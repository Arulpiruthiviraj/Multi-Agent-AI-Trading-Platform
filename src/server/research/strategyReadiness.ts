/**
 * Phase 10 continuation (2026-08-31) - the strategy activation matrix + real edge status this
 * mission's Phase 2/5/15 ask for, built entirely by composing already-computed data:
 *   - CORE_STRATEGIES (StrategyEngine.ts) for the real, static list of implemented/enabled
 *     strategy ids - no new registry invented.
 *   - agentEdgeAnalytics.ts's already-computed per-(agent, strategyId) rows for real N/effN/
 *     winRate/status, now correctly attributable per real strategy (see
 *     predictionIndependencePolicy.ts's secondaryGroupKey fix, same pass) instead of every
 *     bootstrap-sourced observation collapsing into one undifferentiated bucket.
 *
 * A strategy can appear as up to two distinct rows here - its own id (EV-backed ideas, from
 * StrategyEngine's real evaluate()) and "<id>__COLD_START_BOOTSTRAP" (regime-only ideas emitted
 * while that strategy had zero/insufficient real closed trades) - these are never merged, per this
 * mission's explicit "never mix populations silently" rule: an EV-backed observation and a
 * bootstrap-sourced one are genuinely different evidence, even for the same underlying strategy.
 */
import { CORE_STRATEGIES } from '../quant/strategies/StrategyEngine';
import { buildAgentEdgeReport, type AgentEdgeRow } from './agentEdgeAnalytics';

export interface StrategyReadinessRow {
  strategyId: string;
  implemented: boolean;
  enabled: boolean;
  reachable: boolean;
  /** Real evaluations exist (StrategyEngine.evaluateAll runs this strategy every Quant cycle for
   *  every actively-tracked symbol) - distinct from whether it ever WON the ranking and got emitted. */
  evaluatedEveryQuantCycle: boolean;
  variant: 'EV_BACKED' | 'COLD_START_BOOTSTRAP' | 'NEVER_EMITTED';
  rawN: number;
  effectiveN: number;
  winRate: number | null;
  wilsonLower: number | null;
  status: AgentEdgeRow['statisticalStatus'] | 'NEVER_EMITTED';
}

export async function buildStrategyReadinessReport(): Promise<StrategyReadinessRow[]> {
  const edgeRows = await buildAgentEdgeReport();
  const quantStrategyRows = edgeRows.filter((r) => r.agentName === 'QuantEngine' && r.strategyId !== null);

  const rows: StrategyReadinessRow[] = [];
  for (const def of CORE_STRATEGIES) {
    const evBacked = quantStrategyRows.find((r) => r.strategyId === def.id);
    const bootstrap = quantStrategyRows.find((r) => r.strategyId === `${def.id}__COLD_START_BOOTSTRAP`);

    if (!evBacked && !bootstrap) {
      rows.push({
        strategyId: def.id, implemented: true, enabled: true, reachable: true,
        evaluatedEveryQuantCycle: true, variant: 'NEVER_EMITTED',
        rawN: 0, effectiveN: 0, winRate: null, wilsonLower: null, status: 'NEVER_EMITTED',
      });
      continue;
    }
    if (evBacked) {
      rows.push({
        strategyId: def.id, implemented: true, enabled: true, reachable: true,
        evaluatedEveryQuantCycle: true, variant: 'EV_BACKED',
        rawN: evBacked.rawN, effectiveN: evBacked.effectiveN, winRate: evBacked.winRate,
        wilsonLower: evBacked.wilsonLower, status: evBacked.statisticalStatus,
      });
    }
    if (bootstrap) {
      rows.push({
        strategyId: def.id, implemented: true, enabled: true, reachable: true,
        evaluatedEveryQuantCycle: true, variant: 'COLD_START_BOOTSTRAP',
        rawN: bootstrap.rawN, effectiveN: bootstrap.effectiveN, winRate: bootstrap.winRate,
        wilsonLower: bootstrap.wilsonLower, status: bootstrap.statisticalStatus,
      });
    }
  }
  return rows;
}

export function formatStrategyReadinessReport(rows: StrategyReadinessRow[]): string {
  const lines = [
    'STRATEGY READINESS', '-------------------',
    'Strategy'.padEnd(24) + 'Variant'.padEnd(22) + 'Impl'.padEnd(6) + 'Enab'.padEnd(6) + 'Reach'.padEnd(7) + 'N'.padEnd(7) + 'EffN'.padEnd(7) + 'WinRate'.padEnd(10) + 'WilsonLo'.padEnd(10) + 'Status',
  ];
  for (const r of rows) {
    lines.push(
      r.strategyId.padEnd(24)
      + r.variant.padEnd(22)
      + (r.implemented ? 'YES' : 'NO').padEnd(6)
      + (r.enabled ? 'YES' : 'NO').padEnd(6)
      + (r.reachable ? 'YES' : 'NO').padEnd(7)
      + String(r.rawN).padEnd(7)
      + String(r.effectiveN).padEnd(7)
      + (r.winRate !== null ? r.winRate.toFixed(3) : 'N/A').padEnd(10)
      + (r.wilsonLower !== null ? r.wilsonLower.toFixed(3) : 'N/A').padEnd(10)
      + r.status,
    );
  }
  return lines.join('\n');
}
