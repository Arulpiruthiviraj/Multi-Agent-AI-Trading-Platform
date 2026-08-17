/**
 * Promotion status is derived from evidence booleans. Callers cannot set VALIDATED by assignment.
 */
import { isTheoreticalZeroCost, researchSafety } from '../config/researchSafety';
import type { CanonicalBacktestResult } from './canonicalNextBarEngine';
import { CANONICAL_PROMOTION_FILL, isCanonicalPromotionFill } from './executionModel';
import { parquetBytesExistOnDisk } from './parquetStore';

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

export type EvidenceQualityStatus = 'GREEN' | 'YELLOW' | 'RED' | 'UNAVAILABLE' | 'UNKNOWN';

export interface StrategyEvidence {
  strategyId: string;
  strategyVersion: string;
  dataQualityPass: boolean;
  /** Explicit warehouse quality — must be GREEN for promotion past UNTESTED. */
  qualityStatus: EvidenceQualityStatus;
  /** Physical .parquet must exist; sidecar flag alone is insufficient. */
  parquetBytesWritten: boolean;
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
  /** Organic paper profit factor ≥ researchSafety.minPaperProfitFactor. */
  paperProfitFactorPass: boolean;
  /** Distinct NY calendar days with organic closes ≥ researchSafety.minPaperCalendarDays. */
  paperCalendarDaysPass: boolean;
  riskGatePass: boolean;
  brokerHealthPass: boolean;
  marketDataHealthPass: boolean;
  startupHealthPass: boolean;
  omsHealthPass: boolean;
  reconciliationHealthPass: boolean;
  restartRecoveryPass: boolean;
  failureRecoveryPass: boolean;
  observabilityPass: boolean;
  securityPass: boolean;
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
  datasetId?: string | null;
}

