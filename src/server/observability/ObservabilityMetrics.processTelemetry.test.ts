import { describe, it, expect, afterEach } from 'vitest';
import {
  recordProcessTelemetrySample,
  getProcessTelemetrySamples,
  resetMetricsForTests,
} from './ObservabilityMetrics';
import { observabilityConfig } from '../config/observability';

describe('process telemetry collector (reuses ObservabilityMetrics ring, not a second system)', () => {
  afterEach(() => {
    resetMetricsForTests();
  });

  it('records a heap/RSS/event-loop sample into the bounded ring', () => {
    const mem = process.memoryUsage();
    recordProcessTelemetrySample({
      ts: Date.now(),
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      eventLoopDelayMs: 1.25,
      eventLoopDelayP50Ms: 0.9,
      eventLoopDelayP95Ms: 2.1,
      eventLoopDelayP99Ms: 3.4,
      eventLoopDelayMaxMs: 5.0,
    });
    const samples = getProcessTelemetrySamples();
    expect(samples.length).toBe(1);
    expect(samples[0].rss).toBeGreaterThan(0);
    expect(samples[0].heapUsed).toBeGreaterThan(0);
    expect(samples[0].eventLoopDelayMs).toBe(1.25);
    // Event-loop percentiles (2026-09-14 overnight remediation, mandate section 11/28) - same
    // already-running histogram as the mean, added because a single mean can hide real tail
    // latency (e.g. the P1-B freeze itself: mostly fast, one multi-minute stall).
    expect(samples[0].eventLoopDelayP50Ms).toBe(0.9);
    expect(samples[0].eventLoopDelayP95Ms).toBe(2.1);
    expect(samples[0].eventLoopDelayP99Ms).toBe(3.4);
    expect(samples[0].eventLoopDelayMaxMs).toBe(5.0);
    expect(samples[0].soakEvidence).toBe('CALENDAR_EVIDENCE_REQUIRED');
  });

  it('caps the ring at processTelemetryRingSize from observability.json', () => {
    const cap = observabilityConfig.processTelemetryRingSize;
    const mem = process.memoryUsage();
    for (let i = 0; i < cap + 5; i++) {
      recordProcessTelemetrySample({
        ts: i,
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
        eventLoopDelayMs: 0,
        eventLoopDelayP50Ms: 0,
        eventLoopDelayP95Ms: 0,
        eventLoopDelayP99Ms: 0,
        eventLoopDelayMaxMs: 0,
      });
    }
    expect(getProcessTelemetrySamples().length).toBe(cap);
  });
});
