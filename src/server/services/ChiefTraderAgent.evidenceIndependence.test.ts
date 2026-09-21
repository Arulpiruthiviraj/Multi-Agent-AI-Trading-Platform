import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 2026-09-20 forensic-audit remediation regression suite.
 *
 * Verified defect: ChiefTraderAgent's minimum-independent-agent check
 * (`MIN_INDEPENDENT_AGREEING_AGENTS`) counted distinct AGENT NAMES as independent evidence.
 * `QuantEngine` (TS) and `JavaCoreEnsemble` (Java) independently recompute the SAME 5 CORE
 * strategy family set over the SAME canonical bars (`CoreStrategyRunner.java`'s own header:
 * its family map is "copied verbatim from src/server/quant/strategyFamilies.ts's
 * CORE_STRATEGY_FAMILIES") - two names, one underlying computation. They could previously satisfy
 * the 2-independent-agent floor together despite being structurally correlated, not independent.
 *
 * These tests prove the fix (evidenceIndependence.ts's resolveIndependentEvidenceGroup, wired into
 * ChiefTraderAgent.ts's uniqueIndependent computation) without changing any configured threshold:
 * consensusApprovalThreshold and MIN_INDEPENDENT_AGREEING_AGENTS are untouched by this suite.
 * Mirrors ChiefTraderAgent.quantIndependent.test.ts's own isolated-temp-DB, real-agent pattern.
 */
describe('ChiefTraderAgent - evidence-group independence (2026-09-20 remediation)', () => {
  let tmpDbPath: string;
  let ChiefTraderAgent: any;
  let capturedApprovals: any[];
  let capturedNoTrades: any[];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_evidgrp_ct_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    await import('../db');
    const { eventBus } = await import('../core/EventBus');
    const { EVENTS } = await import('../core/eventNames');
    capturedApprovals = [];
    capturedNoTrades = [];
    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => capturedApprovals.push(a));
    eventBus.on(EVENTS.DESK_NO_TRADE, (a: any) => capturedNoTrades.push(a));
    ({ ChiefTraderAgent } = await import('./ChiefTraderAgent'));
  });

  beforeEach(() => {
    capturedApprovals.length = 0;
    capturedNoTrades.length = 0;
  });

  afterEach(() => {
    delete process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED;
  });

  afterAll(async () => {
    const { sqliteDb } = await import('../db');
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function idea(overrides: Partial<{
    traceId: string; symbol: string; side: 'BUY' | 'SELL' | 'HOLD'; confidence: number;
    agent: string; reasoning: string; quantDetail: any;
  }>) {
    return {
      traceId: overrides.traceId ?? 't1',
      symbol: overrides.symbol ?? 'SYM',
      side: overrides.side ?? 'BUY',
      confidence: overrides.confidence ?? 0.9,
      agent: overrides.agent ?? 'TechnicalAgent',
      reasoning: overrides.reasoning ?? 'signal',
      ...(overrides.quantDetail ? { quantDetail: overrides.quantDetail } : {}),
    };
  }

  // Case A: structurally-correlated pair alone must NOT satisfy the independence floor.
  it('Case A: QuantEngine + JavaCoreEnsemble BUY alone -> counted as 1 independent evidence group, rejected', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0, JavaCoreEnsemble: 1.0 };
    agent.recentIdeas = [
      idea({ traceId: 'a1', symbol: 'CASEA', agent: 'QuantEngine', confidence: 0.9 }),
      idea({ traceId: 'a1', symbol: 'CASEA', agent: 'JavaCoreEnsemble', confidence: 0.9 }),
    ];

    await agent.evaluateConsensus('CASEA', 'a1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].reason).toMatch(/Only 1 independent evidence group\(s\)/);
    expect(capturedNoTrades[0].reason).toMatch(/CORE_QUANT_ENSEMBLE/);
  });

  // Case B: add a third, genuinely independent agent -> now 2 real groups, approved normally.
  it('Case B: QuantEngine + JavaCoreEnsemble + a genuinely independent agent -> 2 evidence groups, approved STRONG', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0, JavaCoreEnsemble: 1.0, TechnicalAgent: 1.0 };
    agent.recentIdeas = [
      idea({ traceId: 'b1', symbol: 'CASEB', agent: 'QuantEngine', confidence: 0.9 }),
      idea({ traceId: 'b1', symbol: 'CASEB', agent: 'JavaCoreEnsemble', confidence: 0.9 }),
      idea({ traceId: 'b1', symbol: 'CASEB', agent: 'TechnicalAgent', confidence: 0.9 }),
    ];

    await agent.evaluateConsensus('CASEB', 'b1');

    expect(capturedNoTrades).toHaveLength(0);
    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('STRONG');
  });

  // Case C: opposing sides must not be merged or side-flipped by the grouping change.
  it('Case C: QuantEngine BUY vs JavaCoreEnsemble SELL -> normal disagreement handling, no accidental agreement/side-flip', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0, JavaCoreEnsemble: 1.0 };
    agent.recentIdeas = [
      idea({ traceId: 'c1', symbol: 'CASEC', agent: 'QuantEngine', side: 'BUY', confidence: 0.9 }),
      idea({ traceId: 'c1', symbol: 'CASEC', agent: 'JavaCoreEnsemble', side: 'SELL', confidence: 0.9 }),
    ];

    await agent.evaluateConsensus('CASEC', 'c1');

    // With equal opposing weight/confidence, disagreement penalty drives net confidence below
    // threshold on both sides regardless of grouping - never approved, never a fabricated side.
    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
  });

  // Case D: duplicate events from the same producer must not inflate the group count.
  it('Case D: two QuantEngine events for the same symbol coalesce to one vote (pre-existing coalescing, still holds under grouping)', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0, JavaCoreEnsemble: 1.0 };
    agent.recentIdeas = [
      idea({ traceId: 'd1', symbol: 'CASED', agent: 'QuantEngine', confidence: 0.6 }),
      idea({ traceId: 'd1', symbol: 'CASED', agent: 'QuantEngine', confidence: 0.9 }), // last wins
      idea({ traceId: 'd1', symbol: 'CASED', agent: 'JavaCoreEnsemble', confidence: 0.9 }),
    ];

    await agent.evaluateConsensus('CASED', 'd1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].reason).toMatch(/Only 1 independent evidence group\(s\)/);
  });

  // Case E: quantIndependentEligible draws on a DIFFERENT evidence pool (TS CORE/experimental +
  // Java RESEARCH engines via computeInternalEnsembleQualification) than the raw JavaCoreEnsemble
  // vote (CoreStrategyRunner.java's separate 5-CORE recompute) - confirm no double-count: the
  // grouped-insufficient QuantEngine+JavaCoreEnsemble pair can still reach QUANT_INDEPENDENT
  // approval via a genuinely distinct qualification, and the resulting tier is QUANT_INDEPENDENT,
  // never STRONG (i.e. it is honestly reported as the substitution path, not silently disguised as
  // two ordinary independent agents).
  it('Case E: grouped-insufficient pair can still qualify via QUANT_INDEPENDENT (distinct evidence pool), correctly tiered - not silently STRONG', async () => {
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0, JavaCoreEnsemble: 1.0 };
    agent.recentIdeas = [
      idea({
        traceId: 'e1', symbol: 'CASEE', agent: 'QuantEngine', confidence: 0.8,
        quantDetail: {
          internalEnsemble: {
            qualifiesAsIndependent: true,
            rawSide: 'BUY',
            effectiveIndependentCount: 2.8,
            familyCount: 3,
            agreeingFamilies: ['TREND_MOMENTUM', 'BREAKOUT_VOLATILITY', 'MEAN_REVERSION_FAMILY'],
            totalVotes: 5,
            agreeingModelIds: ['TREND_FOLLOWING', 'MOMENTUM_BREAKOUT', 'rsi_mean_reversion'],
            dissentingModelIds: [],
          },
        },
      }),
      idea({ traceId: 'e1', symbol: 'CASEE', agent: 'JavaCoreEnsemble', confidence: 0.8 }),
    ];

    await agent.evaluateConsensus('CASEE', 'e1');

    expect(capturedNoTrades).toHaveLength(0);
    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('QUANT_INDEPENDENT');
    expect(capturedApprovals[0].reasoning).toMatch(/QUANT_INDEPENDENT/);
  });

  // Case F: Java simply absent (never voted) behaves identically to a single-group rejection -
  // same code path as Case A/D, confirms no special-cased "Java unavailable" branch was needed.
  it('Case F: QuantEngine alone (Java never voted) -> 1 group, rejected, unaffected by this change', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0 };
    agent.recentIdeas = [idea({ traceId: 'f1', symbol: 'CASEF', agent: 'QuantEngine', confidence: 0.9 })];

    await agent.evaluateConsensus('CASEF', 'f1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].reason).toMatch(/Only 1 independent evidence group\(s\)/);
  });

  // Case G: JavaFactorComposite (GARCH/HMM/factor-composite - a genuinely different Java engine,
  // no structural overlap with the 5 CORE strategy ensemble found in source) must NOT be merged
  // into CORE_QUANT_ENSEMBLE - it counts as its own independent group.
  it('Case G: QuantEngine + JavaFactorComposite -> 2 distinct evidence groups (factor model is not CORE-ensemble-correlated), approved', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0, JavaFactorComposite: 1.0 };
    agent.recentIdeas = [
      idea({ traceId: 'g1', symbol: 'CASEG', agent: 'QuantEngine', confidence: 0.9 }),
      idea({ traceId: 'g1', symbol: 'CASEG', agent: 'JavaFactorComposite', confidence: 0.9 }),
    ];

    await agent.evaluateConsensus('CASEG', 'g1');

    expect(capturedNoTrades).toHaveLength(0);
    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('STRONG');
  });

  // Case H: a legitimate existing independent combination (no quant agents involved at all) is
  // completely unaffected - byte-for-byte the same outcome as before this change.
  it('Case H: TechnicalAgent + FundamentalAgent (no quant agents involved) -> unaffected, approved STRONG as before', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0, FundamentalAgent: 1.0 };
    agent.recentIdeas = [
      idea({ traceId: 'h1', symbol: 'CASEH', agent: 'TechnicalAgent', confidence: 0.9 }),
      idea({ traceId: 'h1', symbol: 'CASEH', agent: 'FundamentalAgent', confidence: 0.9 }),
    ];

    await agent.evaluateConsensus('CASEH', 'h1');

    expect(capturedNoTrades).toHaveLength(0);
    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('STRONG');
  });
});
