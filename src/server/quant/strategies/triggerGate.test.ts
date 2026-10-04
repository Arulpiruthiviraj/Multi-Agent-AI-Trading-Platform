/**
 * Trigger-gate tests (2026-10-04 fix verification).
 *
 * Every strategy declares StrategyEvaluation.triggerMet - whether its DEFINING trigger event
 * actually occurred. evaluateAll() caps confidence below MIN_STRATEGY_CONFIDENCE_TO_TRADE when
 * the trigger is absent, so confirming conditions can never outvote a missing trigger into a
 * trade idea. These tests prove the negative path for every strategy: no trigger -> no emission.
 */
import { describe, it, expect } from 'vitest';
import { evaluateAll, bestStrategyIdea, MIN_STRATEGY_CONFIDENCE_TO_TRADE } from './StrategyEngine';
import { baseFixture } from './testHelpers';
import { momentumBreakout } from './momentumBreakout';
import { trendFollowing } from './trendFollowing';
import { pullbackContinuation } from './pullbackContinuation';
import { meanReversion } from './meanReversion';
import { rangeReversion } from './rangeReversion';
import { maCrossover } from './maCrossover';
import { donchianBreakout } from './donchianBreakout';
import { gapContinuation } from './gapContinuation';
import { previousPeriodBreakout } from './previousPeriodBreakout';
import { openingRangeBreakout } from './openingRangeBreakout';
import { candlestickReversal } from './candlestickReversal';
import { oscillatorMomentum } from './oscillatorMomentum';
import { bollingerVolatility } from './bollingerVolatility';
import { volumeConfirmation } from './volumeConfirmation';
import { vwapVolumeStructure } from './vwapVolumeStructure';
import { vwapMeanReversion } from './vwapMeanReversion';
import { fibonacciPullback } from './fibonacciPullback';
import { srBounce } from './srBounce';
import { statisticalMeanReversion } from './statisticalMeanReversion';
import { relativeStrengthRotation } from './relativeStrengthRotation';
import { smcLiquiditySweep } from './smcLiquiditySweep';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';

const t = quantExperimentalStrategies.thresholds;

function bullishSectorTrend() {
  return {
    symbol: 'XLK',
    regime: {
      regime: 'BULLISH_TREND', trendStrength: 80, volatility: 'NORMAL',
      marketStructure: 'TRENDING', confidence: 0.8, features: {} as any, insufficientData: false,
    },
    source: 'test',
  } as any;
}

describe('trigger gate - engine', () => {
  it('caps confidence below the trade bar when the trigger did not fire, without rewriting the honest score', () => {
    const ctx = baseFixture();
    // Bullish backdrop, but NO structural break - the old code emitted this at 88 confidence.
    ctx.trend.structure = { trend: 'UPTREND', event: 'NONE', lastSwingHigh: 105, lastSwingLow: 95 };
    ctx.volume.relativeVolume = 2.0;
    ctx.volatility.regime = 'EXPANDING';
    ctx.volume.vwap = { vwap: 98, distancePct: 2, slopePct: 1, event: 'RECLAIM', intradayBased: true };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.marketContext.sector.trend = bullishSectorTrend();
    ctx.marketContext.relativeStrengthVsSPY = { vsSymbol: 'SPY', periodPct: 5, benchmarkPeriodPct: 2, relativeStrengthPct: 3, correlation: 0.5, beta: 1.1, source: 'test' } as any;
    ctx.momentum.roc = 4;

    const raw = momentumBreakout.evaluate(ctx);
    expect(raw.triggerMet).toBe(false);
    expect(raw.setupScore).toBe(88); // the honest fraction of conditions that held

    const results = evaluateAll(ctx);
    const mb = results.find(r => r.strategy === 'MOMENTUM_BREAKOUT')!;
    expect(mb.confidence).toBeLessThan(MIN_STRATEGY_CONFIDENCE_TO_TRADE);
    expect(mb.contradictions.some(c => c.includes('Defining trigger did not fire'))).toBe(true);

    const idea = bestStrategyIdea(results);
    expect(idea?.strategy).not.toBe('MOMENTUM_BREAKOUT');
  });

  it('does not cap a genuine triggered setup', () => {
    const ctx = baseFixture();
    ctx.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    ctx.volume.relativeVolume = 2.0;
    ctx.volatility.regime = 'EXPANDING';
    ctx.volume.vwap = { vwap: 98, distancePct: 2, slopePct: 1, event: 'RECLAIM', intradayBased: true };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.marketContext.sector.trend = bullishSectorTrend();
    ctx.marketContext.relativeStrengthVsSPY = { vsSymbol: 'SPY', periodPct: 5, benchmarkPeriodPct: 2, relativeStrengthPct: 3, correlation: 0.5, beta: 1.1, source: 'test' } as any;
    ctx.momentum.roc = 4;

    const results = evaluateAll(ctx);
    const mb = results.find(r => r.strategy === 'MOMENTUM_BREAKOUT')!;
    expect(mb.triggerMet).toBe(true);
    expect(mb.confidence).toBe(1);
    expect(bestStrategyIdea(results)?.strategy).toBe('MOMENTUM_BREAKOUT');
  });
});

