import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Section 33 end-to-end demonstration: seed parent -> generate candidate -> mutate -> backtest
 * -> walk-forward -> champion/challenger -> promotion decision -> rollback. Uses synthetic bar
 * fixtures (Section 33 explicitly allows this) — but this test does NOT fabricate a "successful
 * promotion" from synthetic data: isPromotableProvenance() only accepts REAL_MARKET_DATA, so a
 * SYNTHETIC_TEST_DATA-labeled dataset correctly, honestly gets rejected at the same gate real
 * data would have to clear. That rejection IS the demonstration that the fail-closed gate works
 * — promotion mechanics themselves (attemptPromotion/ChampionChallenger/RollbackMonitor) are
 * separately demonstrated below using direct evaluation fixtures, the same way this codebase
 * already unit-tests assertPromotionQuarantine() in isolation from a real backtest run.
 */
describe('Strategy Evolution Engine — end-to-end demonstration (Section 33)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;

  let StrategyDefinition: any;
  let evaluateCandidate: any;
  let runCandidateWalkForward: any;
  let generateBoundedMutations: any;
  let runEvolutionCycle: any;
  let attemptPromotion: any;
  let createCandidate: any;
  let getCandidate: any;
  let compareChallengerToChampion: any;
  let designateChallenger: any;
  let promoteChallengerToChampion: any;
  let checkForDegradation: any;
  let rollbackToPreviousChampion: any;
  let retireCandidate: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_evolution_e2e_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ evaluateCandidate } = await import('./CandidateEvaluator'));
    ({ runCandidateWalkForward } = await import('./CandidateWalkForward'));
    ({ generateBoundedMutations } = await import('./ParameterMutation'));
    ({ runEvolutionCycle, attemptPromotion } = await import('./StrategyEvolutionEngine'));
    ({ createCandidate, getCandidate } = await import('./StrategyCandidateLedger'));
    ({ compareChallengerToChampion, designateChallenger, promoteChallengerToChampion } = await import('./ChampionChallenger'));
    ({ checkForDegradation, rollbackToPreviousChampion, retireCandidate } = await import('./RollbackMonitor'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  /** entry=Always, exit=Always -> every bar pair is one deterministic round-trip trade, so trade
   *  count/direction is fully controlled by the synthetic price series, not indicator convergence. */
  function seedParent() {
    return {
      id: 'STRAT-TEST-e2e-parent-v1',
      name: 'E2E Test Strategy',
      version: 1,
      family: 'TREND',
      implementationStatus: 'REAL',
      requiredIndicators: [],
      entryConditions: { kind: 'leaf', type: 'Always' },
      confirmationConditions: null,
      invalidationConditions: null,
      stopLoss: { kind: 'FIXED_PCT', value: 5, basis: 'test' },
      takeProfit: null,
      exitConditions: { kind: 'leaf', type: 'Always' },
      positionSizing: { kind: 'FIXED_FRACTIONAL', value: 1, basis: 'test' },
      parameters: [
        { name: 'stopPct', type: 'number', range: { min: 1, max: 10, step: 1 }, default: 5 },
      ],
      parameterValues: { stopPct: 5 },
      dependencies: [],
      metadata: { description: 'test', tags: ['E2E'], assetClasses: ['EQUITY'], timeframes: ['1d'], marketRegimes: [], origin: 'BASE', createdAt: new Date().toISOString() },
      evidenceState: 'UNTESTED',
    };
  }

  function syntheticBars(n: number, provenance: string, drift = 0.002) {
    const bars = [];
    let price = 100;
    for (let i = 0; i < n; i++) {
      price = price * (1 + drift);
      bars.push({ timestamp: i * 86400000, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 10000 });
    }
    return {
      datasetId: 'e2e-test-dataset', schemaVersion: 1, symbol: 'TESTSYM', timezone: 'America/New_York',
      frequency: '1Day', adjustmentPolicy: 'RAW', missingBarPolicy: 'NONE', duplicatePolicy: 'NONE',
      source: 'test', sourceVersion: '1', market: 'US', provenance, bars,
    };
  }

  it('Phase 1-2: parent genome + bounded mutation generation stays within declared bounds', () => {
    const parent = seedParent();
    const mutations = generateBoundedMutations(parent, { maxCandidates: 4 });
    expect(mutations.length).toBeGreaterThan(0);
    for (const m of mutations) {
      const v = m.parameterValues.stopPct as number;
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(10);
      expect(v).not.toBe(5); // must actually differ from parent
    }
  });

  it('Phase 3: candidate creation persists real lineage', async () => {
    const parent = seedParent();
    const record = await createCandidate({ parentCandidateId: null, generation: 0, source: 'SEED', reason: 'seed', definition: parent });
    expect(record.id).toBe(parent.id);
    const fetched = await getCandidate(record.id);
    expect(fetched?.generation).toBe(0);
    expect(fetched?.lifecycleStatus).toBe('UNTESTED');
  });

  it('Phase 5: candidate evaluator produces real, deterministic trades from the Always/Always fixture', () => {
    const parent = seedParent();
    const dataset = syntheticBars(80, 'UNIT_FIXTURE');
    const result = evaluateCandidate(parent, dataset as any);
    expect(result.metrics.tradeCount).toBeGreaterThan(0);
    expect(result.metrics.winRate).toBeGreaterThan(0.5); // steady uptrend -> mostly winning round-trips
  });

  it('Phase 5b: the fail-closed provenance gate correctly rejects SYNTHETIC_TEST_DATA even with real trades', () => {
    const parent = seedParent();
    const dataset = syntheticBars(80, 'SYNTHETIC_TEST_DATA');
    const result = evaluateCandidate(parent, dataset as any);
    expect(result.metrics.tradeCount).toBeGreaterThan(0); // real trades did occur
    expect(result.backtestPass).toBe(false); // but never promotable from synthetic data
    expect(result.rejection).toBe('SYNTHETIC_NOT_PROMOTABLE');
  });

  it('Phase 5/OOS: walk-forward runs real folds and classifies status honestly', () => {
    const parent = seedParent();
    const dataset = syntheticBars(200, 'UNIT_FIXTURE');
    const wfo = runCandidateWalkForward(parent, dataset as any);
    expect(wfo.foldCount).toBeGreaterThanOrEqual(3);
    expect(['COMPLETED', 'FRAGILE']).toContain(wfo.status);
  });

  it('Phase 4/26: full orchestrated cycle correctly stops failed candidates at BACKTEST_ONLY (Section 26 - failed backtests cannot advance)', async () => {
    const parent = seedParent();
    const dataset = syntheticBars(80, 'SYNTHETIC_TEST_DATA'); // deliberately non-promotable
    const cycle = await runEvolutionCycle({
      parentCandidateId: null, parentDefinition: parent, parentGeneration: 0,
      dataset: dataset as any, maxCandidates: 2, force: true,
    });
    expect(cycle.ran).toBe(true);
    expect(cycle.candidates.length).toBeGreaterThan(0);
    for (const c of cycle.candidates) {
      expect(c.lifecycleStatus).toBe('BACKTEST_ONLY'); // never advanced past this on rejection
      expect(c.rejectionReason).toBe('SYNTHETIC_NOT_PROMOTABLE');
    }
  });

  it('Phase 26: evolution cycle withholds itself when the evidence gate is not forced and no organic trades exist', async () => {
    const parent = seedParent();
    const dataset = syntheticBars(80, 'UNIT_FIXTURE');
    const cycle = await runEvolutionCycle({
      parentCandidateId: null, parentDefinition: parent, parentGeneration: 0,
      dataset: dataset as any, maxCandidates: 2, force: false,
    });
    expect(cycle.ran).toBe(false);
    expect(cycle.candidates).toEqual([]);
  });

  it('Phase 8/26: promotion is blocked when assertPromotionQuarantine fails, even with a fabricated-good story', async () => {
    const parent = { ...seedParent(), id: 'STRAT-TEST-e2e-promo-1' };
    const record = await createCandidate({ parentCandidateId: null, generation: 1, source: 'MUTATION', reason: 'test', definition: parent });
    const result = await attemptPromotion({
      candidateId: record.id,
      qualityStatus: 'YELLOW', // not GREEN -> must fail
      parquetBytesWritten: true,
      executionModel: 'NEXT_BAR_OPEN',
      organicPaperTradeCountForCandidate: 999,
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons.some((r: string) => r.includes('QUALITY_STATUS_NOT_GREEN'))).toBe(true);
  });

  it('Phase 8/26: promotion is blocked on insufficient organic paper evidence even when data quality passes', async () => {
    const parent = seedParent();
    const record = await createCandidate({ parentCandidateId: null, generation: 1, source: 'MUTATION', reason: 'test2', definition: { ...parent, id: 'STRAT-TEST-e2e-2' } });
    const result = await attemptPromotion({
      candidateId: record.id,
      qualityStatus: 'GREEN',
      parquetBytesWritten: true,
      executionModel: 'NEXT_BAR_OPEN',
      organicPaperTradeCountForCandidate: 2, // far below researchSafety.minPaperTrades
    });
    expect(result.promoted).toBe(false);
    expect(result.reasons.some((r: string) => r.includes('INSUFFICIENT_PAPER_EVIDENCE'))).toBe(true);
  });

  it('Phase 22: challenger is not promoted without a statistically meaningful edge over the champion', async () => {
    const champion = { lastEvaluation: { metrics: { winRate: 0.55, tradeCount: 100, expectancy: 0.01 } } } as any;
    const weakChallenger = { lastEvaluation: { metrics: { winRate: 0.56, tradeCount: 10, expectancy: 0.01 } } } as any;
    const comparison = compareChallengerToChampion(weakChallenger, champion);
    expect(comparison.shouldPromoteChallenger).toBe(false);
  });

  it('Phase 22: challenger IS promoted when it clears a real, non-overlapping statistical margin', async () => {
    const champion = { lastEvaluation: { metrics: { winRate: 0.50, tradeCount: 200, expectancy: 0.01 } } } as any;
    const strongChallenger = { lastEvaluation: { metrics: { winRate: 0.75, tradeCount: 200, expectancy: 0.02 } } } as any;
    const comparison = compareChallengerToChampion(strongChallenger, champion);
    expect(comparison.shouldPromoteChallenger).toBe(true);
  });

  it('Phase 20/21: degradation check and rollback restore the known-good previous champion', async () => {
    const championRecord = await createCandidate({ parentCandidateId: null, generation: 0, source: 'SEED', reason: 'champion', definition: { ...seedParent(), id: 'STRAT-TEST-champion' } });
    const challengerRecord = await createCandidate({ parentCandidateId: championRecord.id, generation: 1, source: 'MUTATION', reason: 'challenger', definition: { ...seedParent(), id: 'STRAT-TEST-challenger' } });
    await designateChallenger(challengerRecord.id, 'testing challenger');
    await promoteChallengerToChampion(challengerRecord.id, championRecord.id, 'won comparison');

    const promotedChallenger = { ...challengerRecord, lastEvaluation: { metrics: { winRate: 0.7, tradeCount: 100 } } } as any;
    const degradation = checkForDegradation(promotedChallenger, 5, 50); // recent: only 5 wins of 50 -> real degradation
    expect(degradation.shouldRollback).toBe(true);

    await rollbackToPreviousChampion(challengerRecord.id, championRecord.id, degradation.reason);
    const restoredChampion = await getCandidate(championRecord.id);
    const rolledBack = await getCandidate(challengerRecord.id);
    expect(restoredChampion?.championStatus).toBe('CHAMPION');
    expect(rolledBack?.championStatus).toBe('RETIRED');
    expect(rolledBack?.lifecycleStatus).toBe('DEGRADED');
  });

  it('Phase 20: retirement never deletes a candidate row — only re-labels it', async () => {
    const record = await createCandidate({ parentCandidateId: null, generation: 0, source: 'SEED', reason: 'to retire', definition: { ...seedParent(), id: 'STRAT-TEST-retire' } });
    await retireCandidate(record.id, 'no longer useful');
    const fetched = await getCandidate(record.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.championStatus).toBe('RETIRED');
    expect(fetched?.lifecycleStatus).toBe('RETIRED');
  });
});
