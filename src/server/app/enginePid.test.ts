import { describe, expect, it, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ENGINE_PID_PATH,
  claimEnginePid,
  clearEnginePid,
  isEngineProcessRunning,
  isPidAlive,
  isPidLikelyArgusProcess,
  readEnginePid,
  reconcileEnginePidFile,
  writeEnginePid,
} from './enginePid';

describe('enginePid', () => {
  afterEach(() => {
    clearEnginePid();
  });

  it('isPidAlive detects this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('stale PID file is cleared by reconcileEnginePidFile', () => {
    mkdirSync(dirname(ENGINE_PID_PATH), { recursive: true });
    writeFileSync(ENGINE_PID_PATH, '99999999', 'utf8');
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
