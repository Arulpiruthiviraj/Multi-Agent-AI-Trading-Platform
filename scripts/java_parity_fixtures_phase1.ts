import * as stats from '../src/server/quant/statistics';
import { riskRewardRatio, expectedValue, fractionalKelly } from '../src/server/quant/risk/ExpectedValue';
import { momentumBreakout } from '../src/server/quant/strategies/momentumBreakout';
import { pullbackContinuation } from '../src/server/quant/strategies/pullbackContinuation';
import { meanReversion } from '../src/server/quant/strategies/meanReversion';
import { trendFollowing } from '../src/server/quant/strategies/trendFollowing';
import { rangeReversion } from '../src/server/quant/strategies/rangeReversion';
import { StrategyContext } from '../src/server/quant/strategies/types';

function risingTrend(n: number, start: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += (i % 3 === 2) ? -1.15 : 1.0;
    out.push(Number(p.toFixed(4)));
  }
  return out;
}

function oscillating(n: number, start: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p += Math.sin(i / 3) * 2;
    out.push(Number(p.toFixed(4)));
  }
  return out;
}

const seriesA = risingTrend(60, 100);
const seriesB = oscillating(60, 100);

const statistics = {
  rollingMean20_A: stats.rollingMean(seriesA, 20),
  rollingStdDev20_A: stats.rollingStdDev(seriesA, 20),
  zScore20_A: stats.zScore(seriesA, 20),
  percentileRank_A_at110: stats.percentileRank(seriesA, 110),
  correlation_A_B: stats.correlation(seriesA, seriesB, 20),
  covariance_A_B: stats.covariance(seriesA, seriesB, 20),
  beta_A_vs_B: stats.beta(stats.rollingReturns(seriesA), stats.rollingReturns(seriesB), 20),
  skewness_A: stats.skewness(seriesA, 20),
  kurtosis_A: stats.kurtosis(seriesA, 20),
  autocorrelation_A_lag1: stats.autocorrelation(seriesA, 1, 20),
};

const ev = {
  riskReward_100_95_112: riskRewardRatio(100, 95, 112),
  expectedValue_p060_rr2_4: expectedValue(0.6, 2.4),
  kelly_insufficientSample: fractionalKelly(0.6, 2.0, 10),
  kelly_justified_uncapped: fractionalKelly(0.55, 1.8, 50),
  kelly_justified_capped: fractionalKelly(0.7, 3.0, 50),
  kelly_nonPositiveEdge: fractionalKelly(0.3, 1.0, 50),
};

// Synthetic StrategyContext fixtures - `as unknown as StrategyContext` bypasses populating every
// field of the full live interfaces (RegimeResult/MarketContextResult have many fields these 5
// strategies never read); only the fields these strategies actually access are populated, exactly
// matching what the Java StrategyContext record covers (see its own header comment on scope).
function makeContext(overrides: any): StrategyContext {
  const base = {
    symbol: 'TEST',
    currentPrice: 100,
    trend: {
      structure: { event: null, trend: null, lastSwingHigh: null, lastSwingLow: null },
      priceVsSMA20: { diffPct: 0, above: true },
      priceVsSMA200: { diffPct: 0, above: true },
      movingAverages: { sma20: 100, sma50: 100, sma200: 100 },
      dmi: null,
    },
    momentum: { rsi: 50, roc: 0, stochasticRSI: 50, macd: { macd: 0, signal: 0 } },
    volatility: { regime: null, atr: 1, keltner: null },
    volume: { relativeVolume: 1, vwap: { distancePct: 0 }, cmf: 0, isSpike: false },
    priceAction: { candlestick: null, consolidating: false },
    supportResistance: { nearest: { nearestResistance: null, nearestSupport: null } },
    regime: { regime: 'SIDEWAYS_RANGE', marketStructure: 'RANGING', trendStrength: 0 },
    marketContext: { sector: { trend: null }, relativeStrengthVsSPY: null },
  };
  return { ...base, ...overrides } as unknown as StrategyContext;
}

function pick(evaluation: any) {
  return {
    side: evaluation.side,
    setupScore: evaluation.setupScore,
    confidence: evaluation.confidence,
    conditionsMetCount: evaluation.conditionsMet.length,
    conditionsFailedCount: evaluation.conditionsFailed.length,
    contradictionsCount: evaluation.contradictions.length,
  };
}

