import { describe, it, expect } from 'vitest';
import { calculateCommission, SEC_FEE_RATE_PER_DOLLAR, FINRA_TAF_PER_SHARE, FINRA_TAF_MIN, FINRA_TAF_CAP } from './Commissions';

describe('calculateCommission', () => {
  it('charges nothing beyond broker commission (default $0) on a BUY - SEC/FINRA fees are sells-only', () => {
    const result = calculateCommission({ side: 'BUY', quantity: 100, fillPrice: 50 });
    expect(result.total).toBe(0);
    expect(result.secFee).toBe(0);
    expect(result.finraTaf).toBe(0);
  });

  it('charges real SEC + FINRA TAF fees on a SELL, with the verified 2026 rates', () => {
    // 1000 shares @ $50 = $50,000 principal.
    const result = calculateCommission({ side: 'SELL', quantity: 1000, fillPrice: 50 });
    const expectedSecFee = Math.ceil(50000 * SEC_FEE_RATE_PER_DOLLAR * 100) / 100;
    const expectedTaf = Math.max(FINRA_TAF_MIN, Math.ceil(1000 * FINRA_TAF_PER_SHARE * 100) / 100);
    expect(result.secFee).toBeCloseTo(expectedSecFee, 2);
    expect(result.finraTaf).toBeCloseTo(expectedTaf, 2);
    expect(result.total).toBeCloseTo(expectedSecFee + expectedTaf, 2);
  });

  it('applies the real FINRA TAF minimum ($0.01) for a tiny SELL', () => {
    const result = calculateCommission({ side: 'SELL', quantity: 1, fillPrice: 10 });
    expect(result.finraTaf).toBe(FINRA_TAF_MIN);
  });

  it('applies the real FINRA TAF cap ($9.79) for a very large SELL', () => {
    const result = calculateCommission({ side: 'SELL', quantity: 1_000_000, fillPrice: 10 });
    expect(result.finraTaf).toBe(FINRA_TAF_CAP);
  });

  it('adds a configured broker commission on top of the real regulatory fees for a SELL', () => {
    const withoutBroker = calculateCommission({ side: 'SELL', quantity: 100, fillPrice: 50 });
    const withBroker = calculateCommission({ side: 'SELL', quantity: 100, fillPrice: 50, brokerCommissionPerTrade: 1.00 });
    expect(withBroker.total).toBeCloseTo(withoutBroker.total + 1.00, 2);
    expect(withBroker.brokerCommission).toBe(1);
  });

  it('never charges a negative or undefined fee for a zero-quantity edge case', () => {
    const result = calculateCommission({ side: 'SELL', quantity: 0, fillPrice: 50 });
    expect(result.total).toBeGreaterThanOrEqual(0);
  });
});
