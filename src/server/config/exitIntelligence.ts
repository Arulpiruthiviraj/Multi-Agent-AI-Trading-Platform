/**
 * Loads config/exitIntelligence.json. ExitIntelligenceEngine thresholds/weights.
 * Missing required keys fail boot, matching every other config loader in this codebase.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface ExitIntelligenceComponentWeights {
  momentumDeterioration: number;
  trendWeakening: number;
  profitProtectionPressure: number;
  volatilityRisk: number;
}

export interface ExitIntelligenceConfig {
  enabledEnvVar: string;
  minBarsRequired: number;
  componentWeights: ExitIntelligenceComponentWeights;
  rsiOverboughtForDeterioration: number;
  rsiDivergenceDropPts: number;
  adxWeakeningThreshold: number;
  peakDrawbackForPressurePct: number;
  elevatedAtrPercentileForRisk: number;
  exitScoreHold: number;
  exitScorePartialTakeProfit: number;
  exitScoreFullTakeProfit: number;
  exitScoreLossExit: number;
  partialTakeProfitSellFraction: number;
}

const NUMERIC_KEYS: (keyof ExitIntelligenceConfig)[] = [
  'minBarsRequired',
  'rsiOverboughtForDeterioration',
  'rsiDivergenceDropPts',
  'adxWeakeningThreshold',
  'peakDrawbackForPressurePct',
  'elevatedAtrPercentileForRisk',
  'exitScoreHold',
  'exitScorePartialTakeProfit',
  'exitScoreFullTakeProfit',
  'exitScoreLossExit',
  'partialTakeProfitSellFraction',
];

const WEIGHT_KEYS: (keyof ExitIntelligenceComponentWeights)[] = [
  'momentumDeterioration', 'trendWeakening', 'profitProtectionPressure', 'volatilityRisk',
];

function loadExitIntelligenceConfig(): ExitIntelligenceConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('exitIntelligence.json');
  if (typeof raw.enabledEnvVar !== 'string' || !raw.enabledEnvVar) {
    throw new Error('config/exitIntelligence.json missing enabledEnvVar');
  }
  for (const key of NUMERIC_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/exitIntelligence.json missing numeric field: ${key}`);
    }
  }
  const weights = raw.componentWeights;
  if (!weights || typeof weights !== 'object') {
    throw new Error('config/exitIntelligence.json missing componentWeights');
  }
  const w = weights as Record<string, unknown>;
  for (const key of WEIGHT_KEYS) {
    if (typeof w[key] !== 'number' || !Number.isFinite(w[key] as number)) {
      throw new Error(`config/exitIntelligence.json missing componentWeights.${key}`);
    }
  }
  return raw as unknown as ExitIntelligenceConfig;
}

export const exitIntelligenceConfig: ExitIntelligenceConfig = loadExitIntelligenceConfig();

export function isExitIntelligenceEnabled(): boolean {
  return process.env[exitIntelligenceConfig.enabledEnvVar] === 'true';
}
