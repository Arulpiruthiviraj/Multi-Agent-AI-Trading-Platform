/**
 * In-memory event tracing + durable persistence for the agent pipeline.
 *
 * Wraps every tracked EventBus event in a typed envelope (eventId, schemaVersion,
 * correlationId, source, timestamp) and keeps two views: a capped recent-events
 * ring buffer, and a per-correlationId trace map used by ExplainabilityAgent and
 * the /system/trace/:traceId route. Both are in-memory only and lost on restart,
 * so every envelope is also fire-and-forget persisted to the `event_traces` table
 * (previously dead - GET /api/v1/system/event-traces always returned [] because
 * nothing ever wrote to it) for durable, restart-safe replay.
 */
import { eventBus } from './EventBus';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import * as schema from '../db/schema';
import { PERSISTED_EVENTS, EVENTS } from './eventNames';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { redactSecretsDeep } from './SecretRedaction';

export interface EventEnvelope {
  eventId: string;
  schemaVersion: number;
  correlationId: string | null;
  source: string;
  type: string;
  timestamp: number;
  payload: any;
}

const SCHEMA_VERSION = runtimeIntervals.eventStoreSchemaVersion;
const MAX_RECENT_EVENTS = runtimeIntervals.eventStoreMaxRecentEvents;
const MAX_TRACES = runtimeIntervals.eventStoreMaxTraces;

export const recentEvents: EventEnvelope[] = [];
export const tradeTraces: Record<string, EventEnvelope[]> = {};
const traceInsertionOrder: string[] = [];

function evictOldTraces() {
  while (traceInsertionOrder.length > MAX_TRACES) {
    const oldest = traceInsertionOrder.shift();
    if (oldest) delete tradeTraces[oldest];
  }
}

// MARKET_DATA and CALCULATION_COMPLETED fire on every price tick per watched symbol -
// many times per second under live market data. Kept in the in-memory buffers below
// (bounded, same as before) but never written to SQLite, or the event_traces table
// would grow unbounded and add write load to every tick. Only the actual decision-
// lifecycle events (one per trade idea, not per tick) are durably persisted.
const NO_PERSIST_TYPES = new Set([EVENTS.MARKET_DATA, EVENTS.CALCULATION_COMPLETED]);

const trackEvent = (type: string) => (payload: any) => {
  // Digital Twin telemetry pulse — keep in-memory ring for live UI, skip SQLite pollution.
  const skipPersist = !!(payload?.telemetryPulse || payload?.diagnosticTelemetry
    || String(payload?.traceId || '').startsWith('telemetry-pulse-'));
  const correlationId: string | null = payload?.traceId || payload?.trace_id || payload?.correlationId || null;
  const transactionId: string | null = payload?.transactionId ?? null;
  // Real bug found and fixed this pass: this envelope's payload used to be stored/persisted
  // completely raw. queryTraces.ts's getDecisionTrace() redacts on its own read path, but three
  // other live routes (GET /api/v1/system/event-traces, GET /api/v2/system/events,
  // GET /api/v2/system/trace/:traceId) and their in-memory fallbacks (recentEvents, tradeTraces)
  // read this same data and served it verbatim - any secret that ever landed in an EventBus
  // payload (e.g. an upstream fetch error string embedding a query-string API key) was persisted
  // in cleartext and served to any caller of those endpoints. Redacting once here, at write time,
  // protects every current and future read path uniformly instead of relying on each one to
  // remember to redact independently.
  const redactedPayload = redactSecretsDeep(payload);
  const envelope: EventEnvelope = {
    eventId: uuidv4(),
    schemaVersion: SCHEMA_VERSION,
    correlationId,
    source: payload?.agent || payload?.source || type,
    type,
    timestamp: Date.now(),
    payload: redactedPayload,
  };

  recentEvents.unshift(envelope);
  if (recentEvents.length > MAX_RECENT_EVENTS) recentEvents.pop();

  if (correlationId) {
    if (!tradeTraces[correlationId]) {
      tradeTraces[correlationId] = [];
      traceInsertionOrder.push(correlationId);
      evictOldTraces();
    }
    tradeTraces[correlationId].push(envelope);
  }

  if (!NO_PERSIST_TYPES.has(type) && !skipPersist) {
    db.insert(schema.eventTraces).values({
      id: envelope.eventId,
      correlationId,
      transactionId,
      timestamp: envelope.timestamp,
      source: envelope.source,
      eventType: type,
      payload: JSON.stringify(redactedPayload),
    }).catch((e) => console.error('[EventStore] Failed to persist event trace', e));
  }

  if (!skipPersist && (type === EVENTS.TRADE_LIFECYCLE || type === EVENTS.DESK_NO_TRADE)) {
    const candidateId = correlationId || envelope.eventId;
    const state = type === EVENTS.DESK_NO_TRADE ? (payload?.code || 'NO_TRADE') : (payload?.state || 'UNKNOWN');
    import('./TradeLifecycleStore').then(({ persistLifecycleTransition }) => {
      persistLifecycleTransition({
        candidateId,
        symbol: payload?.symbol || 'UNKNOWN',
        state: String(state),
        reason: payload?.reason ?? payload?.code ?? null,
        source: envelope.source,
        evidence: { type, payload: redactedPayload },
      });
    }).catch((e) => console.error('[EventStore] lifecycle persist failed', e));
  }
};

for (const type of PERSISTED_EVENTS) {
  eventBus.on(type, trackEvent(type));
}
