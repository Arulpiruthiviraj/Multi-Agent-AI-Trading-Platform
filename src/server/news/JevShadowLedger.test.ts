/**
 * JevShadowLedger tests — agreement computation is pure and fully covered here.
 * DB round-trips are intentionally NOT tested (sandbox has no migration runner in
 * unit tests); recordShadowScore's best-effort catch is covered by code review.
 */
import { describe, it, expect } from 'vitest';
import { computeSentimentAgreement } from './JevShadowLedger';

describe('computeSentimentAgreement', () => {
  it('agrees on matching directions', () => {
    expect(computeSentimentAgreement('bullish', 'BULLISH')).toBe(1);
    expect(computeSentimentAgreement('bearish', 'BEARISH')).toBe(1);
    expect(computeSentimentAgreement('neutral', 'NEUTRAL')).toBe(1);
  });

  it('disagrees on opposing directions', () => {
    expect(computeSentimentAgreement('bullish', 'BEARISH')).toBe(0);
    expect(computeSentimentAgreement('bearish', 'BULLISH')).toBe(0);
  });

  it('neutral vs directional counts as disagreement', () => {
    expect(computeSentimentAgreement('neutral', 'BULLISH')).toBe(0);
    expect(computeSentimentAgreement('bullish', 'NEUTRAL')).toBe(0);
  });
});
