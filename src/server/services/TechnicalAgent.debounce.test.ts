import { describe, it, expect, afterEach } from 'vitest';
import { technicalAgent } from './TechnicalAgent';
import { quantThresholds } from '../config/quantThresholds';
import { eventBus } from '../core/EventBus';
import { tradingEngine } from '../engines/TradingEngine';
import { setActiveReplaySession, type ActiveReplaySession } from '../replay/ReplayContext';

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
      // Known-good momentumBreakout fixture (see technicalSignal.test.ts's risingTrendPrices for
      // the full explanation, including the 2026-09-22 MACDEngine seeding-bug fix rationale): RSI
      // settles ~66, inside the 50-70 momentum band. A pure uniform ramp pins RSI near 100 and
      // never fires the rule at all; a constant-rate trend run for the FULL window (no flat
      // lead-in) lets the MACD histogram decay back toward zero as the signal line catches up -
      // fragile/flickering right at this test's checkpoints under the corrected (properly
      // SMA-seeded) EMA math. Flat lead-in + a SHORT (10-bar) trend onset keeps the histogram
      // robustly positive at both the bar-50 and bar-60 checkpoints (empirically swept against
      // the real evaluateTechnicalSignals: histogram +0.29 at bar 50, +0.26 at bar 60, comfortably
      // clear of the flickering zone larger onset windows fall into as the trend matures).
      const bars = quantThresholds.technicalHistoryBars;
      const trendBars = 10;
      const flatBars = Math.max(0, bars - trendBars);
      let p = 100;
      let i = 0;
      for (; i < flatBars; i++) {
        p = 100 + Math.sin(i / 7) * 0.3;
        agent.analyzeTick({ symbol: SYMBOL, price: p, volume: 1, timestamp: new Date().toISOString() });
      }
      let trendTick = 0;
      for (; i < bars; i++, trendTick++) {
        p += (trendTick % 3 === 2) ? -1.15 : 1.0;
        agent.analyzeTick({ symbol: SYMBOL, price: p, volume: 1, timestamp: new Date().toISOString() });
      }
      const firstCount = emitted.filter((e) => e.symbol === SYMBOL).length;
      expect(firstCount).toBe(1); // the fixture must genuinely fire once - not a vacuous 0-vs-0 check

      // Force the evaluation cooldown to have elapsed (so checkStrategies genuinely re-runs) many
      // times in a row, continuing the identical oscillation pattern so the signal state stays
      // "still true" rather than reverting to a flat ramp that would itself be a state transition.
      for (let j = 0; j < 10; j++, i++, trendTick++) {
        agent.lastEvaluatedAt[SYMBOL] = Date.now() - quantThresholds.technicalEvaluationCooldownMs - 1;
        p += (trendTick % 3 === 2) ? -1.15 : 1.0;
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

/**
 * Real gap found and fixed (2026-09-14, Synthetic Market Session Simulator certification):
 * technicalEvaluationCooldownMs is a genuine, necessary real-wall-clock throttle for LIVE tick-rate
 * MARKET_DATA (see the crash incident documented on TechnicalProposerAgent's own priceHistory
 * field). A replay-shaped session (Historical Evaluation, or the Synthetic Market Session Simulator)
 * drives this same live class via real MARKET_DATA events but paces delivery far faster than real
 * time, so a Date.now()-based cooldown would only ever allow ONE evaluation per session regardless
 * of how many simulated minutes of genuine opportunity pass. debounceNowMs() fixes this by reading
 * the active replay session's own clock when one is installed - these tests prove both halves: the
 * redirection actually happens, and live behavior (no active session) is unchanged.
 */
describe('TechnicalAgent debounce is replay-clock-aware when a replay session is active', () => {
  const agent = technicalAgent as any;
  const SYMBOL = 'RPDBG';

  afterEach(() => {
    setActiveReplaySession(null);
    delete agent.priceHistory[SYMBOL];
    delete agent.lastEvaluatedAt[SYMBOL];
    delete agent.previousIndicators[SYMBOL];
    delete agent.lastEmittedAt[SYMBOL];
  });

  function fakeReplaySession(nowFn: () => number): ActiveReplaySession {
    return { clock: { now: nowFn } } as unknown as ActiveReplaySession;
  }

  it('debounceNowMs() reads the active replay session clock instead of Date.now() when one is installed', () => {
    setActiveReplaySession(fakeReplaySession(() => 123456789));
    expect(agent.debounceNowMs()).toBe(123456789);
  });

  it('debounceNowMs() falls back to real Date.now() when no replay session is active - live behavior unchanged', () => {
    setActiveReplaySession(null);
    const before = Date.now();
    const value = agent.debounceNowMs();
    const after = Date.now();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(after);
  });

  it('analyzeTick re-evaluates on simulated-clock elapsed time even when almost no real wall-clock time has passed', () => {
    const originalEnabled = tradingEngine.state.enabled;
    const originalTradingState = tradingEngine.state.tradingState;
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    // Simulated clock starts far in the future of technicalEvaluationCooldownMs so the very first
    // warmup-completing tick's "last - 0" comparison isn't accidentally always-pass for an unrelated
    // reason - then advances in large simulated jumps between ticks, far exceeding
    // technicalEvaluationCooldownMs each time, while real wall-clock time barely moves at all.
    let simulatedNowMs = quantThresholds.technicalEvaluationCooldownMs * 100;
    setActiveReplaySession(fakeReplaySession(() => simulatedNowMs));

    const emitted: any[] = [];
    const listener = (idea: any) => emitted.push(idea);
    eventBus.subscribe('TRADE_IDEA_GENERATED', listener);
    try {
      const bars = quantThresholds.technicalHistoryBars;
      let p = 100;
      let i = 0;
      for (; i < bars; i++) {
        p += (i % 3 === 2) ? -1.15 : 1.0;
        agent.analyzeTick({ symbol: SYMBOL, price: p, volume: 1, timestamp: new Date().toISOString() });
      }
      const firstCount = emitted.filter((e) => e.symbol === SYMBOL).length;
      expect(firstCount).toBe(1); // the fixture genuinely fires once, same as the plain-Date.now() case above

      // Advance the SIMULATED clock well past technicalEvaluationCooldownMs (real wall-clock time:
      // effectively zero) and re-run the identical oscillation so the signal state stays "still
      // true" - checkStrategies must genuinely re-run here, proving the gate is keyed off the
      // replay session's clock, not real elapsed milliseconds.
      for (let j = 0; j < 5; j++, i++) {
        simulatedNowMs += quantThresholds.technicalEvaluationCooldownMs + 1;
        p += (i % 3 === 2) ? -1.15 : 1.0;
        agent.analyzeTick({ symbol: SYMBOL, price: p, volume: 1, timestamp: new Date().toISOString() });
      }
      // lastEvaluatedAt must have actually advanced to the simulated clock's value, proving
      // checkStrategies re-ran on simulated time rather than staying stuck at its first value.
      expect(agent.lastEvaluatedAt[SYMBOL]).toBe(simulatedNowMs);
    } finally {
      eventBus.unsubscribe('TRADE_IDEA_GENERATED', listener);
      tradingEngine.state.enabled = originalEnabled;
      tradingEngine.state.tradingState = originalTradingState;
    }
  });
});
