/**
 * ==========================================================
 * Module: config/quantExperimentalStrategies
 *
 * Purpose:
 * Load config/quantExperimentalStrategies.json: experimental strategy ids, the env var that
 * includes each in live evaluateAll(), API notes, and shared numeric thresholds.
 * Changing this file is a reviewed config change, not a UI knob, and does not enable Quant.
 * ==========================================================
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface ExperimentalStrategyRow {
  id: string;
  enabledEnvVar: string;
  apiNote: string;
}

export interface QuantExperimentalThresholds {
  rvolContinuation: number;
  rvolBreakout: number;
  vwapPullbackMaxDistancePct: number;
  adxTrendMin: number;
  adxRangeMax: number;
  vwapReversionDistancePct: number;
  openingRangeWindowMinutes: number;
  donchianPriorLookback: number;
  rsiMidline: number;
  nearLevelPct: number;
  fibProximityPct: number;
  bbSqueezeWidthPct: number;
  gapMinSizePct: number;
}

export interface QuantExperimentalStrategiesConfig {
  strategies: ExperimentalStrategyRow[];
  thresholds: QuantExperimentalThresholds;
}

const THRESHOLD_KEYS: (keyof QuantExperimentalThresholds)[] = [
  'rvolContinuation',
  'rvolBreakout',
  'vwapPullbackMaxDistancePct',
  'adxTrendMin',
  'adxRangeMax',
  'vwapReversionDistancePct',
  'openingRangeWindowMinutes',
  'donchianPriorLookback',
  'rsiMidline',
  'nearLevelPct',
  'fibProximityPct',
  'bbSqueezeWidthPct',
  'gapMinSizePct',
];

function loadQuantExperimentalStrategies(): QuantExperimentalStrategiesConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('quantExperimentalStrategies.json');
  if (!Array.isArray(raw.strategies) || raw.strategies.length === 0) {
    throw new Error('config/quantExperimentalStrategies.json missing strategies[]');
  }
  const strategies: ExperimentalStrategyRow[] = [];
  for (const item of raw.strategies) {
    if (!item || typeof item !== 'object') {
      throw new Error('config/quantExperimentalStrategies.json strategies[] entry is not an object');
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id) {
      throw new Error('config/quantExperimentalStrategies.json strategy missing id');
    }
    if (typeof row.enabledEnvVar !== 'string' || !row.enabledEnvVar) {
      throw new Error(`config/quantExperimentalStrategies.json ${row.id} missing enabledEnvVar`);
    }
    if (typeof row.apiNote !== 'string' || !row.apiNote) {
      throw new Error(`config/quantExperimentalStrategies.json ${row.id} missing apiNote`);
    }
    strategies.push({ id: row.id, enabledEnvVar: row.enabledEnvVar, apiNote: row.apiNote });
  }

  const thresholdsRaw = raw.thresholds;
  if (!thresholdsRaw || typeof thresholdsRaw !== 'object') {
    throw new Error('config/quantExperimentalStrategies.json missing thresholds');
  }
  const t = thresholdsRaw as Record<string, unknown>;
  for (const key of THRESHOLD_KEYS) {
    if (typeof t[key] !== 'number' || !Number.isFinite(t[key] as number)) {
      throw new Error(`config/quantExperimentalStrategies.json missing numeric field: ${key}`);
    }
  }

  return { strategies, thresholds: t as unknown as QuantExperimentalThresholds };
}

export const quantExperimentalStrategies: QuantExperimentalStrategiesConfig = loadQuantExperimentalStrategies();

export function experimentalStrategyRow(id: string): ExperimentalStrategyRow | undefined {
  return quantExperimentalStrategies.strategies.find(s => s.id === id);
}

/** Live Quant evaluateAll includes this experimental id only when its JSON env var is the string 'true'. */
export function isExperimentalStrategyLive(id: string): boolean {
  const row = experimentalStrategyRow(id);
  if (!row) return false;
  return process.env[row.enabledEnvVar] === 'true';
}
