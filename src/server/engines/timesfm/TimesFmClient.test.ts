import { describe, it, expect } from 'vitest';
import { TimesFmClient, timesFmOptionsFromEnv, type TimesFmBar } from './TimesFmClient';

const H = 8;
const bars = (n = 64, start = 1_000): TimesFmBar[] => Array.from({ length: n }, (_, i) => ({ timestampMs: start + i * 60_000, close: 100 + Math.sin(i / 5) }));
const origin = (b: TimesFmBar[]) => b[b.length - 1].timestampMs;

function okBody(horizon = H) {
  const row = [100, 99, 99.5, 99.8, 100, 100.2, 100.5, 100.8, 101, 101.5];
  return {
    modelId: 'google/timesfm-2.5-200m-pytorch', point: Array(horizon).fill(100.2), device: 'cpu', latencyMs: 12, traceId: 't1',
    quantiles: { levels: ['mean', 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], values: Array.from({ length: horizon }, () => row) },
  };
}
const json = (status: number, body: any) => async () => ({ ok: status < 300, status, json: async () => body }) as any;
const client = (fetchImpl: any, over: Partial<ReturnType<typeof timesFmOptionsFromEnv>> = {}) =>
  new TimesFmClient({ ...timesFmOptionsFromEnv({} as any), enabled: true, fetchImpl, timeoutMs: 200, ...over });

describe('TimesFmClient', () => {
  it('is disabled by default and never calls the service', async () => {
    let called = 0;
    const c = new TimesFmClient({ ...timesFmOptionsFromEnv({} as any), fetchImpl: (async () => { called++; return {} as any; }) as any });
    const b = bars();
    expect((await c.forecast({ symbol: 'AAPL', timeframe: '1d', originMs: origin(b), horizon: H, bars: b })).status).toBe('DISABLED');
    expect(called).toBe(0);
  });

  it('returns a validated forecast marked uncalibrated', async () => {
    const b = bars();
    const r = await client(json(200, okBody())).forecast({ symbol: 'AAPL', timeframe: '1d', originMs: origin(b), horizon: H, bars: b });
    expect(r.status).toBe('OK');
    if (r.status === 'OK') { expect(r.forecast.calibrated).toBe(false); expect(r.forecast.point).toHaveLength(H); }
  });

  it('rejects look-ahead: a bar after the forecast origin never reaches the service', async () => {
    let called = 0;
    const b = bars();
    const r = await client(async () => { called++; return {} as any; }).forecast({ symbol: 'AAPL', timeframe: '1d', originMs: origin(b) - 1, horizon: H, bars: b });
    expect(r.status).toBe('LOOKAHEAD_REJECTED');
    expect(called).toBe(0);
  });

  it('rejects short history, duplicate/out-of-order timestamps, NaN and non-positive closes', async () => {
    const c = client(json(200, okBody()));
    const mk = (b: TimesFmBar[]) => c.forecast({ symbol: 'X', timeframe: '1d', originMs: 10 ** 12, horizon: H, bars: b });
    expect((await mk(bars(10))).status).toBe('INSUFFICIENT_HISTORY');
    const dup = bars(); dup[5] = { ...dup[4] };
    expect((await mk(dup)).status).toBe('INVALID_INPUT');
    const nan = bars(); nan[3] = { ...nan[3], close: NaN };
    expect((await mk(nan)).status).toBe('INVALID_INPUT');
    const neg = bars(); neg[3] = { ...neg[3], close: -1 };
    expect((await mk(neg)).status).toBe('INVALID_INPUT');
  });

  it('maps service/model/timeouts to typed statuses, never throwing', async () => {
    const b = bars();
    const a = { symbol: 'X', timeframe: '1d', originMs: origin(b), horizon: H, bars: b };
    expect((await client(json(503, { code: 'MODEL_NOT_INSTALLED', error: 'no timesfm' })).forecast(a)).status).toBe('MODEL_UNAVAILABLE');
    expect((await client(json(500, { code: 'INFERENCE_FAILED' })).forecast(a)).status).toBe('SERVICE_UNAVAILABLE');
    expect((await client(async () => { throw new Error('ECONNREFUSED'); }).forecast(a)).status).toBe('SERVICE_UNAVAILABLE');
    const hang = (async (_u: any, init: any) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as any;
    expect((await client(hang, { timeoutMs: 30 }).forecast(a)).status).toBe('TIMEOUT');
  });

  it('rejects malformed responses: wrong length, NaN, non-monotonic quantiles', async () => {
    const b = bars();
    const a = { symbol: 'X', timeframe: '1d', originMs: origin(b), horizon: H, bars: b };
    expect((await client(json(200, okBody(H - 1))).forecast(a)).status).toBe('MALFORMED_RESPONSE');
    const nan = okBody(); nan.point[2] = NaN as any;
    expect((await client(json(200, nan)).forecast(a)).status).toBe('MALFORMED_RESPONSE');
    const bad = okBody(); bad.quantiles.values[0] = [100, 99, 98, 99.8, 100, 100.2, 100.5, 100.8, 101, 101.5];
    expect((await client(json(200, bad)).forecast(a)).status).toBe('MALFORMED_RESPONSE');
  });

  it('coalesces identical in-flight requests and bounds the queue', async () => {
    const b = bars();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => { calls++; await gate; return { ok: true, status: 200, json: async () => okBody() } as any; }) as any;
    const c = client(slow, { maxConcurrent: 1, maxQueue: 1, timeoutMs: 5000 });
    const mk = (sym: string) => c.forecast({ symbol: sym, timeframe: '1d', originMs: origin(b), horizon: H, bars: b });
    const p1 = mk('A'); const p1dup = mk('A'); // coalesced
    const p2 = mk('B'); // queued
    const p3 = mk('C'); // rejected: queue full
    expect((await p3).status).toBe('QUEUE_FULL');
    release();
    expect((await p1).status).toBe('OK'); expect((await p1dup).status).toBe('OK'); expect((await p2).status).toBe('OK');
    expect(calls).toBe(2);
    expect(c.stats.coalesced).toBe(1);
  });

  it('refuses a non-loopback service URL', async () => {
    const b = bars();
    const r = await client(json(200, okBody()), { serviceUrl: 'http://example.com:8011' }).forecast({ symbol: 'X', timeframe: '1d', originMs: origin(b), horizon: H, bars: b });
    expect(r.status).toBe('INVALID_INPUT');
  });
});
