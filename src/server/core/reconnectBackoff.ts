/**
 * Shared exponential reconnect schedule for WebSocket feeds and broker REST retries.
 * Values loaded from config/runtimeIntervals.json — not TypeScript literals.
 */
import { runtimeIntervals } from '../config/runtimeIntervals';

export function networkReconnectDelayMs(attemptIndex: number): number {
  const schedule = runtimeIntervals.networkReconnectBackoffMs;
  const idx = Math.max(0, Math.min(attemptIndex, schedule.length - 1));
  return schedule[idx]!;
}

export class ReconnectBackoff {
  private attempt = 0;

  reset(): void {
    this.attempt = 0;
  }

  /** Returns delay for this attempt and advances the counter (caps at last schedule slot). */
  nextDelayMs(): number {
    const delay = networkReconnectDelayMs(this.attempt);
    if (this.attempt < runtimeIntervals.networkReconnectBackoffMs.length - 1) {
      this.attempt++;
    }
    return delay;
  }
}
