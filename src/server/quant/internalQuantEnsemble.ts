/**
 * QuantEngine internal-ensemble independent qualification (2026-09-09, explicit operator
 * override of the QuantEngine Expansion design doc's own §16 recommendation to wait for real
 * correlation/outcome evidence before allowing this - see
 * ChiefTraderAgent.ts's doc comment on isQuantIndependentQualificationEnabled and
 * config/tradingSafety.json's own doc comment on the same flag).
 *
 * Combines the currently-firing TypeScript strategy evaluations (evaluateAll()'s own output, real
 * regime-scoped strategies) with the newly-HTTP-wired Java RESEARCH engines
 * (strategyFamilies.ts's JAVA_RESEARCH_STRATEGY_IDS) into ONE real vote list, sends it through
 * QuantEnsembleEngine.java's correlation-adjusted effectiveIndependentCount() math (never a naive
 * majority vote), and reports whether the result clears the higher bar
 * (minQuantIndependentFamilies / minQuantIndependentEffectiveCount) required to stand in for a
 * second independent agent. Fails closed on any Java-side error - a bridge failure means "not
 * qualified", never a fabricated qualification.
 */
import { quantCoreBridge, type EnsembleModelVote, type EnsembleSide } from '../services/QuantCoreBridge';
import { tradingSafety } from '../config/tradingSafety';
import type { StrategyEvaluation } from './strategies/types';
import { familyForStrategyId, JAVA_RESEARCH_STRATEGY_IDS } from './strategyFamilies';
import type { ResearchBar } from '../research/ohlcvTypes';

export interface InternalEnsembleQualification {
  qualifiesAsIndependent: boolean;
  rawSide: EnsembleSide;
  effectiveIndependentCount: number;
  familyCount: number;
  agreeingFamilies: string[];
  totalVotes: number;
  agreeingModelIds: string[];
  dissentingModelIds: string[];
  /**
   * 2026-09-10 (real observability gap closed, see this module's exported
   * computeInternalEnsembleQualification() doc comment): true when the broader correlation-
   * adjusted ensemble's own resolved side disagrees with the side bestStrategyIdea() already
   * picked for this idea (ensemble.rawSide !== ideaSide). Previously this case collapsed to a
   * bare `null` return, indistinguishable from "agreed but didn't clear the family/effective-
   * count bar" - real evidence about whether QuantEngine's top-1 strategy selection sometimes
   * picks a side the broader evidence set disagrees with was structurally unobservable. Does
   * NOT change qualifiesAsIndependent's meaning or any existing consumer's behavior -
   * qualifiesAsIndependent is still (and must remain) false whenever sideMismatch is true.
   */
  sideMismatch: boolean;
}

/** Simple, honest, non-backtested confidence heuristics for each Java RESEARCH engine's own
 *  result shape - same reasoning discipline as JavaQuantAdvisoryService.ts's factorCompositeToVote
 *  (a reasoned scale, not a claimed calibration). Returns null for NEUTRAL/no-signal. */
function javaResultToVote(strategyId: string, result: Record<string, unknown>): { side: EnsembleSide; confidence: number } | null {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const bool = (v: unknown): boolean => v === true;
  const clamp = (v: number, lo = 0.05, hi = 0.95): number => Math.max(lo, Math.min(hi, v));

  switch (strategyId) {
    case 'rsi_mean_reversion': {
      const side = result.fadeSignal;
      if (side === 'BUY' || side === 'SELL') return { side, confidence: clamp(Math.abs(num(result.rsi) - 50) / 50) };
      return null;
    }
    case 'macd_crossover':
      if (bool(result.bullishCross)) return { side: 'BUY', confidence: 0.6 };
      if (bool(result.bearishCross)) return { side: 'SELL', confidence: 0.6 };
      return null;
    case 'bollinger_mean_reversion': {
      const side = result.fadeSignal;
      if (side === 'BUY' || side === 'SELL') return { side, confidence: 0.6 };
      return null;
    }
    case 'moving_average_crossover':
      if (bool(result.bullishCross)) return { side: 'BUY', confidence: 0.6 };
      if (bool(result.bearishCross)) return { side: 'SELL', confidence: 0.6 };
      return null;
    case 'donchian_channel':
      if (bool(result.breakoutUp)) return { side: 'BUY', confidence: 0.6 };
      if (bool(result.breakoutDown)) return { side: 'SELL', confidence: 0.6 };
      return null;
    case 'trend_strength_adx':
      if (bool(result.strongTrend)) return { side: bool(result.trendingUp) ? 'BUY' : 'SELL', confidence: clamp(num(result.adx) / 50) };
      return null;
    case 'mean_reversion_zscore': {
      const side = result.fadeSignal;
      if (side === 'BUY' || side === 'SELL') return { side, confidence: clamp(Math.abs(num(result.zScore)) / 4) };
      return null;
    }
    case 'stochastic_oscillator':
      if (bool(result.bullishCross)) return { side: 'BUY', confidence: 0.6 };
      if (bool(result.bearishCross)) return { side: 'SELL', confidence: 0.6 };
      return null;
    case 'time_series_momentum':
      if (result.signal === 'BUY' || result.signal === 'SELL') return { side: result.signal, confidence: 0.6 };
      return null;
    case 'volume_signal':
      if (bool(result.bullishDivergence)) return { side: 'BUY', confidence: 0.55 };
      if (bool(result.bearishDivergence)) return { side: 'SELL', confidence: 0.55 };
      return null;
    default:
      return null;
  }
}

