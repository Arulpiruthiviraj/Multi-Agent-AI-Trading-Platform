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
  // Real empirical finding (2026-09-15, post-cross-examination remediation): the original
  // volatilityMultiplier here (0.65) was too LOW relative to driftPerBarMean - the drift/volatility
  // ratio made almost every bar a genuine up-bar, producing a near-monotonic ramp that pinned RSI
  // in the 85-97 "extreme overbought" zone for the whole session (confirmed live on two different
  // seeds: TechnicalAgent's own real overbought/mean-reversion rule, and JavaCoreEnsemble's real
  // MEAN_REVERSION_FAMILY strategies, both correctly read a move that extended is more likely to
  // reverse than continue - exactly what these rules are supposed to do). Raised to 1.3 (still
  // between TRENDING_BULL_GAP_AND_GO's already-real-tested 1.0 and a genuinely noisy regime) so
  // real down-bars occur often enough for RSI to oscillate in the healthy 50-70 momentum band
  // (matching the SAME ratio TechnicalAgent.debounce.test.ts's own proven momentumBreakout fixture
  // targets) instead of running away to an extreme reversal reading - a real market-structure fix,
  // not a threshold or gate change.
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 10 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0.0011, volatilityMultiplier: 1.7, volumeMultiplier: 2.5 },
    { fromOffsetMs: 10 * MIN, toOffsetMs: 230 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.00055, volatilityMultiplier: 1.3, volumeMultiplier: 1.8 },
    { fromOffsetMs: 230 * MIN, toOffsetMs: 240 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0.0001, volatilityMultiplier: 0.6, volumeMultiplier: 1.2 },
  ],
  events: [
    { type: 'GAP', atOffsetMs: 0, gapPct: 0.02 },
  ],
};

/** SCENARIO: CERTIFIED_BULLISH_ENTRY_EXIT (2026-09-15, autonomous end-to-end certification mandate).
 *  Purpose-built to answer one question conclusively: can the real Argus pipeline recognize a
 *  genuinely strong, causally-available opportunity, approve it, fill it, hold a position, exit it,
 *  and produce simulated P&L - without any bypass. A materially more realistic multi-phase
 *  structure than VALIDATED_CONVERGENCE_CONTROL's simpler gap+trend shape, specifically to include
 *  a genuine CONSOLIDATION before the trend resumes (giving MOMENTUM_BREAKOUT's own
 *  structural-break condition something real to break OUT of, not just a straight continuation)
 *  and a genuine REVERSAL phase at the end so PortfolioMonitor's real trailing-stop/thesis-
 *  invalidation exit logic has a real trigger to fire on - VALIDATED_CONVERGENCE_CONTROL never
 *  reverses, so it was never actually capable of exercising exit logic even in principle.
 *
 *  Phase mapping (framework note: this simulator's session always starts at the synthetic
 *  09:30 ET open - see defaultSessionStartMs() - so there is no distinct simulated pre-market
 *  phase; Phase B below IS the session's first bar, carrying the overnight-gap event):
 *   B. Opening auction - GAP event + elevated-but-plausible volatility/volume (mirrors the real
 *      structural-break conditions MOMENTUM_BREAKOUT checks: BOS_BULLISH, RVOL/ATR-EXPANDING).
 *   C1. Controlled pullback (2026-09-15, same-day redesign - see "Timing redesign" note below) -
 *      a real, moderate negative-drift dip off the opening pop, short and bounded so it never
 *      destroys the bullish structure (a real pullback within an uptrend, not a reversal). Exists
 *      specifically to give TechnicalAgent's own real RSI/Bollinger mean-reversion logic an early,
 *      genuine "buy the dip" trigger point - see the redesign note for why this matters.
 *   C2. Basing / stabilization - drift near zero, volatility DAMPENED (not elevated) relative to the
 *      open, so price genuinely pauses/bases after the pullback rather than continuing to ramp or
 *      fall - a real base for the later breakout to break OUT of, and enough of a pause that RSI can
 *      cool before the trend resumes (avoiding VALIDATED_CONVERGENCE_CONTROL's original RSI-pinning
 *      class of defect from the very start, not patching it after the fact).
 *   D. Breakout - a real acceleration in drift AND volume above both the open and the consolidation,
 *      the genuine "break of recent resistance" signature.
 *   E. Continuation - sustained but gentler drift than the breakout spike, elevated volume
 *      maintained (real RVOL confirmation for the whole move, not just the opening minutes) -
 *      long enough for TREND_FOLLOWING's SMA20/50/200 ordering and ADX conditions to actually
 *      evaluate from this session's own bars.
 *   F. Reversal / exit opportunity - a genuine negative-drift segment, giving a real trailing-stop
 *      or thesis-invalidation trigger a real chance to fire and close any open position - the part
 *      VALIDATED_CONVERGENCE_CONTROL structurally could never test, since it never reverses.
 *
 *  Timing redesign (2026-09-15, same-day follow-up, after the HistoricalDataGateway isolation fix
 *  unblocked the first real BUY of this whole mandate): the discovery run's real BUY fired from a
 *  genuine TechnicalAgent "Oversold... RSI at 19.63" read - but that read only occurred deep inside
 *  the OLD Phase F reversal (offset ~219/240 min), because the old Phase C was flat/near-zero-drift,
 *  never a real dip, so TechnicalAgent's mean-reversion BUY trigger had nothing to fire on until the
 *  scenario's own late reversal produced one - by which point only ~20 simulated minutes remained,
 *  too little for a subsequent exit to also fire before the session ended. Splitting the old flat
 *  Phase C into a real, bounded C1 pullback (this fix) gives that same genuine BUY trigger a chance
 *  to fire around minute 10-16 instead of minute 219 - preserving essentially the entire rest of the
 *  session (D through F, ~220+ minutes) for the position to be held, evaluated, and legitimately
 *  exited. This is a scenario-timing fix, not a fabricated exit rule - Phase F's real reversal is
 *  unchanged and remains the same genuine, pre-existing exit trigger it always was. */
