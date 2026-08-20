import { describe, it, expect } from 'vitest';
import { buildDecisionFunnel, buildAgentEvaluation } from './replayReport';
import type { ReplayTradeRecord } from './ReplayContext';

function trade(side: 'BUY' | 'SELL'): ReplayTradeRecord {
  return {
    timestamp: 1, symbol: 'X', side, quantity: 1, price: 100, strategyId: 'S', traceId: 't',
    fees: 0, slippage: 0, realizedPnl: null, executionModel: 'NEXT_BAR_OPEN', executionEnvironment: 'HISTORICAL_REPLAY',
  };
}

describe('buildDecisionFunnel', () => {
  it('derives each funnel stage from noTrade/tradeLedger/rejectedOrders without inventing new counts', () => {
    const funnel = buildDecisionFunnel({
      evaluationsAttempted: 100,
      noTrade: { DATA_UNAVAILABLE: 10, INSUFFICIENT_SAMPLE: 20, NO_VALID_STRATEGY: 30, NO_CHIEF_APPROVAL: 25 },
      tradeLedger: [trade('BUY'), trade('SELL')],
      rejectedOrders: [{ reason: 'INSUFFICIENT_BUYING_POWER_OR_RISK' }, { reason: 'RISK_REJECTED' }],
    });
    expect(funnel.evaluationsAttempted).toBe(100);
    expect(funnel.dataUnavailable).toBe(10);
    expect(funnel.insufficientSample).toBe(20);
    expect(funnel.analyzed).toBe(70); // 100 - 10 - 20
    expect(funnel.noValidIdea).toBe(30);
    expect(funnel.ideasGenerated).toBe(40); // 70 - 30
    expect(funnel.consensusRejected).toBe(25);
    expect(funnel.consensusApproved).toBe(15); // 40 - 25
    expect(funnel.ordersFilled).toBe(2);
    expect(funnel.ordersRejected).toBe(2);
    expect(funnel.ordersSubmitted).toBe(4);
    expect(funnel.rejectionReasons).toEqual({ INSUFFICIENT_BUYING_POWER_OR_RISK: 1, RISK_REJECTED: 1 });
  });

  it('never produces negative counts even when noTrade totals exceed evaluationsAttempted', () => {
    const funnel = buildDecisionFunnel({
      evaluationsAttempted: 5,
      noTrade: { DATA_UNAVAILABLE: 10 }, // deliberately inconsistent input
      tradeLedger: [],
      rejectedOrders: [],
    });
    expect(funnel.analyzed).toBe(0);
    expect(funnel.ideasGenerated).toBe(0);
    expect(funnel.consensusApproved).toBe(0);
  });

  it('handles an all-zero (zero-trade) replay without dividing by zero or throwing', () => {
    const funnel = buildDecisionFunnel({ evaluationsAttempted: 0, noTrade: {}, tradeLedger: [], rejectedOrders: [] });
    expect(funnel.ordersSubmitted).toBe(0);
    expect(funnel.analyzed).toBe(0);
  });

  it('ALL_CORE multi-strategy: noValidIdea can legitimately exceed evaluationsAttempted without clamping ideasGenerated to 0', () => {
    // Real numbers observed from a live ALL_CORE (5 strategies) run: evaluationsAttempted=480,
    // NO_VALID_STRATEGY=2280 (> 480, since it's bumped once per strategyId per symbol-tick), yet
    // 80 real strategy passes produced ideas. Before strategyPassesAttempted existed, this clamped
    // ideasGenerated to 0 and hid those 80 real ideas from the funnel.
    const funnel = buildDecisionFunnel({
      evaluationsAttempted: 480,
      strategyPassesAttempted: 2360, // (480 - 8 exit-continues) * 5 strategies
      noTrade: { NO_VALID_STRATEGY: 2280 },
      tradeLedger: [],
      rejectedOrders: [],
    });
    expect(funnel.ideasGenerated).toBe(80); // 2360 - 2280, not clamped to 0
    expect(funnel.strategyPassesAttempted).toBe(2360);
  });

  it('without strategyPassesAttempted, falls back to `analyzed` (old single-strategy behavior unchanged)', () => {
    const funnel = buildDecisionFunnel({
      evaluationsAttempted: 100,
      noTrade: { NO_VALID_STRATEGY: 30 },
      tradeLedger: [],
      rejectedOrders: [],
    });
    expect(funnel.strategyPassesAttempted).toBe(100); // falls back to analyzed (100 - 0 - 0)
    expect(funnel.ideasGenerated).toBe(70); // 100 - 30, same as before this fix
  });
});

describe('buildAgentEvaluation', () => {
  it('computes average confidence per agent from accumulated stats', () => {
    const result = buildAgentEvaluation({
      TechnicalAgent: { ideas: 4, buyIdeas: 3, sellIdeas: 1, confidenceSum: 2.0 },
      QuantEngine: { ideas: 0, buyIdeas: 0, sellIdeas: 0, confidenceSum: 0 },
    });
    expect(result.TechnicalAgent).toEqual({ ideas: 4, buyIdeas: 3, sellIdeas: 1, averageConfidence: 0.5 });
    expect(result.QuantEngine.averageConfidence).toBeNull(); // 0 ideas - no division by zero
  });

  it('returns an empty object for an empty input, not an error', () => {
    expect(buildAgentEvaluation({})).toEqual({});
  });
});
