/**
 * Java Quant Core companion launch lock - thin, name-pinned wrapper over the generic
 * companionLaunchLock.ts (generalized 2026-09-02 when Chronos gained the same duplicate-launch
 * protection under its own lock name). Kept as its own module so existing call sites
 * (javaQuantCoreLauncher.ts) and javaQuantCoreLock.test.ts's fixed
 * `data/.quant_core_java_launch.lock` path assertions are unchanged.
 */
import { acquireCompanionLaunchLock, releaseCompanionLaunchLock, isCompanionLockHolderAlive } from './companionLaunchLock';

const LOCK_NAME = 'quant_core_java';

export interface JavaQuantCoreLockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

export function acquireJavaQuantCoreLaunchLock(repoRoot: string, port: number): { acquired: true } | { acquired: false; holderPid: number } {
  return acquireCompanionLaunchLock(repoRoot, LOCK_NAME, port);
}

/** Safe to call even if this process never held the lock (e.g. acquire failed) - always best-effort. */
export function releaseJavaQuantCoreLaunchLock(repoRoot: string): void {
  releaseCompanionLaunchLock(repoRoot, LOCK_NAME);
}

export { isCompanionLockHolderAlive as isJavaQuantCoreLockHolderAlive };
