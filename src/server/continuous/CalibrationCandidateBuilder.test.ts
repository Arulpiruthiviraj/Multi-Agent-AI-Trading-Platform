import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('CalibrationCandidateBuilder', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./CalibrationCandidateBuilder');
  let championChallenger: typeof import('./ChampionChallengerService');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_calibration_builder_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./CalibrationCandidateBuilder');
    championChallenger = await import('./ChampionChallengerService');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty candidate list when no calibration rows exist yet', async () => {
    const candidates = await mod.buildCalibrationCandidates();
    expect(candidates).toEqual([]);
  });

  it('recomputes a real cluster-corrected candidate for a seeded (agent, bucket) with clustered predictions', async () => {
    // Seed the currently "active" (raw) calibration row, as ReflectionEngine.ts would.
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'TestQuantAgent', bucketLow: 0.8, bucketHigh: 0.9,
      wins: 6, losses: 4, calibratedConfidence: 0.6, lastEvaluated: new Date().toISOString(),
    });

    // Seed 10 raw predictions for the SAME symbol, all within the same 60-minute window (a single
    // real market episode re-predicted repeatedly) - these should collapse to ~1 effective cluster,
    // not 10.
    const base = new Date('2026-08-20T14:00:00.000Z').getTime();
    for (let i = 0; i < 10; i++) {
      const id = `pred-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'TestQuantAgent', symbol: 'TEST', prediction: 'BUY', confidence: 0.85,
        reasoning: 'test prediction', timestamp: new Date(base + i * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'TEST',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i < 6 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }

    const candidates = await mod.buildCalibrationCandidates();
    expect(candidates.length).toBe(1);
    const c = candidates[0];
    expect(c.agentName).toBe('TestQuantAgent');
    expect(c.rawN).toBe(10);
    expect(c.rawWins).toBe(6);
    // All 10 predictions are 1 minute apart, well within the default evaluation horizon gap -
    // they must collapse into exactly 1 effective, independent cluster.
    expect(c.effectiveN).toBe(1);
    expect(c.inflationFactor).toBe(10);
    expect(c.currentActiveCalibratedConfidence).toBe(0.6);
    expect(c.symbolConcentration[0]).toMatchObject({ symbol: 'TEST', count: 10 });
  });

  it('runCalibrationValidationCycle FAILs the promotion gate when effective N is below the sample-size floor', async () => {
    const results = await mod.runCalibrationValidationCycle();
    expect(results.length).toBe(1);
    expect(results[0].decision).toBe('FAIL');
    expect(results[0].effectiveN).toBe(1);

    // Confirm it never touched the live (raw) calibration table.
    const row = (await db.select().from(schema.agentConfidenceCalibration)).find((r: any) => r.agentName === 'TestQuantAgent');
    expect(row.calibratedConfidence).toBe(0.6);
    expect(row.wins).toBe(6);
    expect(row.losses).toBe(4);
  });

  it('promotes once enough independent (differently-timed) evidence accumulates AT a win rate genuinely above chance', async () => {
    // Add 25 more predictions, each in its OWN, well-separated 60-minute-plus episode, for a
    // different symbol, so they count as genuinely independent clusters (not just more of the
    // same one). 20 wins / 5 losses (80%) - deliberately well above chance, so this exercises the
    // Phase 7E statistical-significance gate (Wilson lower bound > moderateCalibrationTrustMin
    // WilsonLowerBound) as well as the pre-existing sample-size floor. A 50/50 split would legitimately
    // FAIL the new gate even with plenty of effective N - see the dedicated "does NOT promote" test below.
    const base = new Date('2026-08-21T09:00:00.000Z').getTime();
    for (let i = 0; i < 25; i++) {
      const id = `pred-indep-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'TestQuantAgent', symbol: 'INDEP', prediction: 'BUY', confidence: 0.85,
        reasoning: 'independent test prediction', timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'INDEP',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i < 20 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }

    const candidates = await mod.buildCalibrationCandidates();
    const c = candidates.find((x) => x.agentName === 'TestQuantAgent')!;
    // 1 cluster from the tight-timed batch + 25 independent clusters from the 2-hour-spaced batch.
    expect(c.effectiveN).toBe(26);
    expect(c.wilsonLower).toBeGreaterThan(0.5);

    const results = await mod.runCalibrationValidationCycle();
    const result = results.find((r) => r.agentName === 'TestQuantAgent')!;
    expect(result.decision).toBe('PASS');

    const champion = await championChallenger.getChampion(mod.calibrationVersionType('TestQuantAgent', { low: 0.8, high: 0.9 }));
    expect(champion).not.toBeNull();
    expect(champion!.status).toBe('CHAMPION');

    // Still never touched the live calibration table.
    const row = (await db.select().from(schema.agentConfidenceCalibration)).find((r: any) => r.agentName === 'TestQuantAgent');
    expect(row.calibratedConfidence).toBe(0.6);
  });

  it('does NOT promote to CHAMPION when effective N clears the sample-size floor but the win rate sits at chance (Phase 7E statistical-significance gate)', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'ChanceAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 15, losses: 15, calibratedConfidence: 0.55, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-22T09:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      const id = `pred-chance-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'ChanceAgent', symbol: 'CHANCE', prediction: 'BUY', confidence: 0.65,
        reasoning: 'chance-level test prediction', timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'CHANCE',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i % 2 === 0 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }

    const candidates = await mod.buildCalibrationCandidates();
    const c = candidates.find((x) => x.agentName === 'ChanceAgent')!;
    expect(c.effectiveN).toBe(30); // clears championChallengerMinSampleSize (20)
    expect(c.wilsonLower).toBeLessThanOrEqual(0.5);

    const results = await mod.runCalibrationValidationCycle();
    const result = results.find((r) => r.agentName === 'ChanceAgent')!;
    expect(result.decision).toBe('FAIL');
    expect(result.reason).toMatch(/not.*statistically distinguishable from chance/i);

    const champion = await championChallenger.getChampion(mod.calibrationVersionType('ChanceAgent', { low: 0.6, high: 0.7 }));
    expect(champion).toBeNull();
  });

  it('flags a bucket as stale when its newest observation is older than the configured max age', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'StaleAgent', bucketLow: 0, bucketHigh: 0.6,
      wins: 1, losses: 1, calibratedConfidence: 0.5, lastEvaluated: new Date().toISOString(),
    });
    const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
    await db.insert(schema.agentPredictions).values({
      id: 'stale-pred', agentName: 'StaleAgent', symbol: 'OLD', prediction: 'BUY', confidence: 0.3,
      reasoning: 'old', timestamp: oldTs,
    });
    await db.insert(schema.predictionOutcomes).values({
      predictionId: 'stale-pred', sourceTable: 'agent_predictions', symbol: 'OLD',
      actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
      mfe: 0.01, mae: 0, outcome: 'WIN', evaluatedAt: oldTs,
    });

    const candidates = await mod.buildCalibrationCandidates();
    const stale = candidates.find((c) => c.agentName === 'StaleAgent')!;
    expect(stale.isStale).toBe(true);
  });
});
