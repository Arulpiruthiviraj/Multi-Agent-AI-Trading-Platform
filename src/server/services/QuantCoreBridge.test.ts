import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { QuantCoreBridgeService } from './QuantCoreBridge';

const LIVE_IDEAS_ENV = 'QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED';

describe('QuantCoreBridgeService - gating and tick forwarding (Phase 2)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    delete process.env[LIVE_IDEAS_ENV];
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    delete process.env[LIVE_IDEAS_ENV];
  });

  it('start() does not subscribe to MARKET_DATA when the flag is off (default)', () => {
    const bridge = new QuantCoreBridgeService();
    fetchSpy = vi.spyOn(global, 'fetch');
    bridge.start();

    eventBus.emit('MARKET_DATA', { symbol: 'AAPL', price: 100, volume: 10, timestamp: new Date().toISOString() });
    bridge.stop();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('forwards a tick to the Java process when the flag is on', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    bridge.start();
    eventBus.emit('MARKET_DATA', { symbol: 'AAPL', price: 189.5, volume: 500, timestamp: new Date().toISOString() });
    // onMarketData is fire-and-forget (not awaited by the emitter) - flush microtasks.
    await new Promise((r) => setTimeout(r, 20));
    bridge.stop();

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/ticks'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('never throws when the Java process is unreachable (fetch rejects)', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const bridge = new QuantCoreBridgeService();
    bridge.start();
    expect(() => {
      eventBus.emit('MARKET_DATA', { symbol: 'AAPL', price: 100, volume: 10, timestamp: new Date().toISOString() });
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    bridge.stop();
  });

  it('opens the circuit breaker after consecutive failures and stops attempting new requests', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const bridge = new QuantCoreBridgeService();
    bridge.start();
    // tradingSafety.quantJavaCoreCircuitBreakerFailureThreshold defaults to 3 in config.
    for (let i = 0; i < 5; i++) {
      eventBus.emit('MARKET_DATA', { symbol: 'AAPL', price: 100 + i, volume: 10, timestamp: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 5));
    }
    bridge.stop();

    // Once the breaker opens, later ticks should short-circuit before calling fetch again -
    // so the total call count is bounded, not one-per-tick across all 5 emits.
    expect(fetchSpy.mock.calls.length).toBeLessThan(5);
  });
});

describe('QuantCoreBridgeService - local parity-comparison history window (Quant Parity Forensics, 2026-08-26)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('retains more than the old hardcoded 52-tick cap - must match SymbolState.java CAPACITY (200), a real prior parity-divergence root cause', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    bridge.start();
    // 60 ticks: more than the old 52-tick cap, well under the new 200-tick cap.
    for (let i = 0; i < 60; i++) {
      eventBus.emit('MARKET_DATA', { symbol: 'AAPL', price: 100 + i * 0.1, volume: 10, timestamp: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 1));
    }
    bridge.stop();

    expect(bridge.getLocalHistoryLengthForTests('AAPL')).toBe(60);
  });

  it('caps local history at tradingSafety.quantJavaCoreLocalHistoryCap once exceeded', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    bridge.start();
    for (let i = 0; i < 210; i++) {
      eventBus.emit('MARKET_DATA', { symbol: 'AAPL', price: 100 + i * 0.1, volume: 10, timestamp: new Date().toISOString() });
      await new Promise((r) => setTimeout(r, 1));
    }
    bridge.stop();

    expect(bridge.getLocalHistoryLengthForTests('AAPL')).toBe(200);
  });
});

