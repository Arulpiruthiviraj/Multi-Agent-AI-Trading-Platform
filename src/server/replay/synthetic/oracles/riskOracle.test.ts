import { describe, expect, it } from 'vitest';
import { compareApprovalsToOracle, maxPermissibleBuyQuantity, type RiskOracleInput } from './riskOracle';

// Hand-derived: $20k capital, 20% symbol cap = $4000, $3000 max trade, 2% risk with 5% stop -> $400/(0.05*price).
const base: RiskOracleInput = {
  side: 'BUY', symbol: 'NVDA', price: 100, capitalBasis: 20000, maxTradeSizeUsd: 3000, maxPortfolioRiskPct: 0.02,
  stopLossAssumptionPct: 0.05, buyingPower: 1_000_000, maxSingleSymbolConcentrationPct: 0.2, maxSectorConcentrationPct: 0.4,
  maxOpenPositions: 5, remainingAllocationUsd: 20000, holdings: [], proposalSector: 'TECH',
};

describe('riskOracle', () => {
  it('risk cap binds: 400 / (100*0.05) = 80 shares, notional would allow 30 -> 30 binds', () => {
    const r = maxPermissibleBuyQuantity(base);
    expect(r.caps.risk).toBe(80);
    expect(r.caps.notional).toBe(30);
    expect(r.maxQuantity).toBe(30);
    expect(r.binding).toBe('notional');
  });
  it('existing position consumes symbol concentration room', () => {
    const r = maxPermissibleBuyQuantity({ ...base, holdings: [{ symbol: 'NVDA', quantity: 25, markPrice: 100, sector: 'TECH' }] });
    expect(r.caps.symbolConcentration).toBe(15); // (4000-2500)/100
    expect(r.maxQuantity).toBe(15);
  });
  it('sector cap uses holdings marks, remaining allocation can bind, full book blocks a new name', () => {
    const r = maxPermissibleBuyQuantity({ ...base, holdings: [{ symbol: 'MSFT', quantity: 70, markPrice: 100, sector: 'TECH' }] });
    expect(r.caps.sectorConcentration).toBe(10); // (8000-7000)/100
    expect(maxPermissibleBuyQuantity({ ...base, remainingAllocationUsd: 550 }).maxQuantity).toBe(5);
    const full = Array.from({ length: 5 }, (_, k) => ({ symbol: `S${k}`, quantity: 1, markPrice: 10, sector: null }));
    expect(maxPermissibleBuyQuantity({ ...base, holdings: full }).maxQuantity).toBe(0);
  });
  it('flags over-exposure, zero-room approvals and under-sizing', () => {
    const m = compareApprovalsToOracle([
      { traceId: 'a', symbol: 'NVDA', approvedQuantity: 31, input: base },
      { traceId: 'b', symbol: 'NVDA', approvedQuantity: 1, input: { ...base, remainingAllocationUsd: 0 } },
      { traceId: 'c', symbol: 'NVDA', approvedQuantity: 20, input: base },
      { traceId: 'd', symbol: 'NVDA', approvedQuantity: 30, input: base },
    ]);
    expect(m.map((x) => x.code)).toEqual(['OVER_EXPOSURE', 'APPROVED_WITH_ZERO_ORACLE_ROOM', 'UNDER_SIZED']);
  });
});
