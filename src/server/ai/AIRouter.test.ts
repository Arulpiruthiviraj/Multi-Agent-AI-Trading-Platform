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

  it('routeTask() returns fail-closed HOLD without retrying when no providers are registered', async () => {
    const result = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-empty', true);
    expect(result.provider).toBe('throttled');
    expect(result.content).toContain('HOLD');
    expect(result.content).toContain('NO_ROUTABLE_AI_PROVIDERS');
  });

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

  it('routeConsensus / BullResearcher fail closed within researchTimeoutMs (not the 20s provider default)', async () => {
    const { aiModels } = await import('../config/aiModels');
    expect(aiModels.researchTimeoutMs).toBe(8000);
    aiRouter.registerProvider('hung-research', hungProvider());

    const consensus = await runAndAdvance(
      aiRouter.routeConsensus('ConsensusDebate', 'test prompt', 'trace-research-ms'),
      aiModels.researchTimeoutMs + 1_000,
    );
    expect(consensus.consensus_verdict).toBe('HOLD');
    expect(consensus.results[0].error).toMatch(new RegExp(String(aiModels.researchTimeoutMs)));

    // Fresh hung provider — prior consensus call may have put hung-research in skip cooldown.
    aiRouter.clearProviders();
    aiRouter.registerProvider('hung-bull', hungProvider());
    const bullOutcome = await runAndAdvance(
      aiRouter.routeTask('BullResearcher', 'test prompt', 'trace-bull-ms', true)
        .then((r: any) => r)
        .catch((e: any) => ({ threw: true, message: e.message })),
      aiModels.researchTimeoutMs + 1_000,
    );
    if (bullOutcome?.threw) {
      expect(bullOutcome.message).toMatch(/All AI providers failed|did not respond within/);
    } else {
      // Fail-closed HOLD / confidence 0 — never a fabricated BUY/SELL from a hung research call.
      expect(String(bullOutcome.content)).toMatch(/HOLD|All AI providers failed|NO_ROUTABLE|AI_RATE_LIMITED/i);
    }
  }, 15_000);

  it('routeTask() gives a local Ollama provider ollamaHardTimeoutMs, not the short remote researchTimeoutMs, before failing closed - real fix: a cold Ollama model load alone measured 12s+, exceeding the old shared 8s cap', async () => {
    const { aiModels } = await import('../config/aiModels');
    const { db } = await import('../db');
    const schema = await import('../db/schema');
    expect(aiModels.ollamaHardTimeoutMs).toBeGreaterThan(aiModels.researchTimeoutMs);

    await db.insert(schema.aiProviders).values({
      id: 'ollama-local-hung',
      providerName: 'Ollama (Local)',
      apiEndpoint: 'http://127.0.0.1:11434/v1',
    });
    try {
      aiRouter.registerProvider('ollama-local-hung', hungProvider());

      let settled = false;
      const p = aiRouter.routeTask('TestAgent', 'test prompt', 'trace-ollama-local')
        .then(() => 'RESOLVED').catch((e: any) => e.message)
        .then((r: any) => { settled = true; return r; });

      // Advance just past the OLD short remote cap (8s) - must still be hung if the fix holds.
      await vi.advanceTimersByTimeAsync(aiModels.researchTimeoutMs + 500);
      expect(settled).toBe(false);

      // Advance the rest of the way to the real local cap (25s) - now it must fail closed.
      await vi.advanceTimersByTimeAsync(aiModels.ollamaHardTimeoutMs - aiModels.researchTimeoutMs + 1_000);
      const result = await p;
      expect(settled).toBe(true);
      expect(result).toMatch(/All AI providers failed/);
    } finally {
      await db.delete(schema.aiProviders).where((await import('drizzle-orm')).eq(schema.aiProviders.id, 'ollama-local-hung'));
    }
  }, 30_000);

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

  it('routeTask() gives a model-not-found 404 (e.g. NVIDIA NIM misconfiguration) the LONG quota-style cooldown, not the short generic-404 cooldown — real gap found in the Phase 9 forensic audit: NVIDIA logged 0/623 successes over 24h while still being retried every ~5 minutes', async () => {
    const misconfigured = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error("NVIDIA API error: 404 Not Found - model 'gpt-3.5-turbo' does not exist"); }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('nvidia-model-404', misconfigured);
    aiRouter.registerProvider('ok-provider', fastProvider('{"ok":true}'));

    const first = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-model-404-a');
    expect(first.provider).toBe('ok-provider');
    expect(aiRouter.isProviderTemporarilySkipped('nvidia-model-404')).toBe(true);
    expect(aiRouter.isProviderAuthDisabled('nvidia-model-404')).toBe(false);

    const { tradingSafety } = await import('../config/tradingSafety');
    const snapshot = aiRouter.getProviderRoutingSnapshot().find((r) => r.providerId === 'nvidia-model-404')!;
    const cooldownRemainingMs = snapshot.skipUntil! - Date.now();
    // Must be the long (quota-exceeded-style) cooldown, not the short generic-unreachable one -
    // this is the whole point of the fix (a misconfigured model does not self-heal in 5 minutes).
    expect(cooldownRemainingMs).toBeGreaterThan(tradingSafety.aiProviderUnreachableCooldownMs);

    const second = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-model-404-b');
    expect(second.provider).toBe('ok-provider');
    expect(misconfigured.chat).toHaveBeenCalledTimes(1);
  });

  it('routeTask() gives a real "410 Gone" (the ACTUAL Friday 2026-08-28 NVIDIA failure - 676 occurrences that day alone, distinct from the 404 case above) the same LONG cooldown, not zero cooldown', async () => {
    const gone = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error('NVIDIA API error: 410 Gone - {"type":"about:blank","title":"Gone","status":410}'); }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('nvidia-410', gone);
    aiRouter.registerProvider('ok-provider', fastProvider('{"ok":true}'));

    const first = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-410-a');
    expect(first.provider).toBe('ok-provider');
    expect(aiRouter.isProviderTemporarilySkipped('nvidia-410')).toBe(true);
    expect(aiRouter.isProviderAuthDisabled('nvidia-410')).toBe(false);

    const { tradingSafety } = await import('../config/tradingSafety');
    const snapshot = aiRouter.getProviderRoutingSnapshot().find((r) => r.providerId === 'nvidia-410')!;
    const cooldownRemainingMs = snapshot.skipUntil! - Date.now();
    expect(cooldownRemainingMs).toBeGreaterThan(tradingSafety.aiProviderUnreachableCooldownMs);

    const second = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-410-b');
    expect(second.provider).toBe('ok-provider');
    expect(gone.chat).toHaveBeenCalledTimes(1);
  });

  it('routeTask() skips an account-suspended provider (real Kimi/Moonshot 429 phrasing) on the next call — real gap found in the 2026-08-26 forensic audit: this provider was previously re-dispatched to on every single call all session', async () => {
    const suspended = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => {
        throw new Error(
          'Kimi API error: 429 Too Many Requests - {"error":{"message":"Your account org-x <ak-y> is suspended due to insufficient balance, please recharge your account or check your plan and billing details","type":"exceeded_current_quota_error"}}',
        );
      }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('kimi-suspended', suspended);
    aiRouter.registerProvider('ok-provider', fastProvider('{"ok":true}'));

    const first = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-suspended-a');
    expect(first.provider).toBe('ok-provider');
    expect(suspended.chat).toHaveBeenCalledTimes(1);
    expect(aiRouter.isProviderTemporarilySkipped('kimi-suspended')).toBe(true);
    // Not the auth-disable path - this is a billing/quota issue, not an invalid credential.
    expect(aiRouter.isProviderAuthDisabled('kimi-suspended')).toBe(false);

    const second = await aiRouter.routeTask('TestAgent', 'prompt', 'trace-suspended-b');
    expect(second.provider).toBe('ok-provider');
    expect(suspended.chat).toHaveBeenCalledTimes(1);
  });

  it('routeTask() skips a rate-limited (429, no suspension wording) provider on the next call', async () => {
    const rateLimited = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error('429 Too Many Requests'); }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('rate-limited', rateLimited);
    aiRouter.registerProvider('ok-provider', fastProvider('{"ok":true}'));

    await aiRouter.routeTask('TestAgent', 'prompt', 'trace-rl-a');
    expect(aiRouter.isProviderTemporarilySkipped('rate-limited')).toBe(true);
    await aiRouter.routeTask('TestAgent', 'prompt', 'trace-rl-b');
    expect(rateLimited.chat).toHaveBeenCalledTimes(1);
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

  it('routeConsensus throws an honest unroutable message when providers are registered but all in auth cooldown', async () => {
    const authFailProvider = {
      authenticate: vi.fn(async () => true),
      chat: vi.fn(async () => { throw new Error('HTTP 401 Unauthorized'); }),
      estimateCost: vi.fn(() => 0),
    };
    aiRouter.registerProvider('only-auth-dead', authFailProvider);
    // Drive auth cooldown via the real routeTask path (same as production).
    await expect(aiRouter.routeTask('TestAgent', 'prompt', 'trace-auth-only')).rejects.toThrow(/All AI providers failed/);
    expect(aiRouter.isProviderAuthDisabled('only-auth-dead')).toBe(true);
    await expect(aiRouter.routeConsensus('ConsensusDebate', 'prompt', 'trace-honest')).rejects.toThrow(/misconfigured|unroutable|registered/);
  });
});

