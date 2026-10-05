/**
 * Fast Opportunity Lane — feature flag and configuration.
 *
 * 2026-10-05: The fast lane is PAPER/research only. It must never be enabled
 * for LIVE execution without formal promotion. The flag defaults to false,
 * and enabling it for LIVE fails closed.
 */

const FLAG_NAME = 'FAST_OPPORTUNITY_LANE_ENABLED';

/**
 * Returns true only if the fast lane is explicitly enabled AND we are not
 * in LIVE trading mode. LIVE + fast lane = fail closed (returns false).
 */
export function isFastLaneEnabled(): boolean {
  const raw = process.env[FLAG_NAME];
  if (raw !== 'true') return false;
  // Fail closed: never enable fast lane for LIVE, even if flag is set.
  const tradingMode = process.env.TRADING_MODE || process.env.ARGUS_TRADING_MODE;
  if (tradingMode === 'LIVE') {
    console.error('[FastLane] FAST_OPPORTUNITY_LANE_ENABLED=true but TRADING_MODE=LIVE — refusing to enable (fail closed).');
    return false;
  }
  return true;
}

export function fastLaneFlagName(): string {
  return FLAG_NAME;
}
