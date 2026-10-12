import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 2026-10-12 (coverage #18): MacroAgent's raw fetch() calls had no timeout - a stalled
 * provider hung the agent interval loop forever. Every raw fetch now goes through the
 * module's AbortSignal-based fetchWithTimeout (same pattern as AIRouter.withTimeout, same
 * default aiModels.researchTimeoutMs). These tests drive the agent's real FRED fetch path:
 * a never-resolving fetch must abort within the timeout, and a healthy fetch must still
 * resolve normally.
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
vi.mock('./FinceptCacheAdapter', () => ({
  getFinceptMacroSnapshot: vi.fn(async () => null),
  formatFinceptMacroSnapshotForPrompt: vi.fn(() => ''),
}));
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

import { MacroEconomyAgent } from './MacroAgent';
import { aiModels } from '../config/aiModels';

describe('MacroAgent fetch timeout (coverage #18)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete process.env.FRED_API_KEY;
  });

  it('aborts a stalled FRED fetch within the timeout instead of hanging the agent loop', async () => {
    process.env.FRED_API_KEY = 'test-fred-key';
    const seenSignals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      seenSignals.push(init?.signal);
      return new Promise<Response>(() => {}); // never resolves - stalled provider
    }));

    const agent = new MacroEconomyAgent();
    const pending = (agent as any).fetchFredSeries('CPIAUCSL', 13);
    // Attach the rejection expectation BEFORE advancing the clock, so the timeout
    // rejection (fired by the fake timer below) is never momentarily unhandled.
    const rejection = expect(pending).rejects.toThrow(/did not respond within/);

    // Just under the configured default: no abort yet.
    await vi.advanceTimersByTimeAsync(aiModels.researchTimeoutMs - 1);
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]!.aborted).toBe(false);

    // At the deadline the fetch aborts with the timeout error (the caller,
    // tryFredFallback, catches it and fails closed per field).
    await vi.advanceTimersByTimeAsync(1);
    expect(seenSignals[0]!.aborted).toBe(true);
    await rejection;
  });

  it('a healthy FRED fetch still resolves normally (the timeout does not break the happy path)', async () => {
    vi.useRealTimers();
    process.env.FRED_API_KEY = 'test-fred-key';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ observations: [{ date: '2026-09-01', value: '3.1' }] }),
    } as any)));

    const agent = new MacroEconomyAgent();
    const rows = await (agent as any).fetchFredSeries('CPIAUCSL', 13);

    expect(rows).toEqual([{ date: '2026-09-01', value: 3.1 }]);
  });
});
