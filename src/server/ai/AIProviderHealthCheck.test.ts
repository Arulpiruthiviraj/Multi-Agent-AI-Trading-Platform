import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Real coverage for the Zero-Trade Forensic Audit follow-up: distinguishing "Configured" from
 * "Authenticated" per the operator's own design, classifying failures into a named status instead
 * of a generic error, and proving a raw API key never appears anywhere in the resulting snapshot.
 */
const { dbRows } = vi.hoisted(() => ({ dbRows: { current: [] as any[] } }));
const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn() }));

vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => Promise.resolve(dbRows.current) }),
  },
}));
vi.mock('../core/EncryptionService', () => ({ EncryptionService: { decrypt } }));

import { AIRouter } from './AIRouter';
import type { AIProvider } from './providers/AIProvider';
import {
  checkProviderHealth,
  getAIProviderHealthSnapshot,
  runAIProviderHealthCheckNow,
  resetAIProviderHealthTrackerForTests,
} from './AIProviderHealthCheck';

function fakeProvider(overrides: Partial<AIProvider> = {}): AIProvider {
  return {
    initialize: async () => {},
    authenticate: async () => true,
    chat: async () => ({ content: 'OK', tokens: 2, inputTokens: 1, outputTokens: 1 }),
    stream: (async function* () { yield ''; })(),
    embeddings: async () => [],
    vision: async () => ({ content: '', tokens: 0 }),
    image: async () => Buffer.from(''),
    health: async () => 'Healthy',
    estimateCost: () => 0,
    estimateLatency: () => 100,
    supportsTools: () => false,
    supportsReasoning: () => false,
    supportsVision: () => false,
    supportsStructuredOutput: () => false,
    supportsStreaming: () => false,
    ...overrides,
  } as AIProvider;
}

function dbRow(overrides: Partial<any> = {}) {
  return {
    id: 'p1',
    providerName: 'Gemini',
    apiEndpoint: null,
    apiKeyEncrypted: 'enc-real-secret-key-value',
    defaultModel: 'gemini-2.5-pro',
    enabled: true,
    lastSuccess: null,
    lastFailure: null,
    ...overrides,
  };
}

