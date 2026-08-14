import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 16M (ARGUS_PHASE16_READINESS_REPORT.md) - real coverage for the new AI-failure circuit
 * breaker, closing the "maximum AI failures" gap identified in that phase's safety-ceiling audit.
 * Real isolated temp SQLite DB (tradingEngine.setTradingState() writes to `settings.tradingState`
 * and `kill_switch_events`), same established pattern as every other real-DB test in this codebase.
 */
describe('AIFailureCircuitBreaker (Phase 16M)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let eventBus: any;
  let tradingEngine: any;
  let aiFailureCircuitBreaker: any;

  beforeAll(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus_aicircuitbreaker_${Date.now()}_${process.pid}.db`);
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
    ({ eventBus } = await import('../core/EventBus'));
    eventBus.removeAllListeners();
    (({ sqliteDb } = await import('../db')) as any);
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ aiFailureCircuitBreaker } = await import('./AIFailureCircuitBreaker'));
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    aiFailureCircuitBreaker.start();
  });

  function emitExhaustion(n: number) {
    for (let i = 0; i < n; i++) {
      eventBus.emit('AI_PROVIDERS_EXHAUSTED', { agentType: 'FundamentalAgent', lastError: 'timeout' });
    }
  }

  it('does NOT pause paper trading, no matter how many AI-provider-exhaustion events occur', async () => {
    tradingEngine.state.tradingMode = 'PAPER';
    emitExhaustion(10);
    await new Promise(r => setTimeout(r, 20));
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
  });

  it('does NOT pause real LIVE trading before the threshold is reached', async () => {
    tradingEngine.state.tradingMode = 'LIVE';
    emitExhaustion(4); // one below the real threshold
    await new Promise(r => setTimeout(r, 20));
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
  });

  it('pauses real LIVE trading once the threshold of AI-provider-exhaustion events is reached', async () => {
    tradingEngine.state.tradingMode = 'LIVE';
    emitExhaustion(5);
    await new Promise(r => setTimeout(r, 20));
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
  });

  it('does not attempt a redundant transition once already paused/stopped', async () => {
    tradingEngine.state.tradingMode = 'LIVE';
    tradingEngine.state.tradingState = 'EMERGENCY_STOP';
    const spy = vi.spyOn(tradingEngine, 'setTradingState');
    emitExhaustion(10);
    await new Promise(r => setTimeout(r, 20));
    expect(spy).not.toHaveBeenCalled();
  });
});
