import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as schema from '../db/schema';

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
  const mockDb = { select: () => builder };
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
    },
  },
}));

const { mockMarketDataWorker } = vi.hoisted(() => ({
  mockMarketDataWorker: { getLatestPriceAgeMs: vi.fn(() => null as number | null) },
}));

const { emitRiskAssessment } = vi.hoisted(() => ({ emitRiskAssessment: vi.fn() }));

vi.mock('../db', () => ({ db: mockDb }));
vi.mock('../core/EventBus', () => ({ eventBus: { emitRiskAssessment } }));
vi.mock('../../brokers/BrokerManager', () => ({
  BrokerManager: { getInstance: () => ({ getActiveBroker: () => mockBrokerHolder.broker }) },
}));
vi.mock('./TradingEngine', () => ({ tradingEngine: mockTradingEngine }));
vi.mock('../services/MarketDataWorker', () => ({ marketDataWorker: mockMarketDataWorker }));

import { riskEngine } from './RiskEngine';

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
    setTableRows(schema.settings, [{ riskLevel: 'Balanced', maxTradeSize: 3000 }]);
    setTableRows(schema.trades, []);
    setTableRows(schema.newsClusters, []);
    mockBrokerHolder.broker = makeBroker(basePortfolio());
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('blocks all trades once the daily-loss kill-switch threshold (80% of limit) is breached', async () => {
    mockTradingEngine.state.dailyLossLimit = 1000;
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 91500 })); // -8500 -> wait, use small numbers
    mockTradingEngine.state.dayStartDateStr = new Date().toISOString().split('T')[0];
    mockTradingEngine.state.dayStartEquity = 100000;
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 99150 })); // loss of 850 = 85% of 1000 limit

    await riskEngine.evaluateRisk({ traceId: 't1', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/Daily Loss Kill-Switch/);
  });

  it('does not trip the daily-loss breaker below the 80% threshold', async () => {
    mockTradingEngine.state.dailyLossLimit = 1000;
    mockTradingEngine.state.dayStartDateStr = new Date().toISOString().split('T')[0];
    mockTradingEngine.state.dayStartEquity = 100000;
    mockBrokerHolder.broker = makeBroker(basePortfolio({ equity: 99500 })); // loss of 500 = 50% of limit

    await riskEngine.evaluateRisk({ traceId: 't2', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.reasoning).not.toMatch(/Daily Loss Kill-Switch/);
  });

  it('blocks new trades after 3 consecutive losing FILLED trades', async () => {
    setTableRows(schema.trades, [
      { status: 'FILLED', profitLoss: -10, timestamp: '2026-01-03' },
      { status: 'FILLED', profitLoss: -5, timestamp: '2026-01-02' },
      { status: 'FILLED', profitLoss: -1, timestamp: '2026-01-01' },
    ]);

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

  it('vetoes a trade when a high-impact news cluster (impactScore > 80) covers the symbol', async () => {
    setTableRows(schema.newsClusters, [
      { symbols: '["AAPL","MSFT"]', impactScore: 95, updatedAt: new Date().toISOString() },
    ]);

    await riskEngine.evaluateRisk({ traceId: 't5', symbol: 'AAPL', side: 'BUY', currentPrice: 150 });

    const assessment = lastAssessment();
    expect(assessment.approved).toBe(false);
    expect(assessment.reasoning).toMatch(/high volatility news/i);
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
});
