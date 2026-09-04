import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyMiss, buildMissedOpportunityRecord, evaluateAgainstPriceSeries, getFunnelSignals, type FunnelSignals } from './MissedOpportunityDetector';
import type { RankedCandidate } from './ComposableRanking';

function ranked(promotionRecommendation: RankedCandidate['promotionRecommendation'], overrides: Partial<RankedCandidate> = {}): RankedCandidate {
  return {
    symbol: 'AAPL',
    finalScore: 0.8,
    components: {} as any,
    rank: 1,
    previousRank: null,
    rankDelta: null,
    promotionRecommendation,
    promotionReason: 'test',
    ...overrides,
  } as RankedCandidate;
}

function baseSignals(overrides: Partial<FunnelSignals> = {}): FunnelSignals {
  return {
    symbol: 'AAPL',
    ranked: ranked('PROMOTE'),
    isActivelySubscribed: true,
    hadAgentIdeaThisWindow: true,
    hadChiefApproval: true,
    hadRiskAssessment: true,
    riskApproved: true,
    hadFilledTrade: true,
    ...overrides,
  };
}

describe('classifyMiss', () => {
  it('classifies a filled trade as NOT_ACTUALLY_MISS regardless of other signals', () => {
    const r = classifyMiss(baseSignals({ hadFilledTrade: true, isActivelySubscribed: false }));
    expect(r.classification).toBe('NOT_ACTUALLY_MISS');
  });

  it('classifies never-subscribed as SUBSCRIPTION_MISS', () => {
    const r = classifyMiss(baseSignals({ hadFilledTrade: false, isActivelySubscribed: false }));
    expect(r.classification).toBe('SUBSCRIPTION_MISS');
  });

  it('classifies subscribed-but-no-idea as AGENT_MISS', () => {
    const r = classifyMiss(baseSignals({ hadFilledTrade: false, hadAgentIdeaThisWindow: false }));
    expect(r.classification).toBe('AGENT_MISS');
  });

  it('classifies idea-but-no-chief-approval as CONSENSUS_REJECTION', () => {
    const r = classifyMiss(baseSignals({ hadFilledTrade: false, hadChiefApproval: false }));
    expect(r.classification).toBe('CONSENSUS_REJECTION');
  });

  it('classifies chief-approved-but-risk-rejected as RISK_REJECTION', () => {
    const r = classifyMiss(baseSignals({ hadFilledTrade: false, hadRiskAssessment: true, riskApproved: false }));
    expect(r.classification).toBe('RISK_REJECTION');
  });

  it('classifies fully approved with no fill as EXECUTION_MISS', () => {
    const r = classifyMiss(baseSignals({ hadFilledTrade: false, hadRiskAssessment: true, riskApproved: true }));
    expect(r.classification).toBe('EXECUTION_MISS');
  });

  it('classifies fully approved with no risk assessment at all as EXECUTION_MISS', () => {
    const r = classifyMiss(baseSignals({ hadFilledTrade: false, hadRiskAssessment: false, riskApproved: null }));
    expect(r.classification).toBe('EXECUTION_MISS');
  });

  it('evaluates first-failure-in-order: subscription miss takes priority over agent miss', () => {
    const r = classifyMiss(baseSignals({
      hadFilledTrade: false,
      isActivelySubscribed: false,
      hadAgentIdeaThisWindow: false,
      hadChiefApproval: false,
    }));
    expect(r.classification).toBe('SUBSCRIPTION_MISS');
  });
});

describe('buildMissedOpportunityRecord', () => {
  it('returns null when ranked is null (no ranking data available)', () => {
    const rec = buildMissedOpportunityRecord(baseSignals({ ranked: null, hadFilledTrade: false }), 100, 60);
    expect(rec).toBeNull();
  });

  it('returns null when the candidate was recommended REJECT (correctly deprioritized, not a miss)', () => {
    const rec = buildMissedOpportunityRecord(baseSignals({ ranked: ranked('REJECT'), hadFilledTrade: false }), 100, 60);
    expect(rec).toBeNull();
  });

  it('returns null when the candidate was recommended HOLD', () => {
    const rec = buildMissedOpportunityRecord(baseSignals({ ranked: ranked('HOLD'), hadFilledTrade: false }), 100, 60);
    expect(rec).toBeNull();
  });

  it('returns null when the candidate was actually filled (NOT_ACTUALLY_MISS)', () => {
    const rec = buildMissedOpportunityRecord(baseSignals({ ranked: ranked('PROMOTE'), hadFilledTrade: true }), 100, 60);
    expect(rec).toBeNull();
  });

  it('builds a record for a PROMOTE candidate that was never subscribed', () => {
    const rec = buildMissedOpportunityRecord(baseSignals({
      ranked: ranked('PROMOTE'),
      hadFilledTrade: false,
      isActivelySubscribed: false,
    }), 150.25, 60, new Date('2026-08-27T12:00:00Z'));
    expect(rec).not.toBeNull();
    expect(rec!.classification).toBe('SUBSCRIPTION_MISS');
    expect(rec!.symbol).toBe('AAPL');
    expect(rec!.priceAtDetection).toBe(150.25);
    expect(rec!.evaluationHorizonMinutes).toBe(60);
    expect(rec!.evaluationStatus).toBe('PENDING');
    expect(rec!.id).toContain('AAPL');
    const evidence = JSON.parse(rec!.evidenceAtDecisionJson);
    expect(evidence.rank).toBe(1);
  });

  it('accepts a null priceAtDetection without throwing', () => {
    const rec = buildMissedOpportunityRecord(baseSignals({
      ranked: ranked('PROMOTE'),
      hadFilledTrade: false,
      isActivelySubscribed: false,
    }), null, 60);
    expect(rec).not.toBeNull();
    expect(rec!.priceAtDetection).toBeNull();
  });
});

