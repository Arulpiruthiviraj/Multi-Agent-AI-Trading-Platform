import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectStartupHealth } from './StartupHealthRegistry';

describe('StartupHealthRegistry', () => {
  describe('Watchdog entry (external liveness watchdog heartbeat)', () => {
    let tmpPath: string;
    let prevEnv: string | undefined;

    function setUp() {
      tmpPath = path.join(os.tmpdir(), `argus_watchdog_hb_${Date.now()}_${process.pid}.json`);
      prevEnv = process.env.ARGUS_WATCHDOG_HEARTBEAT_PATH;
      process.env.ARGUS_WATCHDOG_HEARTBEAT_PATH = tmpPath;
    }
    function tearDown() {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      if (prevEnv === undefined) delete process.env.ARGUS_WATCHDOG_HEARTBEAT_PATH;
      else process.env.ARGUS_WATCHDOG_HEARTBEAT_PATH = prevEnv;
    }

    it('is NOT_CONFIGURED when the heartbeat file does not exist (watchdog never started)', async () => {
      setUp();
      try {
        const rows = await collectStartupHealth(200);
        const wd = rows.find((r) => r.service === 'Watchdog');
        expect(wd?.status).toBe('NOT_CONFIGURED');
      } finally {
        tearDown();
      }
    });

    it('is READY when the heartbeat is fresh', async () => {
      setUp();
      try {
        fs.writeFileSync(tmpPath, JSON.stringify({ pid: 1234, lastTickAt: new Date().toISOString(), state: 'HEALTHY' }));
        const rows = await collectStartupHealth(200);
        const wd = rows.find((r) => r.service === 'Watchdog');
        expect(wd?.status).toBe('READY');
        expect(wd?.rootCause).toBeNull();
      } finally {
        tearDown();
      }
    });

    it('is FAILED when the heartbeat is stale - the watchdog process itself may have died', async () => {
      setUp();
      try {
        const staleTs = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 minutes ago
        fs.writeFileSync(tmpPath, JSON.stringify({ pid: 1234, lastTickAt: staleTs, state: 'HEALTHY' }));
        const rows = await collectStartupHealth(200);
        const wd = rows.find((r) => r.service === 'Watchdog');
        expect(wd?.status).toBe('FAILED');
        expect(wd?.rootCause).toMatch(/stale/i);
      } finally {
        tearDown();
      }
    });
  });
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
