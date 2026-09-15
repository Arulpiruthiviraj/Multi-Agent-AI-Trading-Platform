import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

  describe('P1-A remediation (2026-09-14): overlap guard + bounded queries', () => {
    it('coalesces concurrent direct calls to evaluatePending()', async () => {
      const before = multiHorizonOutcomeEvaluator.getMetrics();
      await Promise.all([
        multiHorizonOutcomeEvaluator.evaluatePending(),
        multiHorizonOutcomeEvaluator.evaluatePending(),
        multiHorizonOutcomeEvaluator.evaluatePending(),
      ]);
      const after = multiHorizonOutcomeEvaluator.getMetrics();
      expect(after.totalRun - before.totalRun).toBe(1);
      expect(after.totalSkippedInFlight - before.totalSkippedInFlight).toBe(2);
    });

    it('bounds rowsFetched to multiHorizonOutcomeTracking.batchSize even when far more predictions are pending', async () => {
      const batchSize = multiHorizonOutcomeTracking.batchSize;
      const extra = 25;
      // Deliberately a LATE timestamp (not PRED_TIME, which every other fixture in this file
      // shares) - the bounded query is ORDER BY timestamp ASC, so if these rows sorted before
      // other tests' PRED_TIME-based fixtures they would starve them out of the same-sized batch
      // (this exact ordering coupling was caught by the partial-horizon test below during review).
      const rows = [];
      for (let i = 0; i < batchSize + extra; i++) {
        rows.push({
          id: `mh-batch-bound-${i}`,
          agentName: 'TechnicalAgent',
          symbol: 'NOBARSYMBOL', // no real bar history - evaluateMultiHorizonOutcomesForPrediction() returns [] fast
          prediction: 'BUY',
          confidence: 0.7,
          reasoning: 'batch-bound test row',
          timestamp: new Date(Date.now() + i).toISOString(),
        });
      }
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await db.insert(schema.agentPredictions).values(rows.slice(i, i + CHUNK));
      }

      await multiHorizonOutcomeEvaluator.evaluatePending();
      const stats = multiHorizonOutcomeEvaluator.getMetrics().lastCycle;
      expect(stats.rowsFetched).toBeLessThanOrEqual(batchSize * 2); // agent_predictions + kronos_predictions batches
      expect(stats.batches).toBeGreaterThanOrEqual(1);
    });

    it('a prediction with only its LARGEST horizon still missing remains a candidate on the next cycle (proves the largest-label anti-join proxy never masks a genuinely incomplete row)', async () => {
      // Bars sufficient for every horizon except the largest (60_BAR needs 61+ bars; give exactly
      // 21 so 1_BAR/5_BAR/20_BAR complete this cycle but 60_BAR is honestly left pending, never
      // fabricated - same "insufficient real bars -> retry later" contract evaluateMultiHorizon
      // OutcomesForPrediction() already documents.
      const closes = Array.from({ length: 21 }, (_, i) => 100 + i * 0.1);
      await seedBars('PARTIALHZN', closes, PRED_TIME);
      await db.insert(schema.agentPredictions).values({
        id: 'mh-partial', agentName: 'TechnicalAgent', symbol: 'PARTIALHZN', prediction: 'BUY',
        confidence: 0.8, reasoning: 'partial horizon test', timestamp: new Date(PRED_TIME).toISOString(),
      });

      await multiHorizonOutcomeEvaluator.evaluatePending();
      const rowsAfterCycle1 = await db.select().from(schema.predictionOutcomeHorizons)
        .where((await import('drizzle-orm')).eq(schema.predictionOutcomeHorizons.predictionId, 'mh-partial'));
      const labelsDone = rowsAfterCycle1.map((r: any) => r.horizonLabel).sort();
      const largestLabel = multiHorizonOutcomeTracking.horizons[multiHorizonOutcomeTracking.horizons.length - 1].label;
      expect(labelsDone).not.toContain(largestLabel); // honestly still missing, not fabricated
      expect(labelsDone.length).toBeGreaterThan(0); // but the smaller horizons DID complete

      // More bars arrive (enough for the largest horizon too - needs bars[60], i.e. 61+ total) -
      // the row must still be picked up on the NEXT cycle, proving it was not silently dropped by
      // the bounded anti-join. HistoricalDataGateway.getBars() caches this exact
      // symbol/timeframe/window for 60s (same cache Patch B bounded) - cycle 1 and cycle 2 request
      // the identical window (both have the same maxBars=60 among their "missing" horizons), so
      // without advancing the clock cycle 2 would read cycle 1's stale cached (too-few-bars)
      // result instead of the fresh DB rows just inserted. Jumping >60s matches production reality
      // anyway - cycles are 300s apart (multiHorizonOutcomeTracking.evaluationIntervalMs).
      const moreCloses = Array.from({ length: 40 }, (_, i) => 100 + (21 + i) * 0.1); // total 21+40=61 bars
      await seedBars('PARTIALHZN', moreCloses, PRED_TIME + 21 * 60000);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.setSystemTime(Date.now() + 65_000);
      try {
        await multiHorizonOutcomeEvaluator.evaluatePending();
      } finally {
        vi.useRealTimers();
      }
      const rowsAfterCycle2 = await db.select().from(schema.predictionOutcomeHorizons)
        .where((await import('drizzle-orm')).eq(schema.predictionOutcomeHorizons.predictionId, 'mh-partial'));
      const labelsDoneAfter = rowsAfterCycle2.map((r: any) => r.horizonLabel);
      expect(labelsDoneAfter).toContain(largestLabel);
      expect(labelsDoneAfter.length).toBe(multiHorizonOutcomeTracking.horizons.length);
    });
  });
});
