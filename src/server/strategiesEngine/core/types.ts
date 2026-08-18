/**
 * ==========================================================
 * Module: strategiesEngine/core/types
 *
 * Purpose:
 * Core type model for the standalone Strategies Engine. This subsystem is architecturally
 * ISOLATED from Argus's live decision path (EventBus -> agents -> ChiefTrader -> RiskEngine ->
 * OMS -> BrokerManager) and from the existing live-reachable quant engine
 * (src/server/quant/strategies/*, which BacktestEngine and QuantSignalAgent already consume).
 * Nothing here is imported by ChiefTraderAgent, RiskAgent, OrderManagementService, or any broker
 * adapter, and this module places no calls to any of them. See STRATEGIES_ENGINE.md for the full
 * isolation contract.
 *
 * A StrategyDefinition is a serializable, composable DESCRIPTION of a strategy - not an
 * executable class. Its condition trees are interpreted by conditions/evaluateCondition.ts against
 * a MarketSnapshot (core/MarketSnapshot.ts). This mirrors why the description separates
 * entry/confirmation/invalidation/exit rather than collapsing everything into "if condition then
 * BUY" - see STRATEGIES_ENGINE.md section "Entry / Confirmation / Exit separation".
 * ==========================================================
 */
import { ConditionNode } from '../conditions/ConditionTypes';
import { EvidenceState } from './evidence';

export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export type AssetClass = 'EQUITY' | 'ETF' | 'CRYPTO' | 'FX' | 'FUTURES' | 'OPTIONS';

/** Metadata-only regime tags a strategy can declare compatibility with. Distinct from the live
 *  RegimeEngine's RegimeLabel (src/server/quant/RegimeEngine.ts) - this engine does not import
 *  that type, to keep the two subsystems decoupled; a future adapter can map between them. */
export type StrategyRegimeTag =
  | 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING'
  | 'HIGH_VOLATILITY' | 'LOW_VOLATILITY'
  | 'RISK_ON' | 'RISK_OFF';

/**
 * Strategy family catalog. Every family a real, named cluster from the requested taxonomy.
 * A family's `implementationStatus` in families/catalog.ts (not here - this is just the id space)
 * states honestly whether its seeded base strategies evaluate real conditions against real data
 * (REAL) or are organizational placeholders awaiting a future data/infra adapter (METADATA_ONLY).
 * No family here claims real signal generation it cannot back.
 */
export type StrategyFamily =
  | 'TREND' | 'MOMENTUM' | 'MEAN_REVERSION' | 'BREAKOUT' | 'PULLBACK'
  | 'PRICE_ACTION' | 'CANDLESTICK' | 'SMART_MONEY' | 'MARKET_STRUCTURE'
  | 'SUPPORT_RESISTANCE' | 'FIBONACCI' | 'VOLUME' | 'VOLATILITY' | 'GAP'
  | 'INTRADAY' | 'SCALPING' | 'SWING' | 'STATISTICAL' | 'ARBITRAGE'
  | 'OPTIONS' | 'FUNDAMENTAL' | 'EVENT_DRIVEN' | 'NEWS_SENTIMENT'
  | 'MACHINE_LEARNING' | 'AI' | 'SEASONAL' | 'MACRO' | 'FOREX' | 'FUTURES'
  | 'CRYPTO' | 'ORDER_FLOW' | 'MARKET_MICROSTRUCTURE' | 'MARKET_MAKING'
  | 'PORTFOLIO' | 'RISK' | 'MULTI_TIMEFRAME';

export type ParameterType = 'number' | 'integer' | 'string' | 'boolean' | 'enum';

/**
 * A single tunable parameter and its real discrete/bounded value space (Section 13: parameter
 * space must NOT be eagerly Cartesian-expanded - see generators/ParameterSpace.ts for the lazy
 * iterator that consumes this).
 */
export interface StrategyParameterDef {
  name: string;
  type: ParameterType;
  /** Discrete candidate values (used for 'string'/'enum'/small numeric sets). */
  values?: Array<number | string | boolean>;
  /** Inclusive numeric range + step, alternative to `values` for 'number'/'integer'. */
  range?: { min: number; max: number; step: number };
  default: number | string | boolean;
  description?: string;
}

export type StopLossKind = 'FIXED_PCT' | 'ATR_MULTIPLE' | 'STRUCTURE' | 'TRAILING_ATR' | 'TIME_BASED';
export interface StopLossRule {
  kind: StopLossKind;
  /** Meaning depends on `kind`: pct for FIXED_PCT, ATR multiple for ATR_MULTIPLE/TRAILING_ATR,
   *  bars for TIME_BASED. Structure-based stops carry no numeric value (level comes from the
   *  condition tree's own structure conditions at evaluation time). */
  value: number | null;
  basis: string;
}

