import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db, sqliteDb } from '../db';
import { trades, fills, portfolio } from '../db/schema';
import { BrokerManager } from '../../brokers/BrokerManager';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import { replaySafety } from '../replay/replaySafety';
import { OrderManagementService } from './OrderManagement';
import { portfolioReconciliationWorker } from './PortfolioReconciliation';
import { insertIncrementalFill } from './fillLedger';
import { prepareOrderPosition } from './positionFillEvidence';
import { riskEngine } from '../engines/RiskEngine';
import { marketDataWorker } from './MarketDataWorker';

// NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY. Real isolated DB, OMS, fill ledger and
// reconciliation. Broker fills are produced by the real historical simulator. Only its
// position response is deliberately delayed/replayed to model eventual consistency.
describe('OMS durable close-long and accounting evidence', () => {
  let broker: HistoricalReplayBroker;
  let oms: OrderManagementService;
  beforeAll(() => { expect(process.env.ARGUS_DB_PATH).toContain('argus_test_'); });
  beforeEach(async () => {
    await db.delete(fills); await db.delete(trades); await db.delete(portfolio);
    broker = new HistoricalReplayBroker({ initialCash: 100000, costs: replaySafety.costProfiles.Base,
      timezone: 'America/New_York', extendedHours: false, shortSelling: true, fractional: false });
    broker.clockNowMs = Date.UTC(2026, 9, 1, 18, 30);
    BrokerManager.getInstance().registerBroker(broker);
    await BrokerManager.getInstance().setActiveBroker(broker.id, {});
    BrokerManager.getInstance().resetSyncStateForTests('READY');
    oms = new OrderManagementService();
  });
  afterEach(() => vi.restoreAllMocks());
  const order = (trace: string) => sqliteDb.prepare('SELECT * FROM trades WHERE trace_id=?').get(trace) as any;
  async function buy() {
    broker.nextFillPrice.set('OKTA', 211.72);
    await oms.executeOrder('OKTA', 'BUY', 14, 'CERTIFICATION_FIXTURE_ONLY', 'entry');
    expect(order('entry').status).toBe('FILLED');
  }

  it('refuses the second exit after a stale positive snapshot, even after OMS restart', async () => {
    await buy();
    const stale = structuredClone(await broker.positions());
    broker.nextFillPrice.set('OKTA', 212.49);
    await oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', 'exit');
    expect(order('exit').status).toBe('FILLED');
    expect(order('exit').profit_loss).toBeCloseTo((order('exit').price - order('entry').price) * 14);
    const realPositions = broker.positions.bind(broker);
    const currentPortfolio = await broker.portfolio();
    vi.spyOn(broker, 'positions').mockResolvedValue(stale);
    vi.spyOn(broker, 'portfolio').mockResolvedValue({ ...currentPortfolio, positions: stale });
    // Real risk evaluation; no fabricated approval and no external market-clock request.
    const oldKey = process.env.ALPACA_API_KEY;
    const oldSecret = process.env.ALPACA_SECRET_KEY;
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
    marketDataWorker.cacheObservedQuote('OKTA', 212.61);
    try {
      await riskEngine.evaluateRisk({ traceId: 'stale-risk', symbol: 'OKTA', side: 'SELL', currentPrice: 212.61 });
    } finally {
      if (oldKey !== undefined) process.env.ALPACA_API_KEY = oldKey;
      if (oldSecret !== undefined) process.env.ALPACA_SECRET_KEY = oldSecret;
    }
    const gate = sqliteDb.prepare("SELECT passed,detail FROM risk_gate_results WHERE trace_id='stale-risk' AND gate_name='sell_position_exists'").get() as any;
    expect(gate.passed).toBe(0);
    expect(JSON.parse(gate.detail).positionEvidenceReason).toBe('POSITION_FILL_CONFLICT');
    await portfolioReconciliationWorker.reconcile();
    expect(sqliteDb.prepare('SELECT * FROM portfolio WHERE symbol=?').get('OKTA')).toBeUndefined();
    const recon = sqliteDb.prepare('SELECT * FROM reconciliation_events ORDER BY id DESC LIMIT 1').get() as any;
    expect(recon.matches).toBe(0);
    expect(recon.mismatches).toContain('POSITION_FILL_CONFLICT');
    oms = new OrderManagementService();
    const submit = vi.spyOn(broker, 'placeOrder');
    await oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', 'repeat');
    expect(order('repeat').status).toBe('REJECTED');
    expect(order('repeat').reasoning).toContain('POSITION_FILL_CONFLICT');
    expect(submit).not.toHaveBeenCalled();
    expect(await realPositions()).toEqual([]);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM fills').get()).toEqual({ n: 2 });
  });

  it('preserves partial-close inventory and refuses another exit while remainder is working', async () => {
    await buy();
    broker.maxVolumeParticipationPct = 0.5;
    broker.nextFillVolume.set('OKTA', 10);
    broker.nextFillPrice.set('OKTA', 213);
    await oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', 'partial');
    expect(order('partial').status).toBe('PARTIALLY_FILLED');
    expect(sqliteDb.prepare('SELECT quantity FROM portfolio WHERE symbol=?').get('OKTA')).toEqual({ quantity: 9 });
    await oms.executeOrder('OKTA', 'SELL', 9, 'CERTIFICATION_FIXTURE_ONLY', 'competing');
    expect(order('competing').reasoning).toContain('POSITION_ORDER_UNRESOLVED');
    expect(order('competing').status).toBe('REJECTED');
    const row = order('partial');
    const first = (await broker.orders()).find(o => o.id === row.broker_order_id)!;
    await (new OrderManagementService() as any).applyFollowUpUpdate(row, first);
    expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM fills WHERE order_id=?').get(row.id)).toEqual({ n: 1 });
    expect(order('partial').profit_loss).toBeCloseTo((first.averageFillPrice! - order('entry').price) * 5);
  });

  it('serializes concurrent independent exit traces using persisted unresolved orders', async () => {
    await buy();
    broker.nextFillPrice.set('OKTA', 212);
    await Promise.all(['exit-a', 'exit-b'].map(trace => oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', trace)));
    const sells = (await broker.orders()).filter(o => o.side === 'SELL');
    expect(sells.length).toBeLessThanOrEqual(1);
    expect((await broker.positions()).every(p => p.quantity >= 0)).toBe(true);
  });

  it('accounts for fills arriving during cancellation before releasing the close reservation', async () => {
    await buy();
    broker.maxVolumeParticipationPct = 0.5;
    broker.nextFillVolume.set('OKTA', 10);
    broker.nextFillPrice.set('OKTA', 213);
    await oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', 'cancel-race');
    const row = order('cancel-race');
    broker.clockNowMs += 60_000;
    broker.advanceWorkingOrders(); // second genuine simulator fill, not yet observed by OMS
    const result = await oms.cancelOrder(row.id);
    expect(result.ok).toBe(true);
    expect(order('cancel-race').status).toBe('CANCELED');
    expect(sqliteDb.prepare('SELECT SUM(quantity) AS quantity FROM fills WHERE order_id=?').get(row.id)).toEqual({ quantity: 10 });
    expect(sqliteDb.prepare('SELECT quantity FROM portfolio WHERE symbol=?').get('OKTA')).toEqual({ quantity: 4 });
    const repeated = (await broker.orders()).find(o => o.id === row.broker_order_id)!;
    await (new OrderManagementService() as any).applyFollowUpUpdate(order('cancel-race'), repeated);
    expect(sqliteDb.prepare('SELECT SUM(quantity) AS quantity FROM fills WHERE order_id=?').get(row.id)).toEqual({ quantity: 10 });
  });

  it('attributes a delayed fill after restart using persisted basis and charges no P&L to an opening short', async () => {
    await buy();
    await db.insert(trades).values({ id: 'delayed', traceId: 'delayed', symbol: 'OKTA', side: 'SELL', quantity: 14,
      price: 0, status: 'PENDING', timestamp: new Date().toISOString(), brokerId: broker.id, executionEnvironment: 'REPLAY' });
    expect(prepareOrderPosition('delayed', { quantity: 14, entryPrice: order('entry').price })).toBeNull();
    const row = order('delayed');
    const late = { id: 'late-broker', symbol: 'OKTA', side: 'SELL', quantity: 14, filledQuantity: 14,
      averageFillPrice: 212.49, status: 'FILLED', commission: 1.06 };
    await (new OrderManagementService() as any).applyFollowUpUpdate(row, late);
    expect(order('delayed').profit_loss).toBeCloseTo((212.49 - order('entry').price) * 14);
    expect(order('delayed').commission).toBe(1.06);
    // An unexpected external short fill is accounting evidence, never permission to submit one.
    await db.insert(trades).values({ id: 'unexpected', symbol: 'OKTA', side: 'SELL', quantity: 14, price: 212.61,
      status: 'RECONCILIATION_REQUIRED', timestamp: new Date().toISOString(), brokerId: broker.id,
      executionEnvironment: 'REPLAY', positionQuantityBefore: 0, positionAveragePriceBefore: 0 });
    await insertIncrementalFill({ orderId: 'unexpected', brokerOrderId: null, requestedQuantity: 14, status: 'FILLED',
      filledQuantity: 14, averageFillPrice: 212.61, applyPosition: true });
    expect(sqliteDb.prepare('SELECT profit_loss FROM trades WHERE id=?').get('unexpected')).toEqual({ profit_loss: null });
    expect(sqliteDb.prepare('SELECT quantity FROM portfolio WHERE symbol=?').get('OKTA')).toEqual({ quantity: -14 });
  });

  it('rolls back fill, inventory and P&L together if inventory persistence fails', async () => {
    await buy();
    sqliteDb.exec("CREATE TRIGGER fail_inventory BEFORE DELETE ON portfolio BEGIN SELECT RAISE(ABORT, 'fixture fault'); END;");
    try {
      await db.insert(trades).values({ id: 'atomic', symbol: 'OKTA', side: 'SELL', quantity: 14, price: 212,
        status: 'PENDING', timestamp: new Date().toISOString(), brokerId: broker.id, executionEnvironment: 'REPLAY',
        positionQuantityBefore: 14, positionAveragePriceBefore: order('entry').price });
      await expect(insertIncrementalFill({ orderId: 'atomic', brokerOrderId: null, requestedQuantity: 14,
        status: 'FILLED', filledQuantity: 14, averageFillPrice: 212, applyPosition: true })).rejects.toThrow('fixture fault');
      expect(sqliteDb.prepare('SELECT COUNT(*) AS n FROM fills WHERE order_id=?').get('atomic')).toEqual({ n: 0 });
      expect(sqliteDb.prepare('SELECT quantity FROM portfolio WHERE symbol=?').get('OKTA')).toEqual({ quantity: 14 });
    } finally { sqliteDb.exec('DROP TRIGGER fail_inventory'); }
  });

  it('keeps legacy fills unattributed and refuses to infer remaining inventory from an old BUY', async () => {
    await db.insert(trades).values({ id: 'legacy', symbol: 'OKTA', side: 'BUY', quantity: 14, price: 200,
      status: 'FILLED', timestamp: new Date().toISOString(), brokerId: broker.id, executionEnvironment: 'REPLAY' });
    await db.insert(fills).values({ orderId: 'legacy', quantity: 14, price: 200, cumulativeQuantity: 14, filledAt: new Date().toISOString() });
    await oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', 'legacy-exit');
    expect(order('legacy-exit').status).toBe('REJECTED');
    expect(order('legacy-exit').reasoning).toContain('POSITION_FILL_BASELINE_UNAVAILABLE');
    expect(await broker.orders()).toEqual([]);
    expect(sqliteDb.prepare('SELECT position_quantity_after FROM fills WHERE order_id=?').get('legacy'))
      .toEqual({ position_quantity_after: null });
  });

  it('does not release a cancellation reservation on a terminal watermark older than a known partial fill', async () => {
    await buy();
    broker.maxVolumeParticipationPct = 0.5;
    broker.nextFillVolume.set('OKTA', 10);
    broker.nextFillPrice.set('OKTA', 213);
    await oms.executeOrder('OKTA', 'SELL', 14, 'CERTIFICATION_FIXTURE_ONLY', 'stale-cancel');
    const row = order('stale-cancel');
    const [remote] = (await broker.orders()).filter(o => o.id === row.broker_order_id);
    vi.spyOn(broker, 'cancelOrder').mockResolvedValue(true);
    vi.spyOn(broker, 'orders').mockResolvedValue([{ ...remote, status: 'CANCELED', filledQuantity: 0 }]);
    const result = await oms.cancelOrder(row.id);
    expect(result.ok).toBe(false);
    expect(order('stale-cancel').status).toBe('RECONCILIATION_REQUIRED');
    expect(sqliteDb.prepare('SELECT quantity FROM portfolio WHERE symbol=?').get('OKTA')).toEqual({ quantity: 9 });
  });
});
