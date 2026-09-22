import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./AlpacaCryptoMarketData', () => ({
  getCryptoBars: vi.fn(),
}));
vi.mock('../../services/QuantCoreBridge', () => ({
  quantCoreBridge: { fetchResearchStrategy: vi.fn() },
}));

import { getCryptoBars } from './AlpacaCryptoMarketData';
import { quantCoreBridge } from '../../services/QuantCoreBridge';
import { buildCryptoLiveSnapshot } from './AlpacaCryptoResearchBridge';

describe('buildCryptoLiveSnapshot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reports zero bars and null lastClose when no real bars are returned, rather than fabricating a value', async () => {
    (getCryptoBars as any).mockResolvedValue([]);
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    const snapshot = await buildCryptoLiveSnapshot('BTC/USD');
    expect(snapshot.barCount).toBe(0);
    expect(snapshot.lastClose).toBeNull();
  });

  it('reports lastClose from the most recent real bar', async () => {
    (getCryptoBars as any).mockResolvedValue([
      { timestampMs: 1, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
      { timestampMs: 2, open: 100.5, high: 102, low: 100, close: 101.7, volume: 1 },
    ]);
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue({ ok: true });
    const snapshot = await buildCryptoLiveSnapshot('BTC/USD');
    expect(snapshot.barCount).toBe(2);
    expect(snapshot.lastClose).toBe(101.7);
  });

  it('calls fetchResearchStrategy for all four real Java engines with the same symbol', async () => {
    (getCryptoBars as any).mockResolvedValue([{ timestampMs: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue({ ok: true });
    await buildCryptoLiveSnapshot('ETH/USD');
    const calledStrategyIds = (quantCoreBridge.fetchResearchStrategy as any).mock.calls.map((c: any[]) => c[0]);
    expect(calledStrategyIds.sort()).toEqual([
      'btc_tan2025_bollinger_mean_reversion',
      'btc_tan2025_vol_adjusted_momentum',
      'crypto_feature',
      'crypto_regime',
    ].sort());
    for (const call of (quantCoreBridge.fetchResearchStrategy as any).mock.calls) {
      expect(call[1]).toBe('ETH/USD');
    }
  });

  it('reports a null stage rather than fabricating a value when the Java bridge returns null for that stage', async () => {
    (getCryptoBars as any).mockResolvedValue([{ timestampMs: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    (quantCoreBridge.fetchResearchStrategy as any).mockImplementation(async (strategyId: string) =>
      strategyId === 'crypto_feature' ? { ok: true } : null,
    );
    const snapshot = await buildCryptoLiveSnapshot('BTC/USD');
    expect(snapshot.feature).toEqual({ ok: true });
    expect(snapshot.regime).toBeNull();
    expect(snapshot.tan2025Momentum).toBeNull();
    expect(snapshot.tan2025Bollinger).toBeNull();
  });

  it('converts CryptoBar shape to ResearchBar shape (timestamp field renamed, OHLCV preserved)', async () => {
    (getCryptoBars as any).mockResolvedValue([{ timestampMs: 12345, open: 1, high: 2, low: 0.5, close: 1.5, volume: 99 }]);
    (quantCoreBridge.fetchResearchStrategy as any).mockResolvedValue(null);
    await buildCryptoLiveSnapshot('BTC/USD');
    const barsPassed = (quantCoreBridge.fetchResearchStrategy as any).mock.calls[0][2];
    expect(barsPassed).toEqual([{ timestamp: 12345, open: 1, high: 2, low: 0.5, close: 1.5, volume: 99 }]);
  });
});
