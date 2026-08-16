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
}

const NUMERIC_KEYS: (keyof QuantThresholds)[] = [
  'rsiOverbought', 'rsiOversold', 'rsiExtremeOverbought', 'rsiExtremeOversold',
  'stochRsiOversold', 'stochRsiOverbought', 'healthyRsiMin', 'healthyRsiMax',
  'minTrendStrength', 'minAdxTrending', 'minAdxRanging', 'minMeaningfulAdx',
  'minMeaningfulPriceVsMaPct', 'minMeaningfulSlopePct', 'volatilityPercentileHigh',
  'volatilityPercentileLow', 'rvolThreshold', 'pullbackTolerancePct', 'nearBoundaryPct',
  'groupedScoreNeutral', 'technicalHistoryBars', 'bollingerPeriod', 'rsiMinBars',
  'kronosMinHistory', 'kronosMaxHistory', 'kronosHorizon', 'kronosNeutralBandPct',
  'baseSlippagePct', 'atrSlippageMultiplier', 'sizeImpactMultiplier', 'maxSlippagePct',
  'priceSourceDivergencePct',
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
