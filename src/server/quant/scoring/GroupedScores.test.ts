import { describe, it, expect } from 'vitest';
import { computeGroupedScores, GroupedScoresInput } from './GroupedScores';

function baseInput(): GroupedScoresInput {
  return {
    trend: {
      movingAverages: { sma20: 100, sma50: 100, sma100: 100, sma200: 100, ema9: 100, ema20: 100, ema50: 100, ema200: 100 },
      priceVsSMA20: { diff: 0, diffPct: 0, above: false },
      priceVsSMA50: { diff: 0, diffPct: 0, above: false },
      priceVsSMA200: { diff: 0, diffPct: 0, above: false },
      sma50SlopePct: 0,
      dmi: { plusDI: 20, minusDI: 20, adx: 10 },
      structure: { trend: 'SIDEWAYS', event: 'NONE', lastSwingHigh: null, lastSwingLow: null },
    },
    momentum: { rsi: 50, macd: { macd: 0, signal: 0, histogram: 0 }, stochasticRSI: 50, roc: 0, momentum: 0, williamsR: -50, cci: 0 },
    volatility: { atr: 1, atrPercent: 1, historicalVolatilityPct: 20, volatilityPercentile: 50, bollingerBandWidthPct: 5, keltner: { middle: 100, upper: 105, lower: 95 }, regime: 'STABLE' },
    volume: { volumeSMA20: 1_000_000, relativeVolume: 1, isSpike: false, volumeROC: 0, obv: 0, mfi: 50, vwap: { vwap: 100, distancePct: 0, slopePct: 0, event: 'NONE' }, cmf: 0, ad: 0 },
    priceAction: { gap: { type: null, sizePct: null }, consolidating: false, rangeRegime: 'STABLE', candlestick: null },
    regime: { regime: 'SIDEWAYS_RANGE', trendStrength: 10, volatility: 'NORMAL', marketStructure: 'CHOPPY', confidence: 0.3, features: {} as any, insufficientData: false },
    marketContext: {
      spy: { symbol: 'SPY', regime: null, source: 'test' },
      qqq: { symbol: 'QQQ', regime: null, source: 'test' },
      iwm: { symbol: 'IWM', regime: null, source: 'test' },
      sector: { name: null, etf: null, trend: null },
      relativeStrengthVsSPY: null,
      relativeStrengthVsSector: null,
      breadth: { available: false, reason: 'test' },
    },
  };
}

function bullishRegime(confidence = 0.8, trendStrength = 80) {
  return { regime: 'BULLISH_TREND' as const, trendStrength, volatility: 'NORMAL' as const, marketStructure: 'TRENDING' as const, confidence, features: {} as any, insufficientData: false };
}

describe('computeGroupedScores - neutral input', () => {
  it('reports every score at (or near) neutral 50 when every input is genuinely neutral', () => {
    const result = computeGroupedScores(baseInput(), 'BUY');
    expect(result.trendScore).toBe(50);
    expect(result.momentumScore).toBe(50);
    expect(result.volatilityScore).toBe(50);
    expect(result.vwapScore).toBe(50);
    expect(result.marketScore).toBe(50);
    expect(result.sectorScore).toBe(50);
    expect(result.relativeStrengthScore).toBe(50);
    expect(result.priceStructureScore).toBe(50);
    expect(result.overallSetupScore).toBe(50);
  });

  it('reports dataCompletePct honestly reflecting how much real (non-fallback) data was available', () => {
    const input = baseInput();
    // Nothing in the base fixture provides a real relativeStrength/market/sector read - those 3
    // signals are genuinely absent, not neutral-by-computation.
    const result = computeGroupedScores(input, 'BUY');
    expect(result.dataCompletePct).toBeLessThan(100);
    expect(result.dataCompletePct).toBeGreaterThan(0);
  });
});

