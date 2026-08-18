/**
 * Bounded process RSS/heap + event-loop delay sampler.
 * Fail-open: never throws into trading. Does not write every sample to SQLite.
 * Multi-hour soak is CALENDAR/EVIDENCE REQUIRED — this only records in-process samples.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { observabilityConfig } from '../config/observability';
import { recordProcessTelemetrySample } from './ObservabilityMetrics';

let timer: NodeJS.Timeout | null = null;
let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;

export function startProcessTelemetry(): void {
  try {
    if (timer) return;
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const intervalMs = observabilityConfig.processTelemetryIntervalMs;
    timer = setInterval(() => {
      try {
        const mem = process.memoryUsage();
        const delayMs = histogram ? histogram.mean / 1e6 : null;
        histogram?.reset();
        recordProcessTelemetrySample({
          ts: Date.now(),
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
          eventLoopDelayMs: delayMs != null && Number.isFinite(delayMs) ? delayMs : null,
        });
      } catch {
        /* fail-open */
      }
    }, intervalMs);
    timer.unref?.();
  } catch {
    /* fail-open: missing perf_hooks or interval must never block boot */
  }
}

export function stopProcessTelemetry(): void {
  try {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    histogram?.disable();
    histogram = null;
  } catch {
    /* fail-open */
  }
}
