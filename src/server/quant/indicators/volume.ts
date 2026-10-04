/**
 * ==========================================================
 * Module: indicators/volume
 *
 * Purpose:
 * Volume-family features: Volume SMA/ROC/spike, RVOL, OBV (wraps existing calculateOBV), a real
 * session-anchored VWAP (new - see note below), VWAP slope/distance/reclaim-rejection, MFI (wraps
 * existing calculateMFI), Chaikin Money Flow, and Accumulation/Distribution.
 *
 * VWAP note: TechnicalIndicators.calculateVWAP already exists but is cumulative over whatever
 * array is passed in (not session-anchored) - confirmed by reading its source, and left
 * completely untouched (its only real caller today has no session concept either). A true
 * intraday VWAP needs to reset at each session's start, which needs a session boundary the
 * existing function was never given. `calculateSessionVWAP` below is a new, separate function for
 * exactly that - not a modification of the existing one.
 * ==========================================================
 */
import { TechnicalIndicators } from '../../engines/TechnicalIndicators';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';

export function volumeSMA(volumes: number[], period: number = 20): number | null {
  if (volumes.length < period) return null;
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

/** Current bar's volume divided by its own trailing average - the standard "RVOL" retail traders
 *  mean (e.g. RVOL 2.0 = today's volume is 2x the recent normal). Null if the average is 0. */
export function relativeVolume(volumes: number[], period: number = 20): number | null {
  if (volumes.length < period + 1) return null;
  const avg = volumeSMA(volumes.slice(0, -1), period);
  if (avg === null || avg === 0) return null;
  return volumes[volumes.length - 1] / avg;
}

/** True when RVOL exceeds `threshold` (default 2x) - a real, threshold-based spike flag built
 *  directly on `relativeVolume`, not a second independent calculation. */
export function isVolumeSpike(volumes: number[], period: number = 20, threshold: number = 2): boolean | null {
  const rvol = relativeVolume(volumes, period);
  return rvol === null ? null : rvol >= threshold;
}

export function volumeROC(volumes: number[], period: number = 10): number | null {
  if (volumes.length < period + 1) return null;
  const anchor = volumes[volumes.length - 1 - period];
  if (anchor === 0) return null;
  return ((volumes[volumes.length - 1] - anchor) / anchor) * 100;
}

/** Midnight-UTC of the given bar's own day - a real, simple, documented session-boundary default
 *  for callers that don't have (or don't need) a real exchange-session-open timestamp. Callers
 *  with real premarket/session data should pass their own boundary into calculateSessionVWAP
 *  instead of relying on this default. */
export function sessionStartOfDay(timestampMs: number): number {
  const d = new Date(timestampMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Real session-anchored VWAP: cumulative typical-price VWAP over only the bars at/after
 *  `sessionStartMs`, mirroring how VWAP is actually meant to be used intraday (resets each
 *  session, not cumulative across all history the caller happens to have loaded). */
export function calculateSessionVWAP(bars: Bar[], sessionStartMs?: number): number | null {
  if (bars.length === 0) return null;
  const boundary = sessionStartMs ?? sessionStartOfDay(bars[bars.length - 1].timestamp);
  const sessionBars = bars.filter(b => b.timestamp >= boundary);
  if (sessionBars.length === 0) return null;
  const typicalPrices = sessionBars.map(b => (b.high + b.low + b.close) / 3);
  const volumes = sessionBars.map(b => b.volume);
  return TechnicalIndicators.calculateVWAP(typicalPrices, volumes);
}

export interface VWAPContext {
  vwap: number | null;
  distancePct: number | null;
  slopePct: number | null; // change in session VWAP over the last few bars of the session
  event: 'RECLAIM' | 'REJECTION' | 'NONE'; // real crossing detection, see below
  /**
   * True only when built from real intraday bars (computeVolumeFeatures' intradayBars path).
   * False means the "session VWAP" was built from daily bars and degenerates to today's
   * single-bar typical price - strategies that need a genuine session anchor must treat
   * this as absent, not as a real VWAP.
   */
  intradayBased: boolean;
}

/**
 * `RECLAIM` = the two most recent closes crossed from below session VWAP to above it (bullish).
 * `REJECTION` = the two most recent closes crossed from above session VWAP to below it (bearish).
 * Requires re-deriving VWAP at both the prior and current bar (VWAP is cumulative within the
 * session, so "VWAP one bar ago" is a real, different number, not the current value reused).
 */
export function computeVWAPContext(bars: Bar[], sessionStartMs?: number, intradayBased = false): VWAPContext {
  const vwap = calculateSessionVWAP(bars, sessionStartMs);
  // A zero/NaN VWAP is corrupt data, not a level - never divide by it.
  if (vwap === null || bars.length === 0 || !Number.isFinite(vwap) || vwap === 0) {
    return { vwap: null, distancePct: null, slopePct: null, event: 'NONE', intradayBased };
  }

  const currentPrice = bars[bars.length - 1].close;
  const distancePct = ((currentPrice - vwap) / vwap) * 100;

  let event: VWAPContext['event'] = 'NONE';
  let slopePct: number | null = null;
  if (bars.length >= 2) {
    const priorVwap = calculateSessionVWAP(bars.slice(0, -1), sessionStartMs);
    if (priorVwap !== null && Number.isFinite(priorVwap) && priorVwap !== 0) {
      slopePct = ((vwap - priorVwap) / priorVwap) * 100;
      const priorClose = bars[bars.length - 2].close;
      if (priorClose < priorVwap && currentPrice > vwap) event = 'RECLAIM';
      else if (priorClose > priorVwap && currentPrice < vwap) event = 'REJECTION';
    }
  }

  return { vwap, distancePct, slopePct, event, intradayBased };
}

/** Chaikin Money Flow over `period` bars - sum(Money Flow Multiplier * volume) / sum(volume).
 *  Null if the summed volume is 0 or every bar in the window has zero range (high===low). */
export function calculateCMF(bars: Bar[], period: number = 20): number | null {
  if (bars.length < period) return null;
  const window = bars.slice(-period);
  let mfvSum = 0, volSum = 0;
  for (const b of window) {
    if (b.high === b.low) continue; // undefined multiplier for a zero-range bar - skip, don't fabricate
    const mfm = ((b.close - b.low) - (b.high - b.close)) / (b.high - b.low);
    mfvSum += mfm * b.volume;
    volSum += b.volume;
  }
  if (volSum === 0) return null;
  return mfvSum / volSum;
}

/** Cumulative Accumulation/Distribution line over the full bars array supplied - a running total,
 *  same convention as the existing calculateOBV (cumulative over whatever's passed in). */
export function calculateAD(bars: Bar[]): number {
  let ad = 0;
  for (const b of bars) {
    if (b.high === b.low) continue;
    const mfm = ((b.close - b.low) - (b.high - b.close)) / (b.high - b.low);
    ad += mfm * b.volume;
  }
  return ad;
}

export interface VolumeFeatures {
  volumeSMA20: number | null;
  relativeVolume: number | null;
  isSpike: boolean | null;
  volumeROC: number | null;
  obv: number;
  mfi: number;
  vwap: VWAPContext;
  cmf: number | null;
  ad: number;
}

/**
 * 2026-09-30 (ARGUS_FULL_SESSION_REVIEW_2026-09-29.md follow-up, ORB input-contract verification):
 * real, confirmed defect found tracing this function's own VWAP path. Every CORE-strategy caller
 * passes only DAILY bars here (one row per trading day) - computeVWAPContext(bars) ->
 * calculateSessionVWAP(bars) filters for bars at/after "today's" midnight-UTC boundary, which
 * against a DAILY series matches at most ONE row (today's own daily OHLCV, if present). A
 * "session VWAP" built from exactly one bar degenerates to that single bar's own typical price
 * ((h+l+c)/3) - not a genuine intraday-cumulative VWAP, even though OPENING_RANGE_BREAKOUT's own
 * "Price above/below session VWAP" condition (openingRangeBreakout.ts) depends on this value being
 * real. `intradayBars` (optional, additive - mirrors computeSupportResistanceFeatures's own
 * intradayBars parameter and QuantSignalAgent.ts's existing intraday fetch, gated the same way)
 * lets VWAP/distance/slope/reclaim-rejection be computed from real 1-minute bars when available -
 * a genuine session-cumulative VWAP instead of a single-bar approximation. relativeVolume/isSpike/
 * volumeROC/obv/mfi/cmf/ad are UNCHANGED (still daily-bar-based) - RVOL's own daily-vs-20-day-daily-
 * average comparison is a coarser, but internally SCOPE-CONSISTENT measure (daily numerator over
 * daily denominator), not the same degenerate-single-bar defect VWAP had; fixing it would require
 * a genuine intraday historical ADV curve, a separate, larger, not-yet-built follow-up (see
 * discoveryCandidateLedger.ts's VolumeProvenance for the same distinction applied to discovery RVOL
 * - a different calculation, different data source, do not conflate the two).
 */
export function computeVolumeFeatures(bars: Bar[], intradayBars?: Bar[]): VolumeFeatures {
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);

  return {
    volumeSMA20: volumeSMA(volumes),
    relativeVolume: relativeVolume(volumes),
    isSpike: isVolumeSpike(volumes),
    volumeROC: volumeROC(volumes),
    obv: TechnicalIndicators.calculateOBV(closes, volumes),
    mfi: TechnicalIndicators.calculateMFI(highs, lows, closes, volumes),
    vwap: intradayBars && intradayBars.length > 0 ? computeVWAPContext(intradayBars, undefined, true) : computeVWAPContext(bars),
    cmf: calculateCMF(bars),
    ad: calculateAD(bars),
  };
}
