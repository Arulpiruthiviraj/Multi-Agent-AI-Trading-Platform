import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import type { BrokerCapabilities, BrokerPlugin, Order } from '../../brokers/BrokerAdapter';

function onceOrderExecuted(eventBus: any, orderId: string, timeoutMs = 2000): Promise<any | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      eventBus.off('ORDER_EXECUTED', handler);
      resolve(null);
    }, timeoutMs);
    const handler = (payload: any) => {
      if (payload.id === orderId) {
        clearTimeout(timer);
        eventBus.off('ORDER_EXECUTED', handler);
        resolve(payload);
      }
    };
    eventBus.on('ORDER_EXECUTED', handler);
  });
}

/**
 * Phase 1, item 3 (ARGUS_SAFETY_HARDENING_REPORT.md) - real coverage for order-level crash
 * recovery. The current audit (FINAL_ANALYSIS.md Section 30.11) found this scenario had zero
 * handling and zero test coverage: Argus sends an order, the broker accepts/fills it, Argus
 * crashes before recording the result locally, and the row is left wrong (REJECTED or stuck
 * PENDING) forever. `reconcileStaleOrders()` closes this by looking up any such row directly with
 * the broker via `getOrderByClientOrderId()` - these tests simulate the "crashed" local state
 * directly (never recorded a brokerOrderId) and drive a stub broker's lookup response.
 */
