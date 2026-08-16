import { describe, it, expect } from 'vitest';
import { baseFixture } from './testHelpers';
import { evaluateAll, findStrategy, ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES } from './StrategyEngine';
import { quantExperimentalStrategies } from '../../config/quantExperimentalStrategies';
import { allTaxonomyTechniques, codedModuleIdsFromTaxonomy } from '../../config/quantStrategyTaxonomy';
import { maCrossover } from './maCrossover';
import { oscillatorMomentum } from './oscillatorMomentum';
import { bollingerVolatility } from './bollingerVolatility';
import { previousPeriodBreakout } from './previousPeriodBreakout';
import { candlestickReversal } from './candlestickReversal';
import { gapContinuation } from './gapContinuation';
import { fibonacciPullback } from './fibonacciPullback';
import { volumeConfirmation } from './volumeConfirmation';
import { srBounce } from './srBounce';
import { relativeStrengthRotation } from './relativeStrengthRotation';

const t = quantExperimentalStrategies.thresholds;

describe('experimental family strategies + taxonomy', () => {
  it('keeps live evaluateAll at five CORE strategies while every config id is findStrategy-able', () => {
    const configIds = quantExperimentalStrategies.strategies.map(s => s.id);
    expect(EXPERIMENTAL_STRATEGIES.map(s => s.id)).toEqual(configIds);
    expect(ALL_STRATEGIES).toHaveLength(5);
    const live = evaluateAll(baseFixture());
    expect(live).toHaveLength(5);
    for (const id of configIds) {
      expect(findStrategy(id)?.id).toBe(id);
      expect(live.map(r => r.strategy)).not.toContain(id);
    }
  });

  it('maps 760 named techniques; CORE/EXPERIMENTAL moduleIds exist; NOT_SUPPORTED has reasons', () => {
    const techniques = allTaxonomyTechniques();
    expect(techniques).toHaveLength(760);
    const nums = techniques.map(x => x.n).sort((a, b) => a - b);
    expect(nums[0]).toBe(1);
    expect(nums[759]).toBe(760);
    const known = new Set([...ALL_STRATEGIES, ...EXPERIMENTAL_STRATEGIES].map(s => s.id));
    for (const tech of techniques) {
      if (tech.status === 'NOT_SUPPORTED') {
        expect(tech.reason && tech.reason.length > 0).toBe(true);
        expect(tech.moduleId).toBeUndefined();
      } else {
        expect(tech.moduleId && known.has(tech.moduleId)).toBe(true);
      }
    }
    for (const id of codedModuleIdsFromTaxonomy()) {
      expect(known.has(id)).toBe(true);
    }
  });

  it('MA_CROSSOVER scores a golden-cross stack', () => {
    const ctx = baseFixture();
    ctx.trend.movingAverages = { ...ctx.trend.movingAverages, sma50: 110, sma200: 90, ema9: 112, ema20: 108 };
    ctx.currentPrice = 111;
    ctx.trend.dmi.adx = t.adxTrendMin;
    ctx.regime.regime = 'BULLISH_TREND';
    const result = maCrossover.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('OSCILLATOR_MOMENTUM scores RSI/MACD/ROC alignment', () => {
    const ctx = baseFixture();
    ctx.momentum.rsi = t.rsiMidline + 5;
    ctx.momentum.macd.histogram = 0.2;
    ctx.momentum.roc = 1;
    ctx.trend.dmi = { plusDI: 30, minusDI: 15, adx: t.adxTrendMin };
    ctx.regime.regime = 'BULLISH_TREND';
    const result = oscillatorMomentum.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('BOLLINGER_VOLATILITY scores a Keltner expansion break', () => {
    const ctx = baseFixture();
    ctx.currentPrice = 106;
    ctx.volatility.keltner = { middle: 100, upper: 105, lower: 95 };
    ctx.volatility.regime = 'EXPANDING';
    ctx.volatility.bollingerBandWidthPct = t.bbSqueezeWidthPct;
    ctx.volume.relativeVolume = t.rvolContinuation;
    ctx.trend.dmi.adx = t.adxTrendMin;
    const result = bollingerVolatility.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('PREVIOUS_PERIOD_BREAKOUT scores a PDH break', () => {
    const ctx = baseFixture();
    ctx.supportResistance.previousDay = { high: 101, low: 90, close: 95 };
    ctx.currentPrice = 102;
    ctx.volume.relativeVolume = t.rvolBreakout;
    ctx.volatility.regime = 'EXPANDING';
    ctx.regime.regime = 'BULLISH_TREND';
    const result = previousPeriodBreakout.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('CANDLESTICK_REVERSAL scores a hammer at support', () => {
    const ctx = baseFixture();
    ctx.priceAction.candlestick = 'HAMMER';
    ctx.supportResistance.nearest.nearestSupport = { level: 99.8, abs: -0.2, pct: -0.2 };
    ctx.supportResistance.nearest.nearestResistance = { level: 110, abs: 10, pct: 10 };
    ctx.momentum.rsi = 45;
    const result = candlestickReversal.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('GAP_CONTINUATION scores a gap-up with RVOL and VWAP', () => {
    const ctx = baseFixture();
    ctx.priceAction.gap = { type: 'GAP_UP', sizePct: t.gapMinSizePct + 0.1 };
    ctx.volume.relativeVolume = t.rvolBreakout;
    ctx.volume.vwap.distancePct = 0.4;
    ctx.regime.regime = 'BULLISH_TREND';
    const result = gapContinuation.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('FIBONACCI_PULLBACK scores a 61.8% pullback in trend', () => {
    const ctx = baseFixture();
    ctx.supportResistance.fibonacci = { level0: 90, level236: 92, level382: 94, level500: 95, level618: 100, level786: 102, level100: 110 };
    ctx.currentPrice = 100;
    ctx.trend.structure.trend = 'UPTREND';
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.momentum.rsi = 50;
    ctx.volume.relativeVolume = 1;
    const result = fibonacciPullback.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('VOLUME_CONFIRMATION scores RVOL + CMF/MFI', () => {
    const ctx = baseFixture();
    ctx.volume.isSpike = true;
    ctx.volume.relativeVolume = t.rvolBreakout;
    ctx.volume.cmf = 0.1;
    ctx.volume.mfi = 60;
    ctx.trend.structure.event = 'NONE';
    ctx.regime.regime = 'BULLISH_TREND';
    const result = volumeConfirmation.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('SR_BOUNCE scores a hammer at support without a volume spike', () => {
    const ctx = baseFixture();
    ctx.supportResistance.nearest.nearestSupport = { level: 99.8, abs: -0.2, pct: -0.2 };
    ctx.supportResistance.nearest.nearestResistance = { level: 110, abs: 10, pct: 10 };
    ctx.priceAction.candlestick = 'HAMMER';
    ctx.volume.relativeVolume = 1;
    const result = srBounce.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });

  it('RELATIVE_STRENGTH_ROTATION scores vs-SPY RS + sector', () => {
    const ctx = baseFixture();
    ctx.marketContext.relativeStrengthVsSPY = {
      vsSymbol: 'SPY',
      periodPct: 3,
      benchmarkPeriodPct: 1,
      relativeStrengthPct: 2,
      correlation: null,
      beta: null,
      source: 'test',
    };
    ctx.regime.regime = 'BULLISH_TREND';
    ctx.marketContext.sector = {
      name: 'Technology',
      etf: 'XLK',
      trend: { symbol: 'XLK', regime: { ...ctx.regime, regime: 'BULLISH_TREND' }, source: 'test' },
    };
    ctx.trend.dmi.adx = t.adxTrendMin;
    const result = relativeStrengthRotation.evaluate(ctx);
    expect(result.side).toBe('BUY');
    expect(result.setupScore).toBe(100);
  });
});
