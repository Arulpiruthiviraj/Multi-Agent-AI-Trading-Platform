import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ModerateTierEvaluator', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./ModerateTierEvaluator');
  let candidateBuilder: typeof import('./CalibrationCandidateBuilder');
  let championChallenger: typeof import('./ChampionChallengerService');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_moderate_tier_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./ModerateTierEvaluator');
    candidateBuilder = await import('./CalibrationCandidateBuilder');
    championChallenger = await import('./ChampionChallengerService');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.CONSENSUS_MODERATE_TIER_ENABLED;
  });

  afterEach(() => {
    delete process.env.CONSENSUS_MODERATE_TIER_ENABLED;
  });

  const baseParams = {
    side: 'BUY',
    confidence: 0.65,
    enoughIndependentVoices: true,
    debateSaidHold: false,
    bearSaidHold: false,
    aiContradicts: false,
    agreeingAgents: [{ agent: 'TechnicalAgent', rawConfidence: 0.65 }],
  };

  it('is ineligible with reasonCode MODERATE_TIER_DISABLED when the env flag is not set', async () => {
    delete process.env.CONSENSUS_MODERATE_TIER_ENABLED;
    const result = await mod.evaluateModerateTierEligibility(baseParams);
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_TIER_DISABLED');
  });

  it('is ineligible with reasonCode MODERATE_REJECT_LOW_CONFIDENCE below the MODERATE floor', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const result = await mod.evaluateModerateTierEligibility({ ...baseParams, confidence: 0.3 });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_LOW_CONFIDENCE');
  });

  it('is ineligible for a HOLD side regardless of confidence', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const result = await mod.evaluateModerateTierEligibility({ ...baseParams, side: 'HOLD' });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_LOW_CONFIDENCE');
  });

  it('is ineligible with reasonCode MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE when the independent-agent floor is not met', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const result = await mod.evaluateModerateTierEligibility({ ...baseParams, enoughIndependentVoices: false });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE');
  });

  it('is ineligible with reasonCode MODERATE_REJECT_HARD_VETO when the adversarial debate said HOLD', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const result = await mod.evaluateModerateTierEligibility({ ...baseParams, debateSaidHold: true });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_HARD_VETO');
  });

  it('is ineligible with reasonCode MODERATE_REJECT_HARD_VETO when the bear researcher said HOLD', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const result = await mod.evaluateModerateTierEligibility({ ...baseParams, bearSaidHold: true });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_HARD_VETO');
  });

  it('is ineligible with reasonCode MODERATE_REJECT_HARD_VETO when the AI contradiction review disagrees', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const result = await mod.evaluateModerateTierEligibility({ ...baseParams, aiContradicts: true });
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_HARD_VETO');
  });

  it('is ineligible with reasonCode MODERATE_REJECT_UNTRUSTED_CALIBRATION when no calibration champion exists for the agent/bucket (the honest real-data default)', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const result = await mod.evaluateModerateTierEligibility(baseParams);
    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_UNTRUSTED_CALIBRATION');
    expect(result.calibrationDetails).toHaveLength(1);
    expect(result.calibrationDetails[0].trustworthy).toBe(false);
  });

  it('is eligible only once a statistically-validated calibration champion actually exists for every agreeing agent (real end-to-end path)', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';

    // Seed the "active" (raw) calibration row for TechnicalAgent's 0.6-0.7 bucket, then real
    // WIN-heavy, well-separated predictions so buildCalibrationCandidates/runCalibrationValidationCycle
    // produce a genuine CHAMPION for this exact bucket - never fabricated directly via getChampion.
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'TechnicalAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 20, losses: 5, calibratedConfidence: 0.7, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-23T09:00:00.000Z').getTime();
    for (let i = 0; i < 25; i++) {
      const id = `pred-trust-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'TechnicalAgent', symbol: 'TRUST', prediction: 'BUY', confidence: 0.65,
        reasoning: 'trust test prediction', timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'TRUST',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i < 20 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }

    const beforeResult = await mod.evaluateModerateTierEligibility(baseParams);
    expect(beforeResult.eligible).toBe(false); // no champion yet - validation cycle has not run

    const cycleResults = await candidateBuilder.runCalibrationValidationCycle();
    const technicalResult = cycleResults.find((r) => r.agentName === 'TechnicalAgent')!;
    expect(technicalResult.decision).toBe('PASS');

    const champion = await championChallenger.getChampion(candidateBuilder.calibrationVersionType('TechnicalAgent', { low: 0.6, high: 0.7 }));
    expect(champion).not.toBeNull();

    const afterResult = await mod.evaluateModerateTierEligibility(baseParams);
    expect(afterResult.eligible).toBe(true);
    expect(afterResult.reasonCode).toBe('MODERATE_APPROVED');
    expect(afterResult.calibrationDetails[0].trustworthy).toBe(true);
  });

  it('isAgentBucketCalibrationTrustworthy is false for an agent/bucket that was never seeded (fail-closed, no DB error)', async () => {
    const result = await mod.isAgentBucketCalibrationTrustworthy('NeverSeededAgent', 0.65);
    expect(result.trustworthy).toBe(false);
    expect(result.championEffectiveN).toBeNull();
  });
});
