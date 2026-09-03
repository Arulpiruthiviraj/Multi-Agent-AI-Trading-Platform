import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// The real production path sessionRecovery.ts falls back to when no test override is set - the
// exact file this test must never touch. Read directly here (not imported) so this regression
// check does not depend on sessionRecovery.ts's own DEFAULT_PATH constant staying exported.
const PRODUCTION_SESSION_PATH = path.join(process.cwd(), 'data', '.argus_runtime_session.json');

describe('ArgusCoreBoot', () => {
  let tmpDbPath: string;
  let tmpSessionPath: string;
  let sqliteDb: any;
  let productionSessionSnapshot: string | null;

  beforeAll(async () => {
    // Snapshot BEFORE overriding the session-recovery path, so this proves the production file is
    // untouched by this test run specifically - not merely absent for unrelated reasons.
    try {
      productionSessionSnapshot = fs.readFileSync(PRODUCTION_SESSION_PATH, 'utf8');
    } catch {
      productionSessionSnapshot = null; // legitimately absent (e.g. a fresh clone) - still asserted below
    }

    tmpDbPath = path.join(os.tmpdir(), `argus_coreboot_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    // Real bug found live (2026-09-03 P0 soak audit): bootArgusCore() calls
    // sessionRecovery.ts's beginRuntimeSession() for real, and that module's DEFAULT_PATH has no
    // env-var override - only this test-only setter. Without it, this test was writing a real
    // vitest-worker PID into the ACTUAL production data/.argus_runtime_session.json on every run,
    // corrupting the crash-forensics marker the real running engine depends on (confirmed live: a
    // fake pid/startedAt from a test run landed in that file, overwriting whatever the real prior
    // session had recorded).
    const { setSessionRecoveryPathForTests } = await import('./sessionRecovery');
    tmpSessionPath = path.join(os.tmpdir(), `argus_coreboot_session_${Date.now()}_${process.pid}.json`);
    setSessionRecoveryPathForTests(tmpSessionPath);
  });

  afterAll(async () => {
    const { resetArgusCoreBootedForTests } = await import('./ArgusCoreBoot');
    const { resetSessionRecoveryForTests } = await import('./sessionRecovery');
    resetArgusCoreBootedForTests();
    resetSessionRecoveryForTests();
    try { sqliteDb?.close(); } catch { /* ignore */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(tmpSessionPath); } catch { /* ignore */ }
    delete process.env.ARGUS_DB_PATH;
  });

  it('boots engine spine without Express or Vite', async () => {
    const { bootArgusCore, isArgusCoreBooted } = await import('./ArgusCoreBoot');
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { system } = await import('./SystemBootstrap');
    const { BrokerManager } = await import('../../brokers/BrokerManager');

    expect(isArgusCoreBooted()).toBe(false);
    await bootArgusCore();
    expect(isArgusCoreBooted()).toBe(true);
    expect(BrokerManager.getInstance().getActiveBroker()).toBeTruthy();

    expect(tradingEngine.state.tradingMode).toBeTruthy();
    expect(system.getStatus().dbConnected).toBe(true);

    ({ sqliteDb } = await import('../db'));

    // Regression assertion (P1 fix, 2026-09-03): bootArgusCore() above just ran a real
    // beginRuntimeSession() write - prove it landed only in the isolated tmp path and the real
    // production runtime-session file is byte-identical to what it was before this test started
    // (or still absent, if it was absent before).
    let productionSessionAfter: string | null;
    try {
      productionSessionAfter = fs.readFileSync(PRODUCTION_SESSION_PATH, 'utf8');
    } catch {
      productionSessionAfter = null;
    }
    expect(productionSessionAfter).toBe(productionSessionSnapshot);
    expect(fs.existsSync(tmpSessionPath)).toBe(true);
  }, 120_000);
});
