import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real test coverage for the Phase 5 hardening fix - identical shape to FundamentalAgent.test.ts,
// since MacroAgent's AI-parse code follows the exact same (now-validated) pattern.
const { emitTradeIdea } = vi.hoisted(() => ({ emitTradeIdea: vi.fn() }));
const { routeTask } = vi.hoisted(() => ({ routeTask: vi.fn() }));
const { getFresh, setCache } = vi.hoisted(() => ({ getFresh: vi.fn(), setCache: vi.fn() }));

vi.mock('../core/EventBus', () => ({ eventBus: { emitTradeIdea } }));
vi.mock('../core/ideaGenerationGate', () => ({ isLiveIdeaGenerationEnabled: () => true }));
vi.mock('../ai/AIRouter', () => ({ AIRouter: { getInstance: () => ({ routeTask }) } }));
vi.mock('./ExternalDataCache', () => ({
  ExternalDataCache: { getFresh, isRateLimited: vi.fn(async () => false), set: setCache, markRateLimited: vi.fn() },
  looksLikeRateLimitResponse: () => false,
  hashObject: (data: any) => JSON.stringify(data),
}));

import { MacroEconomyAgent } from './MacroAgent';

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

    expect(emitTradeIdea).not.toHaveBeenCalled();
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
