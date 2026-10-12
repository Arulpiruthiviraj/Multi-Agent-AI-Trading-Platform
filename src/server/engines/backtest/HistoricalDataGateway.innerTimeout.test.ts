// LABEL: COMPONENT / FAULT_INJECTION
/**
 * HistoricalDataGateway inner-fetch timeout — chaos tests for the 2026-10-12 forensic
 * defect (ARGUS_OCT12_LIVE_FORENSIC_INTERIM_2026-10-12.md): the INNER provider operation
 * (IBKR histChain / Alpaca fetch) had no timeout/cancel path, so a stalled inner wedged the
 * coalescing window until the 300s caller-side timeout (COALESCE_CALLER_TIMEOUT).
 *
 * The fix bounds the inner with quantBarsInnerFetchTimeoutMs: a stalled inner now fails
 * FIRST with the distinct HISTORICAL_INNER_FETCH_TIMEOUT, the coalescing entry is released
 * for a fresh attempt, and a late-settling zombie's cache writes are generation-guarded.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { tradingSafety } from '../../config/tradingSafety';

describe('HistoricalDataGateway inner-fetch timeout (2026-10-12)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let historicalDataGateway: any;
  let registerHistoricalBarProvider: any;
  const originalAlpacaKey = process.env.ALPACA_API_KEY;
  const originalAlpacaSecret = process.env.ALPACA_SECRET_KEY;
  const originalInnerTimeout = tradingSafety.quantBarsInnerFetchTimeoutMs;
  const originalCallerTimeout = tradingSafety.quantBarsCoalesceEntryMaxAgeMs;

  const now = Date.now();
  const start = now - 90 * 86_400_000;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_gwtimeout_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';

    ({ sqliteDb } = await import('../../db'));
    ({ historicalDataGateway } = await import('./HistoricalDataGateway'));
    ({ registerHistoricalBarProvider } = await import('./historicalBarProvider'));
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

  beforeEach(() => {
    vi.unstubAllGlobals();
    historicalDataGateway.clearBarsRateLimitBackoff();
    // Speed up the chaos: real config is 120s inner / 300s caller; the mechanism is identical.
    (tradingSafety as any).quantBarsInnerFetchTimeoutMs = 150;
    (tradingSafety as any).quantBarsCoalesceEntryMaxAgeMs = 60_000;
  });

  afterEach(async () => {
    (tradingSafety as any).quantBarsInnerFetchTimeoutMs = originalInnerTimeout;
    (tradingSafety as any).quantBarsCoalesceEntryMaxAgeMs = originalCallerTimeout;
    registerHistoricalBarProvider(null);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no real fetch in these tests'); }));
  });

  function ibkrBars(close: number, count = 70) {
    return Array.from({ length: count }, (_, i) => ({
      timestamp: start + i * 86_400_000,
      open: close, high: close + 1, low: close - 1, close, volume: 1000,
    }));
  }

  it('a silent (never-settling) provider fails fast with HISTORICAL_INNER_FETCH_TIMEOUT, not the 300s caller timeout', async () => {
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: () => new Promise(() => {}) });
    const t0 = Date.now();
    await expect(historicalDataGateway.ensureBars('SILENT1', '1Day', start, now))
      .rejects.toThrow(/HISTORICAL_INNER_FETCH_TIMEOUT/);
    const elapsed = Date.now() - t0;
    // Fails at the ~150ms inner bound — proves it did not wedge until the caller timeout.
    expect(elapsed).toBeLessThan(10_000);
  });

  it('the coalescing entry is released after an inner timeout, so a fresh attempt proceeds', async () => {
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: () => new Promise(() => {}) });
    await expect(historicalDataGateway.ensureBars('SILENT2', '1Day', start, now))
      .rejects.toThrow(/HISTORICAL_INNER_FETCH_TIMEOUT/);

    // Fresh attempt with a healthy provider must not hang on the dead entry.
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: async () => ibkrBars(100) });
    await historicalDataGateway.ensureBars('SILENT2', '1Day', start, now);
    const cached = await historicalDataGateway.getBars('SILENT2', '1Day', start, now);
    expect(cached.length).toBeGreaterThanOrEqual(60);
    expect(cached[0].close).toBe(100);
  });

  it('a late-settling zombie cannot clobber the fresh attempt’s cache entries', async () => {
    let releaseZombie!: (bars: any[]) => void;
    const zombieGate = new Promise<any[]>((res) => { releaseZombie = res; });
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: () => zombieGate });

    // t=0: first attempt; inner times out at ~150ms while the provider is still silent.
    await expect(historicalDataGateway.ensureBars('ZOMBIE1', '1Day', start, now))
      .rejects.toThrow(/HISTORICAL_INNER_FETCH_TIMEOUT/);

    // Fresh attempt wins the window with close=100.
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: async () => ibkrBars(100) });
    await historicalDataGateway.ensureBars('ZOMBIE1', '1Day', start, now);
    expect((await historicalDataGateway.getBars('ZOMBIE1', '1Day', start, now))[0].close).toBe(100);

    // The zombie finally settles with conflicting close=999 — its persist must be skipped.
    releaseZombie(ibkrBars(999));
    await new Promise((r) => setTimeout(r, 300));
    const cached = await historicalDataGateway.getBars('ZOMBIE1', '1Day', start, now);
    expect(cached[0].close).toBe(100);
  });

  it('caller timeout and inner timeout produce distinct error codes with correct precedence', async () => {
    // Caller bound (50ms) shorter than inner bound (150ms): the coalesced waiter must see
    // COALESCE_CALLER_TIMEOUT while the entry owner sees HISTORICAL_INNER_FETCH_TIMEOUT.
    (tradingSafety as any).quantBarsCoalesceEntryMaxAgeMs = 50;
    registerHistoricalBarProvider({ id: 'ibkr_gateway', fetchBars: () => new Promise(() => {}) });

    const first = historicalDataGateway.ensureBars('PRECEDENCE1', '1Day', start, now);
    // Second caller attaches to the in-flight entry.
    await new Promise((r) => setTimeout(r, 10));
    const second = historicalDataGateway.ensureBars('PRECEDENCE1', '1Day', start, now);

    await expect(second).rejects.toThrow(/COALESCE_CALLER_TIMEOUT/);
    await expect(first).rejects.toThrow(/HISTORICAL_INNER_FETCH_TIMEOUT/);
  });

  it('does not lower the production caller timeout: default inner bound stays well under it', () => {
    expect(originalInnerTimeout).toBeLessThan(originalCallerTimeout);
    expect(originalCallerTimeout).toBe(300000);
  });
});
