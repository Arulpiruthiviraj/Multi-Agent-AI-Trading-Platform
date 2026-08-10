import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, no mocks) for Phase 7's training example
 * builder - in particular the point-in-time leakage check (req #24), which is the one part of
 * this module that must never silently pass a bad row through.
 */
describe('TrainingExampleBuilder (Phase 7)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let trainingExampleBuilder: any;

  // Well in the past relative to "now" so the evaluation horizon has definitely elapsed.
  const DECISION_TIME = new Date('2026-01-05T15:00:00.000Z');
  const DECISION_MS = DECISION_TIME.getTime();

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_training_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ trainingExampleBuilder } = await import('./TrainingExampleBuilder'));

    // Real bars for the evaluator's label computation.
    const closes = [100, 101, 103, 105, 108, 110];
    for (let i = 0; i < closes.length; i++) {
      await db.insert(schema.ohlcvBars).values({
        id: `CLEANTX:1Min:${DECISION_MS + i * 60000}`,
        symbol: 'CLEANTX', timeframe: '1Min', timestamp: DECISION_MS + i * 60000,
        open: closes[i], high: closes[i], low: closes[i], close: closes[i], volume: 1000, source: 'test',
      });
      await db.insert(schema.ohlcvBars).values({
        id: `LEAKTX:1Min:${DECISION_MS + i * 60000}`,
        symbol: 'LEAKTX', timeframe: '1Min', timestamp: DECISION_MS + i * 60000,
        open: closes[i], high: closes[i], low: closes[i], close: closes[i], volume: 1000, source: 'test',
      });
    }
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('builds a real training example with a correct point-in-time label for a clean transaction', async () => {
    await db.insert(schema.transactions).values({
      id: 'ARG-TEST-CLEAN', symbol: 'CLEANTX', openedAt: DECISION_TIME.toISOString(), status: 'OPEN', finalDecision: 'BUY', outcome: 'PENDING',
    });
    await db.insert(schema.consensusDecisions).values({
      transactionId: 'ARG-TEST-CLEAN', symbol: 'CLEANTX', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true,
      agreementsCount: 1, disagreementsCount: 0, createdAt: DECISION_TIME.toISOString(),
    });
    await db.insert(schema.agentPredictions).values({
      id: 'pred-clean', agentName: 'TechnicalAgent', symbol: 'CLEANTX', prediction: 'BUY', confidence: 0.8,
      reasoning: 'test', timestamp: new Date(DECISION_MS - 5000).toISOString(), traceId: 'trace-clean', // 5s BEFORE the decision - real, valid
    });
    await db.insert(schema.consensusEvidence).values({
      transactionId: 'ARG-TEST-CLEAN', sourceTraceId: 'trace-clean', agent: 'TechnicalAgent', side: 'BUY', confidence: 0.8, weight: 1.0, agreed: true,
    });

    await trainingExampleBuilder.buildPending();

    const [example] = await db.select().from(schema.trainingExamples).where(eq(schema.trainingExamples.transactionId, 'ARG-TEST-CLEAN'));
    expect(example).toBeTruthy();
    const label = JSON.parse(example.label);
    expect(label.outcome).toBe('WIN'); // price rose from 100 to 110, BUY was correct
    expect(new Date(example.availableAt).getTime()).toBeLessThanOrEqual(new Date(example.decisionAt).getTime());
  });

  it('skips a transaction where a contributing prediction is timestamped AFTER the decision (leakage)', async () => {
    await db.insert(schema.transactions).values({
      id: 'ARG-TEST-LEAK', symbol: 'LEAKTX', openedAt: DECISION_TIME.toISOString(), status: 'OPEN', finalDecision: 'BUY', outcome: 'PENDING',
    });
    await db.insert(schema.consensusDecisions).values({
      transactionId: 'ARG-TEST-LEAK', symbol: 'LEAKTX', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true,
      agreementsCount: 1, disagreementsCount: 0, createdAt: DECISION_TIME.toISOString(),
    });
    await db.insert(schema.agentPredictions).values({
      id: 'pred-leak', agentName: 'NewsAgent', symbol: 'LEAKTX', prediction: 'BUY', confidence: 0.8,
      reasoning: 'test', timestamp: new Date(DECISION_MS + 60000).toISOString(), traceId: 'trace-leak', // 60s AFTER the decision - impossible/leaked
    });
    await db.insert(schema.consensusEvidence).values({
      transactionId: 'ARG-TEST-LEAK', sourceTraceId: 'trace-leak', agent: 'NewsAgent', side: 'BUY', confidence: 0.8, weight: 1.0, agreed: true,
    });

    await trainingExampleBuilder.buildPending();

    const examples = await db.select().from(schema.trainingExamples).where(eq(schema.trainingExamples.transactionId, 'ARG-TEST-LEAK'));
    expect(examples).toHaveLength(0); // correctly skipped, never silently included
  });

  it('does not duplicate an already-built training example on a second run', async () => {
    await trainingExampleBuilder.buildPending();
    const examples = await db.select().from(schema.trainingExamples).where(eq(schema.trainingExamples.transactionId, 'ARG-TEST-CLEAN'));
    expect(examples).toHaveLength(1);
  });
});
