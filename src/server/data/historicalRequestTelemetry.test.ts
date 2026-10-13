// LABEL: COMPONENT / OBSERVABILITY
/**
 * Historical request telemetry (2026-10-13): every historical-bar request is attributed (cache, coalescing,
 * IBKR queue wait vs provider service time, Alpaca pacing vs service, terminal status) and the intraday
 * availability registry is updated - asynchronously, fail-open, and without changing request behavior.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { tradingSafety } from '../config/tradingSafety';
import {
  classifyAvailability,
  histRequestStore,
  newHistRequestContext,
  finalizeHistRequest,
  flushHistTelemetryForTests,
  telemetryStats,
} from './historicalRequestTelemetry';

const T = { freshnessToleranceMs: 180_000, delayedMaxMs: 1_440_000, minCoverage: 0.85 };

describe('classifyAvailability (pure)', () => {
  const base = { asOfMs: 1_000_000_000, coverage: 1, freshnessToleranceMs: 180_000, delayedMaxMs: 1_440_000, minCoverage: 0.85 };
  it('maps timeouts to TIMED_OUT, never to a setup outcome', () => {
    for (const t of ['HISTORICAL_INNER_FETCH_TIMEOUT', 'COALESCE_CALLER_TIMEOUT', 'CALLER_DEADLINE']) {
      expect(classifyAvailability({ ...base, terminalStatus: t, latestBarMs: null })).toBe('TIMED_OUT');
    }
  });
  it('fresh / delayed / stale by the real latest bar age; partial by coverage', () => {
    expect(classifyAvailability({ ...base, terminalStatus: 'OK', latestBarMs: base.asOfMs - 60_000 })).toBe('AVAILABLE_FRESH');
    expect(classifyAvailability({ ...base, terminalStatus: 'OK', latestBarMs: base.asOfMs - 900_000 })).toBe('AVAILABLE_DELAYED');
    expect(classifyAvailability({ ...base, terminalStatus: 'OK', latestBarMs: base.asOfMs - 5_000_000 })).toBe('STALE');
    expect(classifyAvailability({ ...base, coverage: 0.4, terminalStatus: 'OK', latestBarMs: base.asOfMs - 60_000 })).toBe('PARTIAL');
  });
  it('no bars at all is UNAVAILABLE (NO_DATA) and unknown inputs are UNKNOWN', () => {
    expect(classifyAvailability({ ...base, terminalStatus: 'NO_DATA', latestBarMs: null })).toBe('UNAVAILABLE');
    expect(classifyAvailability({ ...base, terminalStatus: 'OK', latestBarMs: null })).toBe('UNKNOWN');
    expect(classifyAvailability({ ...base, terminalStatus: 'SOMETHING_ELSE', latestBarMs: 1 })).toBe('UNKNOWN');
  });
});

describe('HistoricalDataGateway telemetry (integration, isolated DB)', () => {
  let tmp: string; let sqliteDb: any; let gateway: any; let register: any;
  const originalInner = tradingSafety.quantBarsInnerFetchTimeoutMs;
  const now = Date.now();
  const start = now - 90 * 86_400_000;

  beforeAll(async () => {
    tmp = path.join(os.tmpdir(), `argus_histtel_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmp;
    process.env.ALPACA_API_KEY = 'test-key';
    process.env.ALPACA_SECRET_KEY = 'test-secret';
    ({ sqliteDb } = await import('../db'));
    ({ historicalDataGateway: gateway } = await import('../engines/backtest/HistoricalDataGateway'));
    ({ registerHistoricalBarProvider: register } = await import('../engines/backtest/historicalBarProvider'));
  });
  afterAll(() => {
    try { sqliteDb.close(); } catch { /* closed */ }
    for (const s of ['', '-shm', '-wal']) { try { fs.unlinkSync(tmp + s); } catch { /* best effort */ } }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.ALPACA_API_KEY; delete process.env.ALPACA_SECRET_KEY;
  });
  afterEach(() => {
    register(null);
    (tradingSafety as any).quantBarsInnerFetchTimeoutMs = originalInner;
  });

  const bars = (n = 70) => Array.from({ length: n }, (_, i) => ({ timestamp: start + i * 86_400_000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));

  it('separates IBKR queue wait from provider service time and records the owner row + availability', async () => {
    register({
      id: 'ibkr_gateway',
      // Simulates IbkrSocketSession.requestHistoricalBars: it fills the request context the gateway created.
      fetchBars: async () => {
        const ctx = histRequestStore.getStore();
        const enq = performance.now();
        await new Promise((r) => setTimeout(r, 120)); // time waiting behind the serial queue
        if (ctx) ctx.ibkrQueueWaitMs = performance.now() - enq;
        const svc = performance.now();
        await new Promise((r) => setTimeout(r, 40)); // provider service time
        if (ctx) ctx.ibkrServiceMs = performance.now() - svc;
        return bars();
      },
    });
    await gateway.ensureBars('TELQ1', '1Day', start, now, { traceId: 'trace-telq1' });
    await flushHistTelemetryForTests();
    const row = sqliteDb.prepare("select * from historical_request_telemetry where symbol='TELQ1' and role='OWNER'").get();
    expect(row).toBeTruthy();
    expect(row.provider).toBe('ibkr');
    expect(row.trace_id).toBe('trace-telq1');
    expect(row.ibkr_queue_wait_ms).toBeGreaterThanOrEqual(100);
    expect(row.ibkr_service_ms).toBeGreaterThanOrEqual(30);
    expect(row.ibkr_queue_wait_ms).toBeGreaterThan(row.ibkr_service_ms); // the split is real, not a lump
    expect(row.total_ms).toBeGreaterThanOrEqual(row.ibkr_queue_wait_ms);
    expect(row.valid_bars).toBe(70);
    expect(row.terminal_status).toBe('OK');
    const av = sqliteDb.prepare("select * from intraday_data_availability where symbol='TELQ1'").get();
    expect(av.provider).toBe('ibkr');
    expect(av.bar_count).toBe(70);
    expect(av.last_bar_ms).toBe(bars()[69].timestamp);
  });

  it('records a coalesced waiter separately from the owner (no second provider call)', async () => {
    let calls = 0;
    register({ id: 'ibkr_gateway', fetchBars: async () => { calls++; await new Promise((r) => setTimeout(r, 150)); return bars(); } });
    const a = gateway.ensureBars('TELC1', '1Day', start, now);
    await new Promise((r) => setTimeout(r, 20));
    const b = gateway.ensureBars('TELC1', '1Day', start, now);
    await Promise.all([a, b]);
    await flushHistTelemetryForTests();
    expect(calls).toBe(1);
    const rows = sqliteDb.prepare("select role, coalesce_wait_ms from historical_request_telemetry where symbol='TELC1' order by role").all();
    expect(rows.map((r: any) => r.role).sort()).toEqual(['COALESCED', 'OWNER']);
    expect(rows.find((r: any) => r.role === 'COALESCED').coalesce_wait_ms).toBeGreaterThan(50);
  });

  it('records an inner timeout as TIMED_OUT with the late settlement captured separately (never as no-setup)', async () => {
    (tradingSafety as any).quantBarsInnerFetchTimeoutMs = 120;
    let release!: (b: any[]) => void;
    const gate = new Promise<any[]>((res) => { release = res; });
    register({ id: 'ibkr_gateway', fetchBars: () => gate });
    await expect(gateway.ensureBars('TELT1', '1Day', start, now)).rejects.toThrow(/HISTORICAL_INNER_FETCH_TIMEOUT/);
    release(bars());
    await new Promise((r) => setTimeout(r, 100));
    await flushHistTelemetryForTests();
    const owner = sqliteDb.prepare("select terminal_status from historical_request_telemetry where symbol='TELT1' and terminal_status='HISTORICAL_INNER_FETCH_TIMEOUT'").get();
    expect(owner).toBeTruthy();
    const late = sqliteDb.prepare("select terminal_status from historical_request_telemetry where symbol='TELT1' and terminal_status='LATE_SETTLEMENT'").get();
    expect(late).toBeTruthy();
    const av = sqliteDb.prepare("select status, consecutive_failures from intraday_data_availability where symbol='TELT1'").get();
    expect(av.status).toBe('TIMED_OUT');
    expect(av.consecutive_failures).toBeGreaterThanOrEqual(1);
  });

  it('a cache hit is recorded as such with zero provider time', async () => {
    // Fresh tail (last bar ~now) so the stale-tail gate accepts the cache instead of refreshing from a provider.
    const fresh = Array.from({ length: 70 }, (_, i) => ({ timestamp: now - (69 - i) * 86_400_000, open: 100, high: 101, low: 99, close: 100, volume: 1000 }));
    register({ id: 'ibkr_gateway', fetchBars: async () => fresh });
    await gateway.ensureBars('TELH1', '1Day', start, now); // populate
    await gateway.ensureBars('TELH1', '1Day', start, now + 1); // cache hit (distinct coalesce key)
    await flushHistTelemetryForTests();
    const hit = sqliteDb.prepare("select cache_hit, provider, ibkr_queue_wait_ms from historical_request_telemetry where symbol='TELH1' and cache_hit=1").get();
    expect(hit).toBeTruthy();
    expect(hit.provider).toBe('cache');
    expect(hit.ibkr_queue_wait_ms).toBeNull();
  });

  it('is fail-open and bounded: finalize never throws and the queue never grows past its cap', () => {
    const ctx = newHistRequestContext({ symbol: 'BOUND', timeframe: '1Min', startMs: 1, endMs: 2 });
    for (let i = 0; i < 6000; i++) finalizeHistRequest(ctx, { terminalStatus: 'OK' }, T);
    expect(telemetryStats().queued).toBeLessThanOrEqual(5000);
    expect(() => finalizeHistRequest(undefined as any, { terminalStatus: 'OK' }, T)).not.toThrow();
  });

  it('rejects a malformed symbol at the gateway boundary: no provider request, INVALID_SYMBOL recorded, no availability row', async () => {
    let calls = 0;
    register({ id: 'ibkr_gateway', fetchBars: async () => { calls++; return bars(); } });
    await expect(gateway.ensureBars(' ARCHER AVIATION', '1Min', now - 3_600_000, now)).rejects.toThrow(/INVALID_SYMBOL/);
    await expect(gateway.ensureBars('THE FED', '1Min', now - 3_600_000, now)).rejects.toThrow(/INVALID_SYMBOL/);
    await flushHistTelemetryForTests();
    expect(calls).toBe(0);
    const n = sqliteDb.prepare("select count(*) c from historical_request_telemetry where terminal_status='INVALID_SYMBOL'").get().c;
    expect(n).toBe(2);
    expect(sqliteDb.prepare("select count(*) c from intraday_data_availability where symbol like '%ARCHER%' or symbol='THE FED'").get().c).toBe(0);
  });
});
