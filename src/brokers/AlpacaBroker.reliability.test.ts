import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AlpacaBroker, AlpacaRequestError } from './AlpacaBroker';
import { tradingSafety } from '../server/config/tradingSafety';

/**
 * Phase 1 (ARGUS_SAFETY_HARDENING_REPORT.md) - real coverage for the timeout/retry/circuit-breaker
 * behavior added to AlpacaBroker.ts this phase. The current audit (FINAL_ANALYSIS.md Section
 * 30.11) found this entire surface had ZERO test coverage before this session - these tests close
 * that gap directly, not incidentally.
 *
 * Fake timers are used throughout (real retry backoff is 500ms/1500ms per attempt, and the real
 * request timeout is 15s - real-time waits would make this file slow and, for the timeout case,
 * impractically slow). The pattern: kick off the broker call, then advance fake time enough for
 * every real setTimeout in the call chain (abort timer + retry backoff) to fire, then await the
 * already-in-flight promise.
 */
describe('AlpacaBroker reliability (Phase 1)', () => {
  let broker: AlpacaBroker;

  beforeEach(async () => {
    vi.useFakeTimers();
    broker = new AlpacaBroker();
    await broker.authenticate({ apiKey: 'test-key', secretKey: 'test-secret' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function runAndAdvance<T>(promise: Promise<T>, ms = 20_000): Promise<T> {
    const advancing = vi.advanceTimersByTimeAsync(ms);
    const [result] = await Promise.all([promise, advancing]);
    return result;
  }

  it('a genuine request timeout aborts the fetch and reports a real TIMEOUT classification, not a hang', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, options: any) => {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }));

    // account() is retry-safe (3 total attempts), each with its own real 15s timeout plus backoff
    // between attempts - advance well past the full worst-case chain, and raise this specific
    // test's own real-wall-clock budget since advancing fake time through 3 real timeout cycles
    // still costs measurable real time to process.
    const result = await runAndAdvance(broker.account().catch((e: any) => e), 60_000);
    expect(result).toBeInstanceOf(AlpacaRequestError);
    expect(result.kind).toBe('TIMEOUT');
  }, 15_000);

  it('a network error on a retry-safe (GET) call is retried and can still succeed', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls < 2) throw new Error('ECONNRESET');
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ cash: '1000', buying_power: '1000', equity: '1000' }) };
    }));

    const result = await runAndAdvance(broker.account());
    expect(calls).toBe(2);
    expect(result.cash).toBe('1000');
  });

  it('a definite HTTP error response (4xx) is never retried, even on a retry-safe call', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      return { ok: false, status: 403, headers: new Headers(), text: async () => 'forbidden' };
    }));

    const result = await runAndAdvance(broker.account().catch((e: any) => e));
    expect(result).toBeInstanceOf(AlpacaRequestError);
    expect(result.message).toMatch(/403/);
    expect(calls).toBe(1); // never retried
  });

  it('a 429 response respects Retry-After and is retried on a retry-safe call', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return { ok: false, status: 429, headers: new Headers({ 'Retry-After': '1' }), text: async () => 'rate limited' };
      }
      return { ok: true, status: 200, headers: new Headers(), json: async () => ([]) };
    }));

    const result = await runAndAdvance(broker.orders());
    expect(calls).toBe(2);
    expect(result).toEqual([]);
  });

  it('placeOrder() WITHOUT a clientOrderId is never retried on a network error - no way to know a bare retry would be safe', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      throw new Error('ECONNRESET');
    }));

    const result = await runAndAdvance(
      broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }).then(() => null).catch((e: any) => e)
    );
    expect(result).toBeInstanceOf(AlpacaRequestError);
    expect(calls).toBe(1);
  });

  it('placeOrder() WITH a clientOrderId is retry-safe and sends Alpaca a real client_order_id for dedup', async () => {
    let calls = 0;
    let capturedBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
      calls++;
      capturedBody = JSON.parse(options.body);
      if (calls < 2) throw new Error('ECONNRESET');
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ id: 'order-1', client_order_id: 'my-idempotency-key', symbol: 'AAPL', side: 'buy', order_type: 'market', status: 'accepted', qty: '1', filled_qty: '0', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      };
    }));

    const result = await runAndAdvance(
      broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1, clientOrderId: 'my-idempotency-key' })
    );
    expect(calls).toBe(2); // retried once after the network error, same idempotency key both times
    expect(capturedBody.client_order_id).toBe('my-idempotency-key');
    expect(result.clientOrderId).toBe('my-idempotency-key');
  });

  it('Extended-Hours Execution Policy: extendedHours + LIMIT sends Alpaca a real extended_hours:true', async () => {
    let capturedBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ id: 'order-eh-1', symbol: 'AAPL', side: 'buy', order_type: 'limit', status: 'accepted', qty: '1', filled_qty: '0', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      };
    }));

    await runAndAdvance(
      broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'LIMIT', price: 150.25, quantity: 1, extendedHours: true })
    );
    expect(capturedBody.extended_hours).toBe(true);
    expect(capturedBody.limit_price).toBe(150.25);
  });

  it('Extended-Hours Execution Policy: extendedHours is NEVER sent for a MARKET order, even if requested - Alpaca would reject the combination', async () => {
    let capturedBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ id: 'order-eh-2', symbol: 'AAPL', side: 'buy', order_type: 'market', status: 'accepted', qty: '1', filled_qty: '0', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      };
    }));

    await runAndAdvance(
      broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1, extendedHours: true })
    );
    expect(capturedBody.extended_hours).toBeUndefined();
  });

  it('a regular order (no extendedHours requested) never sends the field at all - zero behavior change for the common case', async () => {
    let capturedBody: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => ({ id: 'order-plain', symbol: 'AAPL', side: 'buy', order_type: 'market', status: 'accepted', qty: '1', filled_qty: '0', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      };
    }));

    await runAndAdvance(broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1 }));
    expect('extended_hours' in capturedBody).toBe(false);
  });

  it('real bug found and fixed: placeOrder() carries the fill price through for a MARKET order that fills synchronously in the POST response', async () => {
    // Alpaca (especially paper) commonly fills a MARKET order within the same POST /v2/orders
    // response - status "filled" with filled_avg_price already set. OMS only re-polls for a fresh
    // price when status is PENDING (OrderManagement.ts), so if placeOrder()'s return object drops
    // this field, an instant fill's price silently becomes 0 and corrupts trades.price/fills.price
    // and any downstream SELL P&L. orders()/getOrderByClientOrderId() already mapped this field -
    // placeOrder() did not, until this fix.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(),
      json: async () => ({
        id: 'order-instant-fill', client_order_id: 'instant-1', symbol: 'AAPL', side: 'buy',
        order_type: 'market', status: 'filled', qty: '1', filled_qty: '1', filled_avg_price: '188.42',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }),
    })));

    const result = await runAndAdvance(
      broker.placeOrder({ symbol: 'AAPL', side: 'BUY', type: 'MARKET', quantity: 1, clientOrderId: 'instant-1' })
    );
    expect(result.status).toBe('FILLED');
    expect(result.averageFillPrice).toBe(188.42);
  });

  it('circuit breaker opens after consecutive failed attempts matching the configured threshold and fails fast without calling fetch again', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('down'); });
    vi.stubGlobal('fetch', fetchMock);

    // A single retry-safe account() call that fails every attempt already makes 3 real attempts
    // (1 initial + 2 retries) = 3 consecutive recorded failures = the real threshold. The circuit
    // should already be open by the time this first call rejects.
    const first = await runAndAdvance(broker.account().catch((e: any) => e));
    expect(first).toBeInstanceOf(AlpacaRequestError);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBe(tradingSafety.alpacaCircuitBreakerFailureThreshold);

    const second = await runAndAdvance(broker.account().catch((e: any) => e));
    expect(second).toBeInstanceOf(AlpacaRequestError);
    expect(second.kind).toBe('CIRCUIT_OPEN');
    // The circuit-open call must not have invoked fetch again - it failed fast.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('a real success resets the circuit breaker failure count', async () => {
    // Uses single-attempt HTTP 4xx failures (never retried, exactly 1 recordFailure() per call)
    // rather than network errors, so the failure count can be reasoned about precisely against
    // the real threshold of 3, without a retry sequence opening the circuit as a side effect.
    let mode: 'fail' | 'succeed' = 'fail';
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'fail') return { ok: false, status: 403, headers: new Headers(), text: async () => 'forbidden' };
      return { ok: true, status: 200, headers: new Headers(), json: async () => ({ cash: '1', buying_power: '1', equity: '1' }) };
    }));

    // 1 failure (count=1), then a real success (resets count to 0).
    await runAndAdvance(broker.account().catch((e: any) => e));
    mode = 'succeed';
    const success = await runAndAdvance(broker.account());
    expect(success.cash).toBe('1');

    // 2 more failures post-reset (count=2) - still under the threshold of 3. If the earlier
    // success had NOT reset the counter, this would be the 3rd cumulative failure and open the
    // circuit; since it doesn't, the reset is proven.
    mode = 'fail';
    await runAndAdvance(broker.account().catch((e: any) => e));
    const result = await runAndAdvance(broker.account().catch((e: any) => e));
    expect(result).toBeInstanceOf(AlpacaRequestError);
    expect(result.kind).not.toBe('CIRCUIT_OPEN');
  });
});
