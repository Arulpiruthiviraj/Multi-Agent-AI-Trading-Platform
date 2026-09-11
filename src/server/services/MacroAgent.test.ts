import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real test coverage for the Phase 5 hardening fix - identical shape to FundamentalAgent.test.ts,
// since MacroAgent's AI-parse code follows the exact same (now-validated) pattern.
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
  // 2026-09-06 MISSING_PRICE remediation - see FundamentalAgent.test.ts's identical comment.
  getLatestPrice: vi.fn(() => 100),
  subscribe: vi.fn(),
  // Phase 7F: agentRoundRobin's fresh-symbol filter reads this - default to "fresh" (age 0) so
  // these pre-existing tests keep exercising the full universe exactly as before this change.
  // Still real/used: this filter is independent of waitForFreshMarketData, which is now mocked
  // directly below (see its own comment) rather than through this lower-level dependency.
  getLatestPriceAgeMs: vi.fn((_s: string) => 0),
}));
// 2026-09-06 MISSING_PRICE remediation: mocked directly (not the real module, and not via its
// requestTemporaryDataRescue/getLatestPrice dependencies) for the identical reason documented in
// FundamentalAgent.test.ts's matching comment - the real module's module-scoped `inFlight` dedup
// Map is real, unmocked, process-wide state. Here it surfaced through a different trigger than
// FundamentalAgent's: this file's "genuine vs internal rate-limit" and "paces the 3 sub-calls"
// tests use vi.useFakeTimers() + a real sleep()-based poll inside waitForFreshMarketData - a
// promise whose internal setTimeout was scheduled under fake timers can be left permanently
// pending across the vi.useRealTimers() teardown in afterEach, and the next test that evaluates
// the same symbol picks up that same dead, never-resolving promise via inFlight.get(), hanging
// forever before ever reaching fetchMacro()/fetch (confirmed live: fetchSpy/markRateLimited both
// saw 0 calls). Mocking this function directly sidesteps the shared module state entirely.
const { waitForFreshMarketData } = vi.hoisted(() => ({
  waitForFreshMarketData: vi.fn(async (): Promise<{ ok: true; price: number; alreadyFresh: boolean } | { ok: false; reason: string; deniedReason?: string; detail?: string }> => ({ ok: true, price: 100, alreadyFresh: true })),
}));
// 2026-09-07 Fincept advisory wiring - real module reads a live SQLite file that does not exist in
// a test process; mocked directly, defaulting to "unavailable" (null) so every pre-existing test
// keeps behaving exactly as before this feature was added (fail-silent is the documented contract).
const { getFinceptMacroSnapshot } = vi.hoisted(() => ({
  getFinceptMacroSnapshot: vi.fn((): { vix: number | null; indices: Record<string, { price: number | null; changePct: number | null }>; asOfMs: number } | null => null),
}));

vi.mock('../core/EventBus', () => ({ eventBus: { emitTradeIdea, emit } }));
vi.mock('../core/waitForFreshMarketData', () => ({ waitForFreshMarketData }));
vi.mock('./FinceptCacheAdapter', async () => {
  const actual = await vi.importActual<typeof import('./FinceptCacheAdapter')>('./FinceptCacheAdapter');
  return { ...actual, getFinceptMacroSnapshot };
});
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));
vi.mock('../core/ideaUniverse', () => ({ resolveIdeaUniverse: () => ['NVDA', 'AAPL', 'TSLA'] }));
// hasAnyRoutableProvider() replaced the old `process.env.GEMINI_API_KEY` gate (2026-09-07 fix -
// see MacroAgent.ts's comment at the call site: the old gate hardcoded one specific provider and
// never checked whether e.g. Ollama alone was actually configured/routable). Reusing the same
// per-test GEMINI_API_KEY set/delete calls below as the mock's own signal keeps every existing
// test's intent unchanged (set = "a provider is available", delete = "no LLM configured") without
// rewriting each call site individually - this mock is intentionally a thin proxy over that env
// var, not a claim about AIRouter's own real routable-provider logic (which has its own tests).
vi.mock('../ai/AIRouter', () => ({
  AIRouter: { getInstance: () => ({ routeTask, hasAnyRoutableProvider }) },
}));
vi.mock('./MarketDataWorker', () => ({ marketDataWorker: { getLatestPrice, subscribe, getLatestPriceAgeMs } }));
    vi.mock('./ExternalDataCache', () => ({
      ExternalDataCache: { getFresh, isRateLimited: vi.fn(async () => false), getStale: vi.fn(async () => null), set: setCache, markRateLimited: vi.fn() },
  looksLikeRateLimitResponse: () => false,
  hashObject: (data: any) => JSON.stringify(data),
}));

