import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TuiApiClient } from './api';

/**
 * TUI data-client tests (2026-10-06): the client must call the real,
 * existing, read-only endpoints — verified against the route table.
 * No trading logic lives here; this only pins the presentation layer's
 * data sources so a renamed route breaks a test, not the terminal.
 */

describe('TuiApiClient', () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }));
  });

  it('calls the verified read-only endpoints', async () => {
    const c = new TuiApiClient('http://127.0.0.1:3400');
    await c.status();
    await c.health();
    await c.readiness();
    await c.portfolio();
    await c.orders();
    await c.observability();
    await c.marketStatus();
    await c.agentHealth();
    await c.consensus();
    await c.risk();
    await c.events();

    const paths = calls.map((u) => u.replace('http://127.0.0.1:3400', ''));
    expect(paths).toEqual([
      '/api/v2/runtime/status',
      '/api/v2/runtime/health',
      '/api/v2/live-readiness',
      '/api/v2/portfolio',
      '/api/v2/orders',
      '/api/v2/observability/metrics',
      '/api/v2/runtime/market/status',
      '/api/v2/system/status',
      '/api/v2/observability/consensus-report',
      '/api/v2/runtime/risk/status',
      '/api/v2/observability/events?limit=50',
    ]);
  });

  it('throws on HTTP errors so screens show the error state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 } as Response)));
    const c = new TuiApiClient('http://127.0.0.1:3400');
    await expect(c.status()).rejects.toThrow('HTTP 500');
  });
});
