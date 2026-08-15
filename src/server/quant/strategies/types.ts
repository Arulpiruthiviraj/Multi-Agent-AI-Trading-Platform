/**
 * ==========================================================
 * Module: strategies/types
 *
 * Purpose:
 * Phase 4 of the additive quant layer - shared types for the Strategy Engine. Every strategy
 * evaluates real, explicit entry/confirmation/invalidation conditions against the real Phase 1-3
 * feature set (never re-deriving its own indicator math), and returns which conditions actually
 * held, which failed, and any real internal contradictions - not a single fabricated score.
 * ==========================================================
 */
import { TrendFeatures } from '../indicators/trend';
import { MomentumFeatures } from '../indicators/momentum';
import { VolatilityFeatures } from '../indicators/volatility';
import { VolumeFeatures } from '../indicators/volume';
import { PriceActionFeatures } from '../indicators/priceAction';
import { SupportResistanceFeatures } from '../indicators/supportResistance';
import { RegimeResult, RegimeLabel } from '../RegimeEngine';
import { MarketContextResult } from '../MarketContext';
import { SmcFeatures } from '../indicators/smc';

export interface StrategyContext {
  symbol: string;
  currentPrice: number;
  trend: TrendFeatures;
  momentum: MomentumFeatures;
  volatility: VolatilityFeatures;
  volume: VolumeFeatures;
  priceAction: PriceActionFeatures;
  supportResistance: SupportResistanceFeatures;
  regime: RegimeResult;
  marketContext: MarketContextResult;
  /** Optional SMC/ICT pattern snapshot. Absent on older fixtures; SMC strategy then scores 0. */
  smc?: SmcFeatures;
}

export interface LevelSuggestion {
  price: number | null;
  basis: string; // e.g. "1x ATR below the broken resistance level" - always states WHY, never a bare number
}

export interface StrategyEvaluation {
  strategy: string;
  side: 'BUY' | 'SELL';
  setupScore: number; // 0-100 - real % of this strategy's own conditions that held
  confidence: number; // 0-1 - setupScore blended with real regime-fit (see StrategyEngine.ts)
  conditionsMet: string[];
  conditionsFailed: string[];
  contradictions: string[]; // real internal conflicts (e.g. bullish momentum but price below VWAP), distinct from a simple unmet condition
  invalidationConditions: string[]; // stated up front, not derived after the fact
  stop: LevelSuggestion;
  target: LevelSuggestion;
  applicableRegimes: RegimeLabel[];
}

/** Every strategy module exports one of these. `evaluate` is pure - same inputs, same output,
 *  no I/O, no randomness - so it's fully unit-testable against constructed fixtures. */
export interface StrategyDefinition {
  id: string;
  displayName: string;
  applicableRegimes: RegimeLabel[];
  evaluate: (ctx: StrategyContext) => StrategyEvaluation;
}

/** Small helper every strategy file uses identically, so setupScore/confidence are computed the
 *  same way everywhere rather than each strategy inventing its own scoring math. */
export function scoreFromConditions(conditionsMet: string[], totalConditions: number): number {
  if (totalConditions === 0) return 0;
  return Math.round((conditionsMet.length / totalConditions) * 100);
}

/**
 * Phase 8's "expected holding period" - a real, documented property of each strategy's OWN
 * design (matches each strategy file's own header comment about its intended use), never a
 * per-trade prediction. trendFollowing.ts already documents it has no fixed target and is meant
 * to be held as long as the trend lasts; meanReversion.ts targets a quick statistical reversion;
 * these descriptions restate what each strategy module already says about itself, in one place
 * ChiefTraderAgent.ts can look up without duplicating that reasoning per-strategy.
 */
export const STRATEGY_TYPICAL_HOLDING_PERIOD: Record<string, string> = {
  MOMENTUM_BREAKOUT: 'Short-term (hours to a few days) - captures the initial breakout move; not designed to be held through a full trend cycle.',
  PULLBACK_CONTINUATION: 'Medium-term (days to weeks) - rides the remainder of an already-established trend after the pullback resolves.',
  MEAN_REVERSION: 'Very short-term (intraday to a few days) - closes once price reverts toward the statistical mean, not designed to be held through a real trend.',
  TREND_FOLLOWING: 'Open-ended - deliberately has no fixed target; held as long as the real trend persists, exited only when its trailing stop is hit or the trend structurally breaks.',
  RANGE_REVERSION: 'Short-term (typically within the current range cycle) - closes at the opposite range boundary; invalidated if the range itself breaks.',
  SMC_LIQUIDITY_SWEEP: 'Short-term (hours to a few days) - waits for liquidity sweep plus CHoCH confirmation, then targets opposing liquidity. UNVALIDATED. Not an automatic fade of every wick.',
};
