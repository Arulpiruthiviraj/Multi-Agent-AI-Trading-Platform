import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

/**
 * ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md - real integration tests (isolated
 * temp SQLite DB) proving evaluateAgents() now gates live agent_performance_stats.currentWeight on
 * EFFECTIVE (autocorrelation-clustered) sample size, not raw prediction_outcomes row counts - the
 * confirmed gap this implementation closes. Separate file from ReflectionEngine.calibration.test.ts
 * (which already covers the calibration-write side) to keep each file's own temp DB and fixtures
 * focused.
 */
describe('ReflectionEngine - effective-N weight gating (Phase 4/5/8/9)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let reflectionEngine: any;
  let tradingSafety: any;
  let agentWeightConfig: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_effweight_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ reflectionEngine } = await import('./ReflectionEngine'));
    ({ tradingSafety } = await import('../config/tradingSafety'));
    ({ agentWeightConfig } = await import('../config/agentWeights'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function seed(agentName: string, symbol: string, side: string, confidence: number, timestampMs: number, outcome: 'WIN' | 'LOSS') {
    const id = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values({
      id, agentName, symbol, prediction: side, confidence, reasoning: 'test',
      timestamp: new Date(timestampMs).toISOString(),
    });
    await db.insert(schema.predictionOutcomes).values({
      predictionId: id, sourceTable: 'agent_predictions', symbol, outcome, evaluatedAt: new Date().toISOString(),
    });
  }

  it('a huge raw N of tightly-clustered (correlated) predictions does not move the weight away from neutral', async () => {
    const now = Date.now();
    const AGENT = 'ClusteredMockAgent';
    // 50 predictions all within a few seconds of each other (well under evaluationHorizonMs) - one
    // real underlying regime read, not 50 independent trials. Mostly WIN, so a raw-N gate would
    // have moved this agent's weight up sharply; effective N should keep it near neutral.
    for (let i = 0; i < 50; i++) {
      await seed(AGENT, 'SPY', 'BUY', 0.8, now + i * 100, i < 45 ? 'WIN' : 'LOSS');
    }

    await reflectionEngine.evaluateAgents();

    const [row] = await db.select().from(schema.agentPerformanceStats).where(eq(schema.agentPerformanceStats.agentName, AGENT));
    expect(row.totalPredictions).toBe(50); // raw count preserved, never hidden
    expect(row.effectivePredictions).toBeLessThan(5); // one real cluster, not 50
    expect(row.evidenceStatus).toBe('INSUFFICIENT_EVIDENCE');
    // Bounded step from the default starting point (1.0) - cannot have swung far in one cycle even
    // though the raw win rate here is 90%.
    expect(Math.abs(row.currentWeight - 1.0)).toBeLessThanOrEqual(tradingSafety.maxWeightAdjustmentPerCycle + 1e-9);
  });

  it('genuinely independent, time-spread predictions with real effective N can move the weight, but only bounded per cycle', async () => {
    const now = Date.now();
    const AGENT = 'IndependentMockAgent';
    const gapMs = tradingSafety.evaluationHorizonMs + 60_000; // safely beyond the cluster gap each time
    const n = tradingSafety.minSampleSizeForTrust + 5; // clears the effective-N floor
    for (let i = 0; i < n; i++) {
      await seed(AGENT, 'AAPL', 'BUY', 0.8, now + i * gapMs, i < n - 2 ? 'WIN' : 'LOSS'); // high real win rate
    }

    await reflectionEngine.evaluateAgents();

    const [row] = await db.select().from(schema.agentPerformanceStats).where(eq(schema.agentPerformanceStats.agentName, AGENT));
    expect(row.effectivePredictions).toBe(n); // each one its own cluster - genuinely independent
    expect(row.evidenceStatus).toBe('LEARNING_ELIGIBLE');
    // Weight moved up from the 1.0 default, but by at most one bounded step this cycle.
    expect(row.currentWeight).toBeGreaterThan(1.0);
    expect(row.currentWeight).toBeLessThanOrEqual(1.0 + tradingSafety.maxWeightAdjustmentPerCycle + 1e-9);
  });

  it('the configured risk-exit agent (e.g. PortfolioManager) never has its weight moved by learning, even with a strong effective win rate', async () => {
    const now = Date.now();
    const AGENT = agentWeightConfig.riskExitAgent;
    const gapMs = tradingSafety.evaluationHorizonMs + 60_000;
    const n = tradingSafety.minSampleSizeForTrust + 5;
    for (let i = 0; i < n; i++) {
      await seed(AGENT, 'NVDA', 'SELL', 0.85, now + i * gapMs, 'WIN'); // 100% effective win rate
    }

    await reflectionEngine.evaluateAgents();

    const [row] = await db.select().from(schema.agentPerformanceStats).where(eq(schema.agentPerformanceStats.agentName, AGENT));
    expect(row.effectivePredictions).toBe(n); // stats still computed and exposed, never hidden
    expect(row.currentWeight).toBe(1.0); // but weight learning is excluded for this agent
  });

  it('rolls a previously-learned weight gradually back toward the static default once evidence is insufficient again', async () => {
    const AGENT = 'RollbackMockAgent';
    // Seed a prior stats row as if a past cycle had already learned an elevated weight.
    await db.insert(schema.agentPerformanceStats).values({
      agentName: AGENT, totalPredictions: 0, correctPredictions: 0, winRate: 0, averageReturn: 0,
      profitFactor: 0, sharpeRatio: 0, effectivePredictions: 0, effectiveCorrect: 0,
      evidenceStatus: 'LEARNING_ELIGIBLE', currentWeight: 1.8, lastEvaluated: new Date().toISOString(),
    });
    // This cycle: only a handful of tightly-clustered predictions - effective N collapses back
    // below the trust floor.
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await seed(AGENT, 'MSFT', 'BUY', 0.8, now + i * 100, 'WIN');
    }

    await reflectionEngine.evaluateAgents();

    const [row] = await db.select().from(schema.agentPerformanceStats).where(eq(schema.agentPerformanceStats.agentName, AGENT));
    expect(row.evidenceStatus).toBe('INSUFFICIENT_EVIDENCE');
    // Moved down from 1.8 toward the neutral default (1.0, no configured default for this mock
    // agent name), but only by one bounded step - not snapped back instantly.
    expect(row.currentWeight).toBeLessThan(1.8);
    expect(row.currentWeight).toBeGreaterThanOrEqual(1.8 - tradingSafety.maxWeightAdjustmentPerCycle - 1e-9);
  });
});
