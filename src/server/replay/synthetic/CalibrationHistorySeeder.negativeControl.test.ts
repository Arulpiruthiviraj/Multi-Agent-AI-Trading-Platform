import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-09-21, Synthetic Certification Framework Hardening Phase 1 close-out (explicit operator
 * requirement, "add or preserve one negative calibration control"). Same isolated-tmp-DB pattern as
 * CalibrationHistorySeeder.test.ts.
 *
 * Proves the 2026-09-21 comprehensive-calibration-matrix fix (scripts/sim/simCliArgs.ts's
 * DEFAULT_CALIBRATION_SEEDS) repaired a test PRECONDITION, not the real production gate
 * (ModerateTierEvaluator.evaluateModerateTierEligibility, completely unmodified by that fix). Both
 * assertions below call the exact same real function with the exact same real convergence
 * (TechnicalAgent 0.65 + KronosEngine 0.73 - the identical rawConfidence pair that reached
 * CHIEF_APPROVED_IDEA in the real CERTIFIED_BULLISH_ENTRY_EXIT run, see
 * agent_workspace/phase1_bullish_run1.log's "Agreed: [KronosEngine(wt:0.20), TechnicalAgent(wt:0.25)]"
 * line). Only what was pre-seeded into the isolated DB differs between the two tests - the gate
 * itself is never touched, never mocked, never bypassed.
 */
describe('MODERATE-tier calibration trust: negative + positive control on the real convergence shape', () => {
  let tmpDbPath: string;
  let seeder: typeof import('./CalibrationHistorySeeder');
  let evaluator: typeof import('../../continuous/ModerateTierEvaluator');
  let sqliteDb: any;
  const prevFlag = process.env.CONSENSUS_MODERATE_TIER_ENABLED;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_calibration_negctrl_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../../db'));
    seeder = await import('./CalibrationHistorySeeder');
    evaluator = await import('../../continuous/ModerateTierEvaluator');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => { process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true'; });
  afterEach(() => { process.env.CONSENSUS_MODERATE_TIER_ENABLED = prevFlag; });

  const REAL_CONVERGENCE_PARAMS = {
    side: 'BUY',
    confidence: 0.65,
    enoughIndependentVoices: true,
    debateSaidHold: false,
    bearSaidHold: false,
    aiContradicts: false,
    agreeingAgents: [
      { agent: 'NegCtrl_TechnicalAgent', rawConfidence: 0.65 }, // bucket 0.6-0.7
      { agent: 'NegCtrl_KronosEngine', rawConfidence: 0.73 },   // bucket 0.7-0.8 - the real gap the
      // old reactive 5-pair DEFAULT_CALIBRATION_SEEDS list never covered for ANY agent (see
      // scripts/sim/simCliArgs.ts's own header - 0.7-0.8 was entirely unseeded pre-fix).
    ],
  };

  it('NEGATIVE CONTROL: same convergence, one required bucket intentionally left unseeded -> MODERATE_REJECT_UNTRUSTED_CALIBRATION', async () => {
    // Deliberately seed only the TechnicalAgent side - proves the gate genuinely requires EVERY
    // agreeing agent's own bucket to have a champion, not just "at least one".
    await seeder.seedSyntheticCalibrationHistory([
      { agentName: 'NegCtrl_TechnicalAgent', bucketLow: 0.6, bucketHigh: 0.7 },
    ]);

    const result = await evaluator.evaluateModerateTierEligibility(REAL_CONVERGENCE_PARAMS);

    expect(result.eligible).toBe(false);
    expect(result.reasonCode).toBe('MODERATE_REJECT_UNTRUSTED_CALIBRATION');
    const kronosDetail = result.calibrationDetails.find((d) => d.agent === 'NegCtrl_KronosEngine');
    expect(kronosDetail?.trustworthy).toBe(false);
  });

  it('POSITIVE CONTROL: identical convergence, both buckets seeded via the real fixture -> MODERATE_APPROVED', async () => {
    // Same real function, same real inputs as the negative control above - only the precondition
    // (what calibration history exists) changed. This is the proof the 2026-09-21 fix repaired
    // fixture coverage, not the gate's own logic.
    await seeder.seedSyntheticCalibrationHistory([
      { agentName: 'NegCtrl_KronosEngine', bucketLow: 0.7, bucketHigh: 0.8 },
    ]);

    const result = await evaluator.evaluateModerateTierEligibility(REAL_CONVERGENCE_PARAMS);

    expect(result.eligible).toBe(true);
    expect(result.reasonCode).toBe('MODERATE_APPROVED');
    expect(result.calibrationDetails.every((d) => d.trustworthy)).toBe(true);
  });
});
