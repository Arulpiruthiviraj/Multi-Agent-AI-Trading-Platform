/**
 * ==========================================================
 * Module: strategiesEngine/conditions/conditionCatalog
 *
 * Purpose:
 * The authoritative list of every LeafConditionType evaluateCondition.ts actually implements -
 * kept as a real runtime array (not just the TS union in ConditionTypes.ts) so validation and
 * stats reporting can enumerate/count real primitives without a compile-time-only type, and so
 * this list and evaluateCondition.ts's switch statement can be cross-checked by a test (a leaf
 * type present in one but not the other is a real bug).
 * ==========================================================
 */
import { LeafConditionType } from './ConditionTypes';

export const LEAF_CONDITION_TYPES: LeafConditionType[] = [
  'PriceAbove', 'PriceBelow',
  'CrossAbove', 'CrossBelow',
  'GreaterThan', 'LessThan', 'Between', 'Equals',
  'PercentChange', 'Slope', 'DistanceFromPct',
  'BreaksHigh', 'BreaksLow',
  'TouchesLevel', 'RejectsLevel',
  'VolumeAboveAverage',
  'VolatilityAbove', 'VolatilityBelow',
  'TrendIsBullish', 'TrendIsBearish',
  'RSIAbove', 'RSIBelow',
  'MACDPositive', 'MACDNegative',
  'ADXAbove',
  'PriceAboveVWAP', 'PriceBelowVWAP',
  'LiquiditySwept',
  'BOSConfirmed', 'CHoCHConfirmed',
  'FVGDetected', 'FVGPriceInZone', 'OrderBlockDetected', 'OrderBlockPriceInZone',
  'NewsSentimentAbove', 'NewsSentimentBelow',
  'Always', 'Never',
];
