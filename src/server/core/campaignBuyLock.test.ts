import { describe, it, expect, afterEach } from 'vitest';
import { getTradingDateStr } from './TradingCalendar';
import {
  isCampaignBuyLocked,
  setCampaignBuyLock,
  clearCampaignBuyLockState,
  getCampaignBuyLockDate,
  getCampaignBuyLockAction,
  setCampaignBuyLockedForTests,
  resetCampaignBuyLockForTests,
} from './campaignBuyLock';

/**
 * Real bug fix (Campaign Audit): TRAIL_STOPS_ONLY previously carried no action metadata, so
 * PortfolioMonitor could not distinguish it from LOCK_AND_IDLE to decide whether to tighten
 * trailing stops. These tests prove the action is recorded, isolated per trading day, and
 * cleared consistently by every reset path.
 */
describe('campaignBuyLock action tracking', () => {
  afterEach(() => {
    resetCampaignBuyLockForTests();
  });

  it('getCampaignBuyLockAction is null when nothing is locked', () => {
    expect(isCampaignBuyLocked()).toBe(false);
    expect(getCampaignBuyLockAction()).toBeNull();
  });

  it('defaults to LOCK_AND_IDLE when no action is passed', () => {
    const today = getTradingDateStr();
    setCampaignBuyLock(today);
    expect(isCampaignBuyLocked()).toBe(true);
    expect(getCampaignBuyLockAction()).toBe('LOCK_AND_IDLE');
  });

  it('records TRAIL_STOPS_ONLY distinctly from LOCK_AND_IDLE', () => {
    const today = getTradingDateStr();
    setCampaignBuyLock(today, 'TRAIL_STOPS_ONLY');
    expect(isCampaignBuyLocked()).toBe(true);
    expect(getCampaignBuyLockAction()).toBe('TRAIL_STOPS_ONLY');
  });

  it('clears the action when the lock expires on a new trading day', () => {
    const yesterday = '2020-01-01';
    setCampaignBuyLock(yesterday, 'TRAIL_STOPS_ONLY');
    expect(isCampaignBuyLocked()).toBe(false); // day boundary crossed - lock auto-expires
    expect(getCampaignBuyLockAction()).toBeNull();
    expect(getCampaignBuyLockDate()).toBeNull();
  });

  it('clearCampaignBuyLockState clears the action alongside the date', () => {
    const today = getTradingDateStr();
    setCampaignBuyLock(today, 'TRAIL_STOPS_ONLY');
    clearCampaignBuyLockState();
    expect(getCampaignBuyLockAction()).toBeNull();
    expect(getCampaignBuyLockDate()).toBeNull();
  });

  it('setCampaignBuyLockedForTests / resetCampaignBuyLockForTests round-trip the action', () => {
    setCampaignBuyLockedForTests(true, undefined, 'TRAIL_STOPS_ONLY');
    expect(getCampaignBuyLockAction()).toBe('TRAIL_STOPS_ONLY');

    resetCampaignBuyLockForTests();
    expect(getCampaignBuyLockAction()).toBeNull();
    expect(isCampaignBuyLocked()).toBe(false);
  });

  it('setCampaignBuyLockedForTests(false) clears the action even if previously set', () => {
    setCampaignBuyLockedForTests(true, undefined, 'TRAIL_STOPS_ONLY');
    setCampaignBuyLockedForTests(false);
    expect(getCampaignBuyLockAction()).toBeNull();
  });
});
