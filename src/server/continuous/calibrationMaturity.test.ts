import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('calibrationMaturity', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./calibrationMaturity');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_calibration_maturity_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./calibrationMaturity');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty report when no calibration buckets are active yet', async () => {
    const rows = await mod.buildCalibrationMaturityReport();
    expect(rows).toEqual([]);
  });

  it('classifies a bucket with real graded outcomes below the sample-size floor as LEARNING', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'ThinAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 3, losses: 2, calibratedConfidence: 0.6, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-20T09:00:00.000Z').getTime();
    for (let i = 0; i < 5; i++) {
      const id = `pred-thin-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'ThinAgent', symbol: 'THIN', prediction: 'BUY', confidence: 0.65,
        reasoning: 'thin evidence', timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'THIN',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i < 3 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }

    const rows = await mod.buildCalibrationMaturityReport();
    const row = rows.find((r) => r.agentName === 'ThinAgent')!;
    expect(row.status).toBe('LEARNING');
    expect(row.effectiveN).toBeLessThan(20);
  });

  it('classifies a bucket with enough effective N but a chance-level win rate as CALIBRATED (not TRUSTED)', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'ChanceMaturityAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 15, losses: 15, calibratedConfidence: 0.55, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-22T09:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      const id = `pred-chance-mat-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'ChanceMaturityAgent', symbol: 'CHANCEMAT', prediction: 'BUY', confidence: 0.65,
        reasoning: 'chance-level', timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'CHANCEMAT',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i % 2 === 0 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }

    const rows = await mod.buildCalibrationMaturityReport();
    const row = rows.find((r) => r.agentName === 'ChanceMaturityAgent')!;
    expect(row.status).toBe('CALIBRATED');
    expect(row.effectiveN).toBeGreaterThanOrEqual(20);
  });

  it('classifies a bucket with a genuinely qualifying live champion as TRUSTED', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'GoodMaturityAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 20, losses: 5, calibratedConfidence: 0.8, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-23T09:00:00.000Z').getTime();
    for (let i = 0; i < 25; i++) {
      const id = `pred-good-mat-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'GoodMaturityAgent', symbol: 'GOODMAT', prediction: 'BUY', confidence: 0.65,
        reasoning: 'genuinely good', timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'GOODMAT',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i < 20 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }
    const { runCalibrationValidationCycle } = await import('./CalibrationCandidateBuilder');
    const cycleResults = await runCalibrationValidationCycle();
    expect(cycleResults.find((r) => r.agentName === 'GoodMaturityAgent')?.decision).toBe('PASS');

    const rows = await mod.buildCalibrationMaturityReport();
    const row = rows.find((r) => r.agentName === 'GoodMaturityAgent')!;
    expect(row.status).toBe('TRUSTED');
  });

  it('formatCalibrationMaturityReport renders a readable text block', async () => {
    const rows = await mod.buildCalibrationMaturityReport();
    const text = mod.formatCalibrationMaturityReport(rows);
    expect(text).toContain('CALIBRATION MATURITY');
  });
});
