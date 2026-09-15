/**
 * P1 memory-leak investigation (2026-09-14) - controlled heap-snapshot capture.
 *
 * Explicit operator-authorized diagnostic, scoped exactly as specified: durable memory telemetry
 * (processTelemetry.ts) showed sustained, ~linear RSS growth (~29MB/min over a 112-minute session,
 * 788.5MB -> 4,014.9MB) with heapUsed tracking RSS closely - a real JS-heap object-retention
 * signature, not a native/socket leak or a one-off spike. Static code review of the highest-
 * probability long-lived collections (ChiefTraderAgent's per-symbol Maps, AIRouter's provider
 * Maps, QuantCoreBridge's capped price/volume history, MarketDataWorker's per-symbol Maps) found
 * them all properly bounded - the retaining allocation was not found by inspection, so a real
 * before/after heap diff is the next tool, not more file-by-file reading.
 *
 * Triggers (see config/observability.json's own comment for the full rationale):
 *   1. One baseline snapshot, heapSnapshotBaselineDelayMs after a controlled boot (captures a
 *      healthy low-memory reference point to diff future snapshots against).
 *   2. One snapshot at the FIRST WARNING/CRITICAL memory-telemetry transition.
 *   3. One optional follow-up snapshot if the level is STILL WARNING/CRITICAL
 *      heapSnapshotFollowUpDelayMs after the first elevated snapshot.
 *   4. A hard heapSnapshotMaxPerProcessLifetime cap (default 3 - covers exactly the three cases
 *      above) regardless of how long the process runs or how many times the level flaps between
 *      WARNING/CRITICAL/NORMAL, plus a heapSnapshotCooldownMs minimum gap between any two captures.
 *
 * HONESTY, not a promise this mechanism doesn't have here: v8.writeHeapSnapshot() performs a real,
 * synchronous V8 heap walk - it blocks the event loop for its duration (this is inherent to how
 * V8 produces a consistent heap snapshot, not an implementation choice this module could avoid).
 * This is NOT a non-blocking mechanism. What IS true: it is infrequent (capped, cooldown-gated),
 * and every capture's wall-clock duration is measured and logged (HEAP_SNAPSHOT_CAPTURED /
 * HEAP_SNAPSHOT_FAILED), so the real cost is visible, never hidden or asserted away.
 *
 * This module NEVER touches tradingEngine/RiskEngine/OMS state and never gates or delays
 * applyMemoryCriticalFailSafe()'s own TRADING_PAUSED intervention (processTelemetry.ts calls that
 * first, unconditionally, before this module's own maybeCaptureHeapSnapshotForMemoryLevel() runs).
 * Snapshot capture failure is fail-open: logged, never thrown, never crashes the process.
 */
import { writeHeapSnapshot } from 'node:v8';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { observabilityConfig } from '../config/observability';
import { structuredLogger, observeSafe } from './StructuredLogger';
import type { MemoryTelemetryLevel } from './processTelemetry';

interface HeapSnapshotState {
  snapshotCount: number;
  lastSnapshotAt: number;
  firstElevatedSnapshotAt: number | null;
  followUpTaken: boolean;
  baselineTimer: NodeJS.Timeout | null;
}

let state: HeapSnapshotState = {
  snapshotCount: 0,
  lastSnapshotAt: 0,
  firstElevatedSnapshotAt: null,
  followUpTaken: false,
  baselineTimer: null,
};

/** Test-only reset - mirrors ObservabilityMetrics.ts's resetMetricsForTests() convention. */
export function resetHeapSnapshotStateForTests(): void {
  if (state.baselineTimer) clearTimeout(state.baselineTimer);
  state = { snapshotCount: 0, lastSnapshotAt: 0, firstElevatedSnapshotAt: null, followUpTaken: false, baselineTimer: null };
}

function snapshotDir(): string {
  return join(process.cwd(), observabilityConfig.heapSnapshotDir);
}

/** Disk-bounded: deletes oldest .heapsnapshot files until under both the file-count and
 *  total-size caps, BEFORE a new one is written - never after, so disk usage never spikes above
 *  the configured ceiling even transiently. Fail-open: a pruning failure never blocks the capture
 *  itself (the write may still succeed, or fail on its own for an unrelated reason). */
