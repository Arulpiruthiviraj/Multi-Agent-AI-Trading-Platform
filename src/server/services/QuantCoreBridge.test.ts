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