describe('QuantCoreBridgeService.fetchInstitutionalVolatility/fetchInstitutionalRegime - advisory-only, never wired to a vote', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const bars = Array.from({ length: 40 }, (_, i) => ({
    timestamp: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
  }));

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('returns null and never calls fetch when QUANT_JAVA_CORE_ENABLED is off (default)', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    const bridge = new QuantCoreBridgeService();

    expect(await bridge.fetchInstitutionalVolatility('AAPL', bars)).toBeNull();
    expect(await bridge.fetchInstitutionalRegime('AAPL', bars)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs bars to the volatility endpoint and returns the parsed GARCH result when enabled', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const fakeResult = { schemaVersion: 1, symbol: 'AAPL', omega: 0.001, alpha: 0.05, beta: 0.9, persistence: 0.95, logLikelihood: -100, unconditionalVariance: 0.02, lastConditionalVariance: 0.019, forecastStepsAhead: 1, forecastVariance: 0.021, forecastVolatility: 0.145, returnsUsed: 39 };
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(fakeResult), { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    const result = await bridge.fetchInstitutionalVolatility('AAPL', bars);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/institutional/volatility/AAPL'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(fakeResult);
  });

  it('POSTs bars to the regime endpoint and returns the parsed HMM result when enabled', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const fakeResult = { schemaVersion: 1, symbol: 'AAPL', currentRegime: 'BULL_TRENDING', logLikelihood: -50, observationCount: 30, stateLabels: ['BULL_TRENDING', 'BEAR_TRENDING', 'MEAN_REVERTING', 'HIGH_VOL_CHAOS'], stateMeans: [[0.01, 0.02]], stateVariances: [[0.001, 0.002]] };
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(fakeResult), { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    const result = await bridge.fetchInstitutionalRegime('AAPL', bars);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/institutional/regime/AAPL'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(fakeResult);
  });

  it('fails closed (returns null, never throws) when the Java process is unreachable', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const bridge = new QuantCoreBridgeService();
    await expect(bridge.fetchInstitutionalVolatility('AAPL', bars)).resolves.toBeNull();
    await expect(bridge.fetchInstitutionalRegime('AAPL', bars)).resolves.toBeNull();
  });

  it('fails closed (returns null) on a non-2xx response, e.g. 422 insufficient history', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":false}', { status: 422 }));

    const bridge = new QuantCoreBridgeService();
    expect(await bridge.fetchInstitutionalVolatility('AAPL', bars)).toBeNull();
  });
});

describe('QuantCoreBridgeService.fetchInstitutionalFeatures/fetchInstitutionalCorrelation - advisory-only, never wired to a vote', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const bars = Array.from({ length: 40 }, (_, i) => ({
    timestamp: i, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 1000,
  }));

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('returns null and never calls fetch when QUANT_JAVA_CORE_ENABLED is off (default)', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    const bridge = new QuantCoreBridgeService();

    expect(await bridge.fetchInstitutionalFeatures('AAPL', bars)).toBeNull();
    expect(await bridge.fetchInstitutionalCorrelation(['A', 'B'], [[0.01, 0.02], [0.01, 0.02]])).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs bars to the features endpoint and returns the parsed snapshot when enabled', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const fakeResult = { schemaVersion: 1, symbol: 'AAPL', asOfMs: 39, close: 139.5, rsi: 55, macd: 0.1, macdSignal: 0.05, bbUpper: 145, bbLower: 130, atr: 1.2, realizedVolatility: 0.01, barsUsed: 40, qualityReport: { status: 'GREEN', stale: false, sufficientHistory: true, anomalyDetected: false, gapDetected: false, issues: [] } };
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(fakeResult), { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    const result = await bridge.fetchInstitutionalFeatures('AAPL', bars);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/institutional/features/AAPL'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(fakeResult);
  });

  it('POSTs symbols + returnsByAsset to the correlation endpoint and returns the parsed matrix when enabled', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const fakeResult = { schemaVersion: 1, symbols: ['SPY', 'IVV'], lambda: 0.94, correlationMatrix: [[1, 0.98], [0.98, 1]] };
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(fakeResult), { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    const result = await bridge.fetchInstitutionalCorrelation(['SPY', 'IVV'], [[0.01, 0.02], [0.011, 0.019]]);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/institutional/correlation'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(fakeResult);
  });

  it('fails closed (returns null, never throws) when the Java process is unreachable', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    const bridge = new QuantCoreBridgeService();
    await expect(bridge.fetchInstitutionalFeatures('AAPL', bars)).resolves.toBeNull();
    await expect(bridge.fetchInstitutionalCorrelation(['A', 'B'], [[0.01], [0.02]])).resolves.toBeNull();
  });

  it('fails closed (returns null) on a non-2xx response, e.g. 422 insufficient/ragged input', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"ok":false}', { status: 422 }));

    const bridge = new QuantCoreBridgeService();
    expect(await bridge.fetchInstitutionalFeatures('AAPL', bars)).toBeNull();
    expect(await bridge.fetchInstitutionalCorrelation(['A', 'B'], [[0.01], [0.02]])).toBeNull();
  });
});

