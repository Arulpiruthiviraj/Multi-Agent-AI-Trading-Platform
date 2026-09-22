import { describe, it, expect } from 'vitest';
import { calculatePositionSizing, returnCorrelation, getSector, SizingContext } from './PositionSizing';
import { tradingSafety } from '../config/tradingSafety';

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
  it('uses the distinct holding price for cross-sector correlated exposure', async () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 100000,
      existingPositions: [{ symbol: 'JPM', quantity: 120, mark: { price: 400, priceAgeMs: 0, source: 'ibkr_gateway' } }],
      getRecentCloses: async () => closes,
    }));
    expect(result.gates.find(g => g.gate === 'correlation_exposure')?.detail.correlatedValue).toBe(48000);
    expect(result.maxQuantity).toBe(Math.min(200, Math.floor((100000 * tradingSafety.maxCorrelatedExposurePct - 48000) / 100)));
  });

  it.each([null, 0, NaN, Infinity])('rejects an invalid required holding price %s', async price => {
    const result = await calculatePositionSizing(baseCtx({ existingPositions: [
      { symbol: 'MSFT', quantity: 1, mark: { price, priceAgeMs: 0, source: 'ibkr_gateway' } },
    ] }));
    expect(result.maxQuantity).toBe(0);
    expect(result.gates.find(g => g.gate === 'sector_concentration')?.detail.reason).toBe('HOLDING_VALUATION_UNAVAILABLE');
  });
  it('values another sector holding at its own observed price, not the proposed price', async () => {
    const result = await calculatePositionSizing(baseCtx({
      currentPrice: 100, maxTradeSizeDollar: 100000,
      existingPositions: [{ symbol: 'MSFT', quantity: 95, mark: { price: 400, priceAgeMs: 0, source: 'ibkr_gateway' } }],
    }));
    const sector = result.gates.find(g => g.gate === 'sector_concentration')!;
    expect(sector.detail.sectorValue).toBe(38000);
    expect(result.maxQuantity).toBe(Math.min(200, Math.floor((100000 * tradingSafety.maxSectorConcentrationPct - 38000) / 100)));
  });

  it.each([null, -1, NaN, tradingSafety.stalePriceThresholdMs + 1])('fails a required holding valuation with unavailable/stale age %s', async age => {
    const result = await calculatePositionSizing(baseCtx({ existingPositions: [
      { symbol: 'MSFT', quantity: 1, mark: { price: 400, priceAgeMs: age, source: 'ibkr_gateway' } },
    ] }));
    expect(result.maxQuantity).toBe(0);
    expect(result.gates.find(g => g.gate === 'sector_concentration')?.detail.reason).toBe('HOLDING_VALUATION_UNAVAILABLE');
  });

  it('does not use missing holding marks to block a protective SELL', async () => {
    const result = await calculatePositionSizing(baseCtx({ side: 'SELL', existingPositions: [
      { symbol: 'AAPL', quantity: 4 }, { symbol: 'MSFT', quantity: 1 },
    ] }));
    // Shared sizing leaves exits unconstrained; RiskEngine clamps to the held quantity.
    expect(result.maxQuantity).toBe(Number.MAX_SAFE_INTEGER);
  });
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

  it('real bug found and fixed: order_notional_cap reports FAIL, not PASS, when the risk-per-share cap alone zeroes out sizing', async () => {
    // maxRiskAmount = 1000 * 0.001 = 1; riskPerShare = 100 * 0.05 (STOP_LOSS_ASSUMPTION_PCT) = 5.
    // maxSharesByRisk = floor(1/5) = 0, while maxSharesByCapital=30 and maxSharesByBuyingPower=1000
    // are both healthy - the risk cap alone is what zeroes out maxQuantity, but before this fix
    // order_notional_cap's passed/status only ever looked at maxSharesByCapital and reported
    // PASS, hiding the real reason from the risk_gate_results audit trail (sufficient_size still
    // correctly failed and rejected the trade either way - this is an honesty/observability gap).
    const result = await calculatePositionSizing(baseCtx({
      currentPrice: 100, accountEquity: 1000, maxPortfolioRiskPct: 0.001,
      maxTradeSizeDollar: 3000, buyingPower: 100000,
    }));
    expect(result.maxQuantity).toBe(0);
    const gate = result.gates.find(g => g.gate === 'order_notional_cap');
    expect(gate?.detail.maxSharesByRisk).toBe(0);
    expect(gate?.detail.maxSharesByCapital).toBeGreaterThan(0);
    expect(gate?.passed).toBe(false);
    expect(gate?.detail.status).toBe('FAIL');
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
      existingPositions: [{ symbol: 'MSFT', quantity: 490, mark: { price: 100, priceAgeMs: 0, source: 'test_quote' } }], // 490*100 = 49000
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
      existingPositions: [{ symbol: 'MSFT', quantity: 490, mark: { price: 100, priceAgeMs: 0, source: 'test_quote' } }],
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

// Crypto Expansion Phase 1 (2026-09-21). quantityStep/minimumQuantity/minimumNotional are new,
// optional SizingContext fields - every test above this point omits them and must therefore
// observe byte-identical behavior to before this phase (proven by the full pre-existing suite
// above staying green unmodified). These tests instead exercise the new fractional path directly.
describe('calculatePositionSizing - Crypto Expansion Phase 1 fractional sizing', () => {
  it('equity regression: identical whole-share outputs with no quantityStep supplied', async () => {
    const a = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 3000, currentPrice: 250, buyingPower: 100000 }));
    expect(a.maxQuantity).toBe(12); // 3000/250
    const b = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 3000, currentPrice: 251, buyingPower: 100000 }));
    expect(b.maxQuantity).toBe(11); // floor(3000/251)
  });

  it('BTC-USD example: produces a non-zero fractional quantity, not zero', async () => {
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'BTC-USD', currentPrice: 60000, maxTradeSizeDollar: 3000, buyingPower: 100000,
      quantityStep: 0.00000001, minimumQuantity: 0.0001, minimumNotional: 10,
    }));
    // raw = 3000/60000 = 0.05 exactly representable at 8 decimals.
    expect(result.maxQuantity).toBe(0.05);
    expect(result.maxQuantity).toBeGreaterThan(0);
  });

  it('ETH-USD example: fractional quantity survives the full sizing path (concentration/sector/correlation all pass through)', async () => {
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'ETH-USD', currentPrice: 2500, maxTradeSizeDollar: 1000, buyingPower: 100000,
      quantityStep: 0.000001, minimumQuantity: 0.001, minimumNotional: 10,
    }));
    expect(result.maxQuantity).toBe(0.4); // 1000/2500
    expect(result.maxQuantity).toBeGreaterThan(0);
  });

  it('non-exact step rounding: floors to the instrument step, never up', async () => {
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'BTC-USD', currentPrice: 61237, maxTradeSizeDollar: 1000, buyingPower: 100000,
      quantityStep: 0.00000001, minimumQuantity: 0.0001, minimumNotional: 10,
    }));
    // raw = 1000/61237 = 0.016331... - must floor at 8 decimals, never round up.
    expect(result.maxQuantity).toBeLessThanOrEqual(1000 / 61237);
    expect(result.maxQuantity).toBeGreaterThan(0);
  });

  it('critical invariant: finalQuantity * price never exceeds approved notional, across many price/step combinations', async () => {
    const cases = [
      { price: 60000, step: 0.00000001, notional: 3000 },
      { price: 2500, step: 0.000001, notional: 1000 },
      { price: 123.45, step: 0.00000001, notional: 777 },
      { price: 1, step: 0.000001, notional: 50 },
    ];
    for (const c of cases) {
      const result = await calculatePositionSizing(baseCtx({
        symbol: 'BTC-USD', currentPrice: c.price, maxTradeSizeDollar: c.notional, buyingPower: 1_000_000,
        quantityStep: c.step, minimumQuantity: 0.00000001, minimumNotional: 0.01,
      }));
      expect(result.maxQuantity * c.price).toBeLessThanOrEqual(c.notional + 1e-6);
    }
  });

  it('minimum notional: rejects (size 0) rather than rounding up to meet the venue minimum', async () => {
    // Risk-approved capital permits $4; instrument minimum notional = $10 -> reject, don't inflate to $10.
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'BTC-USD', currentPrice: 60000, maxTradeSizeDollar: 4, buyingPower: 100000,
      quantityStep: 0.00000001, minimumQuantity: 0.0001, minimumNotional: 10,
    }));
    expect(result.maxQuantity).toBe(0);
    const gate = result.gates.find(g => g.gate === 'sufficient_size');
    expect(gate?.passed).toBe(false);
    expect(gate?.detail.reason).toBe('SIZE_REJECTED_MIN_NOTIONAL');
  });

  it('minimum quantity: rejects (size 0) rather than rounding up to meet the venue minimum', async () => {
    const result = await calculatePositionSizing(baseCtx({
      symbol: 'BTC-USD', currentPrice: 60000, maxTradeSizeDollar: 3000, buyingPower: 100000,
      quantityStep: 0.00000001, minimumQuantity: 0.1, minimumNotional: 10, // 3000/60000=0.05 < 0.1 minimum
    }));
    expect(result.maxQuantity).toBe(0);
    const gate = result.gates.find(g => g.gate === 'sufficient_size');
    expect(gate?.passed).toBe(false);
    expect(gate?.detail.reason).toBe('SIZE_REJECTED_MIN_QUANTITY');
  });

  it('minimum notional/quantity never applies to SELL - exits are never blocked by venue minimums', async () => {
    const result = await calculatePositionSizing(baseCtx({
      side: 'SELL', symbol: 'BTC-USD', currentPrice: 60000,
      existingPositions: [{ symbol: 'BTC-USD', quantity: 0.00005, mark: { price: 60000, priceAgeMs: 0, source: 'alpaca' } }],
      quantityStep: 0.00000001, minimumQuantity: 0.0001, minimumNotional: 10,
    }));
    // Shared sizing leaves exits unconstrained (RiskEngine clamps to held quantity) - same as the
    // pre-existing equity SELL test above, now also proven true with crypto minimums supplied.
    expect(result.maxQuantity).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('no minimums supplied (equity default): a small fractional-looking result is not rejected by the new logic', async () => {
    const result = await calculatePositionSizing(baseCtx({ maxTradeSizeDollar: 50, currentPrice: 100, buyingPower: 100000 }));
    expect(result.maxQuantity).toBe(0); // floor(50/100)=0 at step=1, same as always - not the new min-notional path
    const gate = result.gates.find(g => g.gate === 'sufficient_size');
    expect(gate?.detail.reason).toBeUndefined();
  });
});
