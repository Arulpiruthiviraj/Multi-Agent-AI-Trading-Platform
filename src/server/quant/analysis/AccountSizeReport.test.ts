import { describe, it, expect } from 'vitest';
import { buildAccountSizeReport, DEFAULT_ACCOUNT_SIZE_SCENARIOS } from './AccountSizeReport';

describe('buildAccountSizeReport', () => {
  it('reports TRADE NOT POSSIBLE honestly when even a $100 account cannot afford one real share', () => {
    const report = buildAccountSizeReport(450, [100, 500]); // e.g. a real high-priced stock
    expect(report[0].tradePossible).toBe(false);
    expect(report[0].affordableShares).toBe(0);
    expect(report[0].reason).toContain('WHOLE SHARE CONSTRAINT');
    expect(report[1].tradePossible).toBe(true); // $500 can afford exactly 1 share of $450
    expect(report[1].affordableShares).toBe(1);
  });

  it('computes real capital utilization and risk-per-trade for an affordable account size', () => {
    const report = buildAccountSizeReport(100, [1000]);
    expect(report[0].affordableShares).toBe(10); // floor(1000/100)
    expect(report[0].capitalUtilizationPct).toBe(100); // 10*100 = 1000, 100% of capital
    expect(report[0].estimatedRiskPerTradeDollar).toBeCloseTo(1000 * 0.05, 2); // STOP_LOSS_ASSUMPTION_PCT
  });

  it('never fabricates a fractional-share result - affordableShares is always a whole number', () => {
    const report = buildAccountSizeReport(33.33, DEFAULT_ACCOUNT_SIZE_SCENARIOS);
    for (const scenario of report) {
      expect(Number.isInteger(scenario.affordableShares)).toBe(true);
    }
  });

  it('defaults to the standard research account-size ladder when none is provided', () => {
    const report = buildAccountSizeReport(50);
    expect(report.map(r => r.capital)).toEqual(DEFAULT_ACCOUNT_SIZE_SCENARIOS);
  });
});
