import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB) for the Phase 4 point-in-time outcome
 * evaluator. Seeds real `ohlcv_bars` rows directly (bypassing HistoricalDataGateway.ensureBars,
 * which requires real Alpaca credentials) so the evaluator's own bar-reading and MFE/MAE math
 * runs against real rows, not a mock.
 */
describe('PredictionOutcomeEvaluator (Phase 4)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let evaluatePrediction: any;
  let predictionOutcomeEvaluator: any;
  let EVALUATION_HORIZON_MS: number;
  let KRONOS_EVALUATION_HORIZON_MS: number;

  const PRED_TIME = new Date('2026-01-05T14:30:00.000Z').getTime(); // arbitrary fixed epoch, well aligned to 1-min bars

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_outcomes_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ evaluatePrediction, predictionOutcomeEvaluator, EVALUATION_HORIZON_MS, KRONOS_EVALUATION_HORIZON_MS } = await import('./PredictionOutcomeEvaluator'));

    // Real bars: price rises steadily from 100 to 110 over the evaluation window, with one dip
    // to 98 partway through (so MAE should reflect the dip, not just the endpoints).
    const closes = [100, 99, 98, 101, 103, 105, 108, 110];
    const rows = closes.map((close, i) => ({
      id: `UPTEST:1Min:${PRED_TIME + i * 60000}`,
      symbol: 'UPTEST',
      timeframe: '1Min',
      timestamp: PRED_TIME + i * 60000,
      open: close, high: close, low: close, close, volume: 1000,
      source: 'test',
    }));
    for (const row of rows) {
      await db.insert(schema.ohlcvBars).values(row);
    }
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('computes a real WIN outcome with correct MFE/MAE for a BUY prediction that ends up', async () => {
    const result = await evaluatePrediction('pred-1', 'agent_predictions', 'UPTEST', 'BUY', PRED_TIME);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('WIN');
    expect(result!.actualDirection).toBe('UP');
    expect(result!.actualPrice).toBe(110);
    expect(result!.actualReturn).toBeCloseTo((110 - 100) / 100, 5);
    // MFE: best point is 110 -> +10%. MAE: worst dip is 98 -> -2%.
    expect(result!.mfe).toBeCloseTo(0.10, 4);
    expect(result!.mae).toBeCloseTo(-0.02, 4);
  });

  it('flips MFE/MAE sign for a SELL prediction (favorable = price going down)', async () => {
    const result = await evaluatePrediction('pred-2', 'agent_predictions', 'UPTEST', 'SELL', PRED_TIME);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('LOSS'); // price went UP, bad for a SELL
    // For a SELL, "favorable" is the price falling - the deepest dip (98, -2% raw) is the most
    // favorable point for a short, i.e. +2% in short-adjusted terms.
    expect(result!.mfe).toBeCloseTo(0.02, 4);
    expect(result!.mae).toBeCloseTo(-0.10, 4);
  });

  it('returns N_A outcome (never WIN/LOSS) for a HOLD prediction, with no MFE/MAE fabricated', async () => {
    const result = await evaluatePrediction('pred-3', 'agent_predictions', 'UPTEST', 'HOLD', PRED_TIME);
    expect(result).not.toBeNull();
    expect(result!.outcome).toBe('N_A');
    expect(result!.mfe).toBeNull();
    expect(result!.mae).toBeNull();
  });

  it('returns null (never fabricates) when no real bars exist for the symbol/window', async () => {
    const result = await evaluatePrediction('pred-4', 'agent_predictions', 'NOBARSYMBOL', 'BUY', PRED_TIME);
    expect(result).toBeNull();
  });

  it('evaluatePending persists a real prediction_outcomes row for an aged agent_predictions entry, and skips ones still within the horizon', async () => {
    const oldTimestamp = new Date(PRED_TIME).toISOString();
    const freshTimestamp = new Date(Date.now() - 1000).toISOString(); // 1s old - far inside the horizon

    await db.insert(schema.agentPredictions).values({
      id: 'ap-old', agentName: 'TechnicalAgent', symbol: 'UPTEST', prediction: 'BUY',
      confidence: 0.8, reasoning: 'test', timestamp: oldTimestamp,
    });
    await db.insert(schema.agentPredictions).values({
      id: 'ap-fresh', agentName: 'TechnicalAgent', symbol: 'UPTEST', prediction: 'BUY',
      confidence: 0.8, reasoning: 'test', timestamp: freshTimestamp,
    });

    await predictionOutcomeEvaluator.evaluatePending();

    const outcomes = await db.select().from(schema.predictionOutcomes);
    const oldOutcome = outcomes.find((o: any) => o.predictionId === 'ap-old');
    const freshOutcome = outcomes.find((o: any) => o.predictionId === 'ap-fresh');

    expect(oldOutcome).toBeTruthy();
    expect(oldOutcome.outcome).toBe('WIN');
    expect(freshOutcome).toBeUndefined(); // too young to evaluate yet - correctly skipped, not fabricated

    // Running it again should not duplicate the already-evaluated row.
    await predictionOutcomeEvaluator.evaluatePending();
    const outcomesAfter = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, 'ap-old'));
    expect(outcomesAfter).toHaveLength(1);
  });

  it('returns N_A (never LOSS) for a FLAT outcome on a directional BUY/SELL prediction (ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md finding M2)', async () => {
    const flatTime = PRED_TIME + 100 * 60000;
    await db.insert(schema.ohlcvBars).values([
      { id: `FLATTEST:1Min:${flatTime}`, symbol: 'FLATTEST', timeframe: '1Min', timestamp: flatTime, open: 50, high: 50, low: 50, close: 50, volume: 1000, source: 'test' },
      { id: `FLATTEST:1Min:${flatTime + 60000}`, symbol: 'FLATTEST', timeframe: '1Min', timestamp: flatTime + 60000, open: 50, high: 50, low: 50, close: 50, volume: 1000, source: 'test' },
    ]);
    const buyResult = await evaluatePrediction('pred-flat-buy', 'agent_predictions', 'FLATTEST', 'BUY', flatTime);
    const sellResult = await evaluatePrediction('pred-flat-sell', 'agent_predictions', 'FLATTEST', 'SELL', flatTime);
    expect(buyResult!.actualDirection).toBe('FLAT');
    expect(buyResult!.outcome).toBe('N_A');
    expect(sellResult!.outcome).toBe('N_A');
  });

  it('evaluates a kronos_predictions row once it clears the shorter Kronos-specific horizon, without waiting for the generic 60-minute one (finding M5)', async () => {
    expect(KRONOS_EVALUATION_HORIZON_MS).toBeLessThan(EVALUATION_HORIZON_MS);

    // Real-time-relative bars (not the fixed PRED_TIME fixture) so the age check itself
    // (Date.now() - predTime) is genuinely exercised: prediction is older than
    // KRONOS_EVALUATION_HORIZON_MS but younger than EVALUATION_HORIZON_MS - if the evaluator
    // mistakenly used the generic 60-minute horizon for Kronos, it would (correctly) skip this
    // row as still too young, and the assertion below would fail.
    const kronosTime = Date.now() - KRONOS_EVALUATION_HORIZON_MS - 30000;
    const closes = [100, 101, 102, 103, 104, 105];
    await db.insert(schema.ohlcvBars).values(closes.map((close, i) => ({
      id: `HORIZONTEST:1Min:${kronosTime + i * 60000}`,
      symbol: 'HORIZONTEST', timeframe: '1Min', timestamp: kronosTime + i * 60000,
      open: close, high: close, low: close, close, volume: 1000, source: 'test',
    })));
    await db.insert(schema.kronosPredictions).values({
      symbol: 'HORIZONTEST', timeframe: '1Min', prediction: 'BUY', confidence: 0.85,
      forecastHorizon: 5, expectedMove: 0.01, volatility: 'NORMAL', support: 95, resistance: 115,
      model: 'test-model', predictedOhlc: '[]', marketStructure: 'Unknown', momentum: 'Unknown',
      timestamp: new Date(kronosTime).toISOString(),
    });
    const [row] = await db.select().from(schema.kronosPredictions).where(eq(schema.kronosPredictions.symbol, 'HORIZONTEST'));

    await predictionOutcomeEvaluator.evaluatePending();

    const outcome = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, String(row.id)));
    expect(outcome.length).toBe(1);
  });

  it('evaluatePending skips KronosEngine rows in agent_predictions - kronos_predictions is the sole evaluated source (finding M1)', async () => {
    await db.insert(schema.agentPredictions).values({
      id: 'ap-kronos-dup', agentName: 'KronosEngine', symbol: 'UPTEST', prediction: 'BUY',
      confidence: 0.85, reasoning: 'test', timestamp: new Date(PRED_TIME).toISOString(),
    });
    await db.insert(schema.kronosPredictions).values({
      symbol: 'UPTEST', timeframe: '1Min', prediction: 'BUY', confidence: 0.85,
      forecastHorizon: 5, expectedMove: 0.01, volatility: 'NORMAL', support: 95, resistance: 115,
      model: 'test-model', predictedOhlc: '[]', marketStructure: 'Unknown', momentum: 'Unknown',
      timestamp: new Date(PRED_TIME).toISOString(),
    });

    await predictionOutcomeEvaluator.evaluatePending();

    const outcomes = await db.select().from(schema.predictionOutcomes);
    const kronosDupOutcome = outcomes.find((o: any) => o.predictionId === 'ap-kronos-dup');
    const kronosCanonicalOutcome = outcomes.find((o: any) => o.sourceTable === 'kronos_predictions' && o.symbol === 'UPTEST');
    expect(kronosDupOutcome).toBeUndefined(); // never evaluated from agent_predictions for Kronos
    expect(kronosCanonicalOutcome).toBeTruthy(); // still evaluated once, cleanly, from kronos_predictions
  });

  describe('Phase F6: news_predictions integration', () => {
    it('evaluates a due News prediction via the same real-bars mechanism, mapping BULLISH/BEARISH to BUY/SELL', async () => {
      await db.insert(schema.newsPredictions).values({
        id: 'np-1', clusterId: 'c1', traceId: 't1', symbol: 'UPTEST', direction: 'BULLISH',
        confidence: 80, expectedHorizon: 'INTRADAY', referencePrice: 100, reasoning: 'test',
        materiality: 'HIGH', catalystType: 'PRODUCT', riskLevel: 'LOW', riskVeto: false,
        sourceCount: 1, newsAgentMode: 'ACTIVE_OBSERVE', modelSource: 'test',
        createdAt: new Date(PRED_TIME).toISOString(),
      });

      await predictionOutcomeEvaluator.evaluatePending();

      const outcomes = await db.select().from(schema.predictionOutcomes)
        .where(eq(schema.predictionOutcomes.predictionId, 'np-1'));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].sourceTable).toBe('news_predictions');
      expect(outcomes[0].outcome).toBe('WIN'); // BULLISH, price rose 100 -> 110
      expect(outcomes[0].mfe).toBeCloseTo(0.10, 4);
      expect(outcomes[0].mae).toBeCloseTo(-0.02, 4);
    });

    it('uses News\'s own per-horizon window (4h for INTRADAY), not the generic 1h EVALUATION_HORIZON_MS', async () => {
      // 2 hours old: already past the generic 1h EVALUATION_HORIZON_MS, but still inside News's
      // real 4h INTRADAY window - if this evaluates, the integration is wrongly using the
      // generic horizon instead of the News-specific one.
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await db.insert(schema.newsPredictions).values({
        id: 'np-2', clusterId: 'c2', traceId: 't2', symbol: 'UPTEST', direction: 'BULLISH',
        confidence: 80, expectedHorizon: 'INTRADAY', referencePrice: 100, reasoning: 'test',
        materiality: 'HIGH', catalystType: 'PRODUCT', riskLevel: 'LOW', riskVeto: false,
        sourceCount: 1, newsAgentMode: 'ACTIVE_OBSERVE', modelSource: 'test',
        createdAt: twoHoursAgo,
      });

      await predictionOutcomeEvaluator.evaluatePending();

      const outcomes = await db.select().from(schema.predictionOutcomes)
        .where(eq(schema.predictionOutcomes.predictionId, 'np-2'));
      expect(outcomes).toHaveLength(0); // correctly not-yet-due under the real 4h window
    });

    it('BEARISH prediction maps to SELL for MFE/MAE sign flipping', async () => {
      await db.insert(schema.newsPredictions).values({
        id: 'np-3', clusterId: 'c3', traceId: 't3', symbol: 'UPTEST', direction: 'BEARISH',
        confidence: 80, expectedHorizon: 'INTRADAY', referencePrice: 100, reasoning: 'test',
        materiality: 'HIGH', catalystType: 'PRODUCT', riskLevel: 'LOW', riskVeto: false,
        sourceCount: 1, newsAgentMode: 'ACTIVE_OBSERVE', modelSource: 'test',
        createdAt: new Date(PRED_TIME).toISOString(),
      });

      await predictionOutcomeEvaluator.evaluatePending();

      const outcomes = await db.select().from(schema.predictionOutcomes)
        .where(eq(schema.predictionOutcomes.predictionId, 'np-3'));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcome).toBe('LOSS'); // BEARISH but price rose - wrong direction
    });
  });

  describe('Exit-aware evaluation wiring (2026-09-04 follow-up): TREND_FOLLOWING routes through TrendFollowingExitEvaluator, not the generic fixed-horizon path', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    async function seedDailyBars(symbol: string, entryTimeMs: number, closesFromDayMinus60: number[]): Promise<void> {
      const rows = closesFromDayMinus60.map((close, i) => {
        const ts = entryTimeMs - 60 * DAY_MS + i * DAY_MS;
        return {
          id: `${symbol}:1Day:${ts}`, symbol, timeframe: '1Day', timestamp: ts,
          open: close, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000, source: 'test',
        };
      });
      for (const row of rows) await db.insert(schema.ohlcvBars).values(row);
    }

    it('a real TREND_FOLLOWING stop-out is graded via the real exit-simulation path, not a fixed-horizon snapshot', async () => {
      // Old enough to clear TREND_FOLLOWING's own gating horizon (7d, byQuantStrategyId) but well
      // inside the 90d exit-aware walk-forward bound.
      const entryTimeMs = Date.now() - 10 * DAY_MS;
      const lookback = Array.from({ length: 61 }, () => 100);
      const rise = Array.from({ length: 5 }, (_, i) => 100 + i * 1.2);
      const fall = Array.from({ length: 4 }, (_, i) => 106 - i * 3); // forces a real close-below-SMA50 stop-out quickly
      await seedDailyBars('TFWIRING', entryTimeMs, [...lookback, ...rise, ...fall]);

      await db.insert(schema.agentPredictions).values({
        id: 'tf-wiring-1', agentName: 'QuantEngine', symbol: 'TFWIRING', prediction: 'BUY',
        confidence: 0.7, reasoning: 'QuantEngine/TREND_FOLLOWING: SMA50 uptrend, ADX confirmed',
        timestamp: new Date(entryTimeMs).toISOString(),
      });

      await predictionOutcomeEvaluator.evaluatePending();

      const outcomes = await db.select().from(schema.predictionOutcomes)
        .where(eq(schema.predictionOutcomes.predictionId, 'tf-wiring-1'));
      expect(outcomes).toHaveLength(1);
      // The generic evaluatePrediction() only ever reads 1Min bars (none seeded here for TFWIRING)
      // and would have returned null; a persisted row proves the daily-bar exit-aware path ran.
      expect(outcomes[0].mfe).toBeNull(); // exit-aware evaluator honestly does not model running MFE/MAE
      expect(outcomes[0].mae).toBeNull();
      expect(['WIN', 'LOSS', 'N_A']).toContain(outcomes[0].outcome);
    });

    it('a still-open TREND_FOLLOWING position well short of the 90d walk-forward bound is not persisted yet - never a premature snapshot', async () => {
      const entryTimeMs = Date.now() - 10 * DAY_MS;
      const lookback = Array.from({ length: 61 }, () => 100);
      const uptrend = Array.from({ length: 9 }, (_, i) => 100 + i * 0.8); // never stops out
      await seedDailyBars('TFSTILLOPEN', entryTimeMs, [...lookback, ...uptrend]);

      await db.insert(schema.agentPredictions).values({
        id: 'tf-wiring-2', agentName: 'QuantEngine', symbol: 'TFSTILLOPEN', prediction: 'BUY',
        confidence: 0.7, reasoning: 'QuantEngine/TREND_FOLLOWING: SMA50 uptrend, ADX confirmed',
        timestamp: new Date(entryTimeMs).toISOString(),
      });

      await predictionOutcomeEvaluator.evaluatePending();

      const outcomes = await db.select().from(schema.predictionOutcomes)
        .where(eq(schema.predictionOutcomes.predictionId, 'tf-wiring-2'));
      expect(outcomes).toHaveLength(0); // correctly retried later, not forced into a fabricated result
    });

    it('a non-exit-aware QuantEngine strategy (PULLBACK_CONTINUATION) still uses the generic fixed-horizon path, with real MFE/MAE computed', async () => {
      const oldTimestamp = new Date(PRED_TIME).toISOString(); // real 1Min bars already seeded on UPTEST
      await db.insert(schema.agentPredictions).values({
        id: 'pc-control-1', agentName: 'QuantEngine', symbol: 'UPTEST', prediction: 'BUY',
        confidence: 0.7, reasoning: 'QuantEngine/PULLBACK_CONTINUATION: pullback confirmed',
        timestamp: oldTimestamp,
      });

      await predictionOutcomeEvaluator.evaluatePending();

      const outcomes = await db.select().from(schema.predictionOutcomes)
        .where(eq(schema.predictionOutcomes.predictionId, 'pc-control-1'));
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcome).toBe('WIN');
      // Generic evaluatePrediction() always computes real MFE/MAE - proves this row took the
      // untouched, pre-existing path, not the exit-aware one.
      expect(outcomes[0].mfe).not.toBeNull();
      expect(outcomes[0].mae).not.toBeNull();
    });
  });

  it('self-improvement loop audit (2026-08-26): never grades a Digital Twin telemetry-pulse prediction against real bars', async () => {
    await db.insert(schema.agentPredictions).values({
      id: 'telemetry-pulse-guard-test',
      agentName: 'TechnicalAgent',
      symbol: 'UPTEST',
      prediction: 'BUY',
      confidence: 0.82,
      reasoning: 'TELEMETRY_PULSE — synthetic TechnicalAgent idea (UI only)',
      timestamp: new Date(PRED_TIME).toISOString(),
      traceId: 'telemetry-pulse-abc123',
    });

    await predictionOutcomeEvaluator.evaluatePending();

    const outcomes = await db.select().from(schema.predictionOutcomes)
      .where(eq(schema.predictionOutcomes.predictionId, 'telemetry-pulse-guard-test'));
    expect(outcomes).toHaveLength(0); // skipped, never graded WIN/LOSS from fabricated UI data
  });

  describe('P1-A remediation (2026-09-14): overlap guard + bounded queries', () => {
    it('coalesces concurrent direct calls to evaluatePending() - the exact overlap the isolated forensic harness reproduced as sustained, GC-unrecoverable RSS growth', async () => {
      const before = predictionOutcomeEvaluator.getMetrics();
      // No setInterval/start() involved at all - simulates two overlapping cycles the way a real
      // >5min cycle duration would trigger via the old bare setInterval.
      await Promise.all([
        predictionOutcomeEvaluator.evaluatePending(),
        predictionOutcomeEvaluator.evaluatePending(),
        predictionOutcomeEvaluator.evaluatePending(),
      ]);
      const after = predictionOutcomeEvaluator.getMetrics();
      // Exactly 1 of the 3 concurrent calls actually ran; the other 2 were coalesced, not queued.
      expect(after.totalRun - before.totalRun).toBe(1);
      expect(after.totalSkippedInFlight - before.totalSkippedInFlight).toBe(2);
    });

    it('bounds rowsFetched to predictionOutcomeBatchSize even when far more predictions are pending', async () => {
      const { tradingSafety } = await import('../config/tradingSafety');
      const batchSize = tradingSafety.predictionOutcomeBatchSize;
      const extra = 25;
      const oldTimestamp = new Date(PRED_TIME).toISOString();
      const rows = [];
      for (let i = 0; i < batchSize + extra; i++) {
        rows.push({
          id: `batch-bound-${i}`,
          agentName: 'TechnicalAgent',
          symbol: 'NOBARSYMBOL', // no real bar history - evaluatePrediction() returns null fast (existing "never fabricates" test above already proves this path is quick), so this test measures query-bounding, not per-row evaluation latency
          prediction: 'BUY',
          confidence: 0.7,
          reasoning: 'batch-bound test row',
          timestamp: oldTimestamp,
        });
      }
      // Chunked insert - matches the forensic harness's own seeding pattern for the same reason
      // (a single multi-thousand-row insert() call is unnecessarily heavy).
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await db.insert(schema.agentPredictions).values(rows.slice(i, i + CHUNK));
      }

      await predictionOutcomeEvaluator.evaluatePending();
      const stats = predictionOutcomeEvaluator.getMetrics().lastCycle;
      // rowsFetched includes agent_predictions + kronos_predictions + news_predictions batches
      // combined (each independently capped at batchSize) - the agent_predictions batch alone
      // must never exceed batchSize regardless of how many more rows are actually pending.
      expect(stats.rowsFetched).toBeLessThanOrEqual(batchSize * 3);
      expect(stats.batches).toBeGreaterThanOrEqual(1);
    });

    it('rowsRemaining reflects the true backlog, not just the current bounded fetch window', async () => {
      const { tradingSafety } = await import('../config/tradingSafety');
      const batchSize = tradingSafety.predictionOutcomeBatchSize;
      const oldTimestamp = new Date(PRED_TIME - 1).toISOString(); // distinct from other fixtures' PRED_TIME
      const extra = 40;
      const rows = [];
      for (let i = 0; i < batchSize + extra; i++) {
        rows.push({
          id: `remaining-check-${i}`, agentName: 'TechnicalAgent', symbol: 'NOBARSYMBOL',
          prediction: 'BUY', confidence: 0.7, reasoning: 'rowsRemaining test row', timestamp: oldTimestamp,
        });
      }
      const CHUNK = 500;
      for (let i = 0; i < rows.length; i += CHUNK) {
        await db.insert(schema.agentPredictions).values(rows.slice(i, i + CHUNK));
      }

      await predictionOutcomeEvaluator.evaluatePending();
      const stats = predictionOutcomeEvaluator.getMetrics().lastCycle;
      // The batch fetched at most batchSize rows, but the true backlog (from THIS test's own rows
      // alone, ignoring anything left by earlier tests) is batchSize+extra - rowsRemaining must
      // reflect that larger number, not just "how many this cycle happened to fetch."
      expect(stats.rowsRemaining).toBeGreaterThanOrEqual(extra);
    });

    it('restart resumes correctly: a fresh evaluator instance (simulating a process restart) picks up exactly the still-pending backlog, with no loss and no duplication', async () => {
      const { PredictionOutcomeEvaluator: EvaluatorClass } = await import('./PredictionOutcomeEvaluator');
      const oldTimestamp = new Date(PRED_TIME - 2).toISOString();
      await db.insert(schema.agentPredictions).values([
        { id: 'restart-a', agentName: 'TechnicalAgent', symbol: 'UPTEST', prediction: 'BUY', confidence: 0.8, reasoning: 'restart test', timestamp: oldTimestamp },
        { id: 'restart-b', agentName: 'TechnicalAgent', symbol: 'NOBARSYMBOL', prediction: 'BUY', confidence: 0.8, reasoning: 'restart test - stays pending (no bars)', timestamp: oldTimestamp },
      ]);

      // "Before restart": one instance evaluates once. restart-a has real bars (UPTEST) and gets
      // evaluated; restart-b has no bars and stays pending, same as production's honest
      // never-fabricate contract.
      const beforeRestart = new EvaluatorClass();
      await beforeRestart.evaluatePending();
      const afterFirstRun = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, 'restart-a'));
      expect(afterFirstRun).toHaveLength(1);

      // "Restart": a BRAND NEW instance, zero in-memory state carried over (matching what actually
      // happens on a real process restart - the guard/metrics reset, but the DB - the real cursor -
      // does not).
      const afterRestart = new EvaluatorClass();
      await afterRestart.evaluatePending();

      // restart-a is not re-evaluated (idempotent - onConflictDoNothing + the anti-join already
      // excludes it since it has a row now).
      const restartARows = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, 'restart-a'));
      expect(restartARows).toHaveLength(1); // still exactly 1, not duplicated
      // restart-b was NOT lost across the "restart" - it's still a candidate (no bars yet, so still
      // correctly pending), proving the fresh instance picked up the real DB-backed backlog rather
      // than starting from an empty/reset notion of "already seen."
      const restartBRows = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, 'restart-b'));
      expect(restartBRows).toHaveLength(0); // correctly still pending (no bars), not silently dropped
    });

    it('deliberate backfill: deleting an existing outcome row makes that prediction a real candidate again on the very next cycle', async () => {
      const oldTimestamp = new Date(PRED_TIME - 3).toISOString();
      await db.insert(schema.agentPredictions).values({
        id: 'backfill-target', agentName: 'TechnicalAgent', symbol: 'UPTEST', prediction: 'BUY',
        confidence: 0.8, reasoning: 'backfill test', timestamp: oldTimestamp,
      });
      await predictionOutcomeEvaluator.evaluatePending();
      const firstPass = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, 'backfill-target'));
      expect(firstPass).toHaveLength(1);

      // Operator (or a future backfill script) deletes the outcome to force re-evaluation - e.g.
      // after fixing a bug in evaluatePrediction()'s own math. No special "force re-evaluate" API
      // is needed: the anti-join has no persistent memory beyond the DB tables themselves.
      await db.delete(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, 'backfill-target'));

      await predictionOutcomeEvaluator.evaluatePending();
      const afterBackfill = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.predictionId, 'backfill-target'));
      expect(afterBackfill).toHaveLength(1); // re-evaluated, not permanently excluded
    });
  });
});
