import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('agentWeightConsistency', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./agentWeightConsistency');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_weight_consistency_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./agentWeightConsistency');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty report when no agents are tracked yet', async () => {
    const rows = await mod.buildWeightConsistencyReport();
    expect(rows).toEqual([]);
  });

  it('flags an agent with too few effective predictions as consistent-by-default (not yet judgeable)', async () => {
    await db.insert(schema.agentPerformanceStats).values({
      agentName: 'ThinWeightAgent', totalPredictions: 5, correctPredictions: 3, winRate: 0.6,
      effectivePredictions: 3, effectiveCorrect: 2, evidenceStatus: 'INSUFFICIENT_EVIDENCE',
      currentWeight: 1.0, lastEvaluated: new Date().toISOString(),
    });
    const rows = await mod.buildWeightConsistencyReport();
    const row = rows.find((r) => r.agentName === 'ThinWeightAgent')!;
    expect(row.consistent).toBe(true);
    expect(row.detail).toContain('too few effective predictions');
  });

  it('flags a real, large divergence between actual weight and what real performance would set', async () => {
    // Real win rate is a strong 0.9 (would justify a much higher weight via agentWeightUpdate),
    // but the persisted currentWeight is still stuck at the neutral default 1.0.
    await db.insert(schema.agentPerformanceStats).values({
      agentName: 'DivergedWeightAgent', totalPredictions: 100, correctPredictions: 90, winRate: 0.9,
      effectivePredictions: 50, effectiveCorrect: 45, evidenceStatus: 'LEARNING_ELIGIBLE',
      currentWeight: 1.0, lastEvaluated: new Date().toISOString(),
    });
    const rows = await mod.buildWeightConsistencyReport();
    const row = rows.find((r) => r.agentName === 'DivergedWeightAgent')!;
    expect(row.consistent).toBe(false);
    expect(row.expectedWeightFromPerformance).toBeGreaterThan(row.actualCurrentWeight);
  });

  it('reports a genuinely consistent agent as consistent', async () => {
    // winRate 0.9 -> agentWeightUpdate expects currentWeight ~= 1.0 + (0.9-0.5)*2 = 1.8
    await db.insert(schema.agentPerformanceStats).values({
      agentName: 'ConsistentWeightAgent', totalPredictions: 100, correctPredictions: 90, winRate: 0.9,
      effectivePredictions: 50, effectiveCorrect: 45, evidenceStatus: 'LEARNING_ELIGIBLE',
      currentWeight: 1.8, lastEvaluated: new Date().toISOString(),
    });
    const rows = await mod.buildWeightConsistencyReport();
    const row = rows.find((r) => r.agentName === 'ConsistentWeightAgent')!;
    expect(row.consistent).toBe(true);
  });

  it('formatWeightConsistencyReport renders a readable text table', async () => {
    const rows = await mod.buildWeightConsistencyReport();
    const text = mod.formatWeightConsistencyReport(rows);
    expect(text).toContain('AGENT WEIGHT CONSISTENCY');
    expect(text).toContain('DivergedWeightAgent');
  });

  it('uses the EFFECTIVE (clustered) win rate, not the raw agent_performance_stats.winRate column - real bug fixed (Phase 11, 2026-08-31): this reproduces the real QuantEngine case (raw winRate 0.480, effectiveCorrect/effectivePredictions 18/51=0.353) where the two genuinely differ, and the report must side with the effective figure since that is what ReflectionEngine.ts itself actually uses to set currentWeight', async () => {
    await db.insert(schema.agentPerformanceStats).values({
      agentName: 'RawVsEffectiveAgent',
      totalPredictions: 839, correctPredictions: 403, winRate: 0.480, // raw - inflated by correlated duplicates
      effectivePredictions: 51, effectiveCorrect: 18, // effective win rate: 18/51 = 0.3529...
      evidenceStatus: 'LEARNING_ELIGIBLE',
      currentWeight: 0.706, // the real, correct weight this effective win rate would set
      lastEvaluated: new Date().toISOString(),
    });
    const rows = await mod.buildWeightConsistencyReport();
    const row = rows.find((r) => r.agentName === 'RawVsEffectiveAgent')!;
    expect(row.effectiveWinRate).toBeCloseTo(18 / 51, 5);
    // 1.0 + (0.3529 - 0.5) * 2 ~= 0.706 - matches currentWeight almost exactly, so this must be
    // reported as CONSISTENT. Before the fix, this used raw winRate (0.480) -> expected ~0.961,
    // falsely flagging a real, correct weight as inconsistent.
    expect(row.expectedWeightFromPerformance).toBeCloseTo(0.706, 2);
    expect(row.consistent).toBe(true);
  });
});
