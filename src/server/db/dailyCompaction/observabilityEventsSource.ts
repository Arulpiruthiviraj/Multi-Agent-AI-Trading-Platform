/**
 * Daily Learning Compaction, Phase 1 - the ONE DailyCompactionSource implemented this phase.
 *
 * Section-to-event-type mapping below is deliberately conservative: every event type named here was
 * verified directly against config/eventNames.json and real structuredLogger call sites in this
 * codebase before being included (2026-10-01) - never guessed. A real event type this compactor does
 * not yet map to a named section still contributes fully to `eventTypeCounts`/`categoryCounts` (the
 * sum(eventTypeCounts) === sourceRowCount invariant covers it) and is surfaced in
 * `coverageManifest.unknownEventTypes`, never silently dropped.
 *
 * Deliberately NOT implemented this phase (documented, not fabricated): per-event-type quantitative
 * sufficient statistics (sum/sumSquared/confidence buckets) from `payload` JSON. Extracting those
 * safely requires verifying each event type's real payload schema individually - doing that
 * generically risks inventing a field that doesn't actually exist for some event types. Counts are
 * exhaustive and real; quantitative sufficient-statistics are a named Phase 2 candidate (see the
 * Phase 1 report).
 */
import { sqliteDb } from '../index';
import { observabilityConfig } from '../../config/observability';
import type { DailyCompactionSource, DailyCompactionSummary, PurgeWindowResult, SourceCompactionResult } from './types';

export const OBSERVABILITY_EVENTS_SCHEMA_VERSION = 1;
export const OBSERVABILITY_EVENTS_SOURCE_TYPE = 'OBSERVABILITY_EVENTS';

/** section -> { field -> real, verified event type(s) }. */
const SECTION_EVENT_TYPES: Record<string, Record<string, string[]>> = {
  discovery: {
    admitted: ['DISCOVERY_CANDIDATE_ADMITTED'],
    filtered: ['DISCOVERY_CANDIDATE_FILTERED'],
    subscriptionRequested: ['WATCHLIST_SUBSCRIBE_REQUESTED'],
    subscriptionPromoted: ['SUBSCRIPTION_PROMOTED'],
    subscriptionNotPromoted: ['SUBSCRIPTION_NOT_PROMOTED'],
  },
  ideas: {
    generated: ['TRADE_IDEA_GENERATED'],
    rejected: ['TRADE_IDEA_REJECTED', 'TRADE_REJECTED_CONSENSUS'],
  },
  consensus: {
    rounds: ['CHIEF_CONSENSUS_STARTED'],
    completed: ['CHIEF_CONSENSUS_COMPLETED'],
    approvals: ['CHIEF_APPROVED_IDEA'],
  },
  risk: {
    assessmentsStarted: ['RISK_ASSESSMENT_STARTED'],
    assessmentsCompleted: ['RISK_ASSESSMENT_COMPLETED'],
    blocks: ['RISK_BLOCK'],
    gateEvaluations: ['RISK_GATE_EVALUATED'],
  },
  orders: {
    submitted: ['ORDER_SUBMITTED'],
    accepted: ['ORDER_ACCEPTED'],
    executed: ['ORDER_EXECUTED'],
    filled: ['ORDER_FILLED'],
  },
  marketData: {
    disconnects: ['MARKET_DATA_DISCONNECTED'],
    gaps: ['MARKET_DATA_GAP_DETECTED'],
    staleDataEvents: ['DATA_STALE'],
    sourceDiscrepancies: ['MARKET_DATA_SOURCE_DISCREPANCY'],
  },
  reconciliation: {
    matches: ['RECONCILIATION_MATCH'],
    mismatches: ['RECONCILIATION_MISMATCH'],
    emergencyHalts: ['RECONCILIATION_EMERGENCY_HALT'],
    syncFailed: ['RECONCILIATION_SYNC_FAILED'],
  },
  javaBridge: {
    callOutcomes: ['QUANT_BRIDGE_CALL_OUTCOME'],
    malformedResponses: ['QUANT_BRIDGE_MALFORMED_RESPONSE'],
  },
  system: {
    uncleanShutdowns: ['UNCLEAN_SHUTDOWN_DETECTED'],
  },
};

const ALL_MAPPED_EVENT_TYPES = new Set(
  Object.values(SECTION_EVENT_TYPES).flatMap((fields) => Object.values(fields).flat()),
);

interface BreakdownRow { event_type: string | null; category: string | null; n: number; minTs: number | null; maxTs: number | null }

