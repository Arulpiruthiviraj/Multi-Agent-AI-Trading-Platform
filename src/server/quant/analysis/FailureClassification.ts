/**
 * ==========================================================
 * Module: quant/analysis/FailureClassification
 *
 * Purpose:
 * E4 (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - post-trade failure classification for closed
 * losing trades produced by BacktestEngine.runStrategyBacktest(). Only implements categories
 * that are REAL and DERIVABLE from this backtest engine's actual telemetry (entry regime, entry
 * contradictions, R-multiple, entry+exit slippage) - deliberately does NOT implement categories
 * that would require data this backtest engine does not have. Matches this codebase's
 * established "never fabricate" convention (e.g. MarketContext.ts's honest
 * breadth:{available:false}): an honest UNKNOWN beats a confident wrong guess.
 * ==========================================================
 */
import { RegimeLabel } from '../RegimeEngine';

export const FAILURE_CATEGORIES = [
  'BAD_REGIME', 'SIGNAL_CONFLICT', 'STOP_LOSS_HIT', 'SLIPPAGE_DRAG', 'UNKNOWN',
] as const;
export type FailureCategory = typeof FAILURE_CATEGORIES[number];

/**
 * Requested by the original audit but NOT implemented here, honestly, rather than faked:
 * - NEWS_REVERSAL, AI_ERROR: would require live news/AI-consensus involvement, which
 *   BacktestEngine.runStrategyBacktest() deliberately does not run (see BacktestEngine.ts's own
 *   module header - it backtests the deterministic quant strategy only, never re-runs the live
 *   AI-agent pipeline against historical data).
 * - RISK_ERROR, EXECUTION_ERROR: would require a real RiskEngine gate ladder or broker call,
 *   neither of which this backtest simulates (PositionSizing.ts's pure math is reused, but no
 *   live RiskEngine circuit breaker or broker rejection can occur in a backtest).
 * - FALSE_BREAKOUT, LOW_VOLUME, HIGH_VOLATILITY, TARGET_TOO_FAR, CORRELATION, WRONG_DIRECTION,
 *   POOR_ENTRY, MARKET_REVERSAL: would require confidently attributing one SPECIFIC causal
 *   condition among dozens each strategy checks, which conditionsMet/conditionsFailed does not
 *   support without fragile per-strategy string matching that could silently break if a
 *   strategy's condition text changes. A wrong guess here would actively mislead; UNKNOWN does not.
 */
export const UNIMPLEMENTED_FAILURE_CATEGORIES = [
  'NEWS_REVERSAL', 'AI_ERROR', 'RISK_ERROR', 'EXECUTION_ERROR', 'FALSE_BREAKOUT', 'LOW_VOLUME',
  'HIGH_VOLATILITY', 'TARGET_TOO_FAR', 'CORRELATION', 'WRONG_DIRECTION', 'POOR_ENTRY', 'MARKET_REVERSAL',
] as const;

export interface FailureClassificationInput {
  entryRegime: RegimeLabel | undefined;
  applicableRegimes: RegimeLabel[];
  entryContradictions: string[];
  rMultiple: number | undefined;
  entrySlippagePct: number;
  exitSlippagePct: number;
}

export interface FailureClassificationResult {
  category: FailureCategory;
  detail: string;
}

/** Pure, deterministic, checked in a fixed priority order so the same trade always classifies the
 *  same way - never randomized or LLM-guessed. */
export function classifyTradeFailure(input: FailureClassificationInput): FailureClassificationResult {
  if (input.entryRegime && !input.applicableRegimes.includes(input.entryRegime)) {
    return {
      category: 'BAD_REGIME',
      detail: `Entered during ${input.entryRegime}, outside this strategy's applicable regimes (${input.applicableRegimes.join(', ')}) - StrategyEngine discounts but does not block off-regime setups.`,
    };
  }
  if (input.entryContradictions.length > 0) {
    return {
      category: 'SIGNAL_CONFLICT',
      detail: `Entry had ${input.entryContradictions.length} recorded internal contradiction(s): ${input.entryContradictions.join('; ')}`,
    };
  }
  if (input.rMultiple !== undefined && input.rMultiple <= -0.9) {
    return {
      category: 'STOP_LOSS_HIT',
      detail: `Closed at ${input.rMultiple}R - essentially the full modeled entry-stop distance was given back.`,
    };
  }
  const combinedSlippagePct = input.entrySlippagePct + input.exitSlippagePct;
  if (combinedSlippagePct > 0.01) {
    return {
      category: 'SLIPPAGE_DRAG',
      detail: `Combined entry+exit slippage of ${(combinedSlippagePct * 100).toFixed(2)}% materially eroded this trade's result.`,
    };
  }
  return {
    category: 'UNKNOWN',
    detail: 'No single dominant factor identified among the categories this backtest engine can honestly derive from its own real telemetry.',
  };
}

/** Aggregates classified losing trades into a real distribution ("35% bad regime, 22%..."),
 *  recomputed from the real trade log (tradeLog[].failureCategory) - never a second source of
 *  truth that could drift from it. */
export function computeFailureBreakdown(tradeLog: Array<{ side: string; realizedPnl?: number; failureCategory?: string }>) {
  const losses = tradeLog.filter(t => t.side === 'SELL' && typeof t.realizedPnl === 'number' && (t.realizedPnl as number) < 0);
  const byCategory: Record<string, number> = {};
  for (const t of losses) {
    const cat = t.failureCategory || 'UNKNOWN';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  return {
    totalLosses: losses.length,
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([cat, count]) => [
        cat,
        { count, pctOfLosses: losses.length > 0 ? Number(((count / losses.length) * 100).toFixed(1)) : 0 },
      ])
    ),
  };
}
