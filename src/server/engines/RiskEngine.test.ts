import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '../db/schema';
import { getTradingDateStr } from '../core/TradingCalendar';
import { tradingSafety } from '../config/tradingSafety';

// db.select().from(table)...limit()/where()/orderBy() all resolve to whatever rows were
// registered for that specific table via setTableRows(). Mirrors drizzle's own thenable
// query-builder shape closely enough for RiskEngine's read-only queries.
const { mockDb, setTableRows, resetTableRows } = vi.hoisted(() => {
  const resultsByTable = new Map<any, any[]>();
  let lastTable: any = null;
  const builder: any = {
    from(table: any) { lastTable = table; return builder; },
    where() { return builder; },
    orderBy() { return builder; },
    limit() { return builder; },
    then(resolve: any, reject: any) {
      return Promise.resolve(resultsByTable.get(lastTable) || []).then(resolve, reject);
    },
  };
  const mockDb = {
    select: () => builder,
    insert: () => ({ values: () => Promise.resolve({}) }),
    update: () => ({ set: () => ({ run: () => Promise.resolve({}) }) }),
  };
  return {
    mockDb,
    setTableRows: (table: any, rows: any[]) => resultsByTable.set(table, rows),
    resetTableRows: () => resultsByTable.clear(),
  };
});

const { mockBrokerHolder } = vi.hoisted(() => ({
  mockBrokerHolder: { broker: null as any },
}));

const { mockTradingEngine } = vi.hoisted(() => ({
  mockTradingEngine: {
    state: {
      dayStartDateStr: null as string | null,
      dayStartEquity: null as number | null,
      currentDailyLoss: 0,
      dailyLossLimit: 5000,
      tradingMode: 'PAPER',
      tradingState: 'TRADING_ENABLED' as 'TRADING_ENABLED' | 'TRADING_PAUSED' | 'EMERGENCY_STOP',
      emergencyStopActive: false,
      enabled: true,
      budget: 50000,
    },
  },
}));

const { mockMarketDataWorker } = vi.hoisted(() => ({
  mockMarketDataWorker: { getLatestPriceAgeMs: vi.fn(() => null as number | null) },
}));

const { emitRiskAssessment } = vi.hoisted(() => ({ emitRiskAssessment: vi.fn() }));

// Per-symbol daily-close series the correlation cap reads via getRecentCloses(). Real
// HistoricalDataGateway isn't exercised here - just its real return shape.
const { mockBarsBySymbol, mockHistoricalDataGateway } = vi.hoisted(() => {
  const mockBarsBySymbol: Record<string, number[]> = {};
  const mockHistoricalDataGateway = {
    getBars: vi.fn(async (symbol: string) => (mockBarsBySymbol[symbol] || []).map((close, i) => ({ timestamp: i, open: close, high: close, low: close, close, volume: 1000 }))),
    ensureBars: vi.fn(async () => {}),
  };
  return { mockBarsBySymbol, mockHistoricalDataGateway };
});

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { emitRiskAssessment, emit: vi.fn() } }));
vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: { getInstance: () => ({ getActiveBroker: () => mockBrokerHolder.broker }) },
}));
vi.mock('./TradingEngine', () => ({ tradingEngine: mockTradingEngine }));
vi.mock('../services/MarketDataWorker', () => ({ marketDataWorker: mockMarketDataWorker }));
vi.mock('./backtest/HistoricalDataGateway', () => ({ historicalDataGateway: mockHistoricalDataGateway }));

import { riskEngine, resetMarketClockCacheForTests } from './RiskEngine';

function makeBroker(portfolio: any) {
  return { portfolio: vi.fn(async () => portfolio) };
}

function basePortfolio(overrides: any = {}) {
  return {
    cash: 100000,
    buyingPower: 100000,
    equity: 100000,
    positions: [],
    ...overrides,
  };
}

function lastAssessment() {
  return emitRiskAssessment.mock.calls[emitRiskAssessment.mock.calls.length - 1][0];
}

