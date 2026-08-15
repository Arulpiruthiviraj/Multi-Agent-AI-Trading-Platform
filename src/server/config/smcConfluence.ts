/**
 * ==========================================================
 * Module: config/smcConfluence
 *
 * Purpose:
 * Load config/smcConfluence.json: SMC confluence *weights* (should sum to 100) and detection
 * thresholds (equal-level tolerance, displacement multiple, RVOL confirmation, sweep lookback).
 * Changing weights is a reviewed config change, not a UI knob, and does not enable live Quant.
 * ==========================================================
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface SmcConfluenceConfig {
  liquidityIdentified: number;
  liquiditySwept: number;
  chochConfirmed: number;
  displacement: number;
  orderBlock: number;
  fvg: number;
  volumeConfirmation: number;
  regimeAlignment: number;
  equalLevelTolerancePct: number;
  displacementRangeMultiple: number;
  rvolConfirmation: number;
  sweepLookbackBars: number;
}

const REQUIRED_KEYS: (keyof SmcConfluenceConfig)[] = [
  'liquidityIdentified',
  'liquiditySwept',
  'chochConfirmed',
  'displacement',
  'orderBlock',
  'fvg',
  'volumeConfirmation',
  'regimeAlignment',
  'equalLevelTolerancePct',
  'displacementRangeMultiple',
  'rvolConfirmation',
  'sweepLookbackBars',
];

function loadSmcConfluence(): SmcConfluenceConfig {
  const raw = loadRepoConfigJson<Record<string, unknown>>('smcConfluence.json');
  for (const key of REQUIRED_KEYS) {
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key] as number)) {
      throw new Error(`config/smcConfluence.json missing numeric field: ${key}`);
    }
  }
  return raw as unknown as SmcConfluenceConfig;
}

export const smcConfluence: SmcConfluenceConfig = loadSmcConfluence();
