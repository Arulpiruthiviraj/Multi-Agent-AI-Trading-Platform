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

  const PRED_TIME = new Date('2026-01-05T14:30:00.000Z').getTime(); // arbitrary fixed epoch, well aligned to 1-min bars

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_outcomes_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ evaluatePrediction, predictionOutcomeEvaluator, EVALUATION_HORIZON_MS } = await import('./PredictionOutcomeEvaluator'));

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
});
