import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
});
