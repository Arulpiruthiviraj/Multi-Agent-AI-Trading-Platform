import { describe, it, expect, beforeEach } from 'vitest';
import { recordNewsCatalyst, getNewsCatalysts, clearNewsCatalystsForTests } from './NewsCatalystStore';

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
});
