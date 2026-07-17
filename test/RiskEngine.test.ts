import { RiskEngine } from '../src/server/engines/RiskEngine';

describe('RiskEngine', () => {
  it('should approve valid trades', () => {
    const engine = new RiskEngine();
    const result = engine.evaluateRisk({
      symbol: 'AAPL',
      side: 'BUY',
      currentPrice: 150,
      confidence: 0.9
    }, {
      totalEquity: 100000,
      availableCash: 50000,
      dailyRealizedPnL: 0,
      maxDrawdown: 0.05,
      portfolioHeat: 0.5,
      marketRegime: 'BULL',
      openPositions: []
    });
    
    // Expect approval (it's using mock testing framework logic, but standard jest/vitest format)
    if (!result.approved) throw new Error("Expected approval");
  });
});
