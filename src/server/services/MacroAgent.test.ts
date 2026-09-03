import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real test coverage for the Phase 5 hardening fix - identical shape to FundamentalAgent.test.ts,
// since MacroAgent's AI-parse code follows the exact same (now-validated) pattern.
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

import { MacroEconomyAgent } from './MacroAgent';
import * as tradingSafetyModule from '../config/tradingSafety';

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
    getLatestPrice.mockReset();
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

  it('a BUY idea carries the real live currentPrice from MarketDataWorker, reaching the contract with a valid price', async () => {
    getLatestPrice.mockReturnValue(452.11);
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'dovish pivot' }), aiCallId: 'c1', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('BUY');
    expect(idea.currentPrice).toBe(452.11);
  });

  it('a SELL idea carries the real live currentPrice from MarketDataWorker, reaching the contract with a valid price', async () => {
    getLatestPrice.mockReturnValue(88.3);
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'SELL', confidence: 0.6, reasoning: 'hawkish surprise' }), aiCallId: 'c2', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.side).toBe('SELL');
    expect(idea.currentPrice).toBe(88.3);
  });

  it('never invents a price - when MarketDataWorker has no live tick for this symbol, currentPrice is left undefined rather than fabricated', async () => {
    getLatestPrice.mockReturnValue(null);
    routeTask.mockResolvedValue({ content: JSON.stringify({ recommendation: 'BUY', confidence: 0.7, reasoning: 'dovish pivot' }), aiCallId: 'c3', provider: 'gemini', latency: 100 });

    await agent.analyzeMacro();

    const idea = emitTradeIdea.mock.calls[0][0];
    expect(idea.currentPrice).toBeUndefined();
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
