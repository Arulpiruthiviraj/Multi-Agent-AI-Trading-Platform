/**
 * EVENT-LOOP / MEMORY HEARTBEAT — test-only.
 * =============================================================================
 * LABEL: FAULT_INJECTION
 *
 * A setInterval-free heartbeat: a chained setImmediate that records a tick
 * every time the event loop drains. If the loop stalls (a fault wedged the
 * process, a queue grew unboundedly, a synchronous storm), the heartbeat gaps
 * grow. Tests assert:
 *   - ticks > 0 during the fault (the loop never fully stalls),
 *   - maxGapMs stays under a bound (no long stalls),
 *   - heap delta over the window stays under a bound (no unbounded growth).
 *
 * Deterministic in what it measures (it only observes); the bounds the tests
 * use are generous to avoid CI flake — the point is catching orders-of-
 * magnitude blowups, not micro-benchmarking.
 */
import { assertFaultInjectionEnabled } from './FaultInjectionGate';

export interface Heartbeat {
  /** Stop the heartbeat and return the summary. */
  stop(): HeartbeatSummary;
  /** Ticks observed so far (live read, safe to poll mid-fault). */
  readonly ticks: number;
  /** Largest gap between consecutive ticks so far, ms. */
  readonly maxGapMs: number;
}

export interface HeartbeatSummary {
  ticks: number;
  maxGapMs: number;
  heapDeltaBytes: number;
  heapStartBytes: number;
  heapEndBytes: number;
  elapsedMs: number;
}

export function startHeartbeat(): Heartbeat {
  assertFaultInjectionEnabled('startHeartbeat');
  const heapStartBytes = process.memoryUsage().heapUsed;
  const startedAt = Date.now();
  let ticks = 0;
  let maxGapMs = 0;
  let lastTick = Date.now();
  let running = true;

  const beat = () => {
    if (!running) return;
    const now = Date.now();
    ticks++;
    const gap = now - lastTick;
    if (gap > maxGapMs) maxGapMs = gap;
    lastTick = now;
    setImmediate(beat);
  };
  setImmediate(beat);

  return {
    get ticks() {
      return ticks;
    },
    get maxGapMs() {
      return maxGapMs;
    },
    stop() {
      running = false;
      const heapEndBytes = process.memoryUsage().heapUsed;
      return {
        ticks,
        maxGapMs,
        heapDeltaBytes: heapEndBytes - heapStartBytes,
        heapStartBytes,
        heapEndBytes,
        elapsedMs: Date.now() - startedAt,
      };
    },
  };
}

/**
 * Assert the heartbeat stayed healthy through a fault window. Throws a
 * descriptive error naming the fault otherwise.
 */
export function assertHeartbeatHealthy(summary: HeartbeatSummary, faultName: string, opts?: { maxGapMs?: number; maxHeapDeltaBytes?: number }): void {
  const maxGapMs = opts?.maxGapMs ?? 2000;
  const maxHeapDeltaBytes = opts?.maxHeapDeltaBytes ?? 100 * 1024 * 1024;
  if (summary.ticks === 0)
    throw new Error(`[heartbeat] ${faultName}: event loop fully stalled (0 ticks)`);
  if (summary.maxGapMs > maxGapMs)
    throw new Error(
      `[heartbeat] ${faultName}: event loop stalled — max gap ${summary.maxGapMs}ms > ${maxGapMs}ms over ${summary.ticks} ticks`,
    );
  if (summary.heapDeltaBytes > maxHeapDeltaBytes)
    throw new Error(
      `[heartbeat] ${faultName}: unbounded heap growth — +${(summary.heapDeltaBytes / 1048576).toFixed(1)}MB over ${summary.elapsedMs}ms`,
    );
}
