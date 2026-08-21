/**
 * In-memory daily-campaign BUY soft-lock state.
 *
 * Kept separate from CampaignTracker / MarketDataWorker so ideaGenerationGate can consult it
 * without creating a circular import (CampaignTracker → MarketDataWorker → ideaGenerationGate).
 *
 * Semantics: when locked for today's America/New_York session, NEW entry idea generation is
 * blocked via ideaGenerationGate. SELL/exits (PortfolioMonitor risk-exit path) are not gated here.
 * Not EMERGENCY_STOP / not a second kill switch.
 */
import { getTradingDateStr } from './TradingCalendar';

export type CampaignLockAction = 'LOCK_AND_IDLE' | 'TRAIL_STOPS_ONLY';

let buyLockedForTradingDate: string | null = null;
// Which target-reached action produced today's lock - PortfolioMonitor reads this (not a new
// import cycle back to CampaignTracker) to decide whether to tighten trailing stops under
// TRAIL_STOPS_ONLY specifically, without conflating it with LOCK_AND_IDLE's plain BUY soft-lock.
let buyLockedAction: CampaignLockAction | null = null;

export function isCampaignBuyLocked(now: Date = new Date()): boolean {
  const today = getTradingDateStr(now);
  if (buyLockedForTradingDate == null) return false;
  if (buyLockedForTradingDate !== today) {
    buyLockedForTradingDate = null;
    buyLockedAction = null;
    return false;
  }
  return true;
}

export function setCampaignBuyLock(tradingDate: string, action: CampaignLockAction = 'LOCK_AND_IDLE'): void {
  buyLockedForTradingDate = tradingDate;
  buyLockedAction = action;
}

export function clearCampaignBuyLockState(): string | null {
  const previous = buyLockedForTradingDate;
  buyLockedForTradingDate = null;
  buyLockedAction = null;
  return previous;
}

export function getCampaignBuyLockDate(): string | null {
  return buyLockedForTradingDate;
}

/** Null unless today's lock is active AND was set for this exact action. */
export function getCampaignBuyLockAction(now: Date = new Date()): CampaignLockAction | null {
  return isCampaignBuyLocked(now) ? buyLockedAction : null;
}

/** Test-only helpers. */
export function setCampaignBuyLockedForTests(locked: boolean, tradingDate?: string, action: CampaignLockAction = 'LOCK_AND_IDLE'): void {
  buyLockedForTradingDate = locked ? (tradingDate ?? getTradingDateStr()) : null;
  buyLockedAction = locked ? action : null;
}

export function resetCampaignBuyLockForTests(): void {
  buyLockedForTradingDate = null;
  buyLockedAction = null;
}