import { MacroEconomyAgent } from './MacroAgent';
import * as tradingSafetyModule from '../config/tradingSafety';

// 2026-09-06 MISSING_PRICE remediation: evaluateSymbol()/analyzeMacro() now genuinely gate on a
// fresh price via waitForFreshMarketData() (mocked directly - see its own hoisted comment above)
// before doing anything else. A file-wide beforeEach here (runs before every describe block's own
// local beforeEach, per vitest's hook ordering) guarantees every test in this file starts from the
// same known-good "fresh price available" default, regardless of what a same-file neighboring test
// set via mockResolvedValue/mockResolvedValueOnce - far more robust than patching each describe
// block's own beforeEach individually. getLatestPriceAgeMs stays here too since it independently
// drives round-robin symbol PRIORITIZATION (Phase 7F), unrelated to waitForFreshMarketData.
beforeEach(() => {
  getLatestPrice.mockReset();
  getLatestPrice.mockImplementation(() => 100);
  getLatestPriceAgeMs.mockReset();
  getLatestPriceAgeMs.mockImplementation(() => 0);
  waitForFreshMarketData.mockReset();
  waitForFreshMarketData.mockImplementation(async () => ({ ok: true, price: 100, alreadyFresh: true }));
  getFinceptMacroSnapshot.mockReset();
  getFinceptMacroSnapshot.mockImplementation(() => null);
  // 2026-09-10 FRED fallback addition: isolate every pre-existing test from a real FRED_API_KEY
  // that may be set in the developer's own .env (dotenv.config() does not clear a key already
  // present) - none of the pre-existing tests below intend to exercise the new fallback path, and
  // without this an "AlphaVantage not configured" test could silently make a real network call
  // instead of reaching the plain UNKNOWN_MACRO HOLD it asserts on. The dedicated FRED fallback
  // describe block below sets this explicitly per-test.
  delete process.env.FRED_API_KEY;
});

describe('MacroEconomyAgent - AI output validation (Phase 5 hardening)', () => {
  let agent: any;

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    // getFresh is now called twice per analyzeMacro(): once for the raw-macro cache, once for
    // the Phase 7 AI-analysis cache - branch on `dataType` (2nd arg) so these tests always take
    // the real routeTask() call path.
    getFresh.mockImplementation(async (_provider: string, dataType: string) => {
      if (dataType === 'macro') return { inflation: '3.1', fedFundsRate: '5.25', unemployment: '4.0' };
      return null;
    });
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('coerces an off-schema recommendation to HOLD instead of passing it through as an invalid side', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'ACCUMULATE', confidence: 80, reasoning: 'real reasoning' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.agent).toBe('MacroAgent');
  });

  it('normalizes a 0-100-scale confidence answer down to the real 0-1 TRADE_IDEA_GENERATED convention', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'sell', confidence: 90, reasoning: 'hawkish outlook' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('SELL');
    expect(idea.confidence).toBeCloseTo(0.9);
  });

  it('passes through a well-formed, already-0-1-scale response unchanged', async () => {
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.65, reasoning: 'dovish pivot expected' }), aiCallId: 'c3', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.confidence).toBeCloseTo(0.65);
    expect(idea.reasoning).toContain('dovish pivot expected');
  });

  // Real bug found live (2026-09-02): a bare JSON.parse(res.content) threw on a genuine Mistral
  // response wrapped in a ```json fence, silently discarding a real 0.65-confidence analysis as a
  // fail-closed HOLD/0 "analysis failed this tick" vote - which then dragged down every consensus
  // evaluation it participated in. Remote (paid) providers only get response_format:json_object
  // when the call is local, so any provider is free to fence its JSON, and at least one does.
  it('still extracts the real recommendation from a response wrapped in a ```json fence, instead of failing closed to HOLD', async () => {
    routeTask.mockResolvedValue({
      content: '```json\n' + JSON.stringify({ recommendation: 'HOLD', confidence: 0.65, reasoning: 'mixed macro signals' }) + '\n```',
      aiCallId: 'c4', provider: 'mistral', latency: 100,
    });

    await agent.analyzeMacro();

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.reasoning).toContain('mixed macro signals');
    expect(idea.confidence).toBeCloseTo(0.65);
  });

  it('fails closed to a real HOLD/0-confidence idea (not a thrown error) when the LLM response is genuinely unparseable', async () => {
    routeTask.mockResolvedValue({ content: 'The macro outlook is unclear right now.', aiCallId: 'c5', provider: 'mistral', latency: 100 });

    await agent.analyzeMacro();

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.confidence).toBe(0);
    expect(idea.reasoning).toContain('not parseable JSON');
  });
});

