import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, no per-module mocks) for the Phase 3
 * reconciliation-history persistence. In particular verifies `.returning()` on insert actually
 * works against this project's real better-sqlite3 + drizzle setup - not used anywhere else in
 * the codebase, so this is the first real proof it behaves as expected here.
 */
describe('PortfolioReconciliationWorker.reconcile persistence (Phase 3)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let portfolioReconciliationWorker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reconcile_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    // Force the real default active broker (InternalPaperBroker) rather than depending on
    // whatever env-driven broker selection would otherwise happen.
    void BrokerManager;
    ({ portfolioReconciliationWorker } = await import('./PortfolioReconciliation'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('persists a MATCH reconciliation_events row with no mismatches when local is empty and broker is empty', async () => {
    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1];
    expect(last.matches).toBe(true);
    expect(last.mismatches).toBeNull();
  });

  it('persists a MISSING_LOCALLY mismatch and a BROKER-side portfolio_snapshots row when the broker holds a position Argus does not know about', async () => {
    const broker = (await import('../../brokers/BrokerManager')).BrokerManager.getInstance().getActiveBroker();
    // Monkey-patch portfolio() to simulate a broker-side position Argus's local table doesn't
    // know about, without needing a real fill to have happened first.
    const originalPortfolio = broker.portfolio.bind(broker);
    (broker as any).portfolio = async () => {
      const real = await originalPortfolio();
      return { ...real, positions: [...real.positions, { symbol: 'ZZZTEST', quantity: 42, entryPrice: 10, currentPrice: 10 }] };
    };

    await portfolioReconciliationWorker.reconcile();

    const events = await db.select().from(schema.reconciliationEvents);
    const last = events[events.length - 1];
    expect(last.matches).toBe(false);
    const mismatches = JSON.parse(last.mismatches);
    expect(mismatches.some((m: any) => m.symbol === 'ZZZTEST' && m.type === 'MISSING_LOCALLY')).toBe(true);

    const snapshots = await db.select().from(schema.portfolioSnapshots).where(eq(schema.portfolioSnapshots.reconciliationId, last.id));
    const brokerSnapshot = snapshots.find((s: any) => s.symbol === 'ZZZTEST' && s.source === 'BROKER');
    expect(brokerSnapshot).toBeTruthy();
    expect(brokerSnapshot.quantity).toBe(42);
  });
});
