import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB, no per-module mocks) for the P0 trading-safety
 * kill switch: TradingEngine.setTradingState()'s tri-state machine, its persisted audit trail
 * (kill_switch_events), restart-persistence (settings.tradingState), real outstanding-order
 * cancellation on EMERGENCY_STOP, and the toggle() field-allowlist fix for a real bug found this
 * pass - POST /api/v1/autobot/toggle used to do `Object.assign(state, req.body)` with no
 * allowlisting, so a client could silently clear an emergency stop (or wipe the activity history)
 * through the generic toggle endpoint instead of the dedicated, audited kill-switch endpoints.
 */
describe('TradingEngine - trading-safety kill switch (P0)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let tradingEngine: any;
  let BrokerManager: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_tradingengine_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('./TradingEngine'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));

    await tradingEngine.initialize(); // seeds the default settings row in this fresh temp DB
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('defaults to TRADING_ENABLED with emergencyStopActive false', () => {
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
    expect(tradingEngine.state.emergencyStopActive).toBe(false);
  });

  it('setTradingState(EMERGENCY_STOP) updates in-memory state, persists to settings, and writes an audit event', async () => {
    const result = await tradingEngine.setTradingState('EMERGENCY_STOP', { reason: 'test trigger', actor: 'tester' });

    expect(result.fromState).toBe('TRADING_ENABLED');
    expect(result.toState).toBe('EMERGENCY_STOP');
    expect(tradingEngine.state.tradingState).toBe('EMERGENCY_STOP');
    expect(tradingEngine.state.emergencyStopActive).toBe(true);

    const [settingsRow] = await db.select().from(schema.settings).limit(1);
    expect(settingsRow.tradingState).toBe('EMERGENCY_STOP');

    const events = await db.select().from(schema.killSwitchEvents);
    expect(events.length).toBe(1);
    expect(events[0].fromState).toBe('TRADING_ENABLED');
    expect(events[0].toState).toBe('EMERGENCY_STOP');
    expect(events[0].reason).toBe('test trigger');
    expect(events[0].actor).toBe('tester');

    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });

  it('setTradingState(TRADING_PAUSED) does not set the legacy emergencyStopActive flag (only EMERGENCY_STOP does)', async () => {
    await tradingEngine.setTradingState('TRADING_PAUSED', { reason: 'manual pause', actor: 'tester' });
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    expect(tradingEngine.state.emergencyStopActive).toBe(false);
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });

  it('EMERGENCY_STOP with cancelOpenOrders cancels a real outstanding broker order and records it in the audit trail', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const order = await broker.placeOrder({ symbol: 'ZTEST', side: 'BUY', quantity: 1, price: 100 });

    await db.insert(schema.trades).values({
      id: `trade-estop-${Date.now()}`,
      symbol: 'ZTEST',
      side: 'BUY',
      quantity: 1,
      price: 100,
      status: 'PENDING',
      timestamp: new Date().toISOString(),
      brokerOrderId: order.id,
    });

    const result = await tradingEngine.setTradingState('EMERGENCY_STOP', { reason: 'cancel test', actor: 'tester', cancelOpenOrders: true });

    expect(result.cancelledOrderIds).toContain(order.id);

    const events = await db.select().from(schema.killSwitchEvents).orderBy(schema.killSwitchEvents.id);
    const lastEvent = events[events.length - 1];
    expect(JSON.parse(lastEvent.cancelledOrderIds)).toContain(order.id);

    const orders = await broker.orders();
    const cancelled = orders.find((o: any) => o.id === order.id);
    expect(cancelled.status).toBe('CANCELED');

    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });

  it('EMERGENCY_STOP without cancelOpenOrders leaves real outstanding orders untouched', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const order = await broker.placeOrder({ symbol: 'ZTEST2', side: 'BUY', quantity: 1, price: 100 });

    const result = await tradingEngine.setTradingState('EMERGENCY_STOP', { reason: 'no-cancel test', actor: 'tester', cancelOpenOrders: false });

    expect(result.cancelledOrderIds).toEqual([]);
    const orders = await broker.orders();
    const stillPending = orders.find((o: any) => o.id === order.id);
    expect(stillPending.status).toBe('PENDING');

    await broker.cancelOrder(order.id); // tidy up the paper broker's in-memory order book
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });

  it('toggle() applies allowed config fields but ignores tradingState/emergencyStopActive/history (real bug fix regression test)', async () => {
    tradingEngine.state.history = ['seed-entry'];
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.emergencyStopActive = false;

    const result = await tradingEngine.toggle({
      maxTradeSize: 4242,
      emergencyStopActive: true,
      tradingState: 'EMERGENCY_STOP',
      history: [],
    } as any);

    expect(result.ok).toBe(true);
    expect(tradingEngine.state.maxTradeSize).toBe(4242); // an allowed field really did apply
    expect(tradingEngine.state.emergencyStopActive).toBe(false); // NOT clobbered by client input
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED'); // NOT clobbered by client input
    expect(tradingEngine.state.history).toEqual(['seed-entry']); // NOT wiped by client input
  });

  it('toggle() refuses to enable LIVE trading while tradingState is not TRADING_ENABLED', async () => {
    await tradingEngine.setTradingState('EMERGENCY_STOP', { reason: 'block live test', actor: 'tester' });
    const result = await tradingEngine.toggle({ tradingMode: 'LIVE', confirmLiveTrading: 'I UNDERSTAND THIS WILL PLACE REAL LIVE ORDERS WITH REAL MONEY' } as any);
    expect(result.ok).toBe(false);
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });

  it('toggle() refuses to enable when the allocated budget exceeds the active broker\'s real available buying power', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    const availableToTrade = portfolio.buyingPower ?? portfolio.cash ?? 0;

    tradingEngine.state.enabled = false;
    const result = await tradingEngine.toggle({ enabled: true, budget: availableToTrade + 1_000_000 } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds/i);
    expect(result.error).toMatch(/deposit/i);
    expect(tradingEngine.state.enabled).toBe(false); // never actually started
  });

  it('toggle() allows enabling when the allocated budget is within the active broker\'s available buying power', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    const availableToTrade = portfolio.buyingPower ?? portfolio.cash ?? 0;

    tradingEngine.state.enabled = false;
    const result = await tradingEngine.toggle({ enabled: true, budget: Math.max(1, availableToTrade - 1) } as any);

    expect(result.ok).toBe(true);
    expect(tradingEngine.state.enabled).toBe(true);

    // Stop it again so this doesn't leave the real SystemBootstrap loop running for the rest of
    // the suite - toggle(enabled:false) never fails, mirroring every other cleanup call above.
    await tradingEngine.toggle({ enabled: false } as any);
  });

  it('persists tradingState across a re-initialize (simulating a process restart while stopped)', async () => {
    await tradingEngine.setTradingState('EMERGENCY_STOP', { reason: 'restart persistence test', actor: 'tester' });
    expect(tradingEngine.state.tradingState).toBe('EMERGENCY_STOP');

    // Simulate what a fresh process's in-memory default would be, before initialize() re-reads
    // the persisted settings row.
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.emergencyStopActive = false;

    await tradingEngine.initialize();

    expect(tradingEngine.state.tradingState).toBe('EMERGENCY_STOP');
    expect(tradingEngine.state.emergencyStopActive).toBe(true);

    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });
});
