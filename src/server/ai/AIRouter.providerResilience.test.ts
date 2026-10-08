import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Provider-resilience audit fixes (2026-10-07) - regression coverage:
 *
 * D1 (P1): routeConsensus() now consumes one pipeline rate-limit token per debate
 *          (shared 90/min maxAiCallsPerMinute sliding window). A burst of N
 *          distinct-symbol ideas can no longer fan out to 2N paid provider calls;
 *          throttled debates fail closed (throw) exactly like the no-providers path,
 *          which ChiefTrader's existing .catch() already routes to
 *          pushDebateFailClosed('routeConsensus threw') - excluded from consensus,
 *          never a vote.
 * D3 (P2): routeTask() now coalesces identical concurrent requests (agentType +
 *          prompt-sha256, jsonMode-aware) onto one in-flight provider execution,
 *          mirroring AICallGovernor's singleflight pattern with a bounded map
 *          (cap aiStateCacheMaxEntries, stale-entry TTL aiRouterInflightDedupTtlMs).
 * D5 (P2): routeConsensus() now updates aiProviders successRate/latency/health on
 *          per-provider success AND failure, mirroring routeTask()'s ±(1|5)
 *          update - a consensus-only-failing provider can finally decay below the
 *          50 'Offline' quarantine.
 *
 * Real isolated temp SQLite DB (routeTask/routeConsensus both read ai_providers /
 * ai_usage), the real AIRouter singleton, real registerProvider(). Thresholds are
 * derived from the same config production loads (AGENTS.md rule).
 */
