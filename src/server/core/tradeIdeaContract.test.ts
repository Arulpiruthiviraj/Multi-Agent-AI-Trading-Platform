import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { gateTradeIdea } from './tradeIdeaContract';
import { eventBus } from './EventBus';
import { EVENTS } from './eventNames';
import { marketDataWorker } from '../services/MarketDataWorker';
import { seedRuntimeOverrideCacheForTests, resetRuntimeConfigCacheForTests } from '../config/effectiveRuntimeConfig';

describe('gateTradeIdea — stop emitting garbage symbols / missing prices', () => {
  it('rejects garbled LLM symbols like Toast Stock (not specified...)', () => {
    const gated = gateTradeIdea({
      symbol: 'Toast Stock (not specified...)',
      side: 'BUY',
      confidence: 0.8,
      agent: 'NewsAgent',
      currentPrice: 30,
    });
    expect(gated.ok).toBe(false);
    if (gated.ok === false) expect(gated.reason).toBe('INVALID_SYMBOL');
  });

  it('rejects a listed ticker with no live price and no numeric currentPrice', () => {
    const gated = gateTradeIdea({
      symbol: 'AAPL',
      side: 'BUY',
      confidence: 0.8,
      agent: 'NewsAgent',
    });
    expect(gated.ok).toBe(false);
    if (gated.ok === false) expect(gated.reason).toBe('MISSING_PRICE');
  });

  it('attaches a cached live price and canonicalizes the ticker', () => {
    marketDataWorker.cacheObservedQuote('AAPL', 188.42);
    const gated = gateTradeIdea({
      symbol: 'aapl',
      side: 'BUY',
      confidence: 0.8,
      agent: 'FundamentalAgent',
    });
    expect(gated.ok).toBe(true);
    if (gated.ok) {
      expect(gated.idea.symbol).toBe('AAPL');
      expect(gated.idea.currentPrice).toBe(188.42);
    }
  });

  // Crypto Expansion Phase 2 (2026-09-21): gateTradeIdea migrated from looksLikeListedTicker()
  // (equity-only) to validateInstrumentSymbol() (additive). This exercises the required matrix
  // directly - no live caller emits a crypto idea yet, so this proves capability, not current
  // production behavior.
  describe('Crypto Expansion Phase 2', () => {
    // CRYPTO is disabled by default (ARGUS_TRADEABLE_ASSET_CLASSES defaults to EQUITY-only) -
    // explicitly opt it in for this block, which specifically tests the crypto validation path.
    beforeAll(() => seedRuntimeOverrideCacheForTests('ARGUS_TRADEABLE_ASSET_CLASSES', 'EQUITY,CRYPTO'));
    afterAll(() => resetRuntimeConfigCacheForTests());

    it('BRK.B (equity with a dot suffix) is unaffected', () => {
      marketDataWorker.cacheObservedQuote('BRK.B', 410);
      const gated = gateTradeIdea({ symbol: 'brk.b', side: 'BUY', confidence: 0.8, agent: 'FundamentalAgent' });
      expect(gated.ok).toBe(true);
      if (gated.ok) expect(gated.idea.symbol).toBe('BRK.B');
    });

    it('accepts a registered crypto instrument (BTC-USD) with an explicit currentPrice', () => {
      const gated = gateTradeIdea({ symbol: 'btc-usd', side: 'BUY', confidence: 0.8, agent: 'QuantSignalAgent', currentPrice: 60000 });
      expect(gated.ok).toBe(true);
      if (gated.ok) {
        expect(gated.idea.symbol).toBe('BTC-USD');
        expect(gated.idea.currentPrice).toBe(60000);
      }
    });

    it('accepts a registered crypto instrument (ETH-USD) with an explicit currentPrice', () => {
      const gated = gateTradeIdea({ symbol: 'eth-usd', side: 'BUY', confidence: 0.8, agent: 'QuantSignalAgent', currentPrice: 2500 });
      expect(gated.ok).toBe(true);
      if (gated.ok) expect(gated.idea.symbol).toBe('ETH-USD');
    });

    it('rejects provider-notation crypto symbols - canonical symbols only', () => {
      const gated = gateTradeIdea({ symbol: 'BTC/USD', side: 'BUY', confidence: 0.8, agent: 'QuantSignalAgent', currentPrice: 60000 });
      expect(gated.ok).toBe(false);
      if (gated.ok === false) expect(gated.reason).toBe('INVALID_SYMBOL');
    });

    it('rejects BTCUSD (no canonical registry entry without the hyphen)', () => {
      const gated = gateTradeIdea({ symbol: 'BTCUSD', side: 'BUY', confidence: 0.8, agent: 'QuantSignalAgent', currentPrice: 60000 });
      expect(gated.ok).toBe(false);
      if (gated.ok === false) expect(gated.reason).toBe('INVALID_SYMBOL');
    });

    it('rejects an unregistered crypto-shaped symbol (DOG-FAKE) - a hyphen alone never passes', () => {
      const gated = gateTradeIdea({ symbol: 'DOG-FAKE', side: 'BUY', confidence: 0.8, agent: 'QuantSignalAgent', currentPrice: 1 });
      expect(gated.ok).toBe(false);
      if (gated.ok === false) expect(gated.reason).toBe('INVALID_SYMBOL');
    });

    it('a registered crypto symbol with no price attached and no cached tick still fails MISSING_PRICE (no market data path exists yet)', () => {
      const gated = gateTradeIdea({ symbol: 'BTC-USD', side: 'BUY', confidence: 0.8, agent: 'QuantSignalAgent' });
      expect(gated.ok).toBe(false);
      if (gated.ok === false) expect(gated.reason).toBe('MISSING_PRICE');
    });
  });
});

