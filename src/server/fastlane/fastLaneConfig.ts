/**
 * Fast Opportunity Lane — feature flag and configuration.
 *
 * 2026-10-05: The fast lane is PAPER/research only. It must never be enabled
 * for LIVE execution without formal promotion. The flag defaults to false,
 * and enabling it for LIVE fails closed.
 */

import { resolveEnvTradingMode } from '../core/tradingModeEnv';

const FLAG_NAME = 'FAST_OPPORTUNITY_LANE_ENABLED';

/**
 * Returns true only if the fast lane is explicitly enabled AND we are not
 * in LIVE trading mode. LIVE + fast lane = fail closed (returns false).
 *
 * 2026-10-08 (D7): consults the canonical env trading-mode resolver (tradingModeEnv.ts)
 * instead of reading raw TRADING_MODE/ARGUS_TRADING_MODE env vars directly - the resolver
 * is the one place that also applies the PAPER_TRADING_ONLY hard demotion of LIVE.
 */
export function isFastLaneEnabled(): boolean {
  const raw = process.env[FLAG_NAME];
  if (raw !== 'true') return false;
  // Fail closed: never enable fast lane for LIVE, even if flag is set.
  const { mode } = resolveEnvTradingMode();
  if (mode === 'LIVE') {
    console.error('[FastLane] FAST_OPPORTUNITY_LANE_ENABLED=true but resolved trading mode is LIVE — refusing to enable (fail closed).');
    return false;
  }
  return true;
}

export function fastLaneFlagName(): string {
  return FLAG_NAME;
}
