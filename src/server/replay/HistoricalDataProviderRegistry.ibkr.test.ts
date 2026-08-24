import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test, isolated temp SQLite DB (same ARGUS_DB_PATH pattern as
 * HistoricalDataGateway.test.ts's corporate-actions suite): the ibkr provider's fetch() now
 * routes through HistoricalDataGateway.ensureBars()/getBars(), which read/write the real
 * ohlcv_bars table - this must never touch data/argus.db from a unit test.
 */
describe('HistoricalDataProviderRegistry — ibkr provider', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let getHistoricalProvider: any;
  let listHistoricalProviders: any;
  let registerHistoricalBarProvider: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ibkr_replay_provider_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db'));
    ({ registerHistoricalBarProvider } = await import('../engines/backtest/historicalBarProvider'));
    ({ getHistoricalProvider, listHistoricalProviders } = await import('./HistoricalDataProviderRegistry'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  afterEach(() => {
    // Never leak a fake registration into the next test in this file.
    registerHistoricalBarProvider(null);
  });

  it('reports DATA_PROVIDER_UNAVAILABLE when IB Gateway is not the active broker', async () => {
    registerHistoricalBarProvider(null);
    const p = getHistoricalProvider('ibkr')!;
    expect(p.describe().availability).toBe('DATA_PROVIDER_UNAVAILABLE');
    const fetched = await p.fetch({ symbol: 'IBKRTEST1', startMs: 0, endMs: 1, frequency: '1Day' });
    expect('error' in fetched).toBe(true);
    if ('code' in fetched) expect(fetched.code).toBe('DATA_PROVIDER_UNAVAILABLE');
  });

  it('reports AVAILABLE and fetches real bars once ibkr_gateway is registered, filtering out-of-window bars', async () => {
    const startMs = Date.UTC(2024, 0, 2);
    const endMs = Date.UTC(2024, 0, 10);
    registerHistoricalBarProvider({
      id: 'ibkr_gateway',
      fetchBars: async () => [
        { timestamp: Date.UTC(2024, 0, 2), open: 100, high: 101, low: 99, close: 100.5, volume: 1000 },
        { timestamp: Date.UTC(2024, 0, 3), open: 100.5, high: 102, low: 100, close: 101.5, volume: 1200 },
        { timestamp: Date.UTC(2024, 0, 20), open: 999, high: 999, low: 999, close: 999, volume: 1 }, // outside requested window
      ],
    });

    const p = getHistoricalProvider('ibkr')!;
    expect(p.describe().availability).toBe('AVAILABLE');

    const fetched = await p.fetch({ symbol: 'IBKRTEST2', startMs, endMs, frequency: '1Day' });
    expect('error' in fetched).toBe(false);
    if (!('error' in fetched)) {
      expect(fetched.source).toBe('ibkr_gateway');
      expect(fetched.provenance).toBe('REAL_MARKET_DATA');
      expect(fetched.adjustmentPolicy).toBe('RAW');
      expect(fetched.bars).toHaveLength(2); // the out-of-window bar must be filtered out
      expect(fetched.bars[0].close).toBe(100.5);
    }
  });

  it('serves a second fetch of the same window entirely from the SQLite cache (no second fetchBars call)', async () => {
    // Window sized to exactly match the 2 bars returned below - ensureBars()'s own sufficiency
    // check requires >=85% coverage of expectedBarCountForWindow (config/tradingSafety.json
    // quantBarsCacheMinCoverageRatio), so a wider window here would (correctly) trigger a refetch.
    const startMs = Date.UTC(2024, 1, 1);
    const endMs = Date.UTC(2024, 1, 3);
    let callCount = 0;
    registerHistoricalBarProvider({
      id: 'ibkr_gateway',
      fetchBars: async () => {
        callCount += 1;
        return [
          { timestamp: Date.UTC(2024, 1, 1), open: 50, high: 51, low: 49, close: 50.5, volume: 500 },
          { timestamp: Date.UTC(2024, 1, 2), open: 50.5, high: 52, low: 50, close: 51.5, volume: 600 },
        ];
      },
    });
    const p = getHistoricalProvider('ibkr')!;
    const first = await p.fetch({ symbol: 'IBKRTEST3', startMs, endMs, frequency: '1Day' });
    expect('error' in first).toBe(false);
    expect(callCount).toBe(1);

    const second = await p.fetch({ symbol: 'IBKRTEST3', startMs, endMs, frequency: '1Day' });
    expect('error' in second).toBe(false);
    // Cache-first ensureBars() must not re-invoke the IBKR bridge once ohlcv_bars already has
    // sufficient coverage for this exact window — this is the pacing protection the real
    // reqHistoricalData rate limit needs.
    expect(callCount).toBe(1);
  });

  it('rejects unsupported frequencies even when IB Gateway is active', async () => {
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: async () => [] });
    const p = getHistoricalProvider('ibkr')!;
    const fetched = await p.fetch({ symbol: 'IBKRTEST4', startMs: 0, endMs: 1, frequency: '15m' });
    expect('error' in fetched).toBe(true);
    if ('code' in fetched) expect(fetched.code).toBe('DATA_UNAVAILABLE');
  });

  it('converts a real reqHistoricalData failure into DATA_UNAVAILABLE, never a fabricated dataset', async () => {
    registerHistoricalBarProvider({
      id: 'ibkr_gateway',
      fetchBars: async () => { throw new Error('IBKR historicalData timeout for AAPL (1Day)'); },
    });
    const p = getHistoricalProvider('ibkr')!;
    const fetched = await p.fetch({ symbol: 'IBKRTEST5', startMs: Date.UTC(2024, 2, 1), endMs: Date.UTC(2024, 2, 5), frequency: '1Day' });
    expect('error' in fetched).toBe(true);
    if ('error' in fetched) expect(fetched.error).toMatch(/timeout/);
  });

  it('treats zero bars back from IBKR as DATA_UNAVAILABLE, not an empty-but-valid dataset', async () => {
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: async () => [] });
    const p = getHistoricalProvider('ibkr')!;
    const fetched = await p.fetch({ symbol: 'IBKRTEST6', startMs: Date.UTC(2024, 3, 1), endMs: Date.UTC(2024, 3, 5), frequency: '1Day' });
    expect('error' in fetched).toBe(true);
  });

  it('does not disturb the other registered providers', () => {
    const ids = listHistoricalProviders().map((p: any) => p.id);
    expect(ids).toEqual(['alpaca', 'golden_replay', 'ibkr', 'polygon', 'twelvedata', 'alphavantage']);
  });
});
