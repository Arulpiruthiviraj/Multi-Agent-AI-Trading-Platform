/**
 * Pure helpers for campaign intraday day-trader mode.
 * No EventBus / OMS / RiskEngine — callers decide when to emit risk-exit ideas.
 */
import { tradingSafety } from '../config/tradingSafety';

export interface OpeningSurgeInputs {
  rvol: number | null;
  last: number | null;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  openingRangeHigh: number | null;
  openingRangeLow: number | null;
  hasHighImpactCatalyst: boolean;
}

export interface OpeningSurgeVerdict {
  pass: boolean;
  reasons: string[];
  orbDirection: 'ABOVE' | 'BELOW' | null;
}

/** RVOL + ORB (+ optional catalyst boost). Fail-closed when inputs missing. */
export function evaluateOpeningSurgeCandidate(input: OpeningSurgeInputs): OpeningSurgeVerdict {
  const reasons: string[] = [];
  const rvolMin = tradingSafety.campaignOpeningRvolMin;
  if (input.rvol == null || !Number.isFinite(input.rvol) || input.rvol < rvolMin) {
    reasons.push(`RVOL_BELOW_${rvolMin}`);
  } else {
    reasons.push(`RVOL_${input.rvol.toFixed(2)}`);
  }

  let orbDirection: 'ABOVE' | 'BELOW' | null = null;
  const last = input.last;
  if (last != null && Number.isFinite(last) && last > 0) {
    if (input.prevDayHigh != null && last > input.prevDayHigh) orbDirection = 'ABOVE';
    else if (input.prevDayLow != null && last < input.prevDayLow) orbDirection = 'BELOW';
    else if (input.openingRangeHigh != null && last > input.openingRangeHigh) orbDirection = 'ABOVE';
    else if (input.openingRangeLow != null && last < input.openingRangeLow) orbDirection = 'BELOW';
  }
  if (!orbDirection) reasons.push('NO_ORB');
  else reasons.push(`ORB_${orbDirection}`);

  if (input.hasHighImpactCatalyst) reasons.push('HIGH_CATALYST');

  const rvolOk = input.rvol != null && input.rvol >= rvolMin;
  // Catalyst alone never forces a pass — need RVOL + ORB. Catalyst is confirmation only.
  const pass = rvolOk && orbDirection != null;
  return { pass, reasons, orbDirection };
}

export function campaignIntradayTargetPrice(entry: number, atr: number): number {
  const mult = tradingSafety.campaignIntradayAtrTargetMultiple;
  return entry + mult * atr;
}

export function campaignBreakevenStopPrice(entry: number): number {
  const padPct = tradingSafety.campaignIntradayBreakevenPadPct;
  return entry * (1 + padPct / 100);
}

/** Clamp a single-order notional for campaign velocity (Gate 23 aligned). */
export function campaignVelocityMaxTradeDollars(opts: {
  maxTradeSizeDollar: number;
  budget: number;
  remainingAllocation: number;
}): number {
  const slots = Math.max(1, tradingSafety.campaignMaxConcurrentPositions);
  const fraction = tradingSafety.campaignPositionBudgetFraction;
  const perSlot = opts.budget * fraction;
  const evenSplit = opts.budget / slots;
  const velocityCap = Math.min(perSlot, evenSplit);
  return Math.max(
    0,
    Math.min(opts.maxTradeSizeDollar, opts.budget, opts.remainingAllocation, velocityCap),
  );
}

/** HH:MM in [start, end) on the exchange clock. */
export function isEtTimeInWindow(hhmm: string, startInclusive: string, endExclusive: string): boolean {
  return hhmm >= startInclusive && hhmm < endExclusive;
}

export function isOpeningSurgeWindow(hhmm: string): boolean {
  // Pre-open through early open (09:25–09:40 ET) — aligns with momentum REST window start.
  return isEtTimeInWindow(hhmm, '09:25', '09:40');
}

export function isCampaignEodFlattenWindow(hhmm: string): boolean {
  const minutes = tradingSafety.campaignEodFlattenEtMinutesBeforeClose;
  // Regular close 16:00 ET → flatten window starts at 16:00 - minutes.
  const startHour = 15;
  const startMin = 60 - minutes;
  const start = `${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}`;
  return isEtTimeInWindow(hhmm, start, '16:00');
}
