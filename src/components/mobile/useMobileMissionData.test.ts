import { describe, it, expect, beforeEach } from 'vitest';
import { getMobileMissionSnapshot, resetMobileMissionSnapshot } from './mobileMissionStore';
import { applyInitialStateSnapshot } from './useMobileMissionData';

describe('applyInitialStateSnapshot', () => {
  beforeEach(() => {
    resetMobileMissionSnapshot();
  });

  it('hydrates portfolio and trading state from WS snapshot', () => {
    applyInitialStateSnapshot({
      portfolio: {
        available: true,
        equity: 100_035.17,
        cash: 99_405.17,
        budget: 50_000,
        intradayPl: 35.18,
        drawdownPct: 0.002,
        peakValuation: 100_100,
        positions: [{ symbol: 'AAPL', quantity: 1 }],
      },
      settings: {
        trading_mode: 'PAPER',
        trading_state: 'TRADING_ENABLED',
        auto_bot_enabled: true,
        maxPortfolioDrawdownPct: 0.15,
      },
      consensus: { side: 'BUY', weightedConfidence: 0.82, threshold: 0.75, approved: true },
      autobot: { emergencyStopActive: false, scheduleWindow: { sessionLabel: 'MARKET_OPEN' } },
    });

    const snap = getMobileMissionSnapshot();
    expect(snap.portfolio?.equity).toBe(100_035.17);
    expect(snap.portfolio?.cash).toBe(99_405.17);
    expect(snap.settings?.budget).toBe(50_000);
    expect(snap.capital?.dailyPnl).toBe(35.18);
    expect(snap.autobotEnabled).toBe(true);
    expect(snap.consensus.side).toBe('BUY');
    expect(snap.marketSession).toBe('MARKET_OPEN');
  });
});
