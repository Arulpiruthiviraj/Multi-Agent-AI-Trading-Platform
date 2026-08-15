import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import type { BrokerCapabilities, BrokerPlugin, Order } from '../../brokers/BrokerAdapter';

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
        shortSelling: false, streamingMarketData: false, requiresManualReauth: false,
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
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    lookupResponses = {};
    lookupSpy.mockClear();
    const broker = stubBroker();
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker('crash-recovery-stub', {});
  });

  async function seedCrashedRow(id: string, status: 'PENDING' | 'REJECTED') {
    await db.insert(schema.trades).values({
      id, symbol: 'AAPL', side: 'BUY', quantity: 10, price: 0, status,
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
});
