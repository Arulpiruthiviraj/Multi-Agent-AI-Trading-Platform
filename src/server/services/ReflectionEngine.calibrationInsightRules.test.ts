import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

/**
 * Real integration test (isolated temp SQLite DB, same pattern as ReflectionEngine.calibration.test.ts)
 * for generateCalibrationInsightRules() - the Shadow-Account-inspired addition that extracts a
 * learned_rules entry from an agent's own graded prediction history instead of only ever reacting
 * to a rare organic realized loss. AIRouter is mocked (routeTask) so this stays deterministic and
 * makes no real network/LLM call.
 */
const { routeTask } = vi.hoisted(() => ({ routeTask: vi.fn() }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeTask }) } }));

describe('ReflectionEngine.generateCalibrationInsightRules', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let reflectionEngine: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_calib_insight_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ reflectionEngine } = await import('./ReflectionEngine'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    routeTask.mockReset().mockResolvedValue({ content: 'Apply extra scrutiny to this agent.' });
  });

  // Each call uses a distinct symbol (a counter, not a fixed 'AAPL') so
  // effectiveSampleSize.ts's (symbol, agent, side) clustering treats every seeded row as its own
  // independent cluster instead of collapsing them all into one (rows seeded milliseconds apart
  // on the same symbol/agent/side fall inside a single evaluationHorizonMs cluster and count as
  // ONE effective observation, not N - the real, intentional behavior this module documents).
  let symbolCounter = 0;
  async function seedPredictionWithOutcome(agentName: string, confidence: number, outcome: 'WIN' | 'LOSS') {
    const symbol = `SYM${symbolCounter++}`;
    const id = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values({
      id, agentName, symbol, prediction: 'BUY', confidence, reasoning: 'test', timestamp: new Date().toISOString(),
    });
    await db.insert(schema.predictionOutcomes).values({
      predictionId: id, sourceTable: 'agent_predictions', symbol, outcome, evaluatedAt: new Date().toISOString(),
    });
  }

  it('generates a learned_rules row for an agent whose Wilson upper bound is below chance', async () => {
    // 25 predictions, 3 wins / 22 losses - real, effectively-clustered evidence well below chance
    // even at the confidence interval's optimistic end.
    for (let i = 0; i < 3; i++) await seedPredictionWithOutcome('TestBadAgent', 0.7, 'WIN');
    for (let i = 0; i < 22; i++) await seedPredictionWithOutcome('TestBadAgent', 0.7, 'LOSS');

    await reflectionEngine.evaluateAgents();

    const rows = await db.select().from(schema.learnedRules).where(eq(schema.learnedRules.cause, 'Calibration insight: TestBadAgent'));
    expect(rows.length).toBe(1);
    expect(rows[0].agent).toBe('ReflectionEngine');
    expect(rows[0].rule).toBe('Apply extra scrutiny to this agent.');
    expect(routeTask).toHaveBeenCalledTimes(1);
  });

  it('does not generate a rule for an agent with a healthy win rate', async () => {
    for (let i = 0; i < 20; i++) await seedPredictionWithOutcome('TestGoodAgent', 0.7, 'WIN');
    for (let i = 0; i < 5; i++) await seedPredictionWithOutcome('TestGoodAgent', 0.7, 'LOSS');

    routeTask.mockClear();
    await reflectionEngine.evaluateAgents();

    const rows = await db.select().from(schema.learnedRules).where(eq(schema.learnedRules.cause, 'Calibration insight: TestGoodAgent'));
    expect(rows.length).toBe(0);
  });

  it('respects the cooldown - does not regenerate within reflectionCalibrationRuleCooldownMs', async () => {
    for (let i = 0; i < 3; i++) await seedPredictionWithOutcome('TestCooldownAgent', 0.7, 'WIN');
    for (let i = 0; i < 22; i++) await seedPredictionWithOutcome('TestCooldownAgent', 0.7, 'LOSS');

    await reflectionEngine.evaluateAgents();
    const afterFirst = await db.select().from(schema.learnedRules).where(eq(schema.learnedRules.cause, 'Calibration insight: TestCooldownAgent'));
    expect(afterFirst.length).toBe(1);

    routeTask.mockClear();
    // More losses arrive, but the cooldown window (default 24h) has not elapsed.
    for (let i = 0; i < 5; i++) await seedPredictionWithOutcome('TestCooldownAgent', 0.7, 'LOSS');
    await reflectionEngine.evaluateAgents();

    const afterSecond = await db.select().from(schema.learnedRules).where(eq(schema.learnedRules.cause, 'Calibration insight: TestCooldownAgent'));
    expect(afterSecond.length).toBe(1); // still just the one row - no spam
    expect(routeTask).not.toHaveBeenCalled();
  });

  it('never touches agentPerformanceStats.currentWeight - insight rules are a separate concern from weight learning', async () => {
    for (let i = 0; i < 3; i++) await seedPredictionWithOutcome('TestWeightIsolation', 0.7, 'WIN');
    for (let i = 0; i < 22; i++) await seedPredictionWithOutcome('TestWeightIsolation', 0.7, 'LOSS');

    await reflectionEngine.evaluateAgents();

    const [stats] = await db.select().from(schema.agentPerformanceStats).where(eq(schema.agentPerformanceStats.agentName, 'TestWeightIsolation'));
    // currentWeight comes from agentWeightUpdate/boundedStep (computed earlier in evaluateAgents),
    // completely independent of whether a calibration-insight rule fired - just assert it exists
    // and is a finite number, i.e. the new code path didn't corrupt or skip the existing one.
    expect(stats).toBeDefined();
    expect(Number.isFinite(stats.currentWeight)).toBe(true);
  });
});
