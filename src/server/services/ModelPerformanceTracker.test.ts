import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

/**
 * Real integration test (isolated temp SQLite DB, never data/argus.db) - proves recordPrediction()
 * writes a real, gradable row into the EXISTING agentPredictions table (not a new schema), and
 * that getRegimeSegmentedStats() correctly joins it against predictionOutcomes and groups by
 * regime, matching the same two-table join PredictionOutcomeEvaluator/ReflectionEngine already use.
 */
describe('ModelPerformanceTracker', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let recordPrediction: any;
  let getRegimeSegmentedStats: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_model_perf_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ recordPrediction, getRegimeSegmentedStats } = await import('./ModelPerformanceTracker'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('writes directly to agentPredictions - the existing table, not a new one', async () => {
    await recordPrediction({ agentName: 'JavaFactorComposite', symbol: 'AAPL', side: 'BUY', confidence: 0.7, reasoning: 'composite=0.6', regime: 'BULL_TRENDING' });
    const rows = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, 'JavaFactorComposite'));
    expect(rows.length).toBe(1);
    expect(rows[0].prediction).toBe('BUY');
    expect(rows[0].regime).toBe('BULL_TRENDING');
  });

  it('never throws when the DB insert fails - fails closed, logs, returns', async () => {
    const bogus = { agentName: 'X', symbol: 'Y', side: 'BUY' as const, confidence: Number.NaN, reasoning: 'r' };
    await expect(recordPrediction(bogus as any)).resolves.toBeUndefined();
  });

  it('getRegimeSegmentedStats groups wins/losses by the regime captured at prediction time', async () => {
    const agentName = `TestAgent_${Date.now()}`;
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    const p3 = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values([
      { id: p1, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.7, reasoning: 'r', timestamp: new Date().toISOString(), regime: 'BULL_TRENDING' },
      { id: p2, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.6, reasoning: 'r', timestamp: new Date().toISOString(), regime: 'BULL_TRENDING' },
      { id: p3, agentName, symbol: 'AAPL', prediction: 'SELL', confidence: 0.5, reasoning: 'r', timestamp: new Date().toISOString(), regime: 'HIGH_VOL_CHAOS' },
    ]);
    await db.insert(schema.predictionOutcomes).values([
      { predictionId: p1, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'WIN', actualReturn: 0.02, evaluatedAt: new Date().toISOString() },
      { predictionId: p2, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'LOSS', actualReturn: -0.01, evaluatedAt: new Date().toISOString() },
      { predictionId: p3, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'WIN', actualReturn: 0.03, evaluatedAt: new Date().toISOString() },
    ]);

    const stats = await getRegimeSegmentedStats(agentName);
    const bull = stats.find((s: any) => s.regime === 'BULL_TRENDING');
    const chaos = stats.find((s: any) => s.regime === 'HIGH_VOL_CHAOS');

    expect(bull.total).toBe(2);
    expect(bull.wins).toBe(1);
    expect(bull.winRate).toBeCloseTo(0.5, 5);
    expect(chaos.total).toBe(1);
    expect(chaos.wins).toBe(1);
    expect(chaos.winRate).toBe(1);
  });

  it('excludes N_A outcomes and un-evaluated predictions rather than counting them as losses', async () => {
    const agentName = `TestAgentNA_${Date.now()}`;
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values([
      { id: p1, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.7, reasoning: 'r', timestamp: new Date().toISOString(), regime: 'MEAN_REVERTING' },
      { id: p2, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.7, reasoning: 'r', timestamp: new Date().toISOString(), regime: 'MEAN_REVERTING' },
    ]);
    // p1 graded N_A (excluded); p2 has no outcome row at all yet (not evaluated - excluded too).
    await db.insert(schema.predictionOutcomes).values([
      { predictionId: p1, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'N_A', evaluatedAt: new Date().toISOString() },
    ]);

    const stats = await getRegimeSegmentedStats(agentName);
    expect(stats.find((s: any) => s.regime === 'MEAN_REVERTING')).toBeUndefined();
  });

  it('groups predictions with no captured regime under UNKNOWN rather than dropping them', async () => {
    const agentName = `TestAgentNoRegime_${Date.now()}`;
    const p1 = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values([
      { id: p1, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.7, reasoning: 'r', timestamp: new Date().toISOString(), regime: null },
    ]);
    await db.insert(schema.predictionOutcomes).values([
      { predictionId: p1, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'WIN', actualReturn: 0.01, evaluatedAt: new Date().toISOString() },
    ]);

    const stats = await getRegimeSegmentedStats(agentName);
    expect(stats.find((s: any) => s.regime === 'UNKNOWN')?.total).toBe(1);
  });

  it('returns an empty array for an agent with no predictions', async () => {
    const stats = await getRegimeSegmentedStats(`NeverSeen_${Date.now()}`);
    expect(stats).toEqual([]);
  });
});
