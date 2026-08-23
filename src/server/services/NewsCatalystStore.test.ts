import { describe, it, expect, beforeEach } from 'vitest';
import { recordNewsCatalyst, getNewsCatalysts, clearNewsCatalystsForTests } from './NewsCatalystStore';
import { newsAgentEmitsTradeIdeas } from '../config/deskIntelligence';

describe('NewsCatalystStore', () => {
  beforeEach(() => clearNewsCatalystsForTests());

  it('stores catalysts without implying an order', () => {
    expect(newsAgentEmitsTradeIdeas()).toBe(false);
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
