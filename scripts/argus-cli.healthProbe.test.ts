import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Real, live-reproduced double-engine incident fix (2026-09-12). A restart during a busy moment
 * of this codebase's own recurring heartbeat-staleness pattern (see data/logs/watchdog.log) caused
 * waitForHealthGone() to conclude "the old process is confirmed gone" from a request that merely
 * TIMED OUT (server alive but slow), not from a genuine ECONNREFUSED (server actually down). That
 * false "gone" conclusion let startEngine() spawn a second real engine while the first was still
 * bound to the port - the second became a fully-live, untracked, unreachable-via-HTTP zombie (real
 * IBKR/Ollama/broker connections; only stopped when it later crashed on its own).
 *
 * These tests use real local HTTP servers (not mocked fetch) to reproduce both failure modes
 * exactly as Node's own fetch/undici report them: ECONNREFUSED (nothing listening) vs a genuine
 * timeout (server accepts the connection but never responds).
 */
describe('argus-cli health-probe error classification (2026-09-12 fix)', () => {
  let server: http.Server | null = null;
  let port = 0;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    delete process.env.ARGUS_CLI_FETCH_TIMEOUT_MS;
  });

  function startServer(handler: http.RequestListener): Promise<number> {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        resolve((server!.address() as AddressInfo).port);
      });
    });
  }

  it('probeHealth returns {kind: "refused"} for a genuinely closed port (ECONNREFUSED)', async () => {
    // Find a free port, then immediately release it - guaranteed nothing is listening there.
    const probePort = await startServer((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    process.env.ARGUS_API_URL = `http://127.0.0.1:${probePort}`;
    const { probeHealth } = await import(/* @vite-ignore */ `./argus-cli?refused-${probePort}`);
    const result = await probeHealth();
    expect(result.kind).toBe('refused');
  });

  it('probeHealth returns {kind: "unknown"} (never "refused") when the server is alive but never responds (timeout)', async () => {
    port = await startServer(() => { /* accept the connection, never respond - simulates a busy/slow engine */ });
    process.env.ARGUS_API_URL = `http://127.0.0.1:${port}`;
    process.env.ARGUS_CLI_FETCH_TIMEOUT_MS = '300';
    const { probeHealth } = await import(/* @vite-ignore */ `./argus-cli?timeout-${port}`);
    const result = await probeHealth();
    expect(result.kind).toBe('unknown');
  });

  it('probeHealth returns {kind: "answered", pid} for a real healthy response', async () => {
    port = await startServer((req, res) => {
      if (req.url === '/api/v2/runtime/health') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, health: { pid: 12345 } }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    process.env.ARGUS_API_URL = `http://127.0.0.1:${port}`;
    const { probeHealth } = await import(/* @vite-ignore */ `./argus-cli?answered-${port}`);
    const result = await probeHealth();
    expect(result).toEqual({ kind: 'answered', pid: 12345 });
  });

  it('waitForHealthGone does NOT falsely conclude "gone" while the server is merely slow - only a genuine refusal counts', async () => {
    port = await startServer(() => { /* never responds */ });
    process.env.ARGUS_API_URL = `http://127.0.0.1:${port}`;
    process.env.ARGUS_CLI_FETCH_TIMEOUT_MS = '200';
    const { waitForHealthGone } = await import(/* @vite-ignore */ `./argus-cli?wfhg-slow-${port}`);

    // Bounded to slightly more than one polling cycle (300ms interval + 200ms timeout) - proves it
    // keeps looping (not immediately concluding "gone") rather than testing the full 15s default.
    const result = await waitForHealthGone(600);
    expect(result).toBe(false);
  });

  it('waitForHealthGone returns true promptly once the server genuinely stops listening', async () => {
    const probePort = await startServer((_req, res) => res.end());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;

    process.env.ARGUS_API_URL = `http://127.0.0.1:${probePort}`;
    const { waitForHealthGone } = await import(/* @vite-ignore */ `./argus-cli?wfhg-gone-${probePort}`);
    const result = await waitForHealthGone(5_000);
    expect(result).toBe(true);
  });
});
