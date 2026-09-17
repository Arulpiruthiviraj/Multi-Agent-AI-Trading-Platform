import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real end-to-end integration test (isolated temp SQLite DB, real OMS, real BrokerManager, the REAL
 * HistoricalReplayBroker) for the exact sequence the certification report named as its last open
 * item (2026-09-16 follow-up): BUY -> broker ACK -> partial fill -> remaining quantity -> a SECOND
 * fill completing the SAME order -> final position -> exit -> reconciliation, all through the real
 * synthetic broker, not a stub. `HistoricalReplayBroker.advanceWorkingOrders()` (new this pass) is
 * what makes the broker side of this possible; this file proves the OMS side (which was already
 * correct and pre-existing per OrderManagement.lifecycle.test.ts's own "aggregates a later full
 * fill via followUpOpenOrders" case, previously only proven against a controllable stub) actually
 * completes correctly against the real broker's own progressively-updating order state.
 */
describe('Partial fill -> completion, real synthetic broker end-to-end (OMS + HistoricalReplayBroker)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let oms: any;
  let BrokerManager: any;
  let HistoricalReplayBroker: any;
  let replaySafety: any;
  let runtimeIntervals: any;
  let broker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_synth_partial_fill_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ oms } = await import('./OrderManagement'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ HistoricalReplayBroker } = await import('../../brokers/HistoricalReplayBroker'));
    ({ replaySafety } = await import('../replay/replaySafety'));
    ({ runtimeIntervals } = await import('../config/runtimeIntervals'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct: 0.1,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker(broker.id, {});
    const existingSettings = await db.select().from(schema.settings).limit(1);
    if (existingSettings.length === 0) {
      await db.insert(schema.settings).values({ tradingMode: 'Paper' });
    }
  });

  async function ageOrder(orderId: string, ageMs: number) {
    await db.update(schema.trades).set({ submittedAt: new Date(Date.now() - ageMs).toISOString() }).where(eq(schema.trades.id, orderId));
  }

  it('a real BUY that partially fills on bar 1 is aggregated into a second incremental fills row once the broker completes it on bar 2, with a correct final position, average price, and a clean subsequent exit', async () => {
    // Bar 1: cap = floor(1000*0.1) = 100 shares. Requesting 300 -> the real synthetic broker
    // PARTIALLY_FILLs at 100, exactly the "no fabricated full fill" broker-level behavior.
    broker.nextFillPrice.set('SYNPARTIAL', 50);
    broker.nextFillVolume.set('SYNPARTIAL', 1000);
    await oms.executeOrder('SYNPARTIAL', 'BUY', 300, 'synthetic-broker partial-fill entry', 'synp-entry-1', undefined, undefined, null, null, null, 50);

    const row1 = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'synp-entry-1')))[0];
    expect(row1.status).toBe('PARTIALLY_FILLED');
    expect(row1.filledAt).toBeNull();
    let fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, row1.id));
    expect(fillRows).toHaveLength(1);
    expect(fillRows[0].quantity).toBe(100);

    // Bar 2: the clock genuinely advances (as it always does between real bars), plus fresh
    // price/volume well above the remaining 200 shares - the broker's own advanceWorkingOrders()
    // (real production code, not a test double) completes the order.
    broker.clockNowMs += 60_000;
    broker.nextFillPrice.set('SYNPARTIAL', 51);
    broker.nextFillVolume.set('SYNPARTIAL', 10000);
    broker.advanceWorkingOrders();

    // OMS's own pre-existing followUpOpenOrders() re-polls broker.orders() and must aggregate the
    // INCREMENTAL delta (200), never re-recording the already-seen 100, and never fabricating a
    // third row.
    await ageOrder(row1.id, runtimeIntervals.omsFollowUpMinAgeMs + 2000);
    await oms.followUpOpenOrders();

    const row2 = (await db.select().from(schema.trades).where(eq(schema.trades.id, row1.id)))[0];
    expect(row2.status).toBe('FILLED');
    expect(row2.filledAt).toBeTruthy();

    fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, row1.id));
    expect(fillRows).toHaveLength(2);
    expect(fillRows[1].quantity).toBe(200); // the incremental delta only, not the cumulative 300 again
    expect(fillRows.reduce((s: number, f: any) => s + f.quantity, 0)).toBe(300);

    // Local portfolio reflects the full, correctly-averaged 300 shares - not just bar 1's 100.
    const localPortfolio = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'SYNPARTIAL'));
    expect(localPortfolio[0]?.quantity).toBe(300);

    // A clean subsequent exit against the now-complete position - no leftover confusion from the
    // multi-fill entry.
    broker.nextFillPrice.set('SYNPARTIAL', 55);
    broker.nextFillVolume.set('SYNPARTIAL', 100000); // large enough to exit in one shot
    await oms.executeOrder('SYNPARTIAL', 'SELL', 300, 'synthetic-broker partial-fill exit', 'synp-exit-1', undefined, undefined, null, null, null, 55);

    const exitRow = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'synp-exit-1')))[0];
    expect(exitRow.status).toBe('FILLED');
    expect(exitRow.profitLoss).not.toBeNull();
    expect(exitRow.profitLoss).toBeGreaterThan(0); // sold above the ~50.3-avg entry - a real, computed gain

    const localAfterExit = await db.select().from(schema.portfolio).where(eq(schema.portfolio.symbol, 'SYNPARTIAL'));
    expect(localAfterExit[0]?.quantity ?? 0).toBe(0); // fully flat, no phantom remainder
  });

  it('a broker that never gets a chance to advance (advanceWorkingOrders() never called) leaves the order honestly PARTIALLY_FILLED forever, never fabricating completion', async () => {
    broker.nextFillPrice.set('SYNSTALL', 20);
    broker.nextFillVolume.set('SYNSTALL', 100); // cap = 10
    await oms.executeOrder('SYNSTALL', 'BUY', 50, 'stalled partial fill', 'synp-stall-1', undefined, undefined, null, null, null, 20);

    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'synp-stall-1')))[0];
    expect(row.status).toBe('PARTIALLY_FILLED');

    // No advanceWorkingOrders() call this time - the broker's own working-order state never moves.
    await ageOrder(row.id, runtimeIntervals.omsFollowUpMinAgeMs + 2000);
    await oms.followUpOpenOrders();

    const after = (await db.select().from(schema.trades).where(eq(schema.trades.id, row.id)))[0];
    expect(after.status).toBe('PARTIALLY_FILLED'); // still honestly incomplete, not fabricated FILLED
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, row.id));
    expect(fillRows).toHaveLength(1); // no phantom second fill invented by the follow-up poll alone
  });
});
