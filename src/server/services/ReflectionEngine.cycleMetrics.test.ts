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

  it('does not materialize ungraded predictions while preserving graded calibration', async () => {
    const schema = await import('../db/schema');
    const { eq } = await import('drizzle-orm');
    const timestamp = new Date().toISOString();
    for (let i = 0; i < 100; i++) {
      await db.insert(schema.agentPredictions).values({
        id: `pending-${i}`, agentName: 'PendingAllocationTest', symbol: 'AAPL',
        prediction: 'BUY', confidence: 0.85, reasoning: 'allocation fixture', timestamp,
      });
      await db.insert(schema.kronosPredictions).values({
        symbol: 'AAPL', timeframe: '1Min', prediction: 'BUY', confidence: 0.85,
        forecastHorizon: 5, expectedMove: 0.01, volatility: 'NORMAL',
        support: 95, resistance: 115, model: 'allocation-fixture', predictedOhlc: '[]',
        marketStructure: 'Unknown', momentum: 'Unknown', timestamp,
      });
    }
    await db.insert(schema.predictionOutcomes).values({
      predictionId: 'pending-0', sourceTable: 'agent_predictions', symbol: 'AAPL',
      outcome: 'WIN', evaluatedAt: timestamp,
    });
    const kronos = await db.select().from(schema.kronosPredictions).limit(1);
    await db.insert(schema.predictionOutcomes).values({
      predictionId: String(kronos[0].id), sourceTable: 'kronos_predictions', symbol: 'AAPL',
      outcome: 'LOSS', evaluatedAt: timestamp,
    });
    await reflectionEngine.evaluateAgents();
    const last = observabilityMetrics.getReflectionEngineCycleSamples().at(-1);
    expect(last.agentPredictionsRowsScanned).toBe(1);
    expect(last.kronosPredictionsRowsScanned).toBe(1);
    const calibration = await db.select().from(schema.agentConfidenceCalibration)
      .where(eq(schema.agentConfidenceCalibration.agentName, 'PendingAllocationTest'));
    expect(calibration[0].wins).toBe(1);
    expect(calibration[0].losses).toBe(0);
    const pending = await db.select().from(schema.agentPredictions);
    expect(pending).toHaveLength(100); // read filtering never deletes pending work
  });
});
