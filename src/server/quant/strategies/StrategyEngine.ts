/**
 * ==========================================================
 * Module: strategies/StrategyEngine
 *
 * Purpose:
 * Phase 4 of the additive quant layer - runs all 5 real strategy modules against one real
 * StrategyContext and returns their evaluations, ranked by real setupScore. Each strategy's raw
 * confidence (setupScore/100, computed by the strategy itself) is blended here with how well the
 * CURRENT regime actually matches that strategy's own `applicableRegimes` - a strategy whose
 * conditions mostly held but whose regime doesn't fit (e.g. Mean Reversion's conditions scoring
 * well during a real BULLISH_TREND) is real signal, but a materially less trustworthy one, and that
 * distinction must not be silently lost by only reporting the raw condition-match score.
 * ==========================================================
 */
import { StrategyContext, StrategyEvaluation } from './types';
import { momentumBreakout } from './momentumBreakout';
import { pullbackContinuation } from './pullbackContinuation';
import { meanReversion } from './meanReversion';
import { trendFollowing } from './trendFollowing';
import { rangeReversion } from './rangeReversion';
import { tradingSafety } from '../../config/tradingSafety';
import type { RegimeLabel } from '../RegimeEngine';

export const ALL_STRATEGIES = [momentumBreakout, pullbackContinuation, meanReversion, trendFollowing, rangeReversion];

// A strategy evaluated outside its own stated applicable regime(s) has its confidence discounted,
// not zeroed - real evidence, just less trustworthy context. Kept in one place so every strategy's
// regime-fit is judged the same way rather than each module inventing its own penalty.
const REGIME_MISMATCH_CONFIDENCE_MULTIPLIER = tradingSafety.regimeMismatchConfidenceMultiplier;

export function evaluateAll(ctx: StrategyContext): StrategyEvaluation[] {
  return ALL_STRATEGIES
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
 * Lists which of the five existing strategies match the current regime.
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
