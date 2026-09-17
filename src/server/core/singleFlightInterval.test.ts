import { describe, it, expect, vi, afterEach } from 'vitest';
import { startSingleFlightInterval, createSingleFlightGuard } from './singleFlightInterval';

describe('createSingleFlightGuard (protects ANY caller, not just a timer)', () => {
  it('coalesces concurrent direct calls to guard.run() - the exact shape of the P1-A overlap bug', async () => {
    const guard = createSingleFlightGuard();
    let concurrentInvocations = 0;
    let maxConcurrentInvocations = 0;
    let completedRuns = 0;
    const fn = async () => {
      concurrentInvocations += 1;
      maxConcurrentInvocations = Math.max(maxConcurrentInvocations, concurrentInvocations);
      await new Promise((r) => setTimeout(r, 10));
      concurrentInvocations -= 1;
      completedRuns += 1;
    };

    // Simulates 5 "overlapping cycles" firing at once - exactly what a bare setInterval produced
    // in production once a cycle's duration exceeded the interval.
    await Promise.all([guard.run(fn), guard.run(fn), guard.run(fn), guard.run(fn), guard.run(fn)]);

    expect(maxConcurrentInvocations).toBe(1); // never more than one real invocation in flight
    expect(completedRuns).toBe(1);
    const m = guard.getMetrics();
    expect(m.totalRun).toBe(1);
    expect(m.totalSkippedInFlight).toBe(4);
  });

  it('a guard used by a class method protects it regardless of who calls the method', async () => {
    class FakeEvaluator {
      private guard = createSingleFlightGuard();
      public workDone = 0;
      async evaluatePending() {
        await this.guard.run(async () => {
          await new Promise((r) => setTimeout(r, 10));
          this.workDone += 1;
        });
      }
    }
    const ev = new FakeEvaluator();
    // No start()/timer involved at all - three completely independent direct callers.
    await Promise.all([ev.evaluatePending(), ev.evaluatePending(), ev.evaluatePending()]);
    expect(ev.workDone).toBe(1);
  });

  it('real re-audit (2026-09-15): a thrown fn() releases the guard - no permanently stuck in-flight state, at the primitive level (not just the wrapper)', async () => {
    const guard = createSingleFlightGuard(() => {}); // swallow the error report, we only care about the guard's own state
    await expect(guard.run(async () => { throw new Error('boom'); })).resolves.toBeUndefined(); // run() itself never rejects - the guard always resolves, error goes to onError

    // The guard must be immediately available again - not stuck "running forever" because fn threw.
    let secondRan = false;
    await guard.run(async () => { secondRan = true; });
    expect(secondRan).toBe(true);

    const m = guard.getMetrics();
    expect(m.totalErrors).toBe(1); // the throwing call
    expect(m.totalRun).toBe(1); // only the second, successful call - totalRun/totalErrors are mutually exclusive per-call counters
    expect(m.currentlyRunning).toBe(false);
  });

  it('real re-audit (2026-09-15): concurrent calls during a throwing run still coalesce correctly, and the guard recovers for the NEXT call after that', async () => {
    const guard = createSingleFlightGuard(() => {});
    let releaseFirst: (() => void) | null = null;
    const first = guard.run(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      throw new Error('boom');
    });
    // Fires while the first call is still in flight - must coalesce (skip), not queue behind it.
    const second = guard.run(async () => { throw new Error('should never run - coalesced away'); });

    releaseFirst!();
    await Promise.all([first, second]);

    const afterThrow = guard.getMetrics();
    expect(afterThrow.totalErrors).toBe(1); // only the first call's throw counted - the second was skipped, not run
    expect(afterThrow.totalSkippedInFlight).toBe(1);
    expect(afterThrow.currentlyRunning).toBe(false);

    // A genuinely later call (no overlap) must run normally - the guard was not left stuck.
    let thirdRan = false;
    await guard.run(async () => { thirdRan = true; });
    expect(thirdRan).toBe(true);
  });
});

