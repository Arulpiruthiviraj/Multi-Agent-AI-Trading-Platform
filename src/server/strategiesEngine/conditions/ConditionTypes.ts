/**
 * ==========================================================
 * Module: strategiesEngine/conditions/ConditionTypes
 *
 * Purpose:
 * A small, serializable expression-tree DSL for strategy conditions. A ConditionNode is either a
 * LeafCondition (one real, reusable primitive - PriceAbove, RSIAbove, CrossAbove, ...) or a
 * CompositeCondition (AND/OR/NOT/XOR over child nodes). This is deliberately a data structure, not
 * a class hierarchy: it serializes to plain JSON with no loss (Section 15), is trivially
 * deep-equal-comparable for deterministic-id hashing (core/id.ts), and is interpreted by exactly
 * one function (evaluateCondition.ts) so there is one real place to reason about evaluation
 * semantics rather than N leaf classes each implementing their own evaluate().
 * ==========================================================
 */

/**
 * Every supported leaf primitive. Each is backed by a REAL evaluator in evaluateCondition.ts that
 * reads from MarketSnapshot - none are placeholders. Conditions whose underlying data Argus does
 * not have (order-book imbalance, options greeks, etc.) are simply not in this list; a
 * MarketSnapshot has no field to check them against, so adding such a leaf type would only be able
 * to fabricate a result. See STRATEGIES_ENGINE.md "Condition primitives" for the full rationale
 * per primitive.
 */
export type LeafConditionType =
  | 'PriceAbove' | 'PriceBelow'
  | 'CrossAbove' | 'CrossBelow'
  | 'GreaterThan' | 'LessThan' | 'Between' | 'Equals'
  | 'PercentChange' | 'Slope' | 'DistanceFromPct'
  | 'BreaksHigh' | 'BreaksLow'
  | 'TouchesLevel' | 'RejectsLevel'
  | 'VolumeAboveAverage'
  | 'VolatilityAbove' | 'VolatilityBelow'
  | 'TrendIsBullish' | 'TrendIsBearish'
  | 'RSIAbove' | 'RSIBelow'
  | 'MACDPositive' | 'MACDNegative'
  | 'ADXAbove'
  | 'PriceAboveVWAP' | 'PriceBelowVWAP'
  | 'LiquiditySwept'
  | 'BOSConfirmed' | 'CHoCHConfirmed'
  | 'FVGDetected' | 'FVGPriceInZone' | 'OrderBlockDetected' | 'OrderBlockPriceInZone'
  | 'NewsSentimentAbove' | 'NewsSentimentBelow'
  | 'Always' | 'Never'; // real, trivial constants - useful as generator placeholders, never fabricated data

/**
 * `field` names an indicator/series key on MarketSnapshot.indicators (e.g. 'rsi14', 'ema20',
 * 'adx'). `compareField` is used instead of `value` when comparing two live series (e.g.
 * CrossAbove ema9 over ema20). Not every leaf type uses every param - see evaluateCondition.ts's
 * per-type documentation for exactly which fields each type reads.
 */
export interface LeafCondition {
  kind: 'leaf';
  type: LeafConditionType;
  field?: string;
  compareField?: string;
  value?: number | string | boolean;
  low?: number;
  high?: number;
  lookback?: number;
  tolerancePct?: number;
}

export type CompositeOperator = 'AND' | 'OR' | 'NOT' | 'XOR';

export interface CompositeCondition {
  kind: 'composite';
  op: CompositeOperator;
  children: ConditionNode[];
}

export type ConditionNode = LeafCondition | CompositeCondition;

export function leaf(type: LeafConditionType, params: Omit<LeafCondition, 'kind' | 'type'> = {}): LeafCondition {
  return { kind: 'leaf', type, ...params };
}

export function and(...children: ConditionNode[]): CompositeCondition {
  return { kind: 'composite', op: 'AND', children };
}
export function or(...children: ConditionNode[]): CompositeCondition {
  return { kind: 'composite', op: 'OR', children };
}
export function not(child: ConditionNode): CompositeCondition {
  return { kind: 'composite', op: 'NOT', children: [child] };
}
export function xor(...children: ConditionNode[]): CompositeCondition {
  return { kind: 'composite', op: 'XOR', children };
}
