import { describe, it, expect } from 'vitest';
import { buildMarketSnapshotFromBars } from './MarketSnapshot';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';

function makeBars(count: number, opts: { trending?: boolean } = {}): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = opts.trending ? 0.3 : (Math.sin(i / 3) * 0.5);
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    bars.push({ timestamp: i * 86_400_000, open, high, low, close, volume: 1_000_000 + (i % 5) * 50_000 });
    price = close;
  }
  return bars;
}

describe('buildMarketSnapshotFromBars', () => {
  it('produces real, non-fabricated values from a real bar series', () => {
    const bars = makeBars(300, { trending: true });
    const snapshot = buildMarketSnapshotFromBars(bars, 'TEST', '1d');
    expect(snapshot.symbol).toBe('TEST');
    expect(snapshot.price.close).toBe(bars[bars.length - 1].close);
    expect(snapshot.indicators.rsi14).not.toBeNull();
    expect(snapshot.indicators.adx).not.toBeNull();
    expect(typeof snapshot.indicators.rsi14).toBe('number');
  });

  it('honestly reports null (not a fabricated 0) for indicators needing more history than provided', () => {
    const bars = makeBars(5);
    const snapshot = buildMarketSnapshotFromBars(bars, 'TEST', '1d');
    // SMA200 cannot be computed from only 5 bars.
    expect(snapshot.series.sma200[1]).toBeNull();
  });

  it('never throws on a minimal (near-empty) bar array', () => {
    expect(() => buildMarketSnapshotFromBars([], 'TEST', '1d')).not.toThrow();
    expect(() => buildMarketSnapshotFromBars(makeBars(1), 'TEST', '1d')).not.toThrow();
  });

  it('passes through optional caller-supplied newsSentiment without inventing one when omitted', () => {
    const bars = makeBars(50);
    const withSentiment = buildMarketSnapshotFromBars(bars, 'TEST', '1d', { newsSentiment: 0.6 });
    const withoutSentiment = buildMarketSnapshotFromBars(bars, 'TEST', '1d');
    expect(withSentiment.indicators.newsSentiment).toBe(0.6);
    expect(withoutSentiment.indicators.newsSentiment).toBeNull();
  });

  it('reuses the real SMC feature engine for FVG/order-block zones', () => {
    const bars = makeBars(100, { trending: true });
    const snapshot = buildMarketSnapshotFromBars(bars, 'TEST', '1d');
    expect(typeof snapshot.flags.fvgDetected).toBe('boolean');
    expect(typeof snapshot.flags.fvgPriceInZone).toBe('boolean');
  });
});
