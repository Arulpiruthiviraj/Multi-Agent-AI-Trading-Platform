/**
 * Async batched persistence for structured observability events.
 * Isolated from the live trading spine: enqueue never throws; overflow drops; flush errors
 * increment counters and discard that batch (no unbounded re-queue).
 */
import { db, sqliteDb } from '../db';
import { observabilityEvents } from '../db/schema';
import { lt } from 'drizzle-orm';
import { observabilityConfig } from '../config/observability';
import { incMetric } from './ObservabilityMetrics';
import type { ObservabilityLevel } from '../config/observability';
import { purgeVerifiedDays } from '../db/dailyCompaction/DailyCompactionOrchestrator';
import { observabilityEventsSource } from '../db/dailyCompaction/observabilityEventsSource';
import { timeAsyncPersist } from './syncPersistTiming';

export interface ObservabilityEventRow {
  id: string;
  ts: number;
  level: ObservabilityLevel;
  category: string;
  eventType: string | null;
  loggerName: string;
  message: string;
  sessionId: string;
  correlationId: string | null;
  decisionId: string | null;
  traceId: string | null;
  orderId: string | null;
  symbol: string | null;
  component: string | null;
  payload: string | null;
}

let queue: ObservabilityEventRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let retentionTimer: ReturnType<typeof setInterval> | null = null;
let persistImpl: (batch: ObservabilityEventRow[]) => Promise<void> = defaultPersist;
let enqueueBlocked = false;

/** Current canonical queue only. An empty pending queue does not mean a flush is idle. */
export function getObservabilityQueueSnapshot() {
  return {
    pending: queue.length,
    capacity: observabilityConfig.maxQueueSize,
    flushing,
    firstPendingEventTs: queue[0]?.ts ?? null,
    dropPolicy: observabilityConfig.dropPolicy,
    flushIntervalMs: observabilityConfig.batchFlushMs,
    inFlightBatchSize: null, // not tracked; never fabricate zero during an active flush
  };
}

async function defaultPersist(batch: ObservabilityEventRow[]): Promise<void> {
  // 2026-10-12 (pre-market perfection mission, item 1): warn-level timing around this
  // synchronous-under-the-hood commit - a disk-level stall here blocks the event loop
  // (SYNC_PERSIST_SLOW at WARN). The drizzle call is sync better-sqlite3; measuring the
  // awaited window measures the main-thread block.
  await timeAsyncPersist('ObservabilityStore.defaultPersist', () => db.insert(observabilityEvents).values(batch));
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { void flushObservabilityStore(); }, observabilityConfig.batchFlushMs);
}

export function enqueueObservabilityEvent(row: ObservabilityEventRow): void {
  try {
    if (enqueueBlocked) {
      incMetric('events_dropped_queue_full');
      return;
    }
    if (queue.length >= observabilityConfig.maxQueueSize) {
      incMetric('events_dropped_queue_full');
      if (observabilityConfig.dropPolicy === 'oldest') queue.shift();
      else return;
    }
    queue.push(row);
    if (queue.length >= observabilityConfig.maxBatchSize) {
      void flushObservabilityStore();
      return;
    }
    scheduleFlush();
  } catch {
    incMetric('events_dropped_queue_full');
  }
}

export async function flushObservabilityStore(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, observabilityConfig.maxBatchSize);
  try {
    await persistImpl(batch);
    incMetric('events_persisted', batch.length);
  } catch {
    incMetric('events_persist_failed', batch.length);
    // Do not re-queue: logging isolation. Trading must not stall on a stuck disk.
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }
}

/**
 * Daily Learning Compaction Phase 1 (2026-10-01): once observabilityConfig.dailyCompactionEnabled
 * is on, raw rows are deleted ONLY through purgeVerifiedDays() - a day without a VERIFIED archive
 * row is kept regardless of age, and this function never falls back to the blind delete below while
 * the flag is on. Default is OFF (not yet wired into live boot), so the pre-existing blind
 * time-based delete below is BYTE-FOR-BYTE UNCHANGED for every deployment that hasn't explicitly
 * opted in - this is what keeps "existing retention behavior is not weakened" true for Phase 1.
 */
let sweepAborted = false;

export async function sweepObservabilityRetention(nowMs = Date.now()): Promise<number> {
  if (observabilityConfig.dailyCompactionEnabled) {
    const result = await purgeVerifiedDays(observabilityEventsSource, observabilityConfig.retentionDays, nowMs);
    return result.totalRowsPurged;
  }
  const cutoff = nowMs - observabilityConfig.retentionDays * 24 * 60 * 60 * 1000;
  // 2026-10-01 defect verification pass: previously one single unbatched DELETE, live-reproduced to
  // block the whole process's event loop (including /health) for 8+ minutes against this
  // deployment's real 9.8M-row backlog - see config/observability.json's own comment. Deleting by a
  // bounded id subquery + yielding between batches (setImmediate) keeps any one synchronous slice
  // small and lets a large backlog drain progressively across multiple sweep intervals instead of
  // trying to do it all in one blocking transaction.
  const batchSize = observabilityConfig.retentionSweepBatchSize;
  const maxBatches = observabilityConfig.retentionSweepMaxBatchesPerCall;
  const deleteBatch = sqliteDb.prepare(
    'DELETE FROM observability_events WHERE id IN (SELECT id FROM observability_events WHERE ts < ? LIMIT ?)'
  );
  let totalDeleted = 0;
  sweepAborted = false;
  try {
    for (let i = 0; i < maxBatches; i++) {
      if (sweepAborted) break; // stop requested between slices: never touch the DB after the drain began
      const result = deleteBatch.run(cutoff, batchSize);
      totalDeleted += result.changes;
      if (result.changes < batchSize) break; // caught up - fewer than a full batch matched
      // 2026-10-15 D9: a REAL pause (not setImmediate) so timers, I/O and protective-exit delivery run between slices.
      await new Promise<void>((resolve) => setTimeout(resolve, observabilityConfig.retentionSweepPauseMs));
    }
    return totalDeleted;
  } catch {
    incMetric('events_persist_failed');
    return totalDeleted;
  }
}

export function startObservabilityRetentionSweep(): void {
  if (retentionTimer) return;
  retentionTimer = setInterval(() => { void sweepObservabilityRetention(); }, observabilityConfig.retentionSweepMs);
  if (typeof retentionTimer === 'object' && retentionTimer && 'unref' in retentionTimer) {
    retentionTimer.unref();
  }
  void sweepObservabilityRetention();
}

export function stopObservabilityRetentionSweep(): void {
  sweepAborted = true;
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}

/**
 * 2026-10-12 (L6): the batch-flush timer was never cleared. Called during the graceful-shutdown
 * drain BEFORE the SQLite checkpoint/close - clears the timer and performs a final flush of any
 * pending events so nothing queued in memory is dropped on shutdown. Safe to call when the
 * queue is empty. (The retention sweep has its own stopObservabilityRetentionSweep(), already
 * wired into the shutdown drain.)
 */
export async function stopObservabilityStore(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushObservabilityStore();
}

/** Test hooks — never used on the live path. */
export function setObservabilityPersistForTests(fn: ((batch: ObservabilityEventRow[]) => Promise<void>) | null): void {
  persistImpl = fn ?? defaultPersist;
}

export function setObservabilityEnqueueBlockedForTests(blocked: boolean): void {
  enqueueBlocked = blocked;
}

export function resetObservabilityStoreForTests(): void {
  queue = [];
  flushing = false;
  enqueueBlocked = false;
  persistImpl = defaultPersist;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

export function observabilityQueueLengthForTests(): number {
  return queue.length;
}
