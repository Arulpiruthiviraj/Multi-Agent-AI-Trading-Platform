/**
 * ==========================================================
 * Module: SyntheticDailyBarProvider
 *
 * Closes a real, previously-documented gap in the Synthetic Market Session Simulator (see
 * docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md §4 and
 * docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md §2-4): QuantSignalAgent (the only real
 * production caller of StrategyEngine.evaluateAll(), which runs the 5 CORE strategies) always
 * requests '1Day' bars from HistoricalDataGateway. HistoricalDataGateway correctly refuses a real
 * Alpaca/IBKR network fetch while SYNTHETIC_SIMULATION=true (see HistoricalDataGateway.ts's own
 * guard) - that refusal is intentional and must never be weakened. The gap was upstream: nothing
 * ever wrote a synthetic '1Day' substitute into ohlcv_bars for the gateway's cache-first check to
 * find, so every CORE-strategy evaluation attempt fell through to a real network call, then failed
 * closed on the guard above.
 *
 * This module is that substitute. It produces two kinds of '1Day' bars, both DERIVED from the same
 * deterministic seed/scenario the session's own minute-level SyntheticMarketDataEngine already uses
 * - never a second, disconnected synthetic data source, and never a relabeled copy of minute bars:
 *
 *   1. generateSyntheticPriorDayHistory() - PRIOR_TRADING_DAYS (260, comfortably above the 200 real
 *      daily closes trend.ts's sma(200) needs to stop returning null, and above RegimeEngine's own
 *      MIN_BARS=60 floor) trading days of synthetic daily OHLCV, ending the trading day immediately
 *      before the session's own sessionStartMs. This is NOT a replay of the minute engine's output -
 *      the minute engine only ever covers the single session day. It is a real, separately-seeded
 *      (see deriveDailySeed()) geometric random walk, built BACKWARDS from an anchor so the most
 *      recent synthetic day's close exactly equals the session's own config.startPrice - i.e. the
 *      day the live minute bars are about to trade continues smoothly from where this history leaves
 *      off, rather than gapping to an unrelated price. Daily volatility is derived from the SAME
 *      config.baseVolatility the minute engine uses (scaled by sqrt(bars-per-day), the standard
 *      Brownian-motion time-scaling relationship - not an invented number). Daily drift direction
 *      (not magnitude - see DAILY_DRIFT_MAGNITUDE's own comment) is read directly off the scenario's
 *      own regime segments, so a scenario built to exercise TREND_FOLLOWING/MOMENTUM_BREAKOUT
 *      produces a real, matching SMA20/50/200 stack, and a SIDEWAYS-dominant scenario produces a
 *      real flat/range-bound prior history suited to MEAN_REVERSION/RANGE_REVERSION.
 *
 *   2. rollupTodaysDailyBar() - a real OHLCV rollup (open=first revealed minute bar's open,
 *      high/low=running max/min, close=latest revealed minute bar's close, volume=running sum) of
 *      the CURRENT session's own already-revealed minute bars. SyntheticSessionEngine.ts calls this
 *      incrementally, once per minute bar, using only bars the simulated clock has already reached -
 *      exactly the same point-in-time discipline persistBar() already applies to the '1Min' row, so
 *      today's daily bar can never leak a later-session high/low/close into an earlier evaluation.
 *
 * Production-safety: assertSyntheticDailyBarProviderOnlyInSyntheticSession() is called at the top of
 * every exported bar-producing function and throws unless SYNTHETIC_SIMULATION=true (the same flag
 * HistoricalDataGateway.ts's own guard checks) - this module cannot be reached by a live/paper boot
 * even if something imported it by mistake. See
 * src/server/replay/synthetic/syntheticDailyBarProvider.architectureBoundary.test.ts for the static
 * import-boundary proof (no file outside src/server/replay/synthetic/ may import this module) and a
 * runtime proof of the guard itself.
 * ==========================================================
 */
import type { ScenarioProfile } from './SyntheticScenario';
import type { SyntheticSymbolConfig, SyntheticBar } from './SyntheticMarketDataEngine';

