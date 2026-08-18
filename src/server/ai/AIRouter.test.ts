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

  it('routeTask() disables a provider on HTTP 401 and fails over to the next provider', async () => {
    const authFailProvider = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error('HTTP 401 Unauthorized'); }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('auth-dead', authFailProvider);
    aiRouter.registerProvider('fast-after-auth', fastProvider('{"ok":true}'));

    const result = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-auth');
    expect(result.provider).toBe('fast-after-auth');
    expect(aiRouter.isProviderAuthDisabled('auth-dead')).toBe(true);
  });

  it('routeConsensus() calls at most tradingSafety.consensusMaxProviders providers (DEF-15)', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const chats: string[] = [];
    const make = (id: string) => ({
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => {
        chats.push(id);
        return { content: '{"decision":"HOLD","confidence":10}', tokens: 1, inputTokens: 1, outputTokens: 1 };
      }),
      estimateCost: vi.fn(() => 0),
    });
    aiRouter.registerProvider('c1', make('c1'));
    aiRouter.registerProvider('c2', make('c2'));
    aiRouter.registerProvider('c3', make('c3'));

    const result = await runAndAdvance(aiRouter.routeConsensus('TestAgent', 'prompt', 'trace-topk'));
    expect(result.results).toHaveLength(tradingSafety.consensusMaxProviders);
    expect(chats).toHaveLength(tradingSafety.consensusMaxProviders);
  }, 15_000);

  it('routeTask() skips a 404 provider on the next call without treating it as auth-disable', async () => {
    const dead = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error('NVIDIA API error: 404 Not Found'); }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('nvidia-404', dead);
    aiRouter.registerProvider('ok-provider', fastProvider('{"ok":true}'));

    const first = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-404-a');
    expect(first.provider).toBe('ok-provider');
    expect(dead.chat).toHaveBeenCalledTimes(1);
    expect(aiRouter.isProviderTemporarilySkipped('nvidia-404')).toBe(true);
    expect(aiRouter.isProviderAuthDisabled('nvidia-404')).toBe(false);

    const second = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-404-b');
    expect(second.provider).toBe('ok-provider');
    expect(dead.chat).toHaveBeenCalledTimes(1);
  });

  it('routeTask() skips a fetch-failed provider on the next call', async () => {
    const dead = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error('fetch failed'); }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('litellm-dead', dead);
    aiRouter.registerProvider('ok-provider', fastProvider('{"ok":true}'));

    await aiRouter.routeTask('TestAgent', 'prompt', 'trace-fetch-a');
    expect(aiRouter.isProviderTemporarilySkipped('litellm-dead')).toBe(true);
    await aiRouter.routeTask('TestAgent', 'prompt', 'trace-fetch-b');
    expect(dead.chat).toHaveBeenCalledTimes(1);
  });

  it('routeTask() skips a timed-out provider for tradingSafety.aiProviderTimeoutSkipCooldownMs', async () => {
    const { tradingSafety } = await import('../config/tradingSafety');
    const hung = hungProvider();
    aiRouter.registerProvider('hung-ollama', hung);
    aiRouter.registerProvider('ok-provider', fastProvider('{"ok":true}'));

    const first = await runAndAdvance(aiRouter.routeTask('TestAgent', 'prompt', 'trace-to-a'));
    expect(first.provider).toBe('ok-provider');
    expect(aiRouter.isProviderTemporarilySkipped('hung-ollama')).toBe(true);

    const second = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-to-b');
    expect(second.provider).toBe('ok-provider');
    expect(hung.chat).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(tradingSafety.aiProviderTimeoutSkipCooldownMs + 1);
    expect(aiRouter.isProviderTemporarilySkipped('hung-ollama')).toBe(false);
  }, 15_000);
});

describe('AIRouter provider selection helpers (DEF-14/15)', () => {
  it('skips remote providers with no API key and keeps local ones', async () => {
    const { shouldSkipUnconfiguredProvider, selectConsensusProviders } = await import('./AIRouter');
    expect(shouldSkipUnconfiguredProvider({ apiKey: undefined, isLocal: false })).toBe(true);
    expect(shouldSkipUnconfiguredProvider({ apiKey: 'sk-test', isLocal: false })).toBe(false);
    expect(shouldSkipUnconfiguredProvider({ apiKey: undefined, isLocal: true })).toBe(false);
    expect(selectConsensusProviders([['a', 1], ['b', 2], ['c', 3]] as [string, number][], 2).map(([id]) => id)).toEqual(['a', 'b']);
  });
});

describe('isAuthFailureError - real bug fix: Gemini real-key-rejection phrasing was never caught', () => {
  it('CRITICAL: catches Gemini\'s real "API key not valid" message (found live - was not caught before this fix)', async () => {
    const { isAuthFailureError } = await import('./AIRouter');
    const geminiRealMessage = '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}';
    expect(isAuthFailureError(new Error(geminiRealMessage))).toBe(true);
  });

  it('still catches every previously-supported phrasing (no regression)', async () => {
    const { isAuthFailureError } = await import('./AIRouter');
    expect(isAuthFailureError(new Error('401 Unauthorized'))).toBe(true);
    expect(isAuthFailureError(new Error('OpenAI API error: Unauthorized'))).toBe(true);
    expect(isAuthFailureError(new Error('403 Forbidden'))).toBe(true);
    expect(isAuthFailureError(new Error('invalid api key supplied'))).toBe(true);
  });

  it('does not misclassify genuinely non-auth failures (timeout, 404, network)', async () => {
    const { isAuthFailureError, isUnreachableProviderError, isTimeoutSkipError } = await import('./AIRouter');
    expect(isAuthFailureError(new Error('did not respond within 20000ms'))).toBe(false);
    expect(isAuthFailureError(new Error('NVIDIA API error: 404 Not Found'))).toBe(false);
    expect(isAuthFailureError(new Error('fetch failed'))).toBe(false);
    expect(isUnreachableProviderError(new Error('NVIDIA API error: 404 Not Found'))).toBe(true);
    expect(isUnreachableProviderError(new Error('fetch failed'))).toBe(true);
    expect(isTimeoutSkipError(new Error('NVIDIA API error: 404 Not Found'))).toBe(false);
  });
});
