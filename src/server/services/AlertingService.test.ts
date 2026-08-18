import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 12 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real coverage for AlertingService.ts. The
 * current audit (FINAL_ANALYSIS.md Section 30.22) found MARKET_DATA_DISCONNECTED/GAP had no real
 * consumer anywhere, and reconciliation mismatches only ever produced a console.warn - these tests
 * prove the real EventBus->triggerWebhooks() wiring this phase adds, including the real
 * significance filtering and cooldown that keep it from becoming alert spam.
 *
 * AlertingService.ts imports PortfolioReconciliation.ts (for the shared significance threshold),
 * which transitively imports the real `db` module - isolated temp SQLite DB, same established
 * pattern as every other real-DB test in this codebase, even though this file never queries it
 * directly.
 */
const { triggerWebhooks } = vi.hoisted(() => ({ triggerWebhooks: vi.fn(async (_event: any) => {}) }));
vi.mock('../routes/webhooks', () => ({ triggerWebhooks }));

describe('AlertingService (Phase 12)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let eventBus: any;
  let alertingService: any;

  beforeAll(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus_alerting_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterAll(() => {
    try { sqliteDb?.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    vi.resetModules();
    triggerWebhooks.mockClear();
    ({ eventBus } = await import('../core/EventBus'));
    eventBus.removeAllListeners();
    (({ sqliteDb } = await import('../db')) as any);
    ({ alertingService } = await import('./AlertingService'));
    alertingService.start();
  });

  it('alerts on a significant reconciliation mismatch (>= $100)', () => {
    eventBus.emit('RECONCILIATION_MISMATCH', { worstImpactDollars: 500, broker: 'Alpaca' });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
    expect(triggerWebhooks.mock.calls[0][0].type).toBe('reconciliation_mismatch');
  });

  it('does NOT alert on an insignificant mismatch (< $100) - avoids alert fatigue on real timing drift', () => {
    eventBus.emit('RECONCILIATION_MISMATCH', { worstImpactDollars: 5, broker: 'Alpaca' });
    expect(triggerWebhooks).not.toHaveBeenCalled();
  });

  it('alerts on a real market data disconnect', () => {
    eventBus.emit('MARKET_DATA_DISCONNECTED', { reason: 'Missing API keys' });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
    expect(triggerWebhooks.mock.calls[0][0].type).toBe('market_data_disconnected');
  });

  it('alerts when trading is paused or emergency-stopped, but NOT when trading resumes', () => {
    eventBus.emit('TRADING_STATE_CHANGED', { fromState: 'TRADING_ENABLED', toState: 'TRADING_PAUSED', reason: 'test' });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
    expect(triggerWebhooks.mock.calls[0][0].type).toBe('trading_state_changed');

    triggerWebhooks.mockClear();
    eventBus.emit('TRADING_STATE_CHANGED', { fromState: 'TRADING_PAUSED', toState: 'EMERGENCY_STOP', reason: 'kill switch' });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);

    triggerWebhooks.mockClear();
    eventBus.emit('TRADING_STATE_CHANGED', { fromState: 'TRADING_PAUSED', toState: 'TRADING_ENABLED', reason: 'resumed' });
    expect(triggerWebhooks).not.toHaveBeenCalled();
  });

  it('alerts on a real OMS ORDER_EXECUTED fill', () => {
    eventBus.emit('ORDER_EXECUTED', {
      id: 'ord-1',
      symbol: 'AAPL',
      side: 'BUY',
      status: 'FILLED',
      quantity: 10,
      price: 150,
      agent: 'OrderManagement',
    });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
    expect(triggerWebhooks.mock.calls[0][0].type).toBe('order_executed');
  });

  it('does not alert on simulated ORDER_EXECUTED', () => {
    eventBus.emit('ORDER_EXECUTED', { symbol: 'AAPL', side: 'BUY', status: 'FILLED', executionEnvironment: 'SIMULATION' });
    expect(triggerWebhooks).not.toHaveBeenCalled();
  });

  it('alertProcessBoot fires once on server startup hook', () => {
    alertingService.alertProcessBoot({ port: 3000 });
    alertingService.alertProcessBoot({ port: 3000 });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
    expect(triggerWebhooks.mock.calls[0][0].type).toBe('process_boot');
  });

  it('alerts when all AI providers are exhausted for an agent', () => {
    eventBus.emit('AI_PROVIDERS_EXHAUSTED', { agentType: 'FundamentalAgent', lastError: 'timeout' });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
    expect(triggerWebhooks.mock.calls[0][0].type).toBe('ai_providers_exhausted');
  });

  it('respects a real cooldown - a second identical alert within the cooldown window is suppressed', () => {
    eventBus.emit('MARKET_DATA_DISCONNECTED', { reason: 'first' });
    eventBus.emit('MARKET_DATA_DISCONNECTED', { reason: 'second, immediately after' });
    expect(triggerWebhooks).toHaveBeenCalledTimes(1);
  });
});
