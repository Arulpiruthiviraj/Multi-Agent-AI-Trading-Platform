import { describe, it, expect, afterEach } from 'vitest';
import { technicalAgent } from './TechnicalAgent';
import { quantThresholds } from '../config/quantThresholds';
import { eventBus } from '../core/EventBus';
import { tradingEngine } from '../engines/TradingEngine';

/**
 * ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md finding M3: a still-true, unchanged signal state used
 * to re-emit TRADE_IDEA_GENERATED every single technicalEvaluationCooldownMs regardless, producing
 * thousands of near-duplicate rows for one real regime read. shouldEmitSignal() gates that
 * separately from technicalEvaluationCooldownMs (which only throttles how often checkStrategies
 * re-runs at all).
 */
describe('TechnicalAgent.shouldEmitSignal (M3 debounce)', () => {
  const agent = technicalAgent as any;
  const SYMBOL = 'DBTEST';

  afterEach(() => {
    delete agent.previousIndicators[SYMBOL];
    delete agent.lastEmittedAt[SYMBOL];
  });

  it('first-ever evaluation for a symbol always emits - nothing to debounce against yet', () => {
    expect(agent.shouldEmitSignal(SYMBOL, 'momentumBreakout', 60, 0.5, Date.now())).toBe(true);
  });

  it('does not re-emit the same still-true signal before technicalSignalCooldownMs elapses, with no state transition', () => {
    const now = Date.now();
    expect(agent.shouldEmitSignal(SYMBOL, 'momentumBreakout', 60, 0.5, now)).toBe(true);
    agent.markEmitted(SYMBOL, 'momentumBreakout', now);
    agent.previousIndicators[SYMBOL] = { rsi: 60, macdHistogram: 0.5 };

    // Same rsi/macdHistogram (no cross), only 1s later - well inside the cooldown.
    expect(agent.shouldEmitSignal(SYMBOL, 'momentumBreakout', 60, 0.5, now + 1000)).toBe(false);
  });

  it('re-emits once technicalSignalCooldownMs has genuinely elapsed, even with no state transition', () => {
    const now = Date.now();
    agent.markEmitted(SYMBOL, 'momentumBreakout', now);
    agent.previousIndicators[SYMBOL] = { rsi: 60, macdHistogram: 0.5 };

    const later = now + quantThresholds.technicalSignalCooldownMs + 1;
    expect(agent.shouldEmitSignal(SYMBOL, 'momentumBreakout', 60, 0.5, later)).toBe(true);
  });

  it('re-emits immediately on a genuine MACD histogram sign flip (bullish crossover), even inside the cooldown', () => {
    const now = Date.now();
    agent.markEmitted(SYMBOL, 'momentumBreakout', now);
    agent.previousIndicators[SYMBOL] = { rsi: 60, macdHistogram: -0.2 }; // was bearish

    // 1s later, same rsi, but MACD just crossed positive - a real transition.
    expect(agent.shouldEmitSignal(SYMBOL, 'momentumBreakout', 60, 0.1, now + 1000)).toBe(true);
  });

  it('re-emits immediately on RSI crossing up through 50 into the momentum band, even inside the cooldown', () => {
    const now = Date.now();
    agent.markEmitted(SYMBOL, 'momentumBreakout', now);
    agent.previousIndicators[SYMBOL] = { rsi: 48, macdHistogram: 0.5 }; // was below 50

    expect(agent.shouldEmitSignal(SYMBOL, 'momentumBreakout', 52, 0.5, now + 1000)).toBe(true);
  });

  it('re-emits immediately on RSI crossing down through 30 into oversold (meanReversion), even inside the cooldown', () => {
    const now = Date.now();
    agent.markEmitted(SYMBOL, 'meanReversion', now);
    agent.previousIndicators[SYMBOL] = { rsi: 32, macdHistogram: 0 };

    expect(agent.shouldEmitSignal(SYMBOL, 'meanReversion', 28, 0, now + 1000)).toBe(true);
    // But NOT if RSI is still just drifting within oversold territory (no fresh cross).
    agent.previousIndicators[SYMBOL] = { rsi: 25, macdHistogram: 0 };
    expect(agent.shouldEmitSignal(SYMBOL, 'meanReversion', 24, 0, now + 1000)).toBe(false);
  });

  it('re-emits immediately on RSI crossing up through 75 into overbought, even inside the cooldown', () => {
    const now = Date.now();
    agent.markEmitted(SYMBOL, 'overbought', now);
    agent.previousIndicators[SYMBOL] = { rsi: 74, macdHistogram: 0 };

    expect(agent.shouldEmitSignal(SYMBOL, 'overbought', 76, 0, now + 1000)).toBe(true);
  });

  it('debounces momentumBreakout and meanReversion independently for the same symbol', () => {
    const now = Date.now();
    agent.markEmitted(SYMBOL, 'momentumBreakout', now);
    agent.previousIndicators[SYMBOL] = { rsi: 60, macdHistogram: 0.5 };

    // momentumBreakout is on cooldown with no transition - meanReversion has never fired, so it
    // should still pass independently.
    expect(agent.shouldEmitSignal(SYMBOL, 'momentumBreakout', 60, 0.5, now + 1000)).toBe(false);
    expect(agent.shouldEmitSignal(SYMBOL, 'meanReversion', 60, 0.5, now + 1000)).toBe(true);
  });
});

