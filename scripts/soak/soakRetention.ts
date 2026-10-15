/**
 * Soak-scoped retention + disk-full fail-fast (scripts/soak/soakRetention.ts).
 *
 * Two harness defects found by the October soak runs, fixed here:
 *
 * 1. UNBOUNDED SYNTHETIC-DB GROWTH (~8MB/successful-iteration).
 *    Root cause: the production retention sweepers (src/server/db/operationalRetention.ts)
 *    are time-based, and synthetic sessions are stamped on a FIXED synthetic clock
 *    (2026-09-15T13:30:00Z base, +180 sim-minutes per iteration). Those synthetic
 *    timestamps sit inside every production retention window (30/90/365 days), so the
 *    sweepers never prune a single soak row while the soak is running. A 180-minute
 *    wall-clock soak runs ~240 iterations x ~8MB = ~2GB against one isolated DB.
 *    Seg1 proved it: 500MB of growth, then "database or disk is full" at iteration ~60.
 *    The fix is soak-scoped and deliberately does NOT touch production retention
 *    policy: after each iteration, prune rows from iterations older than
 *    SOAK_KEEP_ITERATIONS, keyed on each iteration's synthetic session window.
 *    Synthetic session windows are sequential and non-overlapping, so "older than the
 *    keep window" is exact, not heuristic.
 *
 * 2. NO FAIL-FAST ON DISK-FULL.
 *    Seg1 kept looping after the disk filled: 720,845 of 720,904 iterations failed
 *    with "database or disk is full", burning the whole wall-clock budget on doomed
 *    iterations instead of aborting with an honest verdict. isDiskFullError() lets the
 *    child break out immediately.
 *
 * FIXTURE PRESERVATION INVARIANT (read before changing seedAuthorization):
 * seedAuthorization() writes ONLY to `trades` (PERMANENT decision record - the
 * SyntheticSessionGuards PERMANENT_TABLES set, never pruned anywhere) and to
 * learning_versions via recordStrategyLifecycleTransition (BOUNDED_TABLES - one row
 * per transition, never pruned). No pruned table below ever receives fixture rows, so
 * this pruner needs no marker filtering. If seedAuthorization ever writes to a table
 * in SOAK_PRUNE_TABLES, that table must move to SOAK_PRUNE_EXCLUDED_TABLES first.
 *
 * SCOPE: scripts/soak/ only. Zero production impact - no src/server/ file is modified
 * by this module. The production sweepers remain the bounded-growth story for real
 * deployments; this is the bounded-growth story for the soak's synthetic time.
 */
import type { Database } from 'better-sqlite3';
import { sqliteDb } from '../../src/server/db';

/** How many of the most recent iterations' rows the soak DB keeps. Older windows are pruned. */
export const SOAK_KEEP_ITERATIONS = 5;

/** Batched-delete discipline mirrors sweepIsoTextTable: bounded subquery deletes, never one giant DELETE. */
const PRUNE_BATCH_SIZE = 1000;
/** Progressive drain: leftover backlog waits for the next iteration, like the production sweepers. */
const PRUNE_MAX_BATCHES_PER_TABLE = 50;

export interface SoakPruneTable {
  /** Physical table name (allowlisted const - never user input). */
  table: string;
  /** Timestamp column the prune compares against the keep-window cutoff. */
  column: string;
  /** 'iso' = ISO-8601 TEXT column, 'epochMs' = integer epoch-ms column. */
  kind: 'iso' | 'epochMs';
  /** Primary-key column for the batched id-subquery delete. Defaults to 'id'. */
  keyColumn?: string;
}

/**
 * Append-only session tables pruned by the soak, with the (table, timestamp column)
 * mapping verified against each table's production sweeper in operationalRetention.ts
 * (or ObservabilityStore.ts for observability_events). Deliberately EXCLUDES the
 * permanent decision record (trades, fills, risk_assessments, risk_gate_results,
 * event_traces, transactions) and bounded-by-construction tables - same split as
 * SyntheticSessionGuards' PERMANENT_TABLES / BOUNDED_TABLES.
 */
