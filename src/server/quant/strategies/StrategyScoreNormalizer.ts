/**
 * Phase B (2026-09-02 forensic-audit follow-up,
 * docs/audits/ARGUS_UNIVERSAL_DISCOVERY_PAPER_TRADING_FORENSIC_AUDIT_2026-09-01.md §13/§27 and
 * docs/audits/ARGUS_PHASE18_SCORE_NORMALIZATION_RESEARCH_NOTE.md). Real, same-day evidence: raw
 * setupScore is not cross-strategy comparable (MEAN_REVERSION mean 18.2 vs FIBONACCI_PULLBACK mean
 * 76.7, a >4x gap on the SAME 0-100 scale), so comparing raw setupScore across strategies with
 * structurally different scoring formulas systematically favors whichever strategy's formula
 * happens to produce larger numbers - not whichever setup is actually stronger.
 *
 * This module computes a real, point-in-time-safe z-score for each strategy against its OWN
 * historical setupScore distribution (from already-persisted quant_assessments rows - no new
 * table), so ranking compares "how unusually strong is this setup FOR THIS STRATEGY" instead of
 * raw magnitude. A strategy with too little historical sample keeps its raw setupScore (a
 * documented, safe cold-start fallback) rather than an unreliable thin-sample z-score.
 *
 * Off entirely (quantThresholds.strategyScoreNormalizationEnabled === false, the reviewed default)
 * leaves StrategyEngine.evaluateAll()'s sort exactly as it always has been. Never changes
 * MIN_STRATEGY_CONFIDENCE_TO_TRADE eligibility, never touches ChiefTrader/RiskEngine/OMS/consensus.
 */
import { db } from '../../db';
import { quantAssessments } from '../../db/schema';
import { gte } from 'drizzle-orm';
import { quantThresholds } from '../../config/quantThresholds';
import type { StrategyEvaluation } from './types';

export interface StrategyHistoricalStats {
  strategyId: string;
  mean: number;
  stddev: number;
  count: number;
}

let statsCache: { fetchedAt: number; stats: Map<string, StrategyHistoricalStats> } | null = null;
let inFlight = false;

/**
 * Real aggregation over already-persisted quant_assessments.strategyEvaluations JSON, bounded to a
 * recent lookback window (reuses the same "don't scan the whole table forever" discipline as the
 * discovery scanners) so this stays cheap to refresh periodically rather than on every evaluation.
 *
 * Called fire-and-forget (`void refreshStrategyHistoricalStats()`) from StrategyEngine.evaluateAll()
 * - it must never throw / reject, or it becomes an unhandled-rejection risk on a hot live path. Any
 * failure here fails closed to the existing cache (or an empty map on first run), which itself falls
 * back to raw setupScore per strategy - never a crash, never fabricated stats.
 */
export async function refreshStrategyHistoricalStats(lookbackDays = 30): Promise<Map<string, StrategyHistoricalStats>> {
  if (inFlight) return statsCache?.stats ?? new Map();
  inFlight = true;
  try {
    const sinceIso = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db.select().from(quantAssessments).where(gte(quantAssessments.createdAt, sinceIso));
    const acc = new Map<string, { sum: number; sumSq: number; count: number }>();
    for (const r of rows as any[]) {
      if (!r.strategyEvaluations) continue;
      let evals: any[] = [];
      try { evals = JSON.parse(r.strategyEvaluations); } catch { continue; }
      for (const e of evals) {
        const strategyId = e.strategy ?? e.strategyId;
        const score = e.setupScore;
        if (typeof strategyId !== 'string' || typeof score !== 'number' || !Number.isFinite(score)) continue;
        const bucket = acc.get(strategyId) ?? { sum: 0, sumSq: 0, count: 0 };
        bucket.sum += score;
        bucket.sumSq += score * score;
        bucket.count += 1;
        acc.set(strategyId, bucket);
      }
    }
    const stats = new Map<string, StrategyHistoricalStats>();
    for (const [strategyId, { sum, sumSq, count }] of acc.entries()) {
      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      stats.set(strategyId, { strategyId, mean, stddev: Math.sqrt(variance), count });
    }
    statsCache = { fetchedAt: Date.now(), stats };
    return stats;
  } catch (e) {
    console.error('[StrategyScoreNormalizer] refresh failed - falling back to the existing cache (or thin-sample raw setupScore if none yet)', e);
    return statsCache?.stats ?? new Map();
  } finally {
    inFlight = false;
  }
}

/** Synchronous read of whatever the last refresh produced. Empty until a refresh has run. */
export function getCachedStrategyHistoricalStats(): Map<string, StrategyHistoricalStats> {
  return statsCache?.stats ?? new Map();
}

export function isStrategyHistoricalStatsCacheStale(): boolean {
  if (!statsCache) return true;
  return Date.now() - statsCache.fetchedAt > quantThresholds.strategyScoreNormalizationCacheTtlMs;
}

/**
 * Pure function - no I/O. Returns a NEW array, re-sorted by normalized comparability instead of
 * raw setupScore, when a strategy has enough historical sample (>= minSample); a thin-sample
 * strategy keeps its position based on raw setupScore among other thin-sample strategies (a
 * documented fallback, not a silent bias). Never mutates the input, never changes which
 * evaluations are eligible - only their relative order for bestStrategyIdea()'s eligible[0] pick.
 */
export function computeNormalizedRank(
  evaluations: StrategyEvaluation[],
  stats: Map<string, StrategyHistoricalStats>,
  minSample: number,
): StrategyEvaluation[] {
  // A thin-sample strategy's raw setupScore is already on the same nominal 0-100 scale, so it is
  // used as-is (documented cold-start fallback) rather than structurally favored or disfavored
  // against a normalized peer. For a strategy with enough sample, the z-score is mapped onto that
  // same rough 0-100 range via a linear approximation (NOT a true normal-CDF percentile - just
  // monotonic in z, which is all sorting needs) so normalized and thin-sample evaluations are
  // compared on a genuinely common scale instead of one class always winning by construction.
  const comparableScore = (e: StrategyEvaluation): number => {
    const s = stats.get(e.strategy);
    if (!s || s.count < minSample) return e.setupScore;
    if (s.stddev === 0) return 50; // no real historical spread to compare against - neutral, not a fabricated extreme
    const z = (e.setupScore - s.mean) / s.stddev;
    return Math.max(0, Math.min(100, 50 + z * 15));
  };
  return [...evaluations].sort((a, b) => comparableScore(b) - comparableScore(a));
}