/**
 * Strategy-selection confluence guard (2026-09-11, tradingSafety.strategySelectionConfluenceGuardEnabledEnvVar's
 * doc comment has the full reasoning) - pure decision function, extracted so QuantSignalAgent.ts's
 * suppression check is unit-testable without standing up its full evaluateSymbol() dependency graph.
 * Returns true only when: the guard is enabled, the ensemble genuinely disagreed with the picked
 * side, AND the disagreeing side itself clears the exact same bar minQuantIndependentFamilies/
 * minQuantIndependentEffectiveCount already use to let the ensemble stand in for a second agent.
 * Never returns true for a null ensemble or a non-mismatch result - only ever suppresses, never
 * decides what TO emit.
 */
export function shouldSuppressForConfluenceGuard(
  guardEnabled: boolean,
  ensemble: InternalEnsembleQualification | null,
  minFamilies: number,
  minEffectiveCount: number,
): boolean {
  if (!guardEnabled || !ensemble?.sideMismatch) return false;
  return ensemble.familyCount >= minFamilies && ensemble.effectiveIndependentCount >= minEffectiveCount;
}

/**
 * Builds the combined TS+Java vote list and computes the qualification result. Returns null (never
 * fabricates) when the Java ensemble call itself fails or QUANT_JAVA_CORE_ENABLED is off - the
 * caller must treat null exactly like "not qualified", not as an error to surface to the trader.
 */
export async function computeInternalEnsembleQualification(
  symbol: string,
  bars: ResearchBar[],
  strategyEvaluations: StrategyEvaluation[],
  /** The side the QuantEngine idea itself already picked (bestStrategyIdea()'s own output).
   *  Qualification requires the independently-computed ensemble to agree with THIS side - an
   *  ensemble leaning the opposite way must never be reported as confirming this idea. */
  ideaSide: 'BUY' | 'SELL',
): Promise<InternalEnsembleQualification | null> {
  const votes: EnsembleModelVote[] = [];

  for (const e of strategyEvaluations) {
    if (e.side !== 'BUY' && e.side !== 'SELL') continue;
    const family = familyForStrategyId(e.strategy);
    if (!family) continue;
    votes.push({ modelId: e.strategy, family, side: e.side, confidence: e.confidence });
  }

  const javaResults = await Promise.all(
    JAVA_RESEARCH_STRATEGY_IDS.map((id) => quantCoreBridge.fetchResearchStrategy(id, symbol, bars)),
  );
  for (let i = 0; i < JAVA_RESEARCH_STRATEGY_IDS.length; i++) {
    const id = JAVA_RESEARCH_STRATEGY_IDS[i];
    const result = javaResults[i];
    if (!result) continue;
    const vote = javaResultToVote(id, result);
    if (!vote) continue;
    const family = familyForStrategyId(id);
    if (!family) continue;
    votes.push({ modelId: id, family, side: vote.side, confidence: vote.confidence });
  }

  if (votes.length === 0) return null;

  const ensemble = await quantCoreBridge.fetchInstitutionalEnsemble(votes);
  if (!ensemble) return null; // genuine Java-unavailable/error case - fail closed, unchanged

  // 2026-09-11: family count for the ensemble's own resolved side is now computed unconditionally
  // (previously hardcoded to 0/[] whenever sideMismatch was true, since nothing consumed it in
  // that branch). Real callers now exist (strategySelectionConfluenceGuard below) that need a real
  // family count for the DISAGREEING side too, not just the agreeing one - this is the same
  // computation either way, just no longer skipped.
  const familiesOnRawSide = new Set(
    votes.filter((v) => v.side === ensemble.rawSide && ensemble.agreeingModelIds.includes(v.modelId)).map((v) => v.family),
  );

  if (ensemble.rawSide !== ideaSide) {
    // Real, observable case (2026-09-10) - the broader ensemble disagrees with the side
    // bestStrategyIdea() already picked. Never treated as qualification (qualifiesAsIndependent
    // stays false, identical practical effect on ChiefTraderAgent.ts as the previous bare
    // `null` return), but now distinguishable from "agreed, didn't clear the bar" for real
    // research/observability instead of silently discarded.
    return {
      qualifiesAsIndependent: false,
      rawSide: ensemble.rawSide,
      effectiveIndependentCount: ensemble.effectiveIndependentCount,
      familyCount: familiesOnRawSide.size,
      agreeingFamilies: Array.from(familiesOnRawSide),
      totalVotes: ensemble.totalVotes,
      agreeingModelIds: ensemble.agreeingModelIds,
      dissentingModelIds: ensemble.dissentingModelIds,
      sideMismatch: true,
    };
  }

  const qualifiesAsIndependent =
    familiesOnRawSide.size >= tradingSafety.minQuantIndependentFamilies
    && ensemble.effectiveIndependentCount >= tradingSafety.minQuantIndependentEffectiveCount;

  return {
    qualifiesAsIndependent,
    rawSide: ensemble.rawSide,
    effectiveIndependentCount: ensemble.effectiveIndependentCount,
    familyCount: familiesOnRawSide.size,
    agreeingFamilies: Array.from(familiesOnRawSide),
    totalVotes: ensemble.totalVotes,
    agreeingModelIds: ensemble.agreeingModelIds,
    dissentingModelIds: ensemble.dissentingModelIds,
    sideMismatch: false,
  };
}
