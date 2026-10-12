import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAliceAdapter } from './OpenAliceAdapter';
import { runtimeIntervals } from '../../config/runtimeIntervals';

// Hermetic like OpenAliceAdapter.test.ts: the workspace resolver is mocked so
// ensureWorkspaceScoped() leaves the injected mock client in place.
vi.mock('./OpenAliceWorkspace', () => ({
  ensureArgusWorkspaceId: vi.fn().mockResolvedValue(null),
}));

// 2026-10-12 defect hunt (L8): healthCheck()'s race-timeout timer id was never captured,
// so a fast provider left a dangling timer behind (and a slow one left it pending until it
// fired). Both paths must clear the timer once the race settles.
describe('OpenAliceAdapter healthCheck timer hygiene (L8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('slow provider: timeout wins and no timer is left pending afterwards', async () => {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    (adapter as any).mcp = { listToolNames: vi.fn(() => new Promise<never>(() => {})) };

    const pending = adapter.healthCheck();
    await vi.advanceTimersByTimeAsync(runtimeIntervals.modelRuntimeProbeTimeoutMs + 1000);
    const result = await pending;

    expect(result.reachable).toBe(false);
    expect(result.detail).toMatch(/timed out/);
    // The timeout timer fired (it had to, to reject the race) - but afterwards nothing
    // may remain scheduled.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fast provider: timer is cleared once the race settles (no dangling timer)', async () => {
    const adapter = new OpenAliceAdapter('http://localhost:9999/mcp');
    (adapter as any).mcp = {
      listToolNames: vi.fn(async () => ['issue_create', 'inbox_read']),
    };

    const result = await adapter.healthCheck();

    expect(result.reachable).toBe(true);
    // Before the L8 fix this was 1: the never-captured timeout timer stayed scheduled
    // until it fired on its own.
    expect(vi.getTimerCount()).toBe(0);
  });
});
