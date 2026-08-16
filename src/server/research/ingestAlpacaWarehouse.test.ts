import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchAlpacaBars, ingestWarehouseDataset } from './ingestAlpacaWarehouse';
import { inspectResearchWarehouse } from './warehouseInventory';

describe('Alpaca warehouse ingest fail-closed', () => {
  const originalKey = process.env.ALPACA_API_KEY;
  const originalSecret = process.env.ALPACA_SECRET_KEY;
  const originalDir = process.env.ARGUS_RESEARCH_DIR;

  beforeEach(() => {
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.ALPACA_API_KEY;
    else process.env.ALPACA_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.ALPACA_SECRET_KEY;
    else process.env.ALPACA_SECRET_KEY = originalSecret;
    if (originalDir === undefined) delete process.env.ARGUS_RESEARCH_DIR;
    else process.env.ARGUS_RESEARCH_DIR = originalDir;
  });

  it('HTTP error after a first page is FETCH_HTTP_ERROR and not GREEN', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            bars: [{ t: '2024-01-02T00:00:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 1000 }],
            next_page_token: 'page2',
          }),
        };
      }
      return { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => 'server error', json: async () => ({}) };
    }));

    const r = await ingestWarehouseDataset({
      symbol: 'SPY',
      timeframe: '1Day',
      startIso: '2024-01-01T00:00:00.000Z',
      endIso: '2024-02-01T00:00:00.000Z',
      writeParquet: false,
    });
    expect(r.fetchStatus).toBe('HTTP_ERROR');
    expect(r.written).toBe(false);
    expect(r.reason).toBe('FETCH_HTTP_ERROR');
    expect(r.quality.quality).toBe('RED');
    expect(r.dataset.provenance).toBe('UNKNOWN');
    expect(r.quality.paperPromotionAllowed).toBe(false);
  });

  it('remaining page_token after ingestMaxPages is TRUNCATED not GREEN', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        bars: [{ t: '2024-01-02T00:00:00.000Z', o: 10, h: 11, l: 9, c: 10.5, v: 1000 }],
        next_page_token: 'still-more',
      }),
    })));
    const fetched = await fetchAlpacaBars('SPY', '1Day', '2024-01-01T00:00:00.000Z', '2024-02-01T00:00:00.000Z');
    expect(fetched.status).toBe('TRUNCATED');
    expect(fetched.bars.length).toBeGreaterThan(0);
  });

  it('sidecar GREEN without parquet is not a warehouse', () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-wh-'));
    process.env.ARGUS_RESEARCH_DIR = dir;
    writeFileSync(join(dir, 'SPY.meta.json'), JSON.stringify({
      qualityStatus: 'GREEN',
      provenance: 'REAL_MARKET_DATA',
      parquetPath: join(dir, 'SPY.parquet'),
    }));
    const inv = inspectResearchWarehouse();
    expect(inv.greenRealMarketData).toBe(false);
    expect(inv.greenParquetCount).toBe(0);
    writeFileSync(join(dir, 'SPY.parquet'), 'not-real-ohlcv');
    const inv2 = inspectResearchWarehouse();
    expect(inv2.greenRealMarketData).toBe(true);
    expect(inv2.greenParquetCount).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('GREEN bars.json without parquet still counts as warehouse inventory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-wh-bars-'));
    process.env.ARGUS_RESEARCH_DIR = dir;
    writeFileSync(join(dir, 'QQQ.meta.json'), JSON.stringify({
      qualityStatus: 'GREEN',
      provenance: 'REAL_MARKET_DATA',
    }));
    expect(inspectResearchWarehouse().greenRealMarketData).toBe(false);
    writeFileSync(join(dir, 'QQQ.bars.json'), JSON.stringify({ bars: [{ timestamp: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] }));
    expect(inspectResearchWarehouse().greenRealMarketData).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
