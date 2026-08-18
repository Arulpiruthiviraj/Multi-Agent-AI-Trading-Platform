/**
 * ==========================================================
 * Module: strategiesEngine/core/MarketSnapshot
 *
 * Purpose:
 * The Strategies Engine's OWN evaluation-input type - deliberately a separate type from
 * src/server/quant/strategies/types.ts's StrategyContext (the live-reachable quant engine's
 * context), even though both ultimately describe "what a strategy can see about the market."
 * This is the architectural isolation boundary: nothing in this engine imports StrategyContext,
 * ChiefTraderAgent, RiskAgent, BrokerManager, or EventBus, so a change to the live path cannot
 * break this engine and vice versa.
 *
 * `buildMarketSnapshotFromBars` is the one real adapter ("usable later through an explicit
 * adapter/interface" per the build directive) that populates a MarketSnapshot from real OHLCV
 * bars. It calls the EXISTING pure indicator functions in src/server/quant/indicators/* and
 * src/server/quant/statistics.ts rather than reimplementing any math - those modules have no
 * side effects and are not part of the live decision path themselves (BacktestEngine and
 * QuantSignalAgent both call them read-only, same as this adapter does).
 * ==========================================================
 */
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { computeTrendFeatures } from '../../quant/indicators/trend';
import { computeMomentumFeatures } from '../../quant/indicators/momentum';
import { computeVolatilityFeatures } from '../../quant/indicators/volatility';
import { computeVolumeFeatures } from '../../quant/indicators/volume';
import { computePriceActionFeatures } from '../../quant/indicators/priceAction';
import { computeSupportResistanceFeatures } from '../../quant/indicators/supportResistance';
import { computeSmcFeatures } from '../../quant/indicators/smc';
import { zScore } from '../../quant/statistics';
import { Timeframe } from './types';

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A flat, named map of real indicator readings, keyed by a stable field name (e.g. 'rsi14',
 * 'ema20', 'ema50', 'adx', 'atrPercent'). `null` means "computed, not enough real history" -
 * never a fabricated 0, matching every source indicator module's own convention. Conditions read
 * from this map (or from `series`/`levels`/`flags` below) rather than ever touching raw bars
 * themselves, so evaluateCondition.ts stays pure and decoupled from any particular data source.
 */
export interface MarketSnapshot {
  symbol: string;
  timeframe: Timeframe;
  timestamp: number;
  price: OHLCV;
  /** Two most recent aligned values for any indicator that supports CrossAbove/CrossBelow
   *  (e.g. { ema9: [prior, current], ema20: [prior, current] }). Absent keys mean "no prior value
   *  available" - CrossAbove/CrossBelow on a missing series is honestly `false`, not fabricated. */
  series: Record<string, [number | null, number | null]>;
  indicators: Record<string, number | null>;
  levels: Record<string, number | null>; // named price levels: vwap, priorDayHigh, swingHigh, etc.
  flags: Record<string, boolean | null>; // named booleans: bosConfirmed, choChConfirmed, fvgDetected, orderBlockDetected, liquiditySwept
}

/**
 * Real adapter: builds a MarketSnapshot from real bars using only existing, already-tested
 * indicator functions. `newsSentiment` is optional and supplied by the caller (this engine has no
 * news pipeline of its own) - omitted keys leave NewsSentimentAbove/Below honestly unevaluable
 * (see evaluateCondition.ts, which treats a missing indicator as `false`, never a guess).
 */
