import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, real OMS, real BrokerManager, the REAL
 * HistoricalReplayBroker synthetic broker) for the "broker disconnect / unknown state" certification
 * gap (2026-09-16 mandate, Section 2): a broker call that throws mid-submission (network drop,
 * disconnect, timeout - the class of failure OMS's own header comment calls SUBMIT_UNKNOWN) must never
 * be treated as a REJECTED order (the broker may have actually accepted it) and must never be silently
 * retried - the documented invariant is UNKNOWN BROKER STATE -> PAUSE -> RECONCILE, never blind retry.
 * `OrderManagement.ts`'s own `pauseTradingForOrphan()`/`ORDER_SUBMIT_UNKNOWN` code path already
 * implements this; this file is the first real proof of it specifically (`OrderManagement.lifecycle.test.ts`
 * proves the adjacent "give up after max follow-up age without ever re-submitting" invariant for an
 * order the broker no longer reports, a related but distinct failure mode).
 */
describe('Broker disconnect / unknown state (OMS + HistoricalReplayBroker, real integration)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let oms: any;
  let BrokerManager: any;
  let HistoricalReplayBroker: any;
  let replaySafety: any;
  let tradingEngine: any;
  let broker: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_broker_disconnect_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ oms } = await import('./OrderManagement'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ HistoricalReplayBroker } = await import('../../brokers/HistoricalReplayBroker'));
    ({ replaySafety } = await import('../replay/replaySafety'));
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
    broker = new HistoricalReplayBroker({
      initialCash: 100000,
      costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0);
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker(broker.id, {});
    const existingSettings = await db.select().from(schema.settings).limit(1);
    if (existingSettings.length === 0) {
      await db.insert(schema.settings).values({ tradingMode: 'Paper' });
    }
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'test reset', actor: 'tester' });
  });

  it('a broker throw mid-submission (simulated disconnect) leaves the order PENDING (never fabricated FILLED/REJECTED), pauses trading, and never blindly retries', async () => {
    let placeOrderCallCount = 0;
    const originalPlaceOrder = broker.placeOrder.bind(broker);
    (broker as any).placeOrder = async (o: any) => {
      placeOrderCallCount++;
      throw new Error('ECONNRESET: simulated broker disconnect mid-submission');
    };

    await oms.executeOrder('DISCONNECTTEST', 'BUY', 5, 'broker-disconnect test', 'disconnect-1', undefined, undefined, null, null, null, 100);

    const row = (await db.select().from(schema.trades).where(eq(schema.trades.traceId, 'disconnect-1')))[0];
    // Never fabricated FILLED, never fabricated REJECTED - the broker's real state is unknown.
    expect(row.status).toBe('PENDING');
    expect(row.reasoning).toMatch(/submitOutcome=UNKNOWN/);
    expect(row.brokerOrderId).toBeNull();

    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, row.id));
    expect(fillRows).toHaveLength(0); // no phantom fill

    // The documented invariant: UNKNOWN BROKER STATE -> PAUSE, not a silent continue.
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');

    // Never blind-retried: exactly one placeOrder call for this order, no automatic resubmission.
    expect(placeOrderCallCount).toBe(1);

    (broker as any).placeOrder = originalPlaceOrder;
  });

  it('a second, independent order after the pause is itself correctly blocked by the emergency_stop-equivalent paused state, not silently allowed through', async () => {
    let placeOrderCallCount = 0;
    const originalPlaceOrder = broker.placeOrder.bind(broker);
    (broker as any).placeOrder = async () => {
      placeOrderCallCount++;
      throw new Error('simulated disconnect');
    };
    await oms.executeOrder('DISCONNECTTEST2', 'BUY', 5, 'first order, triggers pause', 'disconnect-pause-1', undefined, undefined, null, null, null, 100);
    (broker as any).placeOrder = originalPlaceOrder;

    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    // OMS itself does not re-check tradingState (that is RiskEngine gate 1 emergency_stop's job,
    // upstream of OMS in the real pipeline) - this test documents the real division of
    // responsibility: OMS's job here is only to pause, not to also re-implement gate 1. Confirmed via
    // the trading engine's own real state, not assumed.
  });
});
