import { describe, it, expect, vi } from 'vitest';
import { collectStartupHealth } from './StartupHealthRegistry';

describe('StartupHealthRegistry', () => {
  it('never marks Quant READY unless QUANT_ENGINE_ENABLED is true', async () => {
    const prev = process.env.QUANT_ENGINE_ENABLED;
    process.env.QUANT_ENGINE_ENABLED = 'false';
    const rows = await collectStartupHealth(200);
    const quant = rows.find((r) => r.service === 'QuantSignalAgent');
    expect(quant?.status).toBe('DISABLED');
    expect(quant?.impact).toMatch(/never flips the flag/);
    if (prev === undefined) delete process.env.QUANT_ENGINE_ENABLED;
    else process.env.QUANT_ENGINE_ENABLED = prev;
  });

  it('marks OpenAlice DISABLED when OPENALICE_ENABLED is false', async () => {
    const rows = await collectStartupHealth(200);
    const oa = rows.find((r) => r.service === 'OpenAlice');
    expect(oa?.status).toBe('DISABLED');
  });

  it('probes Chronos on :8008 even if LOCAL_AI_SERVICE_URL still says :8000', async () => {
    const prev = process.env.LOCAL_AI_SERVICE_URL;
    process.env.LOCAL_AI_SERVICE_URL = 'http://127.0.0.1:8000';
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any) => {
      seen.push(String(url));
      throw new Error('ECONNREFUSED');
    }) as any;
    try {
      await collectStartupHealth(50);
      expect(seen.some((u) => u.includes(':8008/health'))).toBe(true);
      expect(seen.some((u) => u.includes(':8000/health'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (prev === undefined) delete process.env.LOCAL_AI_SERVICE_URL;
      else process.env.LOCAL_AI_SERVICE_URL = prev;
    }
  });
});
