/**
 * JevShadowLedger tests — agreement computation is pure and fully covered here.
 * DB round-trips are intentionally NOT tested (sandbox has no migration runner in
 * unit tests); recordShadowScore's best-effort catch is covered by code review.
 */
import { describe, it, expect, vi } from 'vitest';
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

describe('ledger DB failure paths (fail-safe defaults)', () => {
  it('getCalibrationSummary returns zeroed summary when the DB throws - never propagates', async () => {
    vi.resetModules();
    vi.doMock('../db', () => ({
      db: {
        select: () => { throw new Error('db down'); },
      },
    }));
    const { getCalibrationSummary } = await import('./JevShadowLedger');
    const summary = await getCalibrationSummary();
    expect(summary.totalScored).toBe(0);
    expect(summary.withLlmComparison).toBe(0);
    expect(summary.sentimentAgreementRate).toBeNull();
    expect(summary.estimatedCostUsd).toBe(0);
    vi.resetModules();
    vi.doUnmock('../db');
  });

  it('analyzeAgreementByConfidence returns empty buckets and an insufficient-data recommendation when the DB throws', async () => {
    vi.resetModules();
    vi.doMock('../db', () => ({
      db: {
        select: () => { throw new Error('db down'); },
      },
    }));
    const { analyzeAgreementByConfidence } = await import('./JevShadowLedger');
    const analysis = await analyzeAgreementByConfidence();
    expect(analysis.buckets).toHaveLength(5);
    for (const b of analysis.buckets) {
      expect(b.compared).toBe(0);
      expect(b.agreementRate).toBeNull();
    }
    expect(analysis.recommendation).toContain('insufficient');
    vi.resetModules();
    vi.doUnmock('../db');
  });
});