export interface SyntheticDailyBar {
  timestamp: number; // bar open time, epoch ms - matches isDailyBarFinal()'s own "1Day bar timestamp is session open" convention
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Source tag written to ohlcv_bars.source - distinct from 'synthetic_simulation' (the minute-bar
 *  tag already in use) so a forensic query can tell daily-history rows from minute rows at a glance,
 *  while the shared 'synthetic' prefix keeps both instantly recognizable as non-organic. */
export const SYNTHETIC_DAILY_SOURCE = 'synthetic_simulation_daily';

/** Comfortably above trend.ts's sma(200) requirement and RegimeEngine.MIN_BARS (60); see header. */
export const PRIOR_TRADING_DAYS = 260;

const MS_PER_DAY = 86_400_000;
const MINUTE_BARS_PER_TRADING_DAY = 390; // 9:30-16:00 ET, the same session length this harness already models

/**
 * Daily log-return drift magnitude for the prior-history random walk. Deliberately NOT derived by
 * literally extrapolating a scenario segment's driftPerBarMean (a per-MINUTE figure tuned for a
 * single ~90-400 minute session) up to a per-DAY figure by multiplying by 390 - that would compound
 * into an absurd, non-physical price path over 260 days (e.g. a 0.0006 per-minute drift implies a
 * +20%/day rate). Instead this is a fixed, realistic daily-drift magnitude (~0.15%/day, which
 * compounds to a strong-but-plausible ~35-45% move over PRIOR_TRADING_DAYS - enough to produce a
 * real, non-degenerate SMA20/50/200 stack for TREND_FOLLOWING/MOMENTUM_BREAKOUT fixtures) whose SIGN
 * alone is read from the scenario (see regimeDriftSign()).
 */
const DAILY_DRIFT_MAGNITUDE = 0.0015;

function assertSyntheticDailyBarProviderOnlyInSyntheticSession(): void {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error(
      'SyntheticDailyBarProvider refuses to run outside a synthetic simulation session (SYNTHETIC_SIMULATION !== "true"). ' +
      'This module exists only to feed HistoricalDataGateway\'s isolated cache during an isolated synthetic run - it must ' +
      'never be reachable from a live/paper boot.',
    );
  }
}

/** Cheap, deterministic string hash (FNV-1a) - used only to derive a distinct, symbol-specific RNG
 *  sub-seed so prior-day history generation never shares (and therefore never perturbs) the exact
 *  draw sequence SyntheticMarketDataEngine's own `rng` instance consumes for minute bars. Two
 *  independent, both-deterministic streams from one seed, not two different sources of randomness. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic, symbol-specific sub-seed derived from the session's own seed. */
export function deriveDailySeed(seed: number, symbol: string): number {
  return (seed ^ fnv1a(`daily:${symbol}`)) >>> 0;
}

/** Weighted sign of the scenario's own regime segments (weighted by duration) - direction only, see
 *  DAILY_DRIFT_MAGNITUDE's doc comment for why magnitude is not read from this. */
export function regimeDriftSign(scenario: ScenarioProfile): -1 | 0 | 1 {
  let signedDurationMs = 0;
  for (const seg of scenario.segments) {
    const durationMs = Math.max(0, seg.toOffsetMs - seg.fromOffsetMs);
    signedDurationMs += Math.sign(seg.driftPerBarMean) * durationMs;
  }
  if (signedDurationMs > 0) return 1;
  if (signedDurationMs < 0) return -1;
  return 0;
}

/** Steps one calendar day backward from `ms`, skipping Saturday/Sunday. Deliberately weekday-only
 *  (no NYSE holiday calendar) - documented approximation, not a claim of real-calendar fidelity;
 *  irrelevant to the gating this module exists to satisfy (HistoricalDataGateway's SYNTHETIC_SIMULATION
 *  branch only checks existing.length > 0, never a specific calendar shape). */
function previousTradingDayMs(ms: number): number {
  let t = ms - MS_PER_DAY;
  let dow = new Date(t).getUTCDay();
  while (dow === 0 || dow === 6) {
    t -= MS_PER_DAY;
    dow = new Date(t).getUTCDay();
  }
  return t;
}

/**
 * Minimal seeded RNG, duplicated in miniature from SyntheticRandom's own mulberry32-style algorithm
 * rather than imported, so this module's daily-history stream is trivially auditable as fully
 * independent of (never advances, never is advanced by) the minute engine's own rng instance. Same
 * algorithm as SyntheticRandom.ts - deliberately not re-exported from there to keep that file's own
 * reviewed, already-certified call sequence untouched by this addition.
 */
