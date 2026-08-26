import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import {
  resolveEnginePidPath,
  claimEnginePid,
  clearEnginePid,
  isEngineProcessRunning,
  isPidAlive,
  isPidLikelyArgusProcess,
  readEnginePid,
  reconcileEnginePidFile,
  writeEnginePid,
} from './enginePid';

/**
 * Real bug found and fixed alongside this test's own isolation (2026-08-25): this file used to
 * import the real, non-overridable ENGINE_PID_PATH and read/write/delete it directly - meaning
 * every run of `npm test` operated on the actual developer-facing data/.argus_engine.pid, and this
 * describe block's own afterEach unconditionally cleared it, silently wiping out a real running
 * dev engine's pid file. ARGUS_ENGINE_PID_PATH now isolates this suite to a disposable temp file.
 */
describe('enginePid', () => {
  const originalOverride = process.env.ARGUS_ENGINE_PID_PATH;
  const tmpPidPath = join(os.tmpdir(), `argus_engine_pid_test_${Date.now()}_${process.pid}.pid`);

  beforeAll(() => {
    process.env.ARGUS_ENGINE_PID_PATH = tmpPidPath;
  });

  afterAll(() => {
    try { unlinkSync(tmpPidPath); } catch { /* best-effort cleanup */ }
    if (originalOverride === undefined) delete process.env.ARGUS_ENGINE_PID_PATH;
    else process.env.ARGUS_ENGINE_PID_PATH = originalOverride;
  });

  afterEach(() => {
    clearEnginePid();
  });

  it('isPidAlive detects this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('stale PID file is cleared by reconcileEnginePidFile', () => {
    mkdirSync(dirname(resolveEnginePidPath()), { recursive: true });
    writeFileSync(resolveEnginePidPath(), '99999999', 'utf8');
    const result = reconcileEnginePidFile();
    expect(result.running).toBe(false);
    expect(result.staleCleared).toBe(true);
    expect(readEnginePid()).toBeNull();
  });

  it('claimEnginePid records this process', () => {
    claimEnginePid();
    expect(isEngineProcessRunning()).toBe(true);
    expect(readEnginePid()).toBe(process.pid);
  });

  it('claimEnginePid throws when another live pid holds the file', () => {
    writeEnginePid(process.pid);
    expect(() => claimEnginePid(process.pid + 1)).toThrow(/already running/);
  });

  describe('isPidLikelyArgusProcess (PID-reuse safety net)', () => {
    it('returns false immediately for a PID that is not alive, without needing any command-line check', async () => {
      // A dead PID is definitely not Argus - isPidAlive() short-circuits before any OS lookup.
      expect(await isPidLikelyArgusProcess(99999999)).toBe(false);
    });

    it('never throws for a live PID, even if the underlying OS command-line lookup is unavailable', async () => {
      // Contract that matters here: this is a best-effort safety net layered on top of the
      // existing isPidAlive() check, not a replacement - it must degrade safely (fail open,
      // never throw) rather than block a legitimate stop when the OS-level check itself can't
      // run (wrong platform, tasklist/wmic missing, permissions). The exact boolean for THIS
      // process depends on how the test runner itself was invoked, so only assert the type/
      // no-throw contract, not a specific value.
      const result = await isPidLikelyArgusProcess(process.pid);
      expect(typeof result).toBe('boolean');
    });
  });
});
