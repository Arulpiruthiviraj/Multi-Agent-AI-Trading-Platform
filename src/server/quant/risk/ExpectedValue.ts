/**
 * ==========================================================
 * Module: risk/ExpectedValue
 *
 * Purpose:
 * Phase 9 delta of the additive quant layer. RiskEngine.ts and PositionSizing.ts already own real
 * position sizing (ATR-based), daily loss limits, max exposure, correlated exposure, drawdown
 * monitoring, and consecutive-loss monitoring - none of that is touched or duplicated here. The
 * one real gap confirmed by reading both files (grepped for kelly/expectedValue/riskReward -
 * zero matches): no risk/reward ratio, no expected-value calculation, no Kelly-criterion logic
 * exists anywhere in this codebase. This module adds exactly those three, as pure functions with
 * no side effects and no knowledge of the broker/DB/EventBus - callers (PositionSizing.ts, or
 * whatever surfaces this to a human/AI) decide what to do with the numbers.
 *
 * Per the plan's own explicit instruction: "Use fractional Kelly only if statistically justified
 * and heavily constrained. Never allow a mathematical sizing model to bypass hard risk limits."
 * Concretely:
 *   - `fractionalKelly()` refuses (returns null with an honest reason) below MIN_SAMPLE_SIZE_FOR_
 *     TRUST closed trades backing the win-probability estimate - the exact same threshold
 *     BacktestEngine.ts already uses for "is this win rate/Sharpe/profit-factor even trustworthy"
 *     (reused for consistency, not reinvented).
 *   - Even when statistically justified, the result is a FRACTION of full Kelly (default 0.25,
 *     "quarter Kelly" - a standard practitioner convention for taming full-Kelly's real
 *     sensitivity to estimation error) AND hard-capped at MAX_KELLY_FRACTION_OF_CAPITAL regardless
 *     of what the raw formula computes.
 *   - This module NEVER sizes a position or places an order - it returns a suggested risk fraction
 *     only. RiskEngine's own hard caps (symbol/sector concentration, max open positions, daily
 *     loss, drawdown) are not consulted here and are not something this module could bypass even
 *     in principle, since it has no access to place an order - any real integration point
 *     (PositionSizing.ts) must apply this as an ADDITIONAL constraint alongside its existing hard
 *     caps, never as a replacement for them.
 * ==========================================================
 */

import { tradingSafety } from '../../config/tradingSafety';

export const MIN_SAMPLE_SIZE_FOR_KELLY = tradingSafety.minSampleSizeForTrust;
export const MAX_KELLY_FRACTION_OF_CAPITAL = tradingSafety.maxKellyFractionOfCapital;

export interface RiskRewardResult {
  ratio: number | null; // e.g. 2.5 means the target is 2.5x further from entry than the stop
  riskPerUnit: number; // |entry - stop|
  rewardPerUnit: number; // |target - entry|
}

/**
 * Real risk/reward ratio from three real price levels. Null (never a fabricated ratio) when the
 * stop equals the entry (undefined risk - division by zero) or when either input isn't finite.
 */
export function riskRewardRatio(entry: number, stop: number, target: number): RiskRewardResult | null {
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) return null;
  const riskPerUnit = Math.abs(entry - stop);
  const rewardPerUnit = Math.abs(target - entry);
  if (riskPerUnit === 0) return null; // stop == entry: undefined risk, not a fabricated "infinite" ratio
  return { ratio: rewardPerUnit / riskPerUnit, riskPerUnit, rewardPerUnit };
}

export interface ExpectedValueResult {
  expectedValueR: number; // in units of "R" (1R = the real riskPerUnit for this specific trade)
  winProbability: number;
  riskRewardRatio: number;
}

/**
 * Expected value in R-multiples: winProbability * reward(in R) - (1 - winProbability) * 1R lost on
 * a loser. Standard, real EV-in-R formula - assumes the full stop distance is lost on a loss and
 * the full target distance is gained on a win, which is exactly what riskRewardRatio() measures.
 * Null (never a fabricated EV) when winProbability isn't a real probability in [0,1] or the R:R
 * ratio isn't a real positive number.
 */
