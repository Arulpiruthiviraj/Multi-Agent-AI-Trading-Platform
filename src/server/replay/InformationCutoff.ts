/**
 * INFORMATION_AVAILABLE_AT_TIME_T. Throws LOOK_AHEAD_BIAS_DETECTED on future timestamps.
 */
import { ReplayClock } from '../engines/backtest/ReplayClock';

export class InformationCutoff {
  constructor(private readonly clock: ReplayClock) {}

  now(): number {
    return this.clock.now();
  }

  advance(toMs: number): void {
    this.clock.advance(toMs);
  }

  assertNotFuture(itemTimestampMs: number, context: string): void {
    this.clock.assertNotFuture(itemTimestampMs, context);
  }

  filterAtOrBefore<T>(items: T[], timestampOf: (item: T) => number, context: string): T[] {
    const t = this.clock.now();
    const out: T[] = [];
    for (const item of items) {
      const ts = timestampOf(item);
      if (ts > t) {
        throw new Error(`LOOK_AHEAD_BIAS_DETECTED: ${context} timestamp ${new Date(ts).toISOString()} is after simulated time ${new Date(t).toISOString()}`);
      }
      out.push(item);
    }
    return out;
  }

  visiblePrefix<T>(items: T[], timestampOf: (item: T) => number): T[] {
    const t = this.clock.now();
    return items.filter((item) => timestampOf(item) <= t);
  }
}
