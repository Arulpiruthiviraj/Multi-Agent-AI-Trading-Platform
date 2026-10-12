import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 2026-10-12 (coverage #18): FundamentalAgent's raw fetch() calls had no timeout - a stalled
 * provider hung the agent interval loop forever. Every raw fetch now goes through the
 * module's AbortSignal-based fetchWithTimeout (same pattern as AIRouter.withTimeout, same
 * default aiModels.researchTimeoutMs). These tests drive the agent's real FMP fetch path:
 * a never-resolving fetch must abort within the timeout (fail-closed to null), and a healthy
 * fetch must still resolve normally.
 */
const { emit } = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('../core/EventBus', () => ({ eventBus: { emit, emitTradeIdea: vi.fn() } }));
vi.mock('../core/waitForFreshMarketData', () => ({
  waitForFreshMarketData: vi.fn(async () => ({ ok: true, price: 100, alreadyFresh: true })),
}));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));
vi.mock('../core/ideaUniverse', () => ({ resolveIdeaUniverse: () => ['NVDA'] }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({}) } }));
vi.mock('./MarketDataWorker', () => ({ marketDataWorker: {} }));
vi.mock('./ExternalDataCache', () => ({
  ExternalDataCache: {
    getFresh: vi.fn(async () => null),
    isRateLimited: vi.fn(async () => false),
    getStale: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    markRateLimited: vi.fn(async () => {}),
  },
  looksLikeRateLimitResponse: () => false,
  hashObject: (data: any) => JSON.stringify(data),
}));
vi.mock('./FmpBudget', () => ({ FmpBudget: { tryConsume: vi.fn(async () => true) } }));

import { FundamentalAnalysisAgent } from './FundamentalAgent';
import { aiModels } from '../config/aiModels';

describe('FundamentalAgent fetch timeout (coverage #18)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.FMP_API_KEY;
  });

  it('aborts a stalled FMP fetch within the timeout instead of hanging the agent loop', async () => {
    process.env.FMP_API_KEY = 'test-fmp-key';
    const seenSignals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      seenSignals.push(init?.signal);
      return new Promise<Response>(() => {}); // never resolves - stalled provider
    }));

    const agent = new FundamentalAnalysisAgent();
    const pending = (agent as any).tryFmpFallback('NVDA');

    // Just under the configured default: no abort yet.
    await vi.advanceTimersByTimeAsync(aiModels.researchTimeoutMs - 1);
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]!.aborted).toBe(false);

    // At the deadline the fetch aborts; tryFmpFallback catches and fails closed to null
    // (the caller falls through to the honest RATE_LIMITED/UNKNOWN HOLD).
    await vi.advanceTimersByTimeAsync(1);
    expect(seenSignals[0]!.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
  });

  it('a healthy FMP fetch still resolves normally (the timeout does not break the happy path)', async () => {
    vi.useRealTimers();
    process.env.FMP_API_KEY = 'test-fmp-key';
    vi.stubGlobal('fetch', vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/ratios-ttm/')) {
        return { ok: true, json: async () => [{ peRatioTTM: 31.2, debtEquityRatioTTM: 1.1 }] } as any;
      }
      if (u.includes('/income-statement-growth/')) {
        return { ok: true, json: async () => [{ growthEPS: 0.18 }] } as any;
      }
      throw new Error(`unexpected fetch URL in test: ${u}`);
    }));

    const agent = new FundamentalAnalysisAgent();
    const result = await (agent as any).tryFmpFallback('NVDA');

    expect(result).toMatchObject({ peRatio: 31.2, epsGrowth: '0.18', debtToEquity: 1.1 });
  });

  it('a network-level fetch rejection still fails closed to null', async () => {
    vi.useRealTimers();
    process.env.FMP_API_KEY = 'test-fmp-key';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));

    const agent = new FundamentalAnalysisAgent();
    await expect((agent as any).tryFmpFallback('NVDA')).resolves.toBeNull();
  });
});
