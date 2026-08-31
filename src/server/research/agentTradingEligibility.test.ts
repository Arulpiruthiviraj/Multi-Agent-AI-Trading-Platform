import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('agentTradingEligibility', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./agentTradingEligibility');
  let candidateBuilder: typeof import('../continuous/CalibrationCandidateBuilder');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_agent_eligibility_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./agentTradingEligibility');
    candidateBuilder = await import('../continuous/CalibrationCandidateBuilder');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seed(agent: string, symbol: string, ts: number, outcome: 'WIN' | 'LOSS', idSuffix: string, confidence = 0.65) {
    const id = `pred-${agent}-${idSuffix}`;
    return Promise.all([
      db.insert(schema.agentPredictions).values({
        id, agentName: agent, symbol, prediction: 'BUY', confidence,
        reasoning: 'test', timestamp: new Date(ts).toISOString(),
      }),
      db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol,
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome, evaluatedAt: new Date(ts).toISOString(),
      }),
    ]);
  }

  it('returns an empty report when no calibration buckets are active yet', async () => {
    const rows = await mod.buildAgentTradingEligibilityReport();
    expect(rows).toEqual([]);
  });

  it('classifies a bucket with too little evidence as NOT_MATURE', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'ThinEligAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 3, losses: 2, calibratedConfidence: 0.6, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-06T09:00:00.000Z').getTime();
    for (let i = 0; i < 5; i++) {
      await seed('ThinEligAgent', `THN${i}`, base + i * 2 * 60 * 60000, i < 3 ? 'WIN' : 'LOSS', `t${i}`);
    }
    const rows = await mod.buildAgentTradingEligibilityReport();
    const row = rows.find((r) => r.agentName === 'ThinEligAgent')!;
    expect(row.status).toBe('NOT_MATURE');
  });

  it('classifies a bucket with enough evidence but a chance-level win rate as CALIBRATION_FAILED', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'ChanceEligAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 15, losses: 15, calibratedConfidence: 0.55, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-07T09:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      await seed('ChanceEligAgent', `CHE${i}`, base + i * 2 * 60 * 60000, i % 2 === 0 ? 'WIN' : 'LOSS', `ce${i}`);
    }
    const rows = await mod.buildAgentTradingEligibilityReport();
    const row = rows.find((r) => r.agentName === 'ChanceEligAgent')!;
    expect(row.status).toBe('CALIBRATION_FAILED');
  });

  it('classifies an agent with a real, statistically BELOW-chance win rate as NO_STATISTICAL_EDGE, not merely CALIBRATION_FAILED', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'BadEdgeAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 5, losses: 25, calibratedConfidence: 0.2, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-08T09:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      await seed('BadEdgeAgent', `BAD${i}`, base + i * 2 * 60 * 60000, i < 5 ? 'WIN' : 'LOSS', `be${i}`);
    }
    const rows = await mod.buildAgentTradingEligibilityReport();
    const row = rows.find((r) => r.agentName === 'BadEdgeAgent')!;
    expect(row.status).toBe('NO_STATISTICAL_EDGE');
  });

  it('classifies a genuinely TRUSTED champion with too little chronological history to judge OOS/walk-forward as INSUFFICIENT_SAMPLE', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'TrustedButThinHistoryAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 20, losses: 5, calibratedConfidence: 0.8, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-09T09:00:00.000Z').getTime();
    for (let i = 0; i < 25; i++) {
      await seed('TrustedButThinHistoryAgent', `TBT${i}`, base + i * 2 * 60 * 60000, i < 20 ? 'WIN' : 'LOSS', `tbt${i}`);
    }
    const cycleResults = await candidateBuilder.runCalibrationValidationCycle();
    expect(cycleResults.find((r) => r.agentName === 'TrustedButThinHistoryAgent')?.decision).toBe('PASS');

    const rows = await mod.buildAgentTradingEligibilityReport();
    const row = rows.find((r) => r.agentName === 'TrustedButThinHistoryAgent')!;
    // Only 25 total observations across the whole real history - OOS/walk-forward splits each get
    // far too few observations to judge, even though the bucket itself is a genuine TRUSTED champion.
    expect(row.status).toBe('INSUFFICIENT_SAMPLE');
  });

  it('classifies a genuinely TRUSTED, consistent, OOS-passing agent as ELIGIBLE', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'FullyEligibleAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 90, losses: 30, calibratedConfidence: 0.8, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-06-01T09:00:00.000Z').getTime();
    for (let i = 0; i < 120; i++) {
      await seed('FullyEligibleAgent', `FEA${i}`, base + i * 24 * 60 * 60000, i % 4 === 3 ? 'LOSS' : 'WIN', `fea${i}`);
    }
    const cycleResults = await candidateBuilder.runCalibrationValidationCycle();
    expect(cycleResults.find((r) => r.agentName === 'FullyEligibleAgent')?.decision).toBe('PASS');

    const rows = await mod.buildAgentTradingEligibilityReport();
    const row = rows.find((r) => r.agentName === 'FullyEligibleAgent')!;
    expect(row.status).toBe('ELIGIBLE');
  });

  it('formatAgentTradingEligibilityReport renders a readable text table', async () => {
    const rows = await mod.buildAgentTradingEligibilityReport();
    const text = mod.formatAgentTradingEligibilityReport(rows);
    expect(text).toContain('TRADING ELIGIBILITY');
    expect(text).toContain('FullyEligibleAgent');
  });
});
