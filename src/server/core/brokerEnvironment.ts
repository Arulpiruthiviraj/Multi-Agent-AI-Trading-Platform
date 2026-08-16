/**
 * Independent PAPER vs LIVE check. Dual flags (settings.tradingMode vs brokerConnections.paperMode)
 * must not be inferred as LIVE. Ambiguity is FAIL-CLOSED.
 */
export type BrokerEnvironment = 'PAPER' | 'LIVE' | 'UNKNOWN';

function normalizePaperMode(v: unknown): boolean | null {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (v == null) return null;
  return Boolean(v);
}

export function classifyBrokerEnvironment(opts: {
  tradingMode?: string | null;
  paperMode?: boolean | number | null;
}): BrokerEnvironment {
  const mode = String(opts.tradingMode || '').toUpperCase();
  const paper = normalizePaperMode(opts.paperMode);
  if (mode === 'LIVE' && paper === false) return 'LIVE';
  if ((mode === 'PAPER' || mode === '') && paper !== false) return 'PAPER';
  return 'UNKNOWN';
}

export function assertBrokerEnvironmentAllowsOrder(opts: {
  tradingMode?: string | null;
  paperMode?: boolean | number | null;
}): { ok: boolean; environment: BrokerEnvironment; reason: string } {
  const environment = classifyBrokerEnvironment(opts);
  if (environment === 'UNKNOWN') {
    return {
      ok: false,
      environment,
      reason: 'BROKER_ENVIRONMENT_UNKNOWN: settings.tradingMode and broker paperMode disagree or are incomplete. No order.',
    };
  }
  return { ok: true, environment, reason: `environment=${environment}` };
}