class DailyRandom {
  private state: number;
  constructor(seed: number) {
    this.state = (seed ^ 0x9e3779b9) >>> 0;
  }
  private next(): number {
    this.state |= 0;
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  gaussian(): number {
    const u1 = Math.max(this.next(), Number.EPSILON);
    const u2 = this.next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

/**
 * Generates PRIOR_TRADING_DAYS deterministic synthetic daily bars ending the trading day immediately
 * before sessionStartMs, anchored so the most recent bar's close equals config.startPrice (zero
 * assumed overnight gap into the live session - the simplest honest continuity assumption, and the
 * same one real pre-market gap events in these scenarios already model explicitly where they intend
 * a gap). See this file's header for the full derivation.
 */
export function generateSyntheticPriorDayHistory(
  config: SyntheticSymbolConfig,
  scenario: ScenarioProfile,
  seed: number,
  sessionStartMs: number,
  priorTradingDays: number = PRIOR_TRADING_DAYS,
): SyntheticDailyBar[] {
  assertSyntheticDailyBarProviderOnlyInSyntheticSession();

  const rng = new DailyRandom(deriveDailySeed(seed, config.symbol));
  const driftSign = regimeDriftSign(scenario);
  const dailyDriftMean = driftSign * DAILY_DRIFT_MAGNITUDE;
  const dailyVol = config.baseVolatility * Math.sqrt(MINUTE_BARS_PER_TRADING_DAY);

  // Day timestamps, most-recent-first (closest trading day before sessionStartMs is index 0).
  const dayTimestamps: number[] = [];
  let cursor = sessionStartMs;
  for (let i = 0; i < priorTradingDays; i++) {
    cursor = previousTradingDayMs(cursor);
    dayTimestamps.push(cursor);
  }

  // Per-day log-returns, one per day, generated forward through the RNG stream (deterministic given
  // seed) - logReturns[0] is the return from day[1]'s close to day[0]'s close (i.e. the most recent
  // day's return), matching the backward walk below.
  const logReturns: number[] = [];
  for (let i = 0; i < priorTradingDays; i++) {
    logReturns.push(dailyDriftMean + dailyVol * rng.gaussian());
  }

  // Backward anchor: closes[0] (most recent prior day) = config.startPrice; closes[i] = closes[i-1] / exp(logReturns[i-1]).
  const closes: number[] = new Array(priorTradingDays);
  closes[0] = config.startPrice;
  for (let i = 1; i < priorTradingDays; i++) {
    closes[i] = closes[i - 1] / Math.exp(logReturns[i - 1]);
  }
  // One extra point behind the oldest day, to serve as its open.
  const oldestOpen = closes[priorTradingDays - 1] / Math.exp(logReturns[priorTradingDays - 1]);

  const bars: SyntheticDailyBar[] = [];
  for (let i = priorTradingDays - 1; i >= 0; i--) {
    const open = i === priorTradingDays - 1 ? oldestOpen : closes[i + 1];
    const close = closes[i];
    const intrabarRangeFrac = Math.abs(dailyVol) * rng.range(0.8, 2.2);
    const high = Math.max(open, close) * (1 + intrabarRangeFrac * rng.range(0.2, 1));
    const low = Math.min(open, close) * (1 - intrabarRangeFrac * rng.range(0.2, 1));
    const volume = Math.max(
      1,
      Math.round(config.baseVolumePerBar * MINUTE_BARS_PER_TRADING_DAY * rng.range(0.6, 1.5)),
    );
    bars.push({
      timestamp: dayTimestamps[i],
      open: round2(open), high: round2(high), low: round2(low), close: round2(close),
      volume,
    });
  }
  return bars;
}

/**
 * Real OHLCV rollup of this session's own already-revealed minute bars - point-in-time safe
 * (`revealedBars` must only ever contain bars the simulated clock has already reached; see call
 * site in SyntheticSessionEngine.ts). Returns null for an empty slice (nothing to roll up yet).
 */
export function rollupTodaysDailyBar(revealedBars: readonly SyntheticBar[], dayTimestamp: number): SyntheticDailyBar | null {
  assertSyntheticDailyBarProviderOnlyInSyntheticSession();
  if (revealedBars.length === 0) return null;
  let high = -Infinity;
  let low = Infinity;
  let volume = 0;
  for (const b of revealedBars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
  }
  return {
    timestamp: dayTimestamp,
    open: revealedBars[0].open,
    high, low,
    close: revealedBars[revealedBars.length - 1].close,
    volume,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
