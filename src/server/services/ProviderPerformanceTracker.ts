/**
 * ProviderPerformanceTracker - Phase A1/A2 of the AI Cost Governor design note
 * (docs/audits/ARGUS_PROJECT_A_AI_COST_GOVERNOR_DESIGN_NOTE.md §C). A real, read-only join of this
 * agent's agentPredictions rows (already carrying a `provider` column, populated by
 * ReflectionEngine.logPrediction()) against their graded predictionOutcomes, grouped by provider
 * instead of the regime `ModelPerformanceTracker.getRegimeSegmentedStats()` groups by - same table,
 * same join key, same "never build a second parallel prediction ledger" philosophy that file's own
 * header already establishes. Predictions not yet evaluated are excluded, never counted as a loss.
 * Rows with no captured provider (e.g. deterministic TechnicalAgent, which never calls AIRouter) are
 * grouped under 'UNKNOWN' rather than dropped, so totals stay honestly reconcilable.
 *
 * Read-only. Never gates a trade, never writes anything, never called from the live decision path -
 * an observability/cost-analysis lens only, exactly like calibrationMaturity.ts is for confidence
 * calibration.
 */
import { db } from '../db';
import { agentPredictions, predictionOutcomes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { wilsonInterval } from '../research/effectiveSampleSize';

export interface ProviderBucketStats {
  provider: string;
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturn: number;
  /** Raw (not autocorrelation-cluster-corrected) Wilson lower bound - a real, conservative interval
   *  on this provider's real win rate, same statistical method calibrationMaturity.ts already uses
   *  on the cluster-corrected effective N. Null until at least one graded outcome exists. */
  wilsonLower: number | null;
}

/**
 * Real, read-only join of this agent's agentPredictions rows against their graded
 * predictionOutcomes, grouped by the `provider` captured at prediction time.
 */
export async function getProviderSegmentedStats(agentName: string): Promise<ProviderBucketStats[]> {
  const predictions = await db.select().from(agentPredictions).where(eq(agentPredictions.agentName, agentName));
  if (predictions.length === 0) return [];

  const predictionIds = new Set(predictions.map((p) => p.id));
  const providerById = new Map(predictions.map((p) => [p.id, p.provider ?? 'UNKNOWN']));

  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));

  const buckets = new Map<string, { total: number; wins: number; losses: number; returnSum: number }>();
  for (const o of outcomes) {
    if (!predictionIds.has(o.predictionId)) continue;
    if (o.outcome === 'N_A') continue;
    const provider = providerById.get(o.predictionId) ?? 'UNKNOWN';
    const bucket = buckets.get(provider) ?? { total: 0, wins: 0, losses: 0, returnSum: 0 };
    bucket.total += 1;
    if (o.outcome === 'WIN') bucket.wins += 1;
    else bucket.losses += 1;
    bucket.returnSum += o.actualReturn ?? 0;
    buckets.set(provider, bucket);
  }

  return [...buckets.entries()].map(([provider, b]) => ({
    provider,
    total: b.total,
    wins: b.wins,
    losses: b.losses,
    winRate: b.total > 0 ? b.wins / b.total : 0,
    avgReturn: b.total > 0 ? b.returnSum / b.total : 0,
    wilsonLower: b.total > 0 ? wilsonInterval(b.wins, b.total).lower : null,
  }));
}
