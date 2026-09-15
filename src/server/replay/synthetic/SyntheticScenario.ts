/**
 * Synthetic Market Session Simulator (2026-09-14 mandate), Phase 8: scenario profiles.
 *
 * A scenario is a deterministic sequence of regime "segments" (each with a drift/volatility/volume
 * multiplier, active over a simulated-time window) plus a list of discrete events (a gap, a news
 * shock, a data interruption) fired once at a specific simulated offset. The market-data engine and
 * news generator both read the SAME scenario object, so "what happens" is defined once, not
 * duplicated across the price path and the news feed.
 *
 * Only a representative subset of the mandate's 15 named scenarios is implemented this pass
 * (documented per-scenario below) - the framework itself (RegimeSegment[] + ScenarioEvent[]) is
 * general enough that the remaining ones are new data, not new engine code, when built later.
 */

export type RegimeLabel = 'TRENDING_UP' | 'TRENDING_DOWN' | 'SIDEWAYS' | 'HIGH_VOL' | 'LOW_VOL';

export interface RegimeSegment {
  /** Simulated-time offset from session start, ms, inclusive. */
  fromOffsetMs: number;
  /** Simulated-time offset from session start, ms, exclusive. */
  toOffsetMs: number;
  regime: RegimeLabel;
  /** Mean log-return per 1-minute bar - the deterministic "drift" a trending regime needs to be
   *  distinguishable from noise. Signed: positive = up, negative = down. */
  driftPerBarMean: number;
  /** Multiplies the symbol's base per-bar volatility (stdev of log-returns). 1.0 = baseline. */
  volatilityMultiplier: number;
  /** Multiplies the symbol's base per-bar volume. 1.0 = baseline. */
  volumeMultiplier: number;
}

export type ScenarioEventType = 'GAP' | 'NEWS_SHOCK' | 'VOLATILITY_SPIKE' | 'DATA_INTERRUPTION';

export interface ScenarioEvent {
  type: ScenarioEventType;
  /** Simulated-time offset from session start, ms. */
  atOffsetMs: number;
  /** Symbols this event applies to. Empty/omitted = every symbol in the universe. */
  symbols?: string[];
  /** GAP: signed fractional jump applied instantaneously to the next bar's open (e.g. -0.03 = -3%). */
  gapPct?: number;
  /** NEWS_SHOCK: direction + magnitude for the synthetic news generator (see SyntheticNewsGenerator.ts). */
  newsDirection?: 'POSITIVE' | 'NEGATIVE';
  newsMagnitude?: 'HIGH_IMPACT' | 'LOW_IMPACT';
  /** VOLATILITY_SPIKE: temporary multiplier and how many bars it lasts. */
  volatilityMultiplier?: number;
  durationBars?: number;
  /** DATA_INTERRUPTION: how many bars of missing data to produce for the affected symbols. */
  interruptionBars?: number;
}

export interface ScenarioProfile {
  id: string;
  description: string;
  /** Whether this scenario is EXPECTED (not required) to contain a legitimate, recognizable
   *  opportunity for the currently-implemented CORE strategies - informational only, never fed
   *  into the pipeline; the real decision must still emerge from the real agents/RiskEngine. */
  expectedToBeTradeable: boolean;
  segments: RegimeSegment[];
  events: ScenarioEvent[];
}

const MIN = 60_000;

/** SCENARIO 1 - QUIET OPEN. Low volatility, no drift, no events. A valid, expected outcome is
 *  zero trades - this is the mandate's own Test A (no-trade safety) candidate scenario. */
export const QUIET_OPEN: ScenarioProfile = {
  id: 'QUIET_OPEN',
  description: 'Low volatility, no persistent drift, no news. Few or zero opportunities is the correct, expected result.',
  expectedToBeTradeable: false,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 90 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0, volatilityMultiplier: 0.5, volumeMultiplier: 0.8 },
  ],
  events: [],
};

