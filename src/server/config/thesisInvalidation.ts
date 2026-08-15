/**
 * ==========================================================
 * Module: config/thesisInvalidation
 *
 * Purpose:
 * Load config/thesisInvalidation.json once at process start. Strategy IDs, thresholds, and
 * human-readable reason templates belong in that file so adding SMC / a future strategy does
 * not require a TypeScript `if (strategy === '…')` branch.
 *
 * Unknown `type` values fail boot (throw) rather than silently skipping a safety rule.
 * ==========================================================
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export type ThesisInvalidationRuleType =
  | 'regime_not_in_applicable'
  | 'rvol_below'
  | 'adx_below'
  | 'false_breakout_through_structural_level'
  | 'choch_against_side'
  | 'close_through_structural_level'
  | 'structure_trend_against_side';

export interface ThesisInvalidationRule {
  type: ThesisInvalidationRuleType;
  /** Template with {rvol} {threshold} {level} {close} {side} {bias} {adx} {entryRegime} {liveRegime} {applicable} {structureTrend} {structureEvent}. */
  message: string;
  /** If set, the rule applies when thesis.strategy is in this list (OR textIncludes). */
  strategies?: string[];
  /** If set, the rule also applies when any stored invalidation text contains a needle. */
  textIncludes?: string[];
  /** Used by rvol_below / adx_below. */
  threshold?: number;
}

export interface ThesisInvalidationConfig {
  /** BUY/SELL → words used in messages, e.g. long/short. */
  biasLabels: Record<string, string>;
  rules: ThesisInvalidationRule[];
}

const RULE_TYPES: ThesisInvalidationRuleType[] = [
  'regime_not_in_applicable',
  'rvol_below',
  'adx_below',
  'false_breakout_through_structural_level',
  'choch_against_side',
  'close_through_structural_level',
  'structure_trend_against_side',
];

function loadThesisInvalidationConfig(): ThesisInvalidationConfig {
  const raw = loadRepoConfigJson<ThesisInvalidationConfig>('thesisInvalidation.json');
  if (!raw.biasLabels || typeof raw.biasLabels !== 'object') {
    throw new Error('config/thesisInvalidation.json missing biasLabels');
  }
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) {
    throw new Error('config/thesisInvalidation.json missing rules[]');
  }
  for (const rule of raw.rules) {
    if (!RULE_TYPES.includes(rule.type)) {
      throw new Error(`config/thesisInvalidation.json unknown rule type: ${rule.type}`);
    }
    if (typeof rule.message !== 'string' || !rule.message) {
      throw new Error(`config/thesisInvalidation.json rule ${rule.type} missing message`);
    }
  }
  return raw;
}

export const thesisInvalidationConfig: ThesisInvalidationConfig = loadThesisInvalidationConfig();