describe('MacroEconomyAgent - secret leakage (Phase 8 hardening)', () => {
  let agent: any;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getFresh.mockReset();
    getFresh.mockResolvedValue(null); // force the real fetchMacro() AlphaVantage call path
    process.env.ALPHAVANTAGE_API_KEY = 'av-real-secret-88888';
    delete process.env.GEMINI_API_KEY;
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    fetchSpy?.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it('never logs the real AlphaVantage API key when a caught fetch error message includes the request URL', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(
      new Error('fetch failed: https://www.alphavantage.co/query?function=INFLATION&apikey=av-real-secret-88888')
    );

    await agent.analyzeMacro();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedCalls = consoleErrorSpy.mock.calls.map(c => String(c[1] ?? c[0]));
    for (const text of loggedCalls) expect(text).not.toContain('av-real-secret-88888');
  });
});

describe('MacroEconomyAgent - AI response caching (Phase 7 hardening)', () => {
  let agent: any;
  const macro = { inflation: '3.1', fedFundsRate: '5.25', unemployment: '4.0' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    setCache.mockClear();
    getFresh.mockReset();
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('on a cache miss, calls the real AI once and caches the validated analysis - the real cost-saving fix', async () => {
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'macro' ? macro : null));
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'SELL', confidence: 0.7, reasoning: 'hawkish Fed' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    expect(routeTask).toHaveBeenCalledTimes(1);
    expect(setCache).toHaveBeenCalledTimes(1);
    const [cacheProvider, cacheDataType, , cachedPayload] = setCache.mock.calls[0];
    expect(cacheProvider).toBe('ai-cache');
    expect(cacheDataType).toContain('MacroAgent');
    expect(cachedPayload).toEqual({ recommendation: 'SELL', confidence: 0.7, reasoning: 'hawkish Fed' });
  });

  it('the exact bug this closes: a cache HIT skips the real (paid) AI call entirely', async () => {
    const cachedAnalysis = { recommendation: 'BUY', confidence: 0.55, reasoning: 'cached dovish signal' };
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'macro' ? macro : cachedAnalysis));

    await agent.analyzeMacro();

    expect(routeTask).not.toHaveBeenCalled();
    expect(setCache).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.confidence).toBe(0.55);
    expect(idea.reasoning).toContain('cached dovish signal');
    expect(idea.aiCallId).toBeUndefined();
  });

  it('caches the AI-analysis cache key per-symbol, even though the underlying macro data is global', async () => {
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'macro' ? macro : null));
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'HOLD', confidence: 0.5, reasoning: 'n/a' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const aiCacheCall = getFresh.mock.calls.find((c: any) => c[0] === 'ai-cache')!;
    const symbolArg = aiCacheCall[2];
    // MacroAgent's prompt is written "for their impact on {symbol}" even though the underlying
    // macro data is symbol-independent - a real cache hit must not reuse an analysis written for
    // a different symbol's impact framing.
    expect(symbolArg).toBeTruthy();
  });
});

