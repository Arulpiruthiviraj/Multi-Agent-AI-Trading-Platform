import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('strategySelectionReplay', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./strategySelectionReplay');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_strategy_fairness_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./strategySelectionReplay');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seedQuantAssessment(id: string, symbol: string, regime: any, evaluations: any[]) {
    return db.insert(schema.quantAssessments).values({
      id, symbol, timeframe: '1Day',
      regime: JSON.stringify(regime),
      marketContext: JSON.stringify({}),
      strategyEvaluations: JSON.stringify(evaluations),
      emittedTradeIdea: false,
      createdAt: new Date().toISOString(),
    });
  }

  it('lists all 5 CORE strategies even with zero quant_assessments rows, tagged NEVER_EVALUATED', async () => {
    const rows = await mod.buildStrategyFairnessReport();
    const core = rows.filter((r) => r.isCore);
    expect(core.length).toBe(5);
    for (const r of core) {
      expect(r.totalEvaluations).toBe(0);
      expect(r.status).toBe('NEVER_EVALUATED');
    }
  });

  it('classifies a strategy that is evaluated every cycle but never wins its regime-preferred subset as EVALUATED_NEVER_SELECTED', async () => {
    // BULLISH_TREND preferred subset is [MOMENTUM_BREAKOUT, PULLBACK_CONTINUATION, TREND_FOLLOWING]
    // (strategyFocus.json) - PULLBACK_CONTINUATION structurally outscores MOMENTUM_BREAKOUT here.
    const regime = { regime: 'BULLISH_TREND', confidence: 0.8, volatility: 'NORMAL', insufficientData: false };
    for (let i = 0; i < 30; i++) {
      await seedQuantAssessment(`qa-starved-${i}`, 'STARVESYM', regime, [
        { strategy: 'MOMENTUM_BREAKOUT', side: 'BUY', setupScore: 30, confidence: 0.65, conditionsMet: [], conditionsFailed: [], contradictions: [], invalidationConditions: [], stop: { price: null, basis: '' }, target: { price: null, basis: '' }, applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'] },
        { strategy: 'PULLBACK_CONTINUATION', side: 'BUY', setupScore: 90, confidence: 0.95, conditionsMet: [], conditionsFailed: [], contradictions: [], invalidationConditions: [], stop: { price: null, basis: '' }, target: { price: null, basis: '' }, applicableRegimes: ['BULLISH_TREND', 'BEARISH_TREND'] },
      ]);
    }
    const rows = await mod.buildStrategyFairnessReport();
    const momentum = rows.find((r) => r.strategyId === 'MOMENTUM_BREAKOUT')!;
    expect(momentum.totalEvaluations).toBe(30);
    expect(momentum.rank1Core).toBe(0); // always beaten by PULLBACK_CONTINUATION's higher score
    expect(momentum.predictedWinner).toBe(0);
    expect(momentum.status).toBe('EVALUATED_NEVER_SELECTED');
  });

  it('classifies a strategy that IS predicted to win real selection but has zero real emissions as SELECTED_NEVER_EMITTED - reproduces the real RANGE_REVERSION/SIDEWAYS_RANGE finding', async () => {
    // SIDEWAYS_RANGE preferred subset is [MEAN_REVERSION, RANGE_REVERSION] - RANGE_REVERSION
    // structurally outscores MEAN_REVERSION and clears MIN_STRATEGY_CONFIDENCE_TO_TRADE (0.6).
    const regime = { regime: 'SIDEWAYS_RANGE', confidence: 0.7, volatility: 'NORMAL', insufficientData: false };
    for (let i = 0; i < 30; i++) {
      await seedQuantAssessment(`qa-selected-${i}`, 'SELECTEDSYM', regime, [
        { strategy: 'MEAN_REVERSION', side: 'BUY', setupScore: 20, confidence: 0.3, conditionsMet: [], conditionsFailed: [], contradictions: [], invalidationConditions: [], stop: { price: null, basis: '' }, target: { price: null, basis: '' }, applicableRegimes: ['SIDEWAYS_RANGE'] },
        { strategy: 'RANGE_REVERSION', side: 'BUY', setupScore: 95, confidence: 0.94, conditionsMet: [], conditionsFailed: [], contradictions: [], invalidationConditions: [], stop: { price: null, basis: '' }, target: { price: null, basis: '' }, applicableRegimes: ['SIDEWAYS_RANGE'] },
      ]);
    }
    // No agent_predictions rows seeded for RANGE_REVERSION at all - real ground truth: zero emissions.
    const rows = await mod.buildStrategyFairnessReport();
    const rangeRev = rows.find((r) => r.strategyId === 'RANGE_REVERSION')!;
    expect(rangeRev.rank1Core).toBe(30);
    expect(rangeRev.predictedWinner).toBe(30);
    expect(rangeRev.realEmissions).toBe(0);
    expect(rangeRev.status).toBe('SELECTED_NEVER_EMITTED');
  });

  it('distinguishes RANKED_BUT_INELIGIBLE (wins its regime-preferred ranking but never clears the real confidence-eligibility gate) from SELECTED_NEVER_EMITTED - reproduces the real MEAN_REVERSION finding: rank1Core > 0 but predictedWinner === 0', async () => {
    const regime = { regime: 'SIDEWAYS_RANGE', confidence: 0.7, volatility: 'NORMAL', insufficientData: false };
    for (let i = 0; i < 20; i++) {
      await seedQuantAssessment(`qa-ineligible-${i}`, 'INELIGIBLESYM', regime, [
        // MEAN_REVERSION is the ONLY strategy present this cycle (so it always "wins" the ranking
        // among a field of one), but its confidence never clears MIN_STRATEGY_CONFIDENCE_TO_TRADE (0.6).
        { strategy: 'MEAN_REVERSION', side: 'BUY', setupScore: 40, confidence: 0.4, conditionsMet: [], conditionsFailed: [], contradictions: [], invalidationConditions: [], stop: { price: null, basis: '' }, target: { price: null, basis: '' }, applicableRegimes: ['SIDEWAYS_RANGE'] },
      ]);
    }
    const rows = await mod.buildStrategyFairnessReport();
    const meanRev = rows.find((r) => r.strategyId === 'MEAN_REVERSION')!;
    expect(meanRev.rank1Core).toBeGreaterThan(0);
    expect(meanRev.predictedWinner).toBe(0);
    expect(meanRev.status).toBe('RANKED_BUT_INELIGIBLE');
  });

  it('classifies a strategy with real emitted AND graded observations as HAS_GRADED_EVIDENCE', async () => {
    await db.insert(schema.agentPredictions).values({
      id: 'pred-graded-1', agentName: 'QuantEngine', symbol: 'GRADEDSYM', prediction: 'BUY', confidence: 0.7,
      reasoning: 'QuantEngine/TREND_FOLLOWING: setupScore 0.8, confidence 0.75.', timestamp: new Date().toISOString(),
    });
    await db.insert(schema.predictionOutcomes).values({
      predictionId: 'pred-graded-1', sourceTable: 'agent_predictions', symbol: 'GRADEDSYM',
      actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP', mfe: 0.01, mae: 0, outcome: 'WIN',
      evaluatedAt: new Date().toISOString(),
    });
    const rows = await mod.buildStrategyFairnessReport();
    const trendFollowing = rows.find((r) => r.strategyId === 'TREND_FOLLOWING')!;
    expect(trendFollowing.realEmissions).toBe(1);
    expect(trendFollowing.realGradedOutcomes).toBe(1);
    expect(trendFollowing.status).toBe('HAS_GRADED_EVIDENCE');
  });

  it('formatStrategyFairnessReport renders a readable text table', async () => {
    const rows = await mod.buildStrategyFairnessReport();
    const text = mod.formatStrategyFairnessReport(rows);
    expect(text).toContain('STRATEGY FAIRNESS');
    expect(text).toContain('RANGE_REVERSION');
  });
});