describe('AIRouter provider-resilience fixes (D1/D3/D5)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: any;
  let eq: any;
  let aiRouter: any;
  let resetPipelineRateLimitForTests: () => void;
  let tradingSafety: any;

  function fastProvider(content = '{"decision":"HOLD","confidence":50,"reasoning":"ok","supportingFactors":[],"risks":[]}'): any {
    return {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => ({ content, tokens: 10, inputTokens: 5, outputTokens: 5 })),
      estimateCost: vi.fn(() => 0),
    };
  }

  function failingProvider(message = 'boom'): any {
    return {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error(message); }),
      estimateCost: vi.fn(() => 0),
    };
  }

  function registeredChatCalls(provider: any): number {
    return provider.chat.mock.calls.length;
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_airouter_resilience_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    const dbMod = await import('../db');
    sqliteDb = dbMod.sqliteDb;
    db = dbMod.db;
    schema = await import('../db/schema');
    ({ eq } = await import('drizzle-orm'));
    ({ resetPipelineRateLimitForTests } = await import('../core/pipelineRateLimit'));
    ({ tradingSafety } = await import('../config/tradingSafety'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    const { AIRouter } = await import('./AIRouter');
    aiRouter = AIRouter.getInstance();
    aiRouter.clearProviders(); // singleton persists across tests - start clean each time
    resetPipelineRateLimitForTests();
    // Wipe ai_providers/ai_usage rows between tests so D5 assertions are isolated.
    await db.delete(schema.aiUsage);
    await db.delete(schema.aiProviders);
  });

  describe('D1: routeConsensus global per-minute rate cap', () => {
    it('throttles debates at maxAiCallsPerMinute: throttled debates fail closed with no provider calls beyond the cap', async () => {
      const cap: number = tradingSafety.maxAiCallsPerMinute;
      const provider = fastProvider();
      aiRouter.registerProvider('d1-provider', provider);

      const outcomes: Array<'resolved' | 'rejected'> = [];
      // Sequential awaits keep each fake-provider debate fast while exercising the
      // real sliding-window accounting (no timer tricks - the window is wall-clock).
      for (let i = 0; i < cap + 5; i++) {
        try {
          await aiRouter.routeConsensus('TestAgent', `debate prompt ${i}`, `trace-d1-${i}`);
          outcomes.push('resolved');
        } catch (e: any) {
          outcomes.push('rejected');
          expect(String(e?.message || e)).toMatch(/rate-limited|MAX_AI_CALLS_PER_MINUTE/i);
        }
      }

      const resolved = outcomes.filter((o) => o === 'resolved').length;
      const rejected = outcomes.filter((o) => o === 'rejected').length;
      expect(resolved).toBe(cap);
      expect(rejected).toBe(5);
      // The cost-storm vector is closed: no provider was contacted beyond the cap.
      expect(registeredChatCalls(provider)).toBe(cap);
    }, 120_000);

    it('a throttled debate consumes no provider call and the failure is the reviewed fail-closed shape (throw, not a fabricated verdict)', async () => {
      const cap: number = tradingSafety.maxAiCallsPerMinute;
      const provider = fastProvider();
      aiRouter.registerProvider('d1-provider', provider);

      for (let i = 0; i < cap; i++) {
        await aiRouter.routeConsensus('TestAgent', `debate prompt ${i}`, `trace-d1b-${i}`);
      }
      const chatsBefore = registeredChatCalls(provider);
      await expect(aiRouter.routeConsensus('TestAgent', 'one more debate', 'trace-d1b-cap'))
        .rejects.toThrow(/rate-limited/i);
      // Rejection (not a resolved no-verdict object) mirrors the existing no-providers
      // throw path, which ChiefTrader's .catch() already maps to
      // pushDebateFailClosed('routeConsensus threw') -> never a vote.
      expect(registeredChatCalls(provider)).toBe(chatsBefore);
    }, 120_000);
  });

  describe('D3: routeTask in-flight request coalescing', () => {
    it('20 concurrent identical routeTask calls produce exactly 1 provider call with identical outputs', async () => {
      const provider = fastProvider('{"side":"HOLD","confidence":0.9}');
      aiRouter.registerProvider('d3-provider', provider);

      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          aiRouter.routeTask('TestAgent', 'identical article analysis prompt', `trace-d3-${i}`),
        ),
      );

      expect(registeredChatCalls(provider)).toBe(1);
      for (const r of results) {
        expect(r.content).toBe(results[0].content);
        expect(r.provider).toBe('d3-provider');
      }
    });

    it('different prompts are not coalesced (one provider call each)', async () => {
      const provider = fastProvider('{"side":"HOLD"}');
      aiRouter.registerProvider('d3-provider', provider);

      const [a, b] = await Promise.all([
        aiRouter.routeTask('TestAgent', 'prompt alpha', 'trace-d3c-1'),
        aiRouter.routeTask('TestAgent', 'prompt beta', 'trace-d3c-2'),
      ]);

      expect(registeredChatCalls(provider)).toBe(2);
      expect(a.provider).toBe('d3-provider');
      expect(b.provider).toBe('d3-provider');
    });

    it('coalesced duplicates consume only one pipeline rate-limit token', async () => {
      const cap: number = tradingSafety.maxAiCallsPerMinute;
      const provider = fastProvider('{"side":"HOLD"}');
      aiRouter.registerProvider('d3-provider', provider);

      // Fire cap identical concurrent calls: they must all resolve (one token spent),
      // proving joined calls do not each burn a token.
      const results = await Promise.all(
        Array.from({ length: cap }, (_, i) =>
          aiRouter.routeTask('TestAgent', 'same prompt for token test', `trace-d3t-${i}`),
        ),
      );
      expect(registeredChatCalls(provider)).toBe(1);
      expect(results).toHaveLength(cap);
      for (const r of results) expect(r.provider).toBe('d3-provider');
    });

    it('the dedup entry is released on settle: a later identical call makes a fresh provider call (no stale response caching)', async () => {
      const provider = fastProvider('{"side":"HOLD"}');
      aiRouter.registerProvider('d3-provider', provider);

      await aiRouter.routeTask('TestAgent', 'repeatable prompt', 'trace-d3r-1');
      await aiRouter.routeTask('TestAgent', 'repeatable prompt', 'trace-d3r-2');

      expect(registeredChatCalls(provider)).toBe(2);
    });
  });

  describe('D5: routeConsensus updates provider successRate/health', () => {
    async function seedProviderRow(id: string, successRate: number) {
      await db.insert(schema.aiProviders).values({
        id,
        providerName: id,
        enabled: true,
        priority: 1,
        health: 'Healthy',
        latency: 100,
        successRate,
        requests: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
      });
    }

    async function readProviderRow(id: string) {
      const rows = await db.select().from(schema.aiProviders).where(eq(schema.aiProviders.id, id));
      return rows[0];
    }

    it('credits successRate +1 (capped at 100) and marks Healthy on consensus success, mirroring routeTask', async () => {
      await seedProviderRow('d5-ok', 90);
      aiRouter.registerProvider('d5-ok', fastProvider());

      const result = await aiRouter.routeConsensus('TestAgent', 'd5 prompt', 'trace-d5-ok');
      expect(result.successCount).toBe(1);

      const row = await readProviderRow('d5-ok');
      expect(row.successRate).toBe(91);
      expect(row.health).toBe('Healthy');
      expect(row.requests).toBe(1);
      expect(row.lastSuccess).toBeTruthy();
      expect(row.latency).toBeGreaterThanOrEqual(0);
    });

    it('decays successRate -5 and marks Degraded on consensus failure, mirroring routeTask', async () => {
      await seedProviderRow('d5-fail', 90);
      aiRouter.registerProvider('d5-fail', failingProvider('consensus transport down'));

      const result = await aiRouter.routeConsensus('TestAgent', 'd5 prompt', 'trace-d5-fail');
      expect(result.successCount).toBe(0);

      const row = await readProviderRow('d5-fail');
      expect(row.successRate).toBe(85);
      expect(row.health).toBe('Degraded');
      expect(row.lastFailure).toBeTruthy();
    });

    it('a repeatedly consensus-failing provider reaches the Offline quarantine below 50', async () => {
      await seedProviderRow('d5-dead', 52);
      aiRouter.registerProvider('d5-dead', failingProvider('still down'));

      await aiRouter.routeConsensus('TestAgent', 'd5 prompt', 'trace-d5-dead');

      const row = await readProviderRow('d5-dead');
      expect(row.successRate).toBe(47);
      expect(row.health).toBe('Offline');
    });
  });
});