describe('computeGroupedScores - trendScore (reuses RegimeEngine, does not re-derive trend)', () => {
  it('scores high for BUY under a strong, confident BULLISH_TREND regime', () => {
    const input = baseInput();
    input.regime = bullishRegime(0.9, 90);
    const result = computeGroupedScores(input, 'BUY');
    expect(result.trendScore).toBeGreaterThan(80);
  });

  it('mirrors exactly: the same bullish regime scores low for a SELL candidate', () => {
    const input = baseInput();
    input.regime = bullishRegime(0.9, 90);
    const buyResult = computeGroupedScores(input, 'BUY');
    const sellResult = computeGroupedScores(input, 'SELL');
    expect(sellResult.trendScore).toBe(100 - buyResult.trendScore);
  });

  it('reports an honest neutral (not a fabricated lean) for a genuine SIDEWAYS_RANGE regime', () => {
    const input = baseInput(); // already SIDEWAYS_RANGE
    const result = computeGroupedScores(input, 'BUY');
    expect(result.trendScore).toBe(50);
  });
});

describe('computeGroupedScores - momentumScore (correlated-oscillator collapse)', () => {
  it('blends the 4 correlated oscillators into ONE reading, not 4 independent votes', () => {
    const allBullishOscillators = baseInput();
    allBullishOscillators.momentum = { rsi: 70, macd: { macd: 0, signal: 0, histogram: 0 }, stochasticRSI: 70, roc: null, momentum: null, williamsR: -30, cci: 75 };

    const oneBullishOscillator = baseInput();
    oneBullishOscillator.momentum = { rsi: 70, macd: { macd: 0, signal: 0, histogram: 0 }, stochasticRSI: 50, roc: null, momentum: null, williamsR: -50, cci: 0 };

    const scoreAllFour = computeGroupedScores(allBullishOscillators, 'BUY').momentumScore;
    const scoreOneOnly = computeGroupedScores(oneBullishOscillator, 'BUY').momentumScore;

    // If these were independent votes, 4 agreeing oscillators would score dramatically higher than
    // 1. Because they're averaged into a single oscillator-family reading first, the jump from "1
    // agreeing" to "4 agreeing" is real but bounded - not a 4x amplification.
    expect(scoreAllFour).toBeGreaterThan(scoreOneOnly);
    expect(scoreAllFour).toBeLessThan(scoreOneOnly + 25);
  });

  it('blends the oscillator-family reading with a separate MACD/ROC trend-momentum reading, not a vote count over 6 fields', () => {
    const input = baseInput();
    input.momentum = { rsi: 50, macd: { macd: 2, signal: 0.5, histogram: 1.5 }, stochasticRSI: 50, roc: 8, momentum: null, williamsR: -50, cci: 0 };
    const result = computeGroupedScores(input, 'BUY');
    expect(result.momentumScore).toBeGreaterThan(50); // real bullish MACD/ROC signal, even with neutral oscillators
  });

  it('mirrors exactly for a SELL candidate', () => {
    const input = baseInput();
    input.momentum = { rsi: 25, macd: { macd: -2, signal: -0.5, histogram: -1.5 }, stochasticRSI: 20, roc: -8, momentum: null, williamsR: -80, cci: -80 };
    const buyResult = computeGroupedScores(input, 'BUY');
    const sellResult = computeGroupedScores(input, 'SELL');
    expect(sellResult.momentumScore).toBe(100 - buyResult.momentumScore);
  });
});

describe('computeGroupedScores - volatilityScore (non-directional)', () => {
  it('reports the real volatilityPercentile directly, identical for BUY and SELL', () => {
    const input = baseInput();
    input.volatility.volatilityPercentile = 85;
    const buyResult = computeGroupedScores(input, 'BUY');
    const sellResult = computeGroupedScores(input, 'SELL');
    expect(buyResult.volatilityScore).toBe(85);
    expect(sellResult.volatilityScore).toBe(85); // non-directional - identical regardless of side
  });

  it('is honestly neutral, not fabricated, when volatilityPercentile is not computable', () => {
    const input = baseInput();
    input.volatility.volatilityPercentile = null;
    expect(computeGroupedScores(input, 'BUY').volatilityScore).toBe(50);
  });
});

