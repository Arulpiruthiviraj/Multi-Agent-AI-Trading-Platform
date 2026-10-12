/**
 * Continuous event-loop lag monitor (2026-10-12, pre-market perfection mission item 1).
 *
 * Why this exists: on 2026-10-12 ~13:32-13:35 ET the production engine froze ~3 minutes
 * (event-loop stall, /health timeouts, CPU ~10%, self-recovered, cause UNKNOWN; the WAL-shrink
 * lead was REFUTED). processTelemetry already SAMPLES event-loop delay every 15s into an
 * in-memory ring, but nothing WATCHES it continuously, nothing persists a stall record, and
 * nothing alerts - the next stall would be silent again. This monitor closes that gap.
 *
 * How it works: a setInterval at eventLoopLagSampleIntervalMs (config) measures its own drift -
 * lagMs = max(0, now - (lastTick + intervalMs)). A healthy 1s tick drifts by low single-digit
 * ms; anything at/above the WARN threshold is a degraded loop, at/above CRITICAL is a stall.
 * An in-process monitor can only ever observe a stall AFTER the loop unblocks (its own timer
 * cannot fire mid-stall) - the reported lagMs then approximates the stall's duration, which is
 * exactly the forensic quantity the Oct-12 incident was missing.
 *
 * On WARN: structuredLogger.warn (EVENT_LOOP_LAG_WARN) - persisted via the normal observability
 * queue like every other event. On CRITICAL: persists STALL_DETECTED (lag duration + sample
 * info: RSS/heap, uptime, stall count, worst lag this process) AND invokes the alerting hook
 * (AlertingService.alertEventLoopStall, cooldown-guarded). Both thresholds and the cooldown
 * come from config/observability.json - no TS literals.
 *
 * Lifecycle: wired into SystemBootstrap start()/stop() next to startProcessTelemetry() - no
 * parallel lifecycle. Fail-open: never throws into boot, the trading path, or its own timer.
 */
import { performance } from 'node:perf_hooks';
import { observabilityConfig } from '../config/observability';
import { observeSafe, structuredLogger } from './StructuredLogger';
import { alertingService } from '../services/AlertingService';

export interface EventLoopLagSettings {
  sampleIntervalMs: number;
  warnMs: number;
  criticalMs: number;
  cooldownMs: number;
}

export interface EventLoopLagStatus {
  running: boolean;
  /** Worst single-tick lag observed since process start (ms). */
  maxLagObservedMs: number;
  /** Number of CRITICAL crossings observed since process start. */
  stallCount: number;
  settings: EventLoopLagSettings;
}

let settingsOverride: Partial<EventLoopLagSettings> | null = null;

/** Active settings: config/observability.json, merged over by the test-only override. */
export function getEventLoopLagSettings(): EventLoopLagSettings {
  return {
    sampleIntervalMs: settingsOverride?.sampleIntervalMs ?? observabilityConfig.eventLoopLagSampleIntervalMs,
    warnMs: settingsOverride?.warnMs ?? observabilityConfig.eventLoopLagWarnMs,
    criticalMs: settingsOverride?.criticalMs ?? observabilityConfig.eventLoopLagCriticalMs,
    cooldownMs: settingsOverride?.cooldownMs ?? observabilityConfig.eventLoopLagAlertCooldownMs,
  };
}

/** Test-only: shrink thresholds/cooldowns so a synthetic stall is fast. Never used in production. */
export function setEventLoopLagSettingsForTests(override: Partial<EventLoopLagSettings>): void {
  settingsOverride = { ...(settingsOverride ?? {}), ...override };
}