describe('AIRouter provider selection helpers (DEF-14/15)', () => {
  it('skips remote providers with no API key and keeps local ones', async () => {
    const { shouldSkipUnconfiguredProvider, selectConsensusProviders } = await import('./AIRouter');
    expect(shouldSkipUnconfiguredProvider({ apiKey: undefined, isLocal: false })).toBe(true);
    expect(shouldSkipUnconfiguredProvider({ apiKey: 'sk-test-realish-key', isLocal: false })).toBe(false);
    expect(shouldSkipUnconfiguredProvider({ apiKey: undefined, isLocal: true })).toBe(false);
    expect(selectConsensusProviders([['a', 1], ['b', 2], ['c', 3]] as [string, number][], 2).map(([id]) => id)).toEqual(['a', 'b']);
  });

  it('skips empty and placeholder API keys for remote providers (not local Ollama)', async () => {
    const { shouldSkipUnconfiguredProvider, isPlaceholderApiKey, describeConsensusProvidersUnavailable } = await import('./AIRouter');
    expect(isPlaceholderApiKey('')).toBe(true);
    expect(isPlaceholderApiKey('   ')).toBe(true);
    expect(isPlaceholderApiKey('CHANGE_ME')).toBe(true);
    expect(isPlaceholderApiKey('your_openai_api_key_here')).toBe(true);
    expect(isPlaceholderApiKey('sk-xxxxxxxx')).toBe(true);
    expect(isPlaceholderApiKey('placeholder')).toBe(true);
    expect(isPlaceholderApiKey('short')).toBe(true);
    expect(isPlaceholderApiKey('AIzaSyRealLookingGeminiKey123456')).toBe(false);

    expect(shouldSkipUnconfiguredProvider({ apiKey: '', isLocal: false })).toBe(true);
    expect(shouldSkipUnconfiguredProvider({ apiKey: 'your_deepseek_key_here', isLocal: false })).toBe(true);
    expect(shouldSkipUnconfiguredProvider({ apiKey: 'CHANGE_ME_generate', isLocal: false })).toBe(true);
    expect(shouldSkipUnconfiguredProvider({ apiKey: undefined, isLocal: true })).toBe(false);
    expect(shouldSkipUnconfiguredProvider({ apiKey: '', isLocal: true })).toBe(false);

    const zero = describeConsensusProvidersUnavailable({
      registeredCount: 0, skippedAuthCooldown: 0, skippedTemporary: 0, skippedDisabledInDb: 0,
    });
    expect(zero).toMatch(/No AI providers registered/);
    const misconfigured = describeConsensusProvidersUnavailable({
      registeredCount: 3, skippedAuthCooldown: 2, skippedTemporary: 1, skippedDisabledInDb: 0,
    });
    expect(misconfigured).toMatch(/misconfigured/);
    expect(misconfigured).not.toMatch(/^No AI Providers available for consensus$/);
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

  it('classifies 408/409/500/502/503/504 as unreachable too (Phase 9 Friday forensic audit, 2026-08-28: these previously matched no classifier, arming zero cooldown). 410 is deliberately NOT included here - it is classified as MODEL_UNAVAILABLE (long cooldown) earlier in noteProviderSkipFromError\'s chain, see the classifyError/routeTask tests below.', async () => {
    const { isUnreachableProviderError } = await import('./AIRouter');
    expect(isUnreachableProviderError(new Error('Request Timeout: 408'))).toBe(true);
    expect(isUnreachableProviderError(new Error('409 Conflict'))).toBe(true);
    expect(isUnreachableProviderError(new Error('OpenAI API error: 500 Internal Server Error'))).toBe(true);
    expect(isUnreachableProviderError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isUnreachableProviderError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isUnreachableProviderError(new Error('504 Gateway Timeout'))).toBe(true);
  });
});

// Real bug fix, found live: the "Claude" DB/UI display name had no env-var candidate at all -
// CLAUDE_API_KEY was never a real variable (Anthropic's own convention, and this repo's
// .env.example, is ANTHROPIC_API_KEY), so a provider row with no DB-stored key and a real
// ANTHROPIC_API_KEY set would still resolve to "not configured" rather than falling back to it.
describe('envKeyForProviderName - provider display name to env var mapping', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('resolves "Claude" to ANTHROPIC_API_KEY, not the non-existent CLAUDE_API_KEY', async () => {
    const { envKeyForProviderName } = await import('./AIRouter');
    delete process.env.CLAUDE_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-looking-key-1234567890';

    expect(envKeyForProviderName('Claude')).toBe('sk-ant-real-looking-key-1234567890');
  });

  it('resolves "Kimi" to MOONSHOT_API_KEY when set', async () => {
    const { envKeyForProviderName } = await import('./AIRouter');
    delete process.env.KIMI_API_KEY;
    process.env.MOONSHOT_API_KEY = 'sk-moonshot-real-looking-key-1234567890';

    expect(envKeyForProviderName('Kimi')).toBe('sk-moonshot-real-looking-key-1234567890');
  });

  it('still resolves via the direct KIMI_API_KEY match when MOONSHOT_API_KEY is not set', async () => {
    const { envKeyForProviderName } = await import('./AIRouter');
    delete process.env.MOONSHOT_API_KEY;
    process.env.KIMI_API_KEY = 'sk-kimi-direct-1234567890';

    expect(envKeyForProviderName('Kimi')).toBe('sk-kimi-direct-1234567890');
  });

  it('returns undefined for "Claude" when neither ANTHROPIC_API_KEY nor CLAUDE_API_KEY is set', async () => {
    const { envKeyForProviderName } = await import('./AIRouter');
    delete process.env.CLAUDE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    expect(envKeyForProviderName('Claude')).toBeUndefined();
  });
});

/**
 * OPS-1 (post-remediation audit) - real-DB, real-AIRouter coverage of the credential-precedence
 * fix: a stale/invalid DB-stored key must never be silently kept in place when a distinct, usable
 * .env credential exists. Real isolated temp SQLite DB + real AIRouter.initialize(), following the
 * same pattern as the timeout suite above; only the concrete provider class's authenticate()/chat()
 * are mocked (per-key behavior), never AIRouter's own credential-resolution logic.
 */
describe('AIRouter OPS-1: DB-vs-.env credential precedence and stale-DB fallback', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: any;
  let EncryptionService: any;
  let uuidv4: any;
  let aiRouter: any;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_airouter_ops1_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    // The Phase-1 describe block above already imported and closed a `../db` connection in this
    // same test file's module registry - dynamic import() would otherwise return that same,
    // now-closed, cached instance instead of opening a fresh one against our new tmpDbPath.
    vi.resetModules();
    ({ sqliteDb, db } = await import('../db'));
    schema = await import('../db/schema');
    ({ EncryptionService } = await import('../core/EncryptionService'));
    ({ v4: uuidv4 } = await import('uuid'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    process.env = { ...savedEnv };
  });

  beforeEach(async () => {
    const { AIRouter } = await import('./AIRouter');
    aiRouter = AIRouter.getInstance();
    aiRouter.clearProviders();
  });

  afterEach(async () => {
    process.env = { ...savedEnv, ARGUS_DB_PATH: tmpDbPath };
    vi.restoreAllMocks();
    try { await db.delete(schema.aiProviders); } catch { /* table may already be empty */ }
  });

  it('resolves credentialSource ENV when only .env is configured (no DB row credential)', async () => {
    process.env.OPENAI_API_KEY = 'sk-good-env-key-1234567890';
    const id = uuidv4();
    await db.insert(schema.aiProviders).values({ id, providerName: 'OpenAI', apiEndpoint: null, priority: 0, enabled: true });

    const { OpenAIProvider } = await import('./providers/OpenAIProvider');
    vi.spyOn(OpenAIProvider.prototype, 'authenticate').mockResolvedValue(true);
    vi.spyOn(OpenAIProvider.prototype, 'chat').mockResolvedValue({ content: 'OK', tokens: 1 } as any);

    await aiRouter.initialize();

    expect(aiRouter.getCredentialSource(id)).toBe('ENV');
    expect(aiRouter.listProviders().some(([pid]: [string, any]) => pid === id)).toBe(true);
  });

  it('prefers a working DB-stored credential over .env (does not fall back needlessly when DB auth succeeds)', async () => {
    process.env.OPENAI_API_KEY = 'sk-good-env-key-should-not-be-needed';
    const id = uuidv4();
    await db.insert(schema.aiProviders).values({
      id, providerName: 'OpenAI', apiEndpoint: null, priority: 0, enabled: true,
      apiKeyEncrypted: EncryptionService.encrypt('sk-good-db-key-1234567890'),
    });

    const { OpenAIProvider } = await import('./providers/OpenAIProvider');
    vi.spyOn(OpenAIProvider.prototype, 'authenticate').mockResolvedValue(true);
    vi.spyOn(OpenAIProvider.prototype, 'chat').mockResolvedValue({ content: 'OK', tokens: 1 } as any);

    await aiRouter.initialize();

    expect(aiRouter.getCredentialSource(id)).toBe('DB');
  });

  it('OPS-1 core fix: falls back to a distinct .env credential when the DB-stored credential fails auth, and records the source as ENV rather than silently staying on the stale DB key', async () => {
    process.env.OPENAI_API_KEY = 'sk-good-env-key-1234567890';
    const id = uuidv4();
    await db.insert(schema.aiProviders).values({
      id, providerName: 'OpenAI', apiEndpoint: null, priority: 0, enabled: true,
      apiKeyEncrypted: EncryptionService.encrypt('sk-stale-db-key-0000000000'),
    });

    const { OpenAIProvider } = await import('./providers/OpenAIProvider');
    vi.spyOn(OpenAIProvider.prototype, 'authenticate').mockImplementation(async function (this: any) {
      return this.apiKey === 'sk-good-env-key-1234567890';
    });
    vi.spyOn(OpenAIProvider.prototype, 'chat').mockResolvedValue({ content: 'OK', tokens: 1 } as any);

    await aiRouter.initialize();

    expect(aiRouter.getCredentialSource(id)).toBe('ENV');
    expect(aiRouter.listProviders().some(([pid]: [string, any]) => pid === id)).toBe(true);
    expect(aiRouter.isProviderAuthDisabled(id)).toBe(false);
  });

  it('disables the provider (fail-closed, never a fabricated success) when the DB credential fails auth and no distinct .env credential exists', async () => {
    delete process.env.OPENAI_API_KEY;
    const id = uuidv4();
    await db.insert(schema.aiProviders).values({
      id, providerName: 'OpenAI', apiEndpoint: null, priority: 0, enabled: true,
      apiKeyEncrypted: EncryptionService.encrypt('sk-stale-db-key-only-0000'),
    });

    const { OpenAIProvider } = await import('./providers/OpenAIProvider');
    vi.spyOn(OpenAIProvider.prototype, 'authenticate').mockResolvedValue(false);
    vi.spyOn(OpenAIProvider.prototype, 'chat').mockResolvedValue({ content: '', tokens: 0 } as any);

    await aiRouter.initialize();

    expect(aiRouter.getCredentialSource(id)).toBe('DB');
    expect(aiRouter.isProviderAuthDisabled(id)).toBe(true);
  });

  it('records NONE and never registers the provider when neither a DB credential nor a distinct .env credential exists', async () => {
    delete process.env.OPENAI_API_KEY;
    const id = uuidv4();
    await db.insert(schema.aiProviders).values({ id, providerName: 'OpenAI', apiEndpoint: null, priority: 0, enabled: true });

    await aiRouter.initialize();

    expect(aiRouter.getCredentialSource(id)).toBe('NONE');
    expect(aiRouter.listProviders().some(([pid]: [string, any]) => pid === id)).toBe(false);
  });

  it('never retries the .env fallback more than once per boot, even when the fallback itself also fails (no retry loop)', async () => {
    process.env.OPENAI_API_KEY = 'sk-also-bad-env-key-000000';
    const id = uuidv4();
    await db.insert(schema.aiProviders).values({
      id, providerName: 'OpenAI', apiEndpoint: null, priority: 0, enabled: true,
      apiKeyEncrypted: EncryptionService.encrypt('sk-stale-db-key-111111'),
    });

    const { OpenAIProvider } = await import('./providers/OpenAIProvider');
    const authenticateSpy = vi.spyOn(OpenAIProvider.prototype, 'authenticate').mockResolvedValue(false);
    vi.spyOn(OpenAIProvider.prototype, 'chat').mockResolvedValue({ content: '', tokens: 0 } as any);

    await aiRouter.initialize();

    // Exactly 2 authenticate() attempts this boot: one for the DB key, one for the .env fallback - never a loop.
    expect(authenticateSpy).toHaveBeenCalledTimes(2);
    expect(aiRouter.isProviderAuthDisabled(id)).toBe(true);
  });
});
