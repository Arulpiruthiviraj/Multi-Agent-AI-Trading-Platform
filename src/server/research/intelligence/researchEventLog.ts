/**
 * Structured EventBus + observability emission for the research/intelligence layer (Phase 17).
 * Every event carries researchRunId so research activity is traceable but never joins the same
 * counters as live TRADE_IDEA_GENERATED/CHIEF_APPROVED_IDEA/ORDER_EXECUTED lineage — session-report
 * and trading-audit read those, not these.
 */
import { eventBus } from '../../core/EventBus';
import { EVENTS } from '../../core/eventNames';
import { observeSafe, structuredLogger } from '../../observability/StructuredLogger';

export type ResearchEventKey =
  | 'RESEARCH_STRATEGY_GENERATED'
  | 'BACKTEST_STARTED'
  | 'BACKTEST_COMPLETED'
  | 'WALK_FORWARD_COMPLETED'
  | 'REGIME_DETECTED'
  | 'MULTI_FACTOR_EVALUATED'
  | 'STRATEGY_OPTIMIZED'
  | 'CORRELATION_ANALYSIS_COMPLETED'
  | 'RISK_REWARD_ANALYSIS_COMPLETED'
  | 'TRADE_SETUP_GENERATED'
  | 'MONTE_CARLO_COMPLETED'
  | 'DRAWDOWN_ANALYSIS_COMPLETED'
  | 'MACRO_ANALYSIS_COMPLETED'
  | 'ALPHA_RESEARCH_COMPLETED'
  | 'EVOLUTION_CYCLE_STARTED'
  | 'CANDIDATE_GENERATED'
  | 'CANDIDATE_BACKTEST_STARTED'
  | 'CANDIDATE_BACKTEST_FAILED'
  | 'CANDIDATE_OOS_STARTED'
  | 'CANDIDATE_OOS_FAILED'
  | 'CANDIDATE_WALK_FORWARD_STARTED'
  | 'CANDIDATE_PAPER_STARTED'
  | 'CANDIDATE_REJECTED'
  | 'CANDIDATE_VALIDATED'
  | 'CANDIDATE_PROMOTION_BLOCKED'
  | 'CANDIDATE_PROMOTED'
  | 'STRATEGY_ROLLBACK'
  | 'STRATEGY_RETIRED';

export function emitResearchEvent(
  key: ResearchEventKey,
  payload: { researchRunId: string; traceId?: string; symbol?: string; [k: string]: unknown },
): void {
  eventBus.emit(EVENTS[key], { ...payload, canPlaceOrders: false, isLiveTrade: false });
  observeSafe(() => {
    structuredLogger.info(key.toLowerCase(), {
      category: 'RESEARCH',
      eventType: key,
      traceId: payload.traceId,
      decisionId: payload.researchRunId,
      symbol: payload.symbol,
      researchRunId: payload.researchRunId,
    });
  });
}
