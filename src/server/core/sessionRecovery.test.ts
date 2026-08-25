import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
import { structuredLogger } from '../observability/StructuredLogger';

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

  it('Part 11 crash-forensics fix: beginRuntimeSession records the real pid and parent pid, and exitCode starts null (a process cannot know its own exit code before it happens)', () => {
    beginRuntimeSession();
    const row = JSON.parse(readFileSync(markerPath, 'utf8'));
    expect(row.pid).toBe(process.pid);
    expect(row.parentPid).toBe(process.ppid);
    expect(row.exitCode).toBeNull();
  });

  it('Phase 5 crash-forensics fix: an unclean-shutdown marker is persisted as a queryable, structured TRADING_SAFETY event - not just a console line - so a future forensic audit does not depend on someone having watched the console', () => {
    const warnSpy = vi.spyOn(structuredLogger, 'warn').mockImplementation(() => {});
    writeFileSync(markerPath, JSON.stringify({
      pid: 4242,
      startedAt: '2026-08-24T11:00:52.715Z',
      lastHeartbeatAt: '2026-08-24T16:20:51.940Z',
      cleanShutdown: false,
    }));

    expect(loadInterruptedSessionMarker()).toBe(true);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('pid 4242'),
      expect.objectContaining({
        category: 'TRADING_SAFETY',
        eventType: 'UNCLEAN_SHUTDOWN_DETECTED',
        previousPid: 4242,
        previousStartedAt: '2026-08-24T11:00:52.715Z',
        previousLastHeartbeatAt: '2026-08-24T16:20:51.940Z',
      }),
    );
    warnSpy.mockRestore();
  });

  it('does not log an UNCLEAN_SHUTDOWN_DETECTED event when the prior session shut down cleanly', () => {
    const warnSpy = vi.spyOn(structuredLogger, 'warn').mockImplementation(() => {});
    writeFileSync(markerPath, JSON.stringify({
      pid: 1,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      cleanShutdown: true,
    }));

    expect(loadInterruptedSessionMarker()).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