export const SOAK_PRUNE_TABLES: SoakPruneTable[] = [
  { table: 'candidate_rankings', column: 'cycle_at', kind: 'iso' },
  { table: 'news_articles', column: 'published_at', kind: 'iso' },
  { table: 'news_clusters', column: 'updated_at', kind: 'iso' },
  { table: 'escalation_decisions', column: 'timestamp', kind: 'iso' },
  { table: 'jev_shadow_scores', column: 'scored_at', kind: 'iso' },
  { table: 'news_predictions', column: 'created_at', kind: 'iso' },
  { table: 'ai_calls', column: 'created_at', kind: 'iso' },
  { table: 'ohlcv_bars', column: 'timestamp', kind: 'epochMs' },
  { table: 'agent_predictions', column: 'timestamp', kind: 'iso' },
  { table: 'quant_assessments', column: 'created_at', kind: 'iso' },
  { table: 'pit_decision_ledger', column: 'published_at_ms', kind: 'epochMs' },
  { table: 'agent_reasoning_logs', column: 'timestamp', kind: 'iso' },
  { table: 'transaction_traces', column: 'created_at', kind: 'iso', keyColumn: 'trace_id' },
  { table: 'session_lifecycle_snapshots', column: 'created_at', kind: 'iso' },
  { table: 'trade_lifecycle_transitions', column: 'created_at', kind: 'iso' },
  { table: 'consensus_debate_predictions', column: 'created_at', kind: 'iso' },
  { table: 'consensus_decisions', column: 'created_at', kind: 'iso', keyColumn: 'transaction_id' },
  { table: 'reconciliation_events', column: 'checked_at', kind: 'iso' },
  { table: 'portfolio_snapshots', column: 'snapshot_at', kind: 'iso' },
  { table: 'ai_usage', column: 'timestamp', kind: 'iso' },
  { table: 'kronos_predictions', column: 'timestamp', kind: 'iso' },
  { table: 'prediction_outcomes', column: 'evaluated_at', kind: 'iso' },
  { table: 'prediction_outcome_horizons', column: 'evaluated_at', kind: 'iso' },
  { table: 'missed_opportunities', column: 'detected_at', kind: 'iso' },
  { table: 'learning_observations', column: 'created_at', kind: 'iso' },
  { table: 'meta_label_features', column: 'created_at', kind: 'iso' },
  { table: 'quant_forecasts', column: 'created_at', kind: 'iso', keyColumn: 'forecast_id' },
  { table: 'explainability_reports', column: 'timestamp', kind: 'iso', keyColumn: 'trace_id' },
  { table: 'training_examples', column: 'created_at', kind: 'iso' },
  { table: 'learned_rules', column: 'timestamp', kind: 'iso' },
  // observability_events' sweeper lives in ObservabilityStore.ts (own module, like production).
  { table: 'observability_events', column: 'ts', kind: 'epochMs' },
];

/**
 * RETENTION_SWEEPERS tables deliberately NOT soak-pruned, with the reason. The
 * coverage test below fails by design if a registry table is in neither list.
 */
export const SOAK_PRUNE_EXCLUDED_TABLES: string[] = [
  // Prune rule is status-gated (only CONSUMED/EXPIRED rows) in its own module - a blind
  // time delete here could remove live UNCONSUMED catalysts. Not a soak volume driver.
  'staged_news_catalysts',
  // Pruned by its own module (tradePlanRevalidationRetention) with terminal-state semantics.
  'trade_plan_revalidations',
  // Pruned by its own module (PremarketDataReservation.pruneReservationLedger).
  'premarket_data_reservations',
  // Pruned by its own module (replay/provenance/decisionProvenance); small volume in the
  // all-AI-down soak (no AI decisions to provenance).
  'decision_provenance',
];

/** consensus_evidence is pruned by parent age via a JOIN (same rule as production) - handled separately. */
const CONSENSUS_EVIDENCE_TABLE = 'consensus_evidence';

const yieldToEventLoop = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

/**
 * True when the error is a disk-full condition from any layer we write through:
 * better-sqlite3 (SQLITE_FULL / "database or disk is full") or the OS (ENOSPC /
 * "no space left on device"). Pure function - unit tested.
 */
