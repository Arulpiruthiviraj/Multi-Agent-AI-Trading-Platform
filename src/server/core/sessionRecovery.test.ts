import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import {
  setSessionRecoveryPathForTests,
  resetSessionRecoveryForTests,
  loadInterruptedSessionMarker,
  allowsNewEntryIdeas,
  beginRuntimeSession,
  markCleanShutdown,
  startSessionRecoveryListeners,
  forceHoldNewEntryIdeasForTests,
} from './sessionRecovery';
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';
import { isAutobotTradingEnabled, isLiveIdeaGenerationEnabled } from './ideaGenerationGate';
import { tradingEngine } from '../engines/TradingEngine';

describe('sessionRecovery interrupted session', () => {
  const markerPath = join(tmpdir(), `argus_session_recovery_${process.pid}.json`);
  const originalEnabled = tradingEngine.state.enabled;
  const originalTradingState = tradingEngine.state.tradingState;

  beforeEach(() => {
    resetSessionRecoveryForTests();
    setSessionRecoveryPathForTests(markerPath);
    try { unlinkSync(markerPath); } catch { /* ignore */ }
  });

  afterEach(() => {
    resetSessionRecoveryForTests();
    tradingEngine.state.enabled = originalEnabled;
    tradingEngine.state.tradingState = originalTradingState;
    try { unlinkSync(markerPath); } catch { /* ignore */ }
  });

  it('holds new entry ideas after a dirty marker, then releases on RECONCILIATION_MATCH without changing tradingState', () => {
    writeFileSync(markerPath, JSON.stringify({
      pid: 1,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      cleanShutdown: false,
    }));
    expect(loadInterruptedSessionMarker()).toBe(true);
    expect(allowsNewEntryIdeas()).toBe(false);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    expect(isAutobotTradingEnabled()).toBe(true);
    expect(isLiveIdeaGenerationEnabled()).toBe(false);

    startSessionRecoveryListeners();
    eventBus.publish(EVENTS.RECONCILIATION_MATCH, { matches: 1, broker: 'test' });
    expect(allowsNewEntryIdeas()).toBe(true);
    expect(isLiveIdeaGenerationEnabled()).toBe(true);
    expect(tradingEngine.state.tradingState).toBe('TRADING_ENABLED');
  });

  it('does not auto-unpause TRADING_PAUSED after recon match', () => {
    forceHoldNewEntryIdeasForTests(true);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_PAUSED';
    startSessionRecoveryListeners();
    eventBus.publish(EVENTS.RECONCILIATION_MATCH, { matches: 1, broker: 'test' });
    expect(allowsNewEntryIdeas()).toBe(true);
    expect(tradingEngine.state.tradingState).toBe('TRADING_PAUSED');
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
  });

  it('markCleanShutdown persists cleanShutdown true', () => {
    beginRuntimeSession();
    markCleanShutdown();
    const row = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(row.cleanShutdown).toBe(true);
    expect(loadInterruptedSessionMarker()).toBe(false);
    expect(allowsNewEntryIdeas()).toBe(true);
  });
});
