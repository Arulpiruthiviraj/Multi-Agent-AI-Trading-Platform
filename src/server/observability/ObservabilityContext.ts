/**
 * Decision correlation via AsyncLocalStorage.
 * decisionId === existing EventBus traceId. Never mint a second unrelated id for the same decision.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { observabilityConfig } from '../config/observability';

export interface ObservabilityContext {
  sessionId: string;
  /** Same as decisionId / traceId when on a decision; optional for process-level events. */
  correlationId?: string;
  /** Canonical decision id = existing traceId. */
  decisionId?: string;
  symbol?: string;
  orderId?: string;
  component?: string;
}

const als = new AsyncLocalStorage<ObservabilityContext>();
const SESSION_ID = `${observabilityConfig.sessionIdPrefix}_${randomUUID()}`;

export function getSessionId(): string {
  return SESSION_ID;
}

export function getObservabilityContext(): ObservabilityContext | undefined {
  return als.getStore();
}

export function resolveDecisionId(payload?: { traceId?: unknown; decisionId?: unknown; trace_id?: unknown } | null): string | undefined {
  const fromPayload =
    (typeof payload?.traceId === 'string' && payload.traceId) ||
    (typeof payload?.decisionId === 'string' && payload.decisionId) ||
    (typeof payload?.trace_id === 'string' && payload.trace_id) ||
    undefined;
  if (fromPayload) return fromPayload;
  const ctx = als.getStore();
  return ctx?.decisionId;
}

/**
 * Bind ALS for the duration of fn. Merges with parent store.
 * sessionId is always the process session — never overwritten.
 */
export function runWithObservabilityContext<T>(partial: Partial<ObservabilityContext>, fn: () => T): T {
  const parent = als.getStore();
  const decisionId = partial.decisionId || parent?.decisionId;
  const next: ObservabilityContext = {
    sessionId: SESSION_ID,
    correlationId: partial.correlationId || decisionId || parent?.correlationId,
    decisionId,
    symbol: partial.symbol || parent?.symbol,
    orderId: partial.orderId || parent?.orderId,
    component: partial.component || parent?.component,
  };
  return als.run(next, fn);
}

/** Build a listener/dispatch store from an EventBus payload without inventing ids. */
export function contextFromEventPayload(payload: any, parent?: ObservabilityContext): ObservabilityContext {
  const decisionId = resolveDecisionId(payload) || parent?.decisionId;
  const orderId =
    (typeof payload?.orderId === 'string' && payload.orderId) ||
    (typeof payload?.id === 'string' && payload.id) ||
    parent?.orderId;
  const symbol = (typeof payload?.symbol === 'string' && payload.symbol) || parent?.symbol;
  const correlationId =
    (typeof payload?.correlationId === 'string' && payload.correlationId) ||
    decisionId ||
    parent?.correlationId;
  return {
    sessionId: SESSION_ID,
    correlationId,
    decisionId,
    symbol,
    orderId,
    component: parent?.component,
  };
}

export function snapshotObservabilityIds(payload?: any): {
  sessionId: string;
  correlationId: string | null;
  decisionId: string | null;
  traceId: string | null;
} {
  const ctx = als.getStore();
  const decisionId = resolveDecisionId(payload) || ctx?.decisionId || null;
  return {
    sessionId: SESSION_ID,
    correlationId: (typeof payload?.correlationId === 'string' && payload.correlationId) || ctx?.correlationId || decisionId,
    decisionId,
    traceId: decisionId,
  };
}
