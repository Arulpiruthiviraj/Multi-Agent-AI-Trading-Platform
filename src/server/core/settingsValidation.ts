/**
 * Value-range validation for the numeric settings fields client-writable via POST /settings and
 * TradingEngine.toggle(). Real bug fixed: SETTINGS_ALLOWED_FIELDS/TOGGLE_ALLOWED_FIELDS only ever
 * allowlisted field *names*, never validated *values* - posting e.g.
 * {"maxPortfolioDrawdownPct": 999} silently disabled the portfolio-drawdown circuit breaker (the
 * gate is just `drawdownPct < maxPortfolioDrawdownPct`), and the same "post an absurd number to
 * defeat a less-than comparison" pattern applies to maxOrdersPerMinute (order_rate_limit) and
 * maxOpenPositions (open_positions_cap). Bounds live in config/tradingSafety.json (reviewed file,
 * not hardcoded here) so tightening/loosening them is a config change, not a code change.
 */
import { tradingSafety } from '../config/tradingSafety';

const BOUNDS: Record<string, { min: number; max: number }> = {
  maxPortfolioDrawdownPct: { min: tradingSafety.settingsBoundMaxPortfolioDrawdownPctMin, max: tradingSafety.settingsBoundMaxPortfolioDrawdownPctMax },
  maxOrdersPerMinute: { min: tradingSafety.settingsBoundMaxOrdersPerMinuteMin, max: tradingSafety.settingsBoundMaxOrdersPerMinuteMax },
  maxOpenPositions: { min: tradingSafety.settingsBoundMaxOpenPositionsMin, max: tradingSafety.settingsBoundMaxOpenPositionsMax },
  dailyLossLimit: { min: tradingSafety.settingsBoundDailyLossLimitMin, max: tradingSafety.settingsBoundDailyLossLimitMax },
  maxTradeSize: { min: tradingSafety.settingsBoundMaxTradeSizeMin, max: tradingSafety.settingsBoundMaxTradeSizeMax },
  percentOfEquityPct: { min: tradingSafety.settingsBoundPercentOfEquityPctMin, max: tradingSafety.settingsBoundPercentOfEquityPctMax },
  minAiConfidence: { min: tradingSafety.settingsBoundMinAiConfidenceMin, max: tradingSafety.settingsBoundMinAiConfidenceMax },
  takeProfitPct: { min: tradingSafety.settingsBoundTakeProfitPctMin, max: tradingSafety.settingsBoundTakeProfitPctMax },
  trailingStopPct: { min: tradingSafety.settingsBoundTrailingStopPctMin, max: tradingSafety.settingsBoundTrailingStopPctMax },
  budget: { min: tradingSafety.settingsBoundBudgetMin, max: tradingSafety.settingsBoundBudgetMax },
};

export type SettingsValidationResult = { ok: true } | { ok: false; error: string };

/** Only checks fields present in `patch` (partial updates never fail on fields they didn't touch)
 * and only fields this module knows a bound for - unrelated allowlisted fields (tradingMode,
 * strategy, riskLevel, ...) are untouched by this validator. */
export function validateSettingsBounds(patch: Record<string, unknown>): SettingsValidationResult {
  for (const [field, bound] of Object.entries(BOUNDS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    const value = patch[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `${field} must be a finite number, got ${JSON.stringify(value)}` };
    }
    if (value < bound.min || value > bound.max) {
      return { ok: false, error: `${field} must be between ${bound.min} and ${bound.max}, got ${value}` };
    }
  }
  return { ok: true };
}
