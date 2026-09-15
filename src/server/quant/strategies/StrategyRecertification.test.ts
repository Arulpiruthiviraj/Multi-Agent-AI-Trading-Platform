import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Item #9 / mandate Phase 11 - real, isolated-DB integration tests. Seeds real
 * agent_predictions/prediction_outcomes rows (the same tables agentEdgeAnalytics.ts, already
 * tested elsewhere, reads) so this proves the real end-to-end wiring, not a mocked stand-in.
 */
describe('StrategyRecertification', () => {
  let tmpDbPath: string;
  let db: any;
  let schema: any;
  let sqliteDb: any;
  let mod: typeof import('./StrategyRecertification');
  let eligibility: typeof import('./StrategyEmissionEligibility');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_recert_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    mod = await import('./StrategyRecertification');
    eligibility = await import('./StrategyEmissionEligibility');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function seedPrediction(id: string, side: 'BUY' | 'SELL', strategyReasoningPrefix: string, outcome: 'WIN' | 'LOSS', tsOffsetMs: number): Promise<void> {
    const timestamp = new Date(Date.now() - tsOffsetMs).toISOString();
    await db.insert(schema.agentPredictions).values({
      id,
      agentName: 'QuantEngine',
      symbol: 'TEST',
      prediction: side,
      confidence: 0.65,
      reasoning: `${strategyReasoningPrefix}: setupScore 60 (3/5 conditions met), confidence 0.65.`,
      timestamp,
    });
    await db.insert(schema.predictionOutcomes).values({
      predictionId: id,
      sourceTable: 'agent_predictions',
      symbol: 'TEST',
      actualReturn: side === 'BUY' ? (outcome === 'WIN' ? 0.01 : -0.01) : (outcome === 'WIN' ? -0.01 : 0.01),
      actualDirection: side === 'BUY' ? (outcome === 'WIN' ? 'UP' : 'DOWN') : (outcome === 'WIN' ? 'DOWN' : 'UP'),
      outcome,
      evaluatedAt: timestamp,
    });
  }

  it('listQuarantinedStrategyIds returns only strategies whose LATEST transition is RETIRED or DEGRADED', async () => {
    // Explicit, strictly increasing timestamps - two transitions for the same strategy recorded
    // via `new Date()` defaults in the same millisecond would tie on createdAt, making ORDER BY
    // DESC's tie-break unspecified (a real flakiness source distinct from this module's own logic).
    const t0 = new Date('2026-09-01T00:00:00.000Z');
    const t1 = new Date('2026-09-01T00:00:01.000Z');
    await eligibility.quarantineStrategyForEmission('STRAT_A', 'below chance', { wilsonLower: 0.1 }, 20, t0);
    await eligibility.recordStrategyLifecycleTransition('STRAT_B', 'DEGRADED', 'degraded evidence', { wilsonLower: 0.3 }, 25, t0);
    await eligibility.recordStrategyLifecycleTransition('STRAT_C', 'RETIRED', 'below chance', { wilsonLower: 0.05 }, 20, t0);
    await eligibility.reinstateStrategyForEmission('STRAT_C', 'evidence improved', t1); // most recent transition -> ROLLED_BACK, not quarantined

    const ids = await mod.listQuarantinedStrategyIds();
    expect(ids).toContain('STRAT_A');
    expect(ids).toContain('STRAT_B');
    expect(ids).not.toContain('STRAT_C'); // reinstated - latest status wins
    expect(ids).not.toContain('STRAT_NEVER_TOUCHED');
  });

  it('buildRecertificationReview flags a strategy whose fresh evidence has crossed the 0.5 line with materially more effective N', async () => {
    await eligibility.quarantineStrategyForEmission(
      'RECERT_SHIFTED',
      'Below-chance evidence at retirement time',
      { effectiveN: 10, winRate: 0.2, wilsonLower: 0.1 },
      10,
    );
    // Seed enough real, independent (1-hour-apart, well beyond the 60-min cluster gap) WIN
    // predictions to push fresh effective N well past 1.5x the original (10) and the Wilson
    // lower bound above 0.5.
    // Spaced strictly beyond the 60-minute QuantEngine cluster gap (tradingSafety.evaluationHorizonMs)
    // so each row lands in its own independent cluster, not merged into one.
    for (let i = 0; i < 20; i++) {
      await seedPrediction(`recert-shifted-${i}`, 'BUY', 'QuantEngine/RECERT_SHIFTED', 'WIN', i * 7_200_000);
    }

    const rows = await mod.buildRecertificationReview();
    const row = rows.find((r) => r.strategyId === 'RECERT_SHIFTED');
    expect(row).toBeTruthy();
    expect(row!.status).toBe('RETIRED');
    expect(row!.freshEvidence).toBeTruthy();
    expect(row!.freshEvidence!.effectiveN).toBeGreaterThanOrEqual(15); // >= 1.5x original 10
    expect(row!.freshEvidence!.wilsonLower).toBeGreaterThan(0.5);
    expect(row!.evidenceHasShifted).toBe(true);
  });

  it('buildRecertificationReview does NOT flag a strategy whose fresh evidence still agrees with the original retirement', async () => {
    await eligibility.quarantineStrategyForEmission(
      'RECERT_STABLE',
      'Below-chance evidence at retirement time',
      { effectiveN: 10, winRate: 0.2, wilsonLower: 0.1 },
      10,
    );
    for (let i = 0; i < 5; i++) {
      await seedPrediction(`recert-stable-${i}`, 'BUY', 'QuantEngine/RECERT_STABLE', 'LOSS', i * 3_600_000);
    }

    const rows = await mod.buildRecertificationReview();
    const row = rows.find((r) => r.strategyId === 'RECERT_STABLE');
    expect(row).toBeTruthy();
    expect(row!.evidenceHasShifted).toBe(false);
  });

  it('reports null freshEvidence (never a fabricated comparison) when no fresh predictions exist for a quarantined strategy', async () => {
    await eligibility.quarantineStrategyForEmission('RECERT_NO_FRESH_DATA', 'below chance', { wilsonLower: 0.1 }, 10);
    const rows = await mod.buildRecertificationReview();
    const row = rows.find((r) => r.strategyId === 'RECERT_NO_FRESH_DATA');
    expect(row).toBeTruthy();
    expect(row!.freshEvidence).toBeNull();
    expect(row!.evidenceHasShifted).toBe(false);
  });

  it('NEVER reinstates a strategy - a materially shifted-evidence strategy stays exactly as quarantined as it was before the review', async () => {
    await eligibility.quarantineStrategyForEmission('RECERT_NEVER_AUTO_REINSTATE', 'below chance', { effectiveN: 10, wilsonLower: 0.1 }, 10);
    for (let i = 0; i < 20; i++) {
      await seedPrediction(`recert-noauto-${i}`, 'BUY', 'QuantEngine/RECERT_NEVER_AUTO_REINSTATE', 'WIN', i * 7_200_000);
    }
    const before = await eligibility.isStrategyQuarantinedForEmission('RECERT_NEVER_AUTO_REINSTATE');
    const rows = await mod.buildRecertificationReview();
    const row = rows.find((r) => r.strategyId === 'RECERT_NEVER_AUTO_REINSTATE');
    const after = await eligibility.isStrategyQuarantinedForEmission('RECERT_NEVER_AUTO_REINSTATE');

    expect(before).toBe(true);
    expect(row!.evidenceHasShifted).toBe(true); // the review DID notice
    expect(after).toBe(true); // but did NOT act on it - still quarantined
  });

  it('formatRecertificationReview renders a readable table without throwing on empty or populated input', () => {
    expect(() => mod.formatRecertificationReview([])).not.toThrow();
    expect(mod.formatRecertificationReview([])).toContain('No quarantined');
  });
});
