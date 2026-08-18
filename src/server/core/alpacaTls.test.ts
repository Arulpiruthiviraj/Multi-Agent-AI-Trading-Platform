import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isTlsOrCertificateError, alpacaFetch, getSystemCaCertificates } from './alpacaTls';

describe('alpacaTls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('classifies UNABLE_TO_VERIFY_LEAF_SIGNATURE as a TLS error', () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
    });
    expect(isTlsOrCertificateError(err)).toBe(true);
  });

  it('does not treat generic network errors as TLS errors', () => {
    expect(isTlsOrCertificateError(new Error('ECONNRESET'))).toBe(false);
  });

  it('returns primary fetch result when TLS succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true}', { status: 200 })));
    const res = await alpacaFetch('https://paper-api.alpaca.markets/v2/account');
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('falls back to system CA https when default fetch fails TLS verification', async () => {
    const tlsErr = Object.assign(new Error('fetch failed'), {
      cause: Object.assign(new Error('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw tlsErr; }));

    const ca = getSystemCaCertificates();
    expect(ca.length).toBeGreaterThan(0);

    const res = await alpacaFetch('https://paper-api.alpaca.markets/v2/account', {
      headers: { Accept: 'application/json' },
    });
    // Live network may 401/403 without keys — success means TLS handshake completed, not auth.
    expect(res.status).toBeGreaterThan(0);
    expect(res.status).not.toBe(0);
  }, 20_000);
});