describe('AIProviderHealthCheck', () => {
  beforeEach(() => {
    AIRouter.getInstance().clearProviders();
    resetAIProviderHealthTrackerForTests();
    decrypt.mockReset().mockReturnValue('real-secret-key-value-1234');
    dbRows.current = [];
  });

  it('classifies a real success as HEALTHY and records latency', async () => {
    const provider = fakeProvider();
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    const rec = snapshot.find(r => r.providerId === 'p1')!;
    expect(rec.status).toBe('HEALTHY');
    expect(rec.authenticated).toBe(true);
    expect(rec.latencyMs).toBeGreaterThanOrEqual(0);
    expect(rec.consecutiveFailures).toBe(0);
  });

  it('classifies authenticate() returning false as AUTH_FAILED - Configured must not imply Authenticated', async () => {
    const provider = fakeProvider({ authenticate: async () => false });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    const rec = snapshot.find(r => r.providerId === 'p1')!;
    expect(rec.configured).toBe(true);
    expect(rec.status).toBe('AUTH_FAILED');
    expect(rec.authenticated).toBe(false);
  });

  it('classifies a 402/quota error as QUOTA_EXCEEDED, distinct from AUTH_FAILED', async () => {
    const provider = fakeProvider({ chat: async () => { throw new Error('OpenRouter (Free Tier) API error: 402 Payment Required'); } });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('QUOTA_EXCEEDED');
  });

  it('classifies a 401 error as AUTH_FAILED, distinct from QUOTA_EXCEEDED', async () => {
    const provider = fakeProvider({ chat: async () => { throw new Error('Claude API error: 401 Unauthorized'); } });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('AUTH_FAILED');
  });

  it('classifies a suspended-account error as ACCOUNT_SUSPENDED, not RATE_LIMITED or QUOTA_EXCEEDED (2026-08-24 readiness audit, Part 5 - real Moonshot/Kimi response)', async () => {
    const provider = fakeProvider({ chat: async () => { throw new Error('Kimi API error: 429 Too Many Requests - {"error":{"message":"Your account org-33aebcddc6224bd5815d2b2e8026966e <ak-fbuxx63a44oi11bpe981> is suspended due to insufficient balance, please recharge your account or check your plan and billing details","type":"exceeded_current_quota_error"}}'); } });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('ACCOUNT_SUSPENDED');
  });

  it('classifies a suspended-account error as ACCOUNT_SUSPENDED even when the same message carries a 401 status (2026-08-25 fix - the actual root cause of the reported 401-vs-429 Kimi discrepancy)', async () => {
    // isAuthFailureError()'s own `\b401\b` pattern matches the raw status code embedded in this
    // exact message shape (providers construct errors as `${status} ${statusText}${bodySnippet}`)
    // - before the 2026-08-25 fix, this was classified AUTH_FAILED instead of ACCOUNT_SUSPENDED
    // purely because Moonshot happened to attach a 401 to this particular response instead of the
    // 429 the test above uses for the identical underlying condition (suspended account).
    const provider = fakeProvider({ chat: async () => { throw new Error('Kimi API error: 401 Unauthorized - {"error":{"message":"Your account org-33aebcddc6224bd5815d2b2e8026966e <ak-fbuxx63a44oi11bpe981> is suspended due to insufficient balance, please recharge your account or check your plan and billing details","type":"exceeded_current_quota_error"}}'); } });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('ACCOUNT_SUSPENDED');
  });

  it('classifies an ordinary 401 with no suspension language as AUTH_FAILED, not ACCOUNT_SUSPENDED (no regression)', async () => {
    const provider = fakeProvider({ chat: async () => { throw new Error('OpenAI API error: 401 Unauthorized - {"error":{"message":"Incorrect API key provided"}}'); } });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('AUTH_FAILED');
  });

  it('classifies an ordinary 429 with no suspension language as RATE_LIMITED, not ACCOUNT_SUSPENDED', async () => {
    const provider = fakeProvider({ chat: async () => { throw new Error('OpenRouter API error: 429 Too Many Requests'); } });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('RATE_LIMITED');
  });

  it('classifies "fetch failed" as PROVIDER_UNAVAILABLE', async () => {
    const provider = fakeProvider({ chat: async () => { throw new Error('fetch failed'); } });
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('PROVIDER_UNAVAILABLE');
  });

  it('increments consecutiveFailures across repeated failures and resets to 0 on the next success', async () => {
    const failing = fakeProvider({ chat: async () => { throw new Error('401 Unauthorized'); } });
    AIRouter.getInstance().registerProvider('p1', failing);
    dbRows.current = [dbRow()];

    await checkProviderHealth('p1', failing);
    await checkProviderHealth('p1', failing);
    let snapshot = await getAIProviderHealthSnapshot();
    expect(snapshot.find(r => r.providerId === 'p1')!.consecutiveFailures).toBe(2);

    const healthy = fakeProvider();
    await checkProviderHealth('p1', healthy);
    snapshot = await getAIProviderHealthSnapshot();
    expect(snapshot.find(r => r.providerId === 'p1')!.consecutiveFailures).toBe(0);
    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('HEALTHY');
  });

  it('reports CONFIG_MISSING for a DB-known provider with no usable credential and no local endpoint - never treated as HEALTHY by default', async () => {
    decrypt.mockReturnValue('changeme'); // placeholder, same as a fresh Setup Wizard default
    dbRows.current = [dbRow({ id: 'p2', providerName: 'OpenAI', apiKeyEncrypted: 'enc-placeholder' })];
    // Not registered - AIRouter never constructed a live provider instance for it.

    const snapshot = await getAIProviderHealthSnapshot();
    const rec = snapshot.find(r => r.providerId === 'p2')!;
    expect(rec.configured).toBe(false);
    expect(rec.status).toBe('CONFIG_MISSING');
    expect(rec.registered).toBe(false);
  });

  it('reports PROVIDER_UNAVAILABLE (not CONFIG_MISSING) when a credential exists but the provider never registered', async () => {
    dbRows.current = [dbRow({ id: 'p3', providerName: 'Mistral' })];
    // decrypt returns a real-looking key (beforeEach default) but nothing calls registerProvider.

    const snapshot = await getAIProviderHealthSnapshot();
    const rec = snapshot.find(r => r.providerId === 'p3')!;
    expect(rec.configured).toBe(true);
    expect(rec.status).toBe('PROVIDER_UNAVAILABLE');
  });

  it('never exposes the raw API key anywhere in the snapshot', async () => {
    const provider = fakeProvider();
    AIRouter.getInstance().registerProvider('p1', provider);
    dbRows.current = [dbRow({ apiKeyEncrypted: 'enc-value' })];
    decrypt.mockReturnValue('sk-real-secret-do-not-leak-9999');

    await checkProviderHealth('p1', provider);
    const snapshot = await getAIProviderHealthSnapshot();

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('sk-real-secret-do-not-leak-9999');
  });

  it('runAIProviderHealthCheckNow(providerId) runs only the requested provider, leaving others untouched', async () => {
    const target = fakeProvider();
    const other = fakeProvider({ chat: async () => { throw new Error('should not be called'); } });
    AIRouter.getInstance().registerProvider('p1', target);
    AIRouter.getInstance().registerProvider('p2', other);
    dbRows.current = [dbRow({ id: 'p1' }), dbRow({ id: 'p2', providerName: 'OpenAI' })];

    const snapshot = await runAIProviderHealthCheckNow('p1');

    expect(snapshot.find(r => r.providerId === 'p1')!.status).toBe('HEALTHY');
    // p2 was never checked this call - still UNKNOWN (configured+registered, no check run yet).
    expect(snapshot.find(r => r.providerId === 'p2')!.status).toBe('UNKNOWN');
  });
});
