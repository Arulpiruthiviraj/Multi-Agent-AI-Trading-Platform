/**
 * ==========================================================
 * Module: strategiesEngine/conditions/evaluateCondition
 *
 * Purpose:
 * The ONE real interpreter for ConditionNode trees (leaf primitives + AND/OR/NOT/XOR composition)
 * against a MarketSnapshot. Every leaf reads real fields only - a missing/null input makes that
 * leaf evaluate to `false` (fail-closed, matching the source indicator modules' own "null, never a
 * fabricated 0" convention), it never throws and never guesses.
 *
 * Two-point series honesty note: MarketSnapshot.series carries only [prior, current] for each
 * named series (see MarketSnapshot.ts), not a full trailing history. `Slope` below is therefore a
 * real two-point delta, not a longer regression slope - this is a disclosed simplification, not a
 * fabrication, and is documented again at its own case below.
 * ==========================================================
 */
import { ConditionNode, LeafCondition, CompositeCondition } from './ConditionTypes';
import { MarketSnapshot } from '../core/MarketSnapshot';

function readNumeric(snapshot: MarketSnapshot, field: string | undefined): number | null {
  if (!field) return null;
  if (field in snapshot.indicators) return snapshot.indicators[field];
  if (field in snapshot.levels) return snapshot.levels[field];
  if (field === 'close') return snapshot.price.close;
  if (field === 'open') return snapshot.price.open;
  if (field === 'high') return snapshot.price.high;
  if (field === 'low') return snapshot.price.low;
  if (field === 'volume') return snapshot.price.volume;
  return null;
}

function readSeries(snapshot: MarketSnapshot, field: string | undefined): [number | null, number | null] {
  if (!field) return [null, null];
  return snapshot.series[field] ?? [null, null];
}

function readFlag(snapshot: MarketSnapshot, field: string | undefined): boolean | null {
  if (!field) return null;
  return snapshot.flags[field] ?? null;
}

