import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { existsSync, unlinkSync } from 'node:fs';

describe('ArgusRuntime lifecycle', () => {
  let tmpDb: string;

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `argus_runtime_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDb;
    const { resetArgusCoreBootedForTests } = await import('./ArgusCoreBoot');
    resetArgusCoreBootedForTests();
    const { argusRuntime } = await import('./ArgusRuntime');
    argusRuntime.resetForTests();
  });

  it('initialize transitions STOPPED → RUNNING without Express', async () => {
    const { argusRuntime } = await import('./ArgusRuntime');
    expect(argusRuntime.getSnapshot().phase).toBe('STOPPED');
    await argusRuntime.initialize();
    expect(argusRuntime.getSnapshot().phase).toMatch(/RUNNING|SAFE_MODE/);
    const health = argusRuntime.health();
    expect(health.coreBooted).toBe(true);
    // R4 diagnostic-logging fix (2026-09-07): health() must surface enough of
    // MarketDataWorker.getFeedStatus() to actually diagnose a marketDataConnected:false report,
    // not just the bare boolean the Sept-6 audit found insufficient.
    expect(typeof health.marketDataAuthenticated).toBe('boolean');
    expect(health.marketDataLastError === null || typeof health.marketDataLastError === 'string').toBe(true);
    expect(health.marketDataReadyState === null || typeof health.marketDataReadyState === 'number').toBe(true);
  }, 60_000);

  it('stop pauses trading without throwing', async () => {
    const { argusRuntime } = await import('./ArgusRuntime');
    await argusRuntime.initialize();
    const result = await argusRuntime.stop({ reason: 'test', actor: 'test' });
    expect(result.ok).toBe(true);
    expect(argusRuntime.getSnapshot().phase).toMatch(/SAFE_MODE|STOPPING|STOPPED/);
  }, 60_000);

  afterEach(() => {
    if (existsSync(tmpDb)) {
      try { unlinkSync(tmpDb); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-wal`); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-shm`); } catch { /* ignore */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });
});
