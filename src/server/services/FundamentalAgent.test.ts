import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real test coverage for the Phase 5 hardening fix: analysis.recommendation/confidence used to
// flow straight from JSON.parse() into a real TRADE_IDEA_GENERATED event with zero validation.
const { emitTradeIdea, emit } = vi.hoisted(() => ({ emitTradeIdea: vi.fn(), emit: vi.fn() }));
const { routeTask, hasAnyRoutableProvider } = vi.hoisted(() => ({
  routeTask: vi.fn(),
  // Default implementation preserves every pre-existing test's behavior (they toggle
  // process.env.GEMINI_API_KEY to control this exact branch) - see the vi.mock('../ai/AIRouter', ...)
  // comment below. A dedicated regression test overrides this per-call via mockResolvedValueOnce to
  // prove the actual 2026-09-07 bug fix: this is no longer tied to GEMINI_API_KEY specifically.
  hasAnyRoutableProvider: vi.fn(() => Promise.resolve(!!process.env.GEMINI_API_KEY)),
}));
const { getFresh, setCache } = vi.hoisted(() => ({ getFresh: vi.fn(), setCache: vi.fn() }));
const { getLatestPrice, subscribe, getLatestPriceAgeMs } = vi.hoisted(() => ({
  getLatestPrice: vi.fn(() => 100),
  subscribe: vi.fn(),
  // Phase 7F: agentRoundRobin's fresh-symbol filter reads this - default to "fresh" (age 0) so
  // these pre-existing tests keep exercising the full universe exactly as before this change.
  getLatestPriceAgeMs: vi.fn((_s: string) => 0),
}));
// 2026-09-06 MISSING_PRICE remediation: evaluateSymbol() now genuinely gates on a fresh price via
// waitForFreshMarketData() before proceeding. Mocked directly (not the real module) rather than
// mocking two levels down at requestTemporaryDataRescue/getLatestPrice - the real module's
// internal inFlight dedup Map is process-wide, module-scoped state that leaked across tests when
// this was tried at that lower level (confirmed live: a resolved-but-not-yet-deleted promise for a
// symbol two round-robin-adjacent tests both happened to pick caused one test to silently reuse
// another test's mocked denial). Mocking this function directly sidesteps that shared-state class
// of problem entirely. Defaults to a fresh price so every pre-existing test that doesn't care about
// price keeps working exactly as before this change; a test that specifically cares overrides it.
const { waitForFreshMarketData } = vi.hoisted(() => ({
  waitForFreshMarketData: vi.fn(async (): Promise<{ ok: true; price: number; alreadyFresh: boolean } | { ok: false; reason: string; deniedReason?: string; detail?: string }> => ({ ok: true, price: 100, alreadyFresh: true })),
}));

vi.mock('../core/EventBus', () => ({ eventBus: { emitTradeIdea, emit } }));
vi.mock('../core/waitForFreshMarketData', () => ({ waitForFreshMarketData }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));
vi.mock('../core/ideaUniverse', () => ({ resolveIdeaUniverse: () => ['NVDA', 'AAPL', 'TSLA'] }));
// hasAnyRoutableProvider() replaced the old `process.env.GEMINI_API_KEY` gate (2026-09-07 fix -
// see FundamentalAgent.ts's comment at the call site). Reusing the same per-test GEMINI_API_KEY
// set/delete calls below as the mock's own signal keeps every existing test's intent unchanged
// without rewriting each call site individually.
vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({ routeTask, hasAnyRoutableProvider }) },
}));
vi.mock('./MarketDataWorker', () => ({ marketDataWorker: { getLatestPrice, subscribe, getLatestPriceAgeMs } }));
    vi.mock('./ExternalDataCache', () => ({
      ExternalDataCache: { getFresh, isRateLimited: vi.fn(async () => false), getStale: vi.fn(async () => null), set: setCache, markRateLimited: vi.fn() },
  looksLikeRateLimitResponse: () => false,
  hashObject: (data: any) => JSON.stringify(data),
}));

import { FundamentalAnalysisAgent } from './FundamentalAgent';

