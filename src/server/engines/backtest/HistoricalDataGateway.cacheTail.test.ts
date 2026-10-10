import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { quantScheduling } from '../../config/quantScheduling';
import { tradingSafety } from '../../config/tradingSafety';
import { registerHistoricalBarProvider } from './historicalBarProvider';
import type { HistoricalBarProvider } from './historicalBarProvider';

// Real gateway + isolated SQLite. Only the external provider boundary is replaced.
// No production DB, broker, strategy result or trade decision is injected.
describe('HistoricalDataGateway sufficient but old daily cache', () => {
  let sqlite: any;
  let gateway: typeof import('./HistoricalDataGateway')['historicalDataGateway'];
  const dbPath = path.join(os.tmpdir(), `argus-cache-tail-${process.pid}-${Date.now()}.db`);
  const originalDb = process.env.ARGUS_DB_PATH;
  const originalSynthetic = process.env.SYNTHETIC_SIMULATION;
  const dayMs = 86_400_000;
  const requestedEnd = Date.parse('2026-10-09T15:00:00Z');
  const requestedStart = requestedEnd - dayMs * 400;

  beforeAll(async () => {
    process.env.ARGUS_DB_PATH = dbPath;
    delete process.env.SYNTHETIC_SIMULATION;
    ({ sqliteDb: sqlite } = await import('../../db'));
    ({ historicalDataGateway: gateway } = await import('./HistoricalDataGateway'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    registerHistoricalBarProvider(null);
    if (originalSynthetic == null) delete process.env.SYNTHETIC_SIMULATION;
    else process.env.SYNTHETIC_SIMULATION = originalSynthetic;
  });
  afterAll(() => {
    sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
    if (originalDb == null) delete process.env.ARGUS_DB_PATH;
    else process.env.ARGUS_DB_PATH = originalDb;
  });
  function seed(symbol: string, latest: number) {
    const insert = sqlite.prepare('INSERT INTO ohlcv_bars (id,symbol,timeframe,timestamp,open,high,low,close,volume,source,provisional) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    sqlite.transaction(() => {
      for (let i = 0; i < tradingSafety.regimeMinBars; i++) {
        const t = latest - i * dayMs;
        insert.run(`${symbol}:1Day:${t}`, symbol, '1Day', t, 100, 101, 99, 100, 1000, 'ibkr', 0);
      }
    })();
  }
  function useProvider(fetchBars: HistoricalBarProvider['fetchBars']) {
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars });
  }

  it('does not leak future bars or omit newly eligible bars when exact windows share an hour bucket', async () => {
    const symbol = 'PIT';
    const hour = Math.floor(requestedEnd / 3_600_000) * 3_600_000;
    seed(symbol, hour + 20 * 60_000);
    const broad = await gateway.getBars(symbol, '1Day', requestedStart, hour + 30 * 60_000);
    expect(broad.at(-1)?.timestamp).toBe(hour + 20 * 60_000);
    const earlier = await gateway.getBars(symbol, '1Day', requestedStart, hour + 10 * 60_000);
    expect(earlier.every(bar => bar.timestamp <= hour + 10 * 60_000)).toBe(true);
    const later = await gateway.getBars(symbol, '1Day', requestedStart, hour + 40 * 60_000);
    expect(later.at(-1)?.timestamp).toBe(hour + 20 * 60_000);
    const narrowedStart = await gateway.getBars(symbol, '1Day', hour + 25 * 60_000, hour + 40 * 60_000);
    expect(narrowedStart).toEqual([]);
    const expandedStart = await gateway.getBars(symbol, '1Day', hour + 15 * 60_000, hour + 40 * 60_000);
    expect(expandedStart).toHaveLength(1);
  });

  it('refreshes a weeks-old cache despite enough samples, then uses the real updated tail', async () => {
    const symbol = 'TAIL';
    seed(symbol, requestedEnd - quantScheduling.dailyCacheTailRefreshGapMs - dayMs);
    const recent = { timestamp: requestedEnd - dayMs, open: 100, high: 102, low: 99, close: 101, volume: 2000 };
    const fetchBars = vi.fn().mockResolvedValue([recent]);
    useProvider(fetchBars);
    await gateway.ensureBars(symbol, '1Day', requestedStart, requestedEnd);
    expect(fetchBars).toHaveBeenCalledExactlyOnceWith(symbol, '1Day', requestedStart, requestedEnd);
    const rows = await gateway.getBars(symbol, '1Day', requestedStart, requestedEnd);
    expect(rows.at(-1)).toEqual(recent);
    await gateway.ensureBars(symbol, '1Day', requestedStart, requestedEnd);
    expect(fetchBars).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a sufficient tail exactly at the configured tolerance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(requestedEnd);
    seed('EDGE', requestedEnd - Math.min(quantScheduling.dailyCacheTailRefreshGapMs, tradingSafety.quantBarsTailFreshnessToleranceMs));
    const fetchBars = vi.fn();
    useProvider(fetchBars);
    await gateway.ensureBars('EDGE', '1Day', requestedStart, requestedEnd);
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it('checks a historical window against its own end, not wall-clock age', async () => {
    const end = Date.parse('2024-10-09T15:00:00Z');
    seed('PAST', end - dayMs);
    const fetchBars = vi.fn();
    useProvider(fetchBars);
    await gateway.ensureBars('PAST', '1Day', end - dayMs * 400, end);
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it('bounds failed refresh retries without inventing or relabeling old bars', async () => {
    const latest = requestedEnd - quantScheduling.dailyCacheTailRefreshGapMs - dayMs;
    seed('FAIL', latest);
    let now = requestedEnd;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetchBars = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    useProvider(fetchBars);
    await expect(gateway.ensureBars('FAIL', '1Day', requestedStart, requestedEnd)).rejects.toThrow('DATA_STALE');
    await expect(gateway.ensureBars('FAIL', '1Day', requestedStart, requestedEnd)).rejects.toThrow('DATA_STALE');
    expect(fetchBars).toHaveBeenCalledTimes(1);
    expect((await gateway.getBars('FAIL', '1Day', requestedStart, requestedEnd)).at(-1)?.timestamp).toBe(latest);
    now += quantScheduling.staleCacheRefreshCooldownMs;
    await expect(gateway.ensureBars('FAIL', '1Day', requestedStart, requestedEnd)).rejects.toThrow('DATA_STALE');
    expect(fetchBars).toHaveBeenCalledTimes(2);
  });

  it('does not issue a real provider request in synthetic isolation even with an old tail', async () => {
    seed('ISOL', requestedEnd - quantScheduling.dailyCacheTailRefreshGapMs - dayMs);
    process.env.SYNTHETIC_SIMULATION = 'true';
    const fetchBars = vi.fn();
    useProvider(fetchBars);
    await gateway.ensureBars('ISOL', '1Day', requestedStart, requestedEnd);
    expect(fetchBars).not.toHaveBeenCalled();
  });

  it('an empty real response does not manufacture a current bar or repeatedly refetch', async () => {
    const latest = requestedEnd - quantScheduling.dailyCacheTailRefreshGapMs - dayMs;
    seed('NONE', latest);
    const fetchBars = vi.fn().mockResolvedValue([]);
    useProvider(fetchBars);
    await expect(gateway.ensureBars('NONE', '1Day', requestedStart, requestedEnd)).rejects.toThrow('DATA_STALE');
    await expect(gateway.ensureBars('NONE', '1Day', requestedStart, requestedEnd)).rejects.toThrow('DATA_STALE');
    expect(fetchBars).toHaveBeenCalledTimes(1);
    expect((await gateway.getBars('NONE', '1Day', requestedStart, requestedEnd)).at(-1)?.timestamp).toBe(latest);
  });
});
