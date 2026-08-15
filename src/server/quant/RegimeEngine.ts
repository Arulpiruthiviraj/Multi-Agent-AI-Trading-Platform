/**
 * ==========================================================
 * Module: RegimeEngine
 *
 * Purpose:
 * Phase 2 of the additive quant layer - a deterministic market-regime classifier built entirely
 * from real Phase 1 indicator features (trend/volatility/price-action), never an LLM guess. This
 * is intentionally independent of the two pre-existing regime-adjacent components already in this
 * codebase, neither of which is touched by this file:
 *   - MarketRegimeAgent.ts asks an LLM to classify the regime from general knowledge, not real
 *     price data, and falls back to a hardcoded "SIMULATED_BULL_MARKET" without a Gemini key.
 *   - AdvancedQuantEngines.ts computes a real ATR/ADX/VWAP-based UPTREND/DOWNTREND/CHOPPY label,
 *     but only as telemetry (CALCULATION_COMPLETED) - nothing consumes it for decisions.
 * Neither is replaced, removed, or modified. This engine's output is new and, per the plan,
 * intended to actually be consumed (by the Strategy Engine / QuantSignalAgent in later phases).
 *
 * Per the plan's explicit requirement, classification combines MULTIPLE independent features
 * (market structure, DMI direction, moving-average ordering/slope) rather than trusting a single
 * indicator - `confidence` is literally how much those independent signals agree with each other,
 * not a fabricated number.
 * ==========================================================
 */
import { Bar } from '../engines/backtest/HistoricalDataGateway';
import { computeTrendFeatures, TrendFeatures } from './indicators/trend';
import { computeVolatilityFeatures, VolatilityFeatures } from './indicators/volatility';
import { computePriceActionFeatures, PriceActionFeatures } from './indicators/priceAction';

import { tradingSafety } from '../config/tradingSafety';

export type RegimeLabel = 'BULLISH_TREND' | 'BEARISH_TREND' | 'SIDEWAYS_RANGE';
export type VolatilityLabel = 'HIGH' | 'LOW' | 'NORMAL';
export type MarketStructureLabel = 'TRENDING' | 'RANGING' | 'CHOPPY';

export interface RegimeResult {
  regime: RegimeLabel;
  trendStrength: number; // 0-100
  volatility: VolatilityLabel;
  marketStructure: MarketStructureLabel;
  confidence: number; // 0-1 - real agreement ratio across independent signals, not fabricated
  features: {
    trend: TrendFeatures;
    volatility: VolatilityFeatures;
    priceAction: PriceActionFeatures;
  };
  insufficientData: boolean; // true when fewer than MIN_BARS bars were supplied - regime is a
                              // best-effort read on thin data, flagged honestly rather than hidden
}

export const MIN_BARS = tradingSafety.regimeMinBars;

// Dead-zones below which a reading is treated as "too close to call" rather than forced into a
// boolean vote - without these, a genuinely flat/noisy series can tip an all-or-nothing vote
// purely on which side of exactly 0 a tiny, meaningless residual lands on (confirmed by a real
// test fixture: a perfectly alternating +1/-1 series with zero net drift still forced a directional
// read on every vote before these thresholds existed, simply based on which parity the array
// happened to end on).
const MIN_MEANINGFUL_PRICE_VS_MA_PCT = 0.1;
const MIN_MEANINGFUL_SLOPE_PCT = 0.05;
const MIN_MEANINGFUL_ADX = 15; // below this, DMI's +DI/-DI split is noise, not a real trend signal

/**
 * Each entry is `true` for a bullish read, `false` for bearish, `null` when that particular
 * feature isn't computable yet (e.g. SMA200 needs 200 real bars) OR is real but too small/weak to
 * treat as meaningful directional evidence (see the dead-zone constants above) - null votes are
 * excluded from the agreement ratio entirely rather than counted as neutral, since a neutral vote
 * would quietly understate confidence for a real, decisive-but-partial feature set.
 */