// 2026-09-06 MISSING_PRICE remediation - see MacroAgent.test.ts's identical file-wide beforeEach
// for the full rationale (evaluateSymbol() now genuinely gates on a fresh price before doing
// anything else; this guarantees every test in this file starts from a known-good default).
beforeEach(() => {
  getLatestPrice.mockReset();
  getLatestPrice.mockImplementation(() => 100);
  getLatestPriceAgeMs.mockReset();
  getLatestPriceAgeMs.mockImplementation(() => 0);
  waitForFreshMarketData.mockReset();
  waitForFreshMarketData.mockImplementation(async () => ({ ok: true, price: 100, alreadyFresh: true }));
  // 2026-09-10 FMP fallback addition: isolate every pre-existing test from a real FMP_API_KEY that
  // may be set in the developer's own .env (dotenv.config() does not clear a key already present)
  // - none of the pre-existing tests below intend to exercise the new fallback path, and without
  // this an "AlphaVantage not configured" test could silently make a real network call instead of
  // reaching the plain UNKNOWN_FUNDAMENTALS HOLD it asserts on. The dedicated FMP fallback describe
  // block below sets this explicitly per-test.
  delete process.env.FMP_API_KEY;
});

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

  // Real bug found live (2026-09-02) via MacroAgent's identical call site - see
  // AIOutputValidator.ts's parseJsonFromLlmContent() header for the full root-cause chain. A bare
  // JSON.parse(res.content) threw on a response wrapped in a ```json fence, silently discarding a
  // real analysis as a fail-closed HOLD/0 vote instead of a genuine recommendation.
  it('still extracts the real recommendation from a response wrapped in a ```json fence, instead of failing closed to HOLD', async () => {
    routeTask.mockResolvedValue({
      content: '```json\n' + JSON.stringify({ recommendation: 'BUY', confidence: 0.72, reasoning: 'strong balance sheet' }) + '\n```',
      aiCallId: 'c5', provider: 'mistral', latency: 100,
    });

    await agent.analyzeFundamentals();

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.confidence).toBeCloseTo(0.72);
    expect(idea.reasoning).toContain('strong balance sheet');
  });

  it('fails closed to a real HOLD/0-confidence idea (not a thrown error) when the LLM response is genuinely unparseable', async () => {
    routeTask.mockResolvedValue({ content: 'Fundamentals look mixed this quarter.', aiCallId: 'c6', provider: 'mistral', latency: 100 });

    await agent.analyzeFundamentals();

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.confidence).toBe(0);
    expect(idea.reasoning).toContain('not parseable JSON');
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
    // waitForFreshMarketData is mocked at the top of this file (2026-09-06 MISSING_PRICE fix) -
    // reset to the file-wide fresh-price default here too, since this block's own tests each
    // control it explicitly (mirrors getLatestPrice's own pre-existing reset-then-restore pattern).
    waitForFreshMarketData.mockReset();
    waitForFreshMarketData.mockImplementation(async () => ({ ok: true, price: 100, alreadyFresh: true }));
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

  it('a BUY idea carries the real live currentPrice from waitForFreshMarketData, reaching the contract with a valid price', async () => {
    waitForFreshMarketData.mockResolvedValue({ ok: true, price: 187.42, alreadyFresh: true });
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.8, reasoning: 'strong growth' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.currentPrice).toBe(187.42);
  });

  it('a SELL idea carries the real live currentPrice from waitForFreshMarketData, reaching the contract with a valid price', async () => {
    waitForFreshMarketData.mockResolvedValue({ ok: true, price: 412.9, alreadyFresh: true });
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'SELL', confidence: 0.65, reasoning: 'weak margins' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('SELL');
    expect(idea.currentPrice).toBe(412.9);
  });

  it('never invents a price - when no fresh market-data rescue can be granted, a HOLD/DATA_UNAVAILABLE is emitted instead of a priced idea (2026-09-06 MISSING_PRICE fix)', async () => {
    // Superseded test, updated in place: previously this let a BUY idea through with an
    // undefined currentPrice and relied on gateTradeIdea's separate MISSING_PRICE gate to catch
    // it downstream (real live rejections: 219 observed). The fix now stops the idea at the
    // source instead - see waitForFreshMarketData.ts / this file's evaluateSymbol() header comment.
    waitForFreshMarketData.mockResolvedValue({ ok: false, reason: 'RESCUE_DENIED', deniedReason: 'RESCUE_CAPACITY_FULL' });
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.8, reasoning: 'strong growth' }), aiCallId: 'c3', provider: 'gemini', latency: 100 });

    await agent.analyzeFundamentals();

    expect(routeTask).not.toHaveBeenCalled(); // never even reaches the LLM call without a fresh price
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.confidence).toBe(0);
    expect(idea.currentPrice).toBeUndefined();
    expect(idea.reasoning).toContain('DATA_UNAVAILABLE');
    expect(idea.reasoning).toContain('RESCUE_CAPACITY_FULL');
  });

  it('attaches currentPrice on every emit path, including the DATA_UNAVAILABLE HOLD when fundamentals providers are not configured', async () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    waitForFreshMarketData.mockResolvedValue({ ok: true, price: 99.5, alreadyFresh: true });
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

describe('FundamentalAnalysisAgent - directional analysis is not tied to one specific provider (2026-09-07 fix)', () => {
  const fundamentals = { peRatio: '28.4', epsGrowth: '0.12', debtToEquity: '0.5' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'fundamentals' ? fundamentals : null));
    getLatestPrice.mockReturnValue(250);
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    delete process.env.GEMINI_API_KEY; // deliberately absent - this is the whole point of this test
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.6, reasoning: 'ollama-routed analysis' }), aiCallId: 'c', provider: 'ollama', latency: 50 });
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
  });

  it('still attempts a directional read with GEMINI_API_KEY unset, as long as AIRouter reports a routable provider (e.g. Ollama-only)', async () => {
    // Real bug this proves fixed: the old gate was `if (process.env.GEMINI_API_KEY)`, hardcoded to
    // one provider - an Ollama-only deployment (no Gemini key at all) would never reach this path
    // regardless of Ollama's real availability, always falling through to the
    // "no LLM configured" HOLD instead. hasAnyRoutableProvider() is the real decoupling point.
    hasAnyRoutableProvider.mockResolvedValueOnce(true);
    const agent = new FundamentalAnalysisAgent();

    await agent.analyzeFundamentals();

    expect(routeTask).toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.reasoning).toContain('ollama-routed analysis');
  });

  it('still falls back to the "no LLM configured" HOLD when truly nothing is routable, GEMINI_API_KEY or otherwise', async () => {
    hasAnyRoutableProvider.mockResolvedValueOnce(false);
    const agent = new FundamentalAnalysisAgent();

    await agent.analyzeFundamentals();

    expect(routeTask).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.confidence).toBe(0);
    expect(idea.reasoning).toContain('no LLM is configured');
  });
});