/** SCENARIO 15 - EXTREME NOISE. Random walk, no persistent alpha anywhere. The critical safety
 *  proof scenario per the mandate: Argus must NOT manufacture a trade from pure noise. */
export const EXTREME_NOISE: ScenarioProfile = {
  id: 'EXTREME_NOISE',
  description: 'Pure random walk, zero persistent drift, elevated but non-directional volatility. Argus must mostly not trade.',
  expectedToBeTradeable: false,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 90 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0, volatilityMultiplier: 1.8, volumeMultiplier: 1.1 },
  ],
  events: [],
};

/** SCENARIO 2 - TRENDING BULL / GAP AND GO. A clean, sustained positive drift with volume
 *  confirmation and a real technical-confirmation-shaped path (an opening gap followed by
 *  continuation) - deliberately designed to be recognizable by the CURRENTLY IMPLEMENTED core
 *  strategies (momentum breakout / trend following) without telling Argus "BUY" directly. This is
 *  the mandate's Test B (controlled tradeable scenario) candidate. */
export const TRENDING_BULL_GAP_AND_GO: ScenarioProfile = {
  id: 'TRENDING_BULL_GAP_AND_GO',
  description: 'Opening gap up + sustained volume-confirmed uptrend - a legitimately recognizable momentum/trend setup for the existing strategy set.',
  expectedToBeTradeable: true,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 5 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0.0009, volatilityMultiplier: 1.6, volumeMultiplier: 2.2 },
    { fromOffsetMs: 5 * MIN, toOffsetMs: 60 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.0006, volatilityMultiplier: 1.0, volumeMultiplier: 1.4 },
    { fromOffsetMs: 60 * MIN, toOffsetMs: 90 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0.0001, volatilityMultiplier: 0.8, volumeMultiplier: 1.0 },
  ],
  events: [
    { type: 'GAP', atOffsetMs: 0, gapPct: 0.018 },
  ],
};

/** SCENARIO 10 - NEWS SHOCK. Quiet, then a deterministic high-impact positive news event mid-
 *  session causes a real price/volume/volatility reaction, with a corresponding synthetic news
 *  item fed through the real news_clusters/news_veto surface. */
export const NEWS_SHOCK: ScenarioProfile = {
  id: 'NEWS_SHOCK',
  description: 'Quiet open, then a deterministic high-impact news event at a fixed simulated timestamp causes a real price/volume/volatility reaction.',
  expectedToBeTradeable: true,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 20 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0, volatilityMultiplier: 0.6, volumeMultiplier: 0.9 },
    { fromOffsetMs: 20 * MIN, toOffsetMs: 25 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0.0012, volatilityMultiplier: 2.2, volumeMultiplier: 3.0 },
    { fromOffsetMs: 25 * MIN, toOffsetMs: 60 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.0004, volatilityMultiplier: 1.1, volumeMultiplier: 1.3 },
  ],
  events: [
    { type: 'NEWS_SHOCK', atOffsetMs: 20 * MIN, newsDirection: 'POSITIVE', newsMagnitude: 'HIGH_IMPACT' },
  ],
};

