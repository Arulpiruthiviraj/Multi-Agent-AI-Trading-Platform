/**
 * Loads config/quantThresholds.json. Core strategy/regime/scoring numbers.
 * Missing required keys fail boot.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface GroupedScoreWeights {
  trend: number;
  momentum: number;
  market: number;
  sector: number;
  relativeStrength: number;
  volume: number;
  vwap: number;
  priceStructure: number;
}

export interface QuantThresholds {
  rsiOverbought: number;
  rsiOversold: number;
  rsiExtremeOverbought: number;
  rsiExtremeOversold: number;
  stochRsiOversold: number;
  stochRsiOverbought: number;
  healthyRsiMin: number;
  healthyRsiMax: number;
  minTrendStrength: number;
  minAdxTrending: number;
  minAdxRanging: number;
  minMeaningfulAdx: number;
  minMeaningfulPriceVsMaPct: number;
  minMeaningfulSlopePct: number;
  volatilityPercentileHigh: number;
  volatilityPercentileLow: number;
  rvolThreshold: number;
  pullbackTolerancePct: number;
  nearBoundaryPct: number;
  groupedScoreNeutral: number;
  technicalHistoryBars: number;
  technicalEvaluationCooldownMs: number;
  /**
   * Minimum re-emission gap for the SAME fired signal (momentumBreakout/meanReversion/overbought)
   * on the SAME symbol, when no genuine indicator state-transition (RSI crossing its threshold,
   * MACD histogram sign flip) has occurred since the last emission. Separate from
   * technicalEvaluationCooldownMs, which only throttles how often checkStrategies() re-runs at
   * all - a still-true, unchanged signal state used to re-emit TRADE_IDEA_GENERATED every single
   * cooldown period regardless (ARGUS_PREDICTIVE_EDGE_FORENSIC_AUDIT.md finding M3).
   */
  technicalSignalCooldownMs: number;
  /**
   * lightweightRegimeClassifier.ts's own minimum bars - deliberately smaller than
   * tradingSafety.regimeMinBars (RegimeEngine.ts's real OHLC-bar minimum, 60), since tick-driven
   * agents like TechnicalAgent only ever hold up to technicalHistoryBars (50) closing prices, not
   * daily bars.
   */
  lightweightRegimeMinBars: number;
  /** Bollinger-band-width-as-fraction-of-price threshold for HIGH volatility (lightweightRegimeClassifier.ts). Not the same unit as volatilityPercentileHigh (a percentile rank) - see that file's own comment. */
  lightweightVolatilityHighBandWidthPct: number;
  /** Same, for LOW volatility. */
  lightweightVolatilityLowBandWidthPct: number;
  bollingerPeriod: number;
  rsiMinBars: number;
  kronosMinHistory: number;
  kronosMaxHistory: number;
  kronosHorizon: number;
  kronosNeutralBandPct: number;
  /** Floor of KronosInference.ts's spread-to-confidence mapping (never below this). */
  kronosConfidenceFloor: number;
  /** Ceiling of KronosInference.ts's spread-to-confidence mapping ("never claim near-certainty from a small model"). */
  kronosConfidenceCeiling: number;
  /** Multiplier in confidence = clamp(1 - relativeSpread * M, floor, ceiling). Recalibrated
   *  2026-09-04 against the real kronos_predictions distribution (3,000-row live sample: p90
   *  relativeSpread 0.73%, p99 2.24%) after the previous value of 4 was found to saturate the
   *  ceiling on ~100% of real predictions - see KronosInference.ts's buildPrediction() comment. */
  kronosConfidenceSpreadMultiplier: number;
  baseSlippagePct: number;
  atrSlippageMultiplier: number;
  sizeImpactMultiplier: number;
  maxSlippagePct: number;
  priceSourceDivergencePct: number;
  kronosTimeframe: string;
  groupedScoreWeights: GroupedScoreWeights;
  /** Phase 15 bounded strategy-exploration scheduler (StrategyExplorationScheduler.ts). Off entirely disables the reordering - bestStrategyIdea() picks exactly as it always has. */
  strategyExplorationEnabled: boolean;
  /** How long a strategy's own exploration promotion lasts before it is eligible to be promoted again. */
  strategyExplorationCooldownMs: number;
  /** System-wide minimum gap between any two exploration promotions, across all symbols/strategies. */
  strategyExplorationMinIntervalMs: number;
  /** Phase B (2026-09-02 score-normalization): off entirely leaves evaluateAll()'s cross-strategy
   *  sort exactly as it always has (raw setupScore descending). When true, ranking among eligible
   *  strategies uses a z-score against each strategy's OWN real historical setupScore distribution
   *  (from already-persisted quant_assessments rows) instead of comparing raw setupScore across
   *  strategies with structurally different scoring formulas. Never changes eligibility (still
   *  gated by MIN_STRATEGY_CONFIDENCE_TO_TRADE, untouched) or which strategies exist. */
  strategyScoreNormalizationEnabled: boolean;
  /** A strategy with fewer than this many historical graded quant_assessments rows keeps its raw
   *  setupScore (documented cold-start fallback) rather than an unreliable thin-sample z-score. */
  strategyScoreNormalizationMinSample: number;
  /** How often the historical mean/stddev-per-strategy cache is refreshed from the DB. */
  strategyScoreNormalizationCacheTtlMs: number;
}

