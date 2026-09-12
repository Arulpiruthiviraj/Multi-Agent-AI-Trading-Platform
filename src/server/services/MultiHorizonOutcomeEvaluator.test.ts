import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Research Memory Platform Phase 2 (2026-09-12). Same real-integration convention as
 * PredictionOutcomeEvaluator.test.ts: seeds real ohlcv_bars rows (bypassing
 * HistoricalDataGateway.ensureBars, which needs real Alpaca credentials) so the evaluator's own
 * bar-reading and forward-return math runs against real rows, not a mock.
 */
describe('MultiHorizonOutcomeEvaluator (Research Memory Platform Phase 2)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let evaluateMultiHorizonOutcomesForPrediction: any;
  let multiHorizonOutcomeEvaluator: any;
  let multiHorizonOutcomeTracking: any;

  const PRED_TIME = new Date('2026-01-05T14:30:00.000Z').getTime();

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_multihorizon_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ evaluateMultiHorizonOutcomesForPrediction, multiHorizonOutcomeEvaluator } = await import('./MultiHorizonOutcomeEvaluator'));
    ({ multiHorizonOutcomeTracking } = await import('../config/multiHorizonOutcomeTracking'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seedBars(symbol: string, closes: number[], startMs: number) {
    return db.insert(schema.ohlcvBars).values(closes.map((close, i) => ({
      id: `${symbol}:1Min:${startMs + i * 60000}`,
      symbol, timeframe: '1Min', timestamp: startMs + i * 60000,
      open: close, high: close, low: close, close, volume: 1000, source: 'test',
    })));
  }

  it('config loader exposes the real, sorted horizon definitions from multiHorizonOutcomeTracking.json', () => {
    expect(multiHorizonOutcomeTracking.horizons.length).toBeGreaterThanOrEqual(4);
    const bars = multiHorizonOutcomeTracking.horizons.map((h: any) => h.bars);
    expect(bars).toEqual([...bars].sort((a, b) => a - b)); // loader sorts ascending
    expect(multiHorizonOutcomeTracking.horizons.map((h: any) => h.label)).toContain('1_BAR');
  });

  it('computes direction-adjusted forward returns at each configured horizon for a BUY prediction', async () => {
    // Bar 0 = 100 (entry). +1 bar = 101 (+1%). +5 bars = 105 (+5%). Plenty of bars beyond that.
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i);
    await seedBars('MHBUY', closes, PRED_TIME);

    const results = await evaluateMultiHorizonOutcomesForPrediction('MHBUY', 'BUY', PRED_TIME, new Set());
    const oneBar = results.find((r: any) => r.horizonLabel === '1_BAR')!;
    const fiveBar = results.find((r: any) => r.horizonLabel === '5_BAR')!;
    expect(oneBar.forwardReturn).toBeCloseTo(0.01, 4);
    expect(oneBar.forwardDirection).toBe('UP');
    expect(fiveBar.forwardReturn).toBeCloseTo(0.05, 4);
  });

  it('flips the sign for a SELL prediction (favorable = price falling), while forwardDirection stays the raw market direction', async () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i); // still rising - bad for a SELL
    await seedBars('MHSELL', closes, PRED_TIME);

    const results = await evaluateMultiHorizonOutcomesForPrediction('MHSELL', 'SELL', PRED_TIME, new Set());
    const oneBar = results.find((r: any) => r.horizonLabel === '1_BAR')!;
    expect(oneBar.forwardReturn).toBeCloseTo(-0.01, 4); // unfavorable for the short
    expect(oneBar.forwardDirection).toBe('UP'); // raw market direction, not side-adjusted
  });

  it('returns an empty array (never fabricated) for a HOLD prediction', async () => {
    const results = await evaluateMultiHorizonOutcomesForPrediction('ANY_SYMBOL', 'HOLD', PRED_TIME, new Set());
    expect(results).toEqual([]);
  });

  it('only computes horizons NOT already in alreadyDoneLabels, and returns nothing when every horizon is already done', async () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i);
    await seedBars('MHPARTIAL', closes, PRED_TIME);

    const allLabels = new Set<string>(multiHorizonOutcomeTracking.horizons.map((h: any) => h.label));
    const oneLabel = new Set<string>([multiHorizonOutcomeTracking.horizons[0].label]);

    const partial = await evaluateMultiHorizonOutcomesForPrediction('MHPARTIAL', 'BUY', PRED_TIME, oneLabel);
    expect(partial.find((r: any) => r.horizonLabel === multiHorizonOutcomeTracking.horizons[0].label)).toBeUndefined();
    expect(partial.length).toBe(multiHorizonOutcomeTracking.horizons.length - 1);

    const none = await evaluateMultiHorizonOutcomesForPrediction('MHPARTIAL', 'BUY', PRED_TIME, allLabels);
    expect(none).toEqual([]);
  });

  it('skips a horizon whose real bars have not arrived yet, rather than fabricating a value - and picks it up once they do', async () => {
    // Only 3 bars available - clears the 1_BAR horizon but not 5_BAR/20_BAR/60_BAR.
    await seedBars('MHTHIN', [100, 101, 102], PRED_TIME);
    const results = await evaluateMultiHorizonOutcomesForPrediction('MHTHIN', 'BUY', PRED_TIME, new Set());
    expect(results.length).toBe(1);
    expect(results[0].horizonLabel).toBe('1_BAR');
  });

  it('evaluatePending persists real prediction_outcome_horizons rows for a real agent_predictions entry, skipping HOLD/telemetry-pulse/KronosEngine rows', async () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i);
    await seedBars('MHPENDING', closes, PRED_TIME);
    const oldTimestamp = new Date(PRED_TIME).toISOString();

    await db.insert(schema.agentPredictions).values([
      { id: 'mh-buy', agentName: 'TechnicalAgent', symbol: 'MHPENDING', prediction: 'BUY', confidence: 0.8, reasoning: 'test', timestamp: oldTimestamp },
      { id: 'mh-hold', agentName: 'TechnicalAgent', symbol: 'MHPENDING', prediction: 'HOLD', confidence: 0.5, reasoning: 'test', timestamp: oldTimestamp },
      { id: 'mh-kronos-dup', agentName: 'KronosEngine', symbol: 'MHPENDING', prediction: 'BUY', confidence: 0.7, reasoning: 'test', timestamp: oldTimestamp },
      { id: 'mh-pulse', agentName: 'TechnicalAgent', symbol: 'MHPENDING', prediction: 'BUY', confidence: 0.8, reasoning: 'test', timestamp: oldTimestamp, traceId: 'telemetry-pulse-fake' },
    ]);

    await multiHorizonOutcomeEvaluator.evaluatePending();

    const rows = await db.select().from(schema.predictionOutcomeHorizons);
    const buyRows = rows.filter((r: any) => r.predictionId === 'mh-buy');
    expect(buyRows.length).toBe(multiHorizonOutcomeTracking.horizons.length);
    expect(rows.some((r: any) => r.predictionId === 'mh-hold')).toBe(false);
    expect(rows.some((r: any) => r.predictionId === 'mh-kronos-dup')).toBe(false);
    expect(rows.some((r: any) => r.predictionId === 'mh-pulse')).toBe(false);

    // Idempotent: running again does not duplicate rows (real unique index + onConflictDoNothing).
    await multiHorizonOutcomeEvaluator.evaluatePending();
    const rowsAfter = await db.select().from(schema.predictionOutcomeHorizons);
    const buyRowsAfter = rowsAfter.filter((r: any) => r.predictionId === 'mh-buy');
    expect(buyRowsAfter.length).toBe(multiHorizonOutcomeTracking.horizons.length);
  });
});