export function isDiskFullError(e: unknown): boolean {
  if (e === null || e === undefined) return false;
  if (typeof e === 'object') {
    const code = (e as { code?: unknown }).code;
    if (code === 'SQLITE_FULL' || code === 'ENOSPC') return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /database or disk is full|no space left on device|ENOSPC/i.test(msg);
}

export interface SoakPruneResult {
  deletedByTable: Record<string, number>;
  totalDeleted: number;
}

/**
 * Delete rows older than keepFromMs from one direct-timestamp table, in bounded
 * batches with event-loop yields between them (same discipline as sweepIsoTextTable).
 * Never throws: a failing table is logged and skipped so one bad table cannot kill
 * the soak loop - the "never throws" contract matches the production sweepers.
 */
export async function pruneSoakTable(
  spec: SoakPruneTable,
  keepFromMs: number,
  dbHandle: Database = sqliteDb,
): Promise<number> {
  const keyColumn = spec.keyColumn ?? 'id';
  const cutoff = spec.kind === 'iso' ? new Date(keepFromMs).toISOString() : keepFromMs;
  let totalDeleted = 0;
  try {
    // Table/column names come from the allowlisted SOAK_PRUNE_TABLES const - never user input.
    const deleteBatch = dbHandle.prepare(
      `DELETE FROM ${spec.table} WHERE ${keyColumn} IN ` +
        `(SELECT ${keyColumn} FROM ${spec.table} WHERE ${spec.column} < ? LIMIT ?)`,
    );
    for (let i = 0; i < PRUNE_MAX_BATCHES_PER_TABLE; i++) {
      const result = deleteBatch.run(cutoff, PRUNE_BATCH_SIZE);
      totalDeleted += result.changes;
      if (result.changes < PRUNE_BATCH_SIZE) break; // caught up - fewer than a full batch matched
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error(
      `[soakRetention] prune ${spec.table} failed (skipped, soak continues):`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return totalDeleted;
}

/**
 * consensus_evidence has no own timestamp column - it is pruned by parent
 * consensus_decisions.created_at via the same JOIN rule the production sweeper uses,
 * plus the same orphan pass. Never throws, same contract as pruneSoakTable.
 */
export async function pruneConsensusEvidenceSoak(
  keepFromMs: number,
  dbHandle: Database = sqliteDb,
): Promise<number> {
  const cutoffIso = new Date(keepFromMs).toISOString();
  let totalDeleted = 0;
  try {
    const deleteByParentAge = dbHandle.prepare(
      `DELETE FROM ${CONSENSUS_EVIDENCE_TABLE} WHERE id IN (` +
        `SELECT ce.id FROM ${CONSENSUS_EVIDENCE_TABLE} ce ` +
        `JOIN consensus_decisions cd ON cd.transaction_id = ce.transaction_id ` +
        `WHERE cd.created_at < ? LIMIT ?)`,
    );
    const deleteOrphans = dbHandle.prepare(
      `DELETE FROM ${CONSENSUS_EVIDENCE_TABLE} WHERE id IN (` +
        `SELECT id FROM ${CONSENSUS_EVIDENCE_TABLE} ` +
        `WHERE transaction_id NOT IN (SELECT transaction_id FROM consensus_decisions) LIMIT ?)`,
    );
    for (let i = 0; i < PRUNE_MAX_BATCHES_PER_TABLE; i++) {
      const result = deleteByParentAge.run(cutoffIso, PRUNE_BATCH_SIZE);
      totalDeleted += result.changes;
      if (result.changes < PRUNE_BATCH_SIZE) break;
      await yieldToEventLoop();
    }
    for (let i = 0; i < PRUNE_MAX_BATCHES_PER_TABLE; i++) {
      const result = deleteOrphans.run(PRUNE_BATCH_SIZE);
      totalDeleted += result.changes;
      if (result.changes < PRUNE_BATCH_SIZE) break;
      await yieldToEventLoop();
    }
  } catch (e) {
    console.error(
      `[soakRetention] prune ${CONSENSUS_EVIDENCE_TABLE} failed (skipped, soak continues):`,
      e instanceof Error ? e.message : String(e),
    );
  }
  return totalDeleted;
}

/**
 * One soak retention pass: prune every covered table to the keep window, then the
 * join-based consensus_evidence pass. Idempotent - safe to call after every iteration.
 * Never throws (per-table "never throws" contract above).
 */
export async function pruneSoakIterations(
  keepFromMs: number,
  dbHandle: Database = sqliteDb,
): Promise<SoakPruneResult> {
  const deletedByTable: Record<string, number> = {};
  let totalDeleted = 0;
  for (const spec of SOAK_PRUNE_TABLES) {
    const n = await pruneSoakTable(spec, keepFromMs, dbHandle);
    if (n > 0) deletedByTable[spec.table] = n;
    totalDeleted += n;
  }
  const n = await pruneConsensusEvidenceSoak(keepFromMs, dbHandle);
  if (n > 0) deletedByTable[CONSENSUS_EVIDENCE_TABLE] = n;
  totalDeleted += n;
  return { deletedByTable, totalDeleted };
}