// Zero-Trade Forensic Audit fix: MacroAgent had the identical missing-currentPrice defect as
// FundamentalAgent (same code shape, same shared universe) - see FundamentalAgent.test.ts's
// identical describe block and tradeIdeaContract.test.ts for the contract-level MISSING_PRICE
// fail-closed coverage this reuses rather than duplicates.
describe('MacroEconomyAgent - currentPrice attachment (zero-trade audit fix)', () => {
  let agent: any;
  const macro = { inflation: '3.1', fedFundsRate: '5.25', unemployment: '4.0' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    // waitForFreshMarketData is mocked at the top of this file (2026-09-06 MISSING_PRICE fix) -
    // reset to the file-wide fresh-price default here too, since this block's own tests each
    // control it explicitly (mirrors FundamentalAgent.test.ts's identical pattern).
    waitForFreshMarketData.mockReset();
    waitForFreshMarketData.mockImplementation(async () => ({ ok: true, price: 100, alreadyFresh: true }));
    getFresh.mockReset();
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'macro' ? macro : null));
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('a BUY idea carries the real live currentPrice from waitForFreshMarketData, reaching the contract with a valid price', async () => {
    waitForFreshMarketData.mockResolvedValue({ ok: true, price: 452.11, alreadyFresh: true });
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'dovish pivot' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.currentPrice).toBe(452.11);
  });

  it('a SELL idea carries the real live currentPrice from waitForFreshMarketData, reaching the contract with a valid price', async () => {
    waitForFreshMarketData.mockResolvedValue({ ok: true, price: 88.3, alreadyFresh: true });
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'SELL', confidence: 0.6, reasoning: 'hawkish surprise' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('SELL');
    expect(idea.currentPrice).toBe(88.3);
  });

  it('never invents a price - when no fresh market-data rescue can be granted, a HOLD/DATA_UNAVAILABLE is emitted instead of a priced idea (2026-09-06 MISSING_PRICE fix)', async () => {
    // Superseded test, updated in place - see FundamentalAgent.test.ts's identical comment.
    waitForFreshMarketData.mockResolvedValue({ ok: false, reason: 'RESCUE_DENIED', deniedReason: 'RESCUE_CAPACITY_FULL' });
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'dovish pivot' }), aiCallId: 'c3', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    expect(routeTask).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.confidence).toBe(0);
    expect(idea.currentPrice).toBeUndefined();
    expect(idea.reasoning).toContain('DATA_UNAVAILABLE');
    expect(idea.reasoning).toContain('RESCUE_CAPACITY_FULL');
  });
});

describe('MacroEconomyAgent - Phase 7F round-robin fix (prioritize symbols with fresh ticks)', () => {
  let agent: any;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockResolvedValue(null);
    getLatestPrice.mockReturnValue(100);
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'x' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
    // getFresh returns null for 'macro' in this block, so analyzeMacro() falls through to the real
    // fetchMacro() AlphaVantage path (3 real subcalls + 2 real alphaVantageMacroSubcallDelayMs
    // pacing sleeps) unless fetch is mocked and timers are faked here too - without this, these
    // tests made genuine outbound network calls and depended on real wall-clock pacing, which was
    // fast enough in isolation but flaky (occasional timeout / wrong round-robin pick from real
    // Date.now() drift) under a loaded full-suite run.
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ status: 200, json: async () => ({ data: [{ value: '1.0' }] }) } as any);
    vi.useFakeTimers();
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy?.mockRestore();
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  async function runAnalyzeMacro() {
    const p = agent.analyzeMacro();
    await vi.advanceTimersByTimeAsync(10000);
    await p;
  }

  it('selects only from symbols with a fresh tick when exactly one qualifies, instead of blindly cycling the full universe', async () => {
    getLatestPriceAgeMs.mockImplementation((s: string) => (s === 'AAPL' ? 0 : 999999));

    await runAnalyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.symbol).toBe('AAPL');
  });

  it('falls back to the full universe when nothing currently has a fresh tick (preserves prior behavior)', async () => {
    getLatestPriceAgeMs.mockReturnValue(999999);

    await runAnalyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(['NVDA', 'AAPL', 'TSLA']).toContain(idea.symbol);
  });
});

