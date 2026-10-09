import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordNewsCatalyst, getNewsCatalysts, clearNewsCatalystsForTests, hasRealCatalystEvidence } from './NewsCatalystStore';

// D3 tests need the in-RTH (ACTIVE, non-staged) path: force regular-session so shouldStage
// is false and recordNewsCatalyst respects the caller-passed expiresAtMs. Existing tests
// above read back immediately after recording, so they pass identically either way.
vi.mock('../news/newsSessionCadence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../news/newsSessionCadence')>();
  return { ...actual, isUsEquityRegularSession: () => true };
});

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

  describe('D3: expired catalysts are not evidence (2026-10-08 defect hunt)', () => {
    const base = {
      traceId: 'd3', symbol: 'D3T', headline: 'Catalyst', source: 'unit', publishedAtMs: 1,
      sentiment: 0.5, credibility: 0.9, catalystStrength: 'HIGH' as const, tradingBias: 'BULLISH' as const,
      contribution: 0.2, reasoning: 'unit', recordedAt: new Date().toISOString(),
    };

    it('excludes a catalyst whose expiresAtMs is in the past from getNewsCatalysts', () => {
      recordNewsCatalyst({ ...base, traceId: 'd3-past', expiresAtMs: Date.now() - 1000 });
      expect(getNewsCatalysts('D3T')).toEqual([]);
    });

    it('an expired catalyst does not count as real catalyst evidence', () => {
      recordNewsCatalyst({ ...base, traceId: 'd3-past2', expiresAtMs: Date.now() - 1000 });
      expect(hasRealCatalystEvidence('D3T')).toBe(false);
    });

    it('ACTIVE catalysts now get a real future TTL instead of never expiring', () => {
      const recorded = recordNewsCatalyst({ ...base, traceId: 'd3-active' });
      expect(recorded.status).toBe('ACTIVE');
      expect(recorded.expiresAtMs).not.toBeNull();
      expect(recorded.expiresAtMs!).toBeGreaterThan(Date.now());
      // Still live evidence right after recording.
      expect(hasRealCatalystEvidence('D3T')).toBe(true);
    });
  });
});
