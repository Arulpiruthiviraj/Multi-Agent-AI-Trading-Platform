import { describe, it, expect } from 'vitest';
import { validateDiscoveryGap, type DiscoveryGapEvidence } from './discoveryGapEvidence';
const now = Date.parse('2026-09-17T15:00:00Z');
const valid: DiscoveryGapEvidence = {
  source: 'ALPACA_IEX_SNAPSHOT', price: 105, open: 100, previousClose: 99,
  priceTimestamp: '2026-09-17T14:59:00Z', openTimestamp: '2026-09-17T04:00:00Z',
  previousCloseTimestamp: '2026-09-16T04:00:00Z', high: 106, low: 99,
  corporateActionState: 'UNKNOWN',
};
describe('discovery gap provenance', () => {
  it('computes same-session return from verifiable references', () => {
    expect(validateDiscoveryGap(valid, now).gapPct).toBeCloseTo(.05);
  });
  it('preserves extreme real returns without a magnitude cutoff', () => {
    expect(validateDiscoveryGap({ ...valid, price: 1000, high: 1000 }, now).gapPct).toBe(9);
  });
  it('does not infer corporate actions or reject a ratio to the previous close', () => {
    expect(validateDiscoveryGap({ ...valid, previousClose: .01 }, now).gapPct).toBeCloseTo(.05);
  });
  it.each([0, -1, NaN, Infinity, undefined])('quarantines invalid opens (%s)', open => {
    expect(validateDiscoveryGap({ ...valid, open }, now).gapPct).toBeNull();
  });
  it('quarantines opens inconsistent with the source session range', () => {
    expect(validateDiscoveryGap({ ...valid, open: .05 }, now).reason).toBe('OPEN_OUTSIDE_SESSION_RANGE');
  });
  it.each(['priceTimestamp', 'openTimestamp', 'previousCloseTimestamp'] as const)('requires %s', key => {
    expect(validateDiscoveryGap({ ...valid, [key]: null }, now).gapPct).toBeNull();
  });
  it('rejects stale sessions even with plausible reference ratios', () => {
    expect(validateDiscoveryGap({ ...valid, openTimestamp: '2026-09-16T04:00:00Z' }, now).gapPct).toBeNull();
  });
  it('rejects future quotes', () => {
    expect(validateDiscoveryGap({ ...valid, priceTimestamp: '2026-09-17T15:01:00Z' }, now).gapPct).toBeNull();
  });
  it('rejects previous-close references from the current session', () => {
    expect(validateDiscoveryGap({ ...valid, previousCloseTimestamp: valid.openTimestamp }, now).gapPct).toBeNull();
  });
});
