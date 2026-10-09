import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * A1 (2026-10-08): sticky-Offline quarantine has no recovery path.
 *
 * Defect, proven in code (no test existed for any recovery):
 *   - Writers: src/server/ai/AIRouter.ts:493 (disableProviderForAuthFailure),
 *     :1059 (routeConsensus failure branch), :1391 (routeTask failure branch) set
 *     aiProviders.health='Offline' (the two failure branches via successRate decaying below 50).
 *   - Readers: :909 and :1174 (`isKnownDead`) permanently EXCLUDE health='Offline'
 *     providers from routing whenever any live provider remains.
 *   - The only writer back to a routable health is a *successful routed call* - which the
 *     exclusion above makes unreachable while any other provider is live.
 *   - The periodic health monitor (AIProviderHealthCheck.tick(), every
 *     aiProviderHealthCheckMs) probes every registered provider for real, but writes its
 *     results only to an in-memory tracker map - it never touches aiProviders.health.
 *   => A transient outage permanently removes the provider until manual DB surgery.
 *
 * Fix: after aiProviderQuarantineCooldownMs (config/runtimeIntervals.json), the health
 * monitor's real re-probe restores the provider (to 'Degraded' - back in rotation but
 * deprioritized; the organic +/-1/-5 successRate math still governs from there) on success.
 * Fail-closed: a failed re-probe, a re-probe before the cooldown, or a missing/unparseable
 * quarantine timestamp keeps the provider Offline. Never touches strategy lifecycle
 * (VALIDATED/CHAMPION), consensus thresholds, or RiskEngine.
 *
 * Real isolated temp SQLite DB (maybeRecoverQuarantinedProvider reads/writes ai_providers).
 * The cooldown is derived from the same config production loads (AGENTS.md rule).
 */
describe('AIProviderHealthCheck quarantine recovery (A1)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: any;
  let eq: any;
  let maybeRecoverQuarantinedProvider: (
    providerId: string,
    probeSucceeded: boolean,
    nowMs?: number,
  ) => Promise<'restored' | 'kept-offline' | 'not-quarantined'>;
  let runtimeIntervals: any;
  let cooldownMs: number;

  async function seedProvider(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = `qprov-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await db.insert(schema.aiProviders).values({
      id,
      providerName: 'TestProvider',
      enabled: true,
      health: 'Healthy',
      successRate: 100,
      ...overrides,
    });
    return id;
  }

  async function readHealth(id: string): Promise<{ health: string | null; successRate: number | null; lastSuccess: string | null }> {
    const rows = await db.select({
      health: schema.aiProviders.health,
      successRate: schema.aiProviders.successRate,
      lastSuccess: schema.aiProviders.lastSuccess,
    }).from(schema.aiProviders).where(eq(schema.aiProviders.id, id));
    return rows[0];
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_quarantine_recovery_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const dbMod = await import('../db');
    sqliteDb = dbMod.sqliteDb;
    db = dbMod.db;
    schema = await import('../db/schema');
    ({ eq } = await import('drizzle-orm'));
    // Fails pre-fix: the recovery path does not exist (nothing ever clears a sticky Offline).
    ({ maybeRecoverQuarantinedProvider } = await import('./AIProviderHealthCheck'));
    ({ runtimeIntervals } = await import('../config/runtimeIntervals'));
    cooldownMs = runtimeIntervals.aiProviderQuarantineCooldownMs;
    expect(typeof cooldownMs).toBe('number');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    await db.delete(schema.aiProviders);
  });

  it('quarantine sticks BEFORE the cooldown even when the re-probe succeeds', async () => {
    const now = Date.now();
    const id = await seedProvider({
      health: 'Offline',
      successRate: 45,
      // Quarantined 5 minutes ago - well inside the cooldown.
      lastFailure: new Date(now - 5 * 60 * 1000).toISOString(),
    });
    const outcome = await maybeRecoverQuarantinedProvider(id, /* probeSucceeded */ true, now);
    expect(outcome).toBe('kept-offline');
    const row = await readHealth(id);
    expect(row.health).toBe('Offline');
    expect(row.successRate).toBe(45);
  });

  it('a successful re-probe AFTER the cooldown restores the provider (fail-open only on real evidence)', async () => {
    const now = Date.now();
    const id = await seedProvider({
      health: 'Offline',
      successRate: 40,
      lastFailure: new Date(now - cooldownMs - 60_000).toISOString(),
    });
    const outcome = await maybeRecoverQuarantinedProvider(id, /* probeSucceeded */ true, now);
    expect(outcome).toBe('restored');
    const row = await readHealth(id);
    // Restored conservatively: 'Degraded' re-enters routing (only 'Offline' is excluded) but
    // stays below 'Healthy' in sort priority; successRate is lifted just above the 50
    // quarantine line so the restored row is internally consistent with the existing
    // "health='Offline' <=> successRate<50" write-time invariant - the organic -5/failure math
    // still re-quarantines on sustained real failures.
    expect(row.health).toBe('Degraded');
    expect(row.successRate).toBeGreaterThanOrEqual(51);
    expect(row.lastSuccess).toBe(new Date(now).toISOString());
  });

  it('a FAILED re-probe after the cooldown keeps the provider Offline (fail-closed)', async () => {
    const now = Date.now();
    const id = await seedProvider({
      health: 'Offline',
      successRate: 30,
      lastFailure: new Date(now - cooldownMs - 60_000).toISOString(),
    });
    const outcome = await maybeRecoverQuarantinedProvider(id, /* probeSucceeded */ false, now);
    expect(outcome).toBe('kept-offline');
    const row = await readHealth(id);
    expect(row.health).toBe('Offline');
    expect(row.successRate).toBe(30);
  });

  it('a provider that is not Offline is never touched (no-op)', async () => {
    const now = Date.now();
    const id = await seedProvider({
      health: 'Degraded',
      successRate: 60,
      lastFailure: new Date(now - cooldownMs - 60_000).toISOString(),
    });
    const outcome = await maybeRecoverQuarantinedProvider(id, /* probeSucceeded */ true, now);
    expect(outcome).toBe('not-quarantined');
    const row = await readHealth(id);
    expect(row.health).toBe('Degraded');
    expect(row.successRate).toBe(60);
  });

  it('a missing quarantine timestamp fails closed (cannot prove the cooldown elapsed)', async () => {
    const now = Date.now();
    const id = await seedProvider({
      health: 'Offline',
      successRate: 20,
      lastFailure: null,
    });
    const outcome = await maybeRecoverQuarantinedProvider(id, /* probeSucceeded */ true, now);
    expect(outcome).toBe('kept-offline');
    expect((await readHealth(id)).health).toBe('Offline');
  });

  it('an operator-disabled provider is never resurrected by the recovery path', async () => {
    const now = Date.now();
    const id = await seedProvider({
      enabled: false,
      health: 'Offline',
      successRate: 40,
      lastFailure: new Date(now - cooldownMs - 60_000).toISOString(),
    });
    const outcome = await maybeRecoverQuarantinedProvider(id, /* probeSucceeded */ true, now);
    expect(outcome).toBe('kept-offline');
    expect((await readHealth(id)).health).toBe('Offline');
  });
});
