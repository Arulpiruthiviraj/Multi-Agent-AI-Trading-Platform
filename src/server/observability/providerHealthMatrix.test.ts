import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('providerHealthMatrix', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./providerHealthMatrix');
  let AIRouter: typeof import('../ai/AIRouter').AIRouter;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_provider_matrix_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./providerHealthMatrix');
    ({ AIRouter } = await import('../ai/AIRouter'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns an empty matrix when no providers are configured', async () => {
    const matrix = await mod.buildProviderHealthMatrix();
    expect(matrix).toEqual([]);
  });

  it('reports a real DB row with recent ai_calls success/error counts and average latency', async () => {
    await db.insert(schema.aiProviders).values({
      id: 'prov-1', providerName: 'Gemini', apiKeyEncrypted: 'enc', defaultModel: 'gemini-1.5-pro',
      health: 'Healthy', lastSuccess: '2026-08-27T10:00:00.000Z', lastFailure: null,
    });
    const now = new Date('2026-08-27T20:00:00.000Z');
    await db.insert(schema.aiCalls).values({
      id: 'call-1', agent: 'NewsAgent', provider: 'prov-1', status: 'success', latencyMs: 200,
      createdAt: '2026-08-27T19:50:00.000Z',
    });
    await db.insert(schema.aiCalls).values({
      id: 'call-2', agent: 'NewsAgent', provider: 'prov-1', status: 'error', error: 'Claude API error: 401 Unauthorized', latencyMs: 100,
      createdAt: '2026-08-27T19:55:00.000Z',
    });

    const matrix = await mod.buildProviderHealthMatrix(now, 6 * 60 * 60 * 1000);
    expect(matrix).toHaveLength(1);
    const row = matrix[0];
    expect(row.providerId).toBe('prov-1');
    expect(row.hasApiKey).toBe(true);
    expect(row.recentCallCount).toBe(2);
    expect(row.recentSuccessCount).toBe(1);
    expect(row.recentErrorCount).toBe(1);
    expect(row.recentSuccessRate).toBeCloseTo(0.5);
    expect(row.avgLatencyMs).toBeCloseTo(150);
    expect(row.mostRecentError).toContain('401 Unauthorized');
    expect(row.routingState).toBe('ACTIVE');
  });

  it('excludes ai_calls rows outside the requested recent window', async () => {
    await db.insert(schema.aiProviders).values({ id: 'prov-2', providerName: 'Old Provider', health: 'Healthy' });
    await db.insert(schema.aiCalls).values({
      id: 'call-old', agent: 'NewsAgent', provider: 'prov-2', status: 'success', latencyMs: 50,
      createdAt: '2026-08-20T00:00:00.000Z',
    });
    const now = new Date('2026-08-27T20:00:00.000Z');
    const matrix = await mod.buildProviderHealthMatrix(now, 6 * 60 * 60 * 1000);
    const row = matrix.find((r) => r.providerId === 'prov-2')!;
    expect(row.recentCallCount).toBe(0);
    expect(row.recentSuccessRate).toBeNull();
  });

  it('reflects AIRouter live in-memory auth-disabled/skip cooldown state as routingState', async () => {
    await db.insert(schema.aiProviders).values({ id: 'prov-3', providerName: 'Broken Provider', health: 'Offline' });
    const router = AIRouter.getInstance() as any;
    router.authDisabledUntil.set('prov-3', Date.now() + 10 * 60 * 1000);

    const matrix = await mod.buildProviderHealthMatrix();
    const row = matrix.find((r) => r.providerId === 'prov-3')!;
    expect(row.routingState).toBe('AUTH_DISABLED');
    expect(row.routingCooldownRemainingMs).toBeGreaterThan(0);
  });
});
