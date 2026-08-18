/**
 * DB-backed decision / order trace assembly. Source of truth is SQLite, not the in-memory ring.
 */
import { db } from '../db';
import {
  eventTraces,
  transactionTraces,
  trades,
  fills,
  observabilityEvents,
  aiCalls,
} from '../db/schema';
import { eq, desc, or, and, like } from 'drizzle-orm';
import { loadAgentThoughts, loadRiskForTrace, tracingService } from '../services/TracingService';
import { redactSecretsDeep } from '../core/SecretRedaction';
import { hashSensitive } from './hashSensitive';

function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function getDecisionTrace(traceId: string) {
  await tracingService.flush();
  const txTrace = await db.select().from(transactionTraces).where(eq(transactionTraces.traceId, traceId)).get();
  const agentThoughts = await loadAgentThoughts(traceId);
  const { assessment, gates } = await loadRiskForTrace(traceId);
  const events = await db.select().from(eventTraces).where(eq(eventTraces.correlationId, traceId));
  const obs = await db.select().from(observabilityEvents).where(eq(observabilityEvents.decisionId, traceId));
  const order = await db.select().from(trades).where(eq(trades.traceId, traceId)).get();
  const fillRows = order
    ? await db.select().from(fills).where(eq(fills.orderId, order.id))
    : [];
  const aiRows = await db.select({
    id: aiCalls.id,
    agent: aiCalls.agent,
    provider: aiCalls.provider,
    model: aiCalls.model,
    status: aiCalls.status,
    latencyMs: aiCalls.latencyMs,
    tokensIn: aiCalls.tokensIn,
    tokensOut: aiCalls.tokensOut,
    cost: aiCalls.cost,
    error: aiCalls.error,
    createdAt: aiCalls.createdAt,
    prompt: aiCalls.prompt,
  }).from(aiCalls).where(eq(aiCalls.traceId, traceId));

  const timeline = [
    ...events.map((e) => ({
      source: 'event_traces' as const,
      time: new Date(e.timestamp).toISOString(),
      sortMs: e.timestamp,
      stage: e.eventType,
      details: redactSecretsDeep(parseJson(e.payload)),
    })),
    ...obs.map((e) => ({
      source: 'observability_events' as const,
      time: new Date(e.ts).toISOString(),
      sortMs: e.ts,
      stage: e.eventType || e.category,
      details: { level: e.level, message: e.message, payload: parseJson(e.payload) },
    })),
    ...agentThoughts.map((t) => {
      const ms = Date.parse(t.timestamp);
      return {
        source: 'agent_reasoning_logs' as const,
        time: t.timestamp,
        sortMs: Number.isFinite(ms) ? ms : 0,
        stage: 'AGENT_ANALYSIS',
        details: { agent: t.agent, action: t.action, confidence: t.confidence },
      };
    }),
  ].sort((a, b) => a.sortMs - b.sortMs);

  return {
    ok: true as const,
    traceId,
    decisionId: traceId,
    correlationId: traceId,
    symbol: txTrace?.symbol ?? assessment?.symbol ?? agentThoughts[0]?.symbol ?? order?.symbol ?? null,
    status: txTrace?.lifecycleStatus ?? (assessment ? (assessment.approved ? 'RISK_APPROVED' : 'RISK_REJECTED') : 'INITIATED'),
    terminalReason: txTrace?.terminalReason ?? assessment?.reasoning ?? null,
    consensusScore: txTrace?.consensusScore ?? null,
    consensusThreshold: txTrace?.consensusThreshold ?? null,
    contributingAgents: txTrace?.contributingAgents
      ? parseJson(txTrace.contributingAgents)
      : agentThoughts.map((t) => t.agent),
    orderId: txTrace?.orderId ?? order?.id ?? null,
    timeline: timeline.map((e, i) => ({ step: i + 1, time: e.time, stage: e.stage, source: e.source, details: e.details })),
    agentThoughts,
    riskAssessment: assessment ?? null,
    riskGates: gates,
    order: order ?? null,
    fills: fillRows,
    aiCalls: aiRows.map((r) => ({
      id: r.id,
      agent: r.agent,
      provider: r.provider,
      model: r.model,
      status: r.status,
      latencyMs: r.latencyMs,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cost: r.cost,
      error: r.error,
      createdAt: r.createdAt,
      promptHash: hashSensitive(r.prompt),
    })),
    events: events.map((e) => ({
      eventType: e.eventType,
      timestamp: e.timestamp,
      source: e.source,
      payload: redactSecretsDeep(parseJson(e.payload)),
    })),
    observabilityEvents: obs.map((e) => ({
      ts: e.ts,
      level: e.level,
      category: e.category,
      eventType: e.eventType,
      message: e.message,
      component: e.component,
      payload: parseJson(e.payload),
    })),
  };
}

export async function getOrderTrace(orderId: string) {
  const order = await db.select().from(trades).where(
    or(eq(trades.id, orderId), eq(trades.brokerOrderId, orderId)),
  ).get();
  if (!order) return { ok: false as const, error: 'ORDER_NOT_FOUND' };
  const fillRows = await db.select().from(fills).where(eq(fills.orderId, order.id));
  const obs = await db.select().from(observabilityEvents).where(eq(observabilityEvents.orderId, order.id));
  const decision = order.traceId ? await getDecisionTrace(order.traceId) : null;
  return {
    ok: true as const,
    order,
    fills: fillRows,
    observabilityEvents: obs,
    decision,
  };
}

export async function exportDecisionTraceJson(traceId: string) {
  const trace = await getDecisionTrace(traceId);
  return {
    exportedAt: new Date().toISOString(),
    schema: 'argus.decision_trace.v1',
    organicClaim: 'NOT_ASSERTED',
    live: 'NO-GO',
    ...trace,
  };
}

export async function listRecentDecisionTraces(opts: { symbol?: string; status?: string; limit: number }) {
  const capped = Math.min(Math.max(opts.limit, 1), 200);
  const conditions = [];
  if (opts.symbol) {
    const safeSymbol = String(opts.symbol).replace(/[%_]/g, '').trim().toUpperCase();
    if (safeSymbol) conditions.push(like(transactionTraces.symbol, `%${safeSymbol}%`));
  }
  if (opts.status) conditions.push(eq(transactionTraces.lifecycleStatus, opts.status));
  const rows = conditions.length > 0
    ? await db.select().from(transactionTraces).where(and(...conditions)).orderBy(desc(transactionTraces.createdAt)).limit(capped)
    : await db.select().from(transactionTraces).orderBy(desc(transactionTraces.createdAt)).limit(capped);
  return rows;
}