function evaluateLeaf(node: LeafCondition, snapshot: MarketSnapshot): boolean {
  switch (node.type) {
    case 'Always': return true;
    case 'Never': return false;

    case 'PriceAbove': {
      const level = node.field ? readNumeric(snapshot, node.field) : (typeof node.value === 'number' ? node.value : null);
      return level !== null && snapshot.price.close > level;
    }
    case 'PriceBelow': {
      const level = node.field ? readNumeric(snapshot, node.field) : (typeof node.value === 'number' ? node.value : null);
      return level !== null && snapshot.price.close < level;
    }

    case 'CrossAbove': {
      const [aPrior, aCur] = readSeries(snapshot, node.field);
      const [bPrior, bCur] = readSeries(snapshot, node.compareField);
      if (aPrior === null || aCur === null || bPrior === null || bCur === null) return false;
      return aPrior <= bPrior && aCur > bCur;
    }
    case 'CrossBelow': {
      const [aPrior, aCur] = readSeries(snapshot, node.field);
      const [bPrior, bCur] = readSeries(snapshot, node.compareField);
      if (aPrior === null || aCur === null || bPrior === null || bCur === null) return false;
      return aPrior >= bPrior && aCur < bCur;
    }

    case 'GreaterThan': {
      const v = readNumeric(snapshot, node.field);
      return v !== null && typeof node.value === 'number' && v > node.value;
    }
    case 'LessThan': {
      const v = readNumeric(snapshot, node.field);
      return v !== null && typeof node.value === 'number' && v < node.value;
    }
    case 'Between': {
      const v = readNumeric(snapshot, node.field);
      return v !== null && node.low !== undefined && node.high !== undefined && v >= node.low && v <= node.high;
    }
    case 'Equals': {
      const v = readNumeric(snapshot, node.field);
      if (v === null || node.value === undefined) return false;
      if (typeof node.value === 'number') return Math.abs(v - node.value) < 1e-9;
      return (v as unknown) === node.value;
    }

    case 'PercentChange':
    case 'Slope': {
      // Real two-point delta (prior -> current) on the named series - not a multi-bar regression
      // slope (MarketSnapshot only carries two points per series). `value` is the minimum
      // required % change (signed - pass a negative value to require a decline).
      const [prior, current] = readSeries(snapshot, node.field);
      if (prior === null || current === null || prior === 0 || typeof node.value !== 'number') return false;
      const pctChange = ((current - prior) / Math.abs(prior)) * 100;
      return node.value >= 0 ? pctChange >= node.value : pctChange <= node.value;
    }

    case 'DistanceFromPct': {
      const level = readNumeric(snapshot, node.field);
      if (level === null || level === 0 || typeof node.value !== 'number') return false;
      const distPct = Math.abs(((snapshot.price.close - level) / level) * 100);
      return distPct <= node.value;
    }

    case 'BreaksHigh': {
      const level = readNumeric(snapshot, node.field);
      return level !== null && snapshot.price.close > level;
    }
    case 'BreaksLow': {
      const level = readNumeric(snapshot, node.field);
      return level !== null && snapshot.price.close < level;
    }

    case 'TouchesLevel': {
      const level = readNumeric(snapshot, node.field);
      if (level === null) return false;
      const tol = node.tolerancePct ?? 0;
      const band = level * (tol / 100);
      return snapshot.price.low <= level + band && snapshot.price.high >= level - band;
    }
    case 'RejectsLevel': {
      // Single-bar rejection: this bar's wick reaches beyond the level but the close stays on the
      // original side. `value` selects the wick direction being tested: 'UP' (wick above the
      // level, close back below - resistance rejection) or 'DOWN' (mirror, support rejection).
      const level = readNumeric(snapshot, node.field);
      if (level === null) return false;
      if (node.value === 'UP') return snapshot.price.high > level && snapshot.price.close < level;
      if (node.value === 'DOWN') return snapshot.price.low < level && snapshot.price.close > level;
      return false;
    }

    case 'VolumeAboveAverage': {
      const rvol = snapshot.indicators.relativeVolume;
      const threshold = typeof node.value === 'number' ? node.value : 1;
      return rvol !== null && rvol >= threshold;
    }

    case 'VolatilityAbove': {
      const v = readNumeric(snapshot, node.field ?? 'atrPercent');
      return v !== null && typeof node.value === 'number' && v > node.value;
    }
    case 'VolatilityBelow': {
      const v = readNumeric(snapshot, node.field ?? 'atrPercent');
      return v !== null && typeof node.value === 'number' && v < node.value;
    }

    case 'TrendIsBullish': return readFlag(snapshot, 'trendBullish') === true;
    case 'TrendIsBearish': return readFlag(snapshot, 'trendBearish') === true;

    case 'RSIAbove': {
      const v = readNumeric(snapshot, node.field ?? 'rsi14');
      return v !== null && typeof node.value === 'number' && v > node.value;
    }
    case 'RSIBelow': {
      const v = readNumeric(snapshot, node.field ?? 'rsi14');
      return v !== null && typeof node.value === 'number' && v < node.value;
    }

    case 'MACDPositive': {
      const v = snapshot.indicators.macdHistogram;
      return v !== null && v > 0;
    }
    case 'MACDNegative': {
      const v = snapshot.indicators.macdHistogram;
      return v !== null && v < 0;
    }

    case 'ADXAbove': {
      const v = snapshot.indicators.adx;
      return v !== null && typeof node.value === 'number' && v >= node.value;
    }

    case 'PriceAboveVWAP': {
      const vwap = snapshot.levels.vwap;
      return vwap !== null && snapshot.price.close > vwap;
    }
    case 'PriceBelowVWAP': {
      const vwap = snapshot.levels.vwap;
      return vwap !== null && snapshot.price.close < vwap;
    }

    case 'LiquiditySwept': return readFlag(snapshot, 'liquiditySwept') === true;
    case 'BOSConfirmed': return readFlag(snapshot, 'bosConfirmed') === true;
    case 'CHoCHConfirmed': return readFlag(snapshot, 'choChConfirmed') === true;
    case 'FVGDetected': return readFlag(snapshot, 'fvgDetected') === true;
    case 'FVGPriceInZone': return readFlag(snapshot, 'fvgPriceInZone') === true;
    case 'OrderBlockDetected': return readFlag(snapshot, 'orderBlockDetected') === true;
    case 'OrderBlockPriceInZone': return readFlag(snapshot, 'orderBlockPriceInZone') === true;

    case 'NewsSentimentAbove': {
      const v = snapshot.indicators.newsSentiment;
      return v !== null && typeof node.value === 'number' && v > node.value;
    }
    case 'NewsSentimentBelow': {
      const v = snapshot.indicators.newsSentiment;
      return v !== null && typeof node.value === 'number' && v < node.value;
    }

    default: {
      const _exhaustive: never = node.type;
      return _exhaustive;
    }
  }
}

function evaluateComposite(node: CompositeCondition, snapshot: MarketSnapshot): boolean {
  switch (node.op) {
    case 'AND': return node.children.every(c => evaluateCondition(c, snapshot));
    case 'OR': return node.children.some(c => evaluateCondition(c, snapshot));
    case 'NOT': return !evaluateCondition(node.children[0], snapshot);
    case 'XOR': return node.children.filter(c => evaluateCondition(c, snapshot)).length % 2 === 1;
    default: {
      const _exhaustive: never = node.op;
      return _exhaustive;
    }
  }
}

export function evaluateCondition(node: ConditionNode, snapshot: MarketSnapshot): boolean {
  return node.kind === 'leaf' ? evaluateLeaf(node, snapshot) : evaluateComposite(node, snapshot);
}
