import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';

/**
 * Real integration test (isolated temp SQLite DB) for the P0 trading-safety
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
    // This suite verifies state/settings/cancellation, not background worker startup.
    // Autobot off intentionally leaves feed/reconciliation/news workers alive in production;
    // starting them here leaks async work past DB/RPC teardown. Control only scheduling.
    const { system } = await import('../core/SystemBootstrap');
    vi.spyOn(system, 'start').mockImplementation(() => {});
    vi.spyOn(system, 'stop').mockImplementation(() => {});

    await tradingEngine.initialize(); // seeds the default settings row in this fresh temp DB
  });

  afterAll(() => {
    vi.restoreAllMocks();
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

  it('2026-10-01 defect verification pass (finding A2.1): toggle() refuses a budget-only increase beyond available buying power while the bot is ALREADY enabled, not just on the enable transition', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    const availableToTrade = portfolio.buyingPower ?? portfolio.cash ?? 0;

    tradingEngine.state.enabled = false;
    const on = await tradingEngine.toggle({ enabled: true, budget: Math.max(1, availableToTrade - 1) } as any);
    expect(on.ok).toBe(true);

    // Same call shape POST /api/v1/config/settings sends: no `enabled` field at all, just a new budget.
    const result = await tradingEngine.toggle({ budget: availableToTrade + 1_000_000 } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds/i);
    // The bad budget must never have been applied to live state or persisted.
    expect(tradingEngine.state.budget).not.toBe(availableToTrade + 1_000_000);
    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.budget).not.toBe(availableToTrade + 1_000_000);

    await tradingEngine.toggle({ enabled: false } as any);
  });

  it('2026-10-01 defect verification pass (finding A2.1): toggle() allows a budget-only decrease while already enabled, and leaves unrelated config edits unaffected', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    const availableToTrade = portfolio.buyingPower ?? portfolio.cash ?? 0;

    tradingEngine.state.enabled = false;
    await tradingEngine.toggle({ enabled: true, budget: Math.max(2, availableToTrade - 1) } as any);

    const result = await tradingEngine.toggle({ budget: Math.max(1, availableToTrade - 2) } as any);
    expect(result.ok).toBe(true);
    expect(tradingEngine.state.budget).toBe(Math.max(1, availableToTrade - 2));

    // An unrelated config edit (no `budget` field at all) must not trigger the broker check or fail.
    const unrelated = await tradingEngine.toggle({ strategy: 'MOMENTUM' } as any);
    expect(unrelated.ok).toBe(true);

    await tradingEngine.toggle({ enabled: false } as any);
  });

  it('toggle() treats settings.autoBotEnabled as the same lever as enabled (DB vs in-memory name)', async () => {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    const availableToTrade = portfolio.buyingPower ?? portfolio.cash ?? 0;

    tradingEngine.state.enabled = false;
    const on = await tradingEngine.toggle({ autoBotEnabled: true, budget: Math.max(1, availableToTrade - 1) } as any);
    expect(on.ok).toBe(true);
    expect(tradingEngine.state.enabled).toBe(true);

    const [rowOn] = await db.select().from(schema.settings).limit(1);
    expect(rowOn.autoBotEnabled).toBe(true);

    const off = await tradingEngine.toggle({ autoBotEnabled: false } as any);
    expect(off.ok).toBe(true);
    expect(tradingEngine.state.enabled).toBe(false);
    const [rowOff] = await db.select().from(schema.settings).limit(1);
    expect(rowOff.autoBotEnabled).toBe(false);
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

  it('Activity Log SCAN/VETO rows keep agent, gate, traceId from real EventBus payloads', () => {
    tradingEngine.state.history = [];
    eventBus.emit(EVENTS.TRADE_IDEA_GENERATED, {
      agent: 'FundamentalAgent',
      symbol: 'AAPL',
      side: 'HOLD',
      confidence: 0,
      currentPrice: 188.42,
      reasoning: 'DATA_UNAVAILABLE: Fundamental data providers not configured.',
      traceId: 'trace-fundamental-aapl-001',
    });
    const scan = tradingEngine.state.history[0];
    expect(scan.type).toBe('scan');
    expect(scan.msg).toContain('FundamentalAgent proposed HOLD AAPL');
    expect(scan.msg).toContain('DATA_UNAVAILABLE');
    expect(scan.detail.traceId).toBe('trace-fundamental-aapl-001');

    eventBus.emit(EVENTS.RISK_ASSESSMENT_COMPLETED, {
      approved: false,
      symbol: 'AAPL',
      side: 'BUY',
      rejectionGate: 'duplicate_signal',
      reasoning: 'Duplicate BUY signal for AAPL within 60s.',
      traceId: 'risk-dup-aaaaaaaa',
      currentPrice: 190.1,
    });
    const veto = tradingEngine.state.history[0];
    expect(veto.type).toBe('veto');
    expect(veto.msg).toContain('[gate=duplicate_signal]');
    expect(veto.detail.gate).toBe('duplicate_signal');
  });

  it('H1 (2026-10-12): toggle() rejects out-of-bounds numerics with ok:false and applies nothing', async () => {
    tradingEngine.state.enabled = false; // belt-and-braces: previous tests clean up, but never rely on it
    // Per TOGGLE_ALLOWED_FIELDS: negative, NaN, zero-where-positive-required, and absurdly
    // large values for each numeric entry. Bound values come from config/tradingSafety.json
    // (unchanged here); this asserts the toggle path enforces them like /config/settings does.
    const cases: Array<{ field: string; badValues: unknown[] }> = [
      { field: 'budget', badValues: [-1, 0, NaN, 1e15] },
      { field: 'maxTradeSize', badValues: [-1, 0, NaN, 1e15] },
      { field: 'dailyLossLimit', badValues: [-1, 0, NaN, 1e15] },
      { field: 'takeProfitPct', badValues: [-1, 0, NaN, 1e15] },
      { field: 'trailingStopPct', badValues: [-1, 0, NaN, 1e15] },
      { field: 'minAiConfidence', badValues: [-1, NaN, 101, 1e15] },
    ];
    for (const { field, badValues } of cases) {
      const before = (tradingEngine.state as any)[field];
      for (const value of badValues) {
        const result = await tradingEngine.toggle({ [field]: value } as any);
        expect(result.ok).toBe(false);
        expect(result.error).toContain(field);
        // A rejected toggle has no side effect: in-memory state untouched...
        expect((tradingEngine.state as any)[field]).toBe(before);
        // ...and nothing persisted to the settings row.
        const [row] = await db.select().from(schema.settings).limit(1);
        expect((row as any)[field]).toBe(before);
      }
    }
  });

  it('H1 (2026-10-12): toggle() still accepts in-bounds numerics (including boundary mins)', async () => {
    tradingEngine.state.enabled = false;
    const snapshot: Record<string, number> = {};
    for (const f of ['budget', 'maxTradeSize', 'dailyLossLimit', 'takeProfitPct', 'trailingStopPct', 'minAiConfidence']) {
      snapshot[f] = (tradingEngine.state as any)[f];
    }
    // minAiConfidence's configured lower bound is 0 (a 0% confidence floor), not 1 - the
    // validator must enforce the real bounds, not a blanket "positive" rule.
    const good = {
      budget: 50000, maxTradeSize: 3000, dailyLossLimit: 5000,
      takeProfitPct: 15, trailingStopPct: 5, minAiConfidence: 0,
    };
    const result = await tradingEngine.toggle(good as any);
    expect(result.ok).toBe(true);
    for (const [field, value] of Object.entries(good)) {
      expect((tradingEngine.state as any)[field]).toBe(value);
    }
    const restore = await tradingEngine.toggle(snapshot as any);
    expect(restore.ok).toBe(true);
  });

  it('L12 (2026-10-12): initialize() coerces a corrupted persisted tradingState to TRADING_PAUSED (fail-closed)', async () => {
    await db.update(schema.settings).set({ tradingState: 'SOME_CORRUPT_VALUE' }).run();
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.emergencyStopActive = false;

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await tradingEngine.initialize();

    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    expect(tradingEngine.state.emergencyStopActive).toBe(false);
    const joinedWarnings = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(joinedWarnings).toContain('INVALID tradingState');
    expect(joinedWarnings).toContain('SOME_CORRUPT_VALUE');
    warnSpy.mockRestore();

    // The corrupt row is repaired in the DB too, so a restart never flips back to garbage.
    const [row] = await db.select().from(schema.settings).limit(1);
    expect(row.tradingState).toBe('TRADING_PAUSED');

    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });

  it('L12 (2026-10-12): initialize() leaves valid persisted trading states untouched', async () => {
    for (const valid of ['TRADING_ENABLED', 'TRADING_PAUSED', 'EMERGENCY_STOP'] as const) {
      await db.update(schema.settings).set({ tradingState: valid }).run();
      tradingEngine.state.tradingState = 'TRADING_ENABLED';
      tradingEngine.state.emergencyStopActive = false;
      await tradingEngine.initialize();
      expect(tradingEngine.state.tradingState).toBe(valid);
      expect(tradingEngine.state.emergencyStopActive).toBe(valid === 'EMERGENCY_STOP');
    }
    await tradingEngine.setTradingState('TRADING_ENABLED', { reason: 'cleanup', actor: 'tester' });
  });
});

describe('TradingEngine.cancelAllOpenOrders - P1 CANCEL_REQUESTED (2026-10-05)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let tradingEngine: any;
  let BrokerManager: any;

  beforeAll(async () => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    tmpDbPath = path.join(os.tmpdir(), `argus_te_cancel_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    // The first describe already imported (and closed) `../db` — reset for a fresh connection.
    vi.resetModules();
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ tradingEngine } = await import('./TradingEngine'));
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));

    await tradingEngine.initialize();
  });

  afterAll(async () => {
    const fs = await import('fs');
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('stamps CANCEL_REQUESTED (not terminal CANCELED) when the cancel request is accepted', async () => {
    await db.insert(schema.trades).values({
      id: 'kill-1', brokerOrderId: 'kb-1', brokerId: 'test',
      symbol: 'AAPL', side: 'BUY', quantity: 10, price: 100,
      status: 'PENDING', submittedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    });
    const cancelOrder = async () => true; // adapter accepted the request; no broker confirmation yet
    vi.spyOn(BrokerManager.getInstance(), 'getActiveBroker').mockReturnValue({ cancelOrder } as any);

    const cancelled = await (tradingEngine as any).cancelAllOpenOrders();

    expect(cancelled).toContain('kb-1');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(schema.trades).where(eq(schema.trades.id, 'kill-1'));
    // Must be non-terminal: OMS follow-up still polls it and reconciles to CANCELED/FILLED.
    expect(row.status).toBe('CANCEL_REQUESTED');
    expect(row.status).not.toBe('CANCELED');

    vi.restoreAllMocks();
    await db.delete(schema.trades).where(eq(schema.trades.id, 'kill-1'));
  });
});
