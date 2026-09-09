import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * QuantEngine internal-ensemble independent qualification (2026-09-09, explicit operator
 * override - see ChiefTraderAgent.ts's own doc comment on isQuantIndependentQualificationEnabled).
 * Mirrors ChiefTraderAgent.moderateTier.test.ts's own isolated-temp-DB, real-agent pattern exactly.
 * Every scenario here uses a SINGLE QuantEngine idea (never a second agent) - proving the
 * qualification mechanism substitutes for the second-agent requirement specifically, not for any
 * other gate.
 */
describe('ChiefTraderAgent - QuantEngine internal-ensemble independent qualification (2026-09-09)', () => {
  let tmpDbPath: string;
  let ChiefTraderAgent: any;
  let capturedApprovals: any[];
  let capturedNoTrades: any[];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quantindep_ct_${Date.now()}_${process.pid}.db`);
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

  function qualifyingQuantIdea(traceId: string, symbol: string, confidence = 0.8) {
    return [{
      traceId, symbol, side: 'BUY', confidence, agent: 'QuantEngine', reasoning: 'internal ensemble signal',
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
    }];
  }

  it('disabled (default): a single qualifying QuantEngine idea is still rejected with the plain insufficient-voices reason, no QUANT_INDEPENDENT noise', async () => {
    delete process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED;
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0 };
    agent.recentIdeas = qualifyingQuantIdea('qi-disabled-1', 'QIOFF', 0.8);

    await agent.evaluateConsensus('QIOFF', 'qi-disabled-1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].reason).toMatch(/Only 1 independent agent\(s\)/);
    expect(capturedNoTrades[0].reason).not.toMatch(/QUANT_INDEPENDENT/);
  });

  it('enabled: a single QuantEngine idea with a qualifying internal ensemble is approved as QUANT_INDEPENDENT', async () => {
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0 };
    agent.recentIdeas = qualifyingQuantIdea('qi-enabled-1', 'QION', 0.8);

    await agent.evaluateConsensus('QION', 'qi-enabled-1');

    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('QUANT_INDEPENDENT');
    expect(capturedApprovals[0].reasoning).toMatch(/QUANT_INDEPENDENT/);
    expect(capturedApprovals[0].reasoning).toMatch(/3 independent strategy families/);
  });

  it('enabled: a QuantEngine idea whose internal ensemble does NOT qualify is still rejected normally', async () => {
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0 };
    const ideas = qualifyingQuantIdea('qi-notqualified-1', 'QINQ', 0.8);
    ideas[0].quantDetail.internalEnsemble.qualifiesAsIndependent = false;
    agent.recentIdeas = ideas;

    await agent.evaluateConsensus('QINQ', 'qi-notqualified-1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].reason).toMatch(/Only 1 independent agent\(s\)/);
  });

  it('enabled: a normal 2-agent STRONG approval is completely unaffected (byte-for-byte same tier/reason)', async () => {
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0, FundamentalAgent: 1.0 };
    agent.recentIdeas = [
      { traceId: 'qi-strong-1', symbol: 'QISTRONG', side: 'BUY', confidence: 0.9, agent: 'TechnicalAgent', reasoning: 'signal A' },
      { traceId: 'qi-strong-1', symbol: 'QISTRONG', side: 'BUY', confidence: 0.9, agent: 'FundamentalAgent', reasoning: 'signal B' },
    ];

    await agent.evaluateConsensus('QISTRONG', 'qi-strong-1');

    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('STRONG');
    expect(capturedApprovals[0].reasoning).not.toMatch(/QUANT_INDEPENDENT/);
  });

  it('enabled: hard vetoes still apply even to a qualifying QuantEngine idea - a debate HOLD still blocks approval', async () => {
    // A HOLD from ConsensusDebate drags the raw weighted result.confidence itself down (the
    // normal weighting algorithm, unrelated to this change) before the ladder even reaches the
    // independent-voice/debateSaidHold branches - so this correctly rejects via
    // CONFIDENCE_BELOW_STRONG rather than the HARD_VETO branch specifically. Either way the
    // property under test - a qualifying internal ensemble never overrides a real debate HOLD -
    // holds: approval never happens.
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { QuantEngine: 1.0, ConsensusDebate: 1.0 };
    const ideas = qualifyingQuantIdea('qi-veto-1', 'QIVETO', 0.8);
    ideas.push({ traceId: 'qi-veto-1', symbol: 'QIVETO', side: 'HOLD', confidence: 0.8, agent: 'ConsensusDebate', reasoning: 'debate says hold' } as any);
    agent.recentIdeas = ideas;

    await agent.evaluateConsensus('QIVETO', 'qi-veto-1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
  });
});
