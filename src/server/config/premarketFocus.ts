/**
 * Loads config/premarketFocus.json. Weights, scale caps, tier cutoffs, and report bounds.
 * Missing/invalid keys fail at load (same "fail boot on bad config" contract as
 * config/observability.ts) — a misconfigured weight set must never silently produce a
 * differently-shaped score. Numbers are never TS literals at call sites.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export type PremarketFocusWeightKey =
  | 'overnightGap'
  | 'preMarketPctChange'
  | 'catalystPresence'
  | 'catalystRecency'
  | 'signedSentiment'
  | 'liquidity'
  | 'spreadQuality'
  | 'sectorRelativeStrength'
  | 'marketRelativeStrength'
  | 'strategyApplicability';

export interface PremarketFocusScales {
  gapScaleCapPct: number;
  preMarketScaleCapPct: number;
  catalystRecencyZeroAtMinutes: number;
  liquidityScaleDollars: number;
  advLiquidityScaleShares: number;
  spreadZeroAtBps: number;
  strategyFullCount: number;
}

export interface PremarketFocusTierCutoffs {
  primary: number;
  secondary: number;
  watch: number;
}

export interface PremarketFocusConfig {
  schemaVersion: number;
  weights: Record<PremarketFocusWeightKey, number>;
  scales: PremarketFocusScales;
  sentimentAloneCeiling: number;
  tierCutoffs: PremarketFocusTierCutoffs;
  refreshWindow: { startET: string; endET: string };
  report: { maxSymbolsPerTier: number; topContributionsKept: number; roundDecimals: number };
}

const WEIGHT_KEYS: PremarketFocusWeightKey[] = [
  'overnightGap',
  'preMarketPctChange',
  'catalystPresence',
  'catalystRecency',
  'signedSentiment',
  'liquidity',
  'spreadQuality',
  'sectorRelativeStrength',
  'marketRelativeStrength',
  'strategyApplicability',
];

const SCALE_KEYS: (keyof PremarketFocusScales)[] = [
  'gapScaleCapPct',
  'preMarketScaleCapPct',
  'catalystRecencyZeroAtMinutes',
  'liquidityScaleDollars',
  'advLiquidityScaleShares',
  'spreadZeroAtBps',
  'strategyFullCount',
];

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function loadPremarketFocusConfig(): PremarketFocusConfig {
  const raw = loadRepoConfigJson<PremarketFocusConfig>('premarketFocus.json');
  const file = 'config/premarketFocus.json';
  if (raw.schemaVersion !== 1) {
    throw new Error(`${file}: unsupported schemaVersion ${String(raw.schemaVersion)} (expected 1)`);
  }
  for (const key of WEIGHT_KEYS) {
    const w = raw.weights?.[key];
    if (!isFiniteNumber(w) || w < 0) {
      throw new Error(`${file}: weights.${key} must be a finite number >= 0`);
    }
  }
  const sum = WEIGHT_KEYS.reduce((acc, k) => acc + raw.weights[k], 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`${file}: weights must sum to exactly 1.0 (got ${sum})`);
  }
  for (const key of SCALE_KEYS) {
    const s = raw.scales?.[key];
    if (!isFiniteNumber(s) || s <= 0) {
      throw new Error(`${file}: scales.${key} must be a finite number > 0`);
    }
  }
  const { primary, secondary, watch } = raw.tierCutoffs ?? ({} as PremarketFocusTierCutoffs);
  if (
    !isFiniteNumber(primary) || !isFiniteNumber(secondary) || !isFiniteNumber(watch) ||
    !(primary < 1 && primary > secondary && secondary > watch && watch > 0)
  ) {
    throw new Error(`${file}: tierCutoffs must satisfy 1 > primary > secondary > watch > 0`);
  }
  if (
    !isFiniteNumber(raw.sentimentAloneCeiling) ||
    Math.abs(raw.sentimentAloneCeiling - raw.weights.signedSentiment) > 1e-9
  ) {
    throw new Error(
      `${file}: sentimentAloneCeiling must equal weights.signedSentiment ` +
      `(the signed component is bounded to [-1,1], so its max |contribution| is the weight itself)`,
    );
  }
  for (const key of ['maxSymbolsPerTier', 'topContributionsKept', 'roundDecimals'] as const) {
    const v = raw.report?.[key];
    if (!Number.isInteger(v) || (v as number) <= 0) {
      throw new Error(`${file}: report.${key} must be a positive integer`);
    }
  }
  return raw;
}

export const premarketFocusConfig = loadPremarketFocusConfig();
