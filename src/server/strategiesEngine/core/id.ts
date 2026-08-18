/**
 * ==========================================================
 * Module: strategiesEngine/core/id
 *
 * Purpose:
 * Deterministic strategy IDs: the same (family, name, parameterValues, entry/confirmation/
 * invalidation/exit condition trees, stopLoss, takeProfit, positionSizing, version) always
 * produces the same id, and any real change to those fields produces a different id. Built from a
 * canonical (sorted-key) JSON serialization hashed with sha256 - not Math.random(), not Date.now(),
 * so generation is reproducible and duplicate detection (Section 10) is exact rather than
 * probabilistic.
 * ==========================================================
 */
import { createHash } from 'crypto';
import { StrategyDefinition } from './types';

/** Recursively sorts object keys so two structurally-identical objects always serialize
 *  byte-for-byte identically regardless of property insertion order. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** The identity fields that define "is this the same strategy" - deliberately excludes `id`
 *  itself, `metadata.createdAt` (a timestamp, not identity), and `metadata.derivedFromId`
 *  (provenance, not identity - two independently-generated definitions with identical rules are
 *  the same strategy even if generated via different paths). */
export interface StrategyIdentityInput {
  family: StrategyDefinition['family'];
  name: string;
  version: number;
  entryConditions: StrategyDefinition['entryConditions'];
  confirmationConditions: StrategyDefinition['confirmationConditions'];
  invalidationConditions: StrategyDefinition['invalidationConditions'];
  exitConditions: StrategyDefinition['exitConditions'];
  stopLoss: StrategyDefinition['stopLoss'];
  takeProfit: StrategyDefinition['takeProfit'];
  positionSizing: StrategyDefinition['positionSizing'];
  parameterValues: StrategyDefinition['parameterValues'];
}

const FAMILY_PREFIX: Record<string, string> = {
  TREND: 'TREND', MOMENTUM: 'MOM', MEAN_REVERSION: 'MREV', BREAKOUT: 'BRK', PULLBACK: 'PB',
  PRICE_ACTION: 'PA', CANDLESTICK: 'CDL', SMART_MONEY: 'SMC', MARKET_STRUCTURE: 'MSTR',
  SUPPORT_RESISTANCE: 'SR', FIBONACCI: 'FIB', VOLUME: 'VOL', VOLATILITY: 'VLT', GAP: 'GAP',
  INTRADAY: 'INTRA', SCALPING: 'SCLP', SWING: 'SWG', STATISTICAL: 'STAT', ARBITRAGE: 'ARB',
  OPTIONS: 'OPT', FUNDAMENTAL: 'FUND', EVENT_DRIVEN: 'EVT', NEWS_SENTIMENT: 'NEWS',
  MACHINE_LEARNING: 'ML', AI: 'AI', SEASONAL: 'SEAS', MACRO: 'MACRO', FOREX: 'FX', FUTURES: 'FUT',
  CRYPTO: 'CRYPTO', ORDER_FLOW: 'OFLOW', MARKET_MICROSTRUCTURE: 'MSTRUCT', MARKET_MAKING: 'MM',
  PORTFOLIO: 'PORT', RISK: 'RISK', MULTI_TIMEFRAME: 'MTF',
};

/** Deterministic id in the form STRAT-<FAMILY>-<name-slug>-<8 hex chars of sha256>-V<version>. */
export function computeStrategyId(input: StrategyIdentityInput): string {
  const hash = createHash('sha256').update(canonicalize({
    family: input.family,
    name: input.name,
    version: input.version,
    entryConditions: input.entryConditions,
    confirmationConditions: input.confirmationConditions,
    invalidationConditions: input.invalidationConditions,
    exitConditions: input.exitConditions,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    positionSizing: input.positionSizing,
    parameterValues: input.parameterValues,
  })).digest('hex');

  const prefix = FAMILY_PREFIX[input.family] ?? input.family;
  const slug = input.name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

  return `STRAT-${prefix}-${slug}-${hash.slice(0, 8)}-V${input.version}`;
}
