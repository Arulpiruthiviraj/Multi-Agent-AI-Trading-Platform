import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'os';
import { existsSync, unlinkSync } from 'node:fs';

describe('ArgusEngineRuntime', () => {
  let tmpDb: string;

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `argus_engine_rt_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDb;
    process.env.PAPER_TRADING_ONLY = 'true';
    const { resetArgusCoreBootedForTests } = await import('../core/ArgusCoreBoot');
    resetArgusCoreBootedForTests();
    const { argusRuntime } = await import('../core/ArgusRuntime');
    argusRuntime.resetForTests();
  });

  afterEach(() => {
    if (existsSync(tmpDb)) {
      try { unlinkSync(tmpDb); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-wal`); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-shm`); } catch { /* ignore */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('startArgusEngineCore boots existing runtime without Vite', async () => {
    const { startArgusEngineCore, getArgusEngineHealth } = await import('./ArgusEngineRuntime');
    await startArgusEngineCore();
    const health = getArgusEngineHealth();
    expect(health.coreBooted).toBe(true);
    expect(health.pid).toBe(process.pid);
  }, 60_000);
});
