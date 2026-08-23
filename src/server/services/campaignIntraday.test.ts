import { describe, it, expect } from 'vitest';
import { tradingSafety } from '../config/tradingSafety';
import {
  campaignVelocityMaxTradeDollars,
  campaignIntradayTargetPrice,
  campaignBreakevenStopPrice,
  evaluateOpeningSurgeCandidate,
  isOpeningSurgeWindow,
  isCampaignEodFlattenWindow,
} from './campaignIntraday';

describe('campaignIntraday', () => {
  it('opening surge requires RVOL + ORB; catalyst alone is not enough', () => {
    const fail = evaluateOpeningSurgeCandidate({
      rvol: 1.2,
      last: 101,
      prevDayHigh: 100,
      prevDayLow: 90,
      openingRangeHigh: null,
      openingRangeLow: null,
      hasHighImpactCatalyst: true,
    });
    expect(fail.pass).toBe(false);

    const pass = evaluateOpeningSurgeCandidate({
      rvol: tradingSafety.campaignOpeningRvolMin,
      last: 101,
      prevDayHigh: 100,
      prevDayLow: 90,
      openingRangeHigh: null,
      openingRangeLow: null,
      hasHighImpactCatalyst: false,
    });
    expect(pass.pass).toBe(true);
    expect(pass.orbDirection).toBe('ABOVE');
  });

  it('velocity sizing clamps to remaining and slot budget without exceeding maxTradeSize', () => {
    const sized = campaignVelocityMaxTradeDollars({
      maxTradeSizeDollar: 3000,
      budget: 2000,
      remainingAllocation: 1612.03,
    });
    expect(sized).toBeLessThanOrEqual(1612.03);
    expect(sized).toBeLessThanOrEqual(2000 * tradingSafety.campaignPositionBudgetFraction);
    expect(sized).toBeLessThanOrEqual(2000 / tradingSafety.campaignMaxConcurrentPositions);
    expect(sized).toBeGreaterThan(0);
  });

  it('ATR target and BE stop are above entry for long scalps', () => {
    expect(campaignIntradayTargetPrice(100, 2)).toBeCloseTo(100 + 2 * tradingSafety.campaignIntradayAtrTargetMultiple);
    expect(campaignBreakevenStopPrice(100)).toBeGreaterThan(100);
  });

  it('open and EOD windows match ET HH:MM helpers', () => {
    expect(isOpeningSurgeWindow('09:25')).toBe(true);
    expect(isOpeningSurgeWindow('09:30')).toBe(true);
    expect(isOpeningSurgeWindow('09:39')).toBe(true);
    expect(isOpeningSurgeWindow('09:40')).toBe(false);
    expect(isOpeningSurgeWindow('09:24')).toBe(false);
    expect(isCampaignEodFlattenWindow('15:55')).toBe(true);
    expect(isCampaignEodFlattenWindow('15:54')).toBe(false);
    expect(isCampaignEodFlattenWindow('16:00')).toBe(false);
  });
});
