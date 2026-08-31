/**
 * Phase 10 (Agent Edge Discovery, 2026-08-31) - Phase 3 item 12: "are current agent weights
 * consistent with observed predictive performance?" Reuses agentWeightPolicy.ts's EXISTING
 * agentWeightUpdate() formula (the same one ReflectionEngine's live weight-learning loop already
 * uses) and agent_performance_stats' already-computed effective-N/win-rate columns - this is a
 * comparison/observability lens, not a new weight-computation engine, and it never writes to
 * agent_performance_stats or config/agentWeights.json.
 *
 * Real bug found and fixed (Phase 11, 2026-08-31): this used agent_performance_stats.winRate -
 * which ReflectionEngine.ts persists as the RAW (uncorrected, autocorrelation-inflated) win rate
 * (`data.correct / data.total`) - to recompute the "expected" weight, while ReflectionEngine's own
 * ACTUAL weight-update call (the one that really sets currentWeight) uses effectiveWinRate
 * (effectiveCorrect / effectivePredictions, the correctly clustered figure) instead. For
 * QuantEngine this meant comparing its real weight (0.706, correctly derived from an effective win
 * rate of 18/51=0.353) against an "expected" weight computed from the wrong number (raw winRate
 * 0.480, giving 0.961) - a false "inconsistent" flag on a weight that was actually exactly right.
 * Recomputing with the same effective win rate ReflectionEngine itself uses reproduces 0.706
 * almost exactly. Never trust the raw winRate column for this comparison again.
 */
import { db } from '../db';
import { agentPerformanceStats } from '../db/schema';
import { agentWeightUpdate } from './agentWeightPolicy';

export interface WeightConsistencyRow {
  agentName: string;
  actualCurrentWeight: number;
  expectedWeightFromPerformance: number;
  effectivePredictions: number;
  /** The effective (clustered) win rate - effectiveCorrect/effectivePredictions - NOT the raw
   *  agent_performance_stats.winRate column, which ReflectionEngine's own weight formula never
   *  actually consults. */
  effectiveWinRate: number;
  evidenceStatus: string;
  consistent: boolean;
  detail: string;
}

/** `tolerance` bounds how much drift between actual and expected weight is treated as "consistent"
 *  - agentWeightPolicy.boundedStep() only ever moves currentWeight partway toward a target per
 *  cycle, so some lag between "expected from current performance" and "actual, still catching up"
 *  is normal, not a defect; only a persistent, large gap is worth flagging. */
export async function buildWeightConsistencyReport(tolerance = 0.15): Promise<WeightConsistencyRow[]> {
  const rows = await db.select().from(agentPerformanceStats);
  return rows.map((r) => {
    const effectiveWinRate = r.effectivePredictions > 0 ? r.effectiveCorrect / r.effectivePredictions : 0;
    const expected = agentWeightUpdate({ totalEvaluated: r.effectivePredictions, winRate: effectiveWinRate });
    const gap = Math.abs(r.currentWeight - expected.currentWeight);
    const consistent = !expected.statisticallyMeaningful || gap <= tolerance;
    return {
      agentName: r.agentName,
      actualCurrentWeight: r.currentWeight,
      expectedWeightFromPerformance: expected.currentWeight,
      effectivePredictions: r.effectivePredictions,
      effectiveWinRate,
      evidenceStatus: r.evidenceStatus,
      consistent,
      detail: !expected.statisticallyMeaningful
        ? `${r.agentName} has too few effective predictions (${r.effectivePredictions}) for its weight to be judged against performance - currentWeight stays at its default/learned value until enough evidence accrues.`
        : consistent
          ? `Actual weight (${r.currentWeight.toFixed(3)}) is within tolerance of what real performance (effective win rate ${effectiveWinRate.toFixed(3)}, N=${r.effectivePredictions}) would set (${expected.currentWeight.toFixed(3)}).`
          : `Actual weight (${r.currentWeight.toFixed(3)}) diverges from what real performance would set (${expected.currentWeight.toFixed(3)}) by more than the ${tolerance} tolerance - likely still catching up via boundedStep()'s gradual adjustment, not necessarily a bug.`,
    };
  });
}

export function formatWeightConsistencyReport(rows: WeightConsistencyRow[]): string {
  const lines = ['AGENT WEIGHT CONSISTENCY', '-------------------------', 'Agent'.padEnd(24) + 'ActualWt'.padEnd(10) + 'ExpectedWt'.padEnd(12) + 'EffN'.padEnd(8) + 'EffWinRate'.padEnd(12) + 'Consistent'];
  for (const r of rows) {
    lines.push(
      r.agentName.padEnd(24)
      + r.actualCurrentWeight.toFixed(3).padEnd(10)
      + r.expectedWeightFromPerformance.toFixed(3).padEnd(12)
      + String(r.effectivePredictions).padEnd(8)
      + r.effectiveWinRate.toFixed(3).padEnd(12)
      + (r.consistent ? 'YES' : 'NO'),
    );
  }
  return lines.join('\n');
}
