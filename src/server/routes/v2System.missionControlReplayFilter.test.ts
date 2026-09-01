import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import request from 'supertest';

/**
 * Real defect found Phase 16 (2026-09-01 reporting-integrity sweep): GET /api/v2/system/
 * mission-control's "trades today / win rate / realized P&L" block had no environment filter,
 * so a HISTORICAL_REPLAY run sharing this DB the same calendar day would be counted as organic
 * activity - the same class of bug Phase 15 fixed in consensusPipelineReport.ts/rescueOutcomeReport.ts.
 */
describe('GET /api/v2/system/mission-control - REPLAY exclusion', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let app: express.Express;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_v2missioncontrol_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { v2Router } = await import('./v2System');
    app = express();
    app.use(express.json());
    app.use('/api/v2', v2Router);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('excludes HISTORICAL_REPLAY-tagged trades from tradesToday/winRate/realizedPnlToday', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.trades).values([
      { id: 'mc-organic-1', symbol: 'AAPL', side: 'SELL', quantity: 10, price: 200, status: 'FILLED', timestamp: now, profitLoss: 50 },
      { id: 'mc-replay-1', symbol: 'AAPL', side: 'SELL', quantity: 10, price: 200, status: 'FILLED', timestamp: now, profitLoss: 5000, executionEnvironment: 'REPLAY', brokerId: 'historical_replay' },
      { id: 'mc-replay-2', symbol: 'TSLA', side: 'SELL', quantity: 3, price: 250, status: 'FILLED', timestamp: now, profitLoss: -5000, executionEnvironment: 'REPLAY', brokerId: 'historical_replay' },
    ]);

    const res = await request(app).get('/api/v2/system/mission-control');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Only the one genuine trade counts - the two replay rows (which would otherwise swing net
    // P&L from +50 to -4950) must not be visible in these organic-facing numbers.
    expect(res.body.tradesToday).toBe(1);
    expect(res.body.winRate).toBe(1);
    expect(res.body.realizedPnlToday).toBe(50);
  });
});
