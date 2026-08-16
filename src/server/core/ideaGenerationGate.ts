/**
 * Idea agents must not emit TRADE_IDEA_GENERATED from MARKET_DATA unless Autobot is on
 * and tradingState is TRADING_ENABLED. Ticks may still be recorded for warmup.
 */
import { tradingEngine } from '../engines/TradingEngine';

export function isLiveIdeaGenerationEnabled(): boolean {
  return tradingEngine.state.tradingState === 'TRADING_ENABLED' && tradingEngine.state.enabled === true;
}
