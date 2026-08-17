import { researchSafety } from '../config/researchSafety';
import {
  deriveLifecycleStatus,
  emptyEvidence,
  liveGoNoGo,
  type StrategyEvidence,
} from './promotionEngine';
import { compareExecutionModels, executionModelVersion } from './executionModel';
import { loadPersistedEvidenceForStrategy } from './researchRuns';
import { parquetBytesExistOnDisk } from './parquetStore';

function gateLabel(pass: boolean | undefined, evaluated: boolean): 'PASS' | 'FAIL' | 'UNTESTED' {
  if (!evaluated) return 'UNTESTED';
  return pass ? 'PASS' : 'FAIL';
}

function resolveEvidence(strategyId: string): { evidence: StrategyEvidence; evaluated: boolean } {
  const persisted = loadPersistedEvidenceForStrategy(strategyId);
  if (!persisted) return { evidence: emptyEvidence(strategyId), evaluated: false };
  // Re-verify parquet still on disk — never trust a stale sidecar-only flag.
  if (persisted.datasetId && !parquetBytesExistOnDisk(persisted.datasetId)) {
    return {
      evidence: {
        ...persisted,
        parquetBytesWritten: false,
        dataQualityPass: false,
      },
      evaluated: true,
    };
  }
  return { evidence: persisted, evaluated: true };
}

export function coreStrategyInventory() {
  return researchSafety.coreStrategyIds.map((strategyId) => {
    const { evidence, evaluated } = resolveEvidence(strategyId);
    return {
      strategyId,
      strategyVersion: evidence.strategyVersion || 'CORE_REPO',
      family: 'CORE',
      adapter: 'FEATURE_SUBSET_PARITY' as const,
      status: deriveLifecycleStatus(evidence),
      evaluated,
      backtest: gateLabel(evidence.backtestPass, evaluated),
      oos: gateLabel(evidence.oosPass, evaluated),
      wfo: gateLabel(evidence.walkForwardPass, evaluated),
      robustness: gateLabel(
        evidence.monteCarloPass && evidence.permutationPass && evidence.sensitivityPass && evidence.costStressPass,
        evaluated,
      ),
      smcUnvalidated: false,
      note: researchSafety.proxyAdapterNote,
      inventedResults: false,
    };
  });
}

export function experimentalInventory() {
  return researchSafety.experimentalStrategyIds.map((strategyId) => ({
    strategyId,
    strategyVersion: 'EXPERIMENTAL_REPO',
    family: 'EXPERIMENTAL',
    status: strategyId === 'SMC_LIQUIDITY_SWEEP' ? 'UNVALIDATED' : deriveLifecycleStatus(emptyEvidence(strategyId)),
    inventedResults: false,
  }));
}

export function researchComparisonMatrix() {
  const ids = [...researchSafety.coreStrategyIds, ...researchSafety.experimentalStrategyIds];
  const rows = ids.map((strategyId) => {
    if (strategyId === 'SMC_LIQUIDITY_SWEEP') {
      return {
        strategy: strategyId,
        featureParity: 'PROXY_NOT_FEATURE_PARITY',
        data: 'UNAVAILABLE',
        backtest: 'UNTESTED',
        oos: 'UNTESTED',
        wfo: 'UNTESTED',
        permutation: 'UNTESTED',
        mc: 'UNTESTED',
        sensitivity: 'UNTESTED',
        costs: 'UNTESTED',
        paper: 'UNTESTED',
        final: 'UNVALIDATED',
        invented: false,
      };
    }
    const { evidence, evaluated } = resolveEvidence(strategyId);
    return {
      strategy: strategyId,
      featureParity: 'FEATURE_SUBSET_PARITY',
      data: evidence.qualityStatus === 'GREEN' && evidence.parquetBytesWritten ? 'GREEN_PARQUET' : evaluated ? 'EVALUATED' : 'UNAVAILABLE',
      backtest: gateLabel(evidence.backtestPass, evaluated),
      oos: gateLabel(evidence.oosPass, evaluated),
      wfo: gateLabel(evidence.walkForwardPass, evaluated),
      permutation: gateLabel(evidence.permutationPass, evaluated),
      mc: gateLabel(evidence.monteCarloPass, evaluated),
      sensitivity: gateLabel(evidence.sensitivityPass, evaluated),
      costs: gateLabel(evidence.costStressPass, evaluated),
      paper: gateLabel(
        evidence.paperTrades >= researchSafety.minPaperTrades && evidence.paperExpectancyPositive,
        evaluated && evidence.paperTrades > 0,
      ),
      final: deriveLifecycleStatus(evidence),
      invented: false,
    };
  });
  const mismatch = compareExecutionModels('NEXT_BAR_OPEN', 'SAME_BAR_CLOSE');
  return {
    inSample: rows.some((r) => r.backtest === 'PASS') ? 'EVALUATED' : 'UNTESTED',
    outOfSample: rows.some((r) => r.oos === 'PASS') ? 'EVALUATED' : 'UNTESTED',
    paper: rows.some((r) => r.paper === 'PASS') ? 'EVALUATED' : 'UNTESTED',
    executionModelVersion: executionModelVersion(),
    canonicalResearchFill: 'NEXT_BAR_OPEN',
    backtestEngineFill: 'SAME_BAR_CLOSE',
    engineCompare: mismatch,
    rows,
  };
}

export function liveCandidateReportMarkdown(): string {
  const lines = ['# LIVE_CANDIDATE_REPORT', '', 'Promotion evidence from baseline_index when present. Never fabricated.', ''];
  for (const id of [...researchSafety.coreStrategyIds, ...researchSafety.experimentalStrategyIds, 'GOLDEN_SMA']) {
    const { evidence } = resolveEvidence(id);
    const { live, failedGates } = liveGoNoGo(evidence);
    lines.push(`## ${id}`);
    lines.push(`Lifecycle: ${deriveLifecycleStatus(evidence)}`);
    lines.push(`LIVE: ${live}`);
    lines.push(`Failed gates: ${failedGates.join(', ') || '(none)'}`);
    lines.push('');
  }
  lines.push('LIVE: NO-GO');
  lines.push('');
  lines.push('Installing VectorBT does not create an edge.');
  return lines.join('\n');
}
