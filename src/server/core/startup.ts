/**
 * Boot-time markers shared by reconciliation and other warm-up-sensitive workers.
 * Warmup is armed only when the real server/bootstrap starts — not on module import —
 * so vitest workers are not permanently inside the grace window.
 */
import { runtimeIntervals } from '../config/runtimeIntervals';

let bootTimestampMs: number | null = null;

/** Called from server.ts / SystemBootstrap at real process boot. */
export function armReconciliationBootWarmup(nowMs: number = Date.now()): void {
  bootTimestampMs = nowMs;
}

export function getBootTimestampMs(): number | null {
  return bootTimestampMs;
}

/** Test-only: reset boot anchor so warmup windows can be exercised deterministically. */
export function resetBootTimestampForTests(ms: number | null = Date.now()): void {
  bootTimestampMs = ms;
}

export function reconciliationWarmupRemainingMs(nowMs: number = Date.now()): number {
  if (bootTimestampMs === null) return 0;
  const elapsed = nowMs - bootTimestampMs;
  return Math.max(0, runtimeIntervals.reconciliationBootWarmupMs - elapsed);
}

export function isReconciliationWarmupActive(nowMs: number = Date.now()): boolean {
  return reconciliationWarmupRemainingMs(nowMs) > 0;
}
