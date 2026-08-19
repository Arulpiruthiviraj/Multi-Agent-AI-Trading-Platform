import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real test coverage for the Phase 5 hardening fix: analysis.recommendation/confidence used to
// flow straight from JSON.parse() into a real TRADE_IDEA_GENERATED event with zero validation.
const { emitTradeIdea } = vi.hoisted(() => ({ emitTradeIdea: vi.fn() }));
const { routeTask } = vi.hoisted(() => ({ routeTask: vi.fn() }));
const { getFresh, setCache } = vi.hoisted(() => ({ getFresh: vi.fn(), setCache: vi.fn() }));

vi.mock('../core/EventBus', () => ({ eventBus: { emitTradeIdea } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));
vi.mock('../core/ideaUniverse', () => ({ resolveIdeaUniverse: () => ['NVDA', 'AAPL', 'TSLA'] }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeTask }) } }));
    vi.mock('./ExternalDataCache', () => ({
      ExternalDataCache: { getFresh, isRateLimited: vi.fn(async () => false), getStale: vi.fn(async () => null), set: setCache, markRateLimited: vi.fn() },
  looksLikeRateLimitResponse: () => false,
  hashObject: (data: any) => JSON.stringify(data),
}));

import { FundamentalAnalysisAgent } from './FundamentalAgent';

describe('FundamentalAnalysisAgent - AI output validation (Phase 5 hardening)', () => {
  let agent: any;

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    // getFresh is now called twice per analyzeFundamentals(): once for the raw-fundamentals
    // cache, once for the Phase 7 AI-analysis cache - branch on `dataType` (2nd arg) so these
    // tests always take the real routeTask() call path (an AI-analysis cache hit would skip it
    // entirely, which is exercised separately in the Phase 7 describe block below).
    getFresh.mockImplementation(async (_provider: string, dataType: string) => {
      if (dataType === 'fundamentals') return { peRatio: '25.4', epsGrowth: '12', debtToEquity: '0.8' };
      return null;
    });
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    agent = new FundamentalAnalysisAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('coerces an off-schema recommendation to HOLD instead of passing it through as an invalid side', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'STRONG_BUY', confidence: 80, reasoning: 'real reasoning' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.agent).toBe('FundamentalAgent');
  });

  it('normalizes a 0-100-scale confidence answer down to the real 0-1 TRADE_IDEA_GENERATED convention', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'buy', confidence: 85, reasoning: 'strong fundamentals' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY'); // case-insensitive match, uppercased
    expect(idea.confidence).toBeCloseTo(0.85);
  });

  it('passes through a well-formed, already-0-1-scale response unchanged', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'SELL', confidence: 0.72, reasoning: 'weak margins' }), aiCallId: 'c3', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('SELL');
    expect(idea.confidence).toBeCloseTo(0.72);
    expect(idea.reasoning).toContain('weak margins');
  });

  it('falls back to a safe default reasoning string when the AI omits it', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.9 }), aiCallId: 'c4', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.reasoning).toContain('No reasoning provided.');
  });
});