describe('RiskEngine.evaluateRisk', () => {
  beforeEach(() => {
    resetTableRows();
    emitRiskAssessment.mockClear();
    mockMarketDataWorker.getLatestPriceAgeMs.mockReset();
    mockMarketDataWorker.getLatestPriceAgeMs.mockReturnValue(null);
    mockTradingEngine.state.dayStartDateStr = null;
    mockTradingEngine.state.dayStartEquity = null;
    mockTradingEngine.state.currentDailyLoss = 0;
    mockTradingEngine.state.dailyLossLimit = 5000;
    mockTradingEngine.state.tradingState = 'TRADING_ENABLED';
    mockTradingEngine.state.enabled = true;
    mockTradingEngine.state.emergencyStopActive = false;
    mockTradingEngine.state.budget = 1_000_000;
    mockTradingEngine.state.tradingMode = 'PAPER';
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 3000, budget: 1_000_000 }]);
    setTableRows(schema.riskAssessments, []);
    setTableRows(schema.trades, []);
    setTableRows(schema.newsClusters, []);
    for (const key of Object.keys(mockBarsBySymbol)) delete mockBarsBySymbol[key];
    mockBrokerHolder.broker = makeBroker(basePortfolio());
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    resetMarketClockCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks all trades once the daily-loss kill-switch threshold (80% of limit) is breached', async () => {
    mockTradingEngine.state.dailyLossLimit = 1000;
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 91500 })); // -8500 -> wait, use small numbers
    mockTradingEngine.state.dayStartDateStr = getTradingDateStr();
    mockTradingEngine.state.dayStartEquity = 100000;
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 99150 })); // loss of 850 = 85% of 1000 limit

    await riskEngine.evaluateRisk({ traceId: 't1', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/Daily Loss Kill-Switch/);
  });

  it('does not trip the daily-loss breaker below the 80% threshold', async () => {
    mockTradingEngine.state.dailyLossLimit = 1000;
    mockTradingEngine.state.dayStartDateStr = getTradingDateStr();
    mockTradingEngine.state.dayStartEquity = 100000;
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 99500 })); // loss of 500 = 50% of limit

    await riskEngine.evaluateRisk({ traceId: 't2', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/Daily Loss Kill-Switch/);
  });

  it('uses the real New York trading day, not UTC, for the daily-loss reset boundary (Phase 3 hardening)', async () => {
    // 2026-01-16T02:00:00Z is already "2026-01-16" under naive UTC, but real New York time at
    // this instant is still 2026-01-15 21:00 EST - the prior trading day. Pin the system clock
    // here and seed dayStartDateStr with the CORRECT (NY) date - if RiskEngine still computed
    // today's date via naive UTC, it would see '2026-01-16' != the seeded '2026-01-15' and
    // wrongly reset dayStartEquity to the current (lossy) equity, masking the real loss.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-16T02:00:00Z'));
    try {
      mockTradingEngine.state.dailyLossLimit = 1000;
      mockTradingEngine.state.dayStartDateStr = '2026-01-15';
      mockTradingEngine.state.dayStartEquity = 100000;
      mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 99500 })); // real loss of 500

      await riskEngine.evaluateRisk({ traceId: 't-tz', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

      // No incorrect reset happened - dayStartDateStr is untouched and the real $500 loss is preserved.
      expect(mockTradingEngine.state.dayStartDateStr).toBe('2026-01-15');
      expect(mockTradingEngine.state.currentDailyLoss).toBe(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks new trades after the configured consecutive losing FILLED trades', async () => {
    const n = tradingSafety.maxConsecutiveLosses;
    setTableRows(schema.trades, Array.from({ length: n }, (_, i) => ({
      status: 'FILLED',
      profitLoss: -10,
      timestamp: `2026-01-${String(n - i).padStart(2, '0')}`,
    })));

    await riskEngine.evaluateRisk({ traceId: 't3', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/consecutive losing trades/);
  });

  it('does not trip the consecutive-loss breaker if the most recent loss streak is broken by a win', async () => {
    setTableRows(schema.trades, [
      { status: 'FILLED', profitLoss: 10, timestamp: '2026-01-03' },
      { status: 'FILLED', profitLoss: -5, timestamp: '2026-01-02' },
      { status: 'FILLED', profitLoss: -1, timestamp: '2026-01-01' },
    ]);

    await riskEngine.evaluateRisk({ traceId: 't4', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/consecutive losing trades/);
  });

  it('vetoes a trade when a high-impact news cluster (impactScore above tradingSafety.newsVetoMinImpactScore) covers the symbol', async () => {
    setTableRows(schema.newsClusters, [
      { symbols: '["AAPL","MSFT"]', impactScore: tradingSafety.newsVetoMinImpactScore + 15, updatedAt: new Date().toISOString() },
    ]);

    await riskEngine.evaluateRisk({ traceId: 't5', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/high volatility news/i);
  });

  it('vetoes when NewsImpactEngine 0–1 scores are stored (0.9 * 100 exceeds the veto threshold)', async () => {
    setTableRows(schema.newsClusters, [
      { symbols: '["AAPL"]', impactScore: 0.9, updatedAt: new Date().toISOString() },
    ]);

    await riskEngine.evaluateRisk({ traceId: 't5-scale', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/high volatility news/i);
  });

  it('does not treat substring ticker matches as coverage (A vs AAPL JSON array)', async () => {
    setTableRows(schema.newsClusters, [
      { symbols: '["AAPL"]', impactScore: 0.9, updatedAt: new Date().toISOString() },
    ]);

    await riskEngine.evaluateRisk({ traceId: 't5-substr', symbol: 'A', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/high volatility news/i);
  });

  it('does not veto on a low-impact news cluster for the same symbol', async () => {
    setTableRows(schema.newsClusters, [
      { symbols: '["AAPL"]', impactScore: 40, updatedAt: new Date().toISOString() },
    ]);

    await riskEngine.evaluateRisk({ traceId: 't6', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/high volatility news/i);
  });

  it('rejects when currentPrice is missing or invalid', async () => {
    await riskEngine.evaluateRisk({ traceId: 't7', symbol: 'AAPL', side: 'BUY', currentPrice: 0 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/No valid price/);
  });

  it('sizes a BUY down to the max-trade-size dollar cap when it is the binding constraint', async () => {
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 1000 }]);
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 1000000, buyingPower: 1000000 }));

    await riskEngine.evaluateRisk({ traceId: 't8', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(true);
    // maxTradeSize $1000 / $100/share = 10 shares, far below the risk/buying-power caps at this equity.
    expect(assessment.maxQuantity).toBe(10);
  });

  it('caps a BUY at the 20% single-symbol concentration limit net of an existing position', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 100000,
      buyingPower: 100000,
      positions: [{ symbol: 'AAPL', quantity: 150, entryPrice: 100 }], // $15,000 existing exposure
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000 }]);

    await riskEngine.evaluateRisk({ traceId: 't9', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    // Cap is 20% of $100k = $20k total; $15k already held -> $5k / $100 = 50 more shares max.
    expect(assessment.maxQuantity).toBeLessThanOrEqual(50);
  });

  it('caps a BUY at the 40% sector concentration limit when existing same-sector positions already fill it', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 100000,
      buyingPower: 100000,
      // MSFT + AAPL are both mapped to Technology; $38k already held against a $40k (40%) cap.
      positions: [
        { symbol: 'MSFT', quantity: 200, entryPrice: 100 }, // $20,000
        { symbol: 'AAPL', quantity: 180, entryPrice: 100 }, // $18,000 existing exposure in the BUY's own symbol/sector
      ],
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000 }]);

    await riskEngine.evaluateRisk({ traceId: 't9b', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    // Sector cap: $40k total - $38k held = $2k / $100 = 20 more shares max (tighter than the 20% single-symbol cap here).
    expect(assessment.maxQuantity).toBeLessThanOrEqual(20);
  });

  it('does not let an unmapped-sector position count against a mapped symbol\'s sector cap', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 100000,
      buyingPower: 1000000,
      positions: [{ symbol: 'ZZZZ', quantity: 900, entryPrice: 100 }], // unmapped symbol, $90,000 exposure
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 1000000 }]);

    await riskEngine.evaluateRisk({ traceId: 't9c', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    // ZZZZ has no GICS mapping, so it doesn't count toward AAPL's (Technology) sector sum - AAPL
    // is only bound by its own 20% single-symbol cap ($20k / $100 = 200 shares), not sector-crushed
    // by ZZZZ's large unrelated position.
    expect(assessment.approved).toBe(true);
    expect(assessment.maxQuantity).toBe(200);
  });

  it('caps a BUY at the 50% correlated-exposure limit when it is highly positively correlated with an existing position', async () => {
    const trendUp = Array.from({ length: 25 }, (_, i) => 100 + i * 2); // [100,102,...,148]
    mockBarsBySymbol.CORRA = trendUp;
    mockBarsBySymbol.CORRB = [...trendUp]; // identical return series -> correlation = 1.0

    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 200000,
      buyingPower: 1000000,
      positions: [{ symbol: 'CORRB', quantity: 900, entryPrice: 100 }], // $90,000 existing exposure
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 1000000 }]);

    await riskEngine.evaluateRisk({ traceId: 't-corr1', symbol: 'CORRA', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    // Correlated cap: 50% of $200k = $100k total; $90k already held in the correlated CORRB
    // position -> $10k / $100 = 100 more shares max, tighter than the 20% single-symbol cap (400).
    expect(assessment.approved).toBe(true);
    expect(assessment.maxQuantity).toBe(100);
  });

  it('does not correlation-cap a BUY against a negatively-correlated existing position', async () => {
    // Constructs two series whose per-step returns are exact negatives of each other
    // (retB_i = -retA_i for every i), which guarantees Pearson correlation = -1 exactly -
    // a real hedge, not a coincidental mirror of price levels (which does NOT imply
    // negatively-correlated returns).
    const stepReturns = Array.from({ length: 24 }, (_, i) => 0.01 * (i % 2 === 0 ? 1 : -1) + 0.001 * i);
    const seriesA = [100]; for (const r of stepReturns) seriesA.push(seriesA[seriesA.length - 1] * (1 + r));
    const seriesB = [100]; for (const r of stepReturns) seriesB.push(seriesB[seriesB.length - 1] * (1 - r));
    mockBarsBySymbol.CORRC = seriesA;
    mockBarsBySymbol.CORRD = seriesB;

    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 200000,
      buyingPower: 1000000,
      positions: [{ symbol: 'CORRD', quantity: 900, entryPrice: 100 }], // $90,000 in an inversely-moving symbol
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 1000000 }]);

    await riskEngine.evaluateRisk({ traceId: 't-corr2', symbol: 'CORRC', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    // A hedge, not concentration - the correlation cap must not fire. Bound only by the 20%
    // single-symbol cap: $200k * 0.20 / $100 = 400 shares (below the 800-share risk-sizing cap).
    expect(assessment.approved).toBe(true);
    expect(assessment.maxQuantity).toBe(400);
  });

  it('blocks all new trades once TRADING_PAUSED, not just EMERGENCY_STOP', async () => {
    mockTradingEngine.state.tradingState = 'TRADING_PAUSED';
    try {
      await riskEngine.evaluateRisk({ traceId: 't-paused', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
      const assessment = lastAssessment();
      expect(assessment.approved).toBe(false);
      expect(assessment.reasoning).toMatch(/paused/i);
    } finally {
      mockTradingEngine.state.tradingState = 'TRADING_ENABLED';
    }
  });

  it('blocks all new trades once EMERGENCY_STOP is active, with an emergency-specific reason', async () => {
    mockTradingEngine.state.tradingState = 'EMERGENCY_STOP';
    try {
      await riskEngine.evaluateRisk({ traceId: 't-estop', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
      const assessment = lastAssessment();
      expect(assessment.approved).toBe(false);
      expect(assessment.reasoning).toMatch(/emergency stop/i);
    } finally {
      mockTradingEngine.state.tradingState = 'TRADING_ENABLED';
    }
  });

  it('blocks a BUY once real portfolio drawdown from its persisted peak equity exceeds the configured limit', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 170000, buyingPower: 170000, positions: [] }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000, maxPortfolioDrawdownPct: 0.10, peakEquity: 200000 }]);

    await riskEngine.evaluateRisk({ traceId: 't-drawdown', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    // (200000 - 170000) / 200000 = 15% drawdown, exceeds the configured 10% limit.
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/drawdown/i);
  });

  it('does not block on drawdown when real equity is at or above its recorded peak', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 200000, buyingPower: 200000, positions: [] }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000, maxPortfolioDrawdownPct: 0.10, peakEquity: 190000 }]);

    await riskEngine.evaluateRisk({ traceId: 't-drawdown-new-peak', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/drawdown/i);
  });

  it('blocks opening a brand new position once the configured maximum open-positions count is already reached', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 100000,
      buyingPower: 100000,
      positions: [
        { symbol: 'MSFT', quantity: 10, entryPrice: 100 },
        { symbol: 'MOH', quantity: 10, entryPrice: 100 }, // unmapped sector, avoids sector-cap interference
      ],
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000, maxOpenPositions: 2 }]);

    // AAPL is not one of the two already-open positions, so opening it would be a 3rd distinct position.
    await riskEngine.evaluateRisk({ traceId: 't-openpos', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/open positions/i);
  });

  it('does not block adding to an already-open position, even at the max open-positions count', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 100000,
      buyingPower: 100000,
      positions: [
        { symbol: 'AAPL', quantity: 10, entryPrice: 100 },
        { symbol: 'MOH', quantity: 10, entryPrice: 100 },
      ],
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000, maxOpenPositions: 2 }]);

    await riskEngine.evaluateRisk({ traceId: 't-openpos-add', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(true);
  });

  it('blocks new proposals once the configured order-rate limit is exceeded, regardless of symbol/side', async () => {
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000, maxOrdersPerMinute: 3 }]);
    setTableRows(schema.riskAssessments, [
      { id: 1, createdAt: new Date().toISOString() },
      { id: 2, createdAt: new Date().toISOString() },
      { id: 3, createdAt: new Date().toISOString() },
    ]);

    await riskEngine.evaluateRisk({ traceId: 't-orderrate', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/rate limit/i);
  });

  it('does not block on order rate when recent activity is below the configured limit', async () => {
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 100000, maxOrdersPerMinute: 3 }]);
    setTableRows(schema.riskAssessments, [{ id: 1, createdAt: new Date().toISOString() }]);

    await riskEngine.evaluateRisk({ traceId: 't-orderrate-ok', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/rate limit/i);
  });

  it('rejects a SELL with no existing position', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({ positions: [] }));

    await riskEngine.evaluateRisk({ traceId: 't10', symbol: 'AAPL', side: 'SELL', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/no existing position/i);
  });

  it('caps a SELL quantity at the existing position size', async () => {
    mockBrokerHolder.broker = makeBroker(basePortfolio({
      equity: 1000000,
      buyingPower: 1000000,
      positions: [{ symbol: 'AAPL', quantity: 5, entryPrice: 100 }],
    }));
    setTableRows(schema.settings, [{ riskLevel: 'Aggressive', maxTradeSize: 1000000 }]);

    await riskEngine.evaluateRisk({ traceId: 't11', symbol: 'AAPL', side: 'SELL', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(true);
    expect(assessment.maxQuantity).toBe(5);
  });

  it('skips the market-hours gate (does not block) when Alpaca credentials are not configured', async () => {
    await riskEngine.evaluateRisk({ traceId: 't12', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });
    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/Market is currently closed/);
  });

  it('vetoes a trade when the Alpaca clock reports the market is closed', async () => {
    process.env.ALPACA_API_KEY = 'key';
    process.env.ALPACA_SECRET_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ is_open: false }) })));

    await riskEngine.evaluateRisk({ traceId: 't13', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/Market is currently closed/);
  });

  it('fail-closes market_hours when Alpaca clock HTTP fails (does not treat outage as open)', async () => {
    process.env.ALPACA_API_KEY = 'key';
    process.env.ALPACA_SECRET_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));

    await riskEngine.evaluateRisk({ traceId: 't13-outage', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/market clock unavailable/i);
  });

  it('fail-closes market_hours when Alpaca clock fetch throws', async () => {
    process.env.ALPACA_API_KEY = 'key';
    process.env.ALPACA_SECRET_KEY = 'secret';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await riskEngine.evaluateRisk({ traceId: 't13-throw', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/market clock unavailable/i);
  });

  it('vetoes a trade on stale market data', async () => {
    mockMarketDataWorker.getLatestPriceAgeMs.mockReturnValue(10 * 60 * 1000); // 10 minutes, > 5 min threshold

    await riskEngine.evaluateRisk({ traceId: 't14', symbol: 'AAPL', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/Stale market data/);
  });

  it('approves a well-sized trade with no active gates', async () => {
    await riskEngine.evaluateRisk({ traceId: 't15', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(true);
    expect(assessment.maxQuantity).toBeGreaterThan(0);
  });

  it('rejects a $101 BUY when Argus allocation is $100 even if broker buying power is $2000', async () => {
    mockTradingEngine.state.budget = 100;
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 101, budget: 100 }]);
    mockBrokerHolder.broker = makeBroker(basePortfolio({ cash: 2000, buyingPower: 2000, equity: 2000 }));

    await riskEngine.evaluateRisk({ traceId: 'cap-101', symbol: 'MSFT', side: 'BUY', currentPrice: 101 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/Remaining Argus allocation/);
    expect(assessment.reasoning).toMatch(/\$101/);
  });

  it('approves a $60 BUY against $100 unused allocation, then rejects a second $50 BUY', async () => {
    mockTradingEngine.state.budget = 100;
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 60, budget: 100 }]);
    mockBrokerHolder.broker = makeBroker(basePortfolio({ cash: 2000, buyingPower: 2000, equity: 2000 }));

    await riskEngine.evaluateRisk({ traceId: 'cap-60', symbol: 'MSFT', side: 'BUY', currentPrice: 60 });
    expect(lastAssessment().approved).toBe(true);

    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 50, budget: 100 }]);
    mockBrokerHolder.broker = makeBroker(basePortfolio({
      cash: 1940, buyingPower: 1940, equity: 2000,
      positions: [{ symbol: 'MSFT', quantity: 1, averagePrice: 60 }],
    }));
    await riskEngine.evaluateRisk({ traceId: 'cap-50', symbol: 'AAPL', side: 'BUY', currentPrice: 50 });
    expect(lastAssessment().approved).toBe(false);
    expect(lastAssessment().reasoning).toMatch(/requested capital = \$50/);
  });

  it('LIVE: rejects a BUY when today NY countable BUY notional plus this order exceeds the restricted-live cap', async () => {
    mockTradingEngine.state.tradingMode = 'LIVE';
    const cap = tradingSafety.restrictedLiveMaxDailyBuyNotionalDollars;
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 3000, budget: 1_000_000 }]);
    setTableRows(schema.trades, [{
      side: 'BUY',
      status: 'FILLED',
      price: 100,
      quantity: Math.ceil(cap / 100),
      timestamp: new Date().toISOString(),
    }]);

    await riskEngine.evaluateRisk({ traceId: 'daily-notional', symbol: 'MSFT', side: 'BUY', currentPrice: 100 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/Daily buy notional cap/i);
  });

  it('blocks new BUY when Autobot is off without treating it as emergency_stop', async () => {
    mockTradingEngine.state.enabled = false;
    mockTradingEngine.state.tradingState = 'TRADING_ENABLED';
    await riskEngine.evaluateRisk({ traceId: 'autobot-off-buy', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });
    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/AUTOBOT_DISABLED/);
    mockTradingEngine.state.enabled = true;
  });

  it('does not use autobot_enabled to block SELL/exits while TRADING_ENABLED', async () => {
    mockTradingEngine.state.enabled = false;
    mockTradingEngine.state.tradingState = 'TRADING_ENABLED';
    setTableRows(schema.portfolio, [{ symbol: 'AAPL', quantity: 10, averagePrice: 100 }]);
    await riskEngine.evaluateRisk({ traceId: 'autobot-off-sell', symbol: 'AAPL', side: 'SELL', currentPrice: 100 });
    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/AUTOBOT_DISABLED/);
    mockTradingEngine.state.enabled = true;
  });
});