export const CERTIFIED_BULLISH_ENTRY_EXIT: ScenarioProfile = {
  id: 'CERTIFIED_BULLISH_ENTRY_EXIT',
  description: 'Multi-phase gap -> controlled pullback -> basing -> breakout -> continuation -> reversal, purpose-built to exercise the full entry-through-exit lifecycle, not just idea generation.',
  expectedToBeTradeable: true,
  segments: [
    // B. Opening auction: gap + elevated vol/volume, short (real opens settle quickly)
    { fromOffsetMs: 0, toOffsetMs: 8 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0.0010, volatilityMultiplier: 1.6, volumeMultiplier: 2.3 },
    // C1. Controlled pullback: a real, bounded dip - moderate negative drift, elevated-but-plausible
    // volatility, short (8 min) so it stays a pullback, never a structural reversal.
    { fromOffsetMs: 8 * MIN, toOffsetMs: 16 * MIN, regime: 'TRENDING_DOWN', driftPerBarMean: -0.0009, volatilityMultiplier: 1.1, volumeMultiplier: 1.4 },
    // C2. Basing / stabilization: near-zero drift, DAMPENED volatility - a real base, not noise
    { fromOffsetMs: 16 * MIN, toOffsetMs: 28 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0.00005, volatilityMultiplier: 0.55, volumeMultiplier: 1.1 },
    // D. Breakout: real acceleration above both B and C2
    { fromOffsetMs: 28 * MIN, toOffsetMs: 40 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.0013, volatilityMultiplier: 1.3, volumeMultiplier: 2.6 },
    // E. Continuation: sustained, gentler than D, still real volume confirmation, long enough for
    // SMA200-class conditions to evaluate from this session's own bars
    { fromOffsetMs: 40 * MIN, toOffsetMs: 190 * MIN, regime: 'TRENDING_UP', driftPerBarMean: 0.0006, volatilityMultiplier: 1.2, volumeMultiplier: 1.7 },
    // F. Reversal: genuine negative drift - a real trailing-stop/thesis-invalidation exit trigger.
    // Extended 240->400 min (2026-09-15, second same-day timing finding): two real post-redesign
    // runs (seeds 271828, 424242) both showed the genuine BUY firing from Kronos+TechnicalAgent
    // converging on THIS phase's own sustained, unambiguous reversal - not the brief C1 pullback
    // above, which turned out to give Kronos too little sustained trend data to form a confident
    // forecast from. A short Phase F (50 min) meant those real entries (offset ~220/239 min) left
    // almost no runway for an exit before the session ended. `activeSegment()` (this file, below)
    // falls through to a flat/no-drift default for any offset past the last segment's own
    // `toOffsetMs` - so naively passing a longer --duration without also extending this boundary
    // just appends a dead, flat tail, not more reversal (confirmed: an earlier --duration=300 probe
    // against the OLD 240-min-capped Phase F produced a materially different, uninformative result
    // for exactly this reason, not primarily AI-provider variance as first assumed). Extending Phase
    // F's own segment to 400 min gives a real entry around the same offset (~220/239) roughly 180
    // minutes of continued genuine reversal runway - real room for either a stop-loss/thesis-
    // invalidation exit (further decline) or a profit-taking exit (a real per-bar bounce within the
    // reversal's own noise), not a fabricated exit rule.
    { fromOffsetMs: 190 * MIN, toOffsetMs: 400 * MIN, regime: 'TRENDING_DOWN', driftPerBarMean: -0.0010, volatilityMultiplier: 1.4, volumeMultiplier: 1.9 },
  ],
  events: [
    { type: 'GAP', atOffsetMs: 0, gapPct: 0.022 },
  ],
};