// Phase 9D (Zero-Trade Root-Cause Resolution, 2026-08-27): real DB evidence showed MacroAgent's
// alphavantage:macro:GLOBAL row had NEVER been successfully populated (fetched_at=0) because a
// purely-internal AlphaVantageBudget.tryConsume() shortfall was treated identically to a genuine
// AlphaVantage 429/rate-limit response, arming the same 24h markRateLimited backoff either way -
// permanently starving MacroAgent even on days AlphaVantage itself never refused a request. These
// tests exercise fetchMacro()'s real 3-subcall path directly (INFLATION/FEDERAL_FUNDS_RATE/
// UNEMPLOYMENT via a spied global.fetch), separately mocking AlphaVantageBudget so each sub-call's
// outcome (real success / genuine 429 / internal-only exhaustion) can be controlled precisely.
vi.mock('./AlphaVantageBudget', () => ({ AlphaVantageBudget: { tryConsume: vi.fn(async () => true) } }));

describe('MacroEconomyAgent - genuine vs internal rate-limit distinction (Phase 9D fix)', () => {
  let agent: any;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let markRateLimited: ReturnType<typeof vi.fn>;
  let tryConsume: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    emitTradeIdea.mockClear();
    getFresh.mockReset();
    getFresh.mockResolvedValue(null); // force the real fetchMacro() AlphaVantage call path
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    delete process.env.GEMINI_API_KEY; // isolate fetchMacro()'s own HOLD/backoff behavior
    vi.useFakeTimers();

    const externalCacheMod = await import('./ExternalDataCache');
    markRateLimited = externalCacheMod.ExternalDataCache.markRateLimited as unknown as ReturnType<typeof vi.fn>;
    markRateLimited.mockClear();

    const budgetMod = await import('./AlphaVantageBudget');
    tryConsume = budgetMod.AlphaVantageBudget.tryConsume as unknown as ReturnType<typeof vi.fn>;
    tryConsume.mockReset();
    tryConsume.mockResolvedValue(true);

    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy?.mockRestore();
    delete process.env.ALPHAVANTAGE_API_KEY;
  });

  async function runAnalyzeMacro() {
    const p = agent.analyzeMacro();
    // Fast-forward through the two inter-subcall pacing delays without a real 3s wall-clock wait.
    await vi.advanceTimersByTimeAsync(10000);
    await p;
  }

  it('a genuine HTTP 429 on any sub-call arms the real 24h backoff', async () => {
    fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: [{ value: '3.1' }] }) } as any)
      .mockResolvedValueOnce({ status: 429, json: async () => ({}) } as any)
      .mockResolvedValueOnce({ status: 200, json: async () => ({ data: [{ value: '4.0' }] }) } as any);

    await runAnalyzeMacro();

    expect(markRateLimited).toHaveBeenCalledWith('alphavantage', 'macro', null);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.reasoning).toContain('AlphaVantage daily rate limit exhausted');
  });

  it('purely internal budget exhaustion (AlphaVantage itself never refused) does NOT arm the 24h backoff', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ status: 200, json: async () => ({ data: [{ value: '3.1' }] }) } as any);
    // First sub-call succeeds, then our OWN shared daily counter runs out mid-sequence - never a
    // real AlphaVantage response telling us to back off.
    tryConsume.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    await runAnalyzeMacro();

    // The observable HOLD reasoning stays the same generic DATA_UNAVAILABLE message either way
    // (matching FundamentalAgent's existing pattern) - the real, load-bearing fix is that this
    // purely-internal shortfall never persists the harsh 24h external backoff.
    expect(markRateLimited).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.reasoning).toContain('DATA_UNAVAILABLE');
  });

  it('paces the 3 sub-calls rather than firing them in an instantaneous burst', async () => {
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ status: 200, json: async () => ({ data: [{ value: '1.0' }] }) } as any);

    const p = agent.analyzeMacro();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // INFLATION fired immediately...

    await vi.advanceTimersByTimeAsync(tradingSafetyModule.tradingSafety.alphaVantageMacroSubcallDelayMs);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // ...FEDERAL_FUNDS_RATE only after the pacing delay

    await vi.advanceTimersByTimeAsync(tradingSafetyModule.tradingSafety.alphaVantageMacroSubcallDelayMs);
    expect(fetchSpy).toHaveBeenCalledTimes(3); // ...and UNEMPLOYMENT after the second delay

    await p;
  });
});

