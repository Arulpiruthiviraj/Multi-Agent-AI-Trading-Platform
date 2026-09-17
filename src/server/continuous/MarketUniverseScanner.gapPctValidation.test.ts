import { describe, it, expect } from 'vitest';
import { computeValidatedGapPct } from './MarketUniverseScanner';

/**
 * 2026-09-16 data-integrity fix regression suite. Real defect: gapPct = (price - dailyBar.o) /
 * dailyBar.o had only an `openPrice > 0` guard - confirmed live producing 985%/394%/356%/342%/315%
 * "gaps" for illiquid symbols, physically implausible for ordinary single-session equity moves.
 * This proves the fix (cross-validation against prevDailyBar.c, mirroring SnapshotScanner.ts's own
 * already-validated reference-price requirement) rejects corrupted reference prices to UNKNOWN
 * (null) while explicitly preserving legitimate extreme gaps.
 *
 * Honest, disclosed scope limit: the Alpaca snapshot response does not carry an independent
 * per-field timestamp or symbol tag on dailyBar/prevDailyBar - there is no data available to
 * separately validate "wrong trading date" / "wrong session" / "mismatched symbol" beyond what the
 * ratio cross-check against prevDailyBar.c already catches as a side effect (a wrong-session or
 * wrong-symbol value would almost always also fail the plausibility ratio). This suite tests what
 * is actually verifiable from the real API response shape, not a hypothetical richer one.
 */
describe('computeValidatedGapPct', () => {
  it('normal gap (flat open): computes the real value', () => {
    expect(computeValidatedGapPct(100, 100, 99)).toBeCloseTo(0, 6);
  });

  it('normal 5% intraday move since open, with a consistent prevClose: preserved', () => {
    expect(computeValidatedGapPct(105, 100, 99)).toBeCloseTo(0.05, 6);
  });

  it('normal 20% move, consistent prevClose: preserved', () => {
    expect(computeValidatedGapPct(120, 100, 98)).toBeCloseTo(0.2, 6);
  });

  it('normal 50% move, consistent prevClose: preserved', () => {
    expect(computeValidatedGapPct(150, 100, 97)).toBeCloseTo(0.5, 6);
  });

  it('legitimate extreme gap (e.g. a real binary-catalyst biotech move, ~300%): preserved, never capped', () => {
    // open itself gapped hard vs prevClose (a real, dramatic but plausible overnight move - within
    // the documented 20x ratio bound), then continued moving intraday.
    const result = computeValidatedGapPct(50, 40, 12);
    expect(result).toBeCloseTo((50 - 40) / 40, 6); // 25% intraday-since-open, not rejected
  });

  it('legitimate reverse-split-compatible ratio (1-for-10): preserved, not treated as corruption', () => {
    // open ~10x prevClose - a real, plausible reverse-split shape, within the 20x documented bound.
    expect(computeValidatedGapPct(105, 100, 10)).toBeCloseTo(0.05, 6);
  });

  it('stale/corrupted open (near-zero) with a normal prevClose: rejected to UNKNOWN, matching the real observed defect shape (RETO/MEDS/PDYNW class)', () => {
    // price=$50 (normal), openPrice=$0.05 (a stale/erroneous fractional print), prevClose=$49
    // (normal) - ratio openPrice/prevClose is ~0.001, far outside the 20x/1/20x band.
    expect(computeValidatedGapPct(50, 0.05, 49)).toBeNull();
  });

  it('zero open: rejected (pre-existing guard, still enforced)', () => {
    expect(computeValidatedGapPct(50, 0, 49)).toBeNull();
  });

  it('negative open: rejected', () => {
    expect(computeValidatedGapPct(50, -5, 49)).toBeNull();
  });

  it('missing open (undefined): rejected, never fabricated', () => {
    expect(computeValidatedGapPct(50, undefined, 49)).toBeNull();
  });

  it('non-numeric open (malformed API response): rejected', () => {
    expect(computeValidatedGapPct(50, 'not-a-number' as unknown as number, 49)).toBeNull();
  });

  it('NaN/Infinity open: rejected', () => {
    expect(computeValidatedGapPct(50, NaN, 49)).toBeNull();
    expect(computeValidatedGapPct(50, Infinity, 49)).toBeNull();
  });

  it('wildly inconsistent open vs prevClose in the other direction (open far ABOVE prevClose, no real corporate-action explanation): rejected to UNKNOWN', () => {
    // openPrice $500 vs prevClose $1 - ratio 500x, far outside the 20x band. A real 500x overnight
    // move is not a plausible single-session event for any real listed equity.
    expect(computeValidatedGapPct(500, 500, 1)).toBeNull();
  });

  it('no prevDailyBar.c available: falls back to the weaker absolute-floor guard, still rejects an unambiguous glitch value', () => {
    expect(computeValidatedGapPct(50, 0.0001, undefined)).toBeNull(); // below gapPctMinAbsoluteOpenPrice
  });

  it('no prevDailyBar.c available: a real, plausible open is still computed (weaker guard is not overly strict)', () => {
    const result = computeValidatedGapPct(105, 100, undefined);
    expect(result).toBeCloseTo(0.05, 6);
  });

  it('no prevDailyBar.c available, prevClose is zero/negative/malformed: treated the same as unavailable, not as a false-normal reference', () => {
    expect(computeValidatedGapPct(105, 100, 0)).toBeCloseTo(0.05, 6); // falls back correctly, still a real value
    expect(computeValidatedGapPct(105, 100, -5)).toBeCloseTo(0.05, 6);
  });

  it('a corrupted reference price never silently becomes a valid discovery gap - the core invariant', () => {
    const corruptedInputs: Array<[number, number, number]> = [
      [50, 0.001, 49],
      [50, 0.05, 49],
      [1, 1000, 1],
    ];
    for (const [price, open, prev] of corruptedInputs) {
      expect(computeValidatedGapPct(price, open, prev)).toBeNull();
    }
  });
});