function collectDirectionalVotes(trend: TrendFeatures): (boolean | null)[] {
  const votes: (boolean | null)[] = [];

  if (trend.structure.trend !== 'SIDEWAYS') {
    votes.push(trend.structure.trend === 'UPTREND');
  } else {
    votes.push(null);
  }

  if (trend.dmi && trend.dmi.adx >= MIN_MEANINGFUL_ADX) {
    votes.push(trend.dmi.plusDI > trend.dmi.minusDI);
  } else {
    votes.push(null);
  }

  const priceVsMAVote = (pvma: TrendFeatures['priceVsSMA50']) =>
    pvma && Math.abs(pvma.diffPct) > MIN_MEANINGFUL_PRICE_VS_MA_PCT ? pvma.above : null;
  votes.push(priceVsMAVote(trend.priceVsSMA50));
  votes.push(priceVsMAVote(trend.priceVsSMA200));

  votes.push(
    trend.sma50SlopePct !== null && Math.abs(trend.sma50SlopePct) > MIN_MEANINGFUL_SLOPE_PCT
      ? trend.sma50SlopePct > 0
      : null
  );

  return votes;
}

/** Classifies volatility relative to the symbol's own real recent history (percentile), not an
 *  arbitrary absolute cutoff that would mean something different for a calm vs. volatile stock. */
function classifyVolatilityLabel(volatility: VolatilityFeatures): VolatilityLabel {
  if (volatility.volatilityPercentile === null) return 'NORMAL';
  if (volatility.volatilityPercentile >= 70) return 'HIGH';
  if (volatility.volatilityPercentile <= 30) return 'LOW';
  return 'NORMAL';
}

/** ADX &gt;= 25 as the TRENDING threshold matches this codebase's own existing convention
 *  (AdvancedQuantEngines.ts uses the identical adx&gt;25 cutoff for its own trend label) - kept
 *  consistent rather than inventing a different threshold for the same real concept. RANGING
 *  requires both a real low ADX AND real price-action consolidation (two independent
 *  confirmations, not ADX alone); anything in between is honestly CHOPPY rather than forced into
 *  one of the other two. */
function classifyMarketStructure(trend: TrendFeatures, priceAction: PriceActionFeatures): MarketStructureLabel {
  const adx = trend.dmi?.adx ?? null;
  if (adx !== null && adx >= 25) return 'TRENDING';
  if (adx !== null && adx < 20 && priceAction.consolidating) return 'RANGING';
  return 'CHOPPY';
}

export function classifyRegime(bars: Bar[]): RegimeResult {
  const trend = computeTrendFeatures(bars);
  const volatility = computeVolatilityFeatures(bars);
  const priceAction = computePriceActionFeatures(bars);

  const votes = collectDirectionalVotes(trend);
  const realVotes = votes.filter((v): v is boolean => v !== null);
  const bullishCount = realVotes.filter(v => v).length;

  // A minimum of 2 independent real signals is required before calling a trend at all - a single
  // surviving vote (everything else null/filtered by the dead-zones above) unanimously "agreeing
  // with itself" would read as 100% confidence from n=1, which is exactly the false-signal shape
  // a real multi-feature regime engine exists to avoid (confirmed by a real fixture: a genuinely
  // flat alternating series left only one vote non-null, and that lone vote alone was enough to
  // force a full BEARISH_TREND call before this guard existed).
  const MIN_REAL_VOTES = 2;
  let regime: RegimeLabel = 'SIDEWAYS_RANGE';
  let agreementRatio = 0;
  if (realVotes.length >= MIN_REAL_VOTES) {
    const bullishRatio = bullishCount / realVotes.length;
    if (bullishRatio >= 0.6) { regime = 'BULLISH_TREND'; agreementRatio = bullishRatio; }
    else if (bullishRatio <= 0.4) { regime = 'BEARISH_TREND'; agreementRatio = 1 - bullishRatio; }
    else { regime = 'SIDEWAYS_RANGE'; agreementRatio = 1 - Math.abs(bullishRatio - 0.5) * 2; }
  }

  // Confidence combines real signal agreement with real data completeness - a unanimous read from
  // only 2 of 5 possible signals is less trustworthy than the same unanimity from 5 of 5, so
  // partial data honestly caps confidence rather than reporting the agreement ratio alone.
  const completeness = realVotes.length / votes.length;
  const confidence = Math.round(agreementRatio * completeness * 100) / 100;

  const adx = trend.dmi?.adx ?? 0;
  const trendStrength = Math.round(Math.min(100, Math.max(0, adx * (0.5 + agreementRatio * 0.5))));

  return {
    regime,
    trendStrength,
    volatility: classifyVolatilityLabel(volatility),
    marketStructure: classifyMarketStructure(trend, priceAction),
    confidence,
    features: { trend, volatility, priceAction },
    insufficientData: bars.length < MIN_BARS,
  };
}
