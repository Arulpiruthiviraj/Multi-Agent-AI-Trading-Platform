/**
 * 2026-09-10, explicit operator override of this codebase's own stated shadow-tracking
 * precondition (same pattern as JavaQuantAdvisoryService.ts's 2026-09-09 override for
 * JavaFactorComposite - see that file's own header for the precedent).
 *
 * Closes the real, verified gap identified in the "Autonomous Java Quant Engine Wiring" mandate:
 * CoreStrategyRunner's 5 CORE-strategy Java ensemble (RangeReversion/PullbackContinuation/
 * MeanReversion/TrendFollowing/MomentumBreakout - each computing its OWN features from canonical
 * bars via FeaturesToStrategyContextAdapter, never fed TS's precomputed StrategyContext) was
 * already being called in production every QuantSignalAgent cycle (quantCoreBridge.
 * fetchCoreEnsembleDecision()), but strictly for shadow-parity logging
 * (QUANT_CORE_STRATEGY_PARITY_DIVERGENCE) - the result never reached a real vote. This module is
 * the missing link: one real, independent TRADE_IDEA_GENERATED vote per eligible ensemble
 * decision, through the SAME eventBus.emitTradeIdea() entry point and unchanged downstream
 * ChiefTrader/RiskEngine/OMS spine every other agent uses - never a CHIEF_APPROVED_IDEA, never a
 * placeOrder call from this module, never touches consensusApprovalThreshold or
 * minIndependentAgreeingAgents.
 *
 * Real evidence base at the time this was enabled: ~99 shadow observations over ~4 hours
 * (docs/audits/ARGUS_JAVA_QUANT_PHASE2_PRELIMINARY_PARITY_2026-09-10.md) - short of this
 * deployment's own documented "multi-week clean shadow-divergence-tracking window" precondition
 * (docs/architecture/ARGUS_ARCHITECTURE.md § Java Quant Core). The operator was told this
 * directly and chose to override it anyway.
 *
 * Gated behind FOUR independent checks (one more than JavaFactorComposite's three, since this
 * also requires Java's own status field to report HEALTHY - never DEGRADED/UNAVAILABLE):
 *   1. isJavaCoreEnsembleVoteEnabled() - the master flag (ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED)
 *   2. isPipelineAgentEnabled('JavaCoreEnsemble') - Mission Control per-agent toggle
 *   3. isLiveIdeaGenerationEnabled() - Autobot/session-recovery/campaign-lock composite gate
 *   4. ensemble.status === 'HEALTHY' - Java's own data-sufficiency/quality gate
 * Even when all four pass, the vote only fires when direction is not HOLD and confidence clears
 * javaCoreEnsembleVoteMinConfidence - never less scrutiny than an idea already needed.
 *
 * A genuinely distinct signal source from JavaFactorComposite (5-factor GARCH/HMM/factor-
 * composite model) - this is the 5-CORE-strategy technical/momentum/mean-reversion ensemble.
 * Different Java engine, different underlying features, different math - not a duplicate vote of
 * the same information under two names.
 */
import { eventBus } from '../core/EventBus';
import { generateTraceId } from '../core/traceId';
import { isJavaCoreEnsembleVoteEnabled, tradingSafety } from '../config/tradingSafety';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import type { CoreEnsembleDecision } from './QuantCoreBridge';

export interface JavaCoreEnsembleVoteResult {
  emitted: boolean;
  reason:
    | 'EMITTED'
    | 'FLAG_OFF'
    | 'AGENT_DISABLED'
    | 'IDEA_GENERATION_GATED'
    | 'NOT_HEALTHY'
    | 'HOLD_DIRECTION'
    | 'BELOW_MIN_CONFIDENCE'
    | 'INVALID_PRICE';
}

/**
 * 2026-09-10, explicit operator override - see this file's own header for the full reasoning.
 * One independent TRADE_IDEA_GENERATED vote per eligible ensemble decision, same
 * eventBus.emitTradeIdea entry point and same downstream ChiefTrader/RiskEngine/OMS spine every
 * other agent uses - never a CHIEF_APPROVED_IDEA, never a placeOrder call from this module.
 */
export function emitJavaCoreEnsembleVoteIfEligible(
  symbol: string,
  ensemble: CoreEnsembleDecision,
  currentPrice: number | null,
): JavaCoreEnsembleVoteResult {
  if (!isJavaCoreEnsembleVoteEnabled()) return { emitted: false, reason: 'FLAG_OFF' };
  if (!isPipelineAgentEnabled('JavaCoreEnsemble')) return { emitted: false, reason: 'AGENT_DISABLED' };
  if (!isLiveIdeaGenerationEnabled()) return { emitted: false, reason: 'IDEA_GENERATION_GATED' };
  if (ensemble.status !== 'HEALTHY') return { emitted: false, reason: 'NOT_HEALTHY' };
  if (ensemble.direction === 'HOLD') return { emitted: false, reason: 'HOLD_DIRECTION' };
  if (ensemble.confidence < tradingSafety.javaCoreEnsembleVoteMinConfidence) {
    return { emitted: false, reason: 'BELOW_MIN_CONFIDENCE' };
  }
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { emitted: false, reason: 'INVALID_PRICE' };
  }

  const traceId = generateTraceId(symbol);
  eventBus.emitTradeIdea({
    traceId,
    symbol,
    side: ensemble.direction,
    confidence: ensemble.confidence,
    currentPrice,
    reasoning: `[Java CORE Ensemble, regime=${ensemble.regime ?? 'unknown'}] ${ensemble.reason} `
      + `(${ensemble.agreeingCount}/${ensemble.strategyCount} strategies agree, `
      + `effIndep=${ensemble.effectiveIndependentCount.toFixed(2)}, families=${ensemble.contributingFamilies.join(',')})`,
    agent: 'JavaCoreEnsemble',
    strategy: 'JAVA_CORE_ENSEMBLE',
    timeframe: 'intraday',
    evidence: {
      score: ensemble.score,
      strategyCount: ensemble.strategyCount,
      agreeingCount: ensemble.agreeingCount,
      effectiveIndependentCount: ensemble.effectiveIndependentCount,
      contributingStrategies: ensemble.contributingStrategies,
      contributingFamilies: ensemble.contributingFamilies,
      featureVersion: ensemble.featureVersion,
      strategyVersion: ensemble.strategyVersion,
    },
  });
  return { emitted: true, reason: 'EMITTED' };
}
