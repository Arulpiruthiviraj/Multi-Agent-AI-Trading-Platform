/**
 * 2026-10-04 (IBKR Web API request timeout): the adapter's https.request previously had no
 * timeout - a Gateway that accepted the connection but never responded hung the promise
 * forever (including placeOrder). The timeout must reject as UNKNOWN (never FAILED), must
 * not be overwritable by a later socket error, and must carry the reconcile-by-clientOrderId
 * instruction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';

vi.mock('../server/config/ibkrConnection', () => ({
  loadIbkrConnection: () => ({ webApiRequestTimeoutMs: 120 }),
}));

import { InteractiveBrokersWebApiAdapter } from './InteractiveBrokersWebApiAdapter';

function fakeSilentRequest() {
  // Simulates a Gateway that accepts the connection but never responds and never errors
  // until we destroy it. setTimeout captures the callback; destroy() then emits 'error'
  // like a real destroyed socket would - exercising the settled-guard.
  const req = new EventEmitter() as any;
  let timeoutCb: (() => void) | null = null;
  req.setTimeout = vi.fn((ms: number, cb: () => void) => { timeoutCb = cb; return req; });
  req.destroy = vi.fn(() => { req.emit('error', new Error('socket hang up')); return req; });
  req.write = vi.fn();
  req.end = vi.fn();
  req.fireTimeout = () => timeoutCb?.();
  return req;
}

describe('InteractiveBrokersWebApiAdapter request timeout', () => {
  let httpsRequestSpy: any;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects with BROKER_TIMEOUT (outcome UNKNOWN) when the gateway stays silent', async () => {
    const req = fakeSilentRequest();
    httpsRequestSpy = vi.spyOn(https, 'request').mockImplementation((..._args: any[]) => {
      const cb = _args[1];
      // Never invoke the response callback - silent gateway.
      void cb;
      return req;
    });

    const adapter = new InteractiveBrokersWebApiAdapter('https://localhost:5000/v1/api');
    const promise = (adapter as any).request('/iserver/auth/status');
    const assertion = expect(promise).rejects.toThrow(/BROKER_TIMEOUT.*outcome UNKNOWN.*reconcile by clientOrderId/);
    // Fire the captured req.setTimeout callback directly (the fake request is not a real timer).
    req.fireTimeout();
    await assertion;
    expect(req.setTimeout).toHaveBeenCalledWith(120, expect.any(Function));
    expect(req.destroy).toHaveBeenCalled();
  });

  it('a late socket error after the timeout does not overwrite the timeout rejection', async () => {
    const req = fakeSilentRequest();
    httpsRequestSpy = vi.spyOn(https, 'request').mockImplementation((..._args: any[]) => req);

    const adapter = new InteractiveBrokersWebApiAdapter('https://localhost:5000/v1/api');
    const promise = (adapter as any).request('/iserver/account/DU123/orders', { method: 'POST', body: { orders: [] } });
    const assertion = expect(promise).rejects.toThrow(/BROKER_TIMEOUT/);
    req.fireTimeout();
    // The destroy() already emitted a late 'error' (socket hang up) - the settled guard
    // must keep the original BROKER_TIMEOUT rejection, not replace it with a connection error.
    await assertion;
  });

  it('a responding gateway still resolves normally (timeout does not break the happy path)', async () => {
    const req = fakeSilentRequest();
    httpsRequestSpy = vi.spyOn(https, 'request').mockImplementation((...args: any[]) => {
      const cb = args[1];
      const res = new EventEmitter() as any;
      res.statusCode = 200;
      // Respond well before the timeout.
      setImmediate(() => {
        cb(res);
        res.emit('data', JSON.stringify({ ok: true }));
        res.emit('end');
      });
      return req;
    });

    const adapter = new InteractiveBrokersWebApiAdapter('https://localhost:5000/v1/api');
    const promise = (adapter as any).request('/iserver/auth/status');
    // Let the setImmediate response fire (real timers - no fake-timer interference).
    await new Promise((r) => setTimeout(r, 20));
    await expect(promise).resolves.toEqual({ ok: true });
  });
});
