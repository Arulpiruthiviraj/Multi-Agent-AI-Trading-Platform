/**
 * P1-A remediation (2026-09-14 forensic finding): a bare `setInterval(() => asyncFn(), ms)`
 * schedules the next callback strictly on wall-clock time regardless of whether the previous
 * invocation's promise has settled. When asyncFn's duration can exceed the interval (as measured
 * for PredictionOutcomeEvaluator/MultiHorizonOutcomeEvaluator against production-scale tables -
 * see docs/audits/ARGUS_MASTER_REMEDIATION_BASELINE.md P1-A section), this produces overlapping
 * concurrent invocations, each materializing its own working set from the same growing query -
 * reproduced in an isolated harness as sustained, GC-unrecoverable RSS growth that scaled with the
 * number of concurrent invocations.
 *
 * This wrapper replaces that pattern with explicit single-flight coalescing: a scheduled tick
 * while a previous run is still in flight is SKIPPED (counted, not queued or dropped silently) -
 * coalescing is preferred over queuing per the remediation directive ("You don't want a backlog of
 * obsolete outcome evaluations").
 */

export interface SingleFlightIntervalMetrics {
  /** Every tick the interval timer fired, whether or not it actually ran fn. */
  totalScheduled: number;
  /** Ticks where fn actually ran to completion (success or thrown error, either way "ran"). */
  totalRun: number;
  /** Ticks skipped because the previous invocation of fn was still in flight - the coalescing count. */
  totalSkippedInFlight: number;
  /** Ticks where fn threw/rejected. */
  totalErrors: number;
  lastRunStartedAt: string | null;
  lastRunEndedAt: string | null;
  lastRunDurationMs: number | null;
  currentlyRunning: boolean;
}

export interface SingleFlightIntervalHandle {
  /** Stops the timer and prevents any further runs (including one already scheduled via
   *  runImmediately that hasn't started yet - stop() before the microtask queue drains is a no-op
   *  on that specific in-flight promise, which will still be allowed to finish; it only prevents
   *  NEW runs from starting). */
  stop(): void;
  getMetrics(): SingleFlightIntervalMetrics;
  /** Manual trigger (ops/tests) - still respects single-flight coalescing against a concurrently
   *  running timer-driven cycle. */
  triggerNow(): Promise<void>;
}

/**
 * The reusable coalescing primitive, deliberately separated from the timer wiring below it. A
 * guard's `run()` is safe to call from ANYWHERE - a setInterval tick, a manual "re-run now" API
 * route, a test calling the method directly and concurrently - and always coalesces against
 * whatever else is currently running through the SAME guard instance. This matters because the
 * bug this whole module exists to close (PredictionOutcomeEvaluator/MultiHorizonOutcomeEvaluator's
 * unbounded overlap) is a property of the METHOD being called concurrently, not specifically of
 * setInterval - a guard that only wrapped the timer path would leave a future direct/manual caller
 * unprotected. Evaluator classes hold their own SingleFlightGuard and have their public
 * evaluatePending() call guard.run(...) internally, so every caller is protected uniformly.
 */
export interface SingleFlightGuard {
  /** Runs fn() if nothing is currently in flight through this guard; otherwise coalesces (skips,
   *  does not queue) and resolves immediately. */
  run(fn: () => Promise<void>): Promise<void>;
  getMetrics(): SingleFlightIntervalMetrics;
}

export function createSingleFlightGuard(onError?: (e: unknown) => void): SingleFlightGuard {
  let running = false;
  const metrics: SingleFlightIntervalMetrics = {
    totalScheduled: 0,
    totalRun: 0,
    totalSkippedInFlight: 0,
    totalErrors: 0,
    lastRunStartedAt: null,
    lastRunEndedAt: null,
    lastRunDurationMs: null,
    currentlyRunning: false,
  };
  const handleError = onError ?? ((e: unknown) => console.error('[singleFlightGuard] cycle failed', e));

  return {
    async run(fn: () => Promise<void>): Promise<void> {
      metrics.totalScheduled += 1;
      if (running) {
        metrics.totalSkippedInFlight += 1;
        return;
      }
      running = true;
      metrics.currentlyRunning = true;
      const startedAt = Date.now();
      metrics.lastRunStartedAt = new Date(startedAt).toISOString();
      try {
        await fn();
        metrics.totalRun += 1;
      } catch (e) {
        metrics.totalErrors += 1;
        handleError(e);
      } finally {
        running = false;
        metrics.currentlyRunning = false;
        const endedAt = Date.now();
        metrics.lastRunEndedAt = new Date(endedAt).toISOString();
        metrics.lastRunDurationMs = endedAt - startedAt;
      }
    },
    getMetrics() {
      return { ...metrics };
    },
  };
}

export interface SingleFlightIntervalOptions {
  /** Run once immediately at start() time, in addition to the timer. Default true. */
  runImmediately?: boolean;
  onError?: (e: unknown) => void;
}

/**
 * Convenience wrapper for the common "own timer, own guard" case (nothing in this codebase needs
 * to share a guard across independent timers). Most callers with a self-guarded evaluatePending()
 * (the coalescing already lives in the method itself via a SingleFlightGuard) should just use a
 * plain setInterval(() => void this.evaluatePending(), ms) instead of this wrapper - see
 * PredictionOutcomeEvaluator.ts for that pattern. This wrapper remains for a caller that wants
 * single-flight behavior WITHOUT modifying the wrapped function itself.
 */
export function startSingleFlightInterval(
  fn: () => Promise<void>,
  intervalMs: number,
  options: SingleFlightIntervalOptions = {},
): SingleFlightIntervalHandle {
  const guard = createSingleFlightGuard(options.onError);
  let stopped = false;

  const intervalId: NodeJS.Timeout = setInterval(() => {
    if (!stopped) void guard.run(fn);
  }, intervalMs);

  if (options.runImmediately !== false) {
    void guard.run(fn);
  }

  return {
    stop() {
      stopped = true;
      clearInterval(intervalId);
    },
    getMetrics() {
      return guard.getMetrics();
    },
    async triggerNow() {
      await guard.run(fn);
    },
  };
}