export type TakeProfitKind = 'FIXED_PCT' | 'RISK_MULTIPLE' | 'ATR_MULTIPLE' | 'STRUCTURE' | 'OPPOSING_LIQUIDITY';
export interface TakeProfitRule {
  kind: TakeProfitKind;
  value: number | null;
  basis: string;
}

export type PositionSizingKind = 'FIXED_FRACTIONAL' | 'FIXED_DOLLAR_RISK' | 'KELLY' | 'FRACTIONAL_KELLY' | 'VOLATILITY_ADJUSTED' | 'ATR_SIZED';
export interface PositionSizingRule {
  kind: PositionSizingKind;
  value: number | null;
  basis: string;
}

export interface MultiTimeframeSpec {
  trend?: Timeframe;
  structure?: Timeframe;
  entry?: Timeframe;
  execution?: Timeframe;
}

/**
 * REAL means this strategy's condition tree is interpretable by evaluateCondition() against a
 * real MarketSnapshot built from real bars - it will produce a genuine true/false signal.
 * METADATA_ONLY means the definition exists for catalog/organizational/future purposes (e.g.
 * Options, Market Making, ML/AI, most Event-Driven/News) but Argus currently has no real data
 * source or model backing its conditions - the SAME honest convention already established in
 * config/quantMasterTaxonomy.json's NOT_SUPPORTED entries, carried into this new engine rather
 * than re-litigated. A METADATA_ONLY strategy's condition tree, if present, is illustrative and
 * MUST NOT be evaluated as a real signal (validation rejects attempts to mark METADATA_ONLY
 * strategies live-evaluable).
 */
export type ImplementationStatus = 'REAL' | 'METADATA_ONLY';

/** Distinguishes a hand-authored base definition from the generator's parameterized output -
 *  Section 12's "clearly distinguish BASE STRATEGY / VARIANT / GENERATED STRATEGY". */
export type StrategyOrigin = 'BASE' | 'VARIANT' | 'GENERATED';

export interface StrategyMetadata {
  description: string;
  tags: string[];
  assetClasses: AssetClass[];
  timeframes: Timeframe[];
  marketRegimes: StrategyRegimeTag[];
  multiTimeframe?: MultiTimeframeSpec;
  origin: StrategyOrigin;
  /** Which BASE strategy id this was generated/varied from, if origin !== 'BASE'. */
  derivedFromId?: string;
  createdAt: string; // ISO timestamp, set once at creation - immutable (see versioning below)
}

/**
 * The full strategy model. Immutable once created - `bumpVersion()` (core/version.ts) returns a
 * NEW StrategyDefinition with version+1 and a new id, it never mutates the original object
 * in place (Section 16: "Do not silently mutate an existing strategy definition").
 */
export interface StrategyDefinition {
  id: string; // deterministic - see core/id.ts
  name: string;
  version: number;
  family: StrategyFamily;
  implementationStatus: ImplementationStatus;
  requiredIndicators: string[]; // e.g. ['rsi','ema20','ema50'] - informational + validated against conditions
  entryConditions: ConditionNode;
  confirmationConditions: ConditionNode | null;
  invalidationConditions: ConditionNode | null;
  stopLoss: StopLossRule;
  takeProfit: TakeProfitRule | null;
  exitConditions: ConditionNode | null;
  positionSizing: PositionSizingRule;
  parameters: StrategyParameterDef[];
  /** Concrete parameter values this specific definition was instantiated with (subset of
   *  `parameters`' names) - populated for VARIANT/GENERATED origins, empty for a bare BASE
   *  template that hasn't been parameterized yet. */
  parameterValues: Record<string, number | string | boolean>;
  dependencies: string[]; // ids of other StrategyDefinitions this one composes/extends, if any
  metadata: StrategyMetadata;
  /** Real evidence-state ladder position (core/evidence.ts). A strategy existing in the registry
   *  is a CANDIDATE, never a claim of profitability - this field, not implementationStatus, is
   *  what gates promotion toward LIVE_ELIGIBLE, and even LIVE_ELIGIBLE here does not itself
   *  unlock live trading (see evidence.ts's header). */
  evidenceState: EvidenceState;
}

export type StrategySignalSide = 'BUY' | 'SELL' | 'NONE';

/** Output of evaluating one StrategyDefinition against one MarketSnapshot. Never invents a price
 *  or an expected value - `side: 'NONE'` is the honest default when conditions don't clear. */
export interface StrategySignal {
  strategyId: string;
  symbol: string;
  timestamp: number;
  side: StrategySignalSide;
  entryMet: boolean;
  confirmationMet: boolean | null; // null when the strategy defines no confirmation stage
  invalidated: boolean;
  reasons: string[];
}

export interface StrategyResult {
  signal: StrategySignal;
  strategy: StrategyDefinition;
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface StrategyValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
