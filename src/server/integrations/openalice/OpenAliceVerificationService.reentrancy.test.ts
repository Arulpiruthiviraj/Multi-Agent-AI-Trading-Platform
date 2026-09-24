import { describe, it, expect, vi } from 'vitest';

/**
 * Batch 2 timer/reentrancy sweep (2026-09-23): startPolling()'s setInterval now runs pollOnce()
 * through a singleFlightGuard (pollGuard). Pure hardening (not a leak fix - the prior forensic
 * audit found no leak in this service; every `pending` entry is already deleted on every code
 * path). This only removes a redundant concurrent MCP round-trip when a poll runs long.
 */
describe('OpenAliceVerificationService reentrancy guard', () => {
  it('pollGuard coalesces a second overlapping pollOnce call', async () => {
    const { OpenAliceVerificationService } = await import('./OpenAliceVerificationService');
    const instance = OpenAliceVerificationService.getInstance();

    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const pollOnceSpy = vi.spyOn(instance as any, 'pollOnce').mockImplementation(async () => { await gate; });

    const guard = (instance as any).pollGuard;
    const first = guard.run(() => (instance as any).pollOnce());
    const second = guard.run(() => (instance as any).pollOnce());

    expect(pollOnceSpy).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second]);

    expect(pollOnceSpy).toHaveBeenCalledTimes(1);
    pollOnceSpy.mockRestore();
  });
});
