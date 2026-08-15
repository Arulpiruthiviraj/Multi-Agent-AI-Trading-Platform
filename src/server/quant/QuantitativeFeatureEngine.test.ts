import { describe, it, expect } from 'vitest';
import { snapshotFromStrategyContext } from './QuantitativeFeatureEngine';
import { evaluateAll } from './strategies/StrategyEngine';
import { computeGroupedScores } from './scoring/GroupedScores';
import { baseFixture } from './strategies/testHelpers';
import { tradingSafety } from '../config/tradingSafety';

describe('QuantitativeFeatureEngine', () => {
  it('assembles existing context without turning divergence or regime into a trade', () => {
    const ctx = baseFixture();
    ctx.regime.regime = 'BULLISH_TREND';
    const evaluations = evaluateAll(ctx);
    const snapshot = snapshotFromStrategyContext({
      ctx,
      evaluations,
      groupedScores: { BUY: computeGroupedScores(ctx, 'BUY'), SELL: computeGroupedScores(ctx, 'SELL') },
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.source).toContain('QuantitativeFeatureEngine');
    expect(snapshot.trend.distanceFromMA.ema9?.diffPct).toBeDefined();
    expect(snapshot.momentum.rsiDivergence.isTradeSignal).toBe(false);
    expect(snapshot.momentum.macdDivergence.isTradeSignal).toBe(false);
    expect(snapshot.vwap).toEqual(ctx.volume.vwap);
    expect(snapshot.regimeEligibility.eligible.length + snapshot.regimeEligibility.ineligible.length).toBe(5);
    expect(snapshot.unavailable.marketBreadth.status).toBe('NOT_SUPPORTED');
    expect(snapshot.unavailable.optionsAnalytics.tradingBlocked).toBe(false);
    expect(snapshot.unavailable.orderFlow.whatHappened).toContain('not available');
  });

  it('uses the same strategy confidence floor as tradingSafety.json', () => {
    expect(tradingSafety.minStrategyConfidenceToTrade).toBeGreaterThan(0);
    expect(tradingSafety.minStrategyConfidenceToTrade).toBeLessThan(1);
  });
});
