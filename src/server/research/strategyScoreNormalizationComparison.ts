/**
 * Raw-vs-normalized strategy selection comparison (2026-09-14, item #7 / mandate Phase 10).
 *
 * Real gap this closes: quantThresholds.strategyScoreNormalizationEnabled exists and is tested
 * (StrategyScoreNormalizer.ts), reviewed OFF because "the mechanism is implemented and tested,
 * not yet observed live" (that file's own comment). Mandate Phase 10 asks for a real historical
 * comparison before ever considering flipping it on - this is that comparison, bounded and
 * read-only, never itself flips the flag or changes selection behavior.
 *
 * Method (HONEST about its own limits, not a walk-forward/OOS test):
 *   1. Pull a bounded, recent window of real quant_assessments.strategyEvaluations rows (the same
 *      raw-sorted array evaluateAll() already persisted every cycle).
 *   2. For each cycle, compute BOTH the raw winner (evaluations[0], since evaluateAll()'s own sort
 *      is raw-setupScore-descending) and the normalized winner (computeNormalizedRank() - the
 *      EXACT same pure function StrategyEngine.ts would use if the flag were on).
 *   3. Where the two winners differ, compare each candidate's own REAL aggregate historical
 *      evidence (effective-N/Wilson-lower-bound, via agentEdgeAnalytics.ts - the same computation
 *      `argus-cli agent-edge` already exposes) rather than inventing a new statistic.
 *
 * LIMITATION, stated plainly: both the historical setupScore distribution (StrategyScoreNormalizer.ts)
 * and each strategy's real win-rate evidence are computed over the SAME overall window this
 * comparison itself uses - this is NOT point-in-time-correct per cycle (a true walk-forward test
 * would recompute both using only data available before each cycle). Treat this as a first-pass
 * discovery signal only, per the mandate's own explicit instruction not to enable normalized
 * scoring merely because it changes trade count - promotion requires the fuller walk-forward
 * design this module does not attempt.
 */
import { db } from '../db';
import { quantAssessments } from '../db/schema';
import { desc } from 'drizzle-orm';
import { quantThresholds } from '../config/quantThresholds';
import { refreshStrategyHistoricalStats, getCachedStrategyHistoricalStats, computeNormalizedRank } from '../quant/strategies/StrategyScoreNormalizer';
import { buildAgentEdgeReport, type AgentEdgeRow } from './agentEdgeAnalytics';
import type { StrategyEvaluation } from '../quant/strategies/types';

const MAX_ROWS_SCANNED = 5000; // bounded by construction, independent of table growth

export interface StrategyScoreNormalizationComparison {
  cyclesScanned: number;
  cyclesWithEvaluations: number;
  winnerChangedCount: number;
  winnerChangedPct: number;
  /** Per divergent cycle, both candidates' real aggregate evidence (null when no real evidence
   *  exists yet for that exact strategy id - never fabricated). */
  divergentSamples: Array<{
    createdAt: string;
    symbol: string;
    rawWinner: string;
    normalizedWinner: string;
    rawWinnerRealEvidence: { effectiveN: number; winRate: number | null; wilsonLower: number | null } | null;
    normalizedWinnerRealEvidence: { effectiveN: number; winRate: number | null; wilsonLower: number | null } | null;
  }>;
  /** Across all divergent cycles with real evidence on both sides: how often normalized would
   *  have picked the strategy with the objectively HIGHER real Wilson lower bound. Null when too
   *  few divergent+evidenced cycles exist to say anything (never a fabricated percentage). */
  normalizedPickedHigherWilsonLowerCount: number;
  normalizedPickedHigherWilsonLowerComparableCount: number;
  limitation: string;
}

function findRealEvidence(rows: AgentEdgeRow[], strategyId: string): { effectiveN: number; winRate: number | null; wilsonLower: number | null } | null {
  const row = rows.find((r) => r.agentName === 'QuantEngine' && r.strategyId === `${strategyId}__COLD_START_BOOTSTRAP`)
    ?? rows.find((r) => r.agentName === 'QuantEngine' && r.strategyId === strategyId);
  return row ? { effectiveN: row.effectiveN, winRate: row.winRate, wilsonLower: row.wilsonLower } : null;
}

