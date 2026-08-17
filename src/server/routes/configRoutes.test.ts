import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real integration test (isolated temp SQLite DB, real Express router mounted via supertest) for
 * a bug found this pass while auditing endpoint authorization: POST /api/v1/config/settings used
 * to do `db.delete(schema.settings); db.insert(schema.settings).values(req.body)` - a full
 * delete-and-recreate using the RAW client body. That let a client write `tradingState` directly
 * (bypassing the audited kill-switch endpoints entirely) and `peakEquity` (resetting the
 * portfolio-drawdown gate's high-water-mark at will). Fixed with an explicit field allowlist,
 * same class of fix as TradingEngine.toggle()'s allowlist.
 */
describe('configRoutes - POST /settings field allowlist (P0 regression)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let tradingEngine: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_configroutes_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    await tradingEngine.initialize(); // seeds the default settings row

    const { configRouter } = await import('./configRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1/config', configRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('applies allowed fields like maxTradeSize/riskLevel', async () => {
    const res = await request(app).post('/api/v1/config/settings').send({ maxTradeSize: 7777, riskLevel: 'Aggressive' });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.maxTradeSize).toBe(7777);
    expect(row.riskLevel).toBe('Aggressive');
  });

  it('ignores a client-supplied tradingState - the kill switch may only change via the audited endpoints', async () => {
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'ensure known baseline', actor: 'test' });

    const res = await request(app).post('/api/v1/config/settings').send({ tradingState: 'EMERGENCY_STOP', maxTradeSize: 123 });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.tradingState).toBe('TRADING_ENABLED'); // NOT clobbered by the client-supplied value
    expect(row.maxTradeSize).toBe(123); // the allowed field in the same request still applied
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
  });

  it('ignores a client-supplied peakEquity - only RiskEngine\'s own drawdown tracking may set it', async () => {
    await db.update(schema.settings).set({ peakEquity: 250000 }).run();

    const res = await request(app).post('/api/v1/config/settings').send({ peakEquity: 1, maxTradeSize: 456 });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.peakEquity).toBe(250000); // NOT clobbered by the client-supplied value
    expect(row.maxTradeSize).toBe(456);
  });

  it('ignores an attempt to overwrite id/createdAt', async () => {
    const [before] = await db.select().from(schema.settings).limit(1);

    const res = await request(app).post('/api/v1/config/settings').send({ id: 9999, createdAt: 1, maxTradeSize: 321 });
    expect(res.status).toBe(200);

    const [after] = await db.select().from(schema.settings).limit(1);
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.maxTradeSize).toBe(321);
  });

  it('rejects enabling LIVE trading without the confirmation phrase, and does not write any settings from that request', async () => {
    const res = await request(app).post('/api/v1/config/settings').send({ tradingMode: 'LIVE', maxTradeSize: 999 });
    expect(res.status).toBe(400);

    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.tradingMode).not.toBe('LIVE');
    expect(row.maxTradeSize).not.toBe(999);
  });

  it('maps autoBotEnabled onto TradingEngine.state.enabled so settings and Autobot stay one lever', async () => {
    tradingEngine.state.enabled = false;
    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    const available = portfolio.buyingPower ?? portfolio.cash ?? 0;

    const on = await request(app).post('/api/v1/config/settings').send({
      autoBotEnabled: true,
      budget: Math.max(1, available - 1),
    });
    expect(on.status).toBe(200);
    expect(tradingEngine.state.enabled).toBe(true);
    const [rowOn] = await db.select().from(schema.settings).limit(1);
    expect(rowOn.autoBotEnabled).toBe(true);

    const off = await request(app).post('/api/v1/config/settings').send({ autoBotEnabled: false });
    expect(off.status).toBe(200);
    expect(tradingEngine.state.enabled).toBe(false);
    const [rowOff] = await db.select().from(schema.settings).limit(1);
    expect(rowOff.autoBotEnabled).toBe(false);
  });

  // Real bug fixed: SETTINGS_ALLOWED_FIELDS only ever allowlisted field *names*; posting an
  // absurd value for a field a RiskEngine gate reads as a "less-than" threshold silently defeated
  // that gate (e.g. maxPortfolioDrawdownPct: 999 permanently disabled the drawdown circuit
  // breaker). validateSettingsBounds (settingsValidation.ts) now rejects out-of-range values.
  it('rejects an out-of-range maxPortfolioDrawdownPct instead of silently disabling the drawdown gate', async () => {
    const res = await request(app).post('/api/v1/config/settings').send({ maxPortfolioDrawdownPct: 999 });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.maxPortfolioDrawdownPct).not.toBe(999);
  });

  it('rejects an out-of-range maxOrdersPerMinute instead of silently defeating the order-rate-limit gate', async () => {
    const res = await request(app).post('/api/v1/config/settings').send({ maxOrdersPerMinute: 100000 });
    expect(res.status).toBe(400);
    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.maxOrdersPerMinute).not.toBe(100000);
  });

  it('accepts an in-range maxPortfolioDrawdownPct', async () => {
    const res = await request(app).post('/api/v1/config/settings').send({ maxPortfolioDrawdownPct: 0.2 });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.maxPortfolioDrawdownPct).toBe(0.2);
  });
});

// Real bug fixed: GET /brokers (also reachable via the duplicate bare app.use("/api/v1",
// configRouter) mount in server.ts) used to return raw rows including apiKeyEncrypted/
// secretEncrypted ciphertext - inconsistent with the "never return ciphertext to the UI" masking
// pattern used everywhere else in this file.
describe('configRoutes - GET /brokers never leaks credential ciphertext', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_configroutes_brokers_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    vi.resetModules();
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    await db.insert(schema.settings).values({});
    await db.insert(schema.brokerConnections).values({
      brokerName: 'Alpaca', paperMode: true,
      apiKeyEncrypted: 'iv:realciphertextvalue', secretEncrypted: 'iv:realsecretciphertext',
    });

    const { configRouter } = await import('./configRoutes');
    app = express();
    app.use(express.json());
    app.use('/api/v1/config', configRouter);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('never returns apiKeyEncrypted/secretEncrypted values, but does report whether they exist', async () => {
    const res = await request(app).get('/api/v1/config/brokers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].apiKeyEncrypted).toBeUndefined();
    expect(res.body[0].secretEncrypted).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('realciphertextvalue');
    expect(JSON.stringify(res.body)).not.toContain('realsecretciphertext');
    expect(res.body[0].hasApiKey).toBe(true);
    expect(res.body[0].hasSecret).toBe(true);
  });
});
