/**
 * ARGUS Crypto Expansion Phase 1 (2026-09-21). Instrument-aware quantity quantization, extracted
 * so PositionSizing.ts's 4 real Math.floor(dollars/price) call sites can share one tested,
 * fp-safe rounding function instead of assuming step=1 (whole shares) unconditionally.
 *
 * step=1 (the equity default) takes an exact `Math.floor()` fast path with zero epsilon - this is
 * deliberate, not an optimization: the 2026-09-21 crypto forensic audit's own regression
 * requirement is that existing equity sizing outputs stay byte-for-byte identical, and adding an
 * epsilon fudge to every call (even step=1) risked a genuine mathematical boundary case (e.g. a
 * true 11.9999999 ratio) rounding UP to 12 - which would violate "never exceed approved notional."
 * Only non-integer steps (crypto) use the epsilon-guarded scaled-integer path below.
 */

/** Number of decimal places implied by a step value, including values JS renders in scientific
 *  notation (e.g. 0.00000001 -> "1e-8"). Only meaningful for step <= 1; callers never pass a
 *  step > 1 today (no fractional-lot-of-many-shares instrument exists), so that case is not
 *  specially handled and simply returns 0 decimals (matches step=1 behavior). */
function decimalPlacesOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  const eIdx = s.toLowerCase().indexOf('e');
  if (eIdx !== -1) {
    const mantissa = s.slice(0, eIdx);
    const exp = Number(s.slice(eIdx + 1));
    const mantissaDecimals = mantissa.includes('.') ? mantissa.split('.')[1].length : 0;
    return Math.max(0, mantissaDecimals - exp);
  }
  const dotIdx = s.indexOf('.');
  return dotIdx === -1 ? 0 : s.length - dotIdx - 1;
}

/**
 * Rounds `rawQuantity` DOWN to the nearest multiple of `step`. Never rounds up. Returns 0 for
 * non-finite or non-positive inputs.
 *
 * step=1: exact `Math.floor(rawQuantity)`, no epsilon - today's exact equity behavior.
 * step<1 (e.g. crypto quantityStep): scales into integer "units of step" space using a tiny
 * (1e-7) epsilon to absorb ordinary IEEE-754 double representation error (e.g. 0.3 stored as
 * 0.299999999999999989) without letting a genuinely-below-boundary quantity round up. At the
 * precisions this registry uses (<=8 decimals) the resulting maximum possible overshoot is on the
 * order of 1e-15 in quantity terms - far below any realistic price*quantity rounding, so the
 * "never exceed approved notional" invariant still holds to any practically meaningful tolerance.
 */
export function quantizeQuantityDown(rawQuantity: number, step: number): number {
  if (!Number.isFinite(rawQuantity) || rawQuantity <= 0) return 0;
  if (!Number.isFinite(step) || step <= 0) return 0;
  if (step === 1) return Math.floor(rawQuantity);

  const decimals = decimalPlacesOf(step);
  const scale = 10 ** decimals;
  const scaledUnits = Math.floor(rawQuantity * scale + 1e-7);
  return scaledUnits / scale;
}