export async function buildStrategyScoreNormalizationComparison(): Promise<StrategyScoreNormalizationComparison> {
  const [rows, , realEvidenceRows] = await Promise.all([
    db.select().from(quantAssessments).orderBy(desc(quantAssessments.createdAt)).limit(MAX_ROWS_SCANNED),
    refreshStrategyHistoricalStats(), // populates the cache used below - real historical setupScore distribution
    buildAgentEdgeReport(),
  ]);
  const stats = getCachedStrategyHistoricalStats();
  const minSample = quantThresholds.strategyScoreNormalizationMinSample;

  let cyclesWithEvaluations = 0;
  let winnerChangedCount = 0;
  const divergentSamples: StrategyScoreNormalizationComparison['divergentSamples'] = [];
  let normalizedPickedHigherWilsonLowerCount = 0;
  let normalizedPickedHigherWilsonLowerComparableCount = 0;

  for (const r of rows as any[]) {
    if (!r.strategyEvaluations) continue;
    let evals: StrategyEvaluation[] = [];
    try { evals = JSON.parse(r.strategyEvaluations); } catch { continue; }
    if (!Array.isArray(evals) || evals.length === 0) continue;
    cyclesWithEvaluations++;

    const rawWinner = evals[0]?.strategy; // evaluateAll()'s own persisted order is raw-descending
    const normalizedWinner = computeNormalizedRank(evals, stats, minSample)[0]?.strategy;
    if (!rawWinner || !normalizedWinner || rawWinner === normalizedWinner) continue;

    winnerChangedCount++;
    const rawEvidence = findRealEvidence(realEvidenceRows, rawWinner);
    const normEvidence = findRealEvidence(realEvidenceRows, normalizedWinner);

    if (rawEvidence?.wilsonLower != null && normEvidence?.wilsonLower != null) {
      normalizedPickedHigherWilsonLowerComparableCount++;
      if (normEvidence.wilsonLower > rawEvidence.wilsonLower) normalizedPickedHigherWilsonLowerCount++;
    }

    if (divergentSamples.length < 50) { // bounded sample of examples, not every divergence
      divergentSamples.push({
        createdAt: r.createdAt, symbol: r.symbol, rawWinner, normalizedWinner,
        rawWinnerRealEvidence: rawEvidence, normalizedWinnerRealEvidence: normEvidence,
      });
    }
  }

  return {
    cyclesScanned: rows.length,
    cyclesWithEvaluations,
    winnerChangedCount,
    winnerChangedPct: cyclesWithEvaluations > 0 ? winnerChangedCount / cyclesWithEvaluations : 0,
    divergentSamples,
    normalizedPickedHigherWilsonLowerCount,
    normalizedPickedHigherWilsonLowerComparableCount,
    limitation: 'Not a walk-forward/OOS test - both the historical setupScore distribution and each '
      + 'strategy\'s real win-rate evidence are computed over the SAME overall window this comparison '
      + 'itself uses, not recomputed point-in-time per cycle. First-pass discovery signal only; do not '
      + 'enable strategyScoreNormalizationEnabled based on this report alone.',
  };
}

export function formatStrategyScoreNormalizationComparison(r: StrategyScoreNormalizationComparison): string {
  const lines = [
    'STRATEGY SCORE NORMALIZATION - RAW vs NORMALIZED SELECTION COMPARISON',
    '========================================================================',
    r.limitation,
    '',
    `Cycles scanned: ${r.cyclesScanned} (bounded to most recent ${MAX_ROWS_SCANNED})`,
    `Cycles with real evaluations: ${r.cyclesWithEvaluations}`,
    `Winner changed (raw vs normalized): ${r.winnerChangedCount} (${(r.winnerChangedPct * 100).toFixed(1)}%)`,
    '',
  ];
  if (r.normalizedPickedHigherWilsonLowerComparableCount > 0) {
    lines.push(
      `Of divergent cycles with real evidence on both sides (n=${r.normalizedPickedHigherWilsonLowerComparableCount}): `
      + `normalized selection picked the strategy with the objectively higher real Wilson lower bound `
      + `${r.normalizedPickedHigherWilsonLowerCount}/${r.normalizedPickedHigherWilsonLowerComparableCount} times `
      + `(${(r.normalizedPickedHigherWilsonLowerCount / r.normalizedPickedHigherWilsonLowerComparableCount * 100).toFixed(1)}%).`,
    );
  } else {
    lines.push('No divergent cycles yet have real evidence on both sides to compare - insufficient data for this specific question.');
  }
  lines.push('', `Sample divergences (up to 50 shown, ${r.divergentSamples.length} captured):`);
  for (const s of r.divergentSamples) {
    lines.push(
      `  ${s.createdAt} ${s.symbol}: raw=${s.rawWinner}`
      + `(wilsonLo=${s.rawWinnerRealEvidence?.wilsonLower != null ? s.rawWinnerRealEvidence.wilsonLower.toFixed(3) : 'n/a'})`
      + ` -> normalized=${s.normalizedWinner}`
      + `(wilsonLo=${s.normalizedWinnerRealEvidence?.wilsonLower != null ? s.normalizedWinnerRealEvidence.wilsonLower.toFixed(3) : 'n/a'})`,
    );
  }
  return lines.join('\n');
}
