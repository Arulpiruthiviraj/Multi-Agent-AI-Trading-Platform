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

  // Real 2026-08-21 TSLA/RIOT BROKER_ENVIRONMENT_UNKNOWN rejections (data/argus.db trades rows
  // 1b8f549f.../60697e63...): reproduced with an un-normalized tradingMode (null/empty), no
  // PAPER_TRADING_ONLY enforcement, and no brokerConnections row yet for the active broker.
  // classifyBrokerEnvironment correctly refuses ambiguity here - this is fail-closed BY DESIGN,
  // not the defect. The real defect was OrderManagement.ts's readTradingMode() returning that raw,
  // un-normalized DB value instead of routing it through normalizeTradingMode() first (fixed in
  // OrderManagement.ts; see the paired test below proving the normalized value resolves).
  it('fails closed to UNKNOWN when tradingMode is unresolved, matching the pre-fix TSLA/RIOT rejections', () => {
    const paperMode = resolveOmsPaperMode({
      paperTradingOnly: false,
      tradingMode: null,
      storedPaperMode: null,
      capabilities: { paperTrading: true, liveTrading: true },
      brokerId: 'alpaca',
    });
    expect(paperMode).toBeNull();
    expect(classifyBrokerEnvironment({ tradingMode: null, paperMode })).toBe('UNKNOWN');
  });

  it('resolves Alpaca (paper+live capable) to PAPER once tradingMode is normalized, even without PAPER_TRADING_ONLY or a stored row', () => {
    const paperMode = resolveOmsPaperMode({
      paperTradingOnly: false,
      tradingMode: 'PAPER', // what normalizeTradingMode(null | '' | legacy) now guarantees
      storedPaperMode: null,
      capabilities: { paperTrading: true, liveTrading: true },
      brokerId: 'alpaca',
    });
    expect(paperMode).toBe(true);
    expect(classifyBrokerEnvironment({ tradingMode: 'PAPER', paperMode })).toBe('PAPER');
  });
});
