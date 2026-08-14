/**
 * ==========================================================
 * Module: RestrictedLiveMode
 *
 * Purpose:
 * Phase 13 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md). Real, hardcoded ceilings that apply
 * automatically whenever real live trading is active (`tradingEngine.state.tradingMode ===
 * 'LIVE'`) - independent of whatever `settings` row currently says, and independent of any AI
 * agent's stated confidence. Deliberately NOT a new parallel risk system: RiskEngine.ts's own
 * existing sizing math and gate ladder are reused unmodified - this module only ever CLAMPS the
 * settings-derived inputs RiskEngine already reads DOWN toward these hardcoded floors, never up,
 * and never bypasses any existing gate.
 *
 * The real problem this closes: today, `settings.maxTradeSize`/`maxOpenPositions`/
 * `dailyLossLimit` are the ONLY caps on real order size, open-position count, and daily loss for a
 * LIVE account - if that settings row were ever misconfigured (or a compromised/buggy write
 * happened), there was no independent hard floor beneath it. An AI agent stating "confidence 99%"
 * was already structurally unable to bypass RiskEngine (verified, ARGUS_SAFETY_HARDENING_REPORT.md)
 * - this module additionally makes sure a misconfigured settings VALUE can't either, for real
 * money specifically.
 * ==========================================================
 */

// Deliberately conservative, hardcoded values - not read from settings, not configurable via any
// API route. Changing them requires a real code change and code review, by design.
export const RESTRICTED_LIVE_MAX_ORDER_NOTIONAL_DOLLARS = 5000;
export const RESTRICTED_LIVE_MAX_OPEN_POSITIONS = 3;
export const RESTRICTED_LIVE_MAX_DAILY_LOSS_DOLLARS = 1000;

export function isRestrictedLiveModeActive(tradingMode: string | undefined | null): boolean {
  return tradingMode === 'LIVE';
}

/** Never loosens a real settings-derived value - only clamps it down toward the hardcoded ceiling
 *  when restricted live mode is active. Paper trading (or any tradingMode !== 'LIVE') is
 *  completely unaffected - this function is the identity function in that case. */
export function applyRestrictedLiveCaps(input: {
  tradingMode: string | undefined | null;
  maxTradeSizeDollar: number;
  maxOpenPositions: number;
  dailyLossLimitDollars: number;
}): { maxTradeSizeDollar: number; maxOpenPositions: number; dailyLossLimitDollars: number; restricted: boolean } {
  if (!isRestrictedLiveModeActive(input.tradingMode)) {
    return {
      maxTradeSizeDollar: input.maxTradeSizeDollar,
      maxOpenPositions: input.maxOpenPositions,
      dailyLossLimitDollars: input.dailyLossLimitDollars,
      restricted: false,
    };
  }
  return {
    maxTradeSizeDollar: Math.min(input.maxTradeSizeDollar, RESTRICTED_LIVE_MAX_ORDER_NOTIONAL_DOLLARS),
    maxOpenPositions: Math.min(input.maxOpenPositions, RESTRICTED_LIVE_MAX_OPEN_POSITIONS),
    dailyLossLimitDollars: Math.min(input.dailyLossLimitDollars, RESTRICTED_LIVE_MAX_DAILY_LOSS_DOLLARS),
    restricted: true,
  };
}
