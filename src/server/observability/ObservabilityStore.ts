/**
 * Async batched persistence for structured observability events.
 * Isolated from the live trading spine: enqueue never throws; overflow drops; flush errors
 * increment counters and discard that batch (no unbounded re-queue).
 */
import { db } from '../db';
import { observabilityEvents } from '../db/schema';
import { lt } from 'drizzle-orm';
import { observabilityConfig } from '../config/observability';
import { incMetric } from './ObservabilityMetrics';
import type { ObservabilityLevel } from '../config/observability';

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

async function defaultPersist(batch: ObservabilityEventRow[]): Promise<void> {
  await db.insert(observabilityEvents).values(batch);
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

export async function sweepObservabilityRetention(nowMs = Date.now()): Promise<number> {
  const cutoff = nowMs - observabilityConfig.retentionDays * 24 * 60 * 60 * 1000;
  try {
    const result = await db.delete(observabilityEvents).where(lt(observabilityEvents.ts, cutoff));
    return Number((result as { changes?: number })?.changes ?? 0);
  } catch {
    incMetric('events_persist_failed');
    return 0;
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
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
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
