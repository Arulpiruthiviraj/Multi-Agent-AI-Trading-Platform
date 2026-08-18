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
      const safePayload = redactSecretsDeep({
        symbol: payload?.symbol,
        side: payload?.side,
        status: payload?.status,
        gate: payload?.gate,
        approved: payload?.approved,
        agent: payload?.agent,
        confidence: payload?.confidence,
        orderId: payload?.orderId ?? payload?.id,
        stage: payload?.stage,
      });
      logStructured(level, eventType, {
        category,
        eventType,
        component: 'EventBus',
        symbol: payload?.symbol,
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