describe('EventBus.emitTradeIdea does not emit TRADE_IDEA_GENERATED for garbage/missing price', () => {
  const ideas: any[] = [];
  const rejected: any[] = [];
  const onIdea = (p: any) => ideas.push(p);
  const onReject = (p: any) => rejected.push(p);

  beforeEach(() => {
    ideas.length = 0;
    rejected.length = 0;
    eventBus.subscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    eventBus.subscribe(EVENTS.TRADE_IDEA_REJECTED, onReject);
  });

  afterEach(() => {
    eventBus.unsubscribe(EVENTS.TRADE_IDEA_GENERATED, onIdea);
    eventBus.unsubscribe(EVENTS.TRADE_IDEA_REJECTED, onReject);
  });

  it('does not emit a trade idea for Toast Stock (not specified...)', () => {
    eventBus.emitTradeIdea({
      traceId: 'test-toast',
      symbol: 'Toast Stock (not specified...)',
      side: 'BUY',
      confidence: 0.9,
      agent: 'NewsAgent',
      currentPrice: 12,
    });
    expect(ideas).toHaveLength(0);
    expect(rejected.some((r) => r.reason === 'INVALID_SYMBOL')).toBe(true);
  });

  it('does not emit a trade idea when currentPrice is missing and no tick is cached', () => {
    eventBus.emitTradeIdea({
      traceId: 'test-noprice',
      symbol: 'MSFT',
      side: 'BUY',
      confidence: 0.7,
      agent: 'MacroAgent',
    });
    expect(ideas).toHaveLength(0);
    expect(rejected.some((r) => r.reason === 'MISSING_PRICE')).toBe(true);
  });

  it('eventBus.emit(TRADE_IDEA_GENERATED) cannot bypass the gate for garbage symbols', () => {
    eventBus.emit(EVENTS.TRADE_IDEA_GENERATED, {
      traceId: 'test-emit-bypass',
      symbol: 'Toast Stock (not specified...)',
      side: 'BUY',
      confidence: 0.9,
      agent: 'NewsAgent',
      currentPrice: 12,
    });
    expect(ideas).toHaveLength(0);
    expect(rejected.some((r) => r.reason === 'INVALID_SYMBOL' && r.bypassedEmitTradeIdea === true)).toBe(true);
  });

  it('telemetryPulse payloads still reach TRADE_IDEA_GENERATED (UI-only, ignored by ChiefTrader)', () => {
    eventBus.emit(EVENTS.TRADE_IDEA_GENERATED, {
      traceId: 'telemetry-pulse-ui-only',
      telemetryPulse: true,
      diagnosticTelemetry: true,
      symbol: 'AAPL',
      side: 'BUY',
      confidence: 0.8,
      agent: 'TechnicalAgent',
      currentPrice: 188.42,
    });
    expect(ideas).toHaveLength(1);
    expect(ideas[0].telemetryPulse).toBe(true);
  });
});
