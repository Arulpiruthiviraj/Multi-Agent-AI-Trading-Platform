/**
 * 2026-10-12 (event-loop stall forensics). Times one run of a periodic background job and reports it
 * when slow. Observability only: it never retries, delays, cancels or changes the job, and a failure of
 * the reporting itself can never affect the job or its result.
 *
 * Why it exists: two ~4-minute freezes of the whole engine, exactly 15 min apart, saturated one CPU
 * core (8.0 CPU-s per 8 s wall) yet no job could be blamed because none reported its own duration.
 * A job that blocks the loop synchronously finishes INSIDE the stall, so its completion record
 * (long wall time and a cpu share near 1) names it directly.
 */
import { performance } from 'node:perf_hooks';
import { tradingSafety } from '../config/tradingSafety';
import { observeSafe, structuredLogger } from './StructuredLogger';
import { runWithDbCaller } from '../db/dbCallerContext';

export interface WorkCycleRecord {
  name: string;
  startedAtMs: number;
  wallMs: number;
  cpuMs: number;
  /** cpuMs / wallMs, clamped to [0, 1]. Near 1 with a long wall time means the job held the loop. */
  cpuShare: number;
  outcome: 'OK' | 'ERROR';
  slow: boolean;
}

export interface WorkCycleDeps {
  nowMs: () => number;
  monotonicMs: () => number;
  cpuMs: () => number;
  slowWarnMs: number;
  report: (rec: WorkCycleRecord) => void;
}

const RING_PER_NAME = 20;
const rings = new Map<string, WorkCycleRecord[]>();

function defaultDeps(): WorkCycleDeps {
  return {
    nowMs: () => Date.now(),
    monotonicMs: () => performance.now(),
    cpuMs: () => {
      const u = process.cpuUsage();
      return (u.user + u.system) / 1000;
    },
    slowWarnMs: tradingSafety.workCycleSlowWarnMs,
    report: (rec) => observeSafe(() => structuredLogger.warn(
      `Work cycle ${rec.name} was slow: wall ${Math.round(rec.wallMs)}ms, cpu ${Math.round(rec.cpuMs)}ms (share ${rec.cpuShare.toFixed(2)})`,
      {
        category: 'SYSTEM',
        eventType: 'WORK_CYCLE_SLOW',
        workCycle: rec.name,
        wallMs: Math.round(rec.wallMs),
        cpuMs: Math.round(rec.cpuMs),
        cpuShare: Math.round(rec.cpuShare * 100) / 100,
        outcome: rec.outcome,
        startedAtMs: rec.startedAtMs,
      },
    )),
  };
}

function remember(rec: WorkCycleRecord): void {
  const ring = rings.get(rec.name) ?? [];
  ring.push(rec);
  if (ring.length > RING_PER_NAME) ring.shift();
  rings.set(rec.name, ring);
}

/** Runs `fn`, records its wall/CPU time, reports it when slow, and returns/throws exactly what `fn` did. */
export async function timedWorkCycle<T>(name: string, fn: () => Promise<T>, deps: WorkCycleDeps = defaultDeps()): Promise<T> {
  const startedAtMs = deps.nowMs();
  const t0 = deps.monotonicMs();
  const c0 = deps.cpuMs();
  let outcome: 'OK' | 'ERROR' = 'OK';
  try {
    return await runWithDbCaller(`cycle:${name}`, fn);
  } catch (e) {
    outcome = 'ERROR';
    throw e;
  } finally {
    try {
      const wallMs = Math.max(0, deps.monotonicMs() - t0);
      const cpuMs = Math.max(0, deps.cpuMs() - c0);
      const cpuShare = wallMs > 0 ? Math.min(1, cpuMs / wallMs) : 0;
      const rec: WorkCycleRecord = { name, startedAtMs, wallMs, cpuMs, cpuShare, outcome, slow: wallMs >= deps.slowWarnMs };
      remember(rec);
      if (rec.slow) deps.report(rec);
    } catch {
      /* diagnostics must never affect the job */
    }
  }
}

/** Last runs per job (bounded), for runtime diagnostics. */
export function getRecentWorkCycles(name?: string): WorkCycleRecord[] {
  if (name) return [...(rings.get(name) ?? [])];
  return [...rings.values()].flat();
}

export function resetWorkCyclesForTests(): void {
  rings.clear();
}
