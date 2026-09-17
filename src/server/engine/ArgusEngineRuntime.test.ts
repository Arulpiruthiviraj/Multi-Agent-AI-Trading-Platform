import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'os';
import { existsSync, unlinkSync } from 'node:fs';

describe('ArgusEngineRuntime', () => {
  let tmpDb: string;
  let tmpSessionPath: string;

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `argus_engine_rt_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDb;
    process.env.PAPER_TRADING_ONLY = 'true';
    // P1 isolation fix (2026-09-15) - see ArgusRuntime.test.ts's identical fix and
    // productionRuntimePathGuard.ts's own header for the real incident this closes: this test
    // boots the real core without isolating sessionRecovery's file path, which silently touched
    // the real data/.argus_runtime_session.json file (shared with a real live engine) before this
    // fix.
    tmpSessionPath = path.join(os.tmpdir(), `argus_engine_rt_session_${Date.now()}_${process.pid}.json`);
    const { setSessionRecoveryPathForTests } = await import('../core/sessionRecovery');
    setSessionRecoveryPathForTests(tmpSessionPath);
    const { resetArgusCoreBootedForTests } = await import('../core/ArgusCoreBoot');
    resetArgusCoreBootedForTests();
    const { argusRuntime } = await import('../core/ArgusRuntime');
    argusRuntime.resetForTests();
  });

  afterEach(async () => {
    if (existsSync(tmpDb)) {
      try { unlinkSync(tmpDb); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-wal`); } catch { /* ignore */ }
      try { unlinkSync(`${tmpDb}-shm`); } catch { /* ignore */ }
    }
    delete process.env.ARGUS_DB_PATH;
    const { resetSessionRecoveryForTests } = await import('../core/sessionRecovery');
    resetSessionRecoveryForTests();
    if (existsSync(tmpSessionPath)) {
      try { unlinkSync(tmpSessionPath); } catch { /* ignore */ }
    }
  });

  it('startArgusEngineCore boots existing runtime without Vite', async () => {
    const { startArgusEngineCore, getArgusEngineHealth } = await import('./ArgusEngineRuntime');
    await startArgusEngineCore();
    const health = getArgusEngineHealth();
    expect(health.coreBooted).toBe(true);
    expect(health.pid).toBe(process.pid);
  }, 60_000);
});
