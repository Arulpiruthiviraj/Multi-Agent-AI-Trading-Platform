/**
 * Fail-open EventBus → structured observability bridge.
 * Does not mutate payloads. Does not participate in trading control flow.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { observabilityConfig, type ObservabilityLevel } from '../config/observability';
import { logStructured, observeSafe } from './StructuredLogger';
import { snapshotObservabilityIds } from './ObservabilityContext';
import { incMetric } from './ObservabilityMetrics';
import { redactSecretsDeep } from '../core/SecretRedaction';

let installed = false;
let marketDataSeen = 0;

const SAMPLED_TYPES = new Set(
  Object.entries(observabilityConfig.eventTaxonomy)
    .filter(([, v]) => v.sampled)
    .map(([k]) => k),
);

function taxonomyFor(eventType: string) {
  return observabilityConfig.eventTaxonomy[eventType];
}

function shouldSample(eventType: string): boolean {
  if (!SAMPLED_TYPES.has(eventType) && eventType !== EVENTS.MARKET_DATA && eventType !== EVENTS.MARKET_DATA_UPDATED) {
    return true;
  }
  incMetric('market_data_seen');
  marketDataSeen += 1;
  const n = observabilityConfig.marketDataSampleEveryN;
  if (n <= 0) return false;
  if (marketDataSeen % n === 0) {
    incMetric('market_data_sampled');
    return true;
  }
  return false;
}

function recordDomainMetrics(eventType: string, payload: any): void {
  if (eventType === EVENTS.TRADE_IDEA_GENERATED) incMetric('decisions_seen');
  if (eventType === EVENTS.ORDER_SUBMITTED) incMetric('orders_submitted');
  if (eventType === EVENTS.ORDER_FILLED || (eventType === EVENTS.ORDER_EXECUTED && payload?.status === 'FILLED')) {
    incMetric('orders_filled');
  }
  if (eventType === EVENTS.ORDER_EXECUTED && (payload?.status === 'PENDING' || payload?.status === 'UNKNOWN')) {
    incMetric('orders_unknown');
  }
  if (eventType === EVENTS.RISK_ASSESSMENT_COMPLETED) incMetric('risk_assessments');
  if (eventType === EVENTS.KILL_SWITCH_TRIGGERED) incMetric('kill_switch');
  if (eventType === EVENTS.RECONCILIATION_MISMATCH || eventType === EVENTS.RECONCILIATION_EMERGENCY_HALT) {
    incMetric('reconciliation_mismatch');
  }
}

export function installObservabilityEventBridge(): void {
  if (installed) return;
  installed = true;
  eventBus.on('*', (eventType: string, payload: any) => {
    observeSafe(() => {
      if (typeof eventType !== 'string') return;
      if (eventType === EVENTS.SERVER_LOG || eventType === 'SERVER_LOG') return;
      incMetric('events_emitted');
      if (!shouldSample(eventType)) return;
      const tax = taxonomyFor(eventType);
      const category = tax?.category || 'EVENTBUS';
      const level = (tax?.defaultLevel || 'INFO') as ObservabilityLevel;
      recordDomainMetrics(eventType, payload);
      const ids = snapshotObservabilityIds(payload);
      // Real gap found (2026-09-06/07 post-audit remediation, §21 P2 finding): this fixed field
      // set is trade-idea-shaped, so any event whose real payload uses different field names
      // silently persists as `{}` once every extracted field comes back undefined and
      // JSON.stringify drops them all - confirmed live for AI_PROVIDERS_EXHAUSTED (real fields
      // agentType/lastError/providersAttempted, none of which matched anything below). Added those
      // three narrowly for this diagnosed case rather than reworking the schema for every possible
      // event shape - a broader per-event-type extraction scheme is a larger, separate change.
      //
      // Real gap found (2026-09-10, postmarket-audit follow-up): NewsEngine.ts's NEWS_ANALYZED
      // event uses `symbols` (plural array - an article can mention more than one ticker), not
      // `symbol` - so this column stayed null for every real news-analysis row, confirmed live
      // (the SEI case: a real, correctly-analyzed article about Solaris Energy never surfaced in
      // any symbol-indexed query). Falls back to the array's first entry when a singular `symbol`
      // isn't present - a narrow, honest fix (a multi-symbol article is still indexed under only
      // its first-listed ticker; full multi-symbol indexing would need NewsEngine.ts itself to
      // emit one row per symbol, a larger, separate change) rather than a silent gap.
      const singleSymbol = payload?.symbol ?? (Array.isArray(payload?.symbols) ? payload.symbols[0] : undefined);
      const safePayload = redactSecretsDeep({
        symbol: singleSymbol,
        side: payload?.side,
        status: payload?.status,
        gate: payload?.gate,
        approved: payload?.approved,
        agent: payload?.agent,
        confidence: payload?.confidence,
        orderId: payload?.orderId ?? payload?.id,
        stage: payload?.stage,
        agentType: payload?.agentType,
        lastError: payload?.lastError,
        providersAttempted: payload?.providersAttempted,
      });
      logStructured(level, eventType, {
        category,
        eventType,
        component: 'EventBus',
        symbol: singleSymbol,
        orderId: payload?.orderId ?? payload?.id,
        traceId: ids.traceId ?? undefined,
        decisionId: ids.decisionId ?? undefined,
        correlationId: ids.correlationId ?? undefined,
        payload: safePayload,
      });
    });
  });
}

export function resetObservabilityBridgeForTests(): void {
  marketDataSeen = 0;
}
