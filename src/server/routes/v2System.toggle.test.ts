import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Regression: POST /api/v2/system/toggle must route through TradingEngine.toggle(),
 * keeping settings.autoBotEnabled and SystemBootstrap.running consistent.
 */
describe('POST /api/v2/system/toggle — authoritative TradingEngine path', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: any;
  let app: express.Express;
  let BrokerManager: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2toggle_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));

    const { tradingEngine } = await import('../engines/TradingEngine');
    await tradingEngine.initialize();

    const broker = BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    const available = portfolio.buyingPower ?? portfolio.cash ?? 100_000;
    await db.update(schema.settings).set({
      autoBotEnabled: false,
      budget: Math.max(1000, available - 100),
    }).run();
    await tradingEngine.initialize();

    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  }, 120_000);

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('enable updates DB autoBotEnabled and SystemBootstrap.running together', async () => {
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { system } = await import('../core/SystemBootstrap');

    expect(tradingEngine.state.enabled).toBe(false);
    expect(system.getStatus().running).toBe(false);

    const res = await request(app)
      .post('/api/v2/system/toggle')
      .send({ enabled: true, mode: 'PAPER' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status.autobot.enabled).toBe(true);
    expect(res.body.status.consistent).toBe(true);

    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.autoBotEnabled).toBe(true);
    expect(tradingEngine.state.enabled).toBe(true);
    expect(system.getStatus().running).toBe(true);
  });

  it('disable updates DB autoBotEnabled and stops SystemBootstrap', async () => {
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { system } = await import('../core/SystemBootstrap');

    const res = await request(app)
      .post('/api/v2/system/toggle')
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status.autobot.enabled).toBe(false);
    expect(res.body.status.consistent).toBe(true);

    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.autoBotEnabled).toBe(false);
    expect(tradingEngine.state.enabled).toBe(false);
    expect(system.getStatus().running).toBe(false);
  });

  it('does not call broker placeOrder from toggle endpoint', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const spy = vi.spyOn(broker, 'placeOrder');

    await request(app).post('/api/v2/system/toggle').send({ enabled: true, mode: 'PAPER' });
    await request(app).post('/api/v2/system/toggle').send({ enabled: false });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
