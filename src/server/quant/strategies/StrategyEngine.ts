/**
 * ==========================================================
 * Module: strategies/StrategyEngine
 *
 * Purpose:
 * Runs strategy modules against one StrategyContext and returns evaluations ranked by setupScore.
 * Each strategy's raw confidence is blended with regime fit: off-regime setups are DISCOUNTED
 * (tradingSafety.regimeMismatchConfidenceMultiplier), never silently zeroed.
 *
 * Two lists:
 *   CORE_STRATEGIES / ALL_STRATEGIES — the original five. Default live evaluateAll() set.
 *   EXPERIMENTAL_STRATEGIES — SMC_LIQUIDITY_SWEEP. Backtestable via findStrategy(); live
 *   evaluateAll() includes them only when QUANT_SMC_STRATEGY_ENABLED=true.
 *
 * ALL_STRATEGIES keeps the historical name so GET /api/v2/quant/strategies `strategies` array
 * and existing tests still see exactly five ids unless that env flag is set.
 * ==========================================================
 */
import { StrategyContext, StrategyEvaluation, StrategyDefinition } from './types';
import { momentumBreakout } from './momentumBreakout';
import { pullbackContinuation } from './pullbackContinuation';
import { meanReversion } from './meanReversion';
import { trendFollowing } from './trendFollowing';
import { rangeReversion } from './rangeReversion';
import { smcLiquiditySweep } from './smcLiquiditySweep';
import { tradingSafety } from '../../config/tradingSafety';
import type { RegimeLabel } from '../RegimeEngine';

/** Original five. Also exported as ALL_STRATEGIES for callers that list "live default" strategies. */
export const CORE_STRATEGIES: StrategyDefinition[] = [momentumBreakout, pullbackContinuation, meanReversion, trendFollowing, rangeReversion];

/**
 * Backtestable and listed under experimentalStrategies on GET /api/v2/quant/strategies.
 * Not in evaluateAll() unless QUANT_SMC_STRATEGY_ENABLED=true (checked at call time, not import time).
 */
export const EXPERIMENTAL_STRATEGIES: StrategyDefinition[] = [smcLiquiditySweep];

/** Live Quant may include experimental strategies only when this env var is the string 'true'. */
export function isSmcLiveQuantEnabled(): boolean {
  return process.env.QUANT_SMC_STRATEGY_ENABLED === 'true';
}

export function resolveStrategiesForLiveEvaluation(): StrategyDefinition[] {
  return isSmcLiveQuantEnabled() ? [...CORE_STRATEGIES, ...EXPERIMENTAL_STRATEGIES] : CORE_STRATEGIES;
}

/** Live default set (the original five). Name preserved for existing imports and tests. */
export const ALL_STRATEGIES = CORE_STRATEGIES;

/** Core first, then experimental — used by BacktestEngine so SMC can be replayed without the live flag. */
export function findStrategy(id: string): StrategyDefinition | undefined {
  return CORE_STRATEGIES.find(s => s.id === id) ?? EXPERIMENTAL_STRATEGIES.find(s => s.id === id);
}

// A strategy evaluated outside its own stated applicable regime(s) has its confidence discounted,
// not zeroed - real evidence, just less trustworthy context. Kept in one place so every strategy's
// regime-fit is judged the same way rather than each module inventing its own penalty.
const REGIME_MISMATCH_CONFIDENCE_MULTIPLIER = tradingSafety.regimeMismatchConfidenceMultiplier;

export function evaluateAll(ctx: StrategyContext): StrategyEvaluation[] {
  return resolveStrategiesForLiveEvaluation()
    .map(strategy => {
      const evaluation = strategy.evaluate(ctx);
      const regimeMatches = evaluation.applicableRegimes.includes(ctx.regime.regime);
      const confidence = Math.round(evaluation.confidence * (regimeMatches ? 1 : REGIME_MISMATCH_CONFIDENCE_MULTIPLIER) * 100) / 100;
      return { ...evaluation, confidence };
    })
    .sort((a, b) => b.setupScore - a.setupScore);
}

/** Real minimum bar before a strategy's evaluation is trusted enough to drive a trade idea -
 *  matches the codebase's own convention (RegimeEngine's placeholder used 0.6 on regime.confidence;
 *  the same bar is applied here to a strategy's own blended confidence). */
export const MIN_STRATEGY_CONFIDENCE_TO_TRADE = tradingSafety.minStrategyConfidenceToTrade;

/**
 * Lists which of the live-evaluated strategies match the current regime.
 * Does not add strategies, execute orders, or zero off-regime confidence (evaluateAll still discounts).
 */
export function regimeStrategyEligibility(evaluations: StrategyEvaluation[], regime: RegimeLabel): {
  eligible: string[];
  ineligible: Array<{ strategy: string; reason: string }>;
} {
  const eligible: string[] = [];
  const ineligible: Array<{ strategy: string; reason: string }> = [];
  for (const e of evaluations) {
    if (e.applicableRegimes.includes(regime)) eligible.push(e.strategy);
    else ineligible.push({
      strategy: e.strategy,
      reason: `Regime ${regime} is outside applicableRegimes (${e.applicableRegimes.join(', ')}). Confidence is discounted, not zeroed, and this is not an automatic trade.`,
    });
  }
  return { eligible, ineligible };
}

export interface StrategyDerivedIdea {
  side: 'BUY' | 'SELL';
  confidence: number;
  reasoning: string;
  strategy: string;
}

/**
 * Picks the single best real strategy signal (highest setupScore among evaluations clearing
 * MIN_STRATEGY_CONFIDENCE_TO_TRADE) to drive a trade idea - `null` when no strategy's real
 * conditions clear the bar, rather than forcing a pick from a weak field.
 */
export function bestStrategyIdea(evaluations: StrategyEvaluation[]): StrategyDerivedIdea | null {
  const eligible = evaluations.filter(e => e.confidence >= MIN_STRATEGY_CONFIDENCE_TO_TRADE);
  if (eligible.length === 0) return null;
  const best = eligible[0]; // evaluateAll already sorts by setupScore descending
  return {
    side: best.side,
    confidence: best.confidence,
    strategy: best.strategy,
    reasoning: `QuantEngine/${best.strategy}: setupScore ${best.setupScore} (${best.conditionsMet.length}/${best.conditionsMet.length + best.conditionsFailed.length} conditions met), confidence ${best.confidence.toFixed(2)}. Met: ${best.conditionsMet.join('; ')}.${best.contradictions.length ? ` Contradictions: ${best.contradictions.join('; ')}.` : ''}`,
  };
}
