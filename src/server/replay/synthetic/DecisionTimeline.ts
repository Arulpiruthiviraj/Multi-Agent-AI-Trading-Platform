/**
 * Synthetic Market Session Simulator (2026-09-14 mandate), Phase 9: behavioral timeline / decision
 * trace. Subscribes to the REAL EventBus (the same production event stream every other observer
 * consumes - never a parallel/private channel) and records a chronological, simulated-time-stamped
 * log of everything the real pipeline actually did. This is read-only observation - it never
 * mutates payloads, never re-emits, never influences the pipeline.
 */
import { eventBus } from '../../core/EventBus';
import type { SyntheticMarketClock } from '../SyntheticMarketClock';

const TRACKED_EVENTS = [
  'MARKET_DATA', 'TRADE_IDEA_GENERATED', 'TRADE_IDEA_REJECTED', 'IDEA_RATE_LIMITED',
  'CHIEF_CONSENSUS_STARTED', 'CHIEF_CONSENSUS_COMPLETED', 'TRADE_REJECTED_CONSENSUS', 'CHIEF_APPROVED_IDEA',
  'RISK_ASSESSMENT_STARTED', 'RISK_ASSESSMENT_COMPLETED', 'RISK_BLOCK', 'RISK_GATE_EVALUATED',
  'ORDER_SUBMITTED', 'ORDER_ACCEPTED', 'ORDER_FILLED', 'ORDER_EXECUTED',
  'DESK_NO_TRADE', 'CANDIDATE_REJECTED', 'ASSET_CANDIDATE_BLOCKED',
] as const;

export interface TimelineEntry {
  seq: number;
  simulatedTimeMs: number;
  simulatedTimeIso: string;
  eventType: string;
  symbol: string | null;
  traceId: string | null;
  side: string | null;
  reason: string | null;
  /** Trimmed, JSON-safe subset of the raw payload - excludes any large/irrelevant fields, never
   *  chain-of-thought (same "safe fields" contract as the real decision-trace export -
   *  queryTraces.ts - uses: side, confidence, EV, reason codes, never raw prompts). */
  summary: Record<string, unknown>;
}

function safeSummary(payload: any): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const {
    confidence, agent, outcome, approved, gate, passed, quantity, price,
    orderId, transactionId, maxQuantity, reasons, netExpectedReturn,
  } = payload;
  const out: Record<string, unknown> = {};
  if (confidence !== undefined) out.confidence = confidence;
  if (agent !== undefined) out.agent = agent;
  if (outcome !== undefined) out.outcome = outcome;
  if (approved !== undefined) out.approved = approved;
  if (gate !== undefined) out.gate = gate;
  if (passed !== undefined) out.passed = passed;
  if (quantity !== undefined) out.quantity = quantity;
  if (price !== undefined) out.price = price;
  if (orderId !== undefined) out.orderId = orderId;
  if (transactionId !== undefined) out.transactionId = transactionId;
  if (maxQuantity !== undefined) out.maxQuantity = maxQuantity;
  if (reasons !== undefined) out.reasons = reasons;
  if (netExpectedReturn !== undefined) out.netExpectedReturn = netExpectedReturn;
  return out;
}

export class DecisionTimeline {
  private entries: TimelineEntry[] = [];
  private seq = 0;
  private handler: ((payload: any) => void) | null = null;
  private running = false;

  constructor(private readonly clock: SyntheticMarketClock) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.handler = (payload: any) => {
      // The wildcard listener receives (eventName, payload) via EventBus's own '*' convention -
      // but subscribing per-event-type below is simpler/safer than parsing wildcard args, so this
      // handler is bound per event type instead (see the loop below).
    };
    for (const eventType of TRACKED_EVENTS) {
      const boundHandler = (payload: any) => this.record(eventType, payload);
      (this as any)[`__h_${eventType}`] = boundHandler;
      eventBus.subscribe(eventType, boundHandler);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const eventType of TRACKED_EVENTS) {
      const boundHandler = (this as any)[`__h_${eventType}`];
      if (boundHandler) eventBus.unsubscribe(eventType, boundHandler);
    }
  }

  private record(eventType: string, payload: any): void {
    this.seq += 1;
    const simMs = this.clock.now();
    this.entries.push({
      seq: this.seq,
      simulatedTimeMs: simMs,
      simulatedTimeIso: new Date(simMs).toISOString(),
      eventType,
      symbol: (payload?.symbol as string) ?? null,
      traceId: (payload?.traceId as string) ?? (payload?.decisionId as string) ?? null,
      side: (payload?.side as string) ?? null,
      reason: (payload?.reason as string) ?? (payload?.reasoning as string) ?? null,
      summary: safeSummary(payload),
    });
  }

  getEntries(): readonly TimelineEntry[] {
    return this.entries;
  }

  getEntriesForSymbol(symbol: string): TimelineEntry[] {
    return this.entries.filter((e) => e.symbol === symbol);
  }

  getEntriesForTraceId(traceId: string): TimelineEntry[] {
    return this.entries.filter((e) => e.traceId === traceId);
  }

  /** Human-readable rendering, roughly matching the mandate's section 18 example format. */
  render(): string {
    return renderTimeline(this.entries);
  }
}

/** Standalone rendering helper, usable against any TimelineEntry[] (e.g. a
 *  SyntheticSessionResult.timeline returned after the recording DecisionTimeline instance has
 *  already gone out of scope) without needing a live DecisionTimeline instance. */
export function renderTimeline(entries: readonly TimelineEntry[]): string {
  return entries.map((e) => {
    const time = new Date(e.simulatedTimeMs).toISOString().slice(11, 19);
    const sym = e.symbol ? ` ${e.symbol}` : '';
    const reasonStr = e.reason ? ` reason=${e.reason}` : '';
    return `${time} ${e.eventType}${sym}${reasonStr}`;
  }).join('\n');
}