// 2026-09-10 real fix: AlphaVantage's free tier (25 req/day) was confirmed live to be fully
// exhausted every session (228 real DATA_UNAVAILABLE HOLDs in one morning), permanently starving
// FundamentalAgent's vote. Financial Modeling Prep's free tier (250 req/day, no payment) is used
// as a real fallback ONLY when AlphaVantage has already given up - never the primary source.
describe('FundamentalAnalysisAgent - FMP fallback when AlphaVantage is exhausted (2026-09-10 fix)', () => {
  let agent: any;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockResolvedValue(null); // force the real fetch path, not a cache hit
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'fmp-sourced fundamentals' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.FMP_API_KEY;
    delete process.env.GEMINI_API_KEY;
    fetchSpy?.mockRestore();
  });

  it('serves real FMP fundamentals and still emits a directional idea when AlphaVantage is not configured at all', async () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    process.env.FMP_API_KEY = 'fmp-test-key';
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('/ratios-ttm/')) {
        return { ok: true, json: async () => ([{ peRatioTTM: 31.2, debtEquityRatioTTM: 1.1 }]) } as any;
      }
      if (u.includes('/income-statement-growth/')) {
        return { ok: true, json: async () => ([{ growthEPS: 0.18 }]) } as any;
      }
      throw new Error(`unexpected fetch URL in test: ${u}`);
    });
    agent = new FundamentalAnalysisAgent();

    await agent.analyzeFundamentals();

    expect(routeTask).toHaveBeenCalledTimes(1);
    const promptArg = routeTask.mock.calls[0][1] as string;
    expect(promptArg).toContain('31.2'); // real FMP peRatio reached the LLM prompt, not a fabricated value
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
  });

  it('serves real FMP fundamentals when AlphaVantage itself signals a rate limit (the exact live failure mode)', async () => {
    process.env.ALPHAVANTAGE_API_KEY = 'av-test-key';
    process.env.FMP_API_KEY = 'fmp-test-key';
    const { AlphaVantageBudget } = await import('./AlphaVantageBudget');
    vi.spyOn(AlphaVantageBudget, 'tryConsume').mockResolvedValue(true);
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('alphavantage')) {
        return { status: 429, json: async () => ({}) } as any;
      }
      if (u.includes('/ratios-ttm/')) {
        return { ok: true, json: async () => ([{ peRatioTTM: 18.5, debtEquityRatioTTM: 0.4 }]) } as any;
      }
      if (u.includes('/income-statement-growth/')) {
        return { ok: true, json: async () => ([{ growthEPS: 0.05 }]) } as any;
      }
      throw new Error(`unexpected fetch URL in test: ${u}`);
    });
    agent = new FundamentalAnalysisAgent();

    await agent.analyzeFundamentals();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY'); // reached the LLM path via the FMP fallback, not the RATE_LIMITED HOLD
    expect(routeTask).toHaveBeenCalledTimes(1);
  });

  it('still fails closed to the honest RATE_LIMITED HOLD when both AlphaVantage AND the FMP fallback are unavailable', async () => {
    process.env.ALPHAVANTAGE_API_KEY = 'av-test-key';
    delete process.env.FMP_API_KEY; // no fallback configured either
    const { AlphaVantageBudget } = await import('./AlphaVantageBudget');
    vi.spyOn(AlphaVantageBudget, 'tryConsume').mockResolvedValue(true);
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ status: 429, json: async () => ({}) } as any);
    agent = new FundamentalAnalysisAgent();

    await agent.analyzeFundamentals();

    expect(routeTask).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.reasoning).toContain('AlphaVantage daily rate limit exhausted');
  });

  it('never fabricates a value FMP did not actually return - a response with no usable ratio fields does not become a fake fundamentals object', async () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    process.env.FMP_API_KEY = 'fmp-test-key';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ([]) } as any); // empty array - no real data
    agent = new FundamentalAnalysisAgent();

    await agent.analyzeFundamentals();

    expect(routeTask).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.reasoning).toContain('DATA_UNAVAILABLE');
  });
});
