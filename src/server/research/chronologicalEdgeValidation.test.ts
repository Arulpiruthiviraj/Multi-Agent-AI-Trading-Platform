import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('chronologicalEdgeValidation', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./chronologicalEdgeValidation');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_chrono_validation_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./chronologicalEdgeValidation');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function seed(agent: string, symbol: string, ts: number, outcome: 'WIN' | 'LOSS', idSuffix: string) {
    const id = `pred-${agent}-${idSuffix}`;
    return Promise.all([
      db.insert(schema.agentPredictions).values({
        id, agentName: agent, symbol, prediction: 'BUY', confidence: 0.7,
        reasoning: 'test', timestamp: new Date(ts).toISOString(),
      }),
      db.insert(schema.predictionOutcomes).values({
        predictionId: id, sourceTable: 'agent_predictions', symbol,
        actualPrice: 101, actualReturn: 0.01, actualDirection: 'UP',
        mfe: 0.01, mae: 0, outcome, evaluatedAt: new Date(ts).toISOString(),
      }),
    ]);
  }

  it('validateAgentOutOfSample returns INSUFFICIENT_SAMPLE when the agent has no data at all', async () => {
    const result = await mod.validateAgentOutOfSample('NeverSeenAgentOOS');
    expect(result.status).toBe('INSUFFICIENT_SAMPLE');
    expect(result.splits).toEqual([]);
  });

  it('validateAgentOutOfSample PASSES when performance is consistently above chance across the whole real history, including the most recent (OOS) period', async () => {
    const base = new Date('2026-07-01T00:00:00.000Z').getTime();
    // 120 predictions spread evenly over ~a real, long period, 75% win rate consistently -
    // 20% OOS split = 24 observations, clearing the sample-size floor.
    for (let i = 0; i < 120; i++) {
      await seed('GoodOosAgent', `SYM${i}`, base + i * 24 * 60 * 60000, i % 4 === 3 ? 'LOSS' : 'WIN', `g${i}`);
    }
    const result = await mod.validateAgentOutOfSample('GoodOosAgent');
    expect(result.status).toBe('OOS_PASSED');
    const oos = result.splits.find((s) => s.label === 'OOS')!;
    expect(oos.wilsonLower).toBeGreaterThan(0.5);
  });

  it('validateAgentOutOfSample FAILS when the OOS (most recent, previously-unseen) period does not clear chance even though earlier periods looked fine', async () => {
    const base = new Date('2026-07-05T00:00:00.000Z').getTime();
    // TRAIN+VALIDATION (first 80%, 96 of 120): strong 90% win rate. OOS (last 20%, 30 obs):
    // 50/50 chance-level - the apparent overall edge does NOT survive the most recent real period.
    for (let i = 0; i < 96; i++) {
      await seed('FadeOosAgent', `SYM${i}`, base + i * 24 * 60 * 60000, i % 10 === 9 ? 'LOSS' : 'WIN', `f${i}`);
    }
    for (let i = 96; i < 126; i++) {
      await seed('FadeOosAgent', `SYM${i}`, base + i * 24 * 60 * 60000, i % 2 === 0 ? 'WIN' : 'LOSS', `f${i}`);
    }
    const result = await mod.validateAgentOutOfSample('FadeOosAgent');
    expect(result.status).toBe('OOS_FAILED');
  });

  it('never lets a later prediction influence an earlier split - splits are strictly chronological with no overlap', async () => {
    const base = new Date('2026-07-10T00:00:00.000Z').getTime();
    for (let i = 0; i < 30; i++) {
      await seed('LeakageCheckAgent', `SYM${i}`, base + i * 24 * 60 * 60000, 'WIN', `l${i}`);
    }
    const result = await mod.validateAgentOutOfSample('LeakageCheckAgent');
    const [train, validation, oos] = result.splits;
    expect(train.fromMs).toBeLessThan(train.toMs);
    expect(train.toMs).toBeLessThanOrEqual(validation.fromMs);
    expect(validation.toMs).toBeLessThanOrEqual(oos.fromMs);
    expect(oos.toMs).toBeGreaterThan(oos.fromMs);
  });

  it('validateAgentWalkForward returns INSUFFICIENT_SAMPLE with too little history', async () => {
    const result = await mod.validateAgentWalkForward('NeverSeenAgentWF');
    expect(result.status).toBe('INSUFFICIENT_SAMPLE');
  });

  it('validateAgentWalkForward PASSES when every judgeable chronological fold is consistently above chance', async () => {
    const base = new Date('2026-06-01T00:00:00.000Z').getTime();
    for (let i = 0; i < 100; i++) {
      await seed('ConsistentWfAgent', `SYM${i}`, base + i * 24 * 60 * 60000, i % 4 === 3 ? 'LOSS' : 'WIN', `cw${i}`);
    }
    const result = await mod.validateAgentWalkForward('ConsistentWfAgent', 4);
    expect(result.status).toBe('WALK_FORWARD_PASSED');
  });

  it('validateAgentWalkForward FAILS when chronological folds disagree on which side of chance they sit (regime-dependent, not a stable edge)', async () => {
    const base = new Date('2026-05-01T00:00:00.000Z').getTime();
    // First half of history: consistently winning. Second half: consistently losing.
    for (let i = 0; i < 50; i++) {
      await seed('FlippingWfAgent', `SYM${i}`, base + i * 24 * 60 * 60000, i % 5 === 4 ? 'LOSS' : 'WIN', `fw${i}`);
    }
    for (let i = 50; i < 100; i++) {
      await seed('FlippingWfAgent', `SYM${i}`, base + i * 24 * 60 * 60000, i % 5 === 4 ? 'WIN' : 'LOSS', `fw${i}`);
    }
    const result = await mod.validateAgentWalkForward('FlippingWfAgent', 4);
    expect(result.status).toBe('WALK_FORWARD_FAILED');
  });
});