export const observabilityEventsSource: DailyCompactionSource = {
  sourceType: OBSERVABILITY_EVENTS_SOURCE_TYPE,
  schemaVersion: OBSERVABILITY_EVENTS_SCHEMA_VERSION,

  async compact(windowStartMs: number, windowEndMs: number, tradingDate: string): Promise<SourceCompactionResult> {
    // Single-pass SQL aggregation (one indexed ts range scan + temp b-tree GROUP BY) instead of
    // three separate passes (GROUP BY event_type, GROUP BY category, COUNT/MIN/MAX). Marginals are
    // derived in JS from the 2-D breakdown - provably identical counts to the old three-query form
    // (same filtered row set, NULL keys still mapped to '(none)' per the §8 invariant fix), at
    // ~1/3 the read I/O. Raw sqliteDb.prepare() (the same pattern this codebase's own db tests
    // already use), not drizzle's query builder, since this is a GROUP BY aggregate drizzle-orm's
    // typed builder does not model directly.
    const breakdownRows = sqliteDb
      .prepare(
        'SELECT event_type, category, COUNT(*) AS n, MIN(ts) AS minTs, MAX(ts) AS maxTs ' +
        'FROM observability_events WHERE ts >= ? AND ts < ? GROUP BY event_type, category',
      )
      .all(windowStartMs, windowEndMs) as BreakdownRow[];

    // Marginalize the 2-D breakdown. NULL event_type/category (a real, legitimate case - not every
    // structuredLogger call sets eventType) maps to a literal '(none)' key so the row is counted
    // in the marginals rather than silently dropped - this preserves the
    // sum(eventTypeCounts) === sourceRowCount invariant §8 requires (bug found and fixed via
    // ObservabilityStore.test.ts, 2026-10-01).
    const eventTypeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};
    let sourceRowCount = 0;
    let minTs: number | null = null;
    let maxTs: number | null = null;
    for (const r of breakdownRows) {
      const et = r.event_type ?? '(none)';
      const cat = r.category ?? '(none)';
      eventTypeCounts[et] = (eventTypeCounts[et] ?? 0) + r.n;
      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + r.n;
      sourceRowCount += r.n;
      if (r.minTs != null) minTs = minTs == null ? r.minTs : Math.min(minTs, r.minTs);
      if (r.maxTs != null) maxTs = maxTs == null ? r.maxTs : Math.max(maxTs, r.maxTs);
    }
    const eventTypesObserved = Object.keys(eventTypeCounts).sort();

    const sections: DailyCompactionSummary['sections'] = {};
    const eventTypesSummarized = new Set<string>();
    for (const [sectionName, fields] of Object.entries(SECTION_EVENT_TYPES)) {
      const section: Record<string, number> = {};
      for (const [fieldName, types] of Object.entries(fields)) {
        let total = 0;
        for (const t of types) {
          total += eventTypeCounts[t] ?? 0;
          eventTypesSummarized.add(t);
        }
        section[fieldName] = total;
      }
      sections[sectionName] = section;
    }

    const unknownEventTypes = eventTypesObserved.filter((t) => !ALL_MAPPED_EVENT_TYPES.has(t));

    const summary: DailyCompactionSummary = {
      sourceType: OBSERVABILITY_EVENTS_SOURCE_TYPE,
      tradingDate,
      schemaVersion: OBSERVABILITY_EVENTS_SCHEMA_VERSION,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      sourceRowCount,
      eventTypeCounts,
      categoryCounts,
      sections,
      coverageManifest: {
        sourceTable: 'observability_events',
        windowStartMs,
        windowEndMs,
        rowCount: sourceRowCount,
        minTs: minTs ?? null,
        maxTs: maxTs ?? null,
        eventTypesObserved,
        eventTypesSummarized: [...eventTypesSummarized].sort(),
        unknownEventTypes,
      },
    };

    return { sourceRowCount, summary };
  },

  purgeWindow: async (windowStartMs: number, windowEndMs: number): Promise<PurgeWindowResult> => {
    // 2026-10-08 I-E1: this was ONE single unbatched DELETE over the whole day window. A full
    // trading day of observability_events can be millions of rows (the 2026-10-01 retention
    // postmortem measured a 9.8M-row backlog blocking the single-threaded event loop - including
    // /health - for 8+ minutes on one DELETE) - the same defect class, not yet fixed here.
    // Batched + yielding now, the same discipline as the news/operational retention sweeps:
    // id-subquery deletes bounded by config (observabilityConfig keys are required - missing
    // keys fail boot), setImmediate yields between batches so any single synchronous slice
    // stays small no matter how large the window is. Fixed BEFORE any enablement:
    // dailyCompactionEnabled is still false, and the flag could be flipped later.
    const batchSize = observabilityConfig.retentionSweepBatchSize;
    const maxBatches = observabilityConfig.retentionSweepMaxBatchesPerCall;
    const deleteBatch = sqliteDb.prepare(
      'DELETE FROM observability_events WHERE id IN (SELECT id FROM observability_events WHERE ts >= ? AND ts < ? LIMIT ?)'
    );
    let deleted = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const result = deleteBatch.run(windowStartMs, windowEndMs, batchSize);
      deleted += result.changes;
      if (result.changes < batchSize) return { deleted, truncated: false };
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Batch budget hit before the window drained - the caller keeps the day VERIFIED and the
    // next sweep resumes. Rows already deleted stay deleted; the deletes are idempotent.
    return { deleted, truncated: true };
  },
};
