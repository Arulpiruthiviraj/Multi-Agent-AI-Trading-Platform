import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 9, Stage B (ARGUS_PRE_IMPLEMENTATION_BASELINE.md) - real coverage for the AI prediction
 * validation aggregation, over real seeded agent_predictions + prediction_outcomes rows (the
 * exact shape PredictionOutcomeEvaluator.ts's own real bars-based evaluation already produces).
 */
describe('computeAIPredictionValidation (Phase 9)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let computeAIPredictionValidation: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_predvalidation_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ computeAIPredictionValidation } = await import('./AIPredictionValidation'));

    async function seed(id: string, agentName: string, prediction: string, confidence: number, actualDirection: string, outcome: string, actualReturn: number) {
      await db.insert(schema.agentPredictions).values({
        id, agentName, symbol: 'AAPL', prediction, confidence, reasoning: 'test', timestamp: new Date().toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'AAPL',
        actualPrice: 100, actualReturn, actualDirection, outcome, evaluatedAt: new Date().toISOString(),
      });
    }

    // TestAgent: 3 correct BUY calls (confidence 0.9, real UP move), 1 wrong BUY call (confidence
    // 0.6, real DOWN move), 1 correct SELL call (confidence 0.8, real DOWN move).
    await seed('p1', 'TestAgent', 'BUY', 0.9, 'UP', 'WIN', 0.02);
    await seed('p2', 'TestAgent', 'BUY', 0.9, 'UP', 'WIN', 0.03);
    await seed('p3', 'TestAgent', 'BUY', 0.9, 'UP', 'WIN', 0.01);
    await seed('p4', 'TestAgent', 'BUY', 0.6, 'DOWN', 'LOSS', -0.02);
    await seed('p5', 'TestAgent', 'SELL', 0.8, 'DOWN', 'WIN', -0.015);
    // A HOLD prediction - must be excluded from directional accuracy/Brier/precision/recall.
    await seed('p6', 'TestAgent', 'HOLD', 0.5, 'UP', 'N_A', 0.01);
    // An unevaluated prediction (no matching prediction_outcomes row) - must count toward
    // totalPredictions but not evaluatedCount/directionalCount.
    await db.insert(schema.agentPredictions).values({
      id: 'p7', agentName: 'TestAgent', symbol: 'AAPL', prediction: 'BUY', confidence: 0.7,
      reasoning: 'test', timestamp: new Date().toISOString(),
    });
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('computes real per-agent accuracy, excluding HOLD and unevaluated predictions', async () => {
    const results = await computeAIPredictionValidation();
    const agent = results.find((r: any) => r.agentName === 'TestAgent');
    expect(agent).toBeDefined();
    expect(agent.totalPredictions).toBe(7); // p1-p7
    expect(agent.evaluatedCount).toBe(6); // p1-p6 (p7 has no outcome yet)
    expect(agent.directionalCount).toBe(5); // p1-p5 (p6 is HOLD, excluded)
    expect(agent.accuracyPct).toBe(80); // 4 of 5 directional predictions correct (p1,p2,p3,p5 correct; p4 wrong)
  });

  it('computes a real Brier score (lower for well-calibrated confident-and-correct predictions)', async () => {
    const results = await computeAIPredictionValidation();
    const agent = results.find((r: any) => r.agentName === 'TestAgent');
    // p1,p2,p3: (0.9-1)^2=0.01 each; p4: (0.6-0)^2=0.36; p5: (0.8-1)^2=0.04
    // sum = 0.01*3 + 0.36 + 0.04 = 0.43, / 5 = 0.086
    expect(agent.brierScore).toBeCloseTo(0.086, 3);
  });

  it('computes real precision/recall treating BUY+realUP as the positive class', async () => {
    const results = await computeAIPredictionValidation();
    const agent = results.find((r: any) => r.agentName === 'TestAgent');
    // TP (BUY & UP) = 3 (p1,p2,p3); FP (BUY & !UP) = 1 (p4); FN (SELL & UP) = 0
    expect(agent.precision).toBeCloseTo(3 / 4, 3);
    expect(agent.recall).toBeCloseTo(3 / 3, 3);
  });

  it('computes real average realized return separately for BUY vs SELL predictions', async () => {
    const results = await computeAIPredictionValidation();
    const agent = results.find((r: any) => r.agentName === 'TestAgent');
    expect(agent.avgRealizedReturnWhenBuy).toBeCloseTo((0.02 + 0.03 + 0.01 - 0.02) / 4, 4);
    expect(agent.avgRealizedReturnWhenSell).toBeCloseTo(-0.015, 4);
  });

  it('flags statisticallyMeaningful=false below the real 20-directional-prediction threshold - honest, not fabricated', async () => {
    const results = await computeAIPredictionValidation();
    const agent = results.find((r: any) => r.agentName === 'TestAgent');
    expect(agent.statisticallyMeaningful).toBe(false); // only 5 directional predictions
  });

  it('an agent with zero predictions is honestly absent from the results, not a fabricated all-null row', async () => {
    const results = await computeAIPredictionValidation();
    expect(results.find((r: any) => r.agentName === 'NoSuchAgent')).toBeUndefined();
  });
});
