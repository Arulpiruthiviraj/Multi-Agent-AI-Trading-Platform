import { describe, it, expect } from 'vitest';
import { NullTradingAgentsShadowAdapter, isTradingAgentsShadowEnabled } from './tradingAgentsShadow';

describe('TradingAgents shadow scaffold (Phase 11 - scaffold only, nothing wired to anything live)', () => {
  it('the only real adapter always returns null - never fabricates an opinion', async () => {
    const adapter = new NullTradingAgentsShadowAdapter();
    const opinion = await adapter.getShadowOpinion({ symbol: 'AAPL', timestampMs: Date.now(), currentPrice: 200 });
    expect(opinion).toBeNull();
  });

  it('defaults to disabled - no operator has set TRADING_AGENTS_SHADOW_ENABLED', () => {
    delete process.env.TRADING_AGENTS_SHADOW_ENABLED;
    expect(isTradingAgentsShadowEnabled()).toBe(false);
  });
});
