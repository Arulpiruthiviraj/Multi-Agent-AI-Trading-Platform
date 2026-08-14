import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real integration test (isolated temp SQLite DB) for Phase 2C's corporate-actions safety check.
 * Seeds real ohlcv_bars rows directly (simulating an already-cached raw fetch) and mocks the
 * comparison split-adjustment HTTP call, since a real Alpaca account isn't available in this
 * environment - the comparison LOGIC (relative-difference detection, pagination, credential/
 * error fallbacks) is what's under test, not Alpaca connectivity itself.
 */
describe('HistoricalDataGateway.checkForUnadjustedCorporateActions', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let historicalDataGateway: any;
  const originalAlpacaKey = process.env.ALPACA_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_corpactions_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ historicalDataGateway } = await import('./HistoricalDataGateway'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    if (originalAlpacaKey === undefined) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = originalAlpacaKey;
    if (originalAlpacaSecret === undefined) delete process.env.ALPACA_SECRET_KEY; else process.env.ALPACA_SECRET_KEY = originalAlpacaSecret;
  });

  afterEach(() => vi.unstubAllGlobals());

  async function seedRawBar(symbol: string, timeframe: string, timestamp: number, close: number) {
    await db.insert(schema.ohlcvBars).values({
      id: `${symbol}:${timeframe}:${timestamp}`, symbol, timeframe, timestamp,
      open: close, high: close, low: close, close, volume: 1000, source: 'alpaca',
    });
  }

  it('reports checked:false, not a fabricated clean verdict, when Alpaca credentials are unset', async () => {
    delete process.env.ALPACA_API_KEY;
    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('NOKEY', '1Day', 0, 1);
    expect(result.checked).toBe(false);
    expect(result.clean).toBe(true); // "clean" here means "not flagged as dirty", not "verified clean"
    process.env.ALPACA_API_KEY = 'test-key';
  });

  it('detects a real unadjusted split: raw and split-adjusted closes differ materially for the same bar', async () => {
    const ts = new Date('2024-01-15').getTime();
    await seedRawBar('SPLITCO', '1Day', ts, 400); // pre-split raw close

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: '2024-01-15T00:00:00Z', c: 100 }] }), // split-adjusted: 4:1 split
    })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('SPLITCO', '1Day', ts - 1000, ts + 1000);
    expect(result.checked).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain('SPLITCO');
    expect(result.issues[0]).toMatch(/split/i);
  });

  it('reports clean when raw and split-adjusted closes agree (no real corporate action occurred)', async () => {
    const ts = new Date('2024-02-15').getTime();
    await seedRawBar('CLEANCO', '1Day', ts, 150);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: '2024-02-15T00:00:00Z', c: 150 }] }),
    })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('CLEANCO', '1Day', ts - 1000, ts + 1000);
    expect(result.checked).toBe(true);
    expect(result.clean).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('tolerates immaterial floating-point-level differences without a false positive', async () => {
    const ts = new Date('2024-03-15').getTime();
    await seedRawBar('TINYDIFF', '1Day', ts, 100.00);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: '2024-03-15T00:00:00Z', c: 100.001 }] }), // 0.001% difference
    })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('TINYDIFF', '1Day', ts - 1000, ts + 1000);
    expect(result.clean).toBe(true);
  });

  it('does not fabricate a clean verdict when the comparison fetch itself fails', async () => {
    const ts = new Date('2024-04-15').getTime();
    await seedRawBar('FETCHFAIL', '1Day', ts, 100);

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('FETCHFAIL', '1Day', ts - 1000, ts + 1000);
    expect(result.checked).toBe(false);
  });

  it('paginates through multiple pages of the split-adjustment comparison, same as the real fetch does', async () => {
    const ts1 = new Date('2024-05-01').getTime();
    const ts2 = new Date('2024-05-02').getTime();
    await seedRawBar('PAGED', '1Day', ts1, 100);
    await seedRawBar('PAGED', '1Day', ts2, 200);

    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => ({ bars: [{ t: '2024-05-01T00:00:00Z', c: 100 }], next_page_token: 'page2' }) };
      return { ok: true, json: async () => ({ bars: [{ t: '2024-05-02T00:00:00Z', c: 200 }] }) };
    }));

    const result = await historicalDataGateway.checkForUnadjustedCorporateActions('PAGED', '1Day', ts1 - 1000, ts2 + 1000);
    expect(result.checked).toBe(true);
    expect(result.clean).toBe(true);
    expect(call).toBe(2);
  });
});