describe('computeGroupedScores - volumeScore', () => {
  it('requires a real directional CMF read before leaning either way - conviction alone (RVOL) never implies a direction', () => {
    const input = baseInput();
    input.volume.relativeVolume = 3; // strong real participation
    input.volume.cmf = null; // but no real directional money-flow read
    expect(computeGroupedScores(input, 'BUY').volumeScore).toBe(50);
  });

  it('leans toward BUY when real money flow (CMF) is positive, amplified by real conviction (RVOL)', () => {
    const lowConviction = baseInput();
    lowConviction.volume.relativeVolume = 1;
    lowConviction.volume.cmf = 0.15;

    const highConviction = baseInput();
    highConviction.volume.relativeVolume = 3;
    highConviction.volume.cmf = 0.15;

    const lowScore = computeGroupedScores(lowConviction, 'BUY').volumeScore;
    const highScore = computeGroupedScores(highConviction, 'BUY').volumeScore;
    expect(lowScore).toBeGreaterThan(50);
    expect(highScore).toBeGreaterThan(lowScore); // same directional flow, more real conviction -> stronger score
  });
});

describe('computeGroupedScores - vwapScore', () => {
  it('scores above neutral for BUY when price sits above session VWAP', () => {
    const input = baseInput();
    input.volume.vwap = { vwap: 98, distancePct: 0.8, slopePct: 0.2, event: 'NONE' };
    expect(computeGroupedScores(input, 'BUY').vwapScore).toBeGreaterThan(50);
  });

  it('gives an additional real nudge for a RECLAIM event beyond the raw distance alone', () => {
    const withoutEvent = baseInput();
    withoutEvent.volume.vwap = { vwap: 99, distancePct: 0.3, slopePct: 0, event: 'NONE' };
    const withReclaim = baseInput();
    withReclaim.volume.vwap = { vwap: 99, distancePct: 0.3, slopePct: 0, event: 'RECLAIM' };

    const scoreWithout = computeGroupedScores(withoutEvent, 'BUY').vwapScore;
    const scoreWith = computeGroupedScores(withReclaim, 'BUY').vwapScore;
    expect(scoreWith).toBeGreaterThan(scoreWithout);
  });
});

describe('computeGroupedScores - marketScore / sectorScore (benchmark alignment)', () => {
  it('scores marketScore high for BUY when SPY itself is in a real confident BULLISH_TREND', () => {
    const input = baseInput();
    input.marketContext.spy = { symbol: 'SPY', regime: bullishRegime(), source: 'test' };
    expect(computeGroupedScores(input, 'BUY').marketScore).toBeGreaterThan(70);
  });

  it('scores sectorScore high for BUY when the sector ETF is in a real confident BULLISH_TREND', () => {
    const input = baseInput();
    input.marketContext.sector = { name: 'Technology', etf: 'XLK', trend: { symbol: 'XLK', regime: bullishRegime(), source: 'test' } };
    expect(computeGroupedScores(input, 'BUY').sectorScore).toBeGreaterThan(70);
  });

  it('is honestly neutral when no sector could be resolved for the symbol', () => {
    const input = baseInput(); // sector.trend is null by default
    expect(computeGroupedScores(input, 'BUY').sectorScore).toBe(50);
  });
});

describe('computeGroupedScores - relativeStrengthScore', () => {
  it('scores high for BUY when the symbol real-outperformed SPY over the lookback window', () => {
    const input = baseInput();
    input.marketContext.relativeStrengthVsSPY = { vsSymbol: 'SPY', periodPct: 8, benchmarkPeriodPct: 2, relativeStrengthPct: 6, correlation: 0.5, beta: 1.2, source: 'test' };
    expect(computeGroupedScores(input, 'BUY').relativeStrengthScore).toBeGreaterThan(50);
  });

  it('mirrors exactly for SELL', () => {
    const input = baseInput();
    input.marketContext.relativeStrengthVsSPY = { vsSymbol: 'SPY', periodPct: -8, benchmarkPeriodPct: 2, relativeStrengthPct: -10, correlation: 0.5, beta: 1.2, source: 'test' };
    const buyResult = computeGroupedScores(input, 'BUY');
    const sellResult = computeGroupedScores(input, 'SELL');
    expect(sellResult.relativeStrengthScore).toBe(100 - buyResult.relativeStrengthScore);
  });
});

