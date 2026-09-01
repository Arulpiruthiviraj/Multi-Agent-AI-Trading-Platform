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
  'baseSlippagePct', 'atrSlippageMultiplier', 'sizeImpactMultiplier', 'maxSlippagePct',
  'priceSourceDivergencePct',
  'strategyExplorationCooldownMs', 'strategyExplorationMinIntervalMs',
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
