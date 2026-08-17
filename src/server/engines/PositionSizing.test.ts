import { describe, it, expect } from 'vitest';
import { calculatePositionSizing, returnCorrelation, getSector, SizingContext } from './PositionSizing';

function baseCtx(overrides: Partial<SizingContext> = {}): SizingContext {
  return {
    side: 'BUY',
    symbol: 'AAPL',
    currentPrice: 100,
    accountEquity: 100000,
    buyingPower: 100000,
    maxTradeSizeDollar: 3000,
    maxPortfolioRiskPct: 0.02,
    existingPositions: [],
    maxOpenPositions: 10,
    getRecentCloses: async () => null,
    ...overrides,
  };
}

describe('calculatePositionSizing - real, shared RiskEngine/BacktestEngine sizing math', () => {
  it('caps size by the order-notional (maxTradeSizeDollar) limit when it is the binding constraint', async () => {
    const result = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 1000, currentPrice: 100 }));
    expect(result.maxQuantity).toBe(10); // 1000/100
    const gate = result.gates.find(g => g.gate === 'order_notional_cap');
    expect(gate?.detail.isBinding).toBe(true);
  });

  it('caps size by buying power when it is thinner than the notional cap', async () => {
    const result = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 10000, buyingPower: 500, currentPrice: 100 }));
    expect(result.maxQuantity).toBe(5); // 500/100
  });

  it('caps a BUY by single-symbol concentration (20% of equity) when an existing position already uses most of the room', async () => {
    const result = await calculatePositionSizing(baseCtx({
      accountEquity: 100000, currentPrice: 100, maxTradeSizeDollar: 100000, buyingPower: 100000,
      existingPositions: [{ symbol: 'AAPL', quantity: 190 }], // 190*100=19000, cap is 20000 -> only 10 more shares of room
    }));
    expect(result.maxQuantity).toBe(10);
  });

  it('rejects opening a brand-new position when maxOpenPositions is already reached', async () => {
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'NEWSYM', existingPositions: [{ symbol: 'A', quantity: 1 }, { symbol: 'B', quantity: 1 }],
      maxOpenPositions: 2,
    }));
    expect(result.maxQuantity).toBe(0);
    expect(result.gates.find(g => g.gate === 'open_positions_cap')?.passed).toBe(false);
  });

  it('does NOT block on open_positions_cap when adding to an already-existing position', async () => {
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'A', existingPositions: [{ symbol: 'A', quantity: 1 }, { symbol: 'B', quantity: 1 }],
      maxOpenPositions: 2,
    }));
    expect(result.gates.find(g => g.gate === 'open_positions_cap')?.passed).toBe(true);
  });

  it('caps combined exposure across positively correlated symbols beyond 50% of equity', async () => {
    const closesA = Array.from({ length: 30 }, (_, i) => 100 + i);
    const closesB = Array.from({ length: 30 }, (_, i) => 50 + i * 0.5); // moves in lockstep with A
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'AAPL', currentPrice: 100, accountEquity: 100000, maxTradeSizeDollar: 1000000, buyingPower: 1000000,
      existingPositions: [{ symbol: 'MSFT', quantity: 490 }], // 490*100 = 49000, close to the 50000 cap
      getRecentCloses: async (sym) => (sym === 'AAPL' ? closesA : sym === 'MSFT' ? closesB : null),
    }));
    const gate = result.gates.find(g => g.gate === 'correlation_exposure');
    expect(gate?.detail.correlatedValue).toBeCloseTo(49000, 0);
    expect(result.maxQuantity).toBeLessThanOrEqual(10); // only ~1000 of the 50000 cap remains
  });

  it('does NOT cap a strongly NEGATIVELY correlated position - that is a hedge, not concentration', async () => {
    // Real anti-correlated RETURNS (not just opposite price levels, which doesn't imply
    // anti-correlated returns): A alternates +1%/-1% each day; B does the exact opposite.
    const closesA = [100]; const closesB = [100];
    for (let i = 0; i < 30; i++) {
      const aUp = i % 2 === 0;
      closesA.push(closesA[closesA.length - 1] * (aUp ? 1.01 : 0.99));
      closesB.push(closesB[closesB.length - 1] * (aUp ? 0.99 : 1.01));
    }
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'AAPL', currentPrice: 100, accountEquity: 100000, maxTradeSizeDollar: 1000000, buyingPower: 1000000,
      existingPositions: [{ symbol: 'MSFT', quantity: 490 }],
      getRecentCloses: async (sym) => (sym === 'AAPL' ? closesA : sym === 'MSFT' ? closesB : null),
    }));
    const gate = result.gates.find(g => g.gate === 'correlation_exposure');
    expect(gate?.detail.correlatedValue).toBe(0); // negative correlation never counted
  });

  it('skips correlation entirely (never blocks) when real price history is unavailable', async () => {
    const result = await calculatePositionSizing(baseCtx({
      existingPositions: [{ symbol: 'MSFT', quantity: 1 }],
      getRecentCloses: async () => null,
    }));
    const gate = result.gates.find(g => g.gate === 'correlation_exposure');
    expect(gate?.detail.skipped).toBe(true);
    expect(gate?.passed).toBe(true);
    expect(gate?.detail.status).toBe('SKIPPED');
  });

  it('LIVE fail-closed: missing correlation history is UNKNOWN FAIL not PASS', async () => {
    const result = await calculatePositionSizing(baseCtx({
      existingPositions: [{ symbol: 'MSFT', quantity: 1 }],
      getRecentCloses: async () => null,
      failClosedUnknownInputs: true,
    }));
    const gate = result.gates.find(g => g.gate === 'correlation_exposure');
    expect(gate?.passed).toBe(false);
    expect(gate?.detail.status).toBe('UNKNOWN');
    expect(result.maxQuantity).toBe(0);
  });

  it('fails symbol_concentration when remaining dollars floor to zero shares', async () => {
    const result = await calculatePositionSizing(baseCtx({
      accountEquity: 100000, currentPrice: 100, maxTradeSizeDollar: 100000, buyingPower: 100000,
      existingPositions: [{ symbol: 'AAPL', quantity: 199.6 }],
    }));
    expect(result.maxQuantity).toBe(0);
    expect(result.gates.find(g => g.gate === 'symbol_concentration')?.passed).toBe(false);
    expect(result.gates.find(g => g.gate === 'sufficient_size')?.passed).toBe(false);
  });

  it('BUY-only gates (symbol/sector/open-positions/correlation) are not evaluated for a SELL proposal, matching RiskEngine\'s pre-refactor behavior', async () => {
    const result = await calculatePositionSizing(baseCtx({ side: 'SELL', existingPositions: [{ symbol: 'AAPL', quantity: 10 }] }));
    for (const gate of ['symbol_concentration', 'open_positions_cap', 'sector_concentration', 'correlation_exposure']) {
      expect(result.gates.find(g => g.gate === gate)).toBeUndefined();
    }
  });

  it('real bug fixed: a SELL is never capped by buying power, order-notional, or risk-per-share - those are new-capital-deployment concepts and must never shrink or block a protective exit', async () => {
    // A near-fully-deployed portfolio: almost no buying power left, and a position (500 shares)
    // worth far more than the flat order-notional cap or the risk-based cap would allow to BUY.
    // Before the fix, maxSharesByBuyingPower = floor(50/100) = 0 alone would have zeroed out the
    // entire SELL - the real, verified failure mode this test guards against.
    const result = await calculatePositionSizing(baseCtx({
      side: 'SELL',
      currentPrice: 100,
      buyingPower: 50, // far less than one share's worth
      maxTradeSizeDollar: 3000, // would cap a BUY at 30 shares
      maxPortfolioRiskPct: 0.02, // would cap a BUY well under 500 shares too
      existingPositions: [{ symbol: 'AAPL', quantity: 500 }],
    }));
    expect(result.maxQuantity).toBeGreaterThanOrEqual(500);
    const notionalGate = result.gates.find(g => g.gate === 'order_notional_cap');
    expect(notionalGate?.passed).toBe(true);
    expect(notionalGate?.detail.status).toBe('SKIPPED');
    expect(result.gates.find(g => g.gate === 'sufficient_size')?.passed).toBe(true);
  });

  it('a SELL with zero buying power and zero equity-derived room still is not blocked by this module (RiskEngine.ts clamps to held quantity downstream)', async () => {
    const result = await calculatePositionSizing(baseCtx({
      side: 'SELL',
      buyingPower: 0,
      maxTradeSizeDollar: 0,
      existingPositions: [{ symbol: 'AAPL', quantity: 10 }],
    }));
    expect(result.maxQuantity).toBeGreaterThan(0);
    expect(result.gates.find(g => g.gate === 'sufficient_size')?.passed).toBe(true);
  });

  it('fail-closes INVALID_ACCOUNT_EQUITY when account equity is missing or not positive', async () => {
    const result = await calculatePositionSizing(baseCtx({ accountEquity: 0 }));
    expect(result.maxQuantity).toBe(0);
    expect(result.gates.find(g => g.gate === 'invalid_account_equity')?.passed).toBe(false);
  });

  it('sufficient_size fails when the computed quantity is zero', async () => {
    const result = await calculatePositionSizing(baseCtx({ buyingPower: 0 }));
    expect(result.maxQuantity).toBe(0);
    expect(result.gates.find(g => g.gate === 'sufficient_size')?.passed).toBe(false);
  });

  // E2B (BACKTEST_QUANT_HARDENING_ANALYSIS.md)
  describe('sizingMode', () => {
    it('omitting sizingMode is byte-identical to explicit FIXED_DOLLAR - no behavior change for existing callers', async () => {
      const withoutMode = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 1000, currentPrice: 100 }));
      const withMode = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 1000, currentPrice: 100, sizingMode: 'FIXED_DOLLAR' }));
      expect(withoutMode.maxQuantity).toBe(withMode.maxQuantity);
      expect(withoutMode.maxQuantity).toBe(10); // 1000/100, unchanged from the pre-E2B test above
    });

    it('PERCENT_OF_EQUITY derives the notional cap from current equity, not the flat maxTradeSizeDollar', async () => {
      const result = await calculatePositionSizing(baseCtx({
        accountEquity: 200000, currentPrice: 100, maxTradeSizeDollar: 1000000, buyingPower: 1000000,
        sizingMode: 'PERCENT_OF_EQUITY', percentOfEquityPct: 2, // 2% of 200000 = 4000 -> 40 shares
      }));
      expect(result.maxQuantity).toBe(40);
      const gate = result.gates.find(g => g.gate === 'order_notional_cap');
      expect(gate?.detail.sizingMode).toBe('PERCENT_OF_EQUITY');
      expect(gate?.detail.effectiveNotionalCapDollar).toBe(4000);
    });

    it('PERCENT_OF_EQUITY still respects single-symbol concentration exactly like FIXED_DOLLAR does', async () => {
      const result = await calculatePositionSizing(baseCtx({
        accountEquity: 100000, currentPrice: 100, maxTradeSizeDollar: 1000000, buyingPower: 1000000,
        sizingMode: 'PERCENT_OF_EQUITY', percentOfEquityPct: 50, // deliberately huge notional room (50000)
        existingPositions: [{ symbol: 'AAPL', quantity: 190 }], // same fixture as the concentration test above
      }));
      expect(result.maxQuantity).toBe(10); // concentration cap (20% of equity) still binds, unchanged
    });

    it('PERCENT_OF_EQUITY still respects buying-power and risk-based caps as hard floors', async () => {
      const result = await calculatePositionSizing(baseCtx({
        accountEquity: 1000000, currentPrice: 100, buyingPower: 500, // thin buying power
        sizingMode: 'PERCENT_OF_EQUITY', percentOfEquityPct: 50,
      }));
      expect(result.maxQuantity).toBe(5); // 500/100, buying-power cap still binds regardless of mode
    });
  });
});

describe('returnCorrelation', () => {
  it('returns null with too little overlapping history', () => {
    expect(returnCorrelation([1, 2, 3], [1, 2, 3])).toBeNull();
  });

  it('returns near +1 for two series moving in lockstep', () => {
    const a = Array.from({ length: 30 }, (_, i) => 100 + i);
    const b = Array.from({ length: 30 }, (_, i) => 50 + i * 0.5);
    expect(returnCorrelation(a, b)).toBeGreaterThan(0.9);
  });
});

describe('getSector', () => {
  it('maps a known large-cap symbol to its real sector', () => {
    expect(getSector('AAPL')).toBe('Technology');
  });

  it('returns null for an unmapped symbol - never fabricates a sector guess', () => {
    expect(getSector('SOME_RANDOM_TICKER')).toBeNull();
  });

  it('exempts diversified ETFs rather than mis-bucketing them into a sector', () => {
    expect(getSector('SPY')).toBeNull();
  });
});
