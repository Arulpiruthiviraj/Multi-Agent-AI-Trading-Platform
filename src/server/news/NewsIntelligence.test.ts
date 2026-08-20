import { describe, it, expect } from 'vitest';
import {
  deriveMateriality,
  mapCategoryToCatalystType,
  mapTimeHorizonToExpectedHorizon,
  deriveNovelty,
  deriveLocalMarketSurpriseProxy,
  deriveRiskAssessment,
} from './NewsIntelligence';

describe('NewsIntelligence (Phase F3 structured, evidence-derived dimensions)', () => {
  describe('deriveMateriality', () => {
    it('buckets NewsImpactEngine real impactScore values correctly', () => {
      expect(deriveMateriality(0.1)).toBe('LOW');
      expect(deriveMateriality(0.5)).toBe('MEDIUM');   // General/Dividend/Legal/Technology today
      expect(deriveMateriality(0.8)).toBe('HIGH');     // Macro today
      expect(deriveMateriality(0.9)).toBe('CRITICAL'); // Earnings/M&A today
    });
    it('is inclusive at the exact boundaries', () => {
      expect(deriveMateriality(0.3)).toBe('MEDIUM');
      expect(deriveMateriality(0.6)).toBe('HIGH');
      expect(deriveMateriality(0.85)).toBe('CRITICAL');
    });
  });

  describe('mapCategoryToCatalystType', () => {
    it('maps every real NewsClassifier category', () => {
      expect(mapCategoryToCatalystType('Earnings')).toBe('EARNINGS');
      expect(mapCategoryToCatalystType('Dividend')).toBe('CAPITAL_RETURN');
      expect(mapCategoryToCatalystType('M&A')).toBe('M_AND_A');
      expect(mapCategoryToCatalystType('Macro')).toBe('MACRO');
      expect(mapCategoryToCatalystType('Legal')).toBe('LEGAL');
      expect(mapCategoryToCatalystType('Technology')).toBe('PRODUCT');
      expect(mapCategoryToCatalystType('General')).toBe('OTHER');
    });
    it('falls back to OTHER for an unrecognized category rather than throwing', () => {
      expect(mapCategoryToCatalystType('SomethingNew')).toBe('OTHER');
    });
  });

  describe('mapTimeHorizonToExpectedHorizon', () => {
    it('maps every real NewsImpactEngine value', () => {
      expect(mapTimeHorizonToExpectedHorizon('Intraday')).toBe('INTRADAY');
      expect(mapTimeHorizonToExpectedHorizon('Swing')).toBe('MEDIUM_TERM');
    });
    it('falls back to UNKNOWN for an unrecognized value rather than guessing', () => {
      expect(mapTimeHorizonToExpectedHorizon('Whatever')).toBe('UNKNOWN');
    });
  });

  describe('deriveNovelty', () => {
    it('is maximal (1) for a brand-new cluster', () => {
      expect(deriveNovelty(true, 0)).toBe(1);
    });
    it('decreases monotonically as more articles corroborate the same event', () => {
      const n1 = deriveNovelty(false, 1);
      const n2 = deriveNovelty(false, 2);
      const n5 = deriveNovelty(false, 5);
      expect(n1).toBeGreaterThan(n2);
      expect(n2).toBeGreaterThan(n5);
      expect(n5).toBeGreaterThan(0); // never hits exactly zero
    });
  });

  describe('deriveLocalMarketSurpriseProxy', () => {
    it('is documented as a heuristic proxy: scales with novelty and sentiment magnitude, clamped 0-1', () => {
      expect(deriveLocalMarketSurpriseProxy(1, 1)).toBe(1);
      expect(deriveLocalMarketSurpriseProxy(0, 1)).toBe(0);
      expect(deriveLocalMarketSurpriseProxy(1, 0)).toBe(0);
      const mid = deriveLocalMarketSurpriseProxy(0.5, 0.5);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(1);
    });
  });

  describe('deriveRiskAssessment (Phase F4 - directional vs. risk separation)', () => {
    it('is low-risk for a credible, corroborated, non-contradictory report', () => {
      const result = deriveRiskAssessment(0.95, false, 0.1, 0.6);
      expect(result.riskLevel).toBe('LOW');
      expect(result.riskVeto).toBe(false);
      expect(result.riskVetoReason).toBeNull();
    });

    it('flags high risk (and a veto) for contradictory evidence even with a bullish/credible source', () => {
      // Mirrors the spec's own example: "A bullish article may still have high risk because the
      // information is uncertain."
      const withoutContradiction = deriveRiskAssessment(0.9, false, 0.1, 0.4);
      const withContradiction = deriveRiskAssessment(0.9, true, 0.1, 0.4);
      expect(withContradiction.riskScore).toBeGreaterThan(withoutContradiction.riskScore);
      expect(withContradiction.riskVeto).toBe(true);
      expect(withContradiction.riskVetoReason).toContain('Contradictory evidence');
    });

    it('flags low-credibility as a risk factor even without contradiction', () => {
      const result = deriveRiskAssessment(0.1, false, 0.1, 0.4);
      expect(result.riskVeto).toBe(true);
      expect(result.riskVetoReason).toContain('Low source credibility');
    });

    it('is more cautious about a brand-new, uncorroborated report than a well-corroborated one', () => {
      const brandNew = deriveRiskAssessment(0.7, false, 1, 0.6);
      const corroborated = deriveRiskAssessment(0.7, false, 0.1, 0.6);
      expect(brandNew.riskScore).toBeGreaterThan(corroborated.riskScore);
    });

    it('riskVeto respects the configured threshold, not a hardcoded one', () => {
      const lenient = deriveRiskAssessment(0.6, false, 0.1, 0.9);
      const strict = deriveRiskAssessment(0.6, false, 0.1, 0.1);
      expect(lenient.riskVeto).toBe(false);
      expect(strict.riskVeto).toBe(true);
    });

    it('never produces a NaN or out-of-range riskScore', () => {
      const result = deriveRiskAssessment(2, true, 5, 0.6); // deliberately out-of-range inputs
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(result.riskScore).toBeLessThanOrEqual(1);
      expect(Number.isFinite(result.riskScore)).toBe(true);
    });
  });
});