/** SCENARIO: VALIDATED_CONVERGENCE_CONTROL (2026-09-14, Step 3 of the post-certification-incident
 *  hardening plan). NOT one of the mandate's 15 named scenarios - a deliberately narrow, single-
 *  purpose control built after TRENDING_BULL_GAP_AND_GO's real certification run correctly reached
 *  CONSENSUS and was correctly rejected there ("only 1 independent agent agreed - need 2",
 *  confidence below the 0.75 bar after calibration). That was a legitimate finding, not a bug - the
 *  operator explicitly forbade lowering minIndependentAgreeingAgents/consensusApprovalThreshold or
 *  otherwise touching the gate to make it pass. This scenario instead tries to make the OPPORTUNITY
 *  itself more genuinely, cleanly recognizable to the CURRENTLY IMPLEMENTED core strategies, so a
 *  real independent multi-agent agreement has an honest chance to occur - never a stronger price
 *  move for its own sake.
 *
 *  Design levers, each tied to a real condition an existing strategy/agent actually checks (see
 *  src/server/quant/strategies/momentumBreakout.ts and trendFollowing.ts):
 *   - An opening gap + volatility/volume pop gives MOMENTUM_BREAKOUT's structural-break
 *     (BOS_BULLISH) and RVOL/ATR-EXPANDING conditions a genuine, early trigger point.
 *   - A long, CLEAN (materially lower noise than TRENDING_BULL_GAP_AND_GO's 1.0x post-open
 *     volatilityMultiplier), sustained uptrend afterward gives TREND_FOLLOWING's MA-ordering / ADX
 *     (>= quantThresholds.minAdxTrending) / MACD / CMF conditions a real chance to all line up at
 *     once - a choppy path with the same mean drift satisfies materially fewer of them - and lets
 *     KronosForecastAgent's own Chronos forecast extrapolate a genuinely low-residual trend with
 *     higher confidence, independently.
 *   - Volume stays elevated (>= a real RVOL confirmation) for the ENTIRE trending segment, not just
 *     the opening minutes - real, sustained "volume confirmation" per the mandate's own criteria.
 *   - The session is deliberately long (see marketOpen.ts's certification defaults for this
 *     scenario) so trendFollowing's SMA20/SMA50/SMA200 ordering condition can actually be evaluated
 *     from this session's OWN bars - on a short session SMA200 is simply unavailable (null), which
 *     is a warm-up data-availability gap, not a real disagreement about the trend, and would
 *     silently suppress a real strategy's score for a reason that has nothing to do with the
 *     opportunity's genuine quality. */
export const VALIDATED_CONVERGENCE_CONTROL: ScenarioProfile = {
  id: 'VALIDATED_CONVERGENCE_CONTROL',
  description: 'Opening structural breakout (gap + volume/volatility pop) followed by a long, low-noise, volume-confirmed uptrend - engineered for genuine independent multi-agent convergence, not a stronger price move. No injected votes, no threshold changes.',
  expectedToBeTradeable: true,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 10 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0.0011, volatilityMultiplier: 1.7, volumeMultiplier: 2.5 },
    { fromOffsetMs: 10 * MIN, toOffsetMs: 230 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.00055, volatilityMultiplier: 0.65, volumeMultiplier: 1.8 },
    { fromOffsetMs: 230 * MIN, toOffsetMs: 240 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0.0001, volatilityMultiplier: 0.6, volumeMultiplier: 1.2 },
  ],
  events: [
    { type: 'GAP', atOffsetMs: 0, gapPct: 0.02 },
  ],
};

export const SCENARIOS: Record<string, ScenarioProfile> = {
  QUIET_OPEN,
  EXTREME_NOISE,
  TRENDING_BULL_GAP_AND_GO,
  NEWS_SHOCK,
  VALIDATED_CONVERGENCE_CONTROL,
};

export function getScenario(id: string): ScenarioProfile {
  const scenario = SCENARIOS[id];
  if (!scenario) {
    throw new Error(`Unknown synthetic scenario "${id}" - available: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return scenario;
}

/** Finds the active regime segment for a given simulated-time offset - the last segment whose
 *  window contains it, defaulting to a flat/neutral regime if the scenario has a gap in coverage
 *  (never throws mid-session over a config gap). */
export function activeSegment(scenario: ScenarioProfile, offsetMs: number): RegimeSegment {
  for (const seg of scenario.segments) {
    if (offsetMs >= seg.fromOffsetMs && offsetMs < seg.toOffsetMs) return seg;
  }
  return { fromOffsetMs: offsetMs, toOffsetMs: offsetMs + 1, regime: 'SIDEWAYS', driftPerBarMean: 0, volatilityMultiplier: 1, volumeMultiplier: 1 };
}