describe('trigger gate - no trigger means triggerMet=false for every strategy', () => {
  it('MOMENTUM_BREAKOUT: no BOS event', () => {
    expect(momentumBreakout.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('TREND_FOLLOWING: ranging regime with aligned MAs still has no trend to follow', () => {
    const ctx = baseFixture();
    ctx.trend.movingAverages.sma20 = 105;
    ctx.trend.movingAverages.sma50 = 102;
    ctx.trend.movingAverages.sma200 = 98;
    ctx.trend.dmi = { plusDI: 30, minusDI: 15, adx: 30 };
    ctx.momentum.macd = { macd: 1, signal: 0.5, histogram: 0.5 };
    ctx.volume.cmf = 0.1;
    const r = trendFollowing.evaluate(ctx);
    expect(r.triggerMet).toBe(false);
    expect(r.setupScore).toBeGreaterThan(0); // confirming conditions pass - the gate is what stops emission
  });

  it('PULLBACK_CONTINUATION: sideways structure is not an established trend', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    expect(pullbackContinuation.evaluate(ctx).triggerMet).toBe(false);
  });

  it('MEAN_REVERSION: neutral RSI is not an extreme to fade', () => {
    expect(meanReversion.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('RANGE_REVERSION: mid-range price with no boundary nearby', () => {
    expect(rangeReversion.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('MA_CROSSOVER: flat MAs are not a stack', () => {
    expect(maCrossover.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('DONCHIAN_BREAKOUT: price inside the channel', () => {
    const ctx = baseFixture();
    ctx.supportResistance.priorChannel20 = { high: 105, low: 95, close: 100 };
    ctx.currentPrice = 100;
    expect(donchianBreakout.evaluate(ctx).triggerMet).toBe(false);
  });

  it('GAP_CONTINUATION: no gap', () => {
    expect(gapContinuation.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('PREVIOUS_PERIOD_BREAKOUT: no prior day, no break', () => {
    expect(previousPeriodBreakout.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('OPENING_RANGE_BREAKOUT: no opening range on daily bars', () => {
    expect(openingRangeBreakout.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('CANDLESTICK_REVERSAL: no pattern detected', () => {
    expect(candlestickReversal.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('OSCILLATOR_MOMENTUM: flat oscillators are not momentum', () => {
    expect(oscillatorMomentum.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('BOLLINGER_VOLATILITY: price inside the Keltner channel is not an expansion break', () => {
    expect(bollingerVolatility.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('VOLUME_CONFIRMATION: no volume spike', () => {
    expect(volumeConfirmation.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('VWAP_VOLUME_STRUCTURE: sideways structure has no trend to pull back in', () => {
    expect(vwapVolumeStructure.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('FIBONACCI_PULLBACK: no Fibonacci levels available', () => {
    expect(fibonacciPullback.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('SR_BOUNCE: no S/R level nearby', () => {
    expect(srBounce.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('STATISTICAL_MEAN_REVERSION: non-extreme z-score has nothing to revert', () => {
    expect(statisticalMeanReversion.evaluate(baseFixture()).triggerMet).toBe(false);
  });

  it('VWAP_MEAN_REVERSION: degenerate daily-bar VWAP is not a session anchor', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.regime.marketStructure = 'RANGING';
    // A large "distance" off a degenerate VWAP must not count as an extension.
    ctx.volume.vwap.distancePct = -t.vwapReversionDistancePct * 2;
    ctx.volume.vwap.intradayBased = false;
    const r = vwapMeanReversion.evaluate(ctx);
    expect(r.triggerMet).toBe(false);
    expect(r.contradictions.some(c => c.includes('No genuine session VWAP'))).toBe(true);
  });

  it('RELATIVE_STRENGTH_ROTATION: missing RS input means no rotation thesis', () => {
    const r = relativeStrengthRotation.evaluate(baseFixture());
    expect(r.triggerMet).toBe(false);
    expect(r.conditionsFailed.some(c => c.includes('not fabricated'))).toBe(true);
  });

  it('SMC_LIQUIDITY_SWEEP: no sweep at all', () => {
    const r = smcLiquiditySweep.evaluate(baseFixture());
    expect(r.triggerMet).toBe(false);
    expect(r.setupScore).toBe(0);
  });
});

describe('vwapMeanReversion stop fallback is side-aware', () => {
  it('SELL fade with no ATR stops above entry at nearest resistance, not below at support', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.regime.marketStructure = 'RANGING';
    ctx.volume.vwap.intradayBased = true;
    ctx.volume.vwap.distancePct = t.vwapReversionDistancePct; // extended ABOVE -> SELL fade
    ctx.volume.vwap.event = 'REJECTION';
    ctx.trend.dmi.adx = t.adxRangeMax - 1;
    ctx.volume.relativeVolume = 1;
    ctx.priceAction.candlestick = 'SHOOTING_STAR';
    ctx.volatility.atr = 0; // no ATR -> fallback branch
    ctx.supportResistance.nearest.nearestSupport = { level: 95, abs: -5, pct: -5 };
    ctx.supportResistance.nearest.nearestResistance = { level: 105, abs: 5, pct: 5 };

    const r = vwapMeanReversion.evaluate(ctx);
    expect(r.side).toBe('SELL');
    // The old code returned nearest support (95) here - below the entry, an immediately
    // violated stop for a short.
    expect(r.stop.price).toBe(105);
  });

  it('BUY fade with no ATR still stops below entry at nearest support', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'SIDEWAYS_RANGE';
    ctx.regime.marketStructure = 'RANGING';
    ctx.volume.vwap.intradayBased = true;
    ctx.volume.vwap.distancePct = -t.vwapReversionDistancePct; // extended BELOW -> BUY fade
    ctx.volume.vwap.event = 'RECLAIM';
    ctx.trend.dmi.adx = t.adxRangeMax - 1;
    ctx.volume.relativeVolume = 1;
    ctx.priceAction.candlestick = 'HAMMER';
    ctx.volatility.atr = 0;
    ctx.supportResistance.nearest.nearestSupport = { level: 95, abs: -5, pct: -5 };
    ctx.supportResistance.nearest.nearestResistance = { level: 105, abs: 5, pct: 5 };

    const r = vwapMeanReversion.evaluate(ctx);
    expect(r.side).toBe('BUY');
    expect(r.stop.price).toBe(95);
  });
});
