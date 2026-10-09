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
  } catch (e) {
    // 2026-10-08 defect hunt (P2-R4): sweep failures were invisible (bare catch) - log loudly.
    console.error('[operationalRetention] sweepNewsClustersRetention failed:', e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}

export function startOperationalRetentionSweep(): void {
  if (retentionTimer) return;
  retentionTimer = setInterval(() => {
    for (const { sweep } of RETENTION_SWEEPERS) void sweep();
  }, runtimeIntervals.candidateRankingsRetentionSweepMs);
  if (typeof retentionTimer === 'object' && retentionTimer && 'unref' in retentionTimer) {
    retentionTimer.unref();
  }
  for (const { sweep } of RETENTION_SWEEPERS) void sweep();
}

/**
 * 2026-10-07 Discovery-D2: retention sweep for the trade_plan_revalidations ledger (see
 * ../continuous/tradePlanRevalidationRetention.pruneTradePlanRevalidations). Lazy dynamic
 * import: the continuous module graph is heavy and must never be pulled into this module's
 * static import set (import-cycle risk with SystemBootstrap's own startup path). Imports the
 * leaf module directly (not TradePlanBuilder) - the leaf cannot participate in the cycle
 * that caused a TDZ "Cannot access before initialization" on the retention-days const
 * (2026-10-09 defect hunt).
 */
export async function sweepTradePlanRevalidationRetention(nowMs = Date.now()): Promise<number> {
  try {
    const { pruneTradePlanRevalidations } = await import('../continuous/tradePlanRevalidationRetention');
    return pruneTradePlanRevalidations(nowMs);
  } catch {
    return 0;
  }
}

/**
 * 2026-10-07 Discovery-D3: retention sweep for the premarket_data_reservations ledger (see
 * PremarketDataReservation.pruneReservationLedger). Lazy dynamic import, same reason as above.
 */
export async function sweepReservationLedgerRetention(nowMs = Date.now()): Promise<number> {
  try {
    const { pruneReservationLedger } = await import('../premarket/PremarketDataReservation');
    return pruneReservationLedger(nowMs);
  } catch {
    return 0;
  }
}

export function stopOperationalRetentionSweep(): void {
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}

/**
 * 2026-10-08 memory-leak follow-up: news_articles grew on disk with no prune path anywhere in
 * the codebase - the same defect class as candidate_rankings (2026-09-22, 1.38M+ rows, zero
 * retention). Article rows are bulky (content/summary text) and their trading value decays
 * within hours (RiskEngine's news veto reads only the last 4h of clusters; catalysts expire
 * intraday), so anything older than newsArticlesRetentionDays is dead weight. Batched +
 * yielding like sweepCandidateRankingsRetention: a large backlog must never block the event
 * loop. Cutoff compares ISO-8601 text, which orders chronologically.
 */
export async function sweepNewsArticlesRetention(nowMs = Date.now()): Promise<number> {
  const cutoffIso = new Date(nowMs - runtimeIntervals.newsArticlesRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = runtimeIntervals.newsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.newsRetentionSweepMaxBatchesPerCall;
  let totalDeleted = 0;
  try {
    // 2026-10-08 defect hunt (P2-R2): rows written before NewsNormalizer.normalizePublishedAt
    // (or by any path bypassing it) may carry non-ISO published_at (RFC-2822 pubDate,
    // "YYYY-MM-DD HH:MM:SS"). ISO-text comparison can never prune those rows, so repair them
    // to ISO first in JS (SQLite cannot parse these formats). The set shrinks to zero and
    // stays there; unparseable dates fail closed to now (never pruned as "old").
    // Bounded + yielding like the delete loop below.
    const repairSelect = sqliteDb.prepare(
      `SELECT id, published_at AS publishedAt FROM news_articles WHERE published_at NOT LIKE '____-__-__T%' LIMIT ?`
    );
    const repairUpdate = sqliteDb.prepare('UPDATE news_articles SET published_at=? WHERE id=?');
    for (let i = 0; i < maxBatches; i++) {
      const rows = repairSelect.all(batchSize) as Array<{ id: string; publishedAt: string | null }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const ms = row.publishedAt ? Date.parse(row.publishedAt) : NaN;
        repairUpdate.run(Number.isFinite(ms) ? new Date(ms).toISOString() : new Date(nowMs).toISOString(), row.id);
      }
      if (rows.length < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const deleteBatch = sqliteDb.prepare(
      'DELETE FROM news_articles WHERE id IN (SELECT id FROM news_articles WHERE published_at < ? LIMIT ?)'
    );
    for (let i = 0; i < maxBatches; i++) {
      const result = deleteBatch.run(cutoffIso, batchSize);
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  } catch (e) {
    // 2026-10-08 defect hunt (P2-R4): sweep failures were invisible (bare catch). A
    // persistently failing sweep is exactly the unbounded-growth class this workstream
    // hunts - log loudly so it cannot fail silently.
    console.error('[operationalRetention] sweepNewsArticlesRetention failed:', e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}

/**
 * 2026-10-08 memory-leak follow-up: news_clusters had no retention either. Clusters are the
 * durable news record of truth (small metadata rows; news_predictions reference cluster ids,
 * and PredictionOutcomeEvaluator joins predictions - never clusters - so pruning a cluster
 * cannot break prediction evaluation), hence the longer newsClustersRetentionDays window.
 * Pruned by updated_at: an active, still-updating story keeps its cluster alive.
 */
export async function sweepNewsClustersRetention(nowMs = Date.now()): Promise<number> {
  const cutoffIso = new Date(nowMs - runtimeIntervals.newsClustersRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = runtimeIntervals.newsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.newsRetentionSweepMaxBatchesPerCall;
  const deleteBatch = sqliteDb.prepare(
    'DELETE FROM news_clusters WHERE id IN (SELECT id FROM news_clusters WHERE updated_at < ? LIMIT ?)'
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
  } catch (e) {
    // 2026-10-08 defect hunt (P2-R4): sweep failures were invisible (bare catch) - log loudly.
    console.error('[operationalRetention] sweepNewsClustersRetention failed:', e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}

/**
 * 2026-10-08 "perfect testing" hardening: the central registry of every operational retention
 * sweep. startOperationalRetentionSweep() iterates this - nothing is wired by hand anymore -
 * and retentionCoverage.test.ts asserts every known append-only operational table appears here.
 * Adding a new append-only table without a sweeper entry fails that test by design: that is
 * how the news_articles/news_clusters gap (and the candidate_rankings gap before it) gets
 * caught at test time instead of on a live disk-forensics pass.
 */
export interface RetentionSweeper {
  /** Physical table name the sweeper prunes. */
  table: string;
  /** The sweep function; resolves to rows deleted. Never throws (returns partial count). */
  sweep: (nowMs?: number) => Promise<number>;
}

/**
 * 2026-10-08 defect hunt (news D2 / infra P2-R1/P2-R3): four more append-only tables plus
 * ai_calls, all growing unbounded with no prune path. Same batched + yielding discipline as
 * the news sweeps; failures log loudly (P2-R4), never swallowed.
 */
async function sweepIsoTextTable(
  table: string,
  column: string,
  retentionDays: number,
  nowMs: number,
): Promise<number> {
  const cutoffIso = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = runtimeIntervals.newsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.newsRetentionSweepMaxBatchesPerCall;
  const deleteBatch = sqliteDb.prepare(
    `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${column} < ? LIMIT ?)`
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
  } catch (e) {
    console.error(`[operationalRetention] sweep ${table} failed:`, e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}

export async function sweepEscalationDecisionsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('escalation_decisions', 'timestamp', runtimeIntervals.escalationDecisionsRetentionDays, nowMs);
}

export async function sweepJevShadowScoresRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('jev_shadow_scores', 'scored_at', runtimeIntervals.jevShadowScoresRetentionDays, nowMs);
}

export async function sweepNewsPredictionsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('news_predictions', 'created_at', runtimeIntervals.newsPredictionsRetentionDays, nowMs);
}

export async function sweepAiCallsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('ai_calls', 'created_at', runtimeIntervals.aiCallsRetentionDays, nowMs);
}

/**
 * 2026-10-08 synthetic session guard: a 6-minute synthetic session wrote rows to
 * 8 tables with no retention path anywhere in the codebase — the same defect
 * class as news_articles. Epoch-ms variant of the sweeper for integer-ms time
 * columns; keyColumn covers tables whose primary key is not `id`.
 */
async function sweepEpochMsTable(
  table: string,
  keyColumn: string,
  timeColumn: string,
  retentionDays: number,
  nowMs: number,
): Promise<number> {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const batchSize = runtimeIntervals.newsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.newsRetentionSweepMaxBatchesPerCall;
  const deleteBatch = sqliteDb.prepare(
    `DELETE FROM ${table} WHERE ${keyColumn} IN (SELECT ${keyColumn} FROM ${table} WHERE ${timeColumn} < ? LIMIT ?)`
  );
  let totalDeleted = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const result = deleteBatch.run(cutoffMs, batchSize);
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  } catch (e) {
    console.error(`[operationalRetention] sweep ${table} failed:`, e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}

/** Market-data bars: 801 rows in a 6-minute synthetic session (3 symbols). A full
 *  year is kept for backtests and outcome audits; anything older is dead weight. */
export async function sweepOhlcvBarsRetention(nowMs = Date.now()): Promise<number> {
  return sweepEpochMsTable('ohlcv_bars', 'id', 'timestamp', runtimeIntervals.ohlcvBarsRetentionDays, nowMs);
}

/** Predictions are graded within hours (evaluationHorizonMs=1h); 30d is generous. */
export async function sweepAgentPredictionsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('agent_predictions', 'timestamp', runtimeIntervals.agentPredictionsRetentionDays, nowMs);
}

export async function sweepQuantAssessmentsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('quant_assessments', 'created_at', runtimeIntervals.quantAssessmentsRetentionDays, nowMs);
}

export async function sweepPitDecisionLedgerRetention(nowMs = Date.now()): Promise<number> {
  return sweepEpochMsTable('pit_decision_ledger', 'id', 'published_at_ms', runtimeIntervals.pitDecisionLedgerRetentionDays, nowMs);
}

export async function sweepAgentReasoningLogsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('agent_reasoning_logs', 'timestamp', runtimeIntervals.agentReasoningLogsRetentionDays, nowMs);
}

export async function sweepTransactionTracesRetention(nowMs = Date.now()): Promise<number> {
  // trace_id is the primary key here, not id.
  const cutoffIso = new Date(nowMs - runtimeIntervals.transactionTracesRetentionDays * 24 * 60 * 60 * 1000).toISOString();
  const batchSize = runtimeIntervals.newsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.newsRetentionSweepMaxBatchesPerCall;
  const deleteBatch = sqliteDb.prepare(
    `DELETE FROM transaction_traces WHERE trace_id IN (SELECT trace_id FROM transaction_traces WHERE created_at < ? LIMIT ?)`
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
  } catch (e) {
    console.error('[operationalRetention] sweep transaction_traces failed:', e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}

/** One row per session; 90d of session history is plenty. */
export async function sweepSessionLifecycleSnapshotsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('session_lifecycle_snapshots', 'created_at', runtimeIntervals.sessionLifecycleSnapshotsRetentionDays, nowMs);
}

export async function sweepTradeLifecycleTransitionsRetention(nowMs = Date.now()): Promise<number> {
  return sweepIsoTextTable('trade_lifecycle_transitions', 'created_at', runtimeIntervals.tradeLifecycleTransitionsRetentionDays, nowMs);
}

/** Terminal staged catalysts (CONSUMED/EXPIRED) are never deleted by the live-queue size
 *  prune - one permanent row per staged catalyst, forever. Prune terminal rows older than
 *  the retention window by updated_at_ms (integer ms, set at write time). */
export async function sweepStagedNewsCatalystsTerminalRetention(nowMs = Date.now()): Promise<number> {
  const cutoffMs = nowMs - runtimeIntervals.stagedNewsCatalystsTerminalRetentionDays * 24 * 60 * 60 * 1000;
  const batchSize = runtimeIntervals.newsRetentionSweepBatchSize;
  const maxBatches = runtimeIntervals.newsRetentionSweepMaxBatchesPerCall;
  const deleteBatch = sqliteDb.prepare(
    `DELETE FROM staged_news_catalysts WHERE trace_id IN (SELECT trace_id FROM staged_news_catalysts WHERE status IN ('CONSUMED','EXPIRED') AND updated_at_ms < ? LIMIT ?)`
  );
  let totalDeleted = 0;
  try {
    for (let i = 0; i < maxBatches; i++) {
      const result = deleteBatch.run(cutoffMs, batchSize);
      totalDeleted += result.changes;
      if (result.changes < batchSize) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return totalDeleted;
  } catch (e) {
    console.error('[operationalRetention] sweep staged_news_catalysts failed:', e instanceof Error ? e.message : String(e));
    return totalDeleted;
  }
}

/**
 * 2026-10-09 (certification mission item 1 - OCT9_PIT_PROVENANCE_ESCAPE): retention sweep
 * for the decision_provenance table (per-Quant-decision PIT replay provenance). Lazy
 * dynamic import: the provenance module pulls in StrategyEngine (the real evaluation path
 * replay uses), which must never be in this module's static import set — same import-cycle
 * discipline as the two sweepers above (the 2026-10-09 defect hunt fixed a TDZ crash from
 * exactly this class of static import). The SQL itself is trivial; only the module load is
 * deferred, and it is the leaf provenance module, not the agent that emits the rows.
 */
export async function sweepDecisionProvenanceRetention(nowMs = Date.now()): Promise<number> {
  try {
    const { sweepDecisionProvenanceRetention: sweep } = await import('../replay/provenance/decisionProvenance');
    return sweep(nowMs);
  } catch (e) {
    console.error('[operationalRetention] sweepDecisionProvenanceRetention failed:', e instanceof Error ? e.message : String(e));
    return 0;
  }
}

export const RETENTION_SWEEPERS: RetentionSweeper[] = [
  { table: 'candidate_rankings', sweep: sweepCandidateRankingsRetention },
  { table: 'trade_plan_revalidations', sweep: sweepTradePlanRevalidationRetention },
  { table: 'premarket_data_reservations', sweep: sweepReservationLedgerRetention },
  { table: 'news_articles', sweep: sweepNewsArticlesRetention },
  { table: 'news_clusters', sweep: sweepNewsClustersRetention },
  // 2026-10-08 defect hunt (news D2 / infra P2-R1/P2-R3): the coverage test fails by
  // design if any append-only table lacks a sweeper - these four (plus ai_calls) were
  // growing unbounded with no prune path.
  { table: 'escalation_decisions', sweep: sweepEscalationDecisionsRetention },
  { table: 'jev_shadow_scores', sweep: sweepJevShadowScoresRetention },
  { table: 'news_predictions', sweep: sweepNewsPredictionsRetention },
  { table: 'staged_news_catalysts', sweep: sweepStagedNewsCatalystsTerminalRetention },
  { table: 'ai_calls', sweep: sweepAiCallsRetention },
  // 2026-10-08 synthetic session guard: a 6-minute synthetic session wrote rows to
  // these 8 tables, none of which had a prune path. Same coverage-test guarantee.
  { table: 'ohlcv_bars', sweep: sweepOhlcvBarsRetention },
  { table: 'agent_predictions', sweep: sweepAgentPredictionsRetention },
  { table: 'quant_assessments', sweep: sweepQuantAssessmentsRetention },
  { table: 'pit_decision_ledger', sweep: sweepPitDecisionLedgerRetention },
  { table: 'agent_reasoning_logs', sweep: sweepAgentReasoningLogsRetention },
  { table: 'transaction_traces', sweep: sweepTransactionTracesRetention },
  { table: 'session_lifecycle_snapshots', sweep: sweepSessionLifecycleSnapshotsRetention },
  { table: 'trade_lifecycle_transitions', sweep: sweepTradeLifecycleTransitionsRetention },
  // 2026-10-09 (certification mission item 1 - OCT9_PIT_PROVENANCE_ESCAPE): per-Quant-decision
  // PIT replay provenance. Same coverage-test guarantee as every table above.
  { table: 'decision_provenance', sweep: sweepDecisionProvenanceRetention },
];
