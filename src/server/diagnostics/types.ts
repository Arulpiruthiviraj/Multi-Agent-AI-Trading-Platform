/** Shared explainable-error shape. Facts must come from the live system, never placeholders. */
export type DiagnosticSeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

export type DiagnosticComponent =
  | 'BROKER' | 'MARKET_DATA' | 'NEWS' | 'TECHNICAL' | 'QUANT'
  | 'CHRONOS' | 'KRONOS' | 'OPENALICE' | 'OLLAMA'
  | 'FUNDAMENTAL' | 'MACRO' | 'CHIEF_TRADER' | 'RISK_ENGINE' | 'PORTFOLIO'
  | 'DATABASE' | 'BACKTEST' | 'WEBSOCKET' | 'SYSTEM' | 'CAPITAL' | 'AI_ROUTER';

export type DiagnosticStatus =
  | 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'MISCONFIGURED' | 'INITIALIZING'
  | 'TIMEOUT' | 'AUTHENTICATION_FAILED' | 'RATE_LIMITED' | 'DATA_STALE'
  | 'DATA_MISSING' | 'SERVICE_CRASHED' | 'EMPTY_RESULT' | 'OPTIONAL_DISABLED';

export interface DiagnosticMessage {
  id: string;
  code: string;
  timestamp: string;
  severity: DiagnosticSeverity;
  component: DiagnosticComponent;
  status: DiagnosticStatus;
  title: string;
  userMessage: string;
  technicalMessage: string;
  cause: string;
  impact: string;
  tradingImpact: string;
  tradingBlocked: boolean;
  canContinueSafely: boolean;
  recommendedFix: string;
  troubleshootingSteps: string[];
  documentationReference: string | null;
  retryable: boolean;
  autoRecoveryAvailable: boolean;
  autoRecoveryStatus: string | null;
  relatedEvents: string[];
  facts: Record<string, string | number | boolean | null>;
}

export interface CatalogEntry {
  code: string;
  component: DiagnosticComponent;
  severity: DiagnosticSeverity;
  status: DiagnosticStatus;
  title: string;
  userMessage: string;
  cause: string;
  impact: string;
  tradingImpact: string;
  tradingBlocked: boolean;
  canContinueSafely: boolean;
  recommendedFix: string;
  troubleshootingSteps: string[];
  documentationReference: string | null;
  retryable: boolean;
  autoRecoveryAvailable: boolean;
}

export function interpolate(template: string, facts: Record<string, string | number | boolean | null>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const v = facts[key];
    if (v === undefined || v === null || v === '') return '(not reported by the underlying system)';
    return String(v);
  });
}
