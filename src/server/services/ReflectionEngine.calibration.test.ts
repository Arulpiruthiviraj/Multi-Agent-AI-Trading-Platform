import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq, and } from 'drizzle-orm';
import crypto from 'crypto';

/**
 * Real integration test (isolated temp SQLite DB) for Phase 1A's calibration-computation
 * addition to ReflectionEngine.evaluateAgents() - the write side of the calibration pipeline.
 * ChiefTraderAgent.calibration.test.ts covers the read/application side against manually-seeded
 * rows; this proves evaluateAgents() itself correctly buckets real agent_predictions by stated
 * confidence, counts real WIN/LOSS outcomes per bucket, and persists the real Beta-Binomial
 * posterior via ConfidenceCalibration.ts's math - not a hand-seeded value.
 */
describe('ReflectionEngine - real confidence calibration computation', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let reflectionEngine: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_reflection_calibration_${Date.now()}_${process.pid}.db`);
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

  async function seedPredictionWithOutcome(agentName: string, confidence: number, outcome: 'WIN' | 'LOSS') {
    const id = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values({
      id, agentName, symbol: 'AAPL', prediction: 'BUY', confidence, reasoning: 'test', timestamp: new Date().toISOString(),
    });
    await db.insert(schema.predictionOutcomes).values({
      predictionId: id, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome, evaluatedAt: new Date().toISOString(),
    });
  }

  it('computes a real Beta-Binomial calibration row from real seeded WIN/LOSS outcomes in the 0.8-0.9 bucket', async () => {
    // 10 predictions at 85% stated confidence: 3 real wins, 7 real losses (30% real accuracy).
    for (let i = 0; i < 3; i++) await seedPredictionWithOutcome('TestOverconfidentAgent', 0.85, 'WIN');
    for (let i = 0; i < 7; i++) await seedPredictionWithOutcome('TestOverconfidentAgent', 0.85, 'LOSS');

    await reflectionEngine.evaluateAgents();

    const [row] = await db.select().from(schema.agentConfidenceCalibration).where(
      and(eq(schema.agentConfidenceCalibration.agentName, 'TestOverconfidentAgent'), eq(schema.agentConfidenceCalibration.bucketLow, 0.8))
    );
    expect(row).toBeDefined();
    expect(row.wins).toBe(3);
    expect(row.losses).toBe(7);
    // Real Beta-Binomial posterior: (3 + 0.85*10) / (10 + 10) = 11.5/20 = 0.575 - pulled well
    // below the 0.85 stated/prior confidence by the real 30% observed accuracy, not all the way
    // to 0.30 either, since n=10 real observations only partially outweighs the prior.
    expect(row.calibratedConfidence).toBeCloseTo(0.575, 3);
  });

  it('keeps separate buckets separate for the same agent', async () => {
    for (let i = 0; i < 5; i++) await seedPredictionWithOutcome('TestMultiAgent', 0.65, 'WIN'); // 0.6-0.7 bucket, all wins
    for (let i = 0; i < 5; i++) await seedPredictionWithOutcome('TestMultiAgent', 0.95, 'LOSS'); // 0.9-1.0 bucket, all losses

    await reflectionEngine.evaluateAgents();

    const rows = await db.select().from(schema.agentConfidenceCalibration).where(eq(schema.agentConfidenceCalibration.agentName, 'TestMultiAgent'));
    const midBucket = rows.find((r: any) => r.bucketLow === 0.6);
    const highBucket = rows.find((r: any) => r.bucketLow === 0.9);

    expect(midBucket.wins).toBe(5);
    expect(midBucket.losses).toBe(0);
    expect(highBucket.wins).toBe(0);
    expect(highBucket.losses).toBe(5);
    // The all-win bucket's calibrated confidence must end up higher than the all-loss bucket's -
    // proving the two buckets are tracked and calibrated fully independently for the same agent.
    expect(midBucket.calibratedConfidence).toBeGreaterThan(highBucket.calibratedConfidence);
  });

  it('logPrediction skips KronosEngine ideas (already logged via KronosMetrics; ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md finding M1)', async () => {
    const before = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, 'KronosEngine'));
    await reflectionEngine.logPrediction({ agent: 'KronosEngine', symbol: 'NVDA', side: 'BUY', confidence: 0.9, reasoning: 'test', timestamp: new Date().toISOString() });
    const after = await db.select().from(schema.agentPredictions).where(eq(schema.agentPredictions.agentName, 'KronosEngine'));
    expect(after.length).toBe(before.length); // no new row written
  });

  it('evaluateAgents sources KronosEngine calibration from kronos_predictions, not agent_predictions (finding M1)', async () => {
    for (let i = 0; i < 4; i++) {
      const id = crypto.randomUUID();
      await db.insert(schema.kronosPredictions).values({
        symbol: 'NVDA', timeframe: '1Min', prediction: 'BUY', confidence: 0.85,
        forecastHorizon: 5, expectedMove: 0.01, volatility: 'NORMAL', support: 95, resistance: 115,
        model: 'test-model', predictedOhlc: '[]', marketStructure: 'Unknown', momentum: 'Unknown',
        timestamp: new Date().toISOString(),
      });
    }
    const rows = await db.select().from(schema.kronosPredictions).where(eq(schema.kronosPredictions.symbol, 'NVDA'));
    for (const [i, row] of rows.entries()) {
      await db.insert(schema.predictionOutcomes).values({
        predictionId: String(row.id), sourceTable: 'kronos_predictions', symbol: 'NVDA',
        outcome: i < 3 ? 'WIN' : 'LOSS', evaluatedAt: new Date().toISOString(),
      });
    }

    await reflectionEngine.evaluateAgents();

    const [calRow] = await db.select().from(schema.agentConfidenceCalibration).where(
      and(eq(schema.agentConfidenceCalibration.agentName, 'KronosEngine'), eq(schema.agentConfidenceCalibration.bucketLow, 0.8))
    );
    expect(calRow.wins).toBe(3);
    expect(calRow.losses).toBe(1);

    const [statsRow] = await db.select().from(schema.agentPerformanceStats).where(eq(schema.agentPerformanceStats.agentName, 'KronosEngine'));
    expect(statsRow.totalPredictions).toBe(4);
    expect(statsRow.correctPredictions).toBe(3);
  });

  it('N_A outcomes (HOLD-style predictions) are excluded from calibration, same as they already are from win-rate stats', async () => {
    const id = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values({
      id, agentName: 'TestHoldAgent', symbol: 'AAPL', prediction: 'HOLD', confidence: 0, reasoning: 'DATA_UNAVAILABLE', timestamp: new Date().toISOString(),
    });
    await db.insert(schema.predictionOutcomes).values({
      predictionId: id, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'N_A', evaluatedAt: new Date().toISOString(),
    });

    await reflectionEngine.evaluateAgents();

    const rows = await db.select().from(schema.agentConfidenceCalibration).where(eq(schema.agentConfidenceCalibration.agentName, 'TestHoldAgent'));
    expect(rows).toHaveLength(0); // never wrote a calibration row from a non-directional N_A outcome
  });
});
