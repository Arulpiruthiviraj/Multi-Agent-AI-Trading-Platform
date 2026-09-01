import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/**
 * Real integration test (isolated temp SQLite DB, never data/argus.db) for the AI Cost Governor's
 * provider-quality ledger (docs/audits/ARGUS_PROJECT_A_AI_COST_GOVERNOR_DESIGN_NOTE.md §C) - proves
 * getProviderSegmentedStats() correctly joins the EXISTING agentPredictions/predictionOutcomes
 * tables (no new schema) and groups by the `provider` column, mirroring
 * ModelPerformanceTracker.getRegimeSegmentedStats()'s own test shape exactly, grouped by provider
 * instead of regime.
 */
describe('ProviderPerformanceTracker', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let getProviderSegmentedStats: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_provider_perf_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ getProviderSegmentedStats } = await import('./ProviderPerformanceTracker'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty array for an agent with no predictions at all', async () => {
    const stats = await getProviderSegmentedStats('NeverSeenAgent');
    expect(stats).toEqual([]);
  });

  it('groups wins/losses by the provider captured at prediction time', async () => {
    const agentName = `TestProviderAgent_${Date.now()}`;
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    const p3 = crypto.randomUUID();
    const pUnknown = crypto.randomUUID();
    await db.insert(schema.agentPredictions).values([
      { id: p1, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.7, reasoning: 'r', timestamp: new Date().toISOString(), provider: 'ollama' },
      { id: p2, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.6, reasoning: 'r', timestamp: new Date().toISOString(), provider: 'ollama' },
      { id: p3, agentName, symbol: 'AAPL', prediction: 'SELL', confidence: 0.5, reasoning: 'r', timestamp: new Date().toISOString(), provider: 'mistral' },
      { id: pUnknown, agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.5, reasoning: 'r', timestamp: new Date().toISOString() },
    ]);
    await db.insert(schema.predictionOutcomes).values([
      { predictionId: p1, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'WIN', actualReturn: 0.02, evaluatedAt: new Date().toISOString() },
      { predictionId: p2, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'LOSS', actualReturn: -0.01, evaluatedAt: new Date().toISOString() },
      { predictionId: p3, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'WIN', actualReturn: 0.03, evaluatedAt: new Date().toISOString() },
      { predictionId: pUnknown, sourceTable: 'agent_predictions', symbol: 'AAPL', outcome: 'N_A', evaluatedAt: new Date().toISOString() },
    ]);

    const stats = await getProviderSegmentedStats(agentName);
    const ollama = stats.find((s: any) => s.provider === 'ollama');
    const mistral = stats.find((s: any) => s.provider === 'mistral');

    expect(ollama).toBeDefined();
    expect(ollama.total).toBe(2);
    expect(ollama.wins).toBe(1);
    expect(ollama.losses).toBe(1);
    expect(ollama.winRate).toBeCloseTo(0.5);

    expect(mistral).toBeDefined();
    expect(mistral.total).toBe(1);
    expect(mistral.wins).toBe(1);

    // The N_A (HOLD-style) prediction is never counted as a win, loss, or even a total - excluded
    // entirely, same discipline as ReflectionEngine's own win-rate/calibration aggregation.
    expect(stats.find((s: any) => s.provider === 'UNKNOWN')).toBeUndefined();
  });

  it('a provider with zero graded outcomes never appears with a fabricated wilsonLower', async () => {
    const agentName = `TestPendingAgent_${Date.now()}`;
    await db.insert(schema.agentPredictions).values({
      id: crypto.randomUUID(), agentName, symbol: 'AAPL', prediction: 'BUY', confidence: 0.7,
      reasoning: 'r', timestamp: new Date().toISOString(), provider: 'claude',
    });
    // No matching predictionOutcomes row - not yet evaluated.
    const stats = await getProviderSegmentedStats(agentName);
    expect(stats).toEqual([]); // never fabricates a bucket with zero graded evidence
  });
});
