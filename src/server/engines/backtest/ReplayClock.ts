/**
 * ==========================================================
 * Module: ReplayClock
 *
 * Purpose:
 * Enforces point-in-time data access during a backtest. The backtest loop
 * only ever hands the strategy a chronological prefix of bars by
 * construction; this class is the explicit, checkable assertion of that
 * invariant so a future change to the loop can't silently reintroduce
 * look-ahead bias without an immediate hard failure.
 * ==========================================================
 */
export class ReplayClock {
  private currentTimeMs: number;

  constructor(startTimeMs: number) {
    this.currentTimeMs = startTimeMs;
  }

  now(): number {
    return this.currentTimeMs;
  }

  advance(toMs: number) {
    if (toMs < this.currentTimeMs) {
      throw new Error(`ReplayClock cannot move backwards: ${new Date(toMs).toISOString()} is before current simulated time ${new Date(this.currentTimeMs).toISOString()}`);
    }
    this.currentTimeMs = toMs;
  }

  /** Hard-fails if the given timestamp is after the current simulated time. */
  assertNotFuture(itemTimestampMs: number, context: string) {
    if (itemTimestampMs > this.currentTimeMs) {
      throw new Error(`LOOK_AHEAD_BIAS_DETECTED: ${context} timestamp ${new Date(itemTimestampMs).toISOString()} is after simulated time ${new Date(this.currentTimeMs).toISOString()}`);
    }
  }
}