/** SCENARIO 7 - TRENDING BEAR. Sustained negative drift, volume-confirmed, mirroring
 *  TRENDING_BULL_GAP_AND_GO's shape on the short side. A real, distinct gap this codebase's own
 *  2026-09-16 synthetic-coverage audit found: TRENDING_BEAR did not exist as a dedicated,
 *  parametrized scenario before this pass - only implied as symmetric by TREND_FOLLOWING/
 *  MOMENTUM_BREAKOUT's own bidirectional design, never actually exercised end-to-end. */
export const TRENDING_BEAR: ScenarioProfile = {
  id: 'TRENDING_BEAR',
  description: 'Opening gap down + sustained volume-confirmed downtrend - the short-side mirror of TRENDING_BULL_GAP_AND_GO, for strategies that are structurally bidirectional (MOMENTUM_BREAKOUT, TREND_FOLLOWING).',
  expectedToBeTradeable: true,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 5 * MIN, regime: 'HIGH_VOL', driftPerBarMean: -0.0009, volatilityMultiplier: 1.6, volumeMultiplier: 2.2 },
    { fromOffsetMs: 5 * MIN, toOffsetMs: 90 * MIN, regime: 'TRENDING_DOWN', driftPerBarMean: -0.0006, volatilityMultiplier: 1.2, volumeMultiplier: 1.5 },
  ],
  events: [],
};

/** SCENARIO 8 - SIDEWAYS / RANGE-BOUND. No persistent drift, moderate (not depressed) volatility -
 *  distinct from QUIET_OPEN (which is deliberately low-volatility/low-opportunity) and from
 *  EXTREME_NOISE (which is deliberately high-volatility random walk). This is the middle case: a
 *  real, tradeable-liquidity range environment where mean-reversion-shaped strategies (RANGE_REVERSION,
 *  MEAN_REVERSION) have a real, legitimate setup to evaluate, without a directional trend gifting
 *  MOMENTUM_BREAKOUT/TREND_FOLLOWING an easy read. */
export const SIDEWAYS: ScenarioProfile = {
  id: 'SIDEWAYS',
  description: 'Range-bound, no persistent drift, moderate volatility and real volume - a genuine mean-reversion environment distinct from QUIET_OPEN (too quiet to be interesting) and EXTREME_NOISE (too chaotic to be a real range).',
  expectedToBeTradeable: false,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 30 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0.00015, volatilityMultiplier: 1.0, volumeMultiplier: 1.1 },
    { fromOffsetMs: 30 * MIN, toOffsetMs: 60 * MIN, regime: 'SIDEWAYS', driftPerBarMean: -0.00015, volatilityMultiplier: 1.0, volumeMultiplier: 1.1 },
    { fromOffsetMs: 60 * MIN, toOffsetMs: 90 * MIN, regime: 'SIDEWAYS', driftPerBarMean: 0.0001, volatilityMultiplier: 1.0, volumeMultiplier: 1.1 },
  ],
  events: [],
};

/** SCENARIO 9 - HIGH VOLATILITY OPEN. Elevated volatility from the very first bar (not building up
 *  over time, unlike TRENDING_BULL_GAP_AND_GO's own opening spike), sustained through the session -
 *  the wide-spread/thin-effective-liquidity opening-auction-adjacent condition named in the
 *  overnight certification mandate's Part 8 (VOLATILITY) and Part 20 (OPENING_AUCTION_EDGE)
 *  categories, distinct from EXTREME_NOISE (that scenario is specifically non-directional; this one
 *  layers real elevated volatility UNDER a mild real trend, testing whether Argus can still find a
 *  genuine signal inside noisy conditions rather than either fabricating one or going silent). */
export const HIGH_VOLATILITY_OPEN: ScenarioProfile = {
  id: 'HIGH_VOLATILITY_OPEN',
  description: 'Elevated volatility from the open, sustained through the session, with a mild real underlying drift - tests signal-vs-noise discrimination, not pure noise-rejection (EXTREME_NOISE already covers that).',
  expectedToBeTradeable: false,
  segments: [
    { fromOffsetMs: 0, toOffsetMs: 90 * MIN, regime: 'HIGH_VOL', driftPerBarMean: 0.0002, volatilityMultiplier: 2.4, volumeMultiplier: 1.6 },
  ],
  events: [],
};

export const SCENARIOS: Record<string, ScenarioProfile> = {
  QUIET_OPEN,
  EXTREME_NOISE,
  TRENDING_BULL_GAP_AND_GO,
  TRENDING_BEAR,
  SIDEWAYS,
  HIGH_VOLATILITY_OPEN,
  NEWS_SHOCK,
  VALIDATED_CONVERGENCE_CONTROL,
  CERTIFIED_BULLISH_ENTRY_EXIT,
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
