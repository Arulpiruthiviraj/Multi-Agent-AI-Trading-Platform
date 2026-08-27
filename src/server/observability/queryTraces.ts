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
import { EVENTS } from '../core/eventNames';
import { reconstructPreIdeaStages } from './DecisionFunnelPreIdea';

/**
 * Real perf fix (2026-08-18): every stage this computes from already exists as a durably
 * persisted event_traces row (EventStore.ts's trackEvent - confirmed live: TRADE_IDEA_GENERATED,
 * CHIEF_CONSENSUS_STARTED/COMPLETED, RISK_ASSESSMENT_STARTED/COMPLETED, ORDER_SUBMITTED,
 * ORDER_EXECUTED are all real, persisted event types, not new instrumentation). This is a
 * pure read-time rollup over rows already written by the live decision spine - it adds no
 * listener, no timer map, no new table, and is never on the hot path (RiskEngine/OMS never call
 * it; it only runs when an operator/UI requests a trace). MARKET_DATA is deliberately excluded:
 * EventStore.ts's NO_PERSIST_TYPES skips it on purpose (many ticks/sec would flood event_traces),
 * so there is no durable per-trace "market data received" timestamp to diff against - that stage
 * is reported unavailable rather than fabricated from an inferred time.
 */
export interface LatencyBreakdownMs {
  totalLatencyMs: number | null;
  firstStage: string | null;
  lastStage: string | null;
  stages: Record<string, number>;
  marketDataToSignalMs: null;
  marketDataToSignalUnavailableReason: string;
}

const LATENCY_MILESTONES: Array<{ event: string; label: string }> = [
  { event: EVENTS.TRADE_IDEA_GENERATED, label: 'ideaGenerated' },
  { event: EVENTS.CHIEF_CONSENSUS_STARTED, label: 'consensusStarted' },
  { event: EVENTS.CHIEF_CONSENSUS_COMPLETED, label: 'consensusCompleted' },
  { event: EVENTS.RISK_ASSESSMENT_STARTED, label: 'riskStarted' },
  { event: EVENTS.RISK_ASSESSMENT_COMPLETED, label: 'riskCompleted' },
  { event: EVENTS.ORDER_SUBMITTED, label: 'orderSubmitted' },
  { event: EVENTS.ORDER_EXECUTED, label: 'orderExecuted' },
];

function computeLatencyBreakdown(events: Array<{ eventType: string; timestamp: number }>): LatencyBreakdownMs {
  const firstTimestampByEvent = new Map<string, number>();
  for (const e of events) {
    if (!firstTimestampByEvent.has(e.eventType) || e.timestamp < firstTimestampByEvent.get(e.eventType)!) {
      firstTimestampByEvent.set(e.eventType, e.timestamp);
    }
  }

  const present = LATENCY_MILESTONES
    .map((m) => ({ ...m, ts: firstTimestampByEvent.get(m.event) }))
    .filter((m): m is { event: string; label: string; ts: number } => typeof m.ts === 'number')
    .sort((a, b) => a.ts - b.ts);

  const stages: Record<string, number> = {};
  for (let i = 1; i < present.length; i++) {
    const key = `${present[i - 1].label}To${present[i].label[0].toUpperCase()}${present[i].label.slice(1)}Ms`;
    stages[key] = present[i].ts - present[i - 1].ts;
  }

  return {
    totalLatencyMs: present.length >= 2 ? present[present.length - 1].ts - present[0].ts : null,
    firstStage: present[0]?.label ?? null,
    lastStage: present[present.length - 1]?.label ?? null,
    stages,
    marketDataToSignalMs: null,
    marketDataToSignalUnavailableReason:
      'MARKET_DATA ticks are deliberately not durably persisted per-trace (EventStore.ts NO_PERSIST_TYPES - many ticks/sec would flood event_traces); not fabricated from an inferred time.',
  };
}

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
    latencyBreakdown: computeLatencyBreakdown(events.map((e) => ({ eventType: e.eventType, timestamp: e.timestamp }))),
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

/**
 * Phase 4A (Decision Funnel, 2026-08-26): the full DISCOVERED -> TRADE_CLOSED trace the zero-trade
 * audit had to reconstruct by hand. Wraps getDecisionTrace() (unchanged, still the source of truth
 * for IDEA_GENERATED onward) and prepends the pre-idea stages DecisionFunnelPreIdea.ts reconstructs
 * from existing event_traces rows. Never duplicates getDecisionTrace's own logic.
 */
export async function getFullDecisionFunnelTrace(traceId: string) {
  const trace = await getDecisionTrace(traceId);
  if (!trace.ok || !trace.symbol) {
    return { ...trace, preIdeaStages: [] as Awaited<ReturnType<typeof reconstructPreIdeaStages>> };
  }
  const ideaEvent = trace.events.find((e) => e.eventType === EVENTS.TRADE_IDEA_GENERATED);
  if (!ideaEvent) {
    return { ...trace, preIdeaStages: [] as Awaited<ReturnType<typeof reconstructPreIdeaStages>> };
  }
  const preIdeaStages = await reconstructPreIdeaStages(trace.symbol, ideaEvent.timestamp);
  return { ...trace, preIdeaStages };
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
