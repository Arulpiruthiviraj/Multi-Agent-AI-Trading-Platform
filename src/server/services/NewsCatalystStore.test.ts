import { describe, it, expect, beforeEach } from 'vitest';
import { recordNewsCatalyst, getNewsCatalysts, clearNewsCatalystsForTests, hasRealCatalystEvidence } from './NewsCatalystStore';

describe('NewsCatalystStore', () => {
  beforeEach(() => clearNewsCatalystsForTests());

  it('stores catalysts without implying an order', () => {
    // Whether NewsEngine actually emits TRADE_IDEA_GENERATED (newsAgentEmitsTradeIdeas(), gated by
    // config/deskIntelligence.json's newsAgentMode) is a separate concern from this store's own
    // job: recording/retrieving catalyst data never itself implies or places an order. Previously
    // asserted newsAgentEmitsTradeIdeas() === false here, which broke when newsAgentMode's
    // documented default changed to ACTIVE_VOTE (DEF-TODAY-05) - that assertion belongs in
    // deskIntelligence's own tests, not hardcoded as an unrelated precondition in this file.
    recordNewsCatalyst({
      traceId: 't1',
      symbol: 'aapl',
      headline: 'Test',
      source: 'unit',
      publishedAtMs: 1,
      sentiment: 0.4,
      credibility: 0.9,
      catalystStrength: 'MODERATE',
      tradingBias: 'BULLISH',
      contribution: 0.18,
      reasoning: 'unit',
      recordedAt: new Date().toISOString(),
    });
    expect(getNewsCatalysts('AAPL')[0].contribution).toBe(0.18);
    expect(getNewsCatalysts('AAPL')[0].symbol).toBe('AAPL');
  });

  describe('hasRealCatalystEvidence (Phase 28, 2026-09-02 P0 discovery fix)', () => {
    it('returns false when no catalyst has ever been recorded for the symbol', () => {
      expect(hasRealCatalystEvidence('ZZNC')).toBe(false);
    });

    it('returns true for a real HIGH-strength, non-neutral catalyst - the exact real FRVO evidence shape', () => {
      recordNewsCatalyst({
        traceId: 't2', symbol: 'zznc', headline: 'Real catalyst', source: 'unit', publishedAtMs: 1,
        sentiment: 0.5, credibility: 0.9, catalystStrength: 'HIGH', tradingBias: 'BULLISH',
        contribution: 0.2, reasoning: 'unit', recordedAt: new Date().toISOString(),
      });
      expect(hasRealCatalystEvidence('ZZNC')).toBe(true);
    });

    it('returns true for MODERATE strength too - reuses the exact same bar recordNewsCatalyst() itself uses for open-staging', () => {
      recordNewsCatalyst({
        traceId: 't3', symbol: 'ZZNC', headline: 'Moderate catalyst', source: 'unit', publishedAtMs: 1,
        sentiment: -0.4, credibility: 0.8, catalystStrength: 'MODERATE', tradingBias: 'BEARISH',
        contribution: 0.15, reasoning: 'unit', recordedAt: new Date().toISOString(),
      });
      expect(hasRealCatalystEvidence('ZZNC')).toBe(true);
    });

    it('returns false for a LOW-strength catalyst - not real enough evidence to grant priority', () => {
      recordNewsCatalyst({
        traceId: 't4', symbol: 'ZZNC', headline: 'Weak catalyst', source: 'unit', publishedAtMs: 1,
        sentiment: 0.1, credibility: 0.5, catalystStrength: 'LOW', tradingBias: 'BULLISH',
        contribution: 0.05, reasoning: 'unit', recordedAt: new Date().toISOString(),
      });
      expect(hasRealCatalystEvidence('ZZNC')).toBe(false);
    });

    it('returns false for a NEUTRAL-bias catalyst regardless of strength - never treats a directionless headline as a real trading catalyst', () => {
      recordNewsCatalyst({
        traceId: 't5', symbol: 'ZZNC', headline: 'Neutral news', source: 'unit', publishedAtMs: 1,
        sentiment: 0, credibility: 0.9, catalystStrength: 'HIGH', tradingBias: 'NEUTRAL',
        contribution: 0, reasoning: 'unit', recordedAt: new Date().toISOString(),
      });
      expect(hasRealCatalystEvidence('ZZNC')).toBe(false);
    });
  });
});
