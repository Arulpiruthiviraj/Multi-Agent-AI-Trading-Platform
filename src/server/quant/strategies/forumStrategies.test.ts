import { describe, it, expect } from 'vitest';
import { evaluateAll, ALL_STRATEGIES, EXPERIMENTAL_STRATEGIES, findStrategy } from './StrategyEngine';
import { baseFixture } from './testHelpers';
import { quantForumStrategies } from '../../config/quantForumStrategies';

describe('forum playbook catalog (quantForumStrategies.json)', () => {
  it('maps every coded forum row to a real module and does not expand live evaluateAll', () => {
    const known = new Set([...ALL_STRATEGIES, ...EXPERIMENTAL_STRATEGIES].map(s => s.id));
    expect(quantForumStrategies.strategies.length).toBeGreaterThanOrEqual(7);
    for (const row of quantForumStrategies.strategies) {
      if (row.status === 'NOT_SUPPORTED') {
        expect(row.reason && row.reason.length).toBeGreaterThan(0);
        expect(row.moduleId).toBeUndefined();
        expect(row.reason).not.toMatch(/win rate|70–80|75–85/i);
      } else {
        expect(row.moduleId && known.has(row.moduleId)).toBe(true);
        expect(findStrategy(row.moduleId!)?.id).toBe(row.moduleId);
        expect(row.honesty && row.honesty.length).toBeGreaterThan(0);
      }
    }
    expect(evaluateAll(baseFixture())).toHaveLength(5);
    expect(quantForumStrategies.riskNote).toMatch(/RiskEngine/);
  });

  it('does not claim options, GEX, or L2 order flow are coded', () => {
    const byId = Object.fromEntries(quantForumStrategies.strategies.map(s => [s.id, s]));
    expect(byId.FORUM_WHEEL_OPTIONS.status).toBe('NOT_SUPPORTED');
    expect(byId.FORUM_0DTE_GEX.status).toBe('NOT_SUPPORTED');
    expect(byId.FORUM_AUCTION_ORDER_FLOW.status).toBe('NOT_SUPPORTED');
    expect(byId.FORUM_RS_RW_SPY.moduleId).toBe('RELATIVE_STRENGTH_ROTATION');
    expect(byId.FORUM_ORB.moduleId).toBe('OPENING_RANGE_BREAKOUT');
    expect(byId.FORUM_SMC_ICT.moduleId).toBe('SMC_LIQUIDITY_SWEEP');
    expect(byId.FORUM_ZSCORE_MR.moduleId).toBe('STATISTICAL_MEAN_REVERSION');
  });
});
