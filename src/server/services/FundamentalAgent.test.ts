import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real test coverage for the Phase 5 hardening fix: analysis.recommendation/confidence used to
// flow straight from JSON.parse() into a real TRADE_IDEA_GENERATED event with zero validation.
const { emitTradeIdea, emit } = vi.hoisted(() => ({ emitTradeIdea: vi.fn(), emit: vi.fn() }));
const { routeTask } = vi.hoisted(() => ({ routeTask: vi.fn() }));
const { getFresh, setCache } = vi.hoisted(() => ({ getFresh: vi.fn(), setCache: vi.fn() }));
const { getLatestPrice, subscribe, getLatestPriceAgeMs } = vi.hoisted(() => ({
  getLatestPrice: vi.fn(),
  subscribe: vi.fn(),
  // Phase 7F: agentRoundRobin's fresh-symbol filter reads this - default to "fresh" (age 0) so
  // these pre-existing tests keep exercising the full universe exactly as before this change.
  getLatestPriceAgeMs: vi.fn((_s: string) => 0),
}));

vi.mock('../core/EventBus', () => ({ eventBus: { emitTradeIdea, emit } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));
vi.mock('../core/ideaUniverse', () => ({ resolveIdeaUniverse: () => ['NVDA', 'AAPL', 'TSLA'] }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeTask }) } }));
vi.mock('./MarketDataWorker', () => ({ marketDataWorker: { getLatestPrice, subscribe, getLatestPriceAgeMs } }));
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

// Zero-Trade Forensic Audit fix: FundamentalAgent never attached currentPrice, so gateTradeIdea
// (tradeIdeaContract.ts, its own MISSING_PRICE coverage lives in tradeIdeaContract.test.ts) had to
// rely entirely on its separate lookupLivePrice fallback - which frequently missed for symbols
// outside the actively-streamed core set (219 real MISSING_PRICE rejections observed live).
describe('FundamentalAnalysisAgent - currentPrice attachment (zero-trade audit fix)', () => {
  let agent: any;

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getLatestPrice.mockReset();
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

  it('a BUY idea carries the real live currentPrice from MarketDataWorker, reaching the contract with a valid price', async () => {
    getLatestPrice.mockReturnValue(187.42);
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.8, reasoning: 'strong growth' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.currentPrice).toBe(187.42);
  });

  it('a SELL idea carries the real live currentPrice from MarketDataWorker, reaching the contract with a valid price', async () => {
    getLatestPrice.mockReturnValue(412.9);
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'SELL', confidence: 0.65, reasoning: 'weak margins' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('SELL');
    expect(idea.currentPrice).toBe(412.9);
  });

  it('never invents a price - when MarketDataWorker has no live tick for this symbol, currentPrice is left undefined rather than fabricated', async () => {
    getLatestPrice.mockReturnValue(null);
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.8, reasoning: 'strong growth' }), aiCallId: 'c3', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.currentPrice).toBeUndefined();
    // The real, unmocked gateTradeIdea (src/server/core/tradeIdeaContract.ts) is what actually
    // fails this closed as MISSING_PRICE - covered directly (not re-mocked here) in
    // tradeIdeaContract.test.ts's "rejects a listed ticker with no live price" cases. This test
    // only proves FundamentalAgent's own contribution: it must not paper over a missing price.
  });

  it('attaches currentPrice on every emit path, including the DATA_UNAVAILABLE HOLD when fundamentals providers are not configured', async () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    getLatestPrice.mockReturnValue(99.5);
    agent = new FundamentalAnalysisAgent();

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.currentPrice).toBe(99.5);
  });
});

describe('FundamentalAnalysisAgent - Phase 7F round-robin fix (prioritize symbols with fresh ticks)', () => {
  let agent: any;

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockResolvedValue(null);
    getLatestPrice.mockReturnValue(100);
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'x' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
    agent = new FundamentalAnalysisAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('selects only from symbols with a fresh tick when exactly one qualifies, instead of blindly cycling the full universe', async () => {
    // Universe (mocked above) is ['NVDA', 'AAPL', 'TSLA'] - make only AAPL "fresh".
    getLatestPriceAgeMs.mockImplementation((s: string) => (s === 'AAPL' ? 0 : 999999));

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.symbol).toBe('AAPL');
  });

  it('falls back to the full universe when nothing currently has a fresh tick (preserves prior behavior)', async () => {
    getLatestPriceAgeMs.mockReturnValue(999999);

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(['NVDA', 'AAPL', 'TSLA']).toContain(idea.symbol);
  });
});

describe('FundamentalAnalysisAgent - Phase 9 same-candidate convergence (prioritize a recent real candidate)', () => {
  let agent: any;

  beforeEach(async () => {
    const { resetRecentCandidatesForTests } = await import('../core/recentCandidateRegistry');
    resetRecentCandidatesForTests();
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockResolvedValue(null);
    getLatestPrice.mockReturnValue(100);
    getLatestPriceAgeMs.mockReturnValue(0); // all three symbols fresh
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'x' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
    agent = new FundamentalAnalysisAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('prefers a recently-recorded real candidate over the generic fresh-symbol pool when both are fresh', async () => {
    const { recordCandidate } = await import('../core/recentCandidateRegistry');
    recordCandidate('TSLA');

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.symbol).toBe('TSLA');
  });

  it('falls back to the plain fresh-symbol pool when the recorded candidate is not part of the universe/is stale', async () => {
    const { recordCandidate } = await import('../core/recentCandidateRegistry');
    recordCandidate('ZZZZ', Date.now() - 10 * 60 * 1000); // outside recentCandidatePriorityMaxAgeMs

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(['NVDA', 'AAPL', 'TSLA']).toContain(idea.symbol);
  });
});

describe('FundamentalAnalysisAgent - evaluateSymbol() on-demand entry point (Phase 9 same-candidate convergence)', () => {
  let agent: any;
  const fundamentals = { peRatio: '28.4', epsGrowth: '0.12', debtToEquity: '0.5' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    // Real fundamentals cache HIT (same pattern as the Phase 7 caching describe block above) -
    // avoids a real AlphaVantage network call; only the AI-analysis cache is a miss.
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'fundamentals' ? fundamentals : null));
    getLatestPrice.mockReturnValue(250);
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.72, reasoning: 'on-demand real fixture' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
    agent = new FundamentalAnalysisAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('evaluates the EXACT symbol it is given, bypassing the round-robin entirely - this is what ConfluenceCoordinator now calls', async () => {
    await agent.evaluateSymbol('NVDA');

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.symbol).toBe('NVDA');
    expect(idea.agent).toBe('FundamentalAgent');
    expect(idea.side).toBe('BUY');
  });

  it('still fails closed (no fabricated vote) when the real AlphaVantage budget is exhausted, even on-demand', async () => {
    getFresh.mockResolvedValue(null); // force a cache MISS so the real budget check is actually reached; ExternalDataCache.getStale defaults to null (mocked at file top)
    const { AlphaVantageBudget } = await import('./AlphaVantageBudget');
    const spy = vi.spyOn(AlphaVantageBudget, 'tryConsume').mockResolvedValue(false);

    await agent.evaluateSymbol('MSFT');

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.reasoning).toContain('DATA_UNAVAILABLE');
    spy.mockRestore();
  });
});
