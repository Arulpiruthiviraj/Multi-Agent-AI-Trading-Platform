import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preferIpv4Loopback, resolveLocalAiServiceUrl } from './preferIpv4Loopback';

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

  it('marks Ollama READY when /api/tags succeeds AND a real completion succeeds; FAILED when tags does not', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) } as any;
      if (u.includes('/api/generate')) return { ok: true, json: async () => ({ response: 'pong' }) } as any;
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

  it('marks Ollama FAILED (not a false READY) when /api/tags succeeds but a real completion fails — real gap found in the 2026-08-26 forensic audit', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) } as any;
      if (u.includes('/api/generate')) return { ok: false, status: 500, json: async () => ({}) } as any;
      return { ok: false, json: async () => ({}) } as any;
    }) as any;

    const { modelRuntimeManager } = await import('./ModelRuntimeManager');
    const models = await modelRuntimeManager.refresh();
    const ollama = models.find((m: any) => m.modelId === 'ollama');
    expect(ollama.health).toBe('FAILED');
    expect(ollama.loaded).toBe(false);
    expect(ollama.detail).toMatch(/completion probe failed/);
  });

  it('marks Ollama FAILED when /api/tags succeeds but the completion response body is empty (e.g. a silently-failed model load)', async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) } as any;
      if (u.includes('/api/generate')) return { ok: true, json: async () => ({ response: '' }) } as any;
      return { ok: false, json: async () => ({}) } as any;
    }) as any;

    const { modelRuntimeManager } = await import('./ModelRuntimeManager');
    const models = await modelRuntimeManager.refresh();
    const ollama = models.find((m: any) => m.modelId === 'ollama');
    expect(ollama.health).toBe('FAILED');
  });

  it('does not spawn processes when ARGUS_START_LOCAL_MODELS is not true', async () => {
    process.env.ARGUS_SKIP_IBKR = 'true';
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const { modelRuntimeManager } = await import('./ModelRuntimeManager');
    const models = await modelRuntimeManager.startAndProbe();
    expect(models.every((m: any) => m.health !== 'STARTING')).toBe(true);
    // Explicit skip — inactive IBKR must not flip the registry to STARTING via spawn.
    expect(models.find((m: any) => m.modelId === 'ibkr-gateway').health).toBe('DISABLED');
    delete process.env.ARGUS_SKIP_IBKR;
  });
});

describe('preferIpv4Loopback', () => {
  it('rewrites localhost to 127.0.0.1 so Windows IPv6 localhost does not miss IPv4-bound Python', () => {
    expect(preferIpv4Loopback('http://localhost:8008')).toBe('http://127.0.0.1:8008');
    expect(preferIpv4Loopback('http://127.0.0.1:8008/')).toBe('http://127.0.0.1:8008');
    expect(preferIpv4Loopback('https://example.com/v1')).toBe('https://example.com/v1');
  });

  it('remaps legacy Chronos :8000 to :8008', () => {
    expect(resolveLocalAiServiceUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8008');
    expect(resolveLocalAiServiceUrl('http://localhost:8000/')).toBe('http://127.0.0.1:8008');
  });
});
