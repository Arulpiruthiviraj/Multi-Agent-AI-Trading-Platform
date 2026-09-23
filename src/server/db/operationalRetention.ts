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
import { db } from './index';
import { candidateRankings } from './schema';
import { lt } from 'drizzle-orm';
import { runtimeIntervals } from '../config/runtimeIntervals';

let retentionTimer: ReturnType<typeof setInterval> | null = null;

export async function sweepCandidateRankingsRetention(nowMs = Date.now()): Promise<number> {
  const cutoffIso = new Date(nowMs - runtimeIntervals.candidateRankingsRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  try {
    const result = await db.delete(candidateRankings).where(lt(candidateRankings.cycleAt, cutoffIso));
    return Number((result as { changes?: number })?.changes ?? 0);
  } catch {
    return 0;
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