describe('MacroEconomyAgent - Phase 9 same-candidate convergence (prioritize a recent real candidate)', () => {
  let agent: any;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const { resetRecentCandidatesForTests } = await import('../core/recentCandidateRegistry');
    resetRecentCandidatesForTests();
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockResolvedValue(null);
    getLatestPrice.mockReturnValue(100);
    getLatestPriceAgeMs.mockReturnValue(0);
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'x' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
    // Same real-fetchMacro-path issue as the Phase 7F block above: getFresh returns null for
    // 'macro' here, so without mocking fetch + faking timers this test made a real AlphaVantage
    // network call and incurred real alphaVantageMacroSubcallDelayMs pacing sleeps, which was the
    // actual (previously undiagnosed) source of this test's full-suite flakiness - not a bug in
    // recentCandidateRegistry or the round-robin selector themselves.
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ status: 200, json: async () => ({ data: [{ value: '1.0' }] }) } as any);
    vi.useFakeTimers();
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy?.mockRestore();
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('prefers a recently-recorded real candidate over the generic fresh-symbol pool when both are fresh', async () => {
    const { recordCandidate } = await import('../core/recentCandidateRegistry');
    recordCandidate('TSLA');

    const p = agent.analyzeMacro();
    await vi.advanceTimersByTimeAsync(10000);
    await p;

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.symbol).toBe('TSLA');
  });
});

describe('MacroEconomyAgent - evaluateSymbol() on-demand entry point (Phase 9 same-candidate convergence)', () => {
  let agent: any;
  const macro = { inflation: '3.1', fedFundsRate: '5.25', unemployment: '4.0' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'macro' ? macro : null));
    getLatestPrice.mockReturnValue(410);
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'SELL', confidence: 0.68, reasoning: 'on-demand real fixture' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('evaluates the EXACT symbol it is given, bypassing the round-robin entirely - this is what ConfluenceCoordinator now calls', async () => {
    await agent.evaluateSymbol('AMD');

    expect(emitTradeIdea).toHaveBeenCalledTimes(1);
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.symbol).toBe('AMD');
    expect(idea.agent).toBe('MacroAgent');
    expect(idea.side).toBe('SELL');
  });
});

// Fincept advisory wiring (2026-09-07, off by default via ENABLE_FINCEPT_CACHE_ADVISORY): a
// read-only, text-only supplementary note from a locally-running Fincept Terminal's cache.db.
// Must never affect confidence/side and must degrade to a no-op when unavailable (the common case
// - see FinceptCacheAdapter.ts's own header for why that cache is empty most of the time in reality).
describe('MacroEconomyAgent - Fincept advisory context (2026-09-07)', () => {
  let agent: any;
  const macro = { inflation: '3.1', fedFundsRate: '5.25', unemployment: '4.0' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'macro' ? macro : null));
    process.env.ALPHAVANTAGE_API_KEY = 'test-key';
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'real analysis text' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
    agent = new MacroEconomyAgent();
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it('appends the Fincept snapshot to reasoning TEXT ONLY when one is available, never touching confidence/side', async () => {
    getFinceptMacroSnapshot.mockReturnValue({
      vix: 15.16,
      indices: { 'S&P 500': { price: 5123.45, changePct: 0.42 } },
      asOfMs: Date.now(),
    });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.confidence).toBeCloseTo(0.7);
    expect(idea.reasoning).toContain('real analysis text');
    expect(idea.reasoning).toContain('Fincept Terminal supplementary context');
    expect(idea.reasoning).toContain('VIX 15.16');
    expect(idea.reasoning).toContain('S&P 500 5123.45');
  });

  it('omits the Fincept note cleanly when no snapshot is available - the common case, not an error', async () => {
    getFinceptMacroSnapshot.mockReturnValue(null);

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.reasoning).toContain('real analysis text');
    expect(idea.reasoning).not.toContain('Fincept');
  });
});

