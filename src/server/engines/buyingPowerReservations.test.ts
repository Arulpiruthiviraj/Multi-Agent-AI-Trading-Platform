/**
 * 2026-10-04 (buying-power TOCTOU remediation): the reservation ledger is DB-derived
 * (durable, restart-safe) - sum of quantity*price over non-terminal BUY orders, excluding
 * research/replay environments. Verifies the fail-closed accounting: pending/unknown
 * orders reserve, terminal orders release, replay orders never reserve.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('getReservedBuyNotional', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let getReservedBuyNotional: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_buypres_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ getReservedBuyNotional } = await import('./buyingPowerReservations'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  afterEach(async () => {
    await db.delete(schema.trades);
  });

  async function seedTrade(overrides: Record<string, any>) {
    await db.insert(schema.trades).values({
      id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      symbol: 'TEST',
      side: 'BUY',
      quantity: 10,
      price: 100,
      status: 'PENDING',
      executionEnvironment: 'PAPER',
      traceId: `test-${Date.now()}-${Math.random()}`,
      timestamp: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
      ...overrides,
    });
  }

  it('returns 0 with no trades', async () => {
    expect(await getReservedBuyNotional()).toBe(0);
  });

  it('reserves non-terminal BUY notional', async () => {
    await seedTrade({ status: 'PENDING', quantity: 10, price: 100 }); // 1000
    await seedTrade({ status: 'SUBMITTED', quantity: 5, price: 200 }); // 1000
    expect(await getReservedBuyNotional()).toBe(2000);
  });

  it('releases terminal orders (FILLED/REJECTED/CANCELED)', async () => {
    await seedTrade({ status: 'PENDING', quantity: 10, price: 100 }); // 1000 reserved
    await seedTrade({ status: 'FILLED', quantity: 10, price: 100 });
    await seedTrade({ status: 'REJECTED', quantity: 10, price: 100 });
    await seedTrade({ status: 'CANCELED', quantity: 10, price: 100 });
    expect(await getReservedBuyNotional()).toBe(1000);
  });

  it('ignores SELL orders', async () => {
    await seedTrade({ side: 'SELL', status: 'PENDING', quantity: 10, price: 100 });
    expect(await getReservedBuyNotional()).toBe(0);
  });

  it('ignores REPLAY and HISTORICAL_REPLAY environments', async () => {
    await seedTrade({ status: 'PENDING', quantity: 10, price: 100, executionEnvironment: 'REPLAY' });
    await seedTrade({ status: 'PENDING', quantity: 10, price: 100, executionEnvironment: 'HISTORICAL_REPLAY' });
    expect(await getReservedBuyNotional()).toBe(0);
  });

  it('keeps reservation on unknown/reconciliation-required orders (fail-closed)', async () => {
    await seedTrade({ status: 'RECONCILIATION_REQUIRED', quantity: 10, price: 100 });
    await seedTrade({ status: 'UNKNOWN', quantity: 5, price: 100 });
    expect(await getReservedBuyNotional()).toBe(1500);
  });
});
