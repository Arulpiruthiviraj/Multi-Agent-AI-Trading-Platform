import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPortfolio = vi.fn();
const mockGetActiveBroker = vi.fn(() => ({ portfolio: mockPortfolio }));

vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: {
    getInstance: () => ({ getActiveBroker: mockGetActiveBroker }),
  },
}));

vi.mock('../engines/TradingEngine', () => ({
  tradingEngine: {
    state: {
      enabled: true,
      tradingMode: 'PAPER',
      tradingState: 'TRADING_ENABLED',
      emergencyStopActive: false,
      budget: 50_000,
    },
    getScheduleWindowStatus: () => ({ inWindow: true, sessionLabel: 'MARKET_OPEN' }),
  },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        limit: vi.fn(async () => [{ budget: 50_000, maxPortfolioDrawdownPct: 0.15, peakEquity: 100_000 }]),
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
  },
}));

describe('buildInitialStateSnapshot', () => {
  beforeEach(() => {
    mockPortfolio.mockReset();
    mockGetActiveBroker.mockClear();
  });

  it('includes broker portfolio numbers when broker is available', async () => {
    mockPortfolio.mockResolvedValue({
      equity: 100_035.17,
      cash: 99_405.17,
      dailyPnl: 35.18,
      positions: [{ symbol: 'AAPL', quantity: 10, marketValue: 630, currentPrice: 63 }],
    });

    const { buildInitialStateSnapshot } = await import('./wsInitialSnapshot');
    const snap = await buildInitialStateSnapshot();

    expect(snap.portfolio.available).toBe(true);
    expect(snap.portfolio.equity).toBe(100_035.17);
    expect(snap.portfolio.cash).toBe(99_405.17);
    expect(snap.portfolio.intradayPl).toBe(35.18);
    expect(snap.settings.auto_bot_enabled).toBe(true);
    expect(snap.settings.trading_mode).toBe('PAPER');
    expect(snap.positions).toHaveLength(1);
  });

  it('returns partial snapshot when broker throws', async () => {
    mockPortfolio.mockRejectedValue(new Error('broker down'));

    const { buildInitialStateSnapshot } = await import('./wsInitialSnapshot');
    const snap = await buildInitialStateSnapshot();

    expect(snap.portfolio.available).toBe(false);
    expect(snap.portfolio.equity).toBeNull();
    expect(snap.settings.trading_state).toBe('TRADING_ENABLED');
  });
});
