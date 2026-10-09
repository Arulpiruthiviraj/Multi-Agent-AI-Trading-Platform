import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { isConnected } = vi.hoisted(() => ({ isConnected: vi.fn(() => true) }));
vi.mock('../services/MarketDataWorker', () => ({
  marketDataWorker: { isConnected },
}));

import {
  startHeartbeatWatchdog,
  stopHeartbeatWatchdog,
  resetHeartbeatWatchdogForTests,
  evaluateHeartbeatWatchdog,
} from './heartbeatWatchdog';
import { runtimeIntervals } from '../config/runtimeIntervals';

/**
 * Lifecycle verification (TIMERS/SCHEDULERS hunt, 2026-10-08): the heartbeat watchdog's
 * start/stop were audited as correct but had no direct lifecycle coverage. Proves: one
 * interval across double-starts, zero timers after stop(), ticks run without false
 * suspicion while armed, and a clean restart.
 */
describe('heartbeatWatchdog start/stop lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHeartbeatWatchdogForTests();
    isConnected.mockReset();
    isConnected.mockReturnValue(true);
  });

  afterEach(() => {
    resetHeartbeatWatchdogForTests();
    vi.useRealTimers();
  });

  it('double-start creates exactly one interval; stop() clears it and is idempotent', async () => {
    expect(vi.getTimerCount()).toBe(0);
    startHeartbeatWatchdog();
    startHeartbeatWatchdog();
    expect(vi.getTimerCount()).toBe(1);
    // Ticks run while armed and find nothing suspicious (no NewsAgent tick yet, MD connected).
    await vi.advanceTimersByTimeAsync(runtimeIntervals.heartbeatWatchdogCheckMs * 2);
    const verdict = await evaluateHeartbeatWatchdog();
    expect(verdict.suspected).toBe(false);
    stopHeartbeatWatchdog();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => stopHeartbeatWatchdog()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restart after stop() arms exactly one fresh interval', async () => {
    startHeartbeatWatchdog();
    stopHeartbeatWatchdog();
    expect(vi.getTimerCount()).toBe(0);
    startHeartbeatWatchdog();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(runtimeIntervals.heartbeatWatchdogCheckMs);
    stopHeartbeatWatchdog();
    expect(vi.getTimerCount()).toBe(0);
  });
});
