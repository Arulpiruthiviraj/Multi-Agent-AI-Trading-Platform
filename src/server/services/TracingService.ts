/**
 * Async-batched distributed tracing for agent reasoning and transaction lifecycle.
 * Writes are queued and flushed on a timer — never awaited on the live decision spine.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { isTelemetryPulsePayload } from '../core/telemetryPulse';
import { tracingConfig } from '../config/tracing';
import { db } from '../db';
import { agentReasoningLogs, transactionTraces, riskGateResults, riskAssessments } from '../db/schema';
import { eq, asc } from 'drizzle-orm';

export type TraceLifecycleStatus =
  | 'INITIATED'
  | 'ANALYZING'
  | 'CONSENSUS_REACHED'
  | 'NO_CONSENSUS'
  | 'RISK_APPROVED'
  | 'RISK_REJECTED'
  | 'ORDER_SUBMITTED'
  | 'FILLED'
  | 'CANCELLED';

export interface AgentThoughtInput {
  traceId: string;
  agentName: string;
  symbol: string;
  action: string;
  confidence: number;
  reasoningSummary: string;
  indicatorsSnapshot?: Record<string, unknown> | null;
  promptContext?: string | null;
  executionLatencyMs?: number | null;
  timestamp?: string;
}

export interface ChiefConsensusInput {
  traceId: string;
  symbol: string;
  approved: boolean;
  consensusScore: number;
  consensusThreshold: number;
  terminalReason: string;
  votingMatrix: Array<{
    agent: string;
    side: string;
    confidence: number;
    weight: number;
    agreed: boolean;
    sourceTraceId?: string;
  }>;
}

type PendingAgentThought = { kind: 'agent'; row: typeof agentReasoningLogs.$inferInsert };
type PendingTraceUpsert = { kind: 'trace'; row: typeof transactionTraces.$inferInsert };
type PendingWrite = PendingAgentThought | PendingTraceUpsert;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mergeAgents(existing: string | null | undefined, next: string[]): string {
  const set = new Set<string>(parseJson<string[]>(existing ?? null, []));
  for (const a of next) set.add(a);
  return JSON.stringify(Array.from(set));
}

class TracingService {
  private queue: PendingWrite[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor() {
    this.registerEventListeners();
  }

  logAgentThought(input: AgentThoughtInput): void {
    if (!input.traceId) return;
    const row: typeof agentReasoningLogs.$inferInsert = {
      traceId: input.traceId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      agentName: input.agentName,
      symbol: input.symbol,
      action: input.action,
      confidence: input.confidence,
      indicatorsSnapshot: input.indicatorsSnapshot ? JSON.stringify(input.indicatorsSnapshot) : null,
      promptContext: input.promptContext ?? null,
      reasoningSummary: input.reasoningSummary,
      executionLatencyMs: input.executionLatencyMs ?? null,
    };
    this.enqueue({ kind: 'agent', row });
    this.ensureTraceRow(input.traceId, input.symbol, 'ANALYZING', [input.agentName]);
    this.emitSpan(input.traceId, 'AGENT_REASONING', {
      agent: input.agentName,
      symbol: input.symbol,
      action: input.action,
      confidence: input.confidence,
    });
  }

  logChiefConsensus(input: ChiefConsensusInput): void {
    if (!input.traceId) return;
    const status: TraceLifecycleStatus = input.approved ? 'CONSENSUS_REACHED' : 'NO_CONSENSUS';
    const agents = input.votingMatrix.map(v => v.agent);
    this.upsertTrace({
      traceId: input.traceId,
      symbol: input.symbol,
      lifecycleStatus: status,
      contributingAgents: mergeAgents(null, agents),
      consensusScore: input.consensusScore,
      consensusThreshold: input.consensusThreshold,
      terminalReason: input.terminalReason,
    });
    this.logAgentThought({
      traceId: input.traceId,
      agentName: 'ChiefTraderAgent',
      symbol: input.symbol,
      action: input.approved ? 'APPROVE' : 'VETO',
      confidence: input.consensusScore,
      reasoningSummary: input.terminalReason,
      promptContext: JSON.stringify({
        votingMatrix: input.votingMatrix,
        weightedFormula: 'sum(confidence * weight) / sum(weight) for agreeing agents',
      }),
    });
    this.emitSpan(input.traceId, 'CHIEF_CONSENSUS', {
      approved: input.approved,
      score: input.consensusScore,
      threshold: input.consensusThreshold,
    });
  }

  private ensureTraceRow(traceId: string, symbol: string, status: TraceLifecycleStatus, agents: string[] = []): void {
    this.upsertTrace({
      traceId,
      symbol,
      lifecycleStatus: status,
      contributingAgents: agents.length > 0 ? JSON.stringify(agents) : undefined,
    }, true);
  }

  private upsertTrace(
    partial: Partial<typeof transactionTraces.$inferInsert> & { traceId: string; symbol?: string },
    initOnly = false,
  ): void {
    const now = new Date().toISOString();
    const row: typeof transactionTraces.$inferInsert = {
      traceId: partial.traceId,
      symbol: partial.symbol ?? 'UNKNOWN',
      createdAt: now,
      lifecycleStatus: partial.lifecycleStatus ?? (initOnly ? 'INITIATED' : 'ANALYZING'),
      contributingAgents: partial.contributingAgents ?? null,
      consensusScore: partial.consensusScore ?? null,
      consensusThreshold: partial.consensusThreshold ?? null,
      riskSummary: partial.riskSummary ?? null,
      terminalReason: partial.terminalReason ?? null,
      orderId: partial.orderId ?? null,
    };
    this.enqueue({ kind: 'trace', row });
  }

  private enqueue(item: PendingWrite): void {
    this.queue.push(item);
    if (this.queue.length >= tracingConfig.maxBatchSize) {
      void this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), tracingConfig.batchFlushMs);
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, tracingConfig.maxBatchSize);
    try {
      for (const item of batch) {
        if (item.kind === 'agent') {
          await db.insert(agentReasoningLogs).values(item.row);
        } else {
          const existing = await db.select().from(transactionTraces).where(eq(transactionTraces.traceId, item.row.traceId)).get();
          if (!existing) {
            await db.insert(transactionTraces).values(item.row);
          } else {
            const mergedAgents = item.row.contributingAgents
              ? mergeAgents(existing.contributingAgents, parseJson<string[]>(item.row.contributingAgents, []))
              : existing.contributingAgents;
            await db.update(transactionTraces).set({
              symbol: item.row.symbol !== 'UNKNOWN' ? item.row.symbol : existing.symbol,
              lifecycleStatus: item.row.lifecycleStatus ?? existing.lifecycleStatus,
              contributingAgents: mergedAgents,
              consensusScore: item.row.consensusScore ?? existing.consensusScore,
              consensusThreshold: item.row.consensusThreshold ?? existing.consensusThreshold,
              riskSummary: item.row.riskSummary ?? existing.riskSummary,
              terminalReason: item.row.terminalReason ?? existing.terminalReason,
              orderId: item.row.orderId ?? existing.orderId,
            }).where(eq(transactionTraces.traceId, item.row.traceId));
          }
        }
      }
    } catch (e) {
      console.error('[TracingService] Batch flush failed', e);
      this.queue.unshift(...batch);
    } finally {
      this.flushing = false;
      if (this.queue.length > 0 && !this.flushTimer) {
        this.flushTimer = setTimeout(() => void this.flush(), tracingConfig.batchFlushMs);
      }
    }
  }

  private emitSpan(traceId: string, stage: string, details: Record<string, unknown>): void {
    eventBus.emit(EVENTS.TRACE_SPAN, {
      traceId,
      stage,
      timestamp: new Date().toISOString(),
      ...details,
    });
  }

  private registerEventListeners(): void {
    eventBus.on(EVENTS.TRADE_IDEA_GENERATED, (idea: any) => {
      if (isTelemetryPulsePayload(idea)) return;
      if (!idea?.traceId) return;
      const indicators: Record<string, unknown> = {};
      if (idea.quantDetail?.featureSnapshot) indicators.featureSnapshot = idea.quantDetail.featureSnapshot;
      if (idea.quantDetail?.tradeThesis) indicators.tradeThesis = idea.quantDetail.tradeThesis;
      if (idea.newsDetails) indicators.newsDetails = idea.newsDetails;
      if (idea.indicatorsSnapshot) Object.assign(indicators, idea.indicatorsSnapshot);
      this.logAgentThought({
        traceId: idea.traceId,
        agentName: idea.agent ?? 'UnknownAgent',
        symbol: idea.symbol,
        action: idea.side ?? 'HOLD',
        confidence: typeof idea.confidence === 'number' ? idea.confidence : 0,
        reasoningSummary: String(idea.reasoning ?? ''),
        indicatorsSnapshot: Object.keys(indicators).length > 0 ? indicators : null,
        executionLatencyMs: idea.latencyMs ?? null,
      });
    });

    eventBus.on(EVENTS.RISK_ASSESSMENT_COMPLETED, (assessment: any) => {
      if (isTelemetryPulsePayload(assessment)) return;
      if (!assessment?.traceId) return;
      void this.updateRiskSummary(assessment);
    });

    eventBus.on(EVENTS.ORDER_SUBMITTED, (order: any) => {
      if (!order?.traceId) return;
      this.upsertTrace({
        traceId: order.traceId,
        symbol: order.symbol,
        lifecycleStatus: 'ORDER_SUBMITTED',
        orderId: order.orderId ?? order.id ?? null,
      });
      this.emitSpan(order.traceId, 'ORDER_SUBMITTED', { orderId: order.orderId ?? order.id });
    });

    eventBus.on(EVENTS.ORDER_EXECUTED, (order: any) => {
      if (!order?.traceId) return;
      const status: TraceLifecycleStatus =
        order.status === 'FILLED' ? 'FILLED'
          : (order.status === 'CANCELED' || order.status === 'REJECTED') ? 'CANCELLED'
            : 'ORDER_SUBMITTED';
      this.upsertTrace({
        traceId: order.traceId,
        symbol: order.symbol,
        lifecycleStatus: status,
        orderId: order.orderId ?? order.id ?? null,
        terminalReason: order.status === 'FILLED' ? 'Order filled' : `Order ${order.status}`,
      });
      this.emitSpan(order.traceId, 'ORDER_EXECUTED', { status: order.status });
    });
  }

  private async updateRiskSummary(assessment: any): Promise<void> {
    const traceId = assessment.traceId as string;
    const approved = !!assessment.approved;
    const status: TraceLifecycleStatus = approved ? 'RISK_APPROVED' : 'RISK_REJECTED';
    let passedCount = 0;
    let totalCount = 0;
    let firstFail: string | null = assessment.rejectionGate ?? null;
    try {
      const gates = await db.select().from(riskGateResults).where(eq(riskGateResults.traceId, traceId)).orderBy(asc(riskGateResults.sequence));
      totalCount = gates.length;
      passedCount = gates.filter(g => g.passed).length;
      if (!firstFail) {
        const fail = gates.find(g => !g.passed);
        firstFail = fail?.gateName ?? null;
      }
    } catch {
      // risk rows may lag slightly — summary still updated from assessment payload
    }
    const terminalReason = approved
      ? `Risk approved (${passedCount}/${totalCount || '?'} gates passed)`
      : firstFail
        ? `RISK_GATE_FAIL: ${firstFail}${assessment.reasoning ? ` — ${assessment.reasoning}` : ''}`
        : String(assessment.reasoning ?? 'Risk rejected');
    this.upsertTrace({
      traceId,
      symbol: assessment.symbol,
      lifecycleStatus: status,
      riskSummary: JSON.stringify({
        approved,
        passedGates: passedCount,
        totalGates: totalCount,
        firstFailingGate: firstFail,
      }),
      terminalReason,
    });
    this.logAgentThought({
      traceId,
      agentName: 'RiskAgent',
      symbol: assessment.symbol,
      action: approved ? 'APPROVE' : 'VETO',
      confidence: approved ? 1 : 0,
      reasoningSummary: terminalReason,
      indicatorsSnapshot: { rejectionGate: firstFail, maxQuantity: assessment.maxQuantity },
    });
    this.emitSpan(traceId, 'RISK_ENGINE', { approved, failingGate: firstFail });
  }
}

export const tracingService = new TracingService();

export async function loadAgentThoughts(traceId: string) {
  const rows = await db.select().from(agentReasoningLogs).where(eq(agentReasoningLogs.traceId, traceId)).orderBy(asc(agentReasoningLogs.timestamp));
  return rows.map(r => ({
    agent: r.agentName,
    symbol: r.symbol,
    action: r.action,
    confidence: r.confidence,
    reasoning: r.reasoningSummary,
    timestamp: r.timestamp,
    indicatorsSnapshot: parseJson(r.indicatorsSnapshot, null),
    promptContext: r.promptContext,
    executionLatencyMs: r.executionLatencyMs,
  }));
}

export async function loadTransactionTrace(traceId: string) {
  return db.select().from(transactionTraces).where(eq(transactionTraces.traceId, traceId)).get();
}

export async function loadRiskForTrace(traceId: string) {
  const assessment = await db.select().from(riskAssessments).where(eq(riskAssessments.traceId, traceId)).get();
  if (!assessment) return { assessment: null, gates: [] as Array<{ gateName: string; sequence: number; passed: boolean; detail: unknown }> };
  const gates = await db.select().from(riskGateResults).where(eq(riskGateResults.traceId, traceId)).orderBy(asc(riskGateResults.sequence));
  return {
    assessment,
    gates: gates.map(g => ({
      gateName: g.gateName,
      sequence: g.sequence,
      passed: g.passed,
      detail: parseJson(g.detail, null),
    })),
  };
}
