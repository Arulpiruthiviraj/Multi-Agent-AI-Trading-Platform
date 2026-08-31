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
});
