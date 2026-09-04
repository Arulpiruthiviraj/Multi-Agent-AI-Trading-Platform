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
  // Real gap found by the 2026-08-18 observability program (Phase 15 - "bounded queues"): a
  // sustained SQLite outage re-queues every failed flush batch (see flush()'s catch below) with
  // no ceiling, so this fire-and-forget forensic sink could grow unboundedly and exhaust memory
  // during exactly the kind of outage it should be recording, not the live decision spine (this
  // service is never awaited by RiskEngine/OMS - only its own DB writes are at risk here).
  private droppedSinceLastWarn = 0;

  constructor() {
    this.registerEventListeners();
  }

  /** Test-only. */
  queueLengthForTests(): number {
    return this.queue.length;
  }

  logAgentThought(input: AgentThoughtInput): void {
    if (!input.traceId) return;
    this.logAgentReasoningRow(input);
    this.ensureTraceRow(input.traceId, input.symbol, 'ANALYZING', [input.agentName]);
  }

  /**
   * Writes only the agent_reasoning_logs row (plus its TRACE_SPAN), never touching
   * transaction_traces.lifecycleStatus. Real bug found during the 2026-09-04 missed-opportunity
   * forensic audit: logChiefConsensus() used to call the public logAgentThought() (below) to log
   * ChiefTraderAgent's own synthetic reasoning entry AFTER already writing the real terminal
   * status (CONSENSUS_REACHED/NO_CONSENSUS) via upsertTrace() two lines above it. But
   * logAgentThought() unconditionally calls ensureTraceRow(..., 'ANALYZING', ...) for every
   * agent-reasoning write - including that ChiefTraderAgent one - which silently clobbered the
   * just-written terminal status back to 'ANALYZING' on every single consensus round, live,
   * all day. Confirmed against the running DB: 100% of today's transaction_traces rows for
   * QQQ/SPY read lifecycleStatus='ANALYZING' even though terminalReason correctly showed
   * "[NO TRADE] Confidence X% did not clear 75%." This corrupted a documented decision-trace
   * table (CLAUDE.md section 4's 7-table reconstruction) and fed a real downstream bug in
   * MissedOpportunityDetector.getFunnelSignals(), which used the mere existence of a
   * transaction_traces row (any lifecycleStatus) as its "hadChiefApproval" signal - producing
   * false EXECUTION_MISS classifications ("Approved by both ChiefTrader and RiskEngine, but no
   * fill was ever recorded") for QQQ/SPY today when ChiefTrader had in fact never approved either
   * symbol (zero CHIEF_CONSENSUS_COMPLETED approved=true events, zero risk_assessments rows,
   * zero CHIEF_APPROVED_IDEA events for either symbol all day). Callers that have already set an
   * authoritative terminal status themselves (logChiefConsensus) must use this method instead of
   * the public logAgentThought() for any reasoning entry logged after that point.
   */
  private logAgentReasoningRow(input: AgentThoughtInput): void {
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
    // logAgentReasoningRow(), not logAgentThought() - this must NOT re-touch lifecycleStatus,
    // which was just set to its real terminal value above. See that method's docstring.
    this.logAgentReasoningRow({
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
    if (this.queue.length >= tracingConfig.maxQueueSize) {
      // Drop the oldest pending item, not the new one - forensic recency matters more than
      // completeness during a real outage, and this never blocks or throws for the caller.
      this.queue.shift();
      this.droppedSinceLastWarn++;
      if (this.droppedSinceLastWarn === 1 || this.droppedSinceLastWarn % 500 === 0) {
        console.error(`[TracingService] Queue at maxQueueSize (${tracingConfig.maxQueueSize}) - dropping oldest pending trace rows (${this.droppedSinceLastWarn} dropped so far). This does not affect trading; only forensic trace completeness during this outage.`);
      }
    }
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
      // unshift() bypasses enqueue()'s cap check - re-enforce it here so a sustained outage can
      // never grow the queue past maxQueueSize regardless of which path added items.
      const overflow = this.queue.length - tracingConfig.maxQueueSize;
      if (overflow > 0) {
        this.queue.splice(tracingConfig.maxQueueSize, overflow);
        this.droppedSinceLastWarn += overflow;
      }
    } finally {
      this.flushing = false;
      if (this.queue.length === 0 && this.droppedSinceLastWarn > 0) {
        console.log(`[TracingService] Flush recovered - ${this.droppedSinceLastWarn} trace row(s) were dropped during the outage (forensic gap only, no trading impact).`);
        this.droppedSinceLastWarn = 0;
      }
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
