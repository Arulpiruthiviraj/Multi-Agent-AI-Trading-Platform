import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tradingSafety } from '../config/tradingSafety';

describe('ChiefTrader consensusAggregationWindowMs', () => {
  it('is configured in the 500–1000ms co-evaluation band (does not lower 0.75/min-2)', () => {
    expect(tradingSafety.consensusAggregationWindowMs).toBeGreaterThanOrEqual(500);
    expect(tradingSafety.consensusAggregationWindowMs).toBeLessThanOrEqual(1000);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });
});

describe('FinBertService scoreAndPublishNewsSentiment', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('publishes NEWS_SENTIMENT_SCORED when FinBERT returns a score', async () => {
    vi.doMock('../ai/LocalSentiment', () => ({
      getFinBertSentiment: vi.fn(async () => ({
        model: 'finbert-test',
        label: 'positive',
        score: 0.91,
        signedScore: 0.82,
      })),
    }));
    const publish = vi.fn();
    vi.doMock('../core/EventBus', () => ({ eventBus: { publish } }));

    const { scoreAndPublishNewsSentiment } = await import('./FinBertService');
    const r = await scoreAndPublishNewsSentiment({ text: 'NVDA beats estimates', symbol: 'NVDA' });
    expect(r?.signedScore).toBe(0.82);
    expect(publish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signedScore: 0.82, symbol: 'NVDA' }),
    );
  });
});