export function resetEventLoopLagSettingsForTests(): void {
  settingsOverride = null;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastTickMs = 0;
let lastWarnAtMs = 0;
let lastCriticalAtMs = 0;
let maxLagObservedMs = 0;
let stallCount = 0;

function sampleMemoryMb(): { rssMb: number | null; heapUsedMb: number | null } {
  try {
    const mem = process.memoryUsage();
    return {
      rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
    };
  } catch {
    return { rssMb: null, heapUsedMb: null };
  }
}

function handleWarn(lagMs: number, settings: EventLoopLagSettings): void {
  observeSafe(
    () =>
      structuredLogger.warn('event_loop_lag_warn', {
        category: 'SYSTEM',
        eventType: 'EVENT_LOOP_LAG_WARN',
        lagMs: Math.round(lagMs * 10) / 10,
        warnMs: settings.warnMs,
        criticalMs: settings.criticalMs,
        maxLagObservedMs: Math.round(maxLagObservedMs * 10) / 10,
        reasoning:
          `Event loop lag ${Math.round(lagMs)}ms reached the WARN threshold (${settings.warnMs}ms). ` +
          `Degraded but recovered - watch for a CRITICAL crossing (STALL_DETECTED).`,
      }),
    'eventLoopLagMonitor',
  );
}

function handleCritical(lagMs: number, settings: EventLoopLagSettings): void {
  stallCount += 1;
  const mem = sampleMemoryMb();
  const roundedLagMs = Math.round(lagMs * 10) / 10;
  // Persisted observability event: the durable forensic record the Oct-12 stall never produced.
  observeSafe(
    () =>
      structuredLogger.error('event_loop_stall_detected', {
        category: 'SYSTEM',
        eventType: 'STALL_DETECTED',
        lagMs: roundedLagMs,
        sampleIntervalMs: settings.sampleIntervalMs,
        warnMs: settings.warnMs,
        criticalMs: settings.criticalMs,
        stallCount,
        maxLagObservedMs: Math.round(maxLagObservedMs * 10) / 10,
        uptimeSec: Math.round(process.uptime()),
        rssMb: mem.rssMb,
        heapUsedMb: mem.heapUsedMb,
        reasoning:
          `Event loop lag ${Math.round(lagMs)}ms exceeded the CRITICAL threshold ` +
          `(${settings.criticalMs}ms) - stall #${stallCount} this process. The monitor's own ` +
          `timer could not fire during the stall, so lagMs approximates the stall duration. ` +
          `Candidate classes under investigation (2026-10-12 forensic): synchronous ` +
          `better-sqlite3 commit tail (persistAssessment p95 1,369ms); v8.writeHeapSnapshot() ` +
          `synchronous heap walk (heapSnapshotEnabled=false in shipped config - needs a ` +
          `deploy-side check, not a code fix).`,
      }),
    'eventLoopLagMonitor',
  );
  // Alerting hook: cooldown-guarded inside AlertingService; safe to call even if never started().
  observeSafe(
    () =>
      alertingService.alertEventLoopStall({
        lagMs: roundedLagMs,
        sampleIntervalMs: settings.sampleIntervalMs,
        criticalMs: settings.criticalMs,
        stallCount,
        rssMb: mem.rssMb,
        heapUsedMb: mem.heapUsedMb,
      }),
    'eventLoopLagMonitor',
  );
}

function onTick(): void {
  try {
    const settings = getEventLoopLagSettings();
    const now = performance.now();
    const lagMs = Math.max(0, now - (lastTickMs + settings.sampleIntervalMs));
    lastTickMs = now;
    if (lagMs > maxLagObservedMs) maxLagObservedMs = lagMs;
    const wallNow = Date.now();
    if (lagMs >= settings.criticalMs) {
      if (wallNow - lastCriticalAtMs >= settings.cooldownMs) {
        lastCriticalAtMs = wallNow;
        handleCritical(lagMs, settings);
      }
    } else if (lagMs >= settings.warnMs) {
      if (wallNow - lastWarnAtMs >= settings.cooldownMs) {
        lastWarnAtMs = wallNow;
        handleWarn(lagMs, settings);
      }
    }
  } catch {
    /* fail-open: the monitor must never break the loop it watches */
  }
}

export function startEventLoopLagMonitor(): void {
  try {
    if (timer) return;
    lastTickMs = performance.now();
    timer = setInterval(onTick, getEventLoopLagSettings().sampleIntervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch {
    /* fail-open: missing timers must never block boot */
  }
}

export function stopEventLoopLagMonitor(): void {
  try {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  } catch {
    /* fail-open */
  }
}

export function getEventLoopLagStatus(): EventLoopLagStatus {
  return {
    running: timer !== null,
    maxLagObservedMs: Math.round(maxLagObservedMs * 10) / 10,
    stallCount,
    settings: getEventLoopLagSettings(),
  };
}

/** Test-only: clears runtime state (not the settings override - use resetEventLoopLagSettingsForTests). */
export function resetEventLoopLagMonitorForTests(): void {
  stopEventLoopLagMonitor();
  lastTickMs = 0;
  lastWarnAtMs = 0;
  lastCriticalAtMs = 0;
  maxLagObservedMs = 0;
  stallCount = 0;
}
