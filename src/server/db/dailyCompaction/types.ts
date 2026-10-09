/**
 * Daily Learning Compaction, Phase 1 (2026-10-01). Shared types for the compact -> verify -> purge
 * pipeline. Deliberately pluggable per source (§19 of the mandate): Phase 1 implements exactly one
 * DailyCompactionSource (observability_events) - adding a second source later means implementing
 * this interface again, never redesigning the orchestrator/archive schema.
 */

export type CompactionStatus = 'PENDING' | 'COMPACTING' | 'COMPACTED' | 'VERIFIED' | 'PURGED' | 'FAILED';

/** Real, verified coverage manifest for one compaction run - never fabricated. */
export interface CoverageManifest {
  sourceTable: string;
  windowStartMs: number;
  windowEndMs: number;
  rowCount: number;
  minTs: number | null;
  maxTs: number | null;
  eventTypesObserved: string[];
  eventTypesSummarized: string[];
  /** Real event types present in the raw data this run but not mapped to a named semantic section
   *  below - still fully counted in eventTypeCounts (the sum(eventTypeCounts) === rowCount
   *  invariant covers them), just not yet broken out by name. Never silently dropped. */
  unknownEventTypes: string[];
}

/** The machine-readable summary_json payload. `sections` holds only fields the compactor could
 *  verify against real, current event-type literals in this codebase - see each source's own
 *  header comment for exactly which event types back which field. */
export interface DailyCompactionSummary {
  sourceType: string;
  tradingDate: string;
  schemaVersion: number;
  windowStart: string; // ISO
  windowEnd: string; // ISO
  sourceRowCount: number;
  eventTypeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
  sections: Record<string, Record<string, number | Record<string, number>>>;
  coverageManifest: CoverageManifest;
}

export interface SourceCompactionResult {
  sourceRowCount: number;
  summary: DailyCompactionSummary;
}

/** Result of a batched purgeWindow call. `truncated` is true when the call hit its per-call
 *  batch budget before the window was fully purged - the caller must NOT mark the day PURGED
 *  yet; the next sweep resumes idempotently (deletes are idempotent, so a resume is a safe
 *  re-run over the remaining rows). */
export interface PurgeWindowResult {
  deleted: number;
  truncated: boolean;
}

/** One pluggable raw-table source for the compaction pipeline. */
export interface DailyCompactionSource {
  sourceType: string;
  schemaVersion: number;
  /** Pure read over [windowStartMs, windowEndMs) - never mutates, safe to re-run. */
  compact(windowStartMs: number, windowEndMs: number, tradingDate: string): Promise<SourceCompactionResult>;
  /** Deletes raw rows for [windowStartMs, windowEndMs) - called ONLY after the corresponding
   *  archive row reaches VERIFIED. MUST be batched with event-loop yields between batches (see
   *  observabilityEventsSource) - a large window can never block the event loop in one
   *  synchronous slice. Idempotent: re-running after a crash deletes only what remains. */
  purgeWindow(windowStartMs: number, windowEndMs: number): Promise<PurgeWindowResult>;
}

export interface CompactionOutcome {
  tradingDate: string;
  sourceType: string;
  status: CompactionStatus;
  reason?: string;
}
