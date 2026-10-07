/**
 * ==========================================================
 * Module: SyntheticWallClockOverride
 *
 * Calibration-trust multi-day certification (2026-10-07 follow-up to
 * ARGUS_CALIBRATION_TRUST_FORENSIC.md's Phases 1-4). That pass found, with file:line citations,
 * that PredictionOutcomeEvaluator / ConsensusDebateOutcomeEvaluator / ReflectionEngine /
 * CalibrationValidationWorker all read `Date.now()` directly (not an injectable `Clock`), and are
 * triggered in production by a real `setInterval` on a 5-minute / 60-second / 15-minute cadence -
 * far longer than a synthetic session's real wall-clock lifetime (~2-10s at 400x speed), so none of
 * them can ever fire inside a synthetic session on their own.
 *
 * THE DESIGN PRINCIPLE THIS FILE SERVES (do not violate it): accelerated replay must control WHEN
 * the real evaluator runs, never WHAT it computes. This file does not reimplement any grading or
 * calibration formula - it only changes what `Date.now()`/`new Date()` report, for a bounded
 * window, so that the REAL, UNMODIFIED `evaluatePending()` / `evaluateAgents()` /
 * `runCalibrationValidationCycle()` functions (called directly, never through their own
 * `setInterval`) see simulated time as "now" when deciding whether a prediction has matured and
 * when timestamping the rows they write.
 *
 * Two distinct use modes:
 *  - `withRunningClock(anchorMs, fn)`: `Date.now()` advances in REAL lockstep (the exact same delta
 *    a real clock would report) but offset so it reads `anchorMs + realElapsedSinceInstall`. This
 *    is what a synthetic session itself needs while running: `SyntheticMarketClock`'s own `now()`
 *    is `simAnchor + elapsedReal*speedMultiplier`, computed from whatever `Date.now` was captured
 *    as at its OWN construction time - installing this override BEFORE constructing/running a
 *    session makes `SyntheticSessionEngine.run()`'s bar timestamps, and every agent idea's
 *    `new Date().toISOString()` creation timestamp, land in the SAME caller-chosen simulated-day
 *    epoch, instead of the real date the script happens to execute on. Nothing about
 *    `SyntheticMarketClock`'s real-time-acceleration mechanism is touched; it still measures real
 *    elapsed milliseconds, just against an offset reference point.
 *  - `withFrozenClock(fixedMs, fn)`: `Date.now()` returns a single constant for the duration of
 *    `fn`. Used ONLY to call the real outcome-evaluator/calibration cycle functions at a simulated
 *    instant far enough past a prediction's creation time to clear `evaluationHorizonMs` - these
 *    calls do no further real-time-dependent work (no bar generation, no `SyntheticMarketClock`
 *    pacing), so a frozen value is correct and simpler than a running one.
 *
 * Production code (`PredictionOutcomeEvaluator.start()`, `ReflectionEngine.start()`, etc.) is never
 * imported or modified by this file, and this file has zero effect once restored - this is an
 * in-process-only global `Date` patch, used exclusively inside the isolated synthetic/forensic
 * child process this module's own architecture-boundary test enforces, never in the real running
 * engine.
 * ==========================================================
 */

const NativeDate = Date;

let activeRestore: (() => void) | null = null;

function install(nowFn: () => number): () => void {
  if (activeRestore) {
    throw new Error('SyntheticWallClockOverride: a clock override is already active - restore it before installing another (nesting is not supported).');
  }
  class PatchedDate extends NativeDate {
    constructor(...args: any[]) {
      if (args.length === 0) {
        super(nowFn());
      } else {
        // @ts-expect-error - spreading a variadic constructor; TS can't match the overload set here.
        super(...args);
      }
    }
    static now(): number {
      return nowFn();
    }
  }
  // eslint-disable-next-line no-global-assign
  (globalThis as any).Date = PatchedDate;
  const restore = () => {
    (globalThis as any).Date = NativeDate;
    activeRestore = null;
  };
  activeRestore = restore;
  return restore;
}

/** True real "now" - always the native clock, regardless of any currently-installed override.
 *  Callers that need a real reference point (e.g. to compute realElapsedSinceInstall) must use
 *  this rather than `Date.now()`, which may already be patched. */
export function realNowMs(): number {
  return NativeDate.now();
}

/**
 * Runs `fn` with `Date.now()`/`new Date()` reporting `anchorMs + (real elapsed ms since install)`
 * - i.e. simulated time moves at the same rate real time does, just offset to a caller-chosen
 * epoch. Always restores the native `Date` afterward, even if `fn` throws.
 */
export async function withRunningClock<T>(anchorMs: number, fn: () => Promise<T>): Promise<T> {
  const realRef = realNowMs();
  const restore = install(() => anchorMs + (realNowMs() - realRef));
  try {
    return await fn();
  } finally {
    restore();
  }
}

/**
 * Runs `fn` with `Date.now()`/`new Date()` frozen at exactly `fixedMs` for its entire duration.
 * Always restores the native `Date` afterward, even if `fn` throws.
 */
export async function withFrozenClock<T>(fixedMs: number, fn: () => Promise<T>): Promise<T> {
  const restore = install(() => fixedMs);
  try {
    return await fn();
  } finally {
    restore();
  }
}

/** True iff a clock override is currently installed - lets a caller assert it never leaks past
 *  the scope it was installed for. */
export function isClockOverrideActive(): boolean {
  return activeRestore !== null;
}
