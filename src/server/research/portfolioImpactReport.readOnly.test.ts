import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// Static guarantee (matches architecture.protection.test.ts's own style): this module must never
// import or reference the protected order-placing spine. A read-only research report has no
// legitimate reason to touch any of these symbols.
describe('portfolioImpactReport.ts - read-only / advisory architectural guarantee', () => {
  const source = fs.readFileSync(path.join(__dirname, 'portfolioImpactReport.ts'), 'utf8');

  it('never imports OrderManagement, the live RiskEngine module, ChiefTraderAgent, or PositionSizing', () => {
    // Deliberately matches only real import/from statements, not prose mentions of the Java
    // OjAlgoPortfolioRiskEngine class (an advisory RESEARCH engine, not the live RiskEngine.ts).
    expect(source).not.toMatch(/from ['"].*OrderManagement['"]/);
    expect(source).not.toMatch(/from ['"].*\/RiskEngine['"]/);
    expect(source).not.toMatch(/from ['"].*ChiefTraderAgent['"]/);
    expect(source).not.toMatch(/from ['"].*PositionSizing['"]/);
  });

  it('never calls .placeOrder( or emitTradeIdea', () => {
    expect(source).not.toMatch(/\.placeOrder\(/);
    expect(source).not.toMatch(/emitTradeIdea/);
  });

  it('labels its output advisory: true unconditionally in the type contract', () => {
    expect(source).toMatch(/advisory:\s*true/);
  });
});

vi.mock('../../brokers/BrokerManager', () => {
  const portfolio = vi.fn();
  return {
    BrokerManager: {
      getInstance: () => ({
        getActiveBroker: () => ({ portfolio }),
      }),
    },
    __mockPortfolio: portfolio,
  };
});

vi.mock('./ingestAlpacaWarehouse', () => ({
  fetchAlpacaBars: vi.fn(),
}));

vi.mock('../services/QuantCoreBridge', () => ({
  quantCoreBridge: { fetchResearchStrategy: vi.fn() },
}));

describe('buildPortfolioImpactReport - real behavior against mocked real data sources', () => {
  it('reports BROKER_UNAVAILABLE when the broker throws, never fabricating a portfolio', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    (BrokerManager.getInstance().getActiveBroker().portfolio as any).mockRejectedValueOnce(new Error('no connection'));
    const { buildPortfolioImpactReport } = await import('./portfolioImpactReport');
    const report = await buildPortfolioImpactReport('AAPL', 'BUY', 1000);
    expect(report.status).toBe('BROKER_UNAVAILABLE');
    expect(report.advisory).toBe(true);
    expect(report.riskContribution).toBeNull();
    expect(report.minVarianceOptimizer).toBeNull();
  });

  it('reports INSUFFICIENT_RETURN_HISTORY when real bar history is too thin, never inventing a covariance', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    (BrokerManager.getInstance().getActiveBroker().portfolio as any).mockResolvedValueOnce({
      cash: 5000, buyingPower: 5000, equity: 10000,
      positions: [{ symbol: 'MSFT', quantity: 10, entryPrice: 300, currentPrice: 310, marketValue: 3100, unrealizedPnl: 100, unrealizedPnlPercent: 3.3 }],
    });
    const { fetchAlpacaBars } = await import('./ingestAlpacaWarehouse');
    (fetchAlpacaBars as any).mockResolvedValue({ bars: [], status: 'NO_KEYS', httpStatus: null, errorDetail: null });
    const { buildPortfolioImpactReport } = await import('./portfolioImpactReport');
    const report = await buildPortfolioImpactReport('AAPL', 'BUY', 1000);
    expect(report.status).toBe('INSUFFICIENT_RETURN_HISTORY');
    expect(report.riskContribution).toBeNull();
  });

  it('produces a real risk-contribution report when Java quant core responds, and marks it advisory', async () => {
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    (BrokerManager.getInstance().getActiveBroker().portfolio as any).mockResolvedValueOnce({
      cash: 5000, buyingPower: 5000, equity: 10000,
      positions: [{ symbol: 'MSFT', quantity: 10, entryPrice: 300, currentPrice: 310, marketValue: 3100, unrealizedPnl: 100, unrealizedPnlPercent: 3.3 }],
    });
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 3);
    const { fetchAlpacaBars } = await import('./ingestAlpacaWarehouse');
    (fetchAlpacaBars as any).mockResolvedValue({
      bars: closes.map((c, i) => ({ timestamp: i, open: c, high: c, low: c, close: c, volume: 1000 })),
      status: 'OK', httpStatus: 200, errorDetail: null,
    });
    const { quantCoreBridge } = await import('../services/QuantCoreBridge');
    (quantCoreBridge.fetchResearchStrategy as any).mockImplementation(async (strategyId: string) => {
      if (strategyId === 'ojalgo_portfolio_risk') {
        return { currentPortfolioVariance: 0.001, proposedPortfolioVariance: 0.0012, marginalRiskContributionPct: 5.2, candidateWeightBefore: 0, candidateWeightAfter: 0.1, exceedsMaxWeight: false };
      }
      return { status: 'OPTIMAL', weights: [0.6, 0.4], portfolioVariance: 0.0009 };
    });
    const { buildPortfolioImpactReport } = await import('./portfolioImpactReport');
    const report = await buildPortfolioImpactReport('AAPL', 'BUY', 1000);
    expect(report.status).toBe('OK');
    expect(report.advisory).toBe(true);
    expect(report.riskContribution?.marginalRiskContributionPct).toBe(5.2);
    expect(report.minVarianceOptimizer?.optimizerStatus).toBe('OPTIMAL');
    expect(report.minVarianceOptimizer?.recommendedWeights).toHaveProperty('MSFT');
    expect(report.minVarianceOptimizer?.recommendedWeights).toHaveProperty('AAPL');
    // never a fabricated confidence/EV field, never a side other than what was requested
    expect(report.candidateSide).toBe('BUY');
  });
});
