/**
 * Daily Learning Compaction, Phase 1 - compact -> verify -> purge orchestrator.
 *
 * Safety rule this whole module exists to enforce (the mandate's own §1): raw rows may be deleted
 * ONLY for a (tradingDate, sourceType) whose archive row has reached VERIFIED. Any failure at any
 * step - compaction, persistence, verification, checksum, row-count reconciliation - leaves the
 * archive row in a non-VERIFIED status and the real raw data untouched. There is no fallback path
 * that deletes raw data without a VERIFIED archive row.
 */
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../index';
import { dailyLearningArchive } from '../schema';
import { computeChecksum } from './checksum';
import { getTradingDateWindowMs, isTradingDateClosed } from './tradingDayWindow';
import type { CompactionOutcome, DailyCompactionSource, DailyCompactionSummary } from './types';
import { observeSafe, structuredLogger } from '../../observability/StructuredLogger';

const REQUIRED_SECTIONS = ['discovery', 'ideas', 'consensus', 'risk', 'orders', 'marketData', 'reconciliation', 'javaBridge', 'system'];

function sumEventTypeCounts(summary: DailyCompactionSummary): number {
  return Object.values(summary.eventTypeCounts).reduce((a, b) => a + b, 0);
}

/** Pure validation - never mutates, safe to call on a freshly-read-back row. Returns a reason
 *  string on failure, null on success. Every check here is a real, documented §8 requirement. */
function validateSummary(summary: DailyCompactionSummary, expectedSourceRowCount: number): string | null {
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in summary.sections)) return `MISSING_SECTION:${section}`;
  }
  const eventTypeSum = sumEventTypeCounts(summary);
  if (eventTypeSum !== summary.sourceRowCount) {
    return `EVENT_TYPE_SUM_MISMATCH: sum(eventTypeCounts)=${eventTypeSum} !== sourceRowCount=${summary.sourceRowCount}`;
  }
  if (summary.sourceRowCount !== expectedSourceRowCount) {
    return `SOURCE_ROW_COUNT_MISMATCH: archived=${summary.sourceRowCount} !== expected=${expectedSourceRowCount}`;
  }
  return null;
}

function logEvent(eventType: string, fields: Record<string, unknown>): void {
  observeSafe(() => {
    structuredLogger.info('daily_compaction', { category: 'SYSTEM', component: 'DailyCompactionOrchestrator', eventType, ...fields });
  });
}

/**
 * Runs compaction for one (source, tradingDate). Idempotent: a day already VERIFIED or PURGED is a
 * real no-op (never re-compacted); a day left PENDING/COMPACTING/COMPACTED/FAILED by a prior crash
 * is safely retried from scratch (compact() is a pure read, safe to redo).
 */
export async function runDailyCompactionForDate(
  source: DailyCompactionSource,
  tradingDate: string,
  nowMs: number = Date.now(),
): Promise<CompactionOutcome> {
  if (!isTradingDateClosed(tradingDate, nowMs)) {
    return { tradingDate, sourceType: source.sourceType, status: 'PENDING', reason: 'DAY_NOT_CLOSED' };
  }

  const existing = db.select().from(dailyLearningArchive)
    .where(and(eq(dailyLearningArchive.tradingDate, tradingDate), eq(dailyLearningArchive.sourceType, source.sourceType)))
    .all()[0];
  if (existing && (existing.compactionStatus === 'VERIFIED' || existing.compactionStatus === 'PURGED')) {
    return { tradingDate, sourceType: source.sourceType, status: existing.compactionStatus as CompactionOutcome['status'] };
  }

  const { windowStartMs, windowEndMs } = getTradingDateWindowMs(tradingDate);
  logEvent('DAILY_COMPACTION_STARTED', { tradingDate, sourceType: source.sourceType, windowStartMs, windowEndMs });

  // Expensive aggregation happens OUTSIDE any write transaction (§11) - never hold a long write
  // lock across the real collect/compact work.
  let sourceRowCount: number;
  let summary: DailyCompactionSummary;
  try {
    const result = await source.compact(windowStartMs, windowEndMs, tradingDate);
    sourceRowCount = result.sourceRowCount;
    summary = result.summary;
  } catch (e) {
    const reason = `COMPACTION_FAILED: ${e instanceof Error ? e.message : String(e)}`;
    persistStatus(tradingDate, source, windowStartMs, windowEndMs, 'FAILED', reason, null);
    logEvent('DAILY_COMPACTION_FAILED', { tradingDate, sourceType: source.sourceType, reason });
    return { tradingDate, sourceType: source.sourceType, status: 'FAILED', reason };
  }

  // Serialization + persist wrapped together: a pathological summary (e.g. a circular reference a
  // future source implementation might accidentally produce) must fail closed as a real archive
  // write failure, never crash the whole sweep uncaught.
  try {
    const summaryJson = JSON.stringify(summary);
    const summaryChecksum = computeChecksum(summary);
    // Short archive-write transaction (§11) - persist, then read back in a SEPARATE step to prove
    // what's actually durable, not just what was in memory a moment ago.
    db.transaction((tx) => {
      const row = {
        tradingDate,
        sourceType: source.sourceType,
        schemaVersion: source.schemaVersion,
        windowStartMs,
        windowEndMs,
        sourceRowCount,
        summaryJson,
        summaryChecksum,
        sourceChecksum: null as string | null,
        compactionStatus: 'COMPACTED' as const,
        failureReason: null as string | null,
        createdAt: existing?.createdAt ?? nowMs,
        verifiedAt: null as number | null,
        rawPurgedAt: existing?.rawPurgedAt ?? null,
      };
      if (existing) {
        tx.update(dailyLearningArchive).set(row).where(eq(dailyLearningArchive.id, existing.id)).run();
      } else {
        tx.insert(dailyLearningArchive).values(row).run();
      }
    });
  } catch (e) {
    const reason = `ARCHIVE_WRITE_FAILED: ${e instanceof Error ? e.message : String(e)}`;
    try {
      persistStatus(tradingDate, source, windowStartMs, windowEndMs, 'FAILED', reason, existing?.id ?? null);
    } catch { /* best-effort - raw data is untouched either way */ }
    logEvent('DAILY_COMPACTION_FAILED', { tradingDate, sourceType: source.sourceType, reason });
    return { tradingDate, sourceType: source.sourceType, status: 'FAILED', reason };
  }
  logEvent('DAILY_COMPACTION_COMPLETED', { tradingDate, sourceType: source.sourceType, sourceRowCount });

  return verifyArchiveRow(source, tradingDate, nowMs);
}