describe('computeGroupedScores - priceStructureScore', () => {
  it('scores high for BUY on a real bullish structural break (BOS_BULLISH)', () => {
    const input = baseInput();
    input.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    expect(computeGroupedScores(input, 'BUY').priceStructureScore).toBeGreaterThan(50);
  });

  it('combines structure + candlestick + gap as up to 3 real votes, not a single field', () => {
    const structureOnly = baseInput();
    structureOnly.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };

    const allThree = baseInput();
    allThree.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };
    allThree.priceAction = { gap: { type: 'GAP_UP', sizePct: 1.2 }, consolidating: false, rangeRegime: 'EXPANDING', candlestick: 'BULLISH_ENGULFING' };

    const scoreOne = computeGroupedScores(structureOnly, 'BUY').priceStructureScore;
    const scoreAll = computeGroupedScores(allThree, 'BUY').priceStructureScore;
    expect(scoreAll).toBeGreaterThanOrEqual(scoreOne);
  });
});

describe('computeGroupedScores - overallSetupScore', () => {
  it('is a real weighted blend that rewards a genuinely strong multi-factor setup, not just one strong factor', () => {
    const weak = baseInput();
    weak.regime = bullishRegime(0.9, 90); // only trend is strong

    const strong = baseInput();
    strong.regime = bullishRegime(0.9, 90);
    strong.momentum = { rsi: 70, macd: { macd: 2, signal: 0.5, histogram: 1.5 }, stochasticRSI: 70, roc: 8, momentum: 5, williamsR: -20, cci: 80 };
    strong.marketContext.spy = { symbol: 'SPY', regime: bullishRegime(), source: 'test' };
    strong.marketContext.sector = { name: 'Technology', etf: 'XLK', trend: { symbol: 'XLK', regime: bullishRegime(), source: 'test' } };
    strong.marketContext.relativeStrengthVsSPY = { vsSymbol: 'SPY', periodPct: 8, benchmarkPeriodPct: 2, relativeStrengthPct: 6, correlation: 0.5, beta: 1.2, source: 'test' };
    strong.volume.cmf = 0.15;
    strong.volume.vwap = { vwap: 98, distancePct: 0.8, slopePct: 0.2, event: 'RECLAIM' };
    strong.trend.structure = { trend: 'UPTREND', event: 'BOS_BULLISH', lastSwingHigh: 105, lastSwingLow: 95 };

    const weakScore = computeGroupedScores(weak, 'BUY').overallSetupScore;
    const strongScore = computeGroupedScores(strong, 'BUY').overallSetupScore;
    expect(strongScore).toBeGreaterThan(weakScore);
    expect(strongScore).toBeGreaterThan(75);
  });

  it('excludes volatilityScore from the blend - two setups differing ONLY in volatility percentile score identically', () => {
    const calm = baseInput();
    calm.regime = bullishRegime();
    calm.volatility.volatilityPercentile = 10;

    const volatile = baseInput();
    volatile.regime = bullishRegime();
    volatile.volatility.volatilityPercentile = 90;

    // NOTE: intentionally only volatilityPercentile differs between the two fixtures.
    const calmResult = computeGroupedScores(calm, 'BUY');
    const volatileResult = computeGroupedScores(volatile, 'BUY');
    expect(calmResult.overallSetupScore).toBe(volatileResult.overallSetupScore);
    expect(calmResult.volatilityScore).not.toBe(volatileResult.volatilityScore);
  });
});
