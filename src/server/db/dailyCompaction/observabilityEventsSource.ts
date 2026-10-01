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
import type { DailyCompactionSource, DailyCompactionSummary, SourceCompactionResult } from './types';

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

interface CountRow { key: string | null; n: number }

/** Real bug found and fixed via ObservabilityStore.test.ts (2026-10-01): a row with a genuinely
 *  NULL event_type/category (a real, legitimate case - not every structuredLogger call sets
 *  eventType) was counted in sourceRowCount but silently dropped from eventTypeCounts/
 *  categoryCounts, breaking the sum(eventTypeCounts) === sourceRowCount invariant §8 requires. A
 *  literal '(none)' key keeps it exhaustive and visible rather than silently uncounted. */
function toCountMap(rows: CountRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.key ?? '(none)'] = r.n;
  }
  return out;
}

export const observabilityEventsSource: DailyCompactionSource = {
  sourceType: OBSERVABILITY_EVENTS_SOURCE_TYPE,
  schemaVersion: OBSERVABILITY_EVENTS_SCHEMA_VERSION,

  async compact(windowStartMs: number, windowEndMs: number, tradingDate: string): Promise<SourceCompactionResult> {
    // SQL-level aggregation throughout (never pulling raw rows into JS) so this stays fast at real
    // volume (§17 performance requirement) - a GROUP BY over an indexed ts range is O(matching rows)
    // regardless of how many distinct event types/categories exist. Raw sqliteDb.prepare() (the
    // same pattern this codebase's own db tests already use), not drizzle's query builder, since
    // this is a GROUP BY aggregate drizzle-orm's typed builder does not model directly.
    const eventTypeRows = sqliteDb
      .prepare('SELECT event_type AS key, COUNT(*) AS n FROM observability_events WHERE ts >= ? AND ts < ? GROUP BY event_type')
      .all(windowStartMs, windowEndMs) as CountRow[];
    const categoryRows = sqliteDb
      .prepare('SELECT category AS key, COUNT(*) AS n FROM observability_events WHERE ts >= ? AND ts < ? GROUP BY category')
      .all(windowStartMs, windowEndMs) as CountRow[];
    const { n: sourceRowCount, minTs, maxTs } = sqliteDb
      .prepare('SELECT COUNT(*) AS n, MIN(ts) AS minTs, MAX(ts) AS maxTs FROM observability_events WHERE ts >= ? AND ts < ?')
      .get(windowStartMs, windowEndMs) as { n: number; minTs: number | null; maxTs: number | null };

    const eventTypeCounts = toCountMap(eventTypeRows);
    const categoryCounts = toCountMap(categoryRows);
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

  purgeWindow(windowStartMs: number, windowEndMs: number): number {
    const result = sqliteDb
      .prepare('DELETE FROM observability_events WHERE ts >= ? AND ts < ?')
      .run(windowStartMs, windowEndMs);
    return result.changes;
  },
};
