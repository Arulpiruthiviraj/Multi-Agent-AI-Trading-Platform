import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import type { BrokerCapabilities, BrokerPlugin, Order } from '../../brokers/BrokerAdapter';

/**
 * Phase 1.5 (2026-09-09 P0 remediation sprint) - the reverse direction of crash recovery from
 * OrderManagement.crashRecovery.test.ts: a broker order Argus has NO local record of at all.
 * reconcileInboundBrokerOrders() already handled this for FILLED/PARTIALLY_FILLED orders (audits
 * them as SOURCE: EXTERNAL_MANUAL); these tests cover the newly-added branch for a genuinely
 * unrecognized order that has NOT filled yet - previously invisible to this function entirely,
 * since it early-continued on zero fill quantity. The required invariant: never auto-cancel, never
 * assume safe - pause trading and surface loudly. Kept in its own file (not merged into
 * OrderManagement.crashRecovery.test.ts) because `db`/`sqliteDb` are process-wide singletons keyed
 * off ARGUS_DB_PATH at first import - a second describe block in the same file reusing
 * `await import('../db')` gets back the FIRST block's already-closed connection, not a fresh one.
 */
describe('OrderManagementService.reconcileInboundBrokerOrders - unrecognized open broker order (Phase 1.5)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let oms: any;
  let BrokerManager: any;
  let tradingEngine: any;
  let brokerOrdersResponse: Order[] = [];

  function stubBroker(): BrokerPlugin {
    return {
      id: 'unrecognized-order-stub',
      name: 'Unrecognized Order Stub Broker',
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
      orders: async () => brokerOrdersResponse,
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
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_oms_unrecognized_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ oms } = await import('./OrderManagement'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    brokerOrdersResponse = [];
    const broker = stubBroker();
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker('unrecognized-order-stub', {});
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
  });

  it('an unrecognized PENDING broker order (no matching local trades row, zero fill) pauses trading and does NOT insert a fabricated trade row or cancel the order', async () => {
    brokerOrdersResponse = [{
      id: 'mystery-order-1', symbol: 'TSLA', side: 'BUY', type: 'LIMIT', status: 'PENDING',
      quantity: 5, filledQuantity: 0, createdAt: new Date(), updatedAt: new Date(),
    }];

    await oms.reconcileInboundBrokerOrders();

    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    const rows = await db.select().from(schema.trades).where(eq(schema.trades.brokerOrderId, 'mystery-order-1'));
    expect(rows.length).toBe(0); // never fabricated a trade row for an order with no fill to record
  });

  it('a recognized order (clientOrderId matches a local row) is reconciled normally and does NOT trigger the unrecognized-order pause', async () => {
    await db.insert(schema.trades).values({
      id: 'known-order-id', symbol: 'AAPL', side: 'BUY', quantity: 10, price: 0, status: 'PENDING',
      timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-known', requestId: 'known-order-id',
      submittedAt: new Date().toISOString(), brokerOrderId: null,
    });
    brokerOrdersResponse = [{
      id: 'broker-side-id-1', clientOrderId: 'known-order-id', symbol: 'AAPL', side: 'BUY', type: 'MARKET',
      status: 'PENDING', quantity: 10, filledQuantity: 0, createdAt: new Date(), updatedAt: new Date(),
    }];

    await oms.reconcileInboundBrokerOrders();

    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED'); // not paused - this order was recognized
  });

  // Phase 8 broker-submission-ambiguity audit (2026-09-14, per explicit operator scenario list,
  // #4 "original ACK arrives after retry decision" generalized to "a genuine late broker-side
  // status change arrives after Argus already made a local terminal determination"). Traced gap:
  // followUpOpenOrders() excludes terminal local rows from its WHERE clause; this function's own
  // loop previously `continue`d unconditionally the moment `byBrokerId.has(o.id)` was true,
  // regardless of whether the broker's CURRENT status differs from the stale local one. Concrete
  // real scenario: an order sits unresponsive past FOLLOWUP_MAX_AGE_MS, cancelOrphanedOpenOrder()
  // issues a real cancel and, finding the order still not-yet-filled at that exact moment, marks it
  // CANCELED - but the order then genuinely fills at the exchange microseconds/seconds later (a
  // real cancel/fill race, not an Argus-internal bug). Nothing previously re-checked this order's
  // status again: it is terminal (excluded from followUpOpenOrders) AND "already recognized by ID"
  // (skipped here). The result: trades.status permanently, incorrectly says CANCELED for an order
  // that actually filled - invisible to attribution/execution-quality reporting (both filter on
  // FILLED), though the broker's own real position would still eventually surface via
  // PortfolioReconciliation's independent position-level MISSING_LOCALLY check (a real but
  // materially weaker safety net than catching it at the order level).
  it('a broker order already known locally (by id) but whose CURRENT status has since diverged from the stale local status is corrected, not silently skipped forever', async () => {
    await db.insert(schema.trades).values({
      id: 'stale-terminal-order', symbol: 'NVDA', side: 'BUY', quantity: 3, price: 0, status: 'CANCELED',
      timestamp: new Date().toISOString(), reasoning: 'test: marked CANCELED by the orphan-timeout path',
      traceId: 'trace-stale-terminal', requestId: 'stale-terminal-order',
      submittedAt: new Date().toISOString(), brokerOrderId: 'broker-stale-1',
    });
    // The broker's REAL current status: it actually filled, moments after Argus's own CANCELED
    // determination - the genuine cancel/fill race this test exists to prove is handled.
    brokerOrdersResponse = [{
      id: 'broker-stale-1', symbol: 'NVDA', side: 'BUY', type: 'MARKET', status: 'FILLED',
      quantity: 3, filledQuantity: 3, averageFillPrice: 450, createdAt: new Date(), updatedAt: new Date(),
    }];

    await oms.reconcileInboundBrokerOrders();

    const rows = await db.select().from(schema.trades).where(eq(schema.trades.id, 'stale-terminal-order'));
    expect(rows[0]?.status).toBe('FILLED'); // corrected, not left permanently wrong
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, 'stale-terminal-order'));
    expect(fillRows.length).toBeGreaterThan(0); // the real fill is recorded, not silently lost
  });

  it('a broker order already known locally whose status genuinely still matches is a true no-op (no spurious re-write, no duplicate fill row)', async () => {
    await db.insert(schema.trades).values({
      id: 'stable-order', symbol: 'MSFT', side: 'BUY', quantity: 4, price: 300, status: 'FILLED',
      timestamp: new Date().toISOString(), reasoning: 'test', traceId: 'trace-stable', requestId: 'stable-order',
      submittedAt: new Date().toISOString(), brokerOrderId: 'broker-stable-1', filledAt: new Date().toISOString(),
    });
    await db.insert(schema.fills).values({
      orderId: 'stable-order', brokerFillId: 'stable-order:4', quantity: 4, price: 300,
      filledAt: new Date().toISOString(), cumulativeQuantity: 4,
    });
    brokerOrdersResponse = [{
      id: 'broker-stable-1', symbol: 'MSFT', side: 'BUY', type: 'MARKET', status: 'FILLED',
      quantity: 4, filledQuantity: 4, averageFillPrice: 300, createdAt: new Date(), updatedAt: new Date(),
    }];

    await oms.reconcileInboundBrokerOrders();

    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, 'stable-order'));
    expect(fillRows.length).toBe(1); // still exactly one fill row - no duplicate from the re-check
  });
});
