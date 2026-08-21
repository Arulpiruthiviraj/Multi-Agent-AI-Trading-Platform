/**
 * Tick-driven *entry* idea agents must ignore MARKET_DATA unless Autobot is on
 * (`tradingEngine.state.enabled`) and tradingState is TRADING_ENABLED.
 * After an interrupted OS session, new BUY ideas stay held until RECONCILIATION_MATCH.
 * PortfolioMonitor risk-exit SELL does not use this gate.
 *
 * `isAutobotTradingEnabled` is the tick-bus / recon / inventory condition.
 * `isLiveIdeaGenerationEnabled` additionally holds *entry* ideas after a dirty OS kill
 * AND when the optional daily campaign BUY soft-lock is active
 * (`isCampaignBuyLocked` — LOCK_AND_IDLE / TRAIL_STOPS_ONLY only; see CampaignTracker).
 *
 * Combined entry gate (documented):
 *   isLiveIdeaGenerationEnabled() ===
 *     isAutobotTradingEnabled() && allowsNewEntryIdeas() && !isCampaignBuyLocked()
 *
 * Campaign lock disarms NEW BUY idea generation only. It is not EMERGENCY_STOP.
 * ChiefTrader still allows risk-exit SELLs via `isRiskExit` when this returns false.
 * Do not gate MarketDataWorker emission on the interrupted-session hold — that would
 * starve price cache consumers and the SELL loop.
 */
import { tradingEngine } from '../engines/TradingEngine';
import { allowsNewEntryIdeas } from './sessionRecovery';
import { isCampaignBuyLocked } from './campaignBuyLock';

export function isAutobotTradingEnabled(): boolean {
  return tradingEngine.state.tradingState === 'TRADING_ENABLED'
    && tradingEngine.state.enabled === true;
}

export function isLiveIdeaGenerationEnabled(): boolean {
  return isAutobotTradingEnabled() && allowsNewEntryIdeas() && !isCampaignBuyLocked();
}
