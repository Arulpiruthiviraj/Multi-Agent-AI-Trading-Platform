import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// safeFetch.ts's own SSRF policy (urlSafety.ts) blocks loopback/private addresses by design - that
// is the exact thing under test for F29, so these tests cannot exercise a "successful connection"
// scenario against a real listener without either (a) real outbound internet access, or (b)
// mocking urlSafety's checkUrlSafety() to control what "safe target" resolves to, while still
// running safeFetch's REAL connection/redirect/timeout logic against a REAL local server. Per the
// task's own instruction ("local mock transport/DNS fixtures... never real outbound network
// calls"), (b) is what these tests do: urlSafety is mocked (standing in for "DNS resolved this
// hostname to X, and X passed/failed policy"), while the actual TCP connection, redirect
// resolution, timeout, and body handling in safeFetch.ts are fully real, exercised against an
// in-process http server bound to loopback only (never a real outbound call).
vi.mock('./urlSafety', () => ({
  checkUrlSafety: vi.fn(),
}));

import { safeFetch, SafeFetchBlockedError } from './safeFetch';
import { checkUrlSafety } from './urlSafety';

const mockCheckUrlSafety = vi.mocked(checkUrlSafety);

function safeTarget(address: string, port: number, protocol: 'http:' = 'http:') {
  return { safe: true as const, hostname: 'test.local', address, family: 4 as const, protocol, port };
}

describe('safeFetch - connection-time SSRF re-check and redirect handling (F29)', () => {
  let server: http.Server;
  let port: number;

  afterEach(() => {
    vi.clearAllMocks();
    if (server) server.close();
  });

  it('connects to the address checkUrlSafety resolved and returns the response body/status', async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    mockCheckUrlSafety.mockResolvedValue(safeTarget('127.0.0.1', port));

    const res = await safeFetch('http://test.local/webhook', { timeoutMs: 3000 });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.body).toBe('ok');
  });

  it('refuses to connect at all when checkUrlSafety blocks the target - no connection attempted', async () => {
    mockCheckUrlSafety.mockResolvedValue({ safe: false, reason: 'blocked for test' });

    await expect(safeFetch('http://internal.example/', { timeoutMs: 1000 })).rejects.toThrow(SafeFetchBlockedError);
  });

  it('does not follow a redirect to a blocked destination - fails closed rather than connecting', async () => {
    server = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://internal-target.example/steal' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    // First hop (the originally-configured URL) is allowed; the redirect target is re-checked
    // independently and is blocked - this is exactly the F29 gap (an initially-allowed URL
    // redirecting to an internal target).
    mockCheckUrlSafety.mockImplementation(async (url: string) => {
      if (url === 'http://allowed.example/start') return safeTarget('127.0.0.1', port);
      return { safe: false, reason: `"${url}" is blocked (simulated internal redirect target)` };
    });

    await expect(
      safeFetch('http://allowed.example/start', { timeoutMs: 3000, maxRedirects: 3 }),
    ).rejects.toThrow(SafeFetchBlockedError);
    // Both hops must have been independently checked - proves the redirect target was re-validated,
    // not assumed safe because the first hop passed.
    expect(mockCheckUrlSafety).toHaveBeenCalledWith('http://allowed.example/start');
    expect(mockCheckUrlSafety).toHaveBeenCalledWith('http://internal-target.example/steal');
  });

  it('follows an allowed-to-allowed redirect chain when both hops pass policy', async () => {
    const finalServer = http.createServer((req, res) => {
      res.writeHead(200);
      res.end('final-destination');
    });
    await new Promise<void>((resolve) => finalServer.listen(0, '127.0.0.1', resolve));
    const finalPort = (finalServer.address() as AddressInfo).port;

    server = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://allowed-second-hop.example/' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    mockCheckUrlSafety.mockImplementation(async (url: string) => {
      if (url === 'http://allowed-first-hop.example/') return safeTarget('127.0.0.1', port);
      if (url === 'http://allowed-second-hop.example/') return safeTarget('127.0.0.1', finalPort);
      return { safe: false, reason: 'unexpected url in test' };
    });

    try {
      const res = await safeFetch('http://allowed-first-hop.example/', { timeoutMs: 3000, maxRedirects: 2 });
      expect(res.status).toBe(200);
      expect(res.body).toBe('final-destination');
    } finally {
      finalServer.close();
    }
  });

  it('rejects a redirect chain exceeding maxRedirects rather than following it indefinitely', async () => {
    server = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://allowed.example/loop' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;

    mockCheckUrlSafety.mockResolvedValue(safeTarget('127.0.0.1', port));

    await expect(
      safeFetch('http://allowed.example/loop', { timeoutMs: 3000, maxRedirects: 1 }),
    ).rejects.toThrow(/exceeded max redirects/i);
  });

  it('rejects a URL that resolves to a different (blocked) address on a later hop (DNS-rebinding-style TOCTOU)', async () => {
    // Simulates the exact F29 scenario: the same hostname resolves safely once, then resolves
    // differently (blocked) on a subsequent connection-time re-check.
    let call = 0;
    mockCheckUrlSafety.mockImplementation(async () => {
      call += 1;
      if (call === 1) return safeTarget('127.0.0.1', 1); // first hop only used to prove distinct calls
      return { safe: false, reason: 'resolved to a different, blocked address on this call' };
    });
    // First call's "server" at port 1 will simply fail to connect (nothing listening) - that's
    // fine, this test's point is exercising re-check-per-hop via a redirect, so drive it through
    // an actual redirect instead.
    server = http.createServer((req, res) => {
      res.writeHead(302, { Location: 'http://same-host.example/' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    call = 0;
    mockCheckUrlSafety.mockImplementation(async (url: string) => {
      call += 1;
      if (call === 1) return safeTarget('127.0.0.1', port);
      return { safe: false, reason: 'now resolves to a blocked address' };
    });

    await expect(
      safeFetch('http://same-host.example/first', { timeoutMs: 3000, maxRedirects: 2 }),
    ).rejects.toThrow(SafeFetchBlockedError);
  });

  it('times out a hung receiver within the configured budget rather than hanging indefinitely', async () => {
    server = http.createServer(() => {
      // Never respond.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    mockCheckUrlSafety.mockResolvedValue(safeTarget('127.0.0.1', port));

    const startedAt = Date.now();
    await expect(safeFetch('http://hung.example/', { timeoutMs: 500 })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });

  it('reports non-2xx status as !ok rather than throwing or treating it as success', async () => {
    server = http.createServer((req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    mockCheckUrlSafety.mockResolvedValue(safeTarget('127.0.0.1', port));

    const res = await safeFetch('http://flaky.example/', { timeoutMs: 3000 });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
  });
});
