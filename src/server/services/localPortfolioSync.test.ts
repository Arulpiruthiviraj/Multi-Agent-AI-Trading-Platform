import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

function sumRange(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

describe('syncLocalPortfolioAfterFullSellFill', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let syncLocalPortfolioAfterFullSellFill: typeof import('./localPortfolioSync').syncLocalPortfolioAfterFullSellFill;
  let syncLocalPortfolioAfterSellFill: typeof import('./localPortfolioSync').syncLocalPortfolioAfterSellFill;
  let syncLocalPortfolioAfterBuyFill: typeof import('./localPortfolioSync').syncLocalPortfolioAfterBuyFill;
  let isOrderFullyFilled: typeof import('./localPortfolioSync').isOrderFullyFilled;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_local_pf_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ syncLocalPortfolioAfterFullSellFill, syncLocalPortfolioAfterSellFill, syncLocalPortfolioAfterBuyFill, isOrderFullyFilled } = await import('./localPortfolioSync'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    await db.delete(schema.portfolio);
  });

  it('deletes local portfolio row after a full SELL fill covering the holding', async () => {
    await db.insert(schema.portfolio).values({
      symbol: 'NVDA',
      quantity: 1,
      averagePrice: 206.85,
      currentPrice: 216.89,
      lastUpdated: new Date().toISOString(),
      brokerSource: 'test',
    });

    expect(isOrderFullyFilled('FILLED', 1, 1)).toBe(true);
    const result = await syncLocalPortfolioAfterFullSellFill('NVDA', 1);
    expect(result.updated).toBe(true);
    expect(result.remainingQty).toBe(0);

    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'NVDA'));
    expect(rows).toHaveLength(0);
  });

  it('reduces local qty when SELL fills less than the full holding', async () => {
    await db.insert(schema.portfolio).values({
      symbol: 'AAPL',
      quantity: 10,
      averagePrice: 100,
      lastUpdated: new Date().toISOString(),
    });

    const result = await syncLocalPortfolioAfterFullSellFill('AAPL', 3);
    expect(result.updated).toBe(true);
    expect(result.remainingQty).toBe(7);

    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'AAPL'));
    expect(rows[0]?.quantity).toBe(7);
  });

  it('is a no-op when no local portfolio row exists (does not invent a position)', async () => {
    const result = await syncLocalPortfolioAfterFullSellFill('GHOST', 1);
    expect(result.updated).toBe(false);
    const rows = await db.select().from(schema.portfolio);
    expect(rows).toHaveLength(0);
  });

  // Forensic audit pass 3, item 4 (position lifecycle / reconciliation race): two fills for the
  // SAME symbol landing concurrently (e.g. a BUY add racing a SELL trim, or two independently
  // approved orders on the same symbol) previously raced on a plain read-then-write with no guard,
  // silently losing one delta (or, for a brand-new symbol, throwing an uncaught PK collision on the
  // second INSERT that got swallowed by the outer catch). Fixed with an optimistic-concurrency
  // retry loop (CAS on the value just read). These tests use a real Promise.all race, not a mock -
  // each sync call performs at least 2 real awaited DB operations, so Node's microtask scheduling
  // reliably interleaves both calls' reads before either call's write, reproducing the exact race.
  it('does not silently drop a concurrent BUY fill for a brand-new symbol (INSERT primary-key race)', async () => {
    const [r1, r2] = await Promise.all([
      syncLocalPortfolioAfterBuyFill('RACE1', 5, 100),
      syncLocalPortfolioAfterBuyFill('RACE1', 3, 100),
    ]);
    expect(r1.updated).toBe(true);
    expect(r2.updated).toBe(true);
    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'RACE1'));
    expect(rows[0]?.quantity).toBe(8); // both fills reflected - neither silently dropped by the PK collision
  });

  it('does not lose an update when two concurrent BUY fills for an already-tracked symbol race', async () => {
    await db.insert(schema.portfolio).values({ symbol: 'RACE2', quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });
    const [r1, r2] = await Promise.all([
      syncLocalPortfolioAfterBuyFill('RACE2', 5, 110),
      syncLocalPortfolioAfterBuyFill('RACE2', 3, 120),
    ]);
    expect(r1.updated).toBe(true);
    expect(r2.updated).toBe(true);
    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'RACE2'));
    expect(rows[0]?.quantity).toBe(18); // 10 + 5 + 3 - neither delta lost to a last-write-wins overwrite
  });

  it('does not lose an update when two concurrent SELL fills for the same symbol race', async () => {
    await db.insert(schema.portfolio).values({ symbol: 'RACE3', quantity: 20, averagePrice: 100, lastUpdated: new Date().toISOString() });
    const [r1, r2] = await Promise.all([
      syncLocalPortfolioAfterSellFill('RACE3', 5),
      syncLocalPortfolioAfterSellFill('RACE3', 3),
    ]);
    expect(r1.updated).toBe(true);
    expect(r2.updated).toBe(true);
    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'RACE3'));
    expect(rows[0]?.quantity).toBe(12); // 20 - 5 - 3 - neither delta lost
  });

  it('a concurrent BUY and SELL for the same symbol both apply (mixed-direction race)', async () => {
    await db.insert(schema.portfolio).values({ symbol: 'RACE4', quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });
    const [buy, sell] = await Promise.all([
      syncLocalPortfolioAfterBuyFill('RACE4', 4, 105),
      syncLocalPortfolioAfterSellFill('RACE4', 2),
    ]);
    expect(buy.updated).toBe(true);
    expect(sell.updated).toBe(true);
    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'RACE4'));
    expect(rows[0]?.quantity).toBe(12); // 10 + 4 - 2
  });

  /**
   * FD-6 hardening evidence (2026-09-14, per explicit operator instruction after a first full-suite
   * run surfaced 4 real failures in the tests above - see docs/ARGUS_FULL_DEFECT_AUDIT.md's FD-6
   * "process note" for the full chronology). The operator's stated invariant, verbatim:
   *
   *   "For N concurrent fill-sync operations against the same portfolio row, the final quantity
   *   must equal the mathematically correct sum of all accepted fills, regardless of interleaving,
   *   retry, SQLITE_BUSY, reconciliation writes, or process scheduling."
   *
   * The two-writer tests above proved the mechanism works for the minimal case. This block proves
   * it holds at higher concurrency, under a real SQLITE_BUSY (not simulated), under mixed BUY/SELL
   * with both a positive and a negative net outcome, against a concurrent reconciliation-style
   * absolute writer (not another fill-sync call), and across a simulated restart/recovery replay.
   * Nested inside the same describe (reusing its db/schema/sqliteDb from the outer beforeAll) -
   * a second top-level describe in this file that re-imports '../db' would get back the SAME
   * cached module instance Node already loaded for this file, including its already-closed
   * connection once the outer describe's own afterAll had run.
   */
  describe('FD-6 hardening - N-writer contention invariant', () => {
    let isRetryableTransientError: typeof import('./localPortfolioSync').isRetryableTransientError;
    let insertIncrementalFill: typeof import('./fillLedger').insertIncrementalFill;

    beforeAll(async () => {
      ({ isRetryableTransientError } = await import('./localPortfolioSync'));
      ({ insertIncrementalFill } = await import('./fillLedger'));
    });

    beforeEach(async () => {
      await db.delete(schema.fills);
    });

  /** Mimics PortfolioReconciliation.ts's real write shape at lines ~186/215/303: an unconditional
   *  absolute overwrite from the broker's own reported quantity - by design, no CAS guard, since
   *  the broker is the reviewed source of truth. Never delete-on-zero here (that is the SELL path's
   *  own concern, not reconciliation's, and irrelevant to what this block is testing). */
  async function reconciliationStyleAbsoluteWrite(symbol: string, absoluteQty: number): Promise<void> {
    await db.update(schema.portfolio).set({ quantity: absoluteQty, lastUpdated: new Date().toISOString() }).where(eq(schema.portfolio.symbol, symbol));
  }

  for (const n of [2, 5, 10]) {
    it(`${n} concurrent BUY fills on a brand-new symbol always sum to the exact mathematically correct total (3 trials)`, async () => {
      for (let trial = 0; trial < 3; trial++) {
        const symbol = `NW_BUY_${n}_${trial}`;
        const amounts = Array.from({ length: n }, (_, i) => i + 1); // 1,2,...,n - distinct, easy to verify
        const results = await Promise.all(amounts.map((amt) => syncLocalPortfolioAfterBuyFill(symbol, amt, 100)));
        for (const r of results) expect(r.updated).toBe(true);
        const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, symbol));
        expect(rows[0]?.quantity).toBe(sumRange(amounts));
      }
    });
  }

  it('10 concurrent fills mixed BUY/SELL converge to the exact correct net quantity (positive net)', async () => {
    await db.insert(schema.portfolio).values({ symbol: 'NW_MIXED_POS', quantity: 50, averagePrice: 100, lastUpdated: new Date().toISOString() });
    // Net: +2+4+6+8+10 (buys) -1-3-5-7-9 (sells) = 30 - 25 = +5. Final = 50 + 5 = 55.
    const buys = [2, 4, 6, 8, 10];
    const sells = [1, 3, 5, 7, 9];
    const results = await Promise.all([
      ...buys.map((amt) => syncLocalPortfolioAfterBuyFill('NW_MIXED_POS', amt, 100)),
      ...sells.map((amt) => syncLocalPortfolioAfterSellFill('NW_MIXED_POS', amt)),
    ]);
    for (const r of results) expect(r.updated).toBe(true);
    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'NW_MIXED_POS'));
    expect(rows[0]?.quantity).toBe(55);
  });

  it('10 concurrent fills mixed BUY/SELL converge to the exact correct net quantity (negative net, without ever going below the real starting exposure)', async () => {
    await db.insert(schema.portfolio).values({ symbol: 'NW_MIXED_NEG', quantity: 100, averagePrice: 100, lastUpdated: new Date().toISOString() });
    // Net: +1+2+3+4+5 (buys) -6-7-8-9-10 (sells) = 15 - 40 = -25. Final = 100 - 25 = 75.
    const buys = [1, 2, 3, 4, 5];
    const sells = [6, 7, 8, 9, 10];
    const results = await Promise.all([
      ...buys.map((amt) => syncLocalPortfolioAfterBuyFill('NW_MIXED_NEG', amt, 100)),
      ...sells.map((amt) => syncLocalPortfolioAfterSellFill('NW_MIXED_NEG', amt)),
    ]);
    for (const r of results) expect(r.updated).toBe(true);
    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'NW_MIXED_NEG'));
    expect(rows[0]?.quantity).toBe(75);
  });

  it('a fill-sync CAS retry always applies its delta exactly once against the freshest value under a single concurrent reconciliation-style absolute write (never double-applies, never silently drops) - 10 trials', async () => {
    for (let trial = 0; trial < 10; trial++) {
      const symbol = `NW_RECON_${trial}`;
      await db.insert(schema.portfolio).values({ symbol, quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });
      const reconAbsolute = 20 + trial;
      const [fillResult] = await Promise.all([
        syncLocalPortfolioAfterBuyFill(symbol, 5, 100),
        reconciliationStyleAbsoluteWrite(symbol, reconAbsolute),
      ]);
      expect(fillResult.updated).toBe(true); // the fill-sync call itself must always succeed
      const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, symbol));
      const final = rows[0]?.quantity;
      // Exactly two valid outcomes depending on which writer's commit is chronologically last -
      // reconciliation is intentionally unconditional (broker is truth), so it CAN overwrite a
      // fill's local effect if it lands after (the already-documented broker-reporting-lag
      // UNKNOWN - see ARGUS_FULL_DEFECT_AUDIT.md). What this test proves is narrower and does hold
      // unconditionally: the fill's own delta (+5) is NEVER lost from its own write (fillResult
      // always true) and NEVER double-counted (final is never reconAbsolute + 10, reconAbsolute -
      // 5, or any other value outside this exact two-outcome set).
      expect([reconAbsolute, reconAbsolute + 5]).toContain(final);
    }
  });

  it('a fill-sync call survives a BURST of repeated concurrent reconciliation-style absolute writes without ever double-applying or losing its own delta - 5 trials', async () => {
    for (let trial = 0; trial < 5; trial++) {
      const symbol = `NW_RECON_BURST_${trial}`;
      await db.insert(schema.portfolio).values({ symbol, quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });
      const burstValues = [15, 25, 35, 45, 55];
      const [fillResult] = await Promise.all([
        syncLocalPortfolioAfterBuyFill(symbol, 5, 100),
        ...burstValues.map((v, i) => (async () => {
          await new Promise((r) => setTimeout(r, i)); // stagger so the burst spans multiple retry windows
          await reconciliationStyleAbsoluteWrite(symbol, v);
        })()),
      ]);
      expect(fillResult.updated).toBe(true);
      const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, symbol));
      const final = rows[0]?.quantity;
      // Valid outcome set: any burst value alone (fill's write got overwritten by a later recon
      // write) or any burst value + 5 (fill's write landed after that recon write and correctly
      // added its delta on top). Never anything else - no double-count, no lost delta, no
      // corruption from repeated CAS retries against a moving absolute target.
      const validOutcomes = [...burstValues, ...burstValues.map((v) => v + 5)];
      expect(validOutcomes).toContain(final);
    }
  });

  it('recovers via retry from a real transient SQLITE_BUSY (a genuine second-connection write lock, not a simulated error)', async () => {
    const { default: Database } = await import('better-sqlite3');
    await db.insert(schema.portfolio).values({ symbol: 'BUSY1', quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });

    // Lower busy_timeout on the connection under test so a real lock throws SQLITE_BUSY quickly
    // instead of SQLite's own internal busy-wait silently absorbing it for up to 5000ms - this
    // isolates and proves THIS module's own retry logic, not SQLite's built-in busy_timeout alone.
    sqliteDb.pragma('busy_timeout = 20');
    const blocker = new Database(tmpDbPath);
    try {
      blocker.pragma('busy_timeout = 0');
      blocker.exec('BEGIN IMMEDIATE'); // real write lock on the shared WAL-mode DB file
      const releaseTimer = setTimeout(() => {
        try { blocker.exec('COMMIT'); } catch { /* ignore */ }
      }, 40);

      const result = await syncLocalPortfolioAfterBuyFill('BUSY1', 5, 100);
      clearTimeout(releaseTimer);
      try { blocker.exec('COMMIT'); } catch { /* already committed */ }

      expect(result.updated).toBe(true);
      const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'BUSY1'));
      expect(rows[0]?.quantity).toBe(15); // the real fill still applied correctly despite the real lock contention
    } finally {
      blocker.close();
      sqliteDb.pragma('busy_timeout = 5000');
    }
  });

  describe('isRetryableTransientError', () => {
    it('classifies SQLITE_BUSY / SQLITE_LOCKED codes as retryable', () => {
      expect(isRetryableTransientError({ code: 'SQLITE_BUSY' })).toBe(true);
      expect(isRetryableTransientError({ code: 'SQLITE_BUSY_SNAPSHOT' })).toBe(true);
      expect(isRetryableTransientError({ code: 'SQLITE_LOCKED' })).toBe(true);
    });
    it('classifies a "database is locked" message as retryable even without a matching code', () => {
      expect(isRetryableTransientError({ message: 'SqliteError: database is locked' })).toBe(true);
    });
    it('does NOT classify an unrelated error as retryable (must not mask real bugs as transient)', () => {
      expect(isRetryableTransientError({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY', message: 'UNIQUE constraint failed: portfolio.symbol' })).toBe(false);
      expect(isRetryableTransientError(new TypeError('boom'))).toBe(false);
      expect(isRetryableTransientError(null)).toBe(false);
    });
  });

  it('restart/recovery: replaying the same broker fill (same cumulative watermark) does not double-apply to local portfolio - idempotency is enforced one layer up, by insertIncrementalFill\'s cumulative-watermark dedup, not by localPortfolioSync itself', async () => {
    // Mirrors OrderManagement.ts's real recordFillProgress() gating exactly: syncLocalPortfolioAfterBuyFill
    // is only ever invoked when insertIncrementalFill reports a genuinely NEW increment (newQty > 0) -
    // this is the real mechanism (already covered by fillLedger.test.ts's own duplicate-fill-accounting
    // tests, pass 3 item 3) that makes a restart/reconnect replay of the same broker fill event safe for
    // portfolio too, without this module needing its own separate idempotency key.
    const orderId = 'restart-recovery-order-1';
    await db.insert(schema.portfolio).values({ symbol: 'RESTART1', quantity: 10, averagePrice: 100, lastUpdated: new Date().toISOString() });

    async function processFillEvent(cumulativeQty: number, price: number) {
      const result = await insertIncrementalFill({
        orderId,
        brokerOrderId: 'broker-restart-1',
        requestedQuantity: 20,
        status: 'PARTIALLY_FILLED',
        filledQuantity: cumulativeQty,
        averageFillPrice: price,
      });
      if (result.newQty > 0) {
        await syncLocalPortfolioAfterBuyFill('RESTART1', result.newQty, price);
      }
      return result;
    }

    // First delivery: a real partial fill of 5 shares (cumulative watermark 5).
    const first = await processFillEvent(5, 100);
    expect(first.newQty).toBe(5);
    // Simulated restart/reconnect: IB (or Alpaca) replays the SAME orderStatus/execDetails event -
    // same cumulative watermark (5) redelivered, exactly what DEF-30's rehydration path produces.
    const replay = await processFillEvent(5, 100);
    // insertIncrementalFill's `duplicate: true` field specifically means "lost a real DB unique-
    // constraint race", not "this watermark was already recorded" - a replay at or below the
    // already-recorded cumulative watermark is caught earlier (newQty <= 1e-9) and correctly
    // reports duplicate:false there; newQty === 0 is the actual signal this test cares about.
    expect(replay.newQty).toBe(0); // correctly recognized as already-recorded, not a new increment
    // A genuinely new partial fill after the restart (cumulative watermark now 8, i.e. 3 more shares).
    const second = await processFillEvent(8, 101);
    expect(second.newQty).toBe(3);

    const rows = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'RESTART1'));
    // 10 (start) + 5 (first real fill) + 3 (second real fill) = 18 - the replayed duplicate (5) was
    // correctly never re-applied to portfolio, since it never even reached syncLocalPortfolioAfterBuyFill.
    expect(rows[0]?.quantity).toBe(18);
  });
  });
});
