import { describe, it, expect, beforeEach } from 'vitest';
import {
  LIVE_TRADING_CONFIRMATION_PHRASE,
  armLiveTrading,
  disarmLiveTrading,
  isLiveTradingArmed,
  assertLiveOrdersArmed,
} from './LiveTradingConfirmation';

describe('LiveTradingConfirmation runtime arm', () => {
  beforeEach(() => disarmLiveTrading());

  it('rejects wrong phrase and stays disarmed', () => {
    expect(armLiveTrading('wrong')).toBe(false);
    expect(isLiveTradingArmed()).toBe(false);
    expect(assertLiveOrdersArmed().ok).toBe(false);
    expect(assertLiveOrdersArmed().reason).toMatch(/LIVE_ARM_REQUIRED/);
  });

  it('arms only on exact phrase and disarms cleanly', () => {
    expect(armLiveTrading(LIVE_TRADING_CONFIRMATION_PHRASE)).toBe(true);
    expect(isLiveTradingArmed()).toBe(true);
    expect(assertLiveOrdersArmed().ok).toBe(true);
    disarmLiveTrading();
    expect(isLiveTradingArmed()).toBe(false);
    expect(assertLiveOrdersArmed().ok).toBe(false);
  });
});