export function expectedValue(winProbability: number, rrRatio: number): ExpectedValueResult | null {
  if (!Number.isFinite(winProbability) || winProbability < 0 || winProbability > 1) return null;
  if (!Number.isFinite(rrRatio) || rrRatio <= 0) return null;
  const expectedValueR = winProbability * rrRatio - (1 - winProbability) * 1;
  return { expectedValueR: Number(expectedValueR.toFixed(4)), winProbability, riskRewardRatio: rrRatio };
}

export interface KellyResult {
  fullKellyFraction: number; // the raw, unconstrained formula output - reported for transparency, never used directly for sizing
  suggestedFraction: number; // fractionalKelly * the requested fraction, hard-capped at MAX_KELLY_FRACTION_OF_CAPITAL, floored at 0
  fractionOfFullKelly: number; // e.g. 0.25 for quarter-Kelly
  sampleSize: number;
  statisticallyJustified: boolean;
  reason: string; // always populated - explains a null/zero result, or confirms why a positive one is trusted
}

/**
 * Fractional Kelly criterion for a binary win/loss trade with a real (not assumed) win probability
 * and risk/reward ratio, using the standard formula for a b:1 payoff: f* = (p*(b+1) - 1) / b, where
 * b = rrRatio, p = winProbability. Refuses (statisticallyJustified:false, suggestedFraction:0)
 * below MIN_SAMPLE_SIZE_FOR_KELLY real closed trades backing the win-rate estimate - a win-rate
 * estimated from too few trades is not a real edge, it's noise, and sizing off noise is exactly
 * what "statistically justified" in the plan's own instruction exists to prevent.
 */
export function fractionalKelly(
  winProbability: number,
  rrRatio: number,
  sampleSize: number,
  fraction: number = tradingSafety.kellyFractionDefault
): KellyResult {
  if (sampleSize < MIN_SAMPLE_SIZE_FOR_KELLY) {
    return {
      fullKellyFraction: 0, suggestedFraction: 0, fractionOfFullKelly: fraction, sampleSize,
      statisticallyJustified: false,
      reason: `INSUFFICIENT SAMPLE SIZE: only ${sampleSize} closed trades back this win-rate estimate - Kelly sizing is not statistically meaningful below ${MIN_SAMPLE_SIZE_FOR_KELLY}. No size suggested.`,
    };
  }
  if (!Number.isFinite(winProbability) || winProbability <= 0 || winProbability >= 1 || !Number.isFinite(rrRatio) || rrRatio <= 0) {
    return {
      fullKellyFraction: 0, suggestedFraction: 0, fractionOfFullKelly: fraction, sampleSize,
      statisticallyJustified: false,
      reason: 'Invalid winProbability or risk/reward ratio - cannot compute a real Kelly fraction.',
    };
  }

  const fullKelly = (winProbability * (rrRatio + 1) - 1) / rrRatio;

  if (fullKelly <= 0) {
    return {
      fullKellyFraction: Number(fullKelly.toFixed(4)), suggestedFraction: 0, fractionOfFullKelly: fraction, sampleSize,
      statisticallyJustified: true,
      reason: `Full Kelly is non-positive (${fullKelly.toFixed(4)}) - this setup has no real statistical edge at this win rate/R:R combination. No size suggested, regardless of sample size.`,
    };
  }

  const scaled = fullKelly * fraction;
  const suggestedFraction = Math.min(scaled, MAX_KELLY_FRACTION_OF_CAPITAL);
  const wasCapped = scaled > MAX_KELLY_FRACTION_OF_CAPITAL;

  return {
    fullKellyFraction: Number(fullKelly.toFixed(4)),
    suggestedFraction: Number(suggestedFraction.toFixed(4)),
    fractionOfFullKelly: fraction,
    sampleSize,
    statisticallyJustified: true,
    reason: wasCapped
      ? `Real positive edge (full Kelly ${fullKelly.toFixed(4)}) over ${sampleSize} real trades, but ${(fraction * 100).toFixed(0)}% Kelly (${scaled.toFixed(4)}) exceeded the hard cap of ${MAX_KELLY_FRACTION_OF_CAPITAL} - capped, not the raw fractional-Kelly output.`
      : `Real positive edge (full Kelly ${fullKelly.toFixed(4)}) over ${sampleSize} real trades - suggesting ${(fraction * 100).toFixed(0)}% of it.`,
  };
}
