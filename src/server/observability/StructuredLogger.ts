/**
 * Central structured JSON logger. Fail-open: never throws to callers.
 * Safety categories are clamped to ≥ safetyMinLevel from config/observability.json.
 */
import { randomUUID } from 'crypto';
import { observabilityConfig, LEVEL_RANK, type ObservabilityLevel } from '../config/observability';
import { redactSecrets, redactSecretsDeep } from '../core/SecretRedaction';
import { snapshotObservabilityIds } from './ObservabilityContext';
import { enqueueObservabilityEvent } from './ObservabilityStore';
import { incMetric, recordObservabilityFailure, recordObservabilitySuccess } from './ObservabilityMetrics';

export interface StructuredLogFields {
  category?: string;
  eventType?: string;
  component?: string;
  symbol?: string;
  orderId?: string;
  traceId?: string;
  decisionId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

const SAFETY = new Set(observabilityConfig.safetyCategories);

function clampLevel(level: ObservabilityLevel, category?: string): ObservabilityLevel {
  if (category && SAFETY.has(category) && LEVEL_RANK[level] < LEVEL_RANK[observabilityConfig.safetyMinLevel]) {
    return observabilityConfig.safetyMinLevel;
  }
  return level;
}

function truncateJson(value: unknown): string | null {
  try {
    const redacted = redactSecretsDeep(value);
    let s = JSON.stringify(redacted);
    if (s.length > observabilityConfig.maxPayloadChars) {
      s = s.slice(0, observabilityConfig.maxPayloadChars) + '…';
    }
    return s;
  } catch {
    return null;
  }
}

function writeLine(record: Record<string, unknown>): void {
  try {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  } catch {
    try {
      console.error('[StructuredLogger] stdout write failed');
    } catch {
      /* last resort: swallow */
    }
  }
}

export function logStructured(level: ObservabilityLevel, message: string, fields: StructuredLogFields = {}): void {
  try {
    const category = typeof fields.category === 'string' ? fields.category : 'SYSTEM';
    const effective = clampLevel(level, category);
    const ids = snapshotObservabilityIds({
      traceId: fields.traceId,
      decisionId: fields.decisionId,
      correlationId: fields.correlationId,
    });
    const { category: _c, eventType, component, symbol, orderId, traceId, decisionId, correlationId, ...rest } = fields;
    const payloadObj = Object.keys(rest).length > 0 ? rest : undefined;
    const payloadStr = payloadObj ? truncateJson(payloadObj) : null;
    const msg = redactSecrets(String(message ?? ''));
    if (msg !== String(message ?? '')) incMetric('logs_redacted');

    const record = {
      ts: new Date().toISOString(),
      level: effective,
      logger: component || 'argus',
      msg,
      sessionId: ids.sessionId,
      correlationId: correlationId || ids.correlationId,
      decisionId: decisionId || ids.decisionId,
      traceId: traceId || ids.traceId,
      category,
      eventType: eventType ?? null,
      symbol: symbol ?? null,
      orderId: orderId ?? null,
      component: component ?? null,
    };

    incMetric('logs_emitted');
    if (LEVEL_RANK[effective] >= LEVEL_RANK[observabilityConfig.consoleMinLevel]) {
      writeLine(record);
    }
    if (LEVEL_RANK[effective] >= LEVEL_RANK[observabilityConfig.persistMinLevel]) {
      enqueueObservabilityEvent({
        id: randomUUID(),
        ts: Date.now(),
        level: effective,
        category,
        eventType: eventType ?? null,
        loggerName: record.logger,
        message: msg,
        sessionId: ids.sessionId,
        correlationId: (correlationId || ids.correlationId) ?? null,
        decisionId: (decisionId || ids.decisionId) ?? null,
        traceId: (traceId || ids.traceId) ?? null,
        orderId: (typeof orderId === 'string' ? orderId : null),
        symbol: (typeof symbol === 'string' ? symbol : null),
        component: (typeof component === 'string' ? component : null),
        payload: payloadStr,
      });
    }
    recordObservabilitySuccess(eventType ?? 'UNTAGGED');
  } catch (e) {
    incMetric('logger_errors');
    recordObservabilityFailure((fields.eventType as string | undefined) ?? 'UNTAGGED', e instanceof Error ? e.name : 'UNKNOWN_ERROR');
  }
}

export const structuredLogger = {
  trace: (msg: string, fields?: StructuredLogFields) => logStructured('TRACE', msg, fields),
  debug: (msg: string, fields?: StructuredLogFields) => logStructured('DEBUG', msg, fields),
  info: (msg: string, fields?: StructuredLogFields) => logStructured('INFO', msg, fields),
  warn: (msg: string, fields?: StructuredLogFields) => logStructured('WARN', msg, fields),
  error: (msg: string, fields?: StructuredLogFields) => logStructured('ERROR', msg, fields),
  fatal: (msg: string, fields?: StructuredLogFields) => logStructured('FATAL', msg, fields),
};

/** Fail-open wrapper for instrumentation sites on the live path.
 *
 *  2026-10-06 (October 5 forensic follow-up, Phase 2): this swallow-and-continue behavior is
 *  deliberately unchanged - a callback failure here must never affect the real decision it
 *  wraps. What changed: the failure's timestamp/type is now also recorded
 *  (recordObservabilityFailure()), so a callback that has been throwing on every call since some
 *  point in the past (exactly the cycleId TDZ bug's real shape) becomes visible via
 *  getObservabilityHealth()'s `degraded` flag, instead of only ever showing up as an
 *  undifferentiated increment in the cumulative logger_errors counter. */
export function observeSafe(fn: () => void, tag = 'UNTAGGED'): void {
  try {
    fn();
    recordObservabilitySuccess(tag);
  } catch (e) {
    incMetric('logger_errors');
    recordObservabilityFailure(tag, e instanceof Error ? e.name : 'UNKNOWN_ERROR');
  }
}
