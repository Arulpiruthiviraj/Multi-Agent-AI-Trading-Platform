/** Control-plane elapsed time, not a quantitative trading calculation or trading gate. */
import { and, eq, gte, lte, asc, sql } from 'drizzle-orm';
import { db } from '../db';
import { observabilityEvents } from '../db/schema';
import { quantScheduling } from '../config/quantScheduling';
import { snapshotObservabilityIds } from './ObservabilityContext';
import { getObservabilityQueueSnapshot } from './ObservabilityStore';
import { snapshotMetrics } from './ObservabilityMetrics';
import { observabilityConfig, LEVEL_RANK } from '../config/observability';

interface Event { ts: number; rowid: number; symbol: string | null; eventType: string | null; payload: string | null }
export function summarizeQuantAdmissionLatency(events: Event[], now: number, complete: boolean) {
  const pending = new Map<string, number[]>();
  const measured: Array<{ symbol: string; acceptedAtMs: number; startedAtMs: number; elapsedMs: number }> = [];
  let malformed = false;
  for (const e of [...events].sort((a, b) => a.ts - b.ts || a.rowid - b.rowid)) {
    if (!e.symbol) continue;
    if (e.eventType === 'MARKET_DATA_SUBSCRIPTION_OUTCOME') {
      let payload;
      try { payload = JSON.parse(e.payload ?? 'null'); } catch { malformed = true; continue; }
      if (!payload || typeof payload.outcome !== 'string') { malformed = true; continue; }
      if (payload.outcome === 'ACCEPTED') { const times = pending.get(e.symbol) ?? []; times.push(e.ts); pending.set(e.symbol, times); }
    } else if (e.eventType === 'QUANT_SYMBOL_EVALUATION_STARTED') {
      for (const acceptedAtMs of pending.get(e.symbol) ?? []) measured.push({ symbol: e.symbol, acceptedAtMs, startedAtMs: e.ts, elapsedMs: e.ts - acceptedAtMs });
      pending.delete(e.symbol);
    }
  }
  const awaiting = [...pending].flatMap(([symbol, times]) => times.map(acceptedAtMs => ({ symbol, acceptedAtMs, elapsedMs: now - acceptedAtMs })));
  const violations = measured.filter(m => m.elapsedMs > quantScheduling.admissionLatencyTargetMs);
  const overdue = awaiting.filter(m => m.elapsedMs > quantScheduling.admissionLatencyTargetMs);
  return { certified: complete && !malformed && measured.length >= quantScheduling.admissionLatencyMinSamples
      && violations.length === 0 && awaiting.length === 0,
    complete: complete && !malformed, measured, awaiting, violations, overdue,
    targetMs: quantScheduling.admissionLatencyTargetMs,
    semantics: 'SUBSCRIPTION_ACCEPTED_TO_SCHEDULED_QUANT_START; NOT_PROVIDER_ACK_OR_COMPLETED_ASSESSMENT',
    note: 'Window-local diagnostic only. Evicted/unassessed admissions remain pending conservatively. Not a multi-hour reliability certificate.' };
}
export async function buildQuantAdmissionLatency(now = Date.now()) {
  const healthy = () => {
    const queue = getObservabilityQueueSnapshot();
    const metrics = snapshotMetrics();
    return queue.pending === 0 && !queue.flushing && metrics.events_dropped_queue_full === 0
      && metrics.events_persist_failed === 0 && metrics.logger_errors === 0
      && LEVEL_RANK[observabilityConfig.persistMinLevel] <= LEVEL_RANK.INFO;
  };
  const healthyBefore = healthy();
  const fromMs = now - quantScheduling.latencyEvidenceWindowMs;
  const sessionId = snapshotObservabilityIds().sessionId;
  const groups = await Promise.all(['MARKET_DATA_SUBSCRIPTION_OUTCOME', 'QUANT_SYMBOL_EVALUATION_STARTED'].map(async type =>
    db.select({ ts: observabilityEvents.ts, rowid: sql<number>`"observability_events"."rowid"`,
      symbol: observabilityEvents.symbol, eventType: observabilityEvents.eventType, payload: observabilityEvents.payload })
      .from(observabilityEvents).where(and(eq(observabilityEvents.eventType, type), eq(observabilityEvents.sessionId, sessionId),
        gte(observabilityEvents.ts, fromMs), lte(observabilityEvents.ts, now)))
      .orderBy(asc(observabilityEvents.ts), asc(sql`"observability_events"."rowid"`))
      .limit(quantScheduling.latencyEvidenceRowLimit + 1)));
  return { fromMs, toMs: now, sessionId, ...summarizeQuantAdmissionLatency(groups.flat(), now,
    healthyBefore && healthy() && groups.every(rows => rows.length <= quantScheduling.latencyEvidenceRowLimit)) };
}
