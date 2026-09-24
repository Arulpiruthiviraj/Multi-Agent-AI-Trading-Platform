import { describe, it, expect, vi } from 'vitest';

/**
 * Batch 2 timer/reentrancy sweep (2026-09-23): JavaQuantAdvisoryService's timer now runs tick()
 * through a singleFlightGuard (tickGuard) so a slow historical-bar fetch / Java HTTP round-trip
 * cannot cause overlapping ticks. Proves the guard wired into the class actually coalesces.
 */
describe('JavaQuantAdvisoryService reentrancy guard', () => {
  it('a second tick while the first is still in flight is coalesced, not run twice', async () => {
    const { javaQuantAdvisoryService: instance } = await import('./JavaQuantAdvisoryService');

    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const tickSpy = vi.spyOn(instance as any, 'tick').mockImplementation(async () => { await gate; });

    const guard = (instance as any).tickGuard;
    const first = guard.run(() => (instance as any).tick());
    const second = guard.run(() => (instance as any).tick());

    expect(tickSpy).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second]);

    expect(tickSpy).toHaveBeenCalledTimes(1);
    tickSpy.mockRestore();
  });
});
