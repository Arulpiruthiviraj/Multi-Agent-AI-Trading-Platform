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

  beforeAll(async () => {
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

    // Regression assertion (P1 fix, 2026-09-03; hardened 2026-09-07): bootArgusCore() above just
    // ran a real beginRuntimeSession() write - prove it landed only in the isolated tmp path,
    // never the real production runtime-session file.
    //
    // 2026-09-07 readiness audit: the previous version of this assertion snapshotted the
    // production file's full content before and after, excluding only `lastHeartbeatAt`, on the
    // theory that a concurrently-running real engine only ever changes that one field between
    // ticks. That assumption broke live during this audit's own test run: a real, unplanned engine
    // restart happened to land in the exact window between this test's two snapshots, changing
    // `pid`/`parentPid`/`startedAt` too - a legitimate event on the operator's machine, unrelated
    // to this test, that nonetheless failed the old assertion. Comparing against a concurrently-
    // running production file's mutable content is inherently not parallel-safe or deterministic,
    // regardless of which fields are excluded - the fix is to stop depending on that content at
    // all. The real invariant this test needs to prove is narrower and does not care what a real
    // engine does concurrently: this vitest worker's own pid must never appear in the production
    // file, because that would mean the override above failed to redirect the write.
    let productionSessionAfter: { pid?: number } | null = null;
    try {
      productionSessionAfter = JSON.parse(fs.readFileSync(PRODUCTION_SESSION_PATH, 'utf8'));
    } catch {
      productionSessionAfter = null; // legitimately absent, or unreadable - either way, not this test's pid
    }
    if (productionSessionAfter) {
      expect(productionSessionAfter.pid).not.toBe(process.pid);
    }
    const tmpSessionContent = JSON.parse(fs.readFileSync(tmpSessionPath, 'utf8'));
    expect(tmpSessionContent.pid).toBe(process.pid);
  }, 120_000);
});
