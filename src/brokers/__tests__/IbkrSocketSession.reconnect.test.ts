import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Real asymmetry found and fixed (2026-09-06, post-implementation forensic audit): unlike
 * MarketDataWorker.ts's Alpaca WebSocket path (which already uses ReconnectBackoff), this session
 * previously had no reconnect-with-backoff at all - if IB Gateway Desktop was down at boot or
 * dropped later, the connection stayed dead until a full Argus process restart (reproduced live
 * during this pass). findFirstOpenTcpPort is mocked so this exercises the real connect()/
 * scheduleReconnect() wiring without a real IB Gateway TCP dependency, matching this file's
 * sibling tests' own stated pattern ("a real IB Gateway TCP connection is out of scope for a unit
 * test").
 */
vi.mock('../ibkrTcpProbe', () => ({
  findFirstOpenTcpPort: vi.fn(async () => null), // simulates "IB Gateway not running"
}));

describe('IbkrSocketSession auto-reconnect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('schedules a retry (real ReconnectBackoff delay) after a failed connect attempt, and retries again on the next failure', async () => {
    const { findFirstOpenTcpPort } = await import('../ibkrTcpProbe');
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();

    const ok = await session.connect(false);
    expect(ok).toBe(false);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(1);

    // First backoff slot is 1000ms (config/runtimeIntervals.json networkReconnectBackoffMs[0]).
    await vi.advanceTimersByTimeAsync(1000);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(2);

    // Second slot is 2000ms - proves the backoff actually advances, not a fixed-interval retry.
    await vi.advanceTimersByTimeAsync(2000);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(3);
  });

  it('stopAutoReconnect() cancels the pending retry and no further attempts are made', async () => {
    const { findFirstOpenTcpPort } = await import('../ibkrTcpProbe');
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();

    await session.connect(false);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(1);

    session.stopAutoReconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(1); // still just the original attempt
  });

  it('a second explicit connect() call supersedes any pending auto-retry rather than double-firing', async () => {
    const { findFirstOpenTcpPort } = await import('../ibkrTcpProbe');
    const { IbkrSocketSession } = await import('../IbkrSocketSession');
    const session = new IbkrSocketSession();

    await session.connect(false);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(1);

    // Manual reconnect before the auto-retry timer fires.
    await session.connect(false);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(2);

    // Only one pending timer should exist at this point, not two stacked ones - the backoff
    // counter isn't reset by a manual connect() (only a successful one resets it), so the second
    // failure's own retry lands on the NEXT schedule slot (2000ms), not back at the first (1000ms).
    await vi.advanceTimersByTimeAsync(2000);
    expect(findFirstOpenTcpPort).toHaveBeenCalledTimes(3);
  });
});
