/**
 * Tick-driven idea agents must ignore MARKET_DATA unless Autobot is on
 * (`tradingEngine.state.enabled`, the same flag the UI calls autoBotConfig.enabled)
 * and tradingState is TRADING_ENABLED. No warmup from Autobot-off ticks.
 */
import { tradingEngine } from '../engines/TradingEngine';

export function isLiveIdeaGenerationEnabled(): boolean {
  return tradingEngine.state.tradingState === 'TRADING_ENABLED' && tradingEngine.state.enabled === true;
}
