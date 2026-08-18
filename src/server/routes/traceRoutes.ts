/**
 * Consolidated distributed trace inspector — GET /api/v2/traces/:traceId
 */
import { Router } from 'express';
import { db } from '../db';
import { eventTraces, transactionTraces } from '../db/schema';
import { eq, desc, like, and, asc } from 'drizzle-orm';
import { loadAgentThoughts, loadRiskForTrace, tracingService } from '../services/TracingService';

export const traceRouter = Router();

function parsePayload(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

type TimelineEntry = {
  step: number;
  time: string;
  stage: string;
  details?: Record<string, unknown>;
  agents?: string[];
  score?: number;
  outcome?: string;
  failingGate?: string | null;
};

function buildTimeline(
  events: Array<{ eventType: string; timestamp: number; payload: string | null; source: string | null }>,
  agentThoughts: Array<{ agent: string; timestamp: string; action: string }>,
): TimelineEntry[] {
  const entries: Array<TimelineEntry & { sortMs: number }> = [];
  for (const e of events) {
    const payload = parsePayload(e.payload) as Record<string, unknown> | null;
    const stage = e.eventType;
    const details: Record<string, unknown> = { source: e.source };
    if (payload?.symbol) details.symbol = payload.symbol;
    if (payload?.side) details.side = payload.side;
    if (typeof payload?.confidence === 'number') details.confidence = payload.confidence;
    if (payload?.price != null) details.price = payload.price;
    entries.push({
      step: 0,
      time: new Date(e.timestamp).toISOString(),
      sortMs: e.timestamp,
      stage,
      details,
      score: typeof payload?.confidence === 'number' ? payload.confidence : undefined,
      outcome: stage.includes('REJECT') ? 'REJECTED' : stage.includes('APPROV') ? 'APPROVED' : undefined,
      failingGate: typeof payload?.rejectionGate === 'string' ? payload.rejectionGate : undefined,
    });
  }
  for (const t of agentThoughts) {
    const ms = Date.parse(t.timestamp);
    entries.push({
      step: 0,
      time: t.timestamp,
      sortMs: Number.isFinite(ms) ? ms : Date.now(),
      stage: 'AGENT_ANALYSIS',
      agents: [t.agent],
      details: { action: t.action },
    });
  }
  entries.sort((a, b) => a.sortMs - b.sortMs);
  return entries.map((e, i) => {
    const { sortMs: _s, ...rest } = e;
    return { ...rest, step: i + 1 };
  });
}

traceRouter.get('/', async (req, res) => {
  try {
    const { symbol, status, limit } = req.query as { symbol?: string; status?: string; limit?: string };
    const capped = Math.min(parseInt(limit || '50', 10) || 50, 200);
    const conditions = [];
    if (symbol) conditions.push(like(transactionTraces.symbol, `%${symbol.toUpperCase()}%`));
    if (status) conditions.push(eq(transactionTraces.lifecycleStatus, status));
    const rows = conditions.length > 0
      ? await db.select().from(transactionTraces).where(and(...conditions)).orderBy(desc(transactionTraces.createdAt)).limit(capped)
      : await db.select().from(transactionTraces).orderBy(desc(transactionTraces.createdAt)).limit(capped);
    res.json({ ok: true, traces: rows });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

traceRouter.get('/:traceId', async (req, res) => {
  try {
    const { traceId } = req.params;
    await tracingService.flush();

    const txTrace = await db.select().from(transactionTraces).where(eq(transactionTraces.traceId, traceId)).get();
    const agentThoughts = await loadAgentThoughts(traceId);
    const { assessment, gates } = await loadRiskForTrace(traceId);
    const events = await db.select().from(eventTraces).where(eq(eventTraces.correlationId, traceId)).orderBy(asc(eventTraces.timestamp));

    const timeline = buildTimeline(events, agentThoughts);
    const createdMs = events.length > 0 ? events[0].timestamp : (txTrace ? Date.parse(txTrace.createdAt) : Date.now());
    const lastMs = events.length > 0 ? events[events.length - 1].timestamp : createdMs;

    const firstPayload = events[0]?.payload ? parsePayload(events[0].payload) as Record<string, unknown> | null : null;
    const symbol =
      txTrace?.symbol
      ?? assessment?.symbol
      ?? agentThoughts[0]?.symbol
      ?? (typeof firstPayload?.symbol === 'string' ? firstPayload.symbol : null);

    res.json({
      ok: true,
      traceId,
      symbol,
      status: txTrace?.lifecycleStatus ?? (assessment ? (assessment.approved ? 'RISK_APPROVED' : 'RISK_REJECTED') : 'INITIATED'),
      terminalReason: txTrace?.terminalReason ?? assessment?.reasoning ?? null,
      consensusScore: txTrace?.consensusScore ?? null,
      consensusThreshold: txTrace?.consensusThreshold ?? null,
      contributingAgents: txTrace?.contributingAgents ? JSON.parse(txTrace.contributingAgents) : agentThoughts.map(t => t.agent),
      orderId: txTrace?.orderId ?? null,
      totalLatencyMs: Math.max(0, lastMs - createdMs),
      timeline,
      agentThoughts,
      riskAssessment: assessment ?? null,
      riskGates: gates,
      events: events.map(e => ({
        eventType: e.eventType,
        timestamp: e.timestamp,
        source: e.source,
        payload: parsePayload(e.payload),
      })),
    });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
