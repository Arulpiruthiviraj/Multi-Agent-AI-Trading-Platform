import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import {
  clearWatchdogPid,
  isPidAlive,
  isWatchdogProcessRunning,
  readWatchdogPid,
  resolveWatchdogPidPath,
  writeWatchdogPid,
} from './watchdogPid';

// Isolated from the real developer-facing data/.argus_watchdog.pid the same way enginePid.test.ts
// isolates itself (see that file's header) - a shared, unoverridden path would let this suite wipe
// out a real running dev watchdog's pid file.
describe('watchdogPid', () => {
  const originalOverride = process.env.ARGUS_WATCHDOG_PID_PATH;
  const tmpPidPath = join(os.tmpdir(), `argus_watchdog_pid_test_${Date.now()}_${process.pid}.pid`);

  beforeAll(() => {
    process.env.ARGUS_WATCHDOG_PID_PATH = tmpPidPath;
  });

  afterAll(() => {
    try { unlinkSync(tmpPidPath); } catch { /* best-effort cleanup */ }
    if (originalOverride === undefined) delete process.env.ARGUS_WATCHDOG_PID_PATH;
    else process.env.ARGUS_WATCHDOG_PID_PATH = originalOverride;
  });

  afterEach(() => {
    clearWatchdogPid();
  });

  it('isPidAlive detects this process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('writeWatchdogPid / readWatchdogPid round-trip', () => {
    writeWatchdogPid(process.pid);
    expect(readWatchdogPid()).toBe(process.pid);
  });

  it('isWatchdogProcessRunning clears a stale pid file and reports not running', () => {
    mkdirSync(dirname(resolveWatchdogPidPath()), { recursive: true });
    writeFileSync(resolveWatchdogPidPath(), '99999999', 'utf8');
    expect(isWatchdogProcessRunning()).toBe(false);
    expect(readWatchdogPid()).toBeNull();
  });

  it('isWatchdogProcessRunning reports true for a live pid', () => {
    writeWatchdogPid(process.pid);
    expect(isWatchdogProcessRunning()).toBe(true);
  });

  it('clearWatchdogPid is a no-op when no file exists', () => {
    expect(() => clearWatchdogPid()).not.toThrow();
    expect(readWatchdogPid()).toBeNull();
  });
});
