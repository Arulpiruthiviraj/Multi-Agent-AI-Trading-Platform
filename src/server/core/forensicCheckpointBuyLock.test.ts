import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearForensicCheckpointBuyLock,
  getForensicCheckpointBuyLockInfo,
  isForensicCheckpointBuyLocked,
  resetForensicCheckpointBuyLockForTests,
  setForensicCheckpointBuyLock,
} from './forensicCheckpointBuyLock';

describe('forensicCheckpointBuyLock', () => {
  beforeEach(() => resetForensicCheckpointBuyLockForTests());

  it('starts unlocked and soft-locks after set', () => {
    expect(isForensicCheckpointBuyLocked()).toBe(false);
    setForensicCheckpointBuyLock('first_fill_portfolio_mismatch');
    expect(isForensicCheckpointBuyLocked()).toBe(true);
    const info = getForensicCheckpointBuyLockInfo();
    expect(info.locked).toBe(true);
    expect(info.reason).toBe('first_fill_portfolio_mismatch');
    expect(info.lockedAt).toBeTruthy();
  });

  it('clear / reset unlocks without touching tradingState', () => {
    setForensicCheckpointBuyLock('test');
    clearForensicCheckpointBuyLock();
    expect(isForensicCheckpointBuyLocked()).toBe(false);
    expect(getForensicCheckpointBuyLockInfo().reason).toBeNull();
  });
});