describe('QuantCoreBridgeService.fetchInstitutionalEnsemble - advisory-only, never wired to a vote', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const votes = [
    { modelId: 'momentum', family: 'momentum', side: 'BUY' as const, confidence: 0.8 },
    { modelId: 'factor', family: 'factor', side: 'BUY' as const, confidence: 0.6 },
  ];

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('returns null and never calls fetch when QUANT_JAVA_CORE_ENABLED is off (default)', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    const bridge = new QuantCoreBridgeService();
    expect(await bridge.fetchInstitutionalEnsemble(votes)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs votes to the ensemble endpoint and returns the parsed result when enabled', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const fakeResult = { schemaVersion: 1, rawSide: 'BUY', totalVotes: 2, agreeingCount: 2, avgConfidenceOfAgreeing: 0.7, effectiveIndependentCount: 1.6, agreeingModelIds: ['momentum', 'factor'], dissentingModelIds: [] };
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(fakeResult), { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    const result = await bridge.fetchInstitutionalEnsemble(votes);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/institutional/ensemble'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(fakeResult);
  });

  it('fails closed (returns null, never throws) when the Java process is unreachable', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const bridge = new QuantCoreBridgeService();
    await expect(bridge.fetchInstitutionalEnsemble(votes)).resolves.toBeNull();
  });
});

describe('QuantCoreBridgeService.fetchInstitutionalAdvisory - Dynamic Regime & Volatility Multiplier Layer, advisory-only', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const votes = [{ modelId: 'factor', family: 'factor', side: 'BUY' as const, confidence: 0.8 }];

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('returns null and never calls fetch when QUANT_JAVA_CORE_ENABLED is off (default)', async () => {
    fetchSpy = vi.spyOn(global, 'fetch');
    const bridge = new QuantCoreBridgeService();
    expect(await bridge.fetchInstitutionalAdvisory(votes, 'BULL_TRENDING', 0.015)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs votes/regime/currentVolatility to the advisory endpoint and returns the parsed result when enabled', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const fakeResult = { schemaVersion: 1, rawSide: 'BUY', rawAvgConfidence: 0.8, rawEffectiveIndependentCount: 1, regime: 'BULL_TRENDING', regimeMultiplier: 1, currentVolatility: 0.015, volatilityMultiplier: 1, adjustedConfidence: 0.8, gated: false, reasoning: 'x', agreeingModelIds: ['factor'], dissentingModelIds: [] };
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(fakeResult), { status: 200 }));

    const bridge = new QuantCoreBridgeService();
    const result = await bridge.fetchInstitutionalAdvisory(votes, 'BULL_TRENDING', 0.015);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/institutional/advisory'),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(fakeResult);
  });

  it('fails closed (returns null, never throws) when the Java process is unreachable', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const bridge = new QuantCoreBridgeService();
    await expect(bridge.fetchInstitutionalAdvisory(votes, 'BULL_TRENDING', 0.015)).resolves.toBeNull();
  });
});

describe('QuantCoreBridgeService.health()', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('reports not connected without hitting the network when the flag is off', async () => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    fetchSpy = vi.spyOn(global, 'fetch');
    const bridge = new QuantCoreBridgeService();
    const health = await bridge.health();
    expect(health.connected).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports connected when the health endpoint responds ok', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{"status":"UP"}', { status: 200 }));
    const bridge = new QuantCoreBridgeService();
    const health = await bridge.health();
    expect(health.connected).toBe(true);
  });

  it('reports not connected when the process is unreachable', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const bridge = new QuantCoreBridgeService();
    const health = await bridge.health();
    expect(health.connected).toBe(false);
    expect(health.detail).toContain('ECONNREFUSED');
  });
});

