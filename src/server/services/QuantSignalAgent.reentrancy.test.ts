import { describe, it, expect, vi } from 'vitest';

/**
 * Batch 2 timer/reentrancy sweep (2026-09-23): QuantSignalAgent's timer now runs runCycle()
 * through a singleFlightGuard (cycleGuard) - a cycle can legitimately run long under Alpaca
 * rate-limit backoff, and an overlapping cycle would otherwise double-evaluate the same symbols
 * concurrently. triggerNow() (the Synthetic Market Session Simulator's manual-trigger entry point)
 * deliberately stays OUTSIDE the guard so the simulator's "give it a real chance to fire" guarantee
 * is preserved - this test also proves that bypass still works even while a guarded cycle is in
 * flight through the SAME guard instance used elsewhere (it does not coalesce here because
 * triggerNow calls runCycle() directly, not through cycleGuard).
 */
describe('QuantSignalAgent reentrancy guard', () => {
  it('a second timer-driven cycle while the first is still in flight is coalesced, not run twice', async () => {
    const { QuantSignalAgent } = await import('./QuantSignalAgent');
    const agent = new QuantSignalAgent();

    let resolveFirst: () => void = () => {};
    const gate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const runCycleSpy = vi.spyOn(agent as any, 'runCycle').mockImplementation(async () => { await gate; });

    const guard = (agent as any).cycleGuard;
    const first = guard.run(() => (agent as any).runCycle());
    const second = guard.run(() => (agent as any).runCycle());

    expect(runCycleSpy).toHaveBeenCalledTimes(1);

    resolveFirst();
    await Promise.all([first, second]);

    expect(runCycleSpy).toHaveBeenCalledTimes(1);
    runCycleSpy.mockRestore();
  });

  it('triggerNow() is NOT coalesced by cycleGuard (simulator bypass preserved)', async () => {
    const { QuantSignalAgent } = await import('./QuantSignalAgent');
    const agent = new QuantSignalAgent();

    const runCycleSpy = vi.spyOn(agent as any, 'runCycle').mockResolvedValue(undefined);

    // Occupy the guard with an in-flight (never-resolving) timer-driven cycle.
    const guard = (agent as any).cycleGuard;
    let releaseTimerCycle: () => void = () => {};
    const timerGate = new Promise<void>((resolve) => { releaseTimerCycle = resolve; });
    runCycleSpy.mockImplementationOnce(async () => { await timerGate; });
    const timerRun = guard.run(() => (agent as any).runCycle());

    // triggerNow bypasses the guard entirely - must still invoke runCycle for real.
    await agent.triggerNow();
    expect(runCycleSpy).toHaveBeenCalledTimes(2);

    releaseTimerCycle();
    await timerRun;
    runCycleSpy.mockRestore();
  });
});