const momentumBreakoutBullish = makeContext({
  currentPrice: 110,
  trend: {
    structure: { event: 'BOS_BULLISH', trend: 'UPTREND', lastSwingHigh: 108, lastSwingLow: 95 },
    priceVsSMA20: { diffPct: 2, above: true },
    priceVsSMA200: { diffPct: 5, above: true },
    movingAverages: { sma20: 105, sma50: 100, sma200: 95 },
    dmi: { plusDI: 30, minusDI: 15, adx: 28 },
  },
  momentum: { rsi: 65, roc: 1.5, stochasticRSI: 70, macd: { macd: 1.2, signal: 0.8 } },
  volatility: { regime: 'EXPANDING', atr: 2, keltner: { upper: 112, lower: 98, middle: 105 } },
  volume: { relativeVolume: 2.1, vwap: { distancePct: 1.2 }, cmf: 0.15, isSpike: true },
  priceAction: { candlestick: 'BULLISH_ENGULFING', consolidating: false },
  supportResistance: { nearest: { nearestResistance: { level: 118, pct: 7.3 }, nearestSupport: { level: 100, pct: -9.1 } } },
  regime: { regime: 'BULLISH_TREND', marketStructure: 'TRENDING', trendStrength: 72 },
  marketContext: {
    sector: { trend: { regime: { regime: 'BULLISH_TREND', marketStructure: 'TRENDING', trendStrength: 60 } } },
    relativeStrengthVsSPY: { relativeStrengthPct: 1.8 },
  },
});

const momentumBreakoutBearish = makeContext({
  currentPrice: 90,
  trend: {
    structure: { event: 'BOS_BEARISH', trend: 'DOWNTREND', lastSwingHigh: 105, lastSwingLow: 92 },
    priceVsSMA20: { diffPct: -2, above: false },
    priceVsSMA200: { diffPct: -5, above: false },
    movingAverages: { sma20: 95, sma50: 100, sma200: 105 },
    dmi: { plusDI: 15, minusDI: 30, adx: 28 },
  },
  momentum: { rsi: 35, roc: -1.5, stochasticRSI: 30, macd: { macd: -1.2, signal: -0.8 } },
  volatility: { regime: 'EXPANDING', atr: 2, keltner: { upper: 102, lower: 88, middle: 95 } },
  volume: { relativeVolume: 2.1, vwap: { distancePct: -1.2 }, cmf: -0.15, isSpike: true },
  priceAction: { candlestick: 'BEARISH_ENGULFING', consolidating: false },
  supportResistance: { nearest: { nearestResistance: { level: 100, pct: 11.1 }, nearestSupport: { level: 82, pct: -8.9 } } },
  regime: { regime: 'BEARISH_TREND', marketStructure: 'TRENDING', trendStrength: 72 },
  marketContext: {
    sector: { trend: { regime: { regime: 'BEARISH_TREND', marketStructure: 'TRENDING', trendStrength: 60 } } },
    relativeStrengthVsSPY: { relativeStrengthPct: -1.8 },
  },
});

const rangingNeutral = makeContext({
  currentPrice: 100,
  trend: {
    structure: { event: null, trend: null, lastSwingHigh: 105, lastSwingLow: 95 },
    priceVsSMA20: { diffPct: 0.1, above: true },
    priceVsSMA200: { diffPct: 0.2, above: true },
    movingAverages: { sma20: 100, sma50: 99, sma200: 98 },
    dmi: { plusDI: 20, minusDI: 20, adx: 15 },
  },
  momentum: { rsi: 28, roc: 0.1, stochasticRSI: 15, macd: { macd: 0.1, signal: 0.1 } },
  volatility: { regime: 'CONTRACTING', atr: 1, keltner: { upper: 103, lower: 97, middle: 100 } },
  volume: { relativeVolume: 0.8, vwap: { distancePct: 0.1 }, cmf: 0.02, isSpike: false },
  priceAction: { candlestick: 'HAMMER', consolidating: true },
  supportResistance: { nearest: { nearestResistance: { level: 105, pct: 5 }, nearestSupport: { level: 96, pct: -1 } } },
  regime: { regime: 'SIDEWAYS_RANGE', marketStructure: 'RANGING', trendStrength: 10 },
  marketContext: { sector: { trend: null }, relativeStrengthVsSPY: null },
});

const strategies = {
  momentumBreakout_bullish: pick(momentumBreakout.evaluate(momentumBreakoutBullish)),
  momentumBreakout_bearish: pick(momentumBreakout.evaluate(momentumBreakoutBearish)),
  pullbackContinuation_bullish: pick(pullbackContinuation.evaluate(momentumBreakoutBullish)),
  pullbackContinuation_bearish: pick(pullbackContinuation.evaluate(momentumBreakoutBearish)),
  meanReversion_ranging: pick(meanReversion.evaluate(rangingNeutral)),
  trendFollowing_bullish: pick(trendFollowing.evaluate(momentumBreakoutBullish)),
  trendFollowing_bearish: pick(trendFollowing.evaluate(momentumBreakoutBearish)),
  rangeReversion_ranging: pick(rangeReversion.evaluate(rangingNeutral)),
};

console.log(JSON.stringify({ statistics, ev, strategies }, null, 2));
