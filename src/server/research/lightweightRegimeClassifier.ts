/**
 * Lightweight, deterministic market-regime classifier for tick-driven agents that only ever hold
 * a rolling price series (no daily OHLC bars) - TechnicalAgent's `priceHistory`, for example.
 *
 * ARGUS_INDEPENDENT_LEARNING_AND_REGIME_IMPLEMENTATION_AUDIT.md Phase 6: QuantSignalAgent already
 * captures a real regime at generation time via `src/server/quant/RegimeEngine.ts`
 * (`quant_assessments.regime`), and Kronos's own forecast already carries `volatility`/
 * `marketStructure` fields from the model itself - this module is NOT a replacement for either.
 * It fills the one real gap: agents with only a plain price array, not `Bar[]` OHLC history, have
 * had no regime capture at all. Reuses `RegimeEngine.ts`'s own label types for consistency across
 * the codebase, and reuses `technicalSignal.ts`'s existing `calcSMA`/`calcBollingerBands` math
 * rather than duplicating indicator logic.
 *
 * NO LOOK-AHEAD BY CONSTRUCTION: this function only ever reads the `prices` array passed to it.
 * Every call site passes a rolling window that ends at "now" (the current tick) - there is no
 * mechanism here to reach past the caller-supplied array, so a regime label computed at
 * prediction-generation time can never have seen a future price. See
 * lightweightRegimeClassifier.test.ts's dedicated proof.
 */
import { calcSMA, calcBollingerBands } from '../services/technicalSignal';
import type { RegimeLabel, VolatilityLabel } from '../quant/RegimeEngine';
import { quantThresholds } from '../config/quantThresholds';

export interface LightweightRegimeResult {
  regime: RegimeLabel;
  volatility: VolatilityLabel;
  insufficientData: boolean;
}

/** Compact string form persisted onto agent_predictions.regime, e.g. "BULLISH_TREND/NORMAL". */
export function encodeRegime(result: LightweightRegimeResult): string {
  return `${result.regime}/${result.volatility}`;
}

/**
 * Classifies a plain closing-price series. Deliberately simpler than RegimeEngine.ts's real
 * multi-feature DMI/market-structure vote (that engine needs true OHLC bars this data doesn't
 * have) - trend direction comes from short-vs-long SMA ordering and slope, volatility from
 * Bollinger band width relative to price. `insufficientData: true` (never a fabricated regime)
 * below `quantThresholds.lightweightRegimeMinBars`.
 */
export function classifyLightweightRegime(prices: number[]): LightweightRegimeResult {
  const minBars = quantThresholds.lightweightRegimeMinBars;
  if (prices.length < minBars) {
    return { regime: 'SIDEWAYS_RANGE', volatility: 'NORMAL', insufficientData: true };
  }

  // Long period spans the FULL available window (not a fixed minBars-sized slice) so the
  // reference average is a genuine longer-term baseline - a fixed-size long window of the same
  // length as the minimum bar requirement produced a real bug here (caught by this file's own
  // tests): both periods sat too close to the recent end of the series, understating the slope of
  // a real, steady trend by ~5x and misclassifying it as SIDEWAYS_RANGE.
  const shortPeriod = Math.max(3, Math.floor(prices.length / 5));
  const longPeriod = prices.length;
  const smaShort = calcSMA(prices, shortPeriod);
  const smaLong = calcSMA(prices, longPeriod);
  const currentPrice = prices[prices.length - 1];

  const slopePct = smaLong !== 0 ? (smaShort - smaLong) / Math.abs(smaLong) : 0;
  const trendDeadZonePct = quantThresholds.minMeaningfulSlopePct;

  let regime: RegimeLabel = 'SIDEWAYS_RANGE';
  if (slopePct > trendDeadZonePct && currentPrice >= smaShort) regime = 'BULLISH_TREND';
  else if (slopePct < -trendDeadZonePct && currentPrice <= smaShort) regime = 'BEARISH_TREND';

  // Deliberately NOT quantThresholds.volatilityPercentileHigh/Low - those are percentile-RANK
  // thresholds (RegimeEngine.ts compares a computed percentile against them), not raw
  // bandwidth-as-fraction-of-price values. Reusing them here would silently compare the wrong
  // units (a genuine ~70%-of-price Bollinger width essentially never occurs, which would make
  // HIGH volatility nearly unreachable). These are their own, honestly-scoped thresholds instead.
  const bb = calcBollingerBands(prices, Math.min(20, prices.length));
  const bandWidthPct = currentPrice !== 0 ? (bb.upper - bb.lower) / currentPrice : 0;
  let volatility: VolatilityLabel = 'NORMAL';
  if (bandWidthPct >= quantThresholds.lightweightVolatilityHighBandWidthPct) volatility = 'HIGH';
  else if (bandWidthPct <= quantThresholds.lightweightVolatilityLowBandWidthPct) volatility = 'LOW';

  return { regime, volatility, insufficientData: false };
}