const NUMERIC_KEYS: (keyof QuantThresholds)[] = [
  'rsiOverbought', 'rsiOversold', 'rsiExtremeOverbought', 'rsiExtremeOversold',
  'stochRsiOversold', 'stochRsiOverbought', 'healthyRsiMin', 'healthyRsiMax',
  'minTrendStrength', 'minAdxTrending', 'minAdxRanging', 'minMeaningfulAdx',
  'minMeaningfulPriceVsMaPct', 'minMeaningfulSlopePct', 'volatilityPercentileHigh',
  'volatilityPercentileLow', 'rvolThreshold', 'pullbackTolerancePct', 'nearBoundaryPct',
  'groupedScoreNeutral', 'technicalHistoryBars', 'technicalEvaluationCooldownMs', 'technicalSignalCooldownMs',
  'lightweightRegimeMinBars', 'lightweightVolatilityHighBandWidthPct', 'lightweightVolatilityLowBandWidthPct',
  'bollingerPeriod', 'rsiMinBars',
  'kronosMinHistory', 'kronosMaxHistory', 'kronosHorizon', 'kronosNeutralBandPct',
  'kronosConfidenceFloor', 'kronosConfidenceCeiling', 'kronosConfidenceSpreadMultiplier',
  'baseSlippagePct', 'atrSlippageMultiplier', 'sizeImpactMultiplier', 'maxSlippagePct',
  'priceSourceDivergencePct',
  'strategyExplorationCooldownMs', 'strategyExplorationMinIntervalMs',
  'strategyScoreNormalizationMinSample', 'strategyScoreNormalizationCacheTtlMs',
];

const WEIGHT_KEYS: (keyof GroupedScoreWeights)[] = [
  'trend', 'momentum', 'market', 'sector', 'relativeStrength', 'volume', 'vwap', 'priceStructure',
];

function loadQuantThresholds(): QuantThresholds {
  const raw = loadRepoConfigJson<Record<string, unknown>>('quantThresholds.json');
  for (const key of NUMERIC_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/quantThresholds.json missing numeric field: ${key}`);
    }
  }
  if (typeof raw.kronosTimeframe !== 'string' || !raw.kronosTimeframe) {
    throw new Error('config/quantThresholds.json missing string field: kronosTimeframe');
  }
  if (typeof raw.strategyExplorationEnabled !== 'boolean') {
    throw new Error('config/quantThresholds.json missing boolean field: strategyExplorationEnabled');
  }
  if (typeof raw.strategyScoreNormalizationEnabled !== 'boolean') {
    throw new Error('config/quantThresholds.json missing boolean field: strategyScoreNormalizationEnabled');
  }
  const weights = raw.groupedScoreWeights;
  if (!weights || typeof weights !== 'object') {
    throw new Error('config/quantThresholds.json missing groupedScoreWeights');
  }
  const w = weights as Record<string, unknown>;
  for (const key of WEIGHT_KEYS) {
    if (typeof w[key] !== 'number' || !Number.isFinite(w[key] as number)) {
      throw new Error(`config/quantThresholds.json missing groupedScoreWeights.${key}`);
    }
  }
  return raw as unknown as QuantThresholds;
}

export const quantThresholds: QuantThresholds = loadQuantThresholds();
