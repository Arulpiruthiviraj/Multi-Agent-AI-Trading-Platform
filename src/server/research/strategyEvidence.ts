import { researchSafety } from '../config/researchSafety';
import { deriveLifecycleStatus, emptyEvidence, liveGoNoGo } from './promotionEngine';
import { compareExecutionModels, executionModelVersion } from './executionModel';

export function coreStrategyInventory() {
  return researchSafety.coreStrategyIds.map((strategyId) => ({
    strategyId,
    strategyVersion: 'CORE_REPO',
    family: 'CORE',
    adapter: strategyId === 'SMC_LIQUIDITY_SWEEP' ? 'PROXY_NOT_FEATURE_PARITY' : 'FEATURE_SUBSET_PARITY',
    status: deriveLifecycleStatus(emptyEvidence(strategyId)),
    smcUnvalidated: false,
    note: researchSafety.proxyAdapterNote,
    inventedResults: false,
  }));
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
    const e = emptyEvidence(strategyId);
    return {
      strategy: strategyId,
      featureParity: strategyId === 'SMC_LIQUIDITY_SWEEP' ? 'PROXY_NOT_FEATURE_PARITY' : 'FEATURE_SUBSET_PARITY',
      data: 'UNAVAILABLE',
      backtest: 'UNTESTED',
      oos: 'UNTESTED',
      wfo: 'UNTESTED',
      permutation: 'UNTESTED',
      mc: 'UNTESTED',
      sensitivity: 'UNTESTED',
      costs: 'UNTESTED',
      paper: 'UNTESTED',
      final: strategyId === 'SMC_LIQUIDITY_SWEEP' ? 'UNVALIDATED' : deriveLifecycleStatus(e),
      invented: false,
    };
  });
  const mismatch = compareExecutionModels('NEXT_BAR_OPEN', 'SAME_BAR_CLOSE');
  return {
    inSample: 'UNTESTED',
    outOfSample: 'UNTESTED',
    paper: 'UNTESTED',
    executionModelVersion: executionModelVersion(),
    canonicalResearchFill: 'NEXT_BAR_OPEN',
    backtestEngineFill: 'SAME_BAR_CLOSE',
    engineCompare: mismatch,
    rows,
  };
}

export function liveCandidateReportMarkdown(): string {
  const lines = ['# LIVE_CANDIDATE_REPORT', '', 'No strategy has satisfied promotion evidence.', ''];
  for (const id of [...researchSafety.coreStrategyIds, ...researchSafety.experimentalStrategyIds, 'GOLDEN_SMA']) {
    const e = emptyEvidence(id);
    const { live, failedGates } = liveGoNoGo(e);
    lines.push(`## ${id}`);
    lines.push(`LIVE: ${live}`);
    lines.push(`Failed gates: ${failedGates.join(', ') || '(none)'}`);
    lines.push('');
  }
  lines.push('LIVE: NO-GO');
  lines.push('');
  lines.push('Installing VectorBT does not create an edge.');
  return lines.join('\n');
}
