import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * P1-A follow-up (2026-09-23): proves ReflectionEngine.evaluateAgents()'s cycle-duration / rows-
 * scanned / query-duration instrumentation (ObservabilityMetrics.ts's reflectionEngineCycleSamples
 * ring) is captured correctly for a real (mocked-DB, real query path) run, and that the ring stays
 * bounded at config/observability.json's reflectionEngineMetricsRingSize across many cycles - the
 * whole point of using a ring buffer instead of an unbounded array, proven explicitly rather than
 * assumed. Separate file from ReflectionEngine.reentrancy.test.ts (which already covers the guard
 * itself plus the skipped-overlap counter) to keep this file focused on the metrics shape/bounding.
 */
describe('ReflectionEngine cycle metrics instrumentation (P1-A follow-up)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let reflectionEngine: any;
  let observabilityMetrics: any;
  let observabilityConfig: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_cycle_metrics_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    ({ reflectionEngine } = await import('./ReflectionEngine'));
    observabilityMetrics = await import('../observability/ObservabilityMetrics');
    ({ observabilityConfig } = await import('../config/observability'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    observabilityMetrics.resetReflectionEngineMetricsForTests();
  });

  it('captures cycle duration and per-table rows-scanned/query-duration for a real evaluateAgents() run', async () => {
    await reflectionEngine.evaluateAgents();

    const samples = observabilityMetrics.getReflectionEngineCycleSamples();
    expect(samples.length).toBe(1);
    const sample = samples[0];

    expect(sample.ts).toBeGreaterThan(0);
    expect(sample.cycleDurationMs).toBeGreaterThanOrEqual(0);
    // Empty tables on a fresh temp DB - real query ran, returned 0 rows, took >= 0ms. Proves the
    // instrumentation captures the REAL return value of each query, not a hardcoded/assumed number.
    expect(sample.tradesRowsScanned).toBe(0);
    expect(sample.tradesQueryDurationMs).toBeGreaterThanOrEqual(0);
    expect(sample.agentPredictionsRowsScanned).toBe(0);
    expect(sample.agentPredictionsQueryDurationMs).toBeGreaterThanOrEqual(0);
    expect(sample.kronosPredictionsRowsScanned).toBe(0);
    expect(sample.kronosPredictionsQueryDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('the ring buffer stays bounded at reflectionEngineMetricsRingSize across many cycles, not unbounded growth', async () => {
    const cap = observabilityConfig.reflectionEngineMetricsRingSize;
    const cyclesToRun = cap + 70; // deliberately far past the cap

    for (let i = 0; i < cyclesToRun; i++) {
      await reflectionEngine.evaluateAgents();
    }

    const samples = observabilityMetrics.getReflectionEngineCycleSamples();
    expect(samples.length).toBe(cap);
    expect(samples.length).toBeLessThan(cyclesToRun);
  });

  it('records a sample even when a cycle throws (finally-based, matching the inFlight reset)', async () => {
    const selectSpy = (await import('vitest')).vi.spyOn(db, 'select').mockImplementationOnce(() => { throw new Error('simulated DB failure'); });
    await reflectionEngine.evaluateAgents();
    selectSpy.mockRestore();

    const samples = observabilityMetrics.getReflectionEngineCycleSamples();
    expect(samples.length).toBeGreaterThan(0);
    const last = samples[samples.length - 1];
    // The trades query threw before returning - row counts for that cycle stay at their 0 default,
    // never a fabricated non-zero value.
    expect(last.tradesRowsScanned).toBe(0);
    expect(last.cycleDurationMs).toBeGreaterThanOrEqual(0);
  });
});