describe('QuantCoreBridgeService.onSignal() - Phase 3 validation gate', () => {
  let receivedIdeas: any[];
  let listener: (idea: any) => void;

  beforeEach(() => {
    receivedIdeas = [];
    listener = (idea) => receivedIdeas.push(idea);
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, listener);
  });

  afterEach(() => {
    eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, listener);
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    delete process.env[LIVE_IDEAS_ENV];
  });

  it('is a no-op when QUANT_JAVA_CORE_ENABLED is off, even with a valid signal', () => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
    process.env[LIVE_IDEAS_ENV] = 'true';
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'AAPL', side: 'BUY', confidence: 0.8, currentPrice: 100, strategyId: 'MOMENTUM_BREAKOUT', reasoning: 'x' });
    expect(receivedIdeas).toHaveLength(0);
  });

  it('is a no-op when only QUANT_JAVA_CORE_ENABLED is on but the live-ideas flag is off', () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    delete process.env[LIVE_IDEAS_ENV];
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'AAPL', side: 'BUY', confidence: 0.8, currentPrice: 100, strategyId: 'MOMENTUM_BREAKOUT', reasoning: 'x' });
    expect(receivedIdeas).toHaveLength(0);
  });

  function enableBothFlags() {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    process.env[LIVE_IDEAS_ENV] = 'true';
  }

  it('emits a valid TRADE_IDEA_GENERATED when both flags are on and the signal is well-formed', () => {
    enableBothFlags();
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'aapl', side: 'BUY', confidence: 0.8, currentPrice: 189.5, strategyId: 'MOMENTUM_BREAKOUT', reasoning: 'BOS confirmed' });

    expect(receivedIdeas).toHaveLength(1);
    expect(receivedIdeas[0].symbol).toBe('AAPL');
    expect(receivedIdeas[0].agent).toBe('QuantCoreJava');
    expect(receivedIdeas[0].side).toBe('BUY');
    expect(receivedIdeas[0].confidence).toBe(0.8);
    expect(receivedIdeas[0].traceId).toBeTruthy();
    expect(receivedIdeas[0].reasoning).toContain('MOMENTUM_BREAKOUT');
  });

  it('rejects a malformed symbol (too long / garbage) - looksLikeListedTicker gate', () => {
    enableBothFlags();
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'NOT_A_REAL_TICKER_123', side: 'BUY', confidence: 0.8, currentPrice: 100, strategyId: 'X', reasoning: '' });
    expect(receivedIdeas).toHaveLength(0);
  });

  it('rejects an invalid side', () => {
    enableBothFlags();
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'AAPL', side: 'HOLD', confidence: 0.8, currentPrice: 100, strategyId: 'X', reasoning: '' });
    expect(receivedIdeas).toHaveLength(0);
  });

  it('rejects a non-finite confidence', () => {
    enableBothFlags();
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'AAPL', side: 'BUY', confidence: Number.NaN, currentPrice: 100, strategyId: 'X', reasoning: '' });
    expect(receivedIdeas).toHaveLength(0);
  });

  it('clamps an out-of-range confidence into [0,1] rather than rejecting it', () => {
    enableBothFlags();
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'AAPL', side: 'BUY', confidence: 1.5, currentPrice: 100, strategyId: 'X', reasoning: '' });
    expect(receivedIdeas).toHaveLength(1);
    expect(receivedIdeas[0].confidence).toBe(1);
  });

  it('rejects a non-positive currentPrice', () => {
    enableBothFlags();
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'AAPL', side: 'BUY', confidence: 0.8, currentPrice: 0, strategyId: 'X', reasoning: '' });
    expect(receivedIdeas).toHaveLength(0);
  });

  it('rejects a missing/undefined price entirely', () => {
    enableBothFlags();
    const bridge = new QuantCoreBridgeService();
    bridge.onSignal({ symbol: 'AAPL', side: 'BUY', confidence: 0.8, strategyId: 'X', reasoning: '' } as any);
    expect(receivedIdeas).toHaveLength(0);
  });
});