/**
 * Re-reads whatever is currently persisted for (tradingDate, sourceType) from scratch (never trusts
 * in-memory state) and re-checks schema/sections, the sum(eventTypeCounts)===sourceRowCount
 * invariant, and the checksum (§8). Independently callable (not just as part of
 * runDailyCompactionForDate) so a row can be re-verified on demand - e.g. an operational integrity
 * check, or recovering from a crash that left a row COMPACTED but never reached VERIFIED.
 */
export function verifyArchiveRow(
  source: DailyCompactionSource,
  tradingDate: string,
  nowMs: number = Date.now(),
): CompactionOutcome {
  const persisted = db.select().from(dailyLearningArchive)
    .where(and(eq(dailyLearningArchive.tradingDate, tradingDate), eq(dailyLearningArchive.sourceType, source.sourceType)))
    .all()[0];
  if (!persisted) {
    return { tradingDate, sourceType: source.sourceType, status: 'FAILED', reason: 'VERIFICATION_FAILED: archive row not found' };
  }
  const fail = (reason: string): CompactionOutcome => {
    db.update(dailyLearningArchive).set({ compactionStatus: 'FAILED', failureReason: reason }).where(eq(dailyLearningArchive.id, persisted.id)).run();
    logEvent('DAILY_COMPACTION_FAILED', { tradingDate, sourceType: source.sourceType, reason });
    return { tradingDate, sourceType: source.sourceType, status: 'FAILED', reason };
  };

  let readBackSummary: DailyCompactionSummary;
  try {
    readBackSummary = JSON.parse(persisted.summaryJson);
  } catch {
    return fail('VERIFICATION_FAILED: summary_json is not valid JSON on read-back');
  }
  const recomputedChecksum = computeChecksum(readBackSummary);
  if (recomputedChecksum !== persisted.summaryChecksum) {
    return fail(`VERIFICATION_FAILED: checksum mismatch (stored=${persisted.summaryChecksum}, recomputed=${recomputedChecksum})`);
  }
  const validationError = validateSummary(readBackSummary, persisted.sourceRowCount);
  if (validationError) {
    return fail(`VERIFICATION_FAILED: ${validationError}`);
  }

  db.update(dailyLearningArchive)
    .set({ compactionStatus: 'VERIFIED', verifiedAt: nowMs, failureReason: null })
    .where(eq(dailyLearningArchive.id, persisted.id))
    .run();
  logEvent('DAILY_COMPACTION_VERIFIED', { tradingDate, sourceType: source.sourceType });
  return { tradingDate, sourceType: source.sourceType, status: 'VERIFIED' };
}

function persistStatus(
  tradingDate: string,
  source: DailyCompactionSource,
  windowStartMs: number,
  windowEndMs: number,
  status: 'FAILED',
  reason: string,
  existingId: number | null,
): void {
  if (existingId != null) {
    db.update(dailyLearningArchive).set({ compactionStatus: status, failureReason: reason }).where(eq(dailyLearningArchive.id, existingId)).run();
    return;
  }
  db.insert(dailyLearningArchive).values({
    tradingDate,
    sourceType: source.sourceType,
    schemaVersion: source.schemaVersion,
    windowStartMs,
    windowEndMs,
    sourceRowCount: 0,
    summaryJson: '{}',
    summaryChecksum: computeChecksum({}),
    compactionStatus: status,
    failureReason: reason,
    createdAt: Date.now(),
  }).run();
}

