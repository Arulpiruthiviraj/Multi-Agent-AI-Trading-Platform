import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * P1-1 (2026-10-04 remediation): a still-forming current-day '1Day' bar, fetched with end=now
 * intraday, used to be persisted with onConflictDoNothing() - first write wins forever, freezing
 * an early-session snapshot as if it were the real closing bar. Real isolated-DB integration test
 * (same pattern as HistoricalDataGateway.test.ts), mocking only the Alpaca HTTP fetch - the
 * provisional-marking/refresh logic itself runs for real against a real SQLite DB.
 */
describe('HistoricalDataGateway provisional daily-bar handling', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let historicalDataGateway: any;
  let isDailyBarFinal: any;
  const originalAlpacaKey = process.env.ALPACA_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_provisional_bars_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ db, sqliteDb } = await import('../../db'));
    schema = await import('../../db/schema');
    ({ historicalDataGateway, isDailyBarFinal } = await import('./HistoricalDataGateway'));
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

  afterEach(() => {
    vi.unstubAllGlobals();
    historicalDataGateway.clearBarsRateLimitBackoff();
  });

  function rowFor(symbol: string, timeframe: string, timestamp: number) {
    return sqliteDb.prepare('SELECT * FROM ohlcv_bars WHERE id = ?').get(`${symbol}:${timeframe}:${timestamp}`);
  }

  it('isDailyBarFinal: a bar dated on a prior calendar day is always final, regardless of time', () => {
    const barOpenMs = Date.UTC(2026, 9, 1, 13, 30); // 2026-10-01 09:30 ET
    const laterSameDayButStillBeforeClose = Date.UTC(2026, 9, 1, 14, 0); // 10:00 ET, same day
    const nextDayMorning = Date.UTC(2026, 9, 2, 13, 35); // 2026-10-02 09:35 ET - a new day started
    expect(isDailyBarFinal(barOpenMs, laterSameDayButStillBeforeClose, 'America/New_York')).toBe(false);
    expect(isDailyBarFinal(barOpenMs, nextDayMorning, 'America/New_York')).toBe(true);
  });

  it('isDailyBarFinal: a bar is final once its own calendar day has passed the regular session close', () => {
    const barOpenMs = Date.UTC(2026, 9, 1, 13, 30); // 09:30 ET
    const beforeClose = Date.UTC(2026, 9, 1, 19, 59); // 15:59 ET
    const afterClose = Date.UTC(2026, 9, 1, 20, 1); // 16:01 ET, same calendar day
    expect(isDailyBarFinal(barOpenMs, beforeClose, 'America/New_York')).toBe(false);
    expect(isDailyBarFinal(barOpenMs, afterClose, 'America/New_York')).toBe(true);
  });

  it('ensureBars called intraday persists a still-forming bar as provisional, not final', async () => {
    const symbol = 'PROVTEST1';
    const barOpenMs = Date.UTC(2026, 9, 1, 13, 30); // 2026-10-01 09:30 ET
    const nowDuringSession = Date.UTC(2026, 9, 1, 15, 0); // 11:00 ET, same trading day, before close
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: new Date(barOpenMs).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 1000 }] }),
    })));
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(nowDuringSession);
    try {
      await historicalDataGateway.ensureBars(symbol, '1Day', barOpenMs - 86_400_000 * 5, nowDuringSession);
    } finally {
      dateSpy.mockRestore();
    }
    const row = rowFor(symbol, '1Day', barOpenMs);
    expect(row).toBeTruthy();
    expect(row.provisional).toBe(1);
    expect(row.close).toBe(100.5);
  });

  it('a provisional bar from a prior session is refreshed (not duplicated, not frozen) once the real closing bar arrives', async () => {
    const symbol = 'PROVTEST2';
    const barOpenMs = Date.UTC(2026, 9, 1, 13, 30); // 2026-10-01 09:30 ET
    const duringSession = Date.UTC(2026, 9, 1, 15, 0); // 11:00 ET same day - still forming
    const nextDay = Date.UTC(2026, 9, 2, 13, 35); // 2026-10-02 09:35 ET - that day is now over

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: new Date(barOpenMs).toISOString(), o: 100, h: 101, l: 99, c: 100.5, v: 1000 }] }),
    })));
    let dateSpy = vi.spyOn(Date, 'now').mockReturnValue(duringSession);
    try {
      await historicalDataGateway.ensureBars(symbol, '1Day', barOpenMs - 86_400_000 * 5, duringSession);
    } finally { dateSpy.mockRestore(); }
    expect(rowFor(symbol, '1Day', barOpenMs).provisional).toBe(1);
    expect(rowFor(symbol, '1Day', barOpenMs).close).toBe(100.5);

    // Real closing bar for the same day arrives the next day.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: new Date(barOpenMs).toISOString(), o: 100, h: 102, l: 98, c: 101.25, v: 5000 }] }),
    })));
    dateSpy = vi.spyOn(Date, 'now').mockReturnValue(nextDay);
    try {
      await historicalDataGateway.ensureBars(symbol, '1Day', barOpenMs - 86_400_000 * 5, nextDay);
    } finally { dateSpy.mockRestore(); }

    const rows = sqliteDb.prepare("SELECT * FROM ohlcv_bars WHERE symbol = ? AND timeframe = '1Day'").all(symbol);
    expect(rows).toHaveLength(1); // refreshed in place, never duplicated
    expect(rows[0].provisional).toBe(0);
    expect(rows[0].close).toBe(101.25);
  });

  it('a bar already written as final (provisional=0) is never overwritten by a later fetch', async () => {
    // Timestamps here must stay after every earlier test's mocked "now" in this file -
    // HistoricalDataGateway is a singleton whose real paceAlpacaFetch() pacing field
    // (lastAlpacaFetchAtMs) persists across tests and reads the same mocked Date.now(); going
    // chronologically backwards produces a real multi-day setTimeout wait, not a hang in this
    // test's own logic. Real wall-clock time never goes backwards, so this is a test-ordering
    // constraint, not a product behavior being masked.
    const symbol = 'PROVTEST3';
    const barOpenMs = Date.UTC(2026, 9, 10, 13, 30);
    await db.insert(schema.ohlcvBars).values({
      id: `${symbol}:1Day:${barOpenMs}`, symbol, timeframe: '1Day', timestamp: barOpenMs,
      open: 50, high: 51, low: 49, close: 50.75, volume: 2000, source: 'alpaca', provisional: 0,
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bars: [{ t: new Date(barOpenMs).toISOString(), o: 999, h: 999, l: 999, c: 999, v: 999 }] }),
    })));
    const farFuture = barOpenMs + 86_400_000 * 10;
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(farFuture);
    try {
      await historicalDataGateway.ensureBars(symbol, '1Day', barOpenMs - 86_400_000, farFuture);
    } finally { dateSpy.mockRestore(); }
    const row = rowFor(symbol, '1Day', barOpenMs);
    expect(row.close).toBe(50.75); // untouched - the already-final value survives
    expect(row.provisional).toBe(0);
  });
});
