// LABEL: CERTIFICATION FIXTURE - production-faithful vs positive-capability consensus (2026-10-14 forensic response).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Oct 14 production: 27,191 consensus rounds, 2 reached 0.75, 0 approved. Synthetic sessions, with an empty calibration table, approved 15 of 188.
 * These tests run the REAL ChiefTraderAgent consensus with the REAL calibration lookup under two clearly separate fixtures and leave every threshold
 * (0.75, two independent evidence groups) untouched:
 *   PRODUCTION_OCT14    - observed production calibration; the correct outcome is ABSTAIN for the evidence that was actually available.
 *   POSITIVE_CAPABILITY - SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY; strong, well-sampled reliability; a qualifying setup must reach
 *                         STRONG approval. Never presented as organic evidence and never a mandatory production outcome.
 */
describe('ChiefTraderAgent consensus under production-faithful vs positive-capability calibration', () => {
  let tmpDbPath: string; let db: any; let sqliteDb: any; let schema: any; let ChiefTraderAgent: any;
  let profiles: typeof import('../replay/synthetic/AgentCalibrationProfiles');
  let approvals: any[]; let noTrades: any[];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_prodcal_ct_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    profiles = await import('../replay/synthetic/AgentCalibrationProfiles');
    const { eventBus } = await import('../core/EventBus');
    const { EVENTS } = await import('../core/eventNames');
    approvals = []; noTrades = [];
    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => approvals.push(a));
    eventBus.on(EVENTS.DESK_NO_TRADE, (a: any) => noTrades.push(a));
    ({ ChiefTraderAgent } = await import('./ChiefTraderAgent'));
  });
  beforeEach(async () => {
    approvals.length = 0; noTrades.length = 0;
    await db.delete(schema.agentConfidenceCalibration);
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmpDbPath + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
  });

  const idea = (traceId: string, symbol: string, agent: string, side: 'BUY' | 'SELL', confidence: number) => ({ traceId, symbol, side, confidence, agent, reasoning: `${agent} ${side}` });
  const run = async (traceId: string, symbol: string, ideas: any[]) => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { ...profiles.PRODUCTION_OCT14_WEIGHTS };
    agent.recentIdeas = ideas;
    await agent.evaluateConsensus(symbol, traceId);
  };

  it('seeded production calibration reproduces the observed calibrated confidences exactly (formula, not hard-coded)', async () => {
    await profiles.seedAgentCalibrationProfile('PRODUCTION_OCT14');
    const rows = await db.select().from(schema.agentConfidenceCalibration);
    const get = (a: string, low: number) => rows.find((r: any) => r.agentName === a && r.bucketLow === low).calibratedConfidence;
    expect(get('KronosEngine', 0.8)).toBeCloseTo(0.5108, 3);
    expect(get('KronosEngine', 0.7)).toBeCloseTo(0.4959, 3);
    expect(get('TechnicalAgent', 0.8)).toBeCloseTo(0.7727, 3);
    expect(get('TechnicalAgent', 0.6)).toBeCloseTo(0.4079, 3);
    expect(get('QuantEngine', 0.8)).toBeCloseTo(0.125, 3);
  });

  it('PRODUCTION_OCT14: the best realistic agreeing pair (Technical + Kronos, both BUY with raw 0.85) is correctly REJECTED below 0.75', async () => {
    await profiles.seedAgentCalibrationProfile('PRODUCTION_OCT14');
    await run('pc-1', 'FAST', [idea('pc-1', 'FAST', 'TechnicalAgent', 'BUY', 0.85), idea('pc-1', 'FAST', 'KronosEngine', 'BUY', 0.85)]);
    expect(approvals).toHaveLength(0);
    expect(noTrades).toHaveLength(1);
    expect(noTrades[0].confidence).toBeLessThan(0.75);
  });

  it('PRODUCTION_OCT14: Technical alone at its thin-sample 0.7727 clears the confidence number but is REJECTED for a single evidence group (the IONQ/XOM rounds)', async () => {
    await profiles.seedAgentCalibrationProfile('PRODUCTION_OCT14');
    await run('pc-2', 'IONQ', [idea('pc-2', 'IONQ', 'TechnicalAgent', 'BUY', 0.85)]);
    expect(approvals).toHaveLength(0);
    expect(noTrades).toHaveLength(1);
    expect(noTrades[0].reason).toMatch(/Only 1 independent evidence group|INSUFFICIENT_AGENT_PARTICIPATION/);
  });

  it('PRODUCTION_OCT14: Kronos and Technical disagreeing on side (23.6 % of Oct 14 rounds) never approve', async () => {
    await profiles.seedAgentCalibrationProfile('PRODUCTION_OCT14');
    await run('pc-3', 'VSTM', [idea('pc-3', 'VSTM', 'TechnicalAgent', 'BUY', 0.85), idea('pc-3', 'VSTM', 'KronosEngine', 'SELL', 0.85)]);
    expect(approvals).toHaveLength(0);
  });

  it('POSITIVE_CAPABILITY (synthetic, non-organic): two independent, well-sampled, genuinely reliable agents agreeing at raw 0.85 reach STRONG approval without any threshold change', async () => {
    await profiles.seedAgentCalibrationProfile('POSITIVE_CAPABILITY');
    await run('pos-1', 'FAST', [idea('pos-1', 'FAST', 'TechnicalAgent', 'BUY', 0.85), idea('pos-1', 'FAST', 'KronosEngine', 'BUY', 0.85)]);
    expect(noTrades).toHaveLength(0);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].decisionTier).toBe('STRONG');
    expect(approvals[0].side).toBe('BUY');
  });

  it('POSITIVE_CAPABILITY control: a single reliable agent is still rejected (independence floor untouched)', async () => {
    await profiles.seedAgentCalibrationProfile('POSITIVE_CAPABILITY');
    await run('pos-2', 'FAST', [idea('pos-2', 'FAST', 'TechnicalAgent', 'BUY', 0.85)]);
    expect(approvals).toHaveLength(0);
  });

  // CONFIRMED WEAKNESS (2026-10-14): `calibrateConfidenceDetailed()` uses the Beta-Binomial posterior as decision confidence even when
  // dataQuality is INSUFFICIENT_CALIBRATION_DATA (N < minCalibrationSampleSize). With the real production table, TechnicalAgent's 0.8 bucket (0W/1L,
  // N=1) is 0.7727 and QuantEngine's 0.7 bucket (2W/0L, N=2) is 0.7917 - both are mostly the bucket-midpoint PRIOR - and the unchanged STRONG
  // path approves their agreement at ~0.78 although three historical samples support neither. Characterization of CURRENT behavior:
  it('CHARACTERIZATION (current behavior): two thin-sample agents agreeing are approved at STRONG through the real consensus path', async () => {
    await profiles.seedAgentCalibrationProfile('PRODUCTION_OCT14');
    await run('thin-1', 'THIN', [idea('thin-1', 'THIN', 'TechnicalAgent', 'BUY', 0.85), idea('thin-1', 'THIN', 'QuantEngine', 'BUY', 0.75)]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].decisionTier).toBe('STRONG');
    expect(approvals[0].confidence).toBeGreaterThan(0.75);
  });

  // POLICY (expected to fail until the owner authorizes a change to the protected consensus path): a STRONG approval must not rest on evidence
  // whose calibration is INSUFFICIENT_CALIBRATION_DATA. This can only REDUCE approvals; it never lowers a threshold. Flip `.fails` when implemented.
  it.fails('POLICY (not yet implemented): STRONG approval requires SUFFICIENT calibration data for every agent counted toward the independence floor', async () => {
    await profiles.seedAgentCalibrationProfile('PRODUCTION_OCT14');
    await run('thin-2', 'THIN', [idea('thin-2', 'THIN', 'TechnicalAgent', 'BUY', 0.85), idea('thin-2', 'THIN', 'QuantEngine', 'BUY', 0.75)]);
    expect(approvals).toHaveLength(0);
  });
});
