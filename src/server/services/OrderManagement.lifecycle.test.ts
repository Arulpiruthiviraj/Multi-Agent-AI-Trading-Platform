import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import type { BrokerCapabilities, BrokerPlugin, Order } from '../../brokers/BrokerAdapter';
import { runtimeIntervals } from '../config/runtimeIntervals';

/**
 * Real integration test (isolated temp SQLite DB, real BrokerManager, no per-module mocks) for
 * hardening-pass Phase 2 (order lifecycle): partial-fill aggregation across multiple observed
 * broker fills, the bounded background follow-up job (followUpOpenOrders) picking up orders the
 * initial ~4s poll gave up on while correctly excluding already-terminal orders (the same real
 * drizzle notInArray/isNotNull filtering TradingEngine.cancelAllOpenOrders() relies on), and the
 * real cancellation path (cancelOrder). A controllable stub broker (registered via the real
 * BrokerManager.registerBroker/setActiveBroker, exactly like BrokerManager.test.ts's own pattern)
 * stands in for Alpaca/IBKR so PARTIALLY_FILLED/FILLED transitions and cancellation outcomes can
 * be driven deterministically without a live broker connection.
 */
describe('OrderManagementService - order lifecycle (Phase 2 hardening)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let oms: any;
  let BrokerManager: any;
  let eventBus: any;

  let ordersResponse: Order[] = [];
  let cancelResult = true;
  let canCancelOrders = true;
  let cancelOrderSpy: ReturnType<typeof vi.fn>;
  let placeOrderDelayMs = 0;
  let placeOrderCallCount = 0;

  function stubBroker(): BrokerPlugin {
    return {
      id: 'lifecycle-stub',
      name: 'Lifecycle Stub Broker',
      initialize: async () => {},
      authenticate: async () => true,
      validateCredentials: async () => true,
      paperTrading: () => {},
      liveTrading: () => {},
      getCapabilities: (): BrokerCapabilities => ({
        canPlaceOrders: true, canCancelOrders, paperTrading: true, liveTrading: false,
        usEquities: true, canadianEquities: false, crypto: false, options: false,
        shortSelling: false, streamingMarketData: false, requiresManualReauth: false,
      }),
      portfolio: async () => ({ cash: 100000, buyingPower: 100000, equity: 100000, positions: [] }),
      orders: async () => ordersResponse,
      positions: async () => [],
      account: async () => ({}),
      disconnect: async () => {},
      health: async () => 'Healthy',
      placeOrder: async (o: Partial<Order>) => {
        placeOrderCallCount++;
        if (placeOrderDelayMs > 0) await new Promise(r => setTimeout(r, placeOrderDelayMs));
        return {
          id: `broker-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          symbol: o.symbol!, side: o.side!, type: o.type || 'MARKET', status: 'PARTIALLY_FILLED',
          quantity: o.quantity!, filledQuantity: 0, createdAt: new Date(), updatedAt: new Date(),
        };
      },
      cancelOrder: cancelOrderSpy as any,
      closePosition: async () => false,
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_oms_lifecycle_${Date.now()}_${process.pid}.db`);
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
    ordersResponse = [];
    cancelResult = true;
    canCancelOrders = true;
    placeOrderDelayMs = 0;
    placeOrderCallCount = 0;
    cancelOrderSpy = vi.fn(async () => cancelResult);
    const broker = stubBroker();
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker('lifecycle-stub', {});
  });

  async function ageOrder(orderId: string, ageMs: number) {
    await db.update(schema.trades).set({ submittedAt: new Date(Date.now() - ageMs).toISOString() }).where(eq(schema.trades.id, orderId));
  }

  it('the real DB unique constraint blocks a genuine concurrent duplicate-traceId race, not just the sequential pre-check', async () => {
    // Widens the race window so both calls' select-based pre-check can plausibly see zero
    // existing rows before either INSERT lands - the scenario idx_trades_trace_id_unique
    // (schema.ts) exists specifically to close, since the pre-check alone is a check-then-act race.
    placeOrderDelayMs = 20;
    const traceId = 'lifecycle-duplicate-race';

    await Promise.all([
      oms.executeOrder('SPY', 'BUY', 1, 'reasoning', traceId),
      oms.executeOrder('SPY', 'BUY', 1, 'reasoning', traceId),
    ]);

    const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
    expect(rows).toHaveLength(1); // the DB constraint allowed exactly one row to ever exist
    expect(placeOrderCallCount).toBe(1); // the losing call aborted in the INSERT-catch, before any broker call
  });

  it('records a partial fill as its own fills row without fabricating a full fill', async () => {
    await oms.executeOrder('AAPL', 'BUY', 10, 'test reasoning', 'lifecycle-partial-1');

    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-partial-1')))[0];
    expect(row.status).toBe('PARTIALLY_FILLED');
    expect(row.filledAt).toBeNull();

    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, row.id));
    expect(fillRows).toHaveLength(0); // stub's placeOrder() reports filledQuantity: 0 - nothing to record yet
  });

  it('aggregates a later full fill via followUpOpenOrders into a second, incremental fills row', async () => {
    await oms.executeOrder('MSFT', 'BUY', 10, 'test reasoning', 'lifecycle-partial-2');
    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-partial-2')))[0];

    // Simulate the broker having filled 4 of 10 shares by the time follow-up next runs.
    ordersResponse = [{ id: row.brokerOrderId, symbol: 'MSFT', side: 'BUY', type: 'MARKET', status: 'PARTIALLY_FILLED', quantity: 10, filledQuantity: 4, averageFillPrice: 100, createdAt: new Date(), updatedAt: new Date() }];
    await ageOrder(row.id, FOLLOWUP_MIN_AGE_MS_PLUS_MARGIN());
    await oms.followUpOpenOrders();

    let fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, row.id));
    expect(fillRows).toHaveLength(1);
    expect(fillRows[0].quantity).toBe(4);

    // Now the broker reports the order fully filled (10 of 10) - the incremental fill recorded
    // this time must be 6 (10 - the 4 already recorded), never the full 10 again.
    ordersResponse = [{ id: row.brokerOrderId, symbol: 'MSFT', side: 'BUY', type: 'MARKET', status: 'FILLED', quantity: 10, filledQuantity: 10, averageFillPrice: 102, createdAt: new Date(), updatedAt: new Date() }];
    const orderExecuted = onceOrderExecuted(eventBus, row.id);
    await oms.followUpOpenOrders();
    const executedPayload = await orderExecuted;

    fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, row.id));
    expect(fillRows).toHaveLength(2);
    expect(fillRows[1].quantity).toBe(6);
    expect(fillRows.reduce((s: number, f: any) => s + f.quantity, 0)).toBe(10);

    const finalRow = (await db.select().from(schema.trades).where(eq(schema.trades.id, row.id)))[0];
    expect(finalRow.status).toBe('FILLED');
    expect(finalRow.filledAt).toBeTruthy();
    expect(executedPayload.status).toBe('FILLED');
  });

  it('excludes already-terminal orders from follow-up scanning (real DB filtering, not just in-process logic)', async () => {
    await oms.executeOrder('GOOG', 'BUY', 5, 'test reasoning', 'lifecycle-terminal-1');
    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-terminal-1')))[0];

    // Force it to a terminal status directly in the DB, as if it had already been resolved.
    await db.update(schema.trades).set({ status: 'FILLED', filledAt: new Date().toISOString() }).where(eq(schema.trades.id, row.id));
    await ageOrder(row.id, FOLLOWUP_MIN_AGE_MS_PLUS_MARGIN());

    // If the terminal exclusion filter were broken, this different broker-reported status would
    // get applied, flipping the trades row to CANCELED.
    ordersResponse = [{ id: row.brokerOrderId, symbol: 'GOOG', side: 'BUY', type: 'MARKET', status: 'CANCELED', quantity: 5, filledQuantity: 0, createdAt: new Date(), updatedAt: new Date() }];
    await oms.followUpOpenOrders();

    const after = (await db.select().from(schema.trades).where(eq(schema.trades.id, row.id)))[0];
    expect(after.status).toBe('FILLED'); // untouched - already terminal, never re-queried
  });

  it('gives up (logs once, leaves last-known status) when the broker no longer reports the order after max follow-up age', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await oms.executeOrder('TSLA', 'BUY', 3, 'test reasoning', 'lifecycle-giveup-1');
    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-giveup-1')))[0];

    // Still-open locally, but the broker list no longer contains this id — we cannot invent
    // a cancel/fill. If the order *is* still reported open, follow-up cancels the remainder
    // (see "cancels a still-open order older than tradingSafety.omsFollowUpMaxAgeMs").
    ordersResponse = [];
    await ageOrder(row.id, 31 * 60 * 1000);

    await oms.followUpOpenOrders();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Giving up follow-up'));

    const after = (await db.select().from(schema.trades).where(eq(schema.trades.id, row.id)))[0];
    expect(after.status).toBe('PARTIALLY_FILLED');

    warnSpy.mockRestore();
  });

  it('cancelOrder() cancels a real still-open order and persists CANCELED', async () => {
    await oms.executeOrder('NVDA', 'BUY', 2, 'test reasoning', 'lifecycle-cancel-1');
    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-cancel-1')))[0];
    expect(row.status).toBe('PARTIALLY_FILLED'); // stub's placeOrder() default - still open, cancellable

    const result = await oms.cancelOrder(row.id);
    expect(result.ok).toBe(true);
    expect(cancelOrderSpy).toHaveBeenCalledWith(row.brokerOrderId);

    const after = (await db.select().from(schema.trades).where(eq(schema.trades.id, row.id)))[0];
    expect(after.status).toBe('CANCELED');
  });

  it('cancelOrder() refuses an already-terminal order without calling the broker', async () => {
    await oms.executeOrder('AMD', 'BUY', 2, 'test reasoning', 'lifecycle-cancel-2');
    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-cancel-2')))[0];
    await db.update(schema.trades).set({ status: 'FILLED' }).where(eq(schema.trades.id, row.id));

    const result = await oms.cancelOrder(row.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already FILLED/i);
    expect(cancelOrderSpy).not.toHaveBeenCalled();
  });

  it('cancelOrder() refuses when the active broker does not support cancellation', async () => {
    canCancelOrders = false;
    const broker = stubBroker();
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker('lifecycle-stub', {});

    await oms.executeOrder('INTC', 'BUY', 2, 'test reasoning', 'lifecycle-cancel-3');
    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-cancel-3')))[0];

    const result = await oms.cancelOrder(row.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not support/i);
    expect(cancelOrderSpy).not.toHaveBeenCalled();
  });

  it('cancelOrder() reports failure honestly when the broker declines (order already filled at the broker)', async () => {
    cancelResult = false;
    await oms.executeOrder('AMZN', 'BUY', 2, 'test reasoning', 'lifecycle-cancel-4');
    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'lifecycle-cancel-4')))[0];

    const result = await oms.cancelOrder(row.id);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/declined/i);

    const after = (await db.select().from(schema.trades).where(eq(schema.trades.id, row.id)))[0];
    expect(after.status).not.toBe('CANCELED'); // never marked cancelled on a real broker refusal
  });

  it('reconcileInboundBrokerOrders records a broker fill that has no local trades row', async () => {
    ordersResponse = [{
      id: 'broker-inbound-1',
      clientOrderId: 'never-locally-inserted',
      symbol: 'MSFT',
      side: 'BUY',
      type: 'MARKET',
      status: 'FILLED',
      quantity: 3,
      filledQuantity: 3,
      averageFillPrice: 400,
      createdAt: new Date(),
      updatedAt: new Date(),
    }];
    await oms.reconcileInboundBrokerOrders();
    const rows = await db.select().from(schema.trades).where(eq(schema.trades.brokerOrderId, 'broker-inbound-1'));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('FILLED');
    expect(rows[0].symbol).toBe('MSFT');
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, rows[0].id));
    expect(fillRows.length).toBeGreaterThan(0);
  });

  it('followUpOpenOrders cancels a still-open order older than tradingSafety.omsFollowUpMaxAgeMs', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const oldIso = new Date(Date.now() - tradingSafety.omsFollowUpMaxAgeMs - 60_000).toISOString();
    await db.insert(schema.trades).values({
      id: 'orphan-partial',
      symbol: 'ORPH',
      side: 'BUY',
      quantity: 10,
      price: 10,
      status: 'PARTIALLY_FILLED',
      timestamp: oldIso,
      reasoning: 'test',
      traceId: 'orphan-partial-trace',
      brokerOrderId: 'broker-orphan-1',
      requestId: 'orphan-partial',
      submittedAt: oldIso,
    });
    ordersResponse = [{
      id: 'broker-orphan-1',
      symbol: 'ORPH',
      side: 'BUY',
      type: 'MARKET',
      status: 'PARTIALLY_FILLED',
      quantity: 10,
      filledQuantity: 2,
      averageFillPrice: 10,
      createdAt: new Date(oldIso),
      updatedAt: new Date(),
    }];
    await oms.followUpOpenOrders();
    expect(cancelOrderSpy).toHaveBeenCalledWith('broker-orphan-1');
  });
});

function FOLLOWUP_MIN_AGE_MS_PLUS_MARGIN(): number {
  return runtimeIntervals.omsFollowUpMinAgeMs + 1000;
}

function onceOrderExecuted(eventBus: any, orderId: string): Promise<any> {
  return new Promise((resolve) => {
    const handler = (payload: any) => {
      if (payload.id === orderId) {
        eventBus.off('ORDER_EXECUTED', handler);
        resolve(payload);
      }
    };
    eventBus.on('ORDER_EXECUTED', handler);
  });
}
