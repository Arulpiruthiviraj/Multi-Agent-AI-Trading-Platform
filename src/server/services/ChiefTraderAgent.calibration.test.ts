import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB, no per-module mocks) for Phase 1A's confidence
 * calibration actually taking effect in a real consensus evaluation - ChiefTraderAgent.test.ts
 * covers the aggregation math itself against a mocked DB (which always returns no calibration
 * data, so it never exercises this path). Kept in its own file per this codebase's established
 * one-isolated-DB-describe-per-file convention (vitest caches a dynamic import per FILE, not per
 * describe block - a second beforeAll in an existing file would get back an already-closed
 * connection from a prior block).
 */
describe('ChiefTraderAgent - real confidence calibration end-to-end', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let ChiefTraderAgent: any;
  let capturedApprovals: any[];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_calibration_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    const { eventBus } = await import('../core/EventBus');
    capturedApprovals = [];
    eventBus.on('CHIEF_APPROVED_IDEA', (a: any) => capturedApprovals.push(a));

    ({ ChiefTraderAgent } = await import('./ChiefTraderAgent'));
  });

  beforeEach(() => {
    capturedApprovals.length = 0;
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('replaces NewsAgent\'s stated 85% confidence with its real, measured ~34% calibrated accuracy for that bucket', async () => {
    // Seeds exactly the real finding this exists to correct: NewsAgent's 80-90% stated-confidence
    // bucket, n=76, ~34.2% real accuracy (FINAL_ANALYSIS.md 15.0/15.4).
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'NewsAgent', bucketLow: 0.8, bucketHigh: 0.9,
      wins: 26, losses: 50, calibratedConfidence: 0.401,
      lastEvaluated: new Date().toISOString(),
    });

    const agent = new ChiefTraderAgent();
    agent.agentWeights = { NewsAgent: 1.0 };
    agent.recentIdeas = [
      { traceId: 'cal-1', symbol: 'AAPL', side: 'BUY', confidence: 0.85, agent: 'NewsAgent', reasoning: 'bullish headline' },
    ];

    await agent.evaluateConsensus('AAPL', 'cal-1');

    // NewsAgent alone -> finalConfidence reduces to whatever confidence value actually got used.
    // Below the 0.75 approval threshold once calibrated (0.401), so no approval should fire -
    // proving the calibrated value, not the raw 0.85, is what actually governed the vote.
    expect(capturedApprovals).toHaveLength(0);
  });

  it('leaves confidence unchanged for an agent/bucket with no real evaluated history yet', async () => {
    const agent = new ChiefTraderAgent();
    agent.agentWeights = { KronosEngine: 1.0 };
    agent.recentIdeas = [
      { traceId: 'cal-2', symbol: 'TSLA', side: 'BUY', confidence: 0.9, agent: 'KronosEngine', reasoning: 'forecast signal' },
    ];

    await agent.evaluateConsensus('TSLA', 'cal-2');

    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].confidence).toBeCloseTo(0.9, 5); // unchanged - no calibration row exists for this bucket
  });

  it('a well-calibrated agent (real accuracy matches its stated confidence) sees its vote pass through with only a small correction', async () => {
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'TechnicalAgent', bucketLow: 0.8, bucketHigh: 0.9,
      wins: 68, losses: 12, calibratedConfidence: 0.845, // real accuracy ~85%, matches its own claim
      lastEvaluated: new Date().toISOString(),
    });

    const agent = new ChiefTraderAgent();
    agent.agentWeights = { TechnicalAgent: 1.0 };
    agent.recentIdeas = [
      { traceId: 'cal-3', symbol: 'MSFT', side: 'BUY', confidence: 0.85, agent: 'TechnicalAgent', reasoning: 'RSI oversold' },
    ];

    await agent.evaluateConsensus('MSFT', 'cal-3');

    expect(capturedApprovals).toHaveLength(1);
    expect(capturedApprovals[0].confidence).toBeCloseTo(0.845, 3);
  });
});