describe('TechnicalAgent.analyzeTick integration - debounce prevents duplicate emission end to end', () => {
  const agent = technicalAgent as any;
  // <=5 letters - looksLikeListedTicker/gateTradeIdea (DEF-24) silently routes anything longer to
  // TRADE_IDEA_REJECTED instead of TRADE_IDEA_GENERATED (confirmed the hard way: the original
  // 'DBEND2E' symbol here made every test in this block pass vacuously against a rejected idea).
  const SYMBOL = 'DBEND';

  afterEach(() => {
    delete agent.priceHistory[SYMBOL];
    delete agent.lastEvaluatedAt[SYMBOL];
    delete agent.previousIndicators[SYMBOL];
    delete agent.lastEmittedAt[SYMBOL];
  });

  it('emits a real regime string on TRADE_IDEA_GENERATED (Phase 6/7 - regime captured at generation time)', () => {
    const originalEnabled = tradingEngine.state.enabled;
    const originalTradingState = tradingEngine.state.tradingState;
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const emitted: any[] = [];
    const listener = (idea: any) => emitted.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);
    try {
      const bars = quantThresholds.technicalHistoryBars;
      // Known-good momentumBreakout fixture (see technicalSignal.test.ts's risingTrendPrices) - a
      // pure monotonic ramp pins RSI near 100, which fails the rule's rsi<70 condition; two
      // up-ticks per one larger down-tick lands RSI ~66-67, inside the healthy-uptrend band.
      let p = 100;
      for (let i = 0; i < bars; i++) {
        p += (i % 3 === 2) ? -1.15 : 1.0;
        agent.analyzeTick({ symbol: SYMBOL, price: p, volume: 1, timestamp: new Date().toISOString() });
      }
      const mine = emitted.find((i) => i.symbol === SYMBOL);
      expect(mine).toBeDefined();
      expect(typeof mine.regime).toBe('string');
      expect(mine.regime).toMatch(/^(BULLISH_TREND|BEARISH_TREND|SIDEWAYS_RANGE)\/(HIGH|LOW|NORMAL)$/);
    } finally {
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);
      tradingEngine.state.enabled = originalEnabled;
      tradingEngine.state.tradingState = originalTradingState;
    }
  });

  it('a still-true momentumBreakout condition across repeated post-cooldown evaluations emits only once until technicalSignalCooldownMs elapses', () => {
    const originalEnabled = tradingEngine.state.enabled;
    const originalTradingState = tradingEngine.state.tradingState;
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    const emitted: any[] = [];
    const listener = (idea: any) => emitted.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);
    try {
      // Known-good momentumBreakout fixture (see technicalSignal.test.ts's risingTrendPrices): RSI
      // settles ~66, inside the 50-70 momentum band, with MACD bullish - a pure uniform ramp pins
      // RSI near 100 and never actually fires the rule (confirmed the hard way while writing this).
      const bars = quantThresholds.technicalHistoryBars;
      let p = 100;
      let i = 0;
      for (; i < bars; i++) {
        p += (i % 3 === 2) ? -1.15 : 1.0;
        agent.analyzeTick({ symbol: SYMBOL, price: p, volume: 1, timestamp: new Date().toISOString() });
      }
      const firstCount = emitted.filter((e) => e.symbol === SYMBOL).length;
      expect(firstCount).toBe(1); // the fixture must genuinely fire once - not a vacuous 0-vs-0 check

      // Force the evaluation cooldown to have elapsed (so checkStrategies genuinely re-runs) many
      // times in a row, continuing the identical oscillation pattern so the signal state stays
      // "still true" rather than reverting to a flat ramp that would itself be a state transition.
      for (let j = 0; j < 10; j++, i++) {
        agent.lastEvaluatedAt[SYMBOL] = Date.now() - quantThresholds.technicalEvaluationCooldownMs - 1;
        p += (i % 3 === 2) ? -1.15 : 1.0;
        agent.analyzeTick({ symbol: SYMBOL, price: p, volume: 1, timestamp: new Date().toISOString() });
      }
      const afterRepeatedEvalCount = emitted.filter((e) => e.symbol === SYMBOL).length;

      // Without the debounce this would have re-emitted on every one of those 10 re-evaluations.
      expect(afterRepeatedEvalCount).toBeLessThanOrEqual(firstCount + 1);
    } finally {
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);
      tradingEngine.state.enabled = originalEnabled;
      tradingEngine.state.tradingState = originalTradingState;
    }
  });
});
