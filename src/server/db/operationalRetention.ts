/**
 * Real defect found and fixed (2026-09-22, CLI runtime forensics pass, DATABASE VERIFIED): unlike
 * observability_events (which has a real sweepObservabilityRetention() on retentionDays=14),
 * candidate_rankings had NO retention policy anywhere in the codebase. Live query against the
 * production DB found 1.38M+ rows spanning 26 days and growing unbounded - a rolling ranking-cycle
 * snapshot table (ComposableRanking.ts writes one row per symbol per cycle; every consumer only
 * ever reads the latest cycle or a bounded recent-history window, never "all of history") with no
 * long-term audit-trail requirement, structurally distinct from trades/fills/risk_assessments/
 * event_traces (the permanent decision record, deliberately never pruned). Mirrors
 * ObservabilityStore.ts's sweep pattern exactly rather than inventing a new one.
 */
import { sqliteDb } from './index';
import { runtimeIntervals } from '../config/runtimeIntervals';

let retentionTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 2026-10-01 defect verification pass: previously one single unbatched DELETE, same class of
 * defect as ObservabilityStore.ts's sweep (see that file's own comment for the first live
 * reproduction) - live-reproduced a SECOND time against this table specifically, which this
 * file's own header comment already documents had grown to 1.38M+ rows with zero retention before
 * 2026-09-22. Same batching + yielding fix: bounded id-subquery deletes, yielding between batches
 * so no single sweep call can block the event loop regardless of backlog size.
 */
export async function sweepCandidateRankingsRetention(nowMs = Date.now()): Promise<number> {
  const cutoffIso = new Date(nowMs - runtimeIntervals.candidateRankingsRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = runtimeIntervals.candidateRankingsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.candidateRankingsRetentionSweepMaxBatchesPerCall;
  const deleteBatch = sqliteDb.prepare(
    'DELETE FROM candidate_rankings WHERE id IN (SELECT id FROM candidate_rankings WHERE cycle_at < ? LIMIT ?)'
  );
  let totalDeleted = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const result = deleteBatch.run(cutoffIso, batchSize);
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  } catch {
    return totalDeleted;
  }
}

export function startOperationalRetentionSweep(): void {
  if (retentionTimer) return;
  retentionTimer = setInterval(() => { void sweepCandidateRankingsRetention(); }, runtimeIntervals.candidateRankingsRetentionSweepMs);
  if (typeof retentionTimer === 'object' && retentionTimer && 'unref' in retentionTimer) {
    retentionTimer.unref();
  }
  void sweepCandidateRankingsRetention();
}

export function stopOperationalRetentionSweep(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}