describe('MacroEconomyAgent - directional analysis is not tied to one specific provider (2026-09-07 fix)', () => {
  const macro = { inflation: '3.1', fedFundsRate: '5.25', unemployment: '4.0' };

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockImplementation(async (_p: string, dataType: string) => (dataType === 'macro' ? macro : null));
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
    const agent = new MacroEconomyAgent();

    await agent.analyzeMacro();

    expect(routeTask).toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.reasoning).toContain('ollama-routed analysis');
  });

  it('still falls back to the "no LLM configured" HOLD when truly nothing is routable, GEMINI_API_KEY or otherwise', async () => {
    hasAnyRoutableProvider.mockResolvedValueOnce(false);
    const agent = new MacroEconomyAgent();

    await agent.analyzeMacro();

    expect(routeTask).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.confidence).toBe(0);
    expect(idea.reasoning).toContain('no LLM is configured');
  });
});

// 2026-09-10 real fix: AlphaVantage's free tier (25 req/day) was confirmed live to be fully
// exhausted every session (160 real DATA_UNAVAILABLE HOLDs from MacroAgent in one morning),
// permanently starving MacroAgent's vote. FRED (Federal Reserve Economic Data - the free,
// no-payment, authoritative U.S. government source these indicators actually come from) is used
// as a real fallback ONLY when AlphaVantage has already given up - never the primary source.
describe('MacroEconomyAgent - FRED fallback when AlphaVantage is exhausted (2026-09-10 fix)', () => {
  let agent: any;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function mockFredResponses() {
    // 13 monthly CPIAUCSL observations, most-recent-first (sort_order=desc) - latest 310.0,
    // 12-months-ago 300.0 -> real YoY inflation = (310-300)/300*100 = 3.33%.
    const cpiValues = [310.0, 309, 308, 307, 306, 305, 304, 303, 302, 301, 300.5, 300.2, 300.0];
    return vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('series_id=CPIAUCSL')) {
        return { ok: true, json: async () => ({ observations: cpiValues.map((v, i) => ({ date: `2026-0${i + 1}-01`, value: String(v) })) }) } as any;
      }
      if (u.includes('series_id=FEDFUNDS')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '5.33' }] }) } as any;
      }
      if (u.includes('series_id=UNRATE')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '4.1' }] }) } as any;
      }
      throw new Error(`unexpected fetch URL in test: ${u}`);
    });
  }

  beforeEach(() => {
    emitTradeIdea.mockClear();
    routeTask.mockClear();
    getFresh.mockReset();
    getFresh.mockResolvedValue(null); // force the real fetch path, not a cache hit
    process.env.GEMINI_API_KEY = 'test-key';
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.65, reasoning: 'fred-sourced macro' }), aiCallId: 'c', provider: 'gemini', latency: 100 });
  });

  afterEach(() => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    delete process.env.FRED_API_KEY;
    delete process.env.GEMINI_API_KEY;
    fetchSpy?.mockRestore();
  });

  it('computes a real year-over-year CPI inflation rate from FRED and still emits a directional idea when AlphaVantage is not configured at all', async () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    process.env.FRED_API_KEY = 'fred-test-key';
    fetchSpy = mockFredResponses();
    agent = new MacroEconomyAgent();

    await agent.analyzeMacro();

    expect(routeTask).toHaveBeenCalledTimes(1);
    const promptArg = routeTask.mock.calls[0][1] as string;
    expect(promptArg).toContain('3.33'); // real computed YoY CPI change reached the LLM prompt
    expect(promptArg).toContain('5.33'); // real FEDFUNDS value
    expect(promptArg).toContain('4.1'); // real UNRATE value
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
  });

  it('serves real FRED macro data when AlphaVantage itself signals a genuine rate limit (the exact live failure mode)', async () => {
    process.env.ALPHAVANTAGE_API_KEY = 'av-test-key';
    process.env.FRED_API_KEY = 'fred-test-key';
    vi.useFakeTimers();
    const budgetMod = await import('./AlphaVantageBudget');
    (budgetMod.AlphaVantageBudget.tryConsume as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const fredMock = mockFredResponses();
    fetchSpy = fredMock;
    // All 3 AlphaVantage sub-calls return a genuine 429 before FRED is ever consulted.
    fetchSpy.mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('alphavantage')) {
        return { status: 429, json: async () => ({}) } as any;
      }
      if (u.includes('series_id=CPIAUCSL')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '310.0' }, ...Array.from({ length: 12 }, (_, i) => ({ date: `2026-0${i + 1}-01`, value: '300.0' }))] }) } as any;
      }
      if (u.includes('series_id=FEDFUNDS')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '5.33' }] }) } as any;
      }
      if (u.includes('series_id=UNRATE')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '4.1' }] }) } as any;
      }
      throw new Error(`unexpected fetch URL in test: ${u}`);
    });
    agent = new MacroEconomyAgent();

    const p = agent.analyzeMacro();
    await vi.advanceTimersByTimeAsync(10000);
    await p;
    vi.useRealTimers();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY'); // reached the LLM path via the FRED fallback, not the RATE_LIMITED HOLD
  });

  it('still fails closed to the honest RATE_LIMITED HOLD when both AlphaVantage AND the FRED fallback are unavailable', async () => {
    process.env.ALPHAVANTAGE_API_KEY = 'av-test-key';
    delete process.env.FRED_API_KEY; // no fallback configured either
    vi.useFakeTimers();
    const budgetMod = await import('./AlphaVantageBudget');
    (budgetMod.AlphaVantageBudget.tryConsume as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({ status: 429, json: async () => ({}) } as any);
    agent = new MacroEconomyAgent();

    const p = agent.analyzeMacro();
    await vi.advanceTimersByTimeAsync(10000);
    await p;
    vi.useRealTimers();

    expect(routeTask).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.reasoning).toContain('AlphaVantage daily rate limit exhausted');
  });

  it('never fabricates an inflation figure from a short CPI series - fewer than 13 observations fails that one field closed to UNKNOWN rather than guessing', async () => {
    delete process.env.ALPHAVANTAGE_API_KEY;
    process.env.FRED_API_KEY = 'fred-test-key';
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('series_id=CPIAUCSL')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '310.0' }] }) } as any; // only 1 observation, not 13
      }
      if (u.includes('series_id=FEDFUNDS')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '5.33' }] }) } as any;
      }
      if (u.includes('series_id=UNRATE')) {
        return { ok: true, json: async () => ({ observations: [{ date: '2026-08-01', value: '4.1' }] }) } as any;
      }
      throw new Error(`unexpected fetch URL in test: ${u}`);
    });
    agent = new MacroEconomyAgent();

    await agent.analyzeMacro();

    // Matches the pre-existing AlphaVantage-path convention (data.inflation === 'UNKNOWN' is the
    // caller's proxy for "not configured", same coarse check applied uniformly to both providers
    // rather than a new, provider-specific carve-out) - a real, un-fabricated field that FRED
    // genuinely couldn't compute (fewer than 13 CPI observations) still results in the honest
    // "not configured" HOLD, not a partially-invented directional call.
    expect(routeTask).not.toHaveBeenCalled();
    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('HOLD');
    expect(idea.reasoning).toContain('DATA_UNAVAILABLE');
  });
});
