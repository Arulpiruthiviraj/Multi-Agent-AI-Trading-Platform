/**
 * Resolve SIMULATOR | PAPER | LIVE from env for boot / UI preselect.
 * PAPER_TRADING_ONLY=true always demotes LIVE → PAPER (hard safety lock).
 */
export type ArgusTradingMode = 'SIMULATOR' | 'PAPER' | 'LIVE';

export function isPaperTradingOnlyEnforced(): boolean {
  return String(process.env.PAPER_TRADING_ONLY || '').toLowerCase() === 'true';
}

export function normalizeTradingMode(raw: unknown): ArgusTradingMode {
  const s = String(raw || '').trim().toUpperCase();
  if (s === 'SIMULATOR' || s === 'SIM' || s === 'SIMULATION') return 'SIMULATOR';
  if (s === 'LIVE' || s === 'LIVE_TRADING') return 'LIVE';
  if (s === 'PAPER' || s === 'PAPER_TRADING' || s === 'PAPER TRADING') return 'PAPER';
  // Legacy DB default "Paper"
  if (s === 'PAPER' || String(raw || '').trim() === 'Paper') return 'PAPER';
  return 'PAPER';
}

/**
 * Env source of truth for preselect:
 * 1. ARGUS_TRADING_MODE if set (LIVE demoted when PAPER_TRADING_ONLY=true)
 * 2. else default PAPER (caller may prefer DB over this)
 */
export function resolveEnvTradingMode(): {
  mode: ArgusTradingMode;
  source: 'ARGUS_TRADING_MODE' | 'PAPER_TRADING_ONLY' | 'default';
  paperTradingOnly: boolean;
  liveBlockedByEnv: boolean;
} {
  const paperTradingOnly = isPaperTradingOnlyEnforced();
  const raw = process.env.ARGUS_TRADING_MODE;
  let mode: ArgusTradingMode = 'PAPER';
  let source: 'ARGUS_TRADING_MODE' | 'PAPER_TRADING_ONLY' | 'default' = 'default';

  if (raw != null && String(raw).trim() !== '') {
    mode = normalizeTradingMode(raw);
    source = 'ARGUS_TRADING_MODE';
  }

  let liveBlockedByEnv = false;
  if (mode === 'LIVE' && paperTradingOnly) {
    mode = 'PAPER';
    liveBlockedByEnv = true;
    if (source === 'default') source = 'PAPER_TRADING_ONLY';
  }

  return { mode, source, paperTradingOnly, liveBlockedByEnv };
}