function pruneOldSnapshots(dir: string): void {
  try {
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.heapsnapshot'))
      .map((f) => {
        const full = join(dir, f);
        const st = statSync(full);
        return { full, mtimeMs: st.mtimeMs, sizeMb: st.size / (1024 * 1024) };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    let totalMb = files.reduce((s, f) => s + f.sizeMb, 0);
    let count = files.length;
    let i = 0;
    while (
      i < files.length
      && (count >= observabilityConfig.heapSnapshotMaxFilesOnDisk || totalMb >= observabilityConfig.heapSnapshotMaxTotalMb)
    ) {
      unlinkSync(files[i].full);
      totalMb -= files[i].sizeMb;
      count -= 1;
      i += 1;
    }
  } catch {
    /* fail-open: disk pruning must never block a capture attempt */
  }
}

/**
 * The one real capture function. Returns without throwing on any failure - callers never need
 * their own try/catch. Every call (success or failure) is logged with its measured duration.
 */
export async function captureHeapSnapshot(reason: string): Promise<{ ok: boolean; path?: string; durationMs: number; error?: string }> {
  const startedAt = Date.now();
  try {
    if (!observabilityConfig.heapSnapshotEnabled || disabledForTests()) {
      return { ok: false, durationMs: 0, error: 'heap snapshot capture disabled' };
    }
    const dir = snapshotDir();
    mkdirSync(dir, { recursive: true });
    pruneOldSnapshots(dir);

    const filename = `argus-${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.heapsnapshot`;
    const fullPath = join(dir, filename);

    // v8.writeHeapSnapshot() is synchronous (a real, bounded V8 heap walk) - see this module's own
    // header for why that is disclosed, not hidden. Duration below is the honest measurement.
    writeHeapSnapshot(fullPath);

    const durationMs = Date.now() - startedAt;
    state.snapshotCount += 1;
    state.lastSnapshotAt = Date.now();

    observeSafe(() => {
      structuredLogger.warn(`Heap snapshot captured (${reason}) in ${durationMs}ms -> ${fullPath}`, {
        category: 'SYSTEM',
        eventType: 'HEAP_SNAPSHOT_CAPTURED',
        reason,
        path: fullPath,
        durationMs,
        snapshotCount: state.snapshotCount,
      });
    });

    return { ok: true, path: fullPath, durationMs };
  } catch (e: unknown) {
    const durationMs = Date.now() - startedAt;
    const message = e instanceof Error ? e.message : String(e);
    observeSafe(() => {
      structuredLogger.error(`Heap snapshot capture FAILED (${reason}) after ${durationMs}ms: ${message}`, {
        category: 'SYSTEM',
        eventType: 'HEAP_SNAPSHOT_FAILED',
        reason,
        durationMs,
        error: message,
      });
    });
    return { ok: false, durationMs, error: message };
  }
}

/** Test isolation, same opt-in idiom as vitest.setup.ts's ARGUS_TEST_ALLOW_CHRONOS/OLLAMA/
 *  OPENALICE: the full suite deliberately drives fake WARNING/CRITICAL memory samples (see
 *  processTelemetry.memory.test.ts) to exercise the existing TRADING_PAUSED fail-safe - without
 *  this, every such run would also write a real .heapsnapshot file to disk. A test file that
 *  wants to exercise capture directly still can, by setting ARGUS_TEST_ALLOW_HEAP_SNAPSHOTS=true
 *  before import (or, as heapSnapshotCapture.test.ts does, mocking node:v8/node:fs directly). */
function disabledForTests(): boolean {
  return process.env.ARGUS_DISABLE_HEAP_SNAPSHOTS === 'true';
}

function lifetimeCapReached(): boolean {
  return state.snapshotCount >= observabilityConfig.heapSnapshotMaxPerProcessLifetime;
}

function cooldownElapsed(): boolean {
  return state.lastSnapshotAt === 0 || Date.now() - state.lastSnapshotAt >= observabilityConfig.heapSnapshotCooldownMs;
}

/**
 * Called once at boot (from startProcessTelemetry()) - schedules the single baseline snapshot.
 * unref()'d: never holds the process open on its own, matching every other timer in this module.
 */
export function scheduleBaselineHeapSnapshot(): void {
  try {
    if (!observabilityConfig.heapSnapshotEnabled || disabledForTests() || state.baselineTimer) return;
    state.baselineTimer = setTimeout(() => {
      state.baselineTimer = null;
      if (lifetimeCapReached()) return;
      void captureHeapSnapshot('baseline');
    }, observabilityConfig.heapSnapshotBaselineDelayMs);
    state.baselineTimer.unref?.();
  } catch {
    /* fail-open */
  }
}

export function stopHeapSnapshotScheduler(): void {
  try {
    if (state.baselineTimer) {
      clearTimeout(state.baselineTimer);
      state.baselineTimer = null;
    }
  } catch {
    /* fail-open */
  }
}

/**
 * Called from sampleAndPersistMemoryTelemetry() on every sample, AFTER (never before, never
 * instead of) applyMemoryCriticalFailSafe() has already run for this sample - see this module's
 * own header. Purely additive: implements the first-crossing + one-optional-follow-up state
 * machine, all gated by the lifetime cap and cooldown.
 */
export function maybeCaptureHeapSnapshotForMemoryLevel(level: MemoryTelemetryLevel): void {
  try {
    if (!observabilityConfig.heapSnapshotEnabled || disabledForTests()) return;
    if (level === 'NORMAL') return; // only WARNING/CRITICAL are "elevated" for this purpose
    if (lifetimeCapReached() || !cooldownElapsed()) return;

    if (state.firstElevatedSnapshotAt === null) {
      // First crossing into WARNING or CRITICAL this process lifetime.
      state.firstElevatedSnapshotAt = Date.now();
      void captureHeapSnapshot(`first-${level.toLowerCase()}`);
      return;
    }

    if (
      !state.followUpTaken
      && Date.now() - state.firstElevatedSnapshotAt >= observabilityConfig.heapSnapshotFollowUpDelayMs
    ) {
      // Still elevated after the configured delay - one follow-up, never more.
      state.followUpTaken = true;
      void captureHeapSnapshot(`followup-${level.toLowerCase()}`);
    }
  } catch {
    /* fail-open: a broken diagnostic must never affect memory-telemetry sampling itself */
  }
}
