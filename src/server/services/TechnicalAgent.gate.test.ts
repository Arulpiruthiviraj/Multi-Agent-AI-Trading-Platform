import { describe, it, expect, afterEach } from 'vitest';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { tradingEngine } from '../engines/TradingEngine';
import { technicalAgent } from './TechnicalAgent';

describe('idea generation start gate', () => {
  const originalEnabled = tradingEngine.state.enabled;
  const originalTradingState = tradingEngine.state.tradingState;

  afterEach(() => {
    tradingEngine.state.enabled = originalEnabled;
    tradingEngine.state.tradingState = originalTradingState;
    delete (technicalAgent as any).priceHistory['GATE_TEST_XYZ'];
  });

  it('is closed when Autobot is off even if tradingState is TRADING_ENABLED', () => {
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
  });

  it('is closed when tradingState is TRADING_PAUSED even if Autobot is on', () => {
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_PAUSED';
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
  });

  it('TechnicalAgent ignores Autobot-off ticks (no price-history warmup)', () => {
    tradingEngine.state.enabled = false;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    technicalAgent.analyzeTick({ symbol: 'GATE_TEST_XYZ', price: 10, volume: 1, timestamp: new Date().toISOString() });
    expect((technicalAgent as any).priceHistory['GATE_TEST_XYZ']).toBeUndefined();
  });
});
