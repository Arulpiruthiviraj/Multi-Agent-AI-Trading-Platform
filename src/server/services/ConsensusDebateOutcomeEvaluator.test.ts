import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * ConsensusDebate P0.5 forensic measurement (2026-09-13). Same real-integration convention as
 * PredictionOutcomeEvaluator.test.ts / MultiHorizonOutcomeEvaluator.test.ts: seeds real ohlcv_bars
 * rows so evaluatePrediction()'s own bar-reading and WIN/LOSS/MFE/MAE math runs against real rows.
 */
describe('ConsensusDebateOutcomeEvaluator', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let consensusDebateOutcomeEvaluator: any;

  const PRED_TIME = new Date('2026-01-05T14:30:00.000Z').getTime();

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_debate_outcomes_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ consensusDebateOutcomeEvaluator } = await import('./ConsensusDebateOutcomeEvaluator'));
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

  function insertPrediction(id: string, symbol: string, baseConsensusSide: string, createdAt: string, debateStatus = 'VALID_PREDICTION') {
    return db.insert(schema.consensusDebatePredictions).values({
      id, traceId: `trace-${id}`, symbol, createdAt, debateStatus,
      debateDirection: debateStatus === 'VALID_PREDICTION' ? 'HOLD' : null,
      debateConfidence: debateStatus === 'VALID_PREDICTION' ? 0.8 : null,
      providersAttempted: 1, providersSucceeded: debateStatus === 'VALID_PREDICTION' ? 1 : 0, providersFailed: debateStatus === 'VALID_PREDICTION' ? 0 : 1,
      underlyingAgentCount: 2,
      underlyingEvidenceJson: '[]',
      baseConsensusSide, baseConsensusConfidence: 0.83,
      baseClearsThreshold: true, baseClearsIndependence: true,
      withDebateConsensusSide: baseConsensusSide, withDebateConsensusConfidence: 0.1,
      withDebateApproved: false,
      vetoFired: true,
    });
  }

  it('grades a real VALID_PREDICTION row against real forward price action (a good veto: price fell after a vetoed BUY)', async () => {
    const oldTimestamp = new Date(PRED_TIME).toISOString();
    const closes = [100, 99, 98, 97, 96, 95, 94, 93];
    await seedBars('DEBATEGOOD', closes, PRED_TIME);
    await insertPrediction('cdp-good', 'DEBATEGOOD', 'BUY', oldTimestamp);

    await consensusDebateOutcomeEvaluator.evaluatePending();

    const outcomes = await db.select().from(schema.predictionOutcomes);
    const row = outcomes.find((o: any) => o.predictionId === 'cdp-good' && o.sourceTable === 'consensus_debate_predictions');
    expect(row).toBeTruthy();
    expect(row.outcome).toBe('LOSS'); // vetoed BUY, price fell - a real "good veto" candidate
    expect(row.actualReturn).toBeLessThan(0);
  });

  it('grades a bad veto: price rose after a vetoed BUY', async () => {
    const oldTimestamp = new Date(PRED_TIME).toISOString();
    const closes = [100, 101, 102, 103, 104, 105, 106, 107];
    await seedBars('DEBATEBAD', closes, PRED_TIME);
    await insertPrediction('cdp-bad', 'DEBATEBAD', 'BUY', oldTimestamp);

    await consensusDebateOutcomeEvaluator.evaluatePending();

    const outcomes = await db.select().from(schema.predictionOutcomes);
    const row = outcomes.find((o: any) => o.predictionId === 'cdp-bad' && o.sourceTable === 'consensus_debate_predictions');
    expect(row).toBeTruthy();
    expect(row.outcome).toBe('WIN');
    expect(row.actualReturn).toBeGreaterThan(0);
  });

  it('never grades a FAIL_CLOSED_* row (AI reliability events are not predictions)', async () => {
    const oldTimestamp = new Date(PRED_TIME).toISOString();
    await seedBars('DEBATEFAILCLOSED', [100, 101, 102, 103, 104, 105, 106, 107], PRED_TIME);
    await insertPrediction('cdp-failclosed', 'DEBATEFAILCLOSED', 'BUY', oldTimestamp, 'FAIL_CLOSED_ERROR');

    await consensusDebateOutcomeEvaluator.evaluatePending();

    const outcomes = await db.select().from(schema.predictionOutcomes);
    expect(outcomes.some((o: any) => o.predictionId === 'cdp-failclosed')).toBe(false);
  });

  it('skips a prediction still within the evaluation horizon, then grades it once aged - and never duplicates on a second run', async () => {
    const freshTimestamp = new Date(Date.now() - 1000).toISOString();
    await seedBars('DEBATEFRESH', [100, 101, 102, 103, 104, 105, 106, 107], PRED_TIME);
    await insertPrediction('cdp-fresh', 'DEBATEFRESH', 'BUY', freshTimestamp);

    await consensusDebateOutcomeEvaluator.evaluatePending();
    let outcomes = await db.select().from(schema.predictionOutcomes);
    expect(outcomes.some((o: any) => o.predictionId === 'cdp-fresh')).toBe(false); // too fresh

    await consensusDebateOutcomeEvaluator.evaluatePending();
    outcomes = await db.select().from(schema.predictionOutcomes);
    const dupCount = outcomes.filter((o: any) => o.predictionId === 'cdp-good').length;
    expect(dupCount).toBe(1); // the earlier 'cdp-good' row from the first test is not re-inserted
  });
});
