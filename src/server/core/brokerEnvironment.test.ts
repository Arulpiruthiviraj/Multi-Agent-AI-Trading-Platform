import { describe, it, expect } from 'vitest';
import { classifyBrokerEnvironment, resolveOmsPaperMode } from './brokerEnvironment';

describe('resolveOmsPaperMode (DEF-TODAY-02)', () => {
  it('forces paper when PAPER_TRADING_ONLY is enforced', () => {
    expect(resolveOmsPaperMode({
      paperTradingOnly: true,
      tradingMode: 'LIVE',
      storedPaperMode: false,
      capabilities: { paperTrading: true, liveTrading: true },
      brokerId: 'ibkr_gateway',
    })).toBe(true);
  });

  it('treats IBKR dual-capable + Paper settings + missing row as paper', () => {
    expect(resolveOmsPaperMode({
      paperTradingOnly: false,
      tradingMode: 'Paper',
      storedPaperMode: null,
      capabilities: { paperTrading: true, liveTrading: true },
      brokerId: 'ibkr_gateway',
    })).toBe(true);
  });

  it('respects stored paperMode=true', () => {
    expect(resolveOmsPaperMode({
      tradingMode: 'Paper',
      storedPaperMode: true,
      capabilities: { paperTrading: true, liveTrading: true },
    })).toBe(true);
  });

  it('classifies PAPER when tradingMode Paper and paperMode true', () => {
    expect(classifyBrokerEnvironment({ tradingMode: 'Paper', paperMode: true })).toBe('PAPER');
  });
});
