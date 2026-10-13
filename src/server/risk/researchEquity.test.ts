import { describe, it, expect, beforeEach } from 'vitest';
import { computeResearchEquity, resetResearchPeakForTests } from './researchEquity';

const today = (iso: string) => iso.startsWith('2026-10-12');
beforeEach(() => resetResearchPeakForTests());

describe('researchEquity', () => {
  it('ignores broker equity entirely: a flat $20k book has zero loss and zero drawdown', () => {
    const s = computeResearchEquity({ budget: 20000, closedTrades: [], positions: [], isToday: today });
    expect(s.equity).toBe(20000); expect(s.dailyLoss).toBe(0); expect(s.drawdownPct).toBe(0);
  });
  it('daily loss = today realized + current unrealized, against the research budget', () => {
    const s = computeResearchEquity({
      budget: 20000,
      closedTrades: [{ profitLoss: -17, filledAt: '2026-10-12T19:57:51Z' }, { profitLoss: 500, filledAt: '2026-10-09T15:00:00Z' }],
      positions: [{ quantity: 38, entryPrice: 25.82, currentPrice: 25.0, unrealizedPnl: null }],
      isToday,
    } as any);
    expect(s.realizedToday).toBe(-17);
    expect(s.unrealized).toBeCloseTo(-31.16, 2);
    expect(s.dailyLoss).toBeCloseTo(48.16, 2);
    expect(s.equity).toBeCloseTo(20000 + 483 - 31.16, 2);
  });
  it('drawdown is measured from the research peak (a $1,000 slide on $20k is 5%, not 0.1% of $1M)', () => {
    computeResearchEquity({ budget: 20000, closedTrades: [{ profitLoss: 1000, filledAt: '2026-10-01T15:00:00Z' }], positions: [], isToday: today });
    const s = computeResearchEquity({
      budget: 20000,
      closedTrades: [{ profitLoss: 1000, filledAt: '2026-10-01T15:00:00Z' }, { profitLoss: -1050, filledAt: '2026-10-12T15:00:00Z' }],
      positions: [], isToday: today,
    });
    expect(s.peakEquity).toBe(21000);
    expect(s.drawdownPct).toBeCloseTo(1050 / 21000, 6);
  });
  it('an unvalued position is counted, not silently priced at zero P&L', () => {
    const s = computeResearchEquity({ budget: 20000, closedTrades: [], positions: [{ quantity: 5, entryPrice: null, currentPrice: null, unrealizedPnl: null }], isToday: today });
    expect(s.unrealizedUnvaluedPositions).toBe(1);
  });
});
function isToday(iso: string) { return today(iso); }

describe('researchEquity net of commissions (2026-10-13)', () => {
  it('trades.profit_loss is gross: entry and exit commissions are deducted from equity and daily loss', () => {
    const s = computeResearchEquity({
      budget: 20000,
      closedTrades: [{ profitLoss: -100, filledAt: '2026-10-12T15:00:00Z' }],
      fills: [
        { commission: 0.11, filledAt: '2026-10-12T14:00:00Z' },
        { commission: 0.11, filledAt: '2026-10-12T15:00:00Z' },
        { commission: null, filledAt: '2026-10-12T15:30:00Z' }, // no real evidence: never guessed
      ],
      positions: [], isToday: today,
    });
    expect(s.feesToday).toBeCloseTo(0.22, 6);
    expect(s.realizedToday).toBeCloseTo(-100.22, 6);
    expect(s.dailyLoss).toBeCloseTo(100.22, 6);
    expect(s.equity).toBeCloseTo(20000 - 100.22, 6);
  });
  it('a gross-winning round trip whose fees exceed the gain is a net loss for the brakes', () => {
    const s = computeResearchEquity({
      budget: 20000,
      closedTrades: [{ profitLoss: 0.10, filledAt: '2026-10-12T15:00:00Z' }],
      fills: [{ commission: 0.11, filledAt: '2026-10-12T14:00:00Z' }, { commission: 0.11, filledAt: '2026-10-12T15:00:00Z' }],
      positions: [], isToday: today,
    });
    expect(s.dailyLoss).toBeCloseTo(0.12, 6);
  });
  it('omitting fills keeps the previous gross behaviour (backward compatible)', () => {
    const s = computeResearchEquity({ budget: 20000, closedTrades: [{ profitLoss: -5, filledAt: '2026-10-12T15:00:00Z' }], positions: [], isToday: today });
    expect(s.feesAllTime).toBe(0); expect(s.dailyLoss).toBe(5);
  });
});
