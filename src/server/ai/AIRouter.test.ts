import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Phase 1/Phase 7 (ARGUS_SAFETY_HARDENING_REPORT.md / AI_MODEL_INVENTORY.md) - the current audit
 * (FINAL_ANALYSIS.md Section 30.8) found `AIRouter.test.ts` did not exist at all: the failover
 * loop, parallel-consensus aggregation, and (before this phase) the complete absence of any
 * timeout had zero direct unit coverage. This file closes that gap, focused specifically on the
 * real behavior this phase changed: a hung provider must never block the caller indefinitely, and
 * a timeout must be treated exactly like any other provider failure (fails over / reports error,
 * never silently becomes a fabricated decision).
 *
 * Real isolated temp SQLite DB (routeTask/routeConsensus both read `ai_providers`/`ai_usage`), the
 * real AIRouter singleton, real registerProvider() (no private-field reaching-in), fake timers to
 * advance through the real 20s AI_PROVIDER_TIMEOUT_MS without a slow real-time wait.
 */
describe('AIRouter provider timeout (Phase 1)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let aiRouter: any;

  function hungProvider(): any {
    return {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(() => new Promise(() => {})), // never resolves - simulates a truly hung call
      estimateCost: vi.fn(() => 0),
    };
  }

  function fastProvider(content = '{"decision":"HOLD"}'): any {
    return {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => ({ content, tokens: 10, inputTokens: 5, outputTokens: 5 })),
      estimateCost: vi.fn(() => 0),
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_airouter_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb } = await import('../db'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    const { AIRouter } = await import('./AIRouter');
    aiRouter = AIRouter.getInstance();
    aiRouter.clearProviders(); // the singleton persists across tests within this file - start clean each time
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runAndAdvance(promise: Promise<any>, ms = 25_000): Promise<any> {
    const advancing = vi.advanceTimersByTimeAsync(ms);
    const [result] = await Promise.all([promise, advancing]);
    return result;
  }

  it('routeTask() does not hang forever on a single hung provider - it eventually fails with a real error, not a stuck promise', async () => {
    aiRouter.registerProvider('hung-only', hungProvider());

    const result = await runAndAdvance(
      aiRouter.routeTask('TestAgent', 'test prompt', 'trace-1').then(() => 'RESOLVED').catch((e: any) => e.message)
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/All AI providers failed/);
  }, 15_000);

  it('routeTask() fails over to a healthy second provider after the first one times out - never blocks on the hung one', async () => {
    aiRouter.registerProvider('hung-first', hungProvider());
    aiRouter.registerProvider('fast-second', fastProvider('{"decision":"BUY"}'));

    const result = await runAndAdvance(aiRouter.routeTask('TestAgent', 'test prompt', 'trace-2'));
    expect(result.content).toContain('BUY');
    expect(result.provider).toBe('fast-second');
  }, 15_000);

  it("routeConsensus() treats a hung provider's timeout exactly like any other failure - reports status:error, never blocks the overall Promise.all", async () => {
    aiRouter.registerProvider('hung-consensus', hungProvider());

    const result = await runAndAdvance(aiRouter.routeConsensus('TestAgent', 'test prompt', 'trace-3'));
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe('error');
    expect(result.results[0].error).toMatch(/did not respond within/);
    // A hung/timed-out provider must never silently become a fabricated verdict.
    expect(result.consensus_verdict).toBe('HOLD');
  }, 15_000);

  it('routeConsensus() still aggregates a real successful provider alongside a timed-out one', async () => {
    aiRouter.registerProvider('hung-consensus-2', hungProvider());
    aiRouter.registerProvider('fast-consensus', fastProvider('{"decision":"SELL","confidence":80,"reasoning":"test","supportingFactors":[],"risks":[]}'));

    const result = await runAndAdvance(aiRouter.routeConsensus('TestAgent', 'test prompt', 'trace-4'));
    const statuses = result.results.map((r: any) => r.status).sort();
    expect(statuses).toEqual(['error', 'success']);
    expect(result.consensus_verdict).toBe('SELL');
  }, 15_000);
});
