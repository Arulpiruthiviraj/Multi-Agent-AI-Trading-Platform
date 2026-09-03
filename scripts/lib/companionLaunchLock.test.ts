import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireCompanionLaunchLock, releaseCompanionLaunchLock } from './companionLaunchLock';

// Generic version of javaQuantCoreLock.test.ts's own coverage (2026-08-24 readiness audit, Part 6),
// generalized 2026-09-02 so a second companion (Chronos) shares this protection instead of
// reimplementing it. Each test uses its own isolated repoRoot (a fresh temp dir) so the lock file
// never collides with a real one this process might be holding.
describe('companionLaunchLock', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_companion_lock_test_'));
  });

  afterEach(() => {
    try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  it('a fresh acquire succeeds when no lock file exists', () => {
    const result = acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    expect(result.acquired).toBe(true);
  });

  it('a second acquire attempt for the same lock name while this process still holds it is rejected with this process\'s own PID', () => {
    acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    const second = acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    expect(second.acquired).toBe(false);
    if (second.acquired === false) expect(second.holderPid).toBe(process.pid);
  });

  it('release then re-acquire succeeds - the lock is only for the launch race, not a permanent marker', () => {
    acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    releaseCompanionLaunchLock(repoRoot, 'chronos');
    const result = acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    expect(result.acquired).toBe(true);
  });

  it('a stale lock file (holder PID no longer alive) is detected and cleaned automatically, not blindly trusted', () => {
    const lockFile = path.join(repoRoot, 'data', '.chronos_launch.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const deadPid = 999999; // astronomically unlikely to be alive on this machine right now
    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, port: 8008, startedAt: new Date().toISOString() }));

    const result = acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    expect(result.acquired).toBe(true);
  });

  it('a genuinely live holder PID (this test process itself) blocks acquisition rather than being treated as stale', () => {
    const lockFile = path.join(repoRoot, 'data', '.chronos_launch.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: 8008, startedAt: new Date().toISOString() }));

    const result = acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    expect(result.acquired).toBe(false);
    if (result.acquired === false) expect(result.holderPid).toBe(process.pid);
  });

  it('release never removes a lock file recorded under a different PID (never clears another process\'s claim blindly)', () => {
    const lockFile = path.join(repoRoot, 'data', '.chronos_launch.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const otherPid = 999998;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: otherPid, port: 8008, startedAt: new Date().toISOString() }));

    releaseCompanionLaunchLock(repoRoot, 'chronos');

    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('releasing when this process never acquired the lock is a safe no-op', () => {
    expect(() => releaseCompanionLaunchLock(repoRoot, 'chronos')).not.toThrow();
  });

  it('different lock names are independent - holding the Java Quant Core lock does not block the Chronos lock', () => {
    const javaLock = acquireCompanionLaunchLock(repoRoot, 'quant_core_java', 8085);
    expect(javaLock.acquired).toBe(true);

    const chronosLock = acquireCompanionLaunchLock(repoRoot, 'chronos', 8008);
    expect(chronosLock.acquired).toBe(true);

    // Each lock name gets its own file on disk.
    expect(fs.existsSync(path.join(repoRoot, 'data', '.quant_core_java_launch.lock'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'data', '.chronos_launch.lock'))).toBe(true);
  });
});