describe('startSingleFlightInterval (P1-A overlap-guard regression coverage)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces: a tick that fires while the previous run is still in flight is skipped, not queued', async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | null = null;
    let concurrentInvocations = 0;
    let maxConcurrentInvocations = 0;
    const fn = vi.fn(async () => {
      concurrentInvocations += 1;
      maxConcurrentInvocations = Math.max(maxConcurrentInvocations, concurrentInvocations);
      await new Promise<void>((resolve) => { resolveFirst = resolve; });
      concurrentInvocations -= 1;
    });

    const handle = startSingleFlightInterval(fn, 1000, { runImmediately: true });
    await vi.advanceTimersByTimeAsync(0); // let the immediate run start
    expect(fn).toHaveBeenCalledTimes(1);

    // Advance past several intervals while the first invocation is still stuck awaiting resolveFirst.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1); // still only 1 real invocation - the rest were coalesced/skipped
    expect(maxConcurrentInvocations).toBe(1); // never more than one in flight - this is the exact
    // production bug this wrapper closes: PredictionOutcomeEvaluator/MultiHorizonOutcomeEvaluator's
    // bare setInterval allowed maxConcurrentInvocations > 1 whenever a cycle outran its interval.

    const midMetrics = handle.getMetrics();
    expect(midMetrics.totalSkippedInFlight).toBeGreaterThan(0);
    expect(midMetrics.totalRun).toBe(0); // first run hasn't resolved yet

    resolveFirst!();
    await vi.advanceTimersByTimeAsync(0);
    const finalMetrics = handle.getMetrics();
    expect(finalMetrics.totalRun).toBe(1);
    expect(finalMetrics.currentlyRunning).toBe(false);

    handle.stop();
  });

  it('runs again on the next tick once the previous invocation has resolved', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => { /* resolves immediately */ });
    const handle = startSingleFlightInterval(fn, 1000, { runImmediately: false });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(handle.getMetrics().totalRun).toBe(3);
    expect(handle.getMetrics().totalSkippedInFlight).toBe(0);

    handle.stop();
  });

  it('stop() prevents further scheduled runs', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {});
    const handle = startSingleFlightInterval(fn, 1000, { runImmediately: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fn).toHaveBeenCalledTimes(1); // no further runs after stop()
  });

  it('a thrown/rejected cycle is caught, counted, and does not break future scheduling', async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error('synthetic cycle failure');
    });
    const errors: unknown[] = [];
    const handle = startSingleFlightInterval(fn, 1000, { runImmediately: true, onError: (e) => errors.push(e) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(handle.getMetrics().totalErrors).toBe(1);
    expect(handle.getMetrics().totalRun).toBe(1); // only the successful 2nd call counts as "run"
    handle.stop();
  });

  it('triggerNow() respects single-flight coalescing against a concurrently running timer cycle', async () => {
    vi.useFakeTimers();
    let resolveFirst: (() => void) | null = null;
    let invocationCount = 0;
    const fn = vi.fn(async () => {
      invocationCount += 1;
      await new Promise<void>((resolve) => { resolveFirst = resolve; });
    });
    const handle = startSingleFlightInterval(fn, 1000, { runImmediately: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(invocationCount).toBe(1);

    const manualTrigger = handle.triggerNow(); // should be coalesced - a run is already in flight
    await vi.advanceTimersByTimeAsync(0);
    expect(invocationCount).toBe(1);
    resolveFirst!();
    await manualTrigger;
    expect(handle.getMetrics().totalSkippedInFlight).toBeGreaterThan(0);
    handle.stop();
  });

  it('getMetrics() reports lastRunDurationMs after a completed run', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 500));
    });
    const handle = startSingleFlightInterval(fn, 2000, { runImmediately: true });
    await vi.advanceTimersByTimeAsync(500);
    const m = handle.getMetrics();
    expect(m.lastRunDurationMs).toBe(500);
    expect(m.lastRunStartedAt).not.toBeNull();
    expect(m.lastRunEndedAt).not.toBeNull();
    handle.stop();
  });
});
