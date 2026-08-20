import { describe, it, expect } from 'vitest';
import { finiteNumber, toPositionLedgerRow } from './positionLedgerRow';

describe('finiteNumber', () => {
  it('accepts numeric strings and rejects empty / NaN / non-numeric', () => {
    expect(finiteNumber('226.27')).toBe(226.27);
    expect(finiteNumber('1,200.50')).toBe(1200.5);
    expect(finiteNumber('')).toBeNull();
    expect(finiteNumber(undefined)).toBeNull();
    expect(finiteNumber(NaN)).toBeNull();
    expect(finiteNumber('n/a')).toBeNull();
  });
});

describe('toPositionLedgerRow', () => {
  it('does not emit NaN when totalCost is missing (Alpaca-shaped row)', () => {
    const row = toPositionLedgerRow({
      symbol: 'NVDA',
      quantity: 2,
      entryPrice: 100,
      currentPrice: 226.27,
      unrealizedPnl: 252.54,
      unrealizedPnlPercent: 1.2627,
    });
    expect(row.unrealizedPnl).toBeCloseTo(252.54);
    expect(Number.isFinite(row.unrealizedPnl)).toBe(true);
    expect(row.unrealizedPnlPercent).toBeCloseTo(126.27, 1);
    expect(row.marketValue).toBeCloseTo(452.54);
    expect(row.isPositive).toBe(true);
  });

  it('computes P&L from qty × (live − entry) when broker P&L and totalCost are absent', () => {
    const row = toPositionLedgerRow(
      { symbol: 'GLD', quantity: '3', entryPrice: '400', currentPrice: '403.38' },
      403.38,
    );
    expect(row.unrealizedPnl).toBeCloseTo(10.14);
    expect(row.unrealizedPnlPercent).toBeCloseTo(0.845, 2);
    expect(String(row.unrealizedPnl)).not.toContain('NaN');
  });

  it('uses broker unrealized_pl when prices are incomplete', () => {
    const row = toPositionLedgerRow({
      symbol: 'AAPL',
      qty: 10,
      entryPrice: 150,
      unrealized_pl: '-12.5',
    });
    expect(row.unrealizedPnl).toBeCloseTo(-12.5);
    expect(row.isPositive).toBe(false);
    expect(row.unrealizedPnlPercent).toBeCloseTo((-12.5 / 1500) * 100);
  });

  it('returns null P&L instead of NaN when nothing numeric is present', () => {
    const row = toPositionLedgerRow({ symbol: 'UNKNOWN' });
    expect(row.unrealizedPnl).toBeNull();
    expect(row.unrealizedPnlPercent).toBeNull();
    expect(row.livePrice).toBeNull();
    expect(row.marketValue).toBeNull();
  });

  it('maps real stopLossPrice/takeProfitPrice from the server (resolvePositionStopTarget) rather than showing "--"', () => {
    const row = toPositionLedgerRow({
      symbol: 'AAPL', quantity: 10, entryPrice: 200, currentPrice: 210,
      stopLossPrice: 190, takeProfitPrice: 230,
    });
    expect(row.stopLossPrice).toBe(190);
    expect(row.takeProfitPrice).toBe(230);
  });

  it('returns null (not 0 or NaN) stop/target when the server could not resolve one', () => {
    const row = toPositionLedgerRow({ symbol: 'AAPL', quantity: 10, entryPrice: 200 });
    expect(row.stopLossPrice).toBeNull();
    expect(row.takeProfitPrice).toBeNull();
  });
});