describe('getFunnelSignals (real-DB regression, 2026-09-04 missed-opportunity forensic audit)', () => {
  let tmpDbPath: string;

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus-missed-opp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
  });

  afterEach(() => {
    delete process.env.ARGUS_DB_PATH;
    try {
      if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
    } catch {
      // ignore cleanup errors on Windows file locks
    }
  });

  it('real bug fix: a symbol with only rejected (NO_CONSENSUS) transaction_traces rows must NOT be treated as chief-approved', async () => {
    // Confirmed live on 2026-09-04: QQQ and SPY were each classified EXECUTION_MISS ("Approved by
    // both ChiefTrader and RiskEngine, but no fill was ever recorded") purely because a
    // transaction_traces row existed for them - even though every one of those rows recorded a
    // rejected consensus round ("[NO TRADE] Confidence X% did not clear 75%."). Zero
    // CHIEF_CONSENSUS_COMPLETED approved=true events and zero risk_assessments rows existed for
    // either symbol that entire day.
    const { db } = await import('../db');
    const { transactionTraces } = await import('../db/schema');

    await db.insert(transactionTraces).values({
      traceId: 'trace_QQQ_REJECTED_1',
      symbol: 'QQQ',
      createdAt: new Date().toISOString(),
      lifecycleStatus: 'ANALYZING', // the exact real-world corrupted value seen live, pre-fix
      terminalReason: '[NO TRADE] Confidence 25.1% did not clear 75%.',
      consensusScore: 0.251,
      consensusThreshold: 0.75,
    });

    const signals = await getFunnelSignals('QQQ', null, true, new Date(Date.now() - 3600_000).toISOString());
    expect(signals.hadChiefApproval).toBe(false);

    const result = classifyMiss({ ...signals, ranked: null, hadAgentIdeaThisWindow: true, hadFilledTrade: false });
    expect(result.classification).not.toBe('EXECUTION_MISS');
    expect(result.classification).toBe('CONSENSUS_REJECTION');
  });

  it('correctly recognized approval: a symbol with a CONSENSUS_REACHED transaction_traces row IS chief-approved', async () => {
    const { db } = await import('../db');
    const { transactionTraces } = await import('../db/schema');

    await db.insert(transactionTraces).values({
      traceId: 'trace_MRK_APPROVED_1',
      symbol: 'MRK',
      createdAt: new Date().toISOString(),
      lifecycleStatus: 'CONSENSUS_REACHED',
      terminalReason: 'Consensus reached: 0.81 >= 0.75',
      consensusScore: 0.81,
      consensusThreshold: 0.75,
    });

    const signals = await getFunnelSignals('MRK', null, true, new Date(Date.now() - 3600_000).toISOString());
    expect(signals.hadChiefApproval).toBe(true);
  });
});

describe('evaluateAgainstPriceSeries', () => {
  it('returns null for an empty series', () => {
    expect(evaluateAgainstPriceSeries(100, [])).toBeNull();
  });

  it('returns null for a non-positive detection price', () => {
    expect(evaluateAgainstPriceSeries(0, [101, 102])).toBeNull();
    expect(evaluateAgainstPriceSeries(-5, [101, 102])).toBeNull();
  });

  it('computes MFE and MAE relative to detection price', () => {
    const r = evaluateAgainstPriceSeries(100, [102, 98, 105, 97, 101]);
    expect(r).not.toBeNull();
    expect(r!.maxFavorableExcursionPct).toBeCloseTo(5, 5);
    expect(r!.maxAdverseExcursionPct).toBeCloseTo(-3, 5);
    expect(r!.priceAtEvaluation).toBe(101);
  });

  it('reports zero excursion when price never moves', () => {
    const r = evaluateAgainstPriceSeries(100, [100, 100, 100]);
    expect(r!.maxFavorableExcursionPct).toBe(0);
    expect(r!.maxAdverseExcursionPct).toBe(0);
  });

  it('handles a monotonically rising series (MAE stays 0)', () => {
    const r = evaluateAgainstPriceSeries(100, [101, 103, 106]);
    expect(r!.maxAdverseExcursionPct).toBe(0);
    expect(r!.maxFavorableExcursionPct).toBeCloseTo(6, 5);
  });

  it('handles a monotonically falling series (MFE stays 0)', () => {
    const r = evaluateAgainstPriceSeries(100, [99, 97, 94]);
    expect(r!.maxFavorableExcursionPct).toBe(0);
    expect(r!.maxAdverseExcursionPct).toBeCloseTo(-6, 5);
  });
});
