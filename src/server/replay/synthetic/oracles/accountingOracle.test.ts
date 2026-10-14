import { describe, expect, it } from 'vitest';
import { compareOracleToLedger, runAccountingOracle, type LedgerView } from './accountingOracle';

// Hand-computed fixtures only: expected values below are derived on paper, never from Argus code.
describe('accountingOracle', () => {
  it('canonical NVDA round trip: gross -160.476228, fees 0.22, cash identity', () => {
    const r = runAccountingOracle([
      { orderId: 'b1', symbol: 'NVDA', side: 'BUY', quantity: 22, price: 134.610718, feeUsd: 0.11 },
      { orderId: 's1', symbol: 'NVDA', side: 'SELL', quantity: 22, price: 127.316344, feeUsd: 0.11 },
    ]);
    expect(r.grossRealizedPnl).toBeCloseTo(-160.476228, 6);
    expect(r.feesTotal).toBeCloseTo(0.22, 6);
    expect(r.netRealizedPnl).toBeCloseTo(-160.696228, 6);
    expect(r.positions).toEqual([]);
    expect(r.cashDelta).toBeCloseTo(-160.696228, 6);
  });

  it('average-cost across two buys and a partial sell', () => {
    const r = runAccountingOracle([
      { orderId: 'b1', symbol: 'A', side: 'BUY', quantity: 10, price: 10 },
      { orderId: 'b2', symbol: 'A', side: 'BUY', quantity: 10, price: 20 },
      { orderId: 's1', symbol: 'A', side: 'SELL', quantity: 5, price: 18 },
    ]);
    expect(r.positions).toEqual([{ symbol: 'A', quantity: 15, avgCost: 15 }]);
    expect(r.grossRealizedPnl).toBe(15); // (18-15)*5
  });

  it('flags overselling and bad inputs', () => {
    const r = runAccountingOracle([
      { orderId: 'b1', symbol: 'A', side: 'BUY', quantity: 1, price: 10 },
      { orderId: 's1', symbol: 'A', side: 'SELL', quantity: 2, price: 10 },
      { orderId: 'x', symbol: 'A', side: 'BUY', quantity: 0, price: 10 },
      { orderId: 'y', symbol: 'A', side: 'BUY', quantity: 1, price: -1 },
    ]);
    expect(r.violations.map((v) => v.code).sort()).toEqual(['NON_POSITIVE_PRICE', 'NON_POSITIVE_QUANTITY', 'OVERSELL']);
  });

  const fills = [
    { orderId: 'b1', symbol: 'A', side: 'BUY' as const, quantity: 10, price: 10, feeUsd: 0.1 },
    { orderId: 's1', symbol: 'A', side: 'SELL' as const, quantity: 10, price: 12, feeUsd: 0.1 },
    { orderId: 'b2', symbol: 'B', side: 'BUY' as const, quantity: 5, price: 20, feeUsd: 0.1 },
  ];
  const goodLedger = (): LedgerView => ({
    tradesPnlBySellOrder: { s1: 20 },
    fillsRealizedByOrder: { s1: 20 },
    portfolio: [{ symbol: 'B', quantity: 5, averagePrice: 20 }],
    broker: { cash: 20000 - 100 - 0.1 + 120 - 0.1 - 100 - 0.1, realizedPnl: 19.9, feesPaid: 0.3, positions: [{ symbol: 'B', quantity: 5, entryPrice: 20 }] },
    initialCash: 20000,
  });

  it('matches a consistent ledger', () => {
    expect(compareOracleToLedger(runAccountingOracle(fills), goodLedger())).toEqual([]);
  });

  it('detects P&L, cash, orphan-position and missing-row defects', () => {
    const o = runAccountingOracle(fills);
    const l = goodLedger();
    l.tradesPnlBySellOrder = { s1: 25 };
    l.broker.cash += 3;
    l.portfolio.push({ symbol: 'Z', quantity: 1, averagePrice: 1 });
    const codes = compareOracleToLedger(o, l).map((m) => m.code);
    expect(codes).toContain('LEDGER_PNL_MISMATCH');
    expect(codes).toContain('BROKER_CASH_MISMATCH');
    expect(codes).toContain('UNEXPLAINED_PORTFOLIO_POSITION');
    const l2 = goodLedger(); l2.tradesPnlBySellOrder = {};
    expect(compareOracleToLedger(o, l2).map((m) => m.code)).toContain('LEDGER_SELL_MISSING');
  });
});

describe('accountingOracle: partial fills (order-level totals)', () => {
  it('sums several fills of one SELL order before comparing with the order-level ledger P&L', () => {
    const fills = [
      { orderId: 'b', symbol: 'A', side: 'BUY' as const, quantity: 10, price: 100, feeUsd: 0 },
      { orderId: 's', symbol: 'A', side: 'SELL' as const, quantity: 4, price: 105, feeUsd: 0 },  // +20
      { orderId: 's', symbol: 'A', side: 'SELL' as const, quantity: 6, price: 110, feeUsd: 0 },  // +60
    ];
    const ledger: LedgerView = {
      tradesPnlBySellOrder: { s: 80 }, fillsRealizedByOrder: { s: 80 }, portfolio: [],
      broker: { cash: 20000 + 80, realizedPnl: 80, feesPaid: 0, positions: [] }, initialCash: 20000,
    };
    expect(compareOracleToLedger(runAccountingOracle(fills), ledger)).toEqual([]);
    ledger.tradesPnlBySellOrder.s = 20;
    expect(compareOracleToLedger(runAccountingOracle(fills), ledger).map((m) => m.code)).toContain('LEDGER_PNL_MISMATCH');
  });
});
