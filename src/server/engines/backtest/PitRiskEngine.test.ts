import { describe, it, expect } from 'vitest';
import { evaluatePitRisk, PitRiskContext } from './PitRiskEngine';
import { tradingSafety } from '../../config/tradingSafety';
import { INVALID_ACCOUNT_EQUITY } from '../AccountEquity';

function weekdayOpenMs(): number {
  // 2024-01-16 15:00 UTC = 10:00 America/New_York (Tuesday RTH)
  return Date.UTC(2024, 0, 16, 15, 0, 0);
}

function baseCtx(overrides: Partial<PitRiskContext> = {}): PitRiskContext {
  const nowMs = weekdayOpenMs();
  return {
    nowMs,
    timeframe: '1Day',
    tradingState: 'TRADING_ENABLED',
    side: 'BUY',
    symbol: 'AAPL',
    currentPrice: 100,
    equityNow: 100000,
    buyingPower: 100000,
    dayStartEquity: 100000,
    dailyLossLimitDollars: 5000,
    peakEquity: 100000,
    maxPortfolioDrawdownPct: 0.15,
    recentClosedPnlsNewestFirst: [],
    buyTimestampsMs: [],
    maxOrdersPerMinute: 5,
    existingPositions: [],
    maxTradeSizeDollar: 3000,
    maxPortfolioRiskPct: 0.02,
    maxOpenPositions: 10,
    allocatedBudget: 100000,
    tradingMode: 'PAPER',
    dailyBuyRows: [],
    getRecentCloses: async () => null,
    pitNews: [],
    barTimestampMs: nowMs,
    ...overrides,
  };
}

describe('evaluatePitRisk — live RiskEngine gate ladder on simulated state', () => {
  it('approves a well-sized weekday BUY with valid equity', async () => {
    const r = await evaluatePitRisk(baseCtx());
    expect(r.approved).toBe(true);
    expect(r.maxQuantity).toBeGreaterThan(0);
    expect(r.rejectionGate).toBeNull();
    expect(r.gateResults.map(g => g.gate)).toContain('daily_loss');
    expect(r.gateResults.map(g => g.gate)).toContain('portfolio_drawdown');
    expect(r.gateResults.map(g => g.gate)).toContain('argus_capital_allocation');
  });

  it('vetoes INVALID_ACCOUNT_EQUITY when equity is missing or non-positive', async () => {
    const r = await evaluatePitRisk(baseCtx({ equityNow: 0 }));
    expect(r.approved).toBe(false);
    expect(r.maxQuantity).toBe(0);
    expect(r.rejectionGate).toBe(INVALID_ACCOUNT_EQUITY);
  });

  it('vetoes daily_loss at the same kill-switch fraction as live', async () => {
    const limit = 1000;
    const start = 10000;
    const atOrOver = start - limit * tradingSafety.dailyLossKillSwitchFraction;
    const r = await evaluatePitRisk(baseCtx({
      equityNow: atOrOver,
      dayStartEquity: start,
      dailyLossLimitDollars: limit,
      peakEquity: start,
      buyingPower: atOrOver,
    }));
    expect(r.approved).toBe(false);
    expect(r.rejectionGate).toBe('daily_loss');
  });

  it('vetoes consecutive_loss using tradingSafety.maxConsecutiveLosses', async () => {
    const losses = Array(tradingSafety.maxConsecutiveLosses).fill(-1);
    const r = await evaluatePitRisk(baseCtx({ recentClosedPnlsNewestFirst: losses }));
    expect(r.approved).toBe(false);
    expect(r.rejectionGate).toBe('consecutive_loss');
  });

  it('vetoes portfolio_drawdown at the configured peak-to-trough pct', async () => {
    const r = await evaluatePitRisk(baseCtx({
      equityNow: 85,
      dayStartEquity: 85,
      peakEquity: 100,
      maxPortfolioDrawdownPct: 0.15,
      buyingPower: 85,
      allocatedBudget: 85,
    }));
    expect(r.approved).toBe(false);
    expect(r.rejectionGate).toBe('portfolio_drawdown');
  });

  it('vetoes news when PIT impact exceeds the live threshold and publication is not in the future', async () => {
    const nowMs = weekdayOpenMs();
    const r = await evaluatePitRisk(baseCtx({
      nowMs,
      barTimestampMs: nowMs,
      pitNews: [{
        symbol: 'AAPL',
        impactScore: tradingSafety.newsVetoMinImpactScore + 1,
        publishedAtMs: nowMs - 60_000,
      }],
    }));
    expect(r.approved).toBe(false);
    expect(r.rejectionGate).toBe('news_veto');
  });

  it('does not apply a future-published news hit (look-ahead forbidden at query time)', async () => {
    const nowMs = weekdayOpenMs();
    const r = await evaluatePitRisk(baseCtx({
      nowMs,
      barTimestampMs: nowMs,
      pitNews: [{
        symbol: 'AAPL',
        impactScore: 99,
        publishedAtMs: nowMs + 60_000,
      }],
    }));
    expect(r.gateResults.find(g => g.gate === 'news_veto')?.passed).toBe(true);
  });

  it('fail-closes weekend market_hours even on daily bars', async () => {
    const saturday = Date.UTC(2024, 0, 13, 15, 0, 0);
    const r = await evaluatePitRisk(baseCtx({ nowMs: saturday, barTimestampMs: saturday }));
    expect(r.approved).toBe(false);
    expect(r.rejectionGate).toBe('market_hours');
  });
});