/**
 * Purges raw rows for every VERIFIED (tradingDate, sourceType) older than retentionDays, one day at
 * a time. Two-phase protocol (2026-10-08 I-E1):
 *   1. Batched, yielding deletes via source.purgeWindow() - idempotent, each batch its own
 *      short statement, event-loop yields between batches, so a multi-million-row day can never
 *      block the event loop in one synchronous slice. A crash mid-phase leaves the day VERIFIED
 *      with some rows already deleted - the next sweep resumes safely (deletes are idempotent).
 *   2. Only after the window is FULLY purged (not truncated by the batch budget), a short atomic
 *      transaction marks the day PURGED.
 * A day that is NOT VERIFIED (PENDING/COMPACTING/COMPACTED/FAILED) is never purged, however old
 * it is - the mandate's explicit "never fall back to blind delete" rule. A day whose purge hit
 * the per-call batch budget stays VERIFIED (never silently marked PURGED) and drains
 * progressively across sweeps.
 */
export async function purgeVerifiedDays(
  source: DailyCompactionSource,
  retentionDays: number,
  nowMs: number = Date.now(),
): Promise<{ purgedDays: number; totalRowsPurged: number; blockedDays: string[] }> {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const eligible = db.select().from(dailyLearningArchive)
    .where(and(
      eq(dailyLearningArchive.sourceType, source.sourceType),
      eq(dailyLearningArchive.compactionStatus, 'VERIFIED'),
      lt(dailyLearningArchive.windowEndMs, cutoffMs),
    ))
    .all();

  let purgedDays = 0;
  let totalRowsPurged = 0;
  for (const row of eligible) {
    logEvent('RETENTION_PURGE_STARTED', { tradingDate: row.tradingDate, sourceType: source.sourceType });
    // Each day isolated in its own try/catch: a failure on one day must not abort the rest of
    // this sweep's otherwise-healthy days (a real "partial purge" scenario). A failed day stays
    // VERIFIED with raw data untouched (or partially deleted - idempotent, safe to retry next
    // sweep) and is never flipped to PURGED.
    try {
      const { deleted, truncated } = await source.purgeWindow(row.windowStartMs, row.windowEndMs);
      if (truncated) {
        // Batch budget hit before the window drained: keep the day VERIFIED - the next sweep
        // resumes the remaining rows. Marking PURGED now would lie about raw data still present.
        logEvent('RETENTION_PURGE_TRUNCATED', {
          tradingDate: row.tradingDate, sourceType: source.sourceType, rowsPurged: deleted,
        });
        continue;
      }
      // Short mark-PURGED transaction, AFTER the batched deletes fully completed - only a fully
      // purged window may be marked. (The old single-transaction delete-then-mark was atomic but
      // required one unbatched DELETE; batching can't yield inside a better-sqlite3 tx callback.)
      db.transaction(() => {
        db.update(dailyLearningArchive)
          .set({ compactionStatus: 'PURGED', rawPurgedAt: nowMs })
          .where(eq(dailyLearningArchive.id, row.id))
          .run();
      });
      purgedDays += 1;
      totalRowsPurged += deleted;
      logEvent('RETENTION_PURGE_COMPLETED', { tradingDate: row.tradingDate, sourceType: source.sourceType, rowsPurged: deleted });
    } catch (e) {
      const reason = `PURGE_FAILED: ${e instanceof Error ? e.message : String(e)}`;
      logEvent('DAILY_COMPACTION_FAILED', { tradingDate: row.tradingDate, sourceType: source.sourceType, reason });
      // Row status is untouched - still VERIFIED, eligible for retry on the next sweep.
      // Continue with the remaining eligible days in this sweep.
    }
  }

  // Visibility only - days blocked from purge because they never reached VERIFIED, even though
  // they're older than the retention cutoff. Never acted on here; surfaced so an operator can see
  // raw data is being retained for a real reason.
  const blocked = db.select().from(dailyLearningArchive)
    .where(and(
      eq(dailyLearningArchive.sourceType, source.sourceType),
      lt(dailyLearningArchive.windowEndMs, cutoffMs),
    ))
    .all()
    .filter((r) => r.compactionStatus !== 'VERIFIED' && r.compactionStatus !== 'PURGED');
  for (const b of blocked) {
    logEvent('RETENTION_PURGE_BLOCKED', { tradingDate: b.tradingDate, sourceType: source.sourceType, compactionStatus: b.compactionStatus, failureReason: b.failureReason });
  }

  return { purgedDays, totalRowsPurged, blockedDays: blocked.map((b) => b.tradingDate) };
}
