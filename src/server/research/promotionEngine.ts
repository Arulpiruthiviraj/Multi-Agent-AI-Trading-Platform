/**
 * Promotion status is derived from evidence booleans. Callers cannot set VALIDATED by assignment.
 */
import { isTheoreticalZeroCost, researchSafety } from '../config/researchSafety';
import type { CanonicalBacktestResult } from './canonicalNextBarEngine';
import { CANONICAL_PROMOTION_FILL, isCanonicalPromotionFill } from './executionModel';

export type StrategyLifecycleStatus =
  | 'UNTESTED'
  | 'BACKTEST_ONLY'
  | 'IN_SAMPLE'
  | 'OOS_TESTING'
  | 'WALK_FORWARD_TESTING'
  | 'ROBUSTNESS_TESTING'
  | 'PAPER_TESTING'
  | 'VALIDATED'
  | 'LIVE_CANDIDATE'
  | 'LIVE_APPROVED'
  | 'DEGRADED'
  | 'RETIRED';

export interface StrategyEvidence {
  strategyId: string;
  strategyVersion: string;
  dataQualityPass: boolean;
  backtestPass: boolean;
  oosPass: boolean;
  walkForwardPass: boolean;
  monteCarloPass: boolean;
  permutationPass: boolean;
  sensitivityPass: boolean;
  costStressPass: boolean;
  paperTrades: number;
  paperSessions: number;
  paperExpectancyPositive: boolean;
  paperDrawdownWithinLimit: boolean;
  riskGatePass: boolean;
  brokerHealthPass: boolean;
  marketDataHealthPass: boolean;
  startupHealthPass: boolean;
  canadianExecutionApproved: boolean;
  isCanadianSecurity: boolean;
  engineMismatch: boolean;
  degraded: boolean;
  retired: boolean;
  manualLiveApproval: boolean;
  organicPaperOnly: boolean;
  dataProvenance: import('./ohlcvTypes').DataProvenance;
  /** Must be NEXT_BAR_OPEN for any lifecycle past UNTESTED. SAME_BAR_CLOSE cannot promote. */
  executionModel: string;
}

export function emptyEvidence(strategyId: string, strategyVersion = '0'): StrategyEvidence {
  return {
    strategyId,
    strategyVersion,
    dataQualityPass: false,
    backtestPass: false,
    oosPass: false,
    walkForwardPass: false,
    monteCarloPass: false,
    permutationPass: false,
    sensitivityPass: false,
    costStressPass: false,
    paperTrades: 0,
    paperSessions: 0,
    paperExpectancyPositive: false,
    paperDrawdownWithinLimit: false,
    riskGatePass: false,
    brokerHealthPass: false,
    marketDataHealthPass: false,
    startupHealthPass: false,
    canadianExecutionApproved: false,
    isCanadianSecurity: false,
    engineMismatch: false,
    degraded: false,
    retired: false,
    manualLiveApproval: false,
    organicPaperOnly: true,
    dataProvenance: 'UNKNOWN',
    executionModel: 'UNKNOWN',
  };
}

export function evidenceFromCanonicalRun(run: CanonicalBacktestResult): StrategyEvidence {
  const e = emptyEvidence(run.strategyId, run.strategyVersion ?? '0');
  e.dataProvenance = run.provenance;
  e.dataQualityPass = run.quality === 'GREEN' && run.provenance === 'REAL_MARKET_DATA';
  e.backtestPass = run.backtestPass === true;
  e.engineMismatch = false;
  e.executionModel = CANONICAL_PROMOTION_FILL;
  if (run.executionModel !== CANONICAL_PROMOTION_FILL) {
    e.engineMismatch = true;
    e.executionModel = run.executionModel;
    e.backtestPass = false;
  }
  if (isTheoreticalZeroCost()) e.backtestPass = false;
  if (run.costModel === 'THEORETICAL_ZERO_COST' || run.rejection === 'THEORETICAL_ZERO_COST') {
    e.backtestPass = false;
  }
  return e;
}