export function buildMarketSnapshotFromBars(
  bars: Bar[],
  symbol: string,
  timeframe: Timeframe,
  opts: { newsSentiment?: number } = {},
): MarketSnapshot {
  const last = bars[bars.length - 1];
  const prior = bars.length >= 2 ? bars[bars.length - 2] : undefined;
  const closes = bars.map(b => b.close);

  const trend = computeTrendFeatures(bars);
  const momentum = computeMomentumFeatures(bars);
  const volatility = computeVolatilityFeatures(bars);
  const volume = computeVolumeFeatures(bars);
  const priceAction = computePriceActionFeatures(bars);
  const sr = computeSupportResistanceFeatures(bars);
  const smc = computeSmcFeatures(bars);

  const priorTrend = prior ? computeTrendFeatures(bars.slice(0, -1)) : null;

  return {
    symbol,
    timeframe,
    timestamp: last ? last.timestamp : Date.now(),
    price: last
      ? { open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume }
      : { open: 0, high: 0, low: 0, close: 0, volume: 0 },
    series: {
      ema9: [priorTrend?.movingAverages.ema9 ?? null, trend.movingAverages.ema9],
      ema20: [priorTrend?.movingAverages.ema20 ?? null, trend.movingAverages.ema20],
      ema50: [priorTrend?.movingAverages.ema50 ?? null, trend.movingAverages.ema50],
      sma50: [priorTrend?.movingAverages.sma50 ?? null, trend.movingAverages.sma50],
      sma200: [priorTrend?.movingAverages.sma200 ?? null, trend.movingAverages.sma200],
      close: [prior?.close ?? null, last?.close ?? null],
      vwap: [null, volume.vwap.vwap],
    },
    indicators: {
      rsi14: momentum.rsi,
      stochasticRsi: momentum.stochasticRSI,
      roc: momentum.roc,
      williamsR: momentum.williamsR,
      cci: momentum.cci,
      macd: momentum.macd.macd,
      macdSignal: momentum.macd.signal,
      macdHistogram: momentum.macd.histogram,
      adx: trend.dmi?.adx ?? null,
      plusDI: trend.dmi?.plusDI ?? null,
      minusDI: trend.dmi?.minusDI ?? null,
      atr: volatility.atr,
      atrPercent: volatility.atrPercent,
      historicalVolatilityPct: volatility.historicalVolatilityPct,
      volatilityPercentile: volatility.volatilityPercentile,
      bollingerBandWidthPct: volatility.bollingerBandWidthPct,
      relativeVolume: volume.relativeVolume,
      volumeROC: volume.volumeROC,
      obv: volume.obv,
      mfi: volume.mfi,
      cmf: volume.cmf,
      ad: volume.ad,
      zScoreClose20: zScore(closes, 20),
      vwapDistancePct: volume.vwap.distancePct,
      gapSizePct: priceAction.gap.sizePct,
      newsSentiment: opts.newsSentiment ?? null,
    },
    levels: {
      vwap: volume.vwap.vwap,
      keltnerUpper: volatility.keltner?.upper ?? null,
      keltnerLower: volatility.keltner?.lower ?? null,
      previousDayHigh: sr.previousDay?.high ?? null,
      previousDayLow: sr.previousDay?.low ?? null,
      nearestSupport: sr.nearest.nearestSupport?.level ?? null,
      nearestResistance: sr.nearest.nearestResistance?.level ?? null,
      priorChannelHigh: sr.priorChannel20?.high ?? null,
      priorChannelLow: sr.priorChannel20?.low ?? null,
      swingHigh: smc.liquidity.buySide?.price ?? null,
      swingLow: smc.liquidity.sellSide?.price ?? null,
      fvgLow: smc.fairValueGap.low,
      fvgHigh: smc.fairValueGap.high,
      orderBlockLow: smc.orderBlock.low,
      orderBlockHigh: smc.orderBlock.high,
    },
    flags: {
      trendBullish: trend.structure.trend === 'UPTREND',
      trendBearish: trend.structure.trend === 'DOWNTREND',
      bosConfirmed: trend.structure.event === 'BOS_BULLISH' || trend.structure.event === 'BOS_BEARISH',
      choChConfirmed: trend.structure.event === 'CHOCH_BULLISH' || trend.structure.event === 'CHOCH_BEARISH',
      fvgDetected: smc.fairValueGap.side !== null,
      /** Distinct from `fvgDetected`: this is true only when price has actually returned into
       *  the most recent FVG zone (smc.ts's own `overlappingPrice`), which is the real ICT entry
       *  trigger - "a gap exists somewhere in history" is a much weaker, less honest condition. */
      fvgPriceInZone: smc.fairValueGap.side !== null && smc.fairValueGap.overlappingPrice,
      orderBlockDetected: smc.orderBlock.side !== null,
      orderBlockPriceInZone: smc.orderBlock.side !== null && smc.orderBlock.overlappingPrice,
      liquiditySwept: smc.sweep.kind !== 'NONE',
      isVolumeSpike: volume.isSpike,
    },
  };
}
