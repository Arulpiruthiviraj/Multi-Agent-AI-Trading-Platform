import { v4 as uuidv4 } from 'uuid';
import { DIAGNOSTIC_CATALOG } from './catalog';
import { interpolate, type DiagnosticMessage } from './types';

export function buildDiagnostic(
  code: string,
  facts: Record<string, string | number | boolean | null> = {},
  overrides: Partial<DiagnosticMessage> = {},
): DiagnosticMessage {
  const entry = DIAGNOSTIC_CATALOG[code];
  if (!entry) {
    throw new Error(`Unknown diagnostic code ${code}`);
  }
  const base: DiagnosticMessage = {
    id: uuidv4(),
    code: entry.code,
    timestamp: new Date().toISOString(),
    severity: entry.severity,
    component: entry.component,
    status: entry.status,
    title: interpolate(entry.title, facts),
    userMessage: interpolate(entry.userMessage, facts),
    technicalMessage: String(facts.technicalMessage ?? facts.detail ?? facts.cause ?? ''),
    cause: interpolate(entry.cause, facts),
    impact: interpolate(entry.impact, facts),
    tradingImpact: interpolate(entry.tradingImpact, facts),
    tradingBlocked: entry.tradingBlocked,
    canContinueSafely: entry.canContinueSafely,
    recommendedFix: interpolate(entry.recommendedFix, facts),
    troubleshootingSteps: entry.troubleshootingSteps.map(s => interpolate(s, facts)),
    documentationReference: entry.documentationReference,
    retryable: entry.retryable,
    autoRecoveryAvailable: entry.autoRecoveryAvailable,
    autoRecoveryStatus: facts.autoRecoveryStatus != null ? String(facts.autoRecoveryStatus) : null,
    relatedEvents: [],
    facts,
  };
  return { ...base, ...overrides, facts: { ...base.facts, ...(overrides.facts || {}) } };
}

export function diagnosticFromBacktestError(message: string): DiagnosticMessage {
  if (/CORPORATE_ACTION_DETECTED/i.test(message)) {
    return buildDiagnostic('BT-002', { detail: message });
  }
  if (/real bars available|need at least/i.test(message)) {
    return buildDiagnostic('BT-001', { detail: message });
  }
  return buildDiagnostic('BT-001', { detail: message, technicalMessage: message });
}
