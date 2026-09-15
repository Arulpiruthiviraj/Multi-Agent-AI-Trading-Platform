/**
 * ==========================================================
 * Module: SyntheticMarketClock
 *
 * Synthetic Market Session Simulator, Phase 2 (2026-09-14 mandate). A real-time-accelerated
 * clock: unlike ReplayClock (src/server/engines/backtest/ReplayClock.ts), which only advances on
 * an explicit advance(toMs) call as a backtest loop consumes bars one at a time, this clock's
 * simulated time moves on its own as real wall-clock time elapses, scaled by speedMultiplier (10
 * real seconds at 30x = 5 simulated minutes).
 *
 * Extends ReplayClock (rather than inventing a parallel interface) so an ActiveReplaySession-typed
 * `clock: ReplayClock` field (src/server/replay/ReplayContext.ts) can hold a SyntheticMarketClock
 * directly - any code that only calls now()/advance()/assertNotFuture() (RiskEngine, the PIT
 * providers) works unmodified against a synthetic session. The parent class's own private time
 * field is intentionally left unused - this class keeps its own real-time-anchored state and
 * overrides every method rather than fighting the parent's field, since the parent has no notion
 * of "time passes on its own."
 *
 * now() is PULL-based (computed on demand from an anchor + elapsed real time), not pushed by an
 * internal timer - per the mandate's own section 27 ("never allow real-time scheduling jitter to
 * change trading decisions"), a timer's exact fire times would introduce real nondeterminism a
 * pull-based computation does not. This also means the class owns no timer/interval to clean up.
 * ==========================================================
 */
import { ReplayClock } from '../engines/backtest/ReplayClock';

export interface SyntheticMarketClockOptions {
  /** Real seconds : simulated seconds ratio. 1 = real-time, 300 = 300x accelerated. Must be > 0. */
  speedMultiplier?: number;
  /** Injectable real-clock source (Date.now by default) - lets tests control elapsed real time
   *  deterministically instead of sleeping. */
  nowFn?: () => number;
}

export class SyntheticMarketClock extends ReplayClock {
  private readonly nowFn: () => number;
  private realAnchorMs: number;
  private simAnchorMs: number;
  private currentSpeedMultiplier: number;
  private isPaused: boolean;

  constructor(startSimulatedTimeMs: number, options: SyntheticMarketClockOptions = {}) {
    super(startSimulatedTimeMs); // parent's own field is unused from here on - see class doc comment
    if (options.speedMultiplier !== undefined && !(options.speedMultiplier > 0)) {
      throw new Error(`SyntheticMarketClock speedMultiplier must be positive, got ${options.speedMultiplier}`);
    }
    this.nowFn = options.nowFn ?? Date.now;
    this.realAnchorMs = this.nowFn();
    this.simAnchorMs = startSimulatedTimeMs;
    this.currentSpeedMultiplier = options.speedMultiplier ?? 1;
    this.isPaused = false;
  }

  get speedMultiplier(): number {
    return this.currentSpeedMultiplier;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** Real (actual) wall-clock time right now, via the injectable source. */
  get realTime(): number {
    return this.nowFn();
  }

  /** Simulated time right now - computed on demand, never stale. */
  now(): number {
    if (this.isPaused) return this.simAnchorMs;
    const elapsedRealMs = this.nowFn() - this.realAnchorMs;
    return this.simAnchorMs + elapsedRealMs * this.currentSpeedMultiplier;
  }

  get simulatedTime(): number {
    return this.now();
  }

  pause(): void {
    if (this.isPaused) return;
    this.simAnchorMs = this.now(); // freeze at the current computed simulated time
    this.isPaused = true;
  }

  resume(): void {
    if (!this.isPaused) return;
    this.realAnchorMs = this.nowFn();
    this.isPaused = false;
  }

  /** Changes pace without retroactively rewriting time already elapsed - re-anchors from "now". */
  setSpeedMultiplier(multiplier: number): void {
    if (!(multiplier > 0)) {
      throw new Error(`SyntheticMarketClock speedMultiplier must be positive, got ${multiplier}`);
    }
    this.simAnchorMs = this.now();
    this.realAnchorMs = this.nowFn();
    this.currentSpeedMultiplier = multiplier;
  }

  /** Force-set simulated time (a seek), e.g. to jump straight to a session's MARKET_OPEN. Refuses
   *  to move backwards, same invariant ReplayClock.advance() already enforces, checked here
   *  against this class's own live now() rather than the unused parent field. Use this DURING a
   *  running session (a legitimate forward seek); use reset() to (re-)initialize the clock before
   *  a session's own explicit time-driving begins - see reset()'s own doc comment for why these
   *  are deliberately two different operations, not one. */
  setTime(newSimulatedTimeMs: number): void {
    const current = this.now();
    if (newSimulatedTimeMs < current) {
      throw new Error(`SyntheticMarketClock cannot move backwards: ${new Date(newSimulatedTimeMs).toISOString()} is before current simulated time ${new Date(current).toISOString()}`);
    }
    this.simAnchorMs = newSimulatedTimeMs;
    this.realAnchorMs = this.nowFn();
  }

  /**
   * Unconditionally re-initializes the clock to newSimulatedTimeMs - NOT guarded against "moving
   * backwards", unlike setTime()/advance(). This exists for a real, distinct problem setTime()
   * cannot solve: real setup work (generating synthetic bars, seeding the DB, booting the real
   * Argus core) elapses real wall-clock time between clock construction and the moment a caller is
   * ready to start explicitly driving simulated time bar-by-bar. At any speedMultiplier, that
   * elapsed real time has already auto-drifted now() forward past the intended start - so a
   * caller trying to (re-)anchor the clock to its OWN starting timestamp via setTime() would be
   * rejected by setTime()'s own backward-guard, even though nothing about simulated decision
   * ordering is actually being violated (no bar/order/idea has been timestamped or evaluated yet).
   * reset() is for exactly this one legitimate case - call it once, immediately before a session's
   * main loop begins its own explicit clock.advance(t) sequence, never mid-session.
   */
  reset(newSimulatedTimeMs: number): void {
    this.simAnchorMs = newSimulatedTimeMs;
    this.realAnchorMs = this.nowFn();
    this.isPaused = false;
  }

  /** Alias for setTime() - kept for interface parity with ReplayClock/replay code that calls
   *  clock.advance(toMs) directly (e.g. a caller stepping to a specific bar boundary). */
  advance(toMs: number): void {
    this.setTime(toMs);
  }

  /** Hard-fails if the given timestamp is after the current (live-computed) simulated time. */
  assertNotFuture(itemTimestampMs: number, context: string): void {
    const current = this.now();
    if (itemTimestampMs > current) {
      throw new Error(`LOOK_AHEAD_BIAS_DETECTED: ${context} timestamp ${new Date(itemTimestampMs).toISOString()} is after simulated time ${new Date(current).toISOString()}`);
    }
  }
}
