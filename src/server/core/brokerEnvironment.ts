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
  if (paper === null || (mode !== 'LIVE' && mode !== 'PAPER')) return 'UNKNOWN';
  if (mode === 'LIVE' && paper === false) return 'LIVE';
  if (mode === 'PAPER' && paper === true) return 'PAPER';
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

/**
 * Resolve broker paperMode for OMS authorizeProductionOrder.
 * IBKR Gateway reports both paperTrading and liveTrading capabilities — missing
 * brokerConnections rows must not yield null (BROKER_ENVIRONMENT_UNKNOWN).
 * PAPER_TRADING_ONLY always forces paper. Never infers LIVE from ambiguity.
 */
export function resolveOmsPaperMode(opts: {
  paperTradingOnly?: boolean;
  tradingMode?: string | null;
  storedPaperMode?: boolean | number | null;
  capabilities?: { paperTrading?: boolean; liveTrading?: boolean } | null;
  brokerId?: string | null;
}): boolean | null {
  if (opts.paperTradingOnly === true) return true;

  const stored = normalizePaperMode(opts.storedPaperMode);
  if (stored !== null) return stored;

  const mode = String(opts.tradingMode || '').toUpperCase();
  const caps = opts.capabilities;
  const paperCapable = caps?.paperTrading === true;
  const liveOnly = caps?.paperTrading === false && caps?.liveTrading === true;

  if (mode === 'PAPER' && paperCapable) return true;
  if (paperCapable && caps?.liveTrading === false) return true;

  // Dual-capable adapters (IBKR) with Paper settings and no stored row → PAPER.
  if (mode === 'PAPER' && paperCapable && caps?.liveTrading === true) return true;

  // Known paper-first ids when settings say Paper.
  const id = String(opts.brokerId || '');
  if (mode === 'PAPER' && (id === 'ibkr_gateway' || id === 'ibkr_web' || id === 'internal_paper')) {
    return true;
  }

  if (liveOnly && mode === 'LIVE') return false;
  return null;
}

