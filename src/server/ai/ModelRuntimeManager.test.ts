import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preferIpv4Loopback } from './preferIpv4Loopback';

vi.mock('../core/EventBus', () => ({ eventBus: { emit: vi.fn() } }));
vi.mock('../integrations/openalice/OpenAliceVerificationService', () => ({
  openAliceVerificationService: {
    enabled: false,
    mcpUrl: null,
    health: async () => ({ reachable: false, detail: 'disabled', checkedAt: new Date().toISOString() }),
  },
}));

describe('ModelRuntimeManager', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env.ARGUS_START_LOCAL_MODELS = 'false';
    process.env.ARGUS_START_CHRONOS = 'false';
    delete process.env.IBKR_GATEWAY_URL;
    delete process.env.ARGUS_PROBE_IBKR;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('marks Ollama READY when /api/tags succeeds and FAILED when it does not', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) } as any;
      if (u.includes('/health')) return { ok: false, json: async () => ({}) } as any;
      return { ok: false, json: async () => ({}) } as any;
    }) as any;

    const { modelRuntimeManager } = await import('./ModelRuntimeManager');
    const models = await modelRuntimeManager.refresh();
    const ollama = models.find((m: any) => m.modelId === 'ollama');
    const chronos = models.find((m: any) => m.modelId === 'chronos-kronos');
    expect(ollama.health).toBe('READY');
    expect(ollama.loaded).toBe(true);
    expect(chronos.health).toBe('FAILED');
    expect(chronos.action).toMatch(/npm run dev starts Chronos/);
  });

  it('does not spawn processes when ARGUS_START_LOCAL_MODELS is not true', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const { modelRuntimeManager } = await import('./ModelRuntimeManager');
    const models = await modelRuntimeManager.startAndProbe();
    expect(models.every((m: any) => m.health !== 'STARTING')).toBe(true);
    expect(models.find((m: any) => m.modelId === 'ibkr-gateway').health).toBe('DISABLED');
  });
});

describe('preferIpv4Loopback', () => {
  it('rewrites localhost to 127.0.0.1 so Windows IPv6 localhost does not miss IPv4-bound Python', () => {
    expect(preferIpv4Loopback('http://localhost:8008')).toBe('http://127.0.0.1:8008');
    expect(preferIpv4Loopback('http://127.0.0.1:8008/')).toBe('http://127.0.0.1:8008');
    expect(preferIpv4Loopback('https://example.com/v1')).toBe('https://example.com/v1');
  });
});
