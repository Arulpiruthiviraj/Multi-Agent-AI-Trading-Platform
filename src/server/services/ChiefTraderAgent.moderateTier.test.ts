import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 7E/7H (MODERATE consensus tier) regression tests. Own isolated temp DB per this codebase's
 * established one-isolated-DB-describe-per-file convention (see ChiefTraderAgent.calibration.test.ts's
 * own header comment for why). Every scenario here uses two REAL independent agreeing agents
 * (TechnicalAgent + FundamentalAgent) so `enoughIndependentVoices` is satisfied identically to the
 * STRONG path - MODERATE never lowers that floor.
 */
describe('ChiefTraderAgent - MODERATE consensus tier (Phase 7E/7H)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let ChiefTraderAgent: any;
  let candidateBuilder: typeof import('../continuous/CalibrationCandidateBuilder');
  let capturedApprovals: any[];
  let capturedNoTrades: any[];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_moderate_ct_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    candidateBuilder = await import('../continuous/CalibrationCandidateBuilder');
    const { eventBus } = await import('../core/EventBus');
    const { EVENTS } = await import('../core/eventNames');
    capturedApprovals = [];
    capturedNoTrades = [];
    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => capturedApprovals.push(a));
    eventBus.on(EVENTS.DESK_NO_TRADE, (a: any) => capturedNoTrades.push(a));

    ({ ChiefTraderAgent } = await import('./ChiefTraderAgent'));

    // Seed a genuine, statistically-validated calibration champion for TechnicalAgent's 0.6-0.7
    // bucket (well above the sample-size floor AND above-chance win rate), so the "qualifying
    // MODERATE case" test below exercises the real calibration-trust gate, not a stub.
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'TechnicalAgent', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 20, losses: 5, calibratedConfidence: 0.68, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-23T09:00:00.000Z').getTime();
    for (let i = 0; i < 25; i++) {
      const id = `mod-pred-${i}`;
      await db.insert(schema.agentPredictions).values({
        id, agentName: 'TechnicalAgent', symbol: 'MODTRUST', prediction: 'BUY', confidence: 0.65,
        reasoning: 'moderate-tier trust seed', timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
      await db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol: 'MODTRUST',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i < 20 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }
    await candidateBuilder.runCalibrationValidationCycle();

    // FundamentalAgent's 0.6-0.7 bucket is deliberately left with NO champion (real default state)
    // so tests can control whether calibration trust holds by choosing which agent votes.
  });

  beforeEach(() => {
    capturedApprovals.length = 0;
    capturedNoTrades.length = 0;
  });

  afterEach(() => {
    delete process.env.CONSENSUS_MODERATE_TIER_ENABLED;
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.CONSENSUS_MODERATE_TIER_ENABLED;
  });

  function twoAgentIdeas(traceId: string, symbol: string, confidence: number, agentA = 'TechnicalAgent', agentB = 'FundamentalAgent') {
    return [
      { traceId, symbol, side: 'BUY', confidence, agent: agentA, reasoning: 'signal A' },
      { traceId, symbol, side: 'BUY', confidence, agent: agentB, reasoning: 'signal B' },
    ];
  }

  it('STRONG path (confidence clears 0.75) is unaffected by MODERATE tier being enabled - byte-for-byte same approval', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0, FundamentalAgent: 1.0 };
    agent.recentIdeas = twoAgentIdeas('strong-1', 'AAPL', 0.9);

    await agent.evaluateConsensus('AAPL', 'strong-1');

    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('STRONG');
    expect(capturedApprovals[0].reasoning).toMatch(/Chief Consensus Approval\]/);
    expect(capturedApprovals[0].reasoning).not.toMatch(/MODERATE/);
  });

  it('MODERATE tier disabled (default): a 0.65-confidence idea is rejected with the pre-existing plain STRONG rejection text, no MODERATE noise', async () => {
    delete process.env.CONSENSUS_MODERATE_TIER_ENABLED;
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0, FundamentalAgent: 1.0 };
    agent.recentIdeas = twoAgentIdeas('mod-disabled-1', 'MODTRUST', 0.65);

    await agent.evaluateConsensus('MODTRUST', 'mod-disabled-1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].decisionTier).toBe('STRONG');
    expect(capturedNoTrades[0].reason).toMatch(/did not clear/);
    expect(capturedNoTrades[0].reason).not.toMatch(/MODERATE/);
    expect(capturedNoTrades[0].moderateReasonCode).toBeUndefined();
  });

  it('MODERATE tier enabled, qualifying case: approves at MODERATE when confidence is in-band, independent voices/hard-vetoes pass, and a real calibration champion exists', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';

    // Seed KronosEngine a real, statistically-validated champion for the SAME 0.6-0.7 bucket
    // (mirrors the TechnicalAgent seed in beforeAll), so both participating agents are genuinely
    // trusted - a real "all participating agents trusted" case, not a stub.
    const { eq } = await import('drizzle-orm');
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'KronosEngine', bucketLow: 0.6, bucketHigh: 0.7,
      wins: 20, losses: 5, calibratedConfidence: 0.68, lastEvaluated: new Date().toISOString(),
    });
    const base = new Date('2026-08-24T09:00:00.000Z').getTime();
    for (let i = 0; i < 25; i++) {
      await db.insert(schema.kronosPredictions).values({
        symbol: 'MODKRONOS', timeframe: '1Min', prediction: 'BUY', confidence: 0.65,
        forecastHorizon: 5, expectedMove: '1.00%', volatility: 'NORMAL', support: 95, resistance: 115,
        model: 'test-model', predictedOhlc: '[]', marketStructure: 'Unknown', momentum: 'Unknown',
        timestamp: new Date(base + i * 2 * 60 * 60000).toISOString(),
      });
    }
    const kronosRows = await db.select().from(schema.kronosPredictions).where(eq(schema.kronosPredictions.symbol, 'MODKRONOS'));
    for (const [i, row] of kronosRows.entries()) {
      await db.insert(schema.predictionOutcomes).values({
        predictionId: String(row.id), sourceTable: 'kronos_predictions', symbol: 'MODKRONOS',
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome: i < 20 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }
    await candidateBuilder.runCalibrationValidationCycle();

    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0, KronosEngine: 1.0 };
    agent.recentIdeas = [
      { traceId: 'mod-qualify-1', symbol: 'MODTRUST', side: 'BUY', confidence: 0.65, agent: 'TechnicalAgent', reasoning: 'signal A' },
      { traceId: 'mod-qualify-1', symbol: 'MODTRUST', side: 'BUY', confidence: 0.65, agent: 'KronosEngine', reasoning: 'signal B' },
    ];

    await agent.evaluateConsensus('MODTRUST', 'mod-qualify-1');

    expect(capturedNoTrades).toHaveLength(0);
    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].decisionTier).toBe('MODERATE');
    expect(capturedApprovals[0].reasoning).toMatch(/MODERATE/);
  });

  it('MODERATE tier enabled but insufficient independent agents: rejected with MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0 };
    agent.recentIdeas = [
      { traceId: 'mod-lone-1', symbol: 'MODTRUST', side: 'BUY', confidence: 0.65, agent: 'TechnicalAgent', reasoning: 'lone signal' },
    ];

    await agent.evaluateConsensus('MODTRUST', 'mod-lone-1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].decisionTier).toBe('STRONG');
    expect(capturedNoTrades[0].reason).toMatch(/MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE/);
  });

  it('MODERATE tier enabled but no calibration champion exists for the agreeing agents (the honest real-data default): rejected with MODERATE_REJECT_UNTRUSTED_CALIBRATION', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { FundamentalAgent: 1.0, MacroAgent: 1.0 };
    agent.recentIdeas = twoAgentIdeas('mod-untrusted-1', 'NOCAL', 0.65, 'FundamentalAgent', 'MacroAgent');

    await agent.evaluateConsensus('NOCAL', 'mod-untrusted-1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].reason).toMatch(/MODERATE_REJECT_UNTRUSTED_CALIBRATION/);
  });

  it('MODERATE tier enabled but confidence is below the MODERATE floor: the outer gate skips MODERATE entirely (cheap short-circuit, no DB lookup) - plain rejection text, unchanged', async () => {
    process.env.CONSENSUS_MODERATE_TIER_ENABLED = 'true';
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0, FundamentalAgent: 1.0 };
    agent.recentIdeas = twoAgentIdeas('mod-lowconf-1', 'MODTRUST', 0.3);

    await agent.evaluateConsensus('MODTRUST', 'mod-lowconf-1');

    expect(capturedApprovals).toHaveLength(0);
    expect(capturedNoTrades).toHaveLength(1);
    expect(capturedNoTrades[0].reason).toBe('[NO TRADE] Confidence 30.0% did not clear 75%.');
    expect(capturedNoTrades[0].moderateReasonCode).toBeUndefined();
  });
});
