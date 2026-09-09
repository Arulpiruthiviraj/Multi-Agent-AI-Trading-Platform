import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('MissedOpportunityDetector persistence + learning integration', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./MissedOpportunityDetector');
  let learningMod: typeof import('./LearningObservationRecorder');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_missedopp_persist_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
    mod = await import('./MissedOpportunityDetector');
    learningMod = await import('./LearningObservationRecorder');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('persists a missed-opportunity record and can read it back', async () => {
    await mod.persistMissedOpportunities([{
      id: 'miss-int-1', symbol: 'NVDA', detectedAt: new Date().toISOString(), classification: 'AGENT_MISS',
      classificationReason: 'test', evidenceAtDecisionJson: '{}', priceAtDetection: 120,
      evaluationHorizonMinutes: 60, evaluationStatus: 'PENDING',
    }]);
    const rows = await mod.getMissedOpportunities(new Date(Date.now() - 3600000).toISOString());
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('miss-int-1');
    expect(rows[0].evaluationStatus).toBe('PENDING');
  });

  it('persistEvaluation marks the record EVALUATED and automatically records an OBSERVATIONAL learning observation', async () => {
    await mod.persistEvaluation('miss-int-1', {
      priceAtEvaluation: 126, maxFavorableExcursionPct: 5, maxAdverseExcursionPct: -1,
    });

    const rows = await mod.getMissedOpportunities(new Date(Date.now() - 3600000).toISOString());
    const updated = rows.find((r) => r.id === 'miss-int-1');
    expect(updated?.evaluationStatus).toBe('EVALUATED');
    expect(updated?.maxFavorableExcursionPct).toBe(5);

    const observations = await learningMod.getLearningObservations({ observationType: 'MISSED_OPPORTUNITY' });
    expect(observations.length).toBe(1);
    expect(observations[0].symbol).toBe('NVDA');
    expect(observations[0].trustLevel).toBe('OBSERVATIONAL');
    expect(JSON.parse(observations[0].outcomeJson!).maxFavorableExcursionPct).toBe(5);
  });

  it('persistEvaluation on a record that does not exist does not throw and records nothing', async () => {
    await expect(mod.persistEvaluation('nonexistent-id', {
      priceAtEvaluation: 1, maxFavorableExcursionPct: 0, maxAdverseExcursionPct: 0,
    })).resolves.toBeUndefined();
    const observations = await learningMod.getLearningObservations({ observationType: 'MISSED_OPPORTUNITY' });
    expect(observations.length).toBe(1); // still just the one from the previous test - no new row for the missing id
  });

  // Real defect fix (2026-09-09): runMissedOpportunityDetectionCycle used to hardcode
  // priceAtDetection to null at its only production call site, which made every persisted record
  // permanently unevaluable (evaluateAgainstPriceSeries fails closed on a missing price by
  // design). This proves the fix: passing priceAtDetectionBySymbol now actually reaches the
  // persisted row.
  it('runMissedOpportunityDetectionCycle persists a real priceAtDetection when priceAtDetectionBySymbol supplies one', async () => {
    const ranked = {
      symbol: 'MOCX', components: {}, finalScore: 0.9, weightsUsed: {},
      rank: 1, previousRank: null, rankDelta: null,
      promotionRecommendation: 'PROMOTE' as const, promotionReason: 'test',
    } as unknown as import('./ComposableRanking').RankedCandidate;
    await mod.runMissedOpportunityDetectionCycle(
      [ranked],
      new Set(), // not actively subscribed -> SUBSCRIPTION_MISS, no other tables needed
      3_600_000,
      0,
      60,
      new Date(),
      new Map([['MOCX', 42.5]]),
    );
    const rows = await mod.getMissedOpportunities(new Date(Date.now() - 3_600_000).toISOString());
    const row = rows.find((r) => r.symbol === 'MOCX');
    expect(row).toBeDefined();
    expect(row?.classification).toBe('SUBSCRIPTION_MISS');
    expect(row?.priceAtDetection).toBe(42.5);
  });

  it('runMissedOpportunityDetectionCycle falls back to null when no price is supplied for the symbol (preserves prior behavior for other callers)', async () => {
    const ranked = {
      symbol: 'MOCY', components: {}, finalScore: 0.9, weightsUsed: {},
      rank: 1, previousRank: null, rankDelta: null,
      promotionRecommendation: 'PROMOTE' as const, promotionReason: 'test',
    } as unknown as import('./ComposableRanking').RankedCandidate;
    await mod.runMissedOpportunityDetectionCycle([ranked], new Set(), 3_600_000, 0, 60, new Date());
    const rows = await mod.getMissedOpportunities(new Date(Date.now() - 3_600_000).toISOString());
    const row = rows.find((r) => r.symbol === 'MOCY');
    expect(row).toBeDefined();
    expect(row?.priceAtDetection).toBeNull();
  });
});
