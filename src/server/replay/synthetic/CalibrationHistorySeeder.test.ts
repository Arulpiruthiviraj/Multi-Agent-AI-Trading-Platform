import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real end-to-end proof for CalibrationHistorySeeder.ts (2026-09-14, explicit operator
 * authorization - see that file's own header for the full disclosure this represents). Uses the
 * SAME isolated-tmp-DB pattern CalibrationCandidateBuilder.test.ts already uses - never the real
 * production database. Proves the seeder's own claim: it seeds evidence, then the REAL
 * runCalibrationValidationCycle() computation (unmodified) decides whether a champion results -
 * never a directly-inserted fake "trustworthy" row.
 */
describe('seedSyntheticCalibrationHistory', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let seeder: typeof import('./CalibrationHistorySeeder');
  let candidateBuilder: typeof import('../../continuous/CalibrationCandidateBuilder');
  let championChallenger: typeof import('../../continuous/ChampionChallengerService');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_calibration_seeder_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    seeder = await import('./CalibrationHistorySeeder');
    candidateBuilder = await import('../../continuous/CalibrationCandidateBuilder');
    championChallenger = await import('../../continuous/ChampionChallengerService');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('seeds real graded rows and produces a genuinely-computed CHAMPION for a plain agent/bucket pair (agent_predictions path)', async () => {
    const results = await seeder.seedSyntheticCalibrationHistory([
      { agentName: 'TestSeedAgentPlain', bucketLow: 0.6, bucketHigh: 0.7 },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].championEstablished).toBe(true);
    expect(results[0].effectiveN).not.toBeNull();
    expect(results[0].wilsonLower).not.toBeNull();
    expect(results[0].wilsonLower!).toBeGreaterThan(0.5); // genuinely above chance, not just present

    // Never faked directly - the champion must be readable through the SAME real
    // getChampion() lookup ModerateTierEvaluator.ts's isAgentBucketCalibrationTrustworthy() uses.
    const versionType = candidateBuilder.calibrationVersionType('TestSeedAgentPlain', { low: 0.6, high: 0.7 });
    const champion = await championChallenger.getChampion(versionType);
    expect(champion).not.toBeNull();

    // The underlying evidence rows are real, gradeable rows a human could inspect - not a
    // directly-inserted champion with no backing predictions.
    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, 'TestSeedAgentPlain'));
    expect(rows.length).toBe(25);
    expect(rows.every((r: any) => r.reasoning.includes('SYNTHETIC CALIBRATION SEED'))).toBe(true);
  });

  it('seeds real graded rows and produces a genuinely-computed CHAMPION for KronosEngine (kronos_predictions path)', async () => {
    const results = await seeder.seedSyntheticCalibrationHistory([
      { agentName: 'KronosEngine', bucketLow: 0.8, bucketHigh: 0.9 },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].championEstablished).toBe(true);

    const { eq } = await import('drizzle-orm');
    const rows = await db.select().from(schema.kronosPredictions).where(eq(schema.kronosPredictions.symbol, 'SEEDCAL'));
    expect(rows.length).toBeGreaterThanOrEqual(25);
    // Each seeded prediction has a matching graded outcome (never a dangling prediction).
    const outcomes = await db.select().from(schema.predictionOutcomes).where(eq(schema.predictionOutcomes.sourceTable, 'kronos_predictions'));
    expect(outcomes.length).toBeGreaterThanOrEqual(25);
  });

  it('seeds distinct pairs independently in one call (the real VALIDATED_CONVERGENCE_CONTROL shape: JavaCoreEnsemble + KronosEngine)', async () => {
    const results = await seeder.seedSyntheticCalibrationHistory([
      { agentName: 'JavaCoreEnsembleTest', bucketLow: 0.6, bucketHigh: 0.7 },
      { agentName: 'KronosEngineTest2', bucketLow: 0.8, bucketHigh: 0.9 },
    ]);

    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.championEstablished).toBe(true);
    }
  });
});
