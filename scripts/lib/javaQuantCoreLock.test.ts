import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { acquireJavaQuantCoreLaunchLock, releaseJavaQuantCoreLaunchLock } from './javaQuantCoreLock';

// Real test coverage for the 2026-08-24 readiness audit, Part 6: two independent launchers
// (javaQuantCoreLauncher.ts and devWithOpenAlice.ts) previously raced each other with no shared
// lock, and this session found the exact real-world result: two java.exe processes bound to the
// same port. Each test uses its own isolated repoRoot (a fresh temp dir) so the lock file never
// collides with a real one this process might be holding.
describe('javaQuantCoreLock', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_java_lock_test_'));
  });

  afterEach(() => {
    try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  it('a fresh acquire succeeds when no lock file exists', () => {
    const result = acquireJavaQuantCoreLaunchLock(repoRoot, 8085);
    expect(result.acquired).toBe(true);
  });

  it('a second acquire attempt while this process still holds the lock is rejected with this process\'s own PID', () => {
    acquireJavaQuantCoreLaunchLock(repoRoot, 8085);
    const second = acquireJavaQuantCoreLaunchLock(repoRoot, 8085);
    expect(second.acquired).toBe(false);
    if (second.acquired === false) expect(second.holderPid).toBe(process.pid);
  });

  it('release then re-acquire succeeds - the lock is only for the launch race, not a permanent marker', () => {
    acquireJavaQuantCoreLaunchLock(repoRoot, 8085);
    releaseJavaQuantCoreLaunchLock(repoRoot);
    const result = acquireJavaQuantCoreLaunchLock(repoRoot, 8085);
    expect(result.acquired).toBe(true);
  });

  it('a stale lock file (holder PID no longer alive) is detected and cleaned automatically, not blindly trusted', () => {
    const lockFile = path.join(repoRoot, 'data', '.quant_core_java_launch.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    // A PID astronomically unlikely to be alive on this machine right now.
    const deadPid = 999999;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: deadPid, port: 8085, startedAt: new Date().toISOString() }));

    const result = acquireJavaQuantCoreLaunchLock(repoRoot, 8085);
    expect(result.acquired).toBe(true);
  });

  it('a genuinely live holder PID (this test process itself) blocks acquisition rather than being treated as stale', () => {
    const lockFile = path.join(repoRoot, 'data', '.quant_core_java_launch.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: 8085, startedAt: new Date().toISOString() }));

    const result = acquireJavaQuantCoreLaunchLock(repoRoot, 8085);
    expect(result.acquired).toBe(false);
    if (result.acquired === false) expect(result.holderPid).toBe(process.pid);
  });

  it('release never removes a lock file recorded under a different PID (never kills/clears another process\'s claim blindly)', () => {
    const lockFile = path.join(repoRoot, 'data', '.quant_core_java_launch.lock');
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const otherPid = 999998;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: otherPid, port: 8085, startedAt: new Date().toISOString() }));

    releaseJavaQuantCoreLaunchLock(repoRoot);

    expect(fs.existsSync(lockFile)).toBe(true);
  });

  it('releasing when this process never acquired the lock is a safe no-op', () => {
    expect(() => releaseJavaQuantCoreLaunchLock(repoRoot)).not.toThrow();
  });
});