export function deriveLifecycleStatus(e: StrategyEvidence): StrategyLifecycleStatus {
  if (e.retired) return 'RETIRED';
  if (e.degraded) return 'DEGRADED';
  if (e.dataProvenance !== 'REAL_MARKET_DATA') return 'UNTESTED';
  if (e.engineMismatch) return 'UNTESTED';
  if (!isCanonicalPromotionFill(e.executionModel)) return 'UNTESTED';
  // Theoretical zero-cost research cannot climb the lifecycle ladder (not live-readiness evidence).
  if (isTheoreticalZeroCost()) return 'UNTESTED';
  const robustness =
    e.monteCarloPass && e.permutationPass && e.sensitivityPass && e.costStressPass;
  const paper =
    e.paperTrades >= researchSafety.minPaperTrades &&
    e.paperSessions >= researchSafety.minPaperSessions &&
    e.paperExpectancyPositive &&
    e.paperDrawdownWithinLimit &&
    e.organicPaperOnly;
  const liveGates =
    e.dataQualityPass &&
    e.backtestPass &&
    e.oosPass &&
    e.walkForwardPass &&
    robustness &&
    paper &&
    e.riskGatePass &&
    e.brokerHealthPass &&
    e.marketDataHealthPass &&
    e.startupHealthPass &&
    (!e.isCanadianSecurity || e.canadianExecutionApproved);
  if (liveGates && e.manualLiveApproval) return 'LIVE_APPROVED';
  if (liveGates) return 'LIVE_CANDIDATE';
  if (paper && e.backtestPass && e.oosPass && e.walkForwardPass && robustness) return 'VALIDATED';
  if (e.backtestPass && e.oosPass && e.walkForwardPass && robustness) return 'PAPER_TESTING';
  if (e.backtestPass && e.oosPass && e.walkForwardPass) return 'ROBUSTNESS_TESTING';
  if (e.backtestPass && e.oosPass) return 'WALK_FORWARD_TESTING';
  if (e.backtestPass) return 'OOS_TESTING';
  if (e.dataQualityPass) return 'BACKTEST_ONLY';
  return 'UNTESTED';
}

export function liveGoNoGo(e: StrategyEvidence): { live: 'GO' | 'NO-GO'; failedGates: string[] } {
  const status = deriveLifecycleStatus(e);
  const failedGates: string[] = [];
  if (!e.dataQualityPass) failedGates.push('DATA_QUALITY_PASS');
  if (!e.backtestPass) failedGates.push('BACKTEST_PASS');
  if (!e.oosPass) failedGates.push('OOS_PASS');
  if (!e.walkForwardPass) failedGates.push('WALK_FORWARD_PASS');
  if (!e.monteCarloPass) failedGates.push('MONTE_CARLO_PASS');
  if (!e.permutationPass) failedGates.push('PERMUTATION_PASS');
  if (!e.sensitivityPass) failedGates.push('SENSITIVITY_PASS');
  if (!e.costStressPass) failedGates.push('COST_STRESS_PASS');
  if (e.paperTrades < researchSafety.minPaperTrades) failedGates.push('MIN_PAPER_TRADES');
  if (e.paperSessions < researchSafety.minPaperSessions) failedGates.push('MIN_PAPER_SESSIONS');
  if (!e.paperExpectancyPositive) failedGates.push('PAPER_EXPECTANCY_POSITIVE');
  if (!e.paperDrawdownWithinLimit) failedGates.push('PAPER_DRAWDOWN_WITHIN_LIMIT');
  if (!e.riskGatePass) failedGates.push('RISK_GATE_PASS');
  if (!e.brokerHealthPass) failedGates.push('BROKER_HEALTH_PASS');
  if (!e.marketDataHealthPass) failedGates.push('MARKET_DATA_HEALTH_PASS');
  if (!e.startupHealthPass) failedGates.push('STARTUP_HEALTH_PASS');
  if (e.isCanadianSecurity && !e.canadianExecutionApproved) failedGates.push('CANADIAN_EXECUTION_APPROVED');
  if (e.engineMismatch) failedGates.push('ENGINE_MISMATCH');
  if (!isCanonicalPromotionFill(e.executionModel)) failedGates.push('EXECUTION_MODEL_NOT_CANONICAL');
  if (!e.manualLiveApproval) failedGates.push('MANUAL_APPROVAL');
  if (e.degraded) failedGates.push('DEGRADED');
  if (status === 'LIVE_APPROVED' && failedGates.length === 0) return { live: 'GO', failedGates };
  return { live: 'NO-GO', failedGates };
}

export function applyDegradation(e: StrategyEvidence, rollingExpectancy: number | null, drawdownPct: number | null, maxDd = 15): StrategyEvidence {
  const degraded =
    (rollingExpectancy != null && rollingExpectancy < 0) ||
    (drawdownPct != null && drawdownPct > maxDd);
  return { ...e, degraded: e.degraded || degraded };
}