describe('OrderManagementService.reconcileStaleOrders - crash recovery (Phase 1)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let oms: any;
  let BrokerManager: any;
  let eventBus: any;

  let lookupResponses: Record<string, Order | null> = {};
  const lookupSpy = vi.fn(async (clientOrderId: string) => lookupResponses[clientOrderId] ?? null);

  function stubBroker(): BrokerPlugin {
    return {
      id: 'crash-recovery-stub',
      name: 'Crash Recovery Stub Broker',
      initialize: async () => {},
      authenticate: async () => true,
      validateCredentials: async () => true,
      paperTrading: () => {},
      liveTrading: () => {},
      getCapabilities: (): BrokerCapabilities => ({
        canPlaceOrders: true, canCancelOrders: true, paperTrading: true, liveTrading: false,
        usEquities: true, canadianEquities: false, crypto: false, options: false,
        shortSelling: false, streamingMarketData: false, requiresManualReauth: false, extendedHoursOrders: false,
      }),
      portfolio: async () => ({ cash: 100000, buyingPower: 100000, equity: 100000, positions: [] }),
      orders: async () => [],
      positions: async () => [],
      account: async () => ({}),
      disconnect: async () => {},
      health: async () => 'Healthy',
      placeOrder: async (o: Partial<Order>) => ({
        id: 'unused', symbol: o.symbol!, side: o.side!, type: o.type || 'MARKET', status: 'FILLED',
        quantity: o.quantity!, filledQuantity: o.quantity!, createdAt: new Date(), updatedAt: new Date(),
      }),
      cancelOrder: async () => true,
      closePosition: async () => false,
      getOrderByClientOrderId: lookupSpy,
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_oms_crashrecovery_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ oms } = await import('./OrderManagement'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ eventBus } = await import('../core/EventBus'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    await db.delete(schema.fills);
    await db.delete(schema.trades);
    await db.delete(schema.portfolio);
    lookupResponses = {};
    lookupSpy.mockClear();
    const broker = stubBroker();
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker('crash-recovery-stub', {});
  });

  async function seedCrashedRow(id: string, status: 'PENDING' | 'REJECTED') {
    await db.insert(schema.trades).values({
      id, symbol: 'AAPL', side: 'BUY', quantity: 10, price: 0, status,
      positionQuantityBefore: 0, positionAveragePriceBefore: 0,
      brokerId: 'crash-recovery-stub', executionEnvironment: 'UNKNOWN',
      timestamp: new Date().toISOString(),
      reasoning: 'test', traceId: `trace-${id}`, requestId: id,
      submittedAt: new Date().toISOString(),
      brokerOrderId: null, // the crashed state: never recorded a broker order id
    });
  }

  it('a row stuck PENDING that the broker confirms it NEVER received is honestly marked REJECTED', async () => {
    await seedCrashedRow('crash-1', 'PENDING');
    lookupResponses['crash-1'] = null; // broker genuinely has no record

    await oms.reconcileStaleOrders();

    const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-1'));
    expect(row.status).toBe('REJECTED');
    expect(lookupSpy).toHaveBeenCalledWith('crash-1');
  });

  it('the dangerous real scenario: a row locally marked REJECTED (broker call threw) but the broker ACTUALLY filled it is corrected to FILLED, not left wrong', async () => {
    await seedCrashedRow('crash-2', 'REJECTED');
    lookupResponses['crash-2'] = {
      id: 'real-broker-order-id', clientOrderId: 'crash-2', symbol: 'AAPL', side: 'BUY', type: 'MARKET',
      status: 'FILLED', quantity: 10, filledQuantity: 10, averageFillPrice: 150.25,
      createdAt: new Date(), updatedAt: new Date(),
    };

    await oms.reconcileStaleOrders();

    const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-2'));
    expect(row.status).toBe('FILLED');
    expect(row.brokerOrderId).toBe('real-broker-order-id');
    expect(row.price).toBe(150.25);
    expect(row.filledAt).toBeTruthy();

    // A real fills-ledger row must exist too - this must go through the exact same
    // recordFillProgress() path a normal live fill does, not a shortcut.
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, 'crash-2'));
    expect(fillRows.length).toBeGreaterThan(0);
  });

  it('F04: a crash-recovered row the broker reports FILLED but with invalid fill economics (NaN averageFillPrice) is marked RECONCILIATION_REQUIRED, never silently re-stamped FILLED and never broadcast as a clean execution', async () => {
    await seedCrashedRow('crash-f04-invalid-economics', 'PENDING');
    lookupResponses['crash-f04-invalid-economics'] = {
      id: 'real-broker-order-id-f04', clientOrderId: 'crash-f04-invalid-economics', symbol: 'AAPL', side: 'BUY', type: 'MARKET',
      status: 'FILLED', quantity: 10, filledQuantity: 10, averageFillPrice: NaN,
      createdAt: new Date(), updatedAt: new Date(),
    };

    const executedPromise = onceOrderExecuted(eventBus, 'crash-f04-invalid-economics');
    await oms.reconcileStaleOrders();
    const executedPayload = await executedPromise;

    // Before the F04 outcome-propagation fix, this crash-recovery loop unconditionally overwrote
    // trades.status with the broker-reported realStatus ('FILLED') right after recordFillProgress()
    // had already caught the invalid fill evidence and marked the row RECONCILIATION_REQUIRED —
    // silently erasing the reconciliation flag and reporting a false clean fill.
    const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-f04-invalid-economics'));
    expect(row.status).toBe('RECONCILIATION_REQUIRED');

    // No fill was fabricated from the NaN price.
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, 'crash-f04-invalid-economics'));
    expect(fillRows).toHaveLength(0);

    // The lifecycle event this loop emits must report the true outcome, not a false FILLED.
    expect(executedPayload).not.toBeNull();
    expect(executedPayload.status).toBe('RECONCILIATION_REQUIRED');

    // Discoverable through the existing reconciliation history, not just a log line.
    const reconRows = await db.select().from(schema.reconciliationEvents).where(eq(schema.reconciliationEvents.matches, false));
    const match = reconRows.find((r: any) => typeof r.mismatches === 'string' && r.mismatches.includes('crash-f04-invalid-economics') && r.mismatches.includes('INVALID_FILL_ECONOMICS'));
    expect(match).toBeTruthy();
  });

  it('a stuck PENDING row the broker confirms it actually accepted (still open) is updated to the real broker status, not silently left PENDING forever', async () => {
    await seedCrashedRow('crash-3', 'PENDING');
    lookupResponses['crash-3'] = {
      id: 'real-broker-order-id-2', clientOrderId: 'crash-3', symbol: 'AAPL', side: 'BUY', type: 'MARKET',
      status: 'PARTIALLY_FILLED', quantity: 10, filledQuantity: 4, averageFillPrice: 151.00,
      createdAt: new Date(), updatedAt: new Date(),
    };

    await oms.reconcileStaleOrders();

    const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-3'));
    expect(row.status).toBe('PARTIALLY_FILLED');
    expect(row.brokerOrderId).toBe('real-broker-order-id-2');
  });

  it('never queries rows that already have a real brokerOrderId - that class of row is followUpOpenOrders() territory, not this one', async () => {
    await db.insert(schema.trades).values({
      id: 'not-crashed', symbol: 'AAPL', side: 'BUY', quantity: 10, price: 0, status: 'PENDING',
      timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-not-crashed',
      requestId: 'not-crashed', submittedAt: new Date().toISOString(),
      brokerOrderId: 'already-has-one',
    });

    await oms.reconcileStaleOrders();

    expect(lookupSpy).not.toHaveBeenCalledWith('not-crashed');
  });

  it('degrades honestly (never throws, never fabricates) when the active broker does not support lookup-by-client-order-id', async () => {
    await seedCrashedRow('crash-4', 'PENDING');
    const broker = stubBroker();
    delete (broker as any).getOrderByClientOrderId;
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker('crash-recovery-stub', {});

    await expect(oms.reconcileStaleOrders()).resolves.not.toThrow();

    const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-4'));
    expect(row.status).toBe('PENDING'); // left honestly alone, never guessed at
  });

  it('no false rejection: a lookup that THROWS (e.g. IBKR order rehydration not yet complete after reconnect) leaves the row untouched rather than marking it REJECTED - the UNKNOWN state must never be conflated with a confirmed absence', async () => {
    await seedCrashedRow('crash-5', 'PENDING');
    // Reconciliation re-scans every non-terminal/REJECTED row each cycle (by design - a REJECTED
    // row from an earlier cycle can still be corrected later), so earlier tests' rows are also in
    // scope here. A plain mockImplementationOnce would risk being consumed by whichever row the
    // query happens to process first, not necessarily crash-5 - key the throw to this test's own id.
    lookupSpy.mockImplementation(async (clientOrderId: string) => {
      if (clientOrderId === 'crash-5') {
        throw new Error('IBKR order rehydration (reqOpenOrders) has not completed yet on this connection - order state is unknown, not confirmed absent.');
      }
      return lookupResponses[clientOrderId] ?? null;
    });

    await expect(oms.reconcileStaleOrders()).resolves.not.toThrow();

    const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-5'));
    expect(row.status).toBe('PENDING'); // NOT REJECTED - ambiguous state was correctly left alone, to be retried next cycle
  });

  describe('cross-broker safety (configurable execution broker review, 2026-09-29)', () => {
    let lookupResponsesB: Record<string, Order | null> = {};
    const lookupSpyB = vi.fn(async (clientOrderId: string) => lookupResponsesB[clientOrderId] ?? null);

    function stubBrokerB(): BrokerPlugin {
      const b = stubBroker();
      return { ...b, id: 'crash-recovery-stub-b', name: 'Crash Recovery Stub Broker B', getOrderByClientOrderId: lookupSpyB };
    }

    beforeEach(() => {
      lookupResponsesB = {};
      lookupSpyB.mockClear();
    });

    it('a candidate row stamped with a DIFFERENT broker_id than the currently-active broker is looked up against the broker it was actually submitted to, never the active one - the exact defect this review found (reconcileStaleOrders previously ignored row.brokerId entirely)', async () => {
      // Broker A ("crash-recovery-stub") is registered and active by the outer beforeEach.
      // Broker B is registered here as a SECOND, non-active broker - simulating a deployment
      // whose execution broker was switched after this order was originally submitted.
      const brokerB = stubBrokerB();
      BrokerManager.getInstance().registerBroker(brokerB);
      // Active broker stays A (never call setActiveBroker('crash-recovery-stub-b', {})).

      await db.insert(schema.trades).values({
        id: 'crash-cross-broker', symbol: 'AAPL', side: 'BUY', quantity: 10, price: 0, status: 'PENDING',
        timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-crash-cross-broker',
        requestId: 'crash-cross-broker', submittedAt: new Date().toISOString(),
        brokerOrderId: null,
        brokerId: 'crash-recovery-stub-b', // submitted to B, even though A is active now
      });
      // Broker B genuinely has this order (still open, not filled) - if the fix works, this is
      // what gets returned and the row must NOT be marked REJECTED.
      lookupResponsesB['crash-cross-broker'] = {
        id: 'real-broker-b-order-id', clientOrderId: 'crash-cross-broker', symbol: 'AAPL', side: 'BUY', type: 'MARKET',
        status: 'PENDING', quantity: 10, filledQuantity: 0,
        createdAt: new Date(), updatedAt: new Date(),
      };
      // The active broker A has never heard of this order - the pre-fix code would have looked
      // here, found nothing, and incorrectly marked the row REJECTED.
      lookupResponses['crash-cross-broker'] = null;

      await oms.reconcileStaleOrders();

      expect(lookupSpyB).toHaveBeenCalledWith('crash-cross-broker');
      expect(lookupSpy).not.toHaveBeenCalledWith('crash-cross-broker');

      const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-cross-broker'));
      expect(row.status).not.toBe('REJECTED');
      expect(row.status).toBe('PENDING');
    });

    it('candidates for two different brokers in the same cycle are each resolved against their own broker, not cross-contaminated', async () => {
      const brokerB = stubBrokerB();
      BrokerManager.getInstance().registerBroker(brokerB);

      await seedCrashedRow('crash-multi-a', 'PENDING'); // defaults to the active broker (A) via no brokerId override... but seedCrashedRow doesn't set brokerId, so patch it explicitly:
      await db.update(schema.trades).set({ brokerId: 'crash-recovery-stub' }).where(eq(schema.trades.id, 'crash-multi-a'));

      await db.insert(schema.trades).values({
        id: 'crash-multi-b', symbol: 'MSFT', side: 'BUY', quantity: 5, price: 0, status: 'PENDING',
        timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-crash-multi-b',
        requestId: 'crash-multi-b', submittedAt: new Date().toISOString(),
        brokerOrderId: null, brokerId: 'crash-recovery-stub-b',
        positionQuantityBefore: 0, positionAveragePriceBefore: 0, executionEnvironment: 'UNKNOWN',
      });

      lookupResponses['crash-multi-a'] = null; // A confirms it never received this one -> REJECTED
      lookupResponsesB['crash-multi-b'] = {
        id: 'real-broker-b-order-id-2', clientOrderId: 'crash-multi-b', symbol: 'MSFT', side: 'BUY', type: 'MARKET',
        status: 'FILLED', quantity: 5, filledQuantity: 5, averageFillPrice: 300.0,
        createdAt: new Date(), updatedAt: new Date(),
      };

      await oms.reconcileStaleOrders();

      const [rowA] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-multi-a'));
      const [rowB] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'crash-multi-b'));
      expect(rowA.status).toBe('REJECTED');
      expect(rowB.status).toBe('FILLED');
      expect(rowB.brokerOrderId).toBe('real-broker-b-order-id-2');
    });
  });

  // 2026-10-08 defect hunt (D7): PENDING rows older than the crash-recovery lookback (48h)
  // silently fell out of recovery forever - neither reconciled nor surfaced. They are now
  // marked RECONCILIATION_REQUIRED (never REJECTED - absence was never confirmed) with a
  // reconciliation_events row, through the same operator-visible mechanism as fill-ledger
  // rejections. NULL submitted_at (unknown age) is surfaced too - fail closed, not skipped.
  describe('D7: aged-out PENDING rows are surfaced, never silently dropped', () => {
    async function seedAgedRow(id: string, submittedAt: string | null) {
      await db.insert(schema.trades).values({
        id, symbol: 'AAPL', side: 'BUY', quantity: 10, price: 0, status: 'PENDING',
        positionQuantityBefore: 0, positionAveragePriceBefore: 0,
        brokerId: 'crash-recovery-stub', executionEnvironment: 'UNKNOWN',
        timestamp: new Date().toISOString(),
        reasoning: 'test', traceId: `trace-${id}`, requestId: id,
        submittedAt, brokerOrderId: null,
      });
    }

    it('a PENDING row older than the 48h lookback becomes RECONCILIATION_REQUIRED with an event row', async () => {
      await seedAgedRow('aged-1', new Date(Date.now() - 49 * 3600 * 1000).toISOString());
      await seedAgedRow('fresh-1', new Date().toISOString()); // control: stays in normal recovery

      await oms.reconcileStaleOrders();

      const [aged] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'aged-1'));
      expect(aged.status).toBe('RECONCILIATION_REQUIRED');
      const events = await db.select().from(schema.reconciliationEvents);
      const surfaced = events.filter((e: any) => JSON.stringify(e.mismatches).includes('aged-1'));
      expect(surfaced.length).toBe(1);
      expect(JSON.stringify(surfaced[0].mismatches)).toContain('CRASH_RECOVERY_LOOKBACK_EXCEEDED');

      // The fresh row still goes through normal broker lookup, not the aged-out path.
      const [fresh] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'fresh-1'));
      expect(lookupSpy).toHaveBeenCalledWith('fresh-1');
      expect(lookupSpy).not.toHaveBeenCalledWith('aged-1');
      expect(fresh.status).not.toBe('RECONCILIATION_REQUIRED');
    });

    it('a PENDING row with NULL submitted_at (unknown age) is surfaced, not skipped', async () => {
      await seedAgedRow('aged-null-ts', null);

      await oms.reconcileStaleOrders();

      const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'aged-null-ts'));
      expect(row.status).toBe('RECONCILIATION_REQUIRED');
    });

    it('surfacing is idempotent: a second run does not duplicate event rows', async () => {
      await seedAgedRow('aged-idem', new Date(Date.now() - 49 * 3600 * 1000).toISOString());

      await oms.reconcileStaleOrders();
      await oms.reconcileStaleOrders();

      const events = await db.select().from(schema.reconciliationEvents);
      const surfaced = events.filter((e: any) => JSON.stringify(e.mismatches).includes('aged-idem'));
      expect(surfaced.length).toBe(1);
    });
  });
});