/** Fail-closed promotion storage / execution quarantine. */
export function assertPromotionQuarantine(opts: {
  executionModel: string;
  qualityStatus: string;
  parquetBytesWritten: boolean;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (opts.executionModel === 'SAME_BAR_CLOSE') {
    reasons.push('SAME_BAR_CLOSE_NOT_PROMOTABLE');
  }
  if (!isCanonicalPromotionFill(opts.executionModel)) {
    reasons.push('EXECUTION_MODEL_NOT_CANONICAL');
  }
  if (opts.qualityStatus !== 'GREEN') {
    reasons.push('QUALITY_STATUS_NOT_GREEN');
  }
  if (opts.parquetBytesWritten !== true) {
    reasons.push('PARQUET_BYTES_NOT_WRITTEN');
  }
  return { ok: reasons.length === 0, reasons };
}

export function emptyEvidence(strategyId: string, strategyVersion = '0'): StrategyEvidence {
  return {
    strategyId,
    strategyVersion,
    dataQualityPass: false,
    qualityStatus: 'UNKNOWN',
    parquetBytesWritten: false,
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
    paperProfitFactorPass: false,
    paperCalendarDaysPass: false,
    riskGatePass: false,
    brokerHealthPass: false,
    marketDataHealthPass: false,
    startupHealthPass: false,
    omsHealthPass: false,
    reconciliationHealthPass: false,
    restartRecoveryPass: false,
    failureRecoveryPass: false,
    observabilityPass: false,
    securityPass: false,
    canadianExecutionApproved: false,
    isCanadianSecurity: false,
    engineMismatch: false,
    degraded: false,
    retired: false,
    manualLiveApproval: false,
    organicPaperOnly: true,
    dataProvenance: 'UNKNOWN',
    executionModel: 'UNKNOWN',
    datasetId: null,
  };
}

export function evidenceFromCanonicalRun(run: CanonicalBacktestResult): StrategyEvidence {
  const e = emptyEvidence(run.strategyId, run.strategyVersion ?? '0');
  e.dataProvenance = run.provenance;
  e.qualityStatus = (run.quality as EvidenceQualityStatus) || 'UNKNOWN';
  e.datasetId = run.datasetId ?? null;
  e.parquetBytesWritten = run.datasetId ? parquetBytesExistOnDisk(run.datasetId) : false;
  e.dataQualityPass =
    e.qualityStatus === 'GREEN' &&
    run.provenance === 'REAL_MARKET_DATA' &&
    e.parquetBytesWritten === true;
  e.backtestPass = run.backtestPass === true;
  e.engineMismatch = false;
  e.executionModel = CANONICAL_PROMOTION_FILL;
  if (run.executionModel !== CANONICAL_PROMOTION_FILL) {
    e.engineMismatch = true;
    e.executionModel = run.executionModel;
    e.backtestPass = false;
  }
  const q = assertPromotionQuarantine({
    executionModel: e.executionModel,
    qualityStatus: e.qualityStatus,
    parquetBytesWritten: e.parquetBytesWritten,
  });
  if (!q.ok) {
    e.backtestPass = false;
    e.dataQualityPass = false;
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
  const quarantine = assertPromotionQuarantine({
    executionModel: e.executionModel,
    qualityStatus: e.qualityStatus,
    parquetBytesWritten: e.parquetBytesWritten,
  });
  if (!quarantine.ok) return 'UNTESTED';
  // Theoretical zero-cost research cannot climb the lifecycle ladder (not live-readiness evidence).
  if (isTheoreticalZeroCost()) return 'UNTESTED';
  const robustness =
    e.monteCarloPass && e.permutationPass && e.sensitivityPass && e.costStressPass;
  const paper =
    e.paperTrades >= researchSafety.minPaperTrades &&
    e.paperSessions >= researchSafety.minPaperSessions &&
    e.paperExpectancyPositive &&
    e.paperDrawdownWithinLimit &&
    e.paperProfitFactorPass &&
    e.paperCalendarDaysPass &&
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
    e.omsHealthPass &&
    e.reconciliationHealthPass &&
    e.restartRecoveryPass &&
    e.failureRecoveryPass &&
    e.observabilityPass &&
    e.securityPass &&
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
  const quarantine = assertPromotionQuarantine({
    executionModel: e.executionModel,
    qualityStatus: e.qualityStatus,
    parquetBytesWritten: e.parquetBytesWritten,
  });
  for (const r of quarantine.reasons) failedGates.push(r);
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
  if (!e.paperProfitFactorPass) failedGates.push('PAPER_PROFIT_FACTOR');
  if (!e.paperCalendarDaysPass) failedGates.push('PAPER_CALENDAR_DAYS');
  if (!e.riskGatePass) failedGates.push('RISK_GATE_PASS');
  if (!e.brokerHealthPass) failedGates.push('BROKER_HEALTH_PASS');
  if (!e.marketDataHealthPass) failedGates.push('MARKET_DATA_HEALTH_PASS');
  if (!e.startupHealthPass) failedGates.push('STARTUP_HEALTH_PASS');
  if (!e.omsHealthPass) failedGates.push('OMS_HEALTH');
  if (!e.reconciliationHealthPass) failedGates.push('RECONCILIATION_HEALTH');
  if (!e.restartRecoveryPass) failedGates.push('RESTART_RECOVERY');
  if (!e.failureRecoveryPass) failedGates.push('FAILURE_RECOVERY');
  if (!e.observabilityPass) failedGates.push('OBSERVABILITY');
  if (!e.securityPass) failedGates.push('SECURITY');
  if (e.isCanadianSecurity && !e.canadianExecutionApproved) failedGates.push('CANADIAN_EXECUTION_APPROVED');
  if (e.engineMismatch) failedGates.push('ENGINE_MISMATCH');
  if (!e.manualLiveApproval) failedGates.push('MANUAL_APPROVAL');
  if (e.degraded) failedGates.push('DEGRADED');
  if (status === 'LIVE_APPROVED' && failedGates.length === 0) return { live: 'GO', failedGates };
  return { live: 'NO-GO', failedGates: [...new Set(failedGates)] };
}

export function applyDegradation(e: StrategyEvidence, rollingExpectancy: number | null, drawdownPct: number | null, maxDd = 15): StrategyEvidence {
  const degraded =
    (rollingExpectancy != null && rollingExpectancy < 0) ||
    (drawdownPct != null && drawdownPct > maxDd);
  return { ...e, degraded: e.degraded || degraded };
}