describe('FundamentalAnalysisAgent - AI response caching (Phase 7 hardening)', () => {
  let agent: any;
  const fundamentals = { peRatio: '25.4', epsGrowth: '12', debtToEquity: '0.8' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    setCache.mockClear();
    getFresh.mockReset();
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    agent = new FundamentalAnalysisAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('on a cache miss, calls the real AI once and caches the validated analysis - the real cost-saving fix', async () => {
    getFresh.mockImplementation(async (_p: string, dataType: string) =>
      dataType === 'fundamentals' ? fundamentals : null // AI-analysis cache miss
    );
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.8, reasoning: 'strong growth' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    expect(routeTask).toHaveBeenCalledTimes(1);
    expect(setCache).toHaveBeenCalledTimes(1);
    const [cacheProvider, cacheDataType, cacheSymbol, cachedPayload] = setCache.mock.calls[0];
    expect(cacheProvider).toBe('ai-cache');
    expect(cacheDataType).toContain('FundamentalAgent'); // agent identity is part of the key
    expect(cachedPayload).toEqual({ recommendation: 'BUY', confidence: 0.8, reasoning: 'strong growth' }); // already-validated, ready to replay
  });

  it('the exact bug this closes: a cache HIT skips the real (paid) AI call entirely', async () => {
    const cachedAnalysis = { recommendation: 'SELL', confidence: 0.6, reasoning: 'cached weak outlook' };
    getFresh.mockImplementation(async (_p: string, dataType: string) =>
      dataType === 'fundamentals' ? fundamentals : cachedAnalysis // AI-analysis cache HIT
    );

    await agent.analyzeFundamentals();

    expect(routeTask).not.toHaveBeenCalled(); // no real, paid AI call happened
    expect(setCache).not.toHaveBeenCalled(); // nothing new to cache - it was already cached
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('SELL');
    expect(idea.confidence).toBe(0.6);
    expect(idea.reasoning).toContain('cached weak outlook');
    expect(idea.aiCallId).toBeUndefined(); // never fabricates a reference to an AI call that didn't happen
  });

  it('different underlying data produces a different cache key, so a real data change always gets a fresh AI call', async () => {
    // Always a miss for the AI-analysis cache in this test (asserting on the key requested, not
    // hit/miss behavior); the raw-fundamentals cache must stay a HIT so the real fetch() path
    // (unmocked here) is never reached.
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'fundamentals' ? fundamentals : null));
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'HOLD', confidence: 0.5, reasoning: 'n/a' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();
    const firstKey = getFresh.mock.calls.find((c: any) => c[0] === 'ai-cache')![1];

    getFresh.mockClear();
    // Force a materially different underlying data snapshot for the next cycle.
    getFresh.mockImplementation(async (_p: string, dataType: string) =>
      dataType === 'fundamentals' ? { peRatio: '99.9', epsGrowth: '12', debtToEquity: '0.8' } : null
    );
    await agent.analyzeFundamentals();
    const secondKey = getFresh.mock.calls.find((c: any) => c[0] === 'ai-cache')![1];

    expect(firstKey).not.toBe(secondKey);
  });
});

describe('FundamentalAnalysisAgent - secret leakage (Phase 8 hardening)', () => {
  let agent: any;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getFresh.mockReset();
    getFresh.mockResolvedValue(null); // force the real fetchFundamentals() AlphaVantage call path
    process.env.ALPHAVANTAGE_API_KEY = 'av-real-secret-77777';
    delete process.env.GEMINI_API_KEY;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    agent = new FundamentalAnalysisAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    fetchSpy?.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('never logs the real AlphaVantage API key when a caught fetch error message includes the request URL', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(
      new Error('fetch failed: https://www.alphavantage.co/query?function=OVERVIEW&symbol=NVDA&apikey=av-real-secret-77777')
    );

    await agent.analyzeFundamentals();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedCalls = consoleErrorSpy.mock.calls.map(c => String(c[1] ?? c[0]));
    for (const text of loggedCalls) expect(text).not.toContain('av-real-secret-77777');
  });
});

// Phase 11 (ARGUS_FAILURE_RECOVERY_REPORT.md) - chaos scenario: every real AI provider is
// unavailable (AIRouter.routeTask() exhausts its own real failover loop and throws). The real,
// desired behavior per this phase's own stated principle ("WHEN UNCERTAIN -> DO NOT OPEN A NEW
// POSITION"): no trade idea is ever emitted, and the agent does not crash the process.
describe('FundamentalAnalysisAgent - all AI providers unavailable (Phase 11 chaos)', () => {
  let agent: any;

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockReset();
    getFresh.mockReset();
    getFresh.mockImplementation(async (_provider: string, dataType: string) => {
      if (dataType === 'fundamentals') return { peRatio: '25.4', epsGrowth: '12', debtToEquity: '0.8' };
      return null;
    });
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    agent = new FundamentalAnalysisAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('emits HOLD DATA_UNAVAILABLE and does not throw when every real AI provider has failed', async () => {
    routeTask.mockRejectedValue(new Error('All AI providers failed for task FundamentalAgent. Last error: AI provider did not respond within 20000ms'));

    await expect(agent.analyzeFundamentals()).resolves.not.toThrow();
    expect(emitTradeIdea).toHaveBeenCalled();
    expect(emitTradeIdea.mock.calls[0][0].side).toBe('HOLD');
    expect(emitTradeIdea.mock.calls[0][0].reasoning).toMatch(/DATA_UNAVAILABLE/);
  });

  it('a second tick still runs after the previous tick threw', async () => {
    routeTask
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.8, reasoning: 'recovered' }), aiCallId: 'c-ok', provider: 'gemini', latency: 10 });
    await agent.analyzeFundamentals();
    emitTradeIdea.mockClear();
    await agent.analyzeFundamentals();
    expect(emitTradeIdea).toHaveBeenCalled();
    expect(emitTradeIdea.mock.calls[0][0].side).toBe('BUY');
  });
});
