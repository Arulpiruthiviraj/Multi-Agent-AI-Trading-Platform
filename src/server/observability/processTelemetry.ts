/**
 * Bounded process RSS/heap + event-loop delay sampler.
 * Fail-open: never throws into trading. Does not write every sample to SQLite.
 * Multi-hour soak is CALENDAR/EVIDENCE REQUIRED — this only records in-process samples.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { observabilityConfig } from '../config/observability';
import { recordProcessTelemetrySample } from './ObservabilityMetrics';
import { structuredLogger, observeSafe } from './StructuredLogger';

let timer: NodeJS.Timeout | null = null;
let histogram: ReturnType<typeof monitorEventLoopDelay> | null = null;
let memoryTelemetryTimer: NodeJS.Timeout | null = null;

/** Best-effort parse of local_ai_service.py's /health "memoryUsage" label, e.g. "586 MB · N/A (CPU/MPS)". */
export function parseSidecarMemoryMb(label: unknown): number | null {
  if (typeof label !== 'string') return null;
  const match = label.match(/^(\d+(?:\.\d+)?)\s*MB/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * local_ai_service.py's /health `committedMemoryMb` - the sidecar's COMMITTED (pagefile/virtual)
 * memory, which is the quantity that actually predicts the Chronos failure mode on this host.
 * Numeric field (not the human `memoryUsage` label), so nothing here parses free text.
 * Returns null for an older sidecar build that does not emit the field - never a fabricated 0,
 * and never inferred from RSS.
 */
export function parseSidecarCommittedMb(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 10) / 10;
}

/** local_ai_service.py's /health `threadCount` - a plain integer, distinct from the MB fields
 *  above (kept as its own function rather than reusing parseSidecarCommittedMb's rounding, which
 *  is meaningless for a count). Null for an older sidecar build - never fabricated. */
export function parseSidecarThreadCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value);
}

export type MemoryTelemetryLevel = 'NORMAL' | 'WARNING' | 'CRITICAL';

export function classifyRss(rssMb: number): MemoryTelemetryLevel {
  if (rssMb >= observabilityConfig.memoryTelemetryCriticalRssMb) return 'CRITICAL';
  if (rssMb >= observabilityConfig.memoryTelemetryWarningRssMb) return 'WARNING';
  return 'NORMAL';
}

/**
 * Separate thresholds from classifyRss() on purpose: committed memory is legitimately a large
 * multiple of RSS for a healthy PyTorch process, so reusing the RSS thresholds here would alarm
 * constantly. These are calibrated against real measurements taken during the 2026-09-04 readiness
 * audit - see config/observability.json's own comment for the evidence behind each number.
 */
export function classifyCommitted(committedMb: number): MemoryTelemetryLevel {
  if (committedMb >= observabilityConfig.memoryTelemetryCriticalCommittedMb) return 'CRITICAL';
  if (committedMb >= observabilityConfig.memoryTelemetryWarningCommittedMb) return 'WARNING';
  return 'NORMAL';
}

const LEVEL_RANK: Record<MemoryTelemetryLevel, number> = { NORMAL: 0, WARNING: 1, CRITICAL: 2 };

/** Worst (highest-severity) of the supplied levels - a leak visible in ANY signal must surface. */
export function worstLevel(...levels: (MemoryTelemetryLevel | null)[]): MemoryTelemetryLevel {
  let worst: MemoryTelemetryLevel = 'NORMAL';
  for (const l of levels) {
    if (l && LEVEL_RANK[l] > LEVEL_RANK[worst]) worst = l;
  }
  return worst;
}

/**
 * Durable memory sample (Node +, best-effort, the Chronos/FinBERT Python sidecar) on a coarse,
 * config-driven cadence - see observability.json's own comment for why this exists (the in-memory
 * processTelemetry ring above is lost on process death; this survives it). Never blocks or throws
 * into the trading path: the sidecar health fetch has a short timeout and any failure there just
 * omits that field, it never delays or fails the Node-side sample.
 *
 * Full-remediation pass (2026-09-04): a CRITICAL sample now triggers a real fail-safe intervention
 * via applyMemoryCriticalFailSafe() below - reusing the EXISTING TRADING_PAUSED state machine
 * (TradingEngine.setTradingState()), never a new/second kill switch (CLAUDE.md's own standing
 * rule). This blocks new BUY ideas the same way an operator-initiated pause does; it does not
 * cancel open orders, does not touch RiskEngine/OMS directly, and never auto-resumes - resuming
 * from a memory-triggered pause is the same reconciliation-then-operator-resume path as any other
 * pause (see systemRoutes.ts's /system/resume).
 */
export async function sampleAndPersistMemoryTelemetry(): Promise<void> {
  const mem = process.memoryUsage();
  const nodeRssMb = Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
  const nodeLevel = classifyRss(nodeRssMb);

  let sidecarRssMb: number | null = null;
  let sidecarCommittedMb: number | null = null;
  let sidecarThreadCount: number | null = null;
  let sidecarReachable = false;
  try {
    const port = Number(process.env.LOCAL_AI_SERVICE_PORT || '8008');
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      sidecarReachable = true;
      const body = await res.json().catch(() => null) as { memoryUsage?: unknown; committedMemoryMb?: unknown; threadCount?: unknown } | null;
      sidecarRssMb = parseSidecarMemoryMb(body?.memoryUsage);
      sidecarCommittedMb = parseSidecarCommittedMb(body?.committedMemoryMb);
      // Recorded, deliberately NOT part of the severity decision: thread count is the leading
      // indicator of the sidecar's commit-growth mechanism (6,451 threads measured alongside
      // 15,245.9MB of commit on 2026-09-04), but no healthy baseline exists yet, so thresholding it
      // would be guessing. Persist it now so the baseline can be derived from real history later.
      sidecarThreadCount = parseSidecarThreadCount(body?.threadCount);
    }
  } catch {
    /* sidecar optional - honestly report unreachable, never fabricate a value */
  }

  // 2026-09-04 readiness audit: the sidecar's COMMITTED memory is included in the severity decision
  // because RSS alone demonstrably could not see the real failure. Measured live during that audit:
  // the Chronos sidecar sat at 15,247MB committed while reporting 102MB RSS, and this sampler
  // recorded "NORMAL" for hours. A null committed value (older sidecar build, or psutil missing)
  // simply contributes nothing - it never downgrades a level derived from the other signals.
  const level: MemoryTelemetryLevel = worstLevel(
    nodeLevel,
    sidecarRssMb != null ? classifyRss(sidecarRssMb) : null,
    sidecarCommittedMb != null ? classifyCommitted(sidecarCommittedMb) : null,
  );

  observeSafe(() => {
    const logLevel = level === 'CRITICAL' ? 'error' : level === 'WARNING' ? 'warn' : 'info';
    structuredLogger[logLevel](`Memory telemetry sample: node=${nodeRssMb}MB sidecar=${sidecarRssMb ?? 'unreachable'}MB sidecarCommitted=${sidecarCommittedMb ?? 'unavailable'}MB level=${level}`, {
      category: 'SYSTEM',
      eventType: 'MEMORY_TELEMETRY_SAMPLE',
      nodeRssMb,
      nodeHeapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
      sidecarRssMb,
      sidecarCommittedMb,
      sidecarThreadCount,
      sidecarReachable,
      level,
    });
  });

  if (level === 'CRITICAL') {
    await applyMemoryCriticalFailSafe(nodeRssMb, sidecarCommittedMb);
  }
}

/**
 * Real fail-safe intervention for a CRITICAL memory sample (2026-09-04 full-remediation pass).
 * Pauses trading via the EXISTING TRADING_PAUSED mechanism - never a new/second kill switch. A
 * no-op if trading is already paused/emergency-stopped (idempotent, no repeated audit-log spam on
 * every 5-minute sample while the condition persists). Never auto-resumes: that stays a deliberate
 * operator action (reconciliation, then /system/resume), matching how every other pause in this
 * codebase already works. Dynamically imports TradingEngine to avoid a hard import-time coupling
 * between the observability layer and the engine layer; failure here is logged, never thrown -
 * a broken fail-safe must not itself become a new crash path.
 */
export async function applyMemoryCriticalFailSafe(nodeRssMb: number, sidecarCommittedMb: number | null): Promise<void> {
  try {
    const { tradingEngine } = await import('../engines/TradingEngine');
    if (tradingEngine.state.tradingState !== 'TRADING_ENABLED') return; // already paused/stopped - nothing to do
    await tradingEngine.setTradingState('TRADING_PAUSED', {
      reason: `Memory telemetry CRITICAL (node=${nodeRssMb}MB${sidecarCommittedMb != null ? `, sidecarCommitted=${sidecarCommittedMb}MB` : ''}) - new BUY ideas held until an operator reviews resource state and resumes.`,
      actor: 'MemoryTelemetryGuard',
    });
  } catch (e) {
    console.error('[processTelemetry] applyMemoryCriticalFailSafe failed - trading state unchanged', e);
  }
}

export function startProcessTelemetry(): void {
  try {
    if (timer) return;
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    const intervalMs = observabilityConfig.processTelemetryIntervalMs;
    timer = setInterval(() => {
      try {
        const mem = process.memoryUsage();
        const delayMs = histogram ? histogram.mean / 1e6 : null;
        histogram?.reset();
        recordProcessTelemetrySample({
          ts: Date.now(),
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          arrayBuffers: mem.arrayBuffers,
          eventLoopDelayMs: delayMs != null && Number.isFinite(delayMs) ? delayMs : null,
        });
      } catch {
        /* fail-open */
      }
    }, intervalMs);
    timer.unref?.();
  } catch {
    /* fail-open: missing perf_hooks or interval must never block boot */
  }

  try {
    if (memoryTelemetryTimer) return;
    memoryTelemetryTimer = setInterval(() => {
      void sampleAndPersistMemoryTelemetry().catch(() => { /* fail-open */ });
    }, observabilityConfig.memoryTelemetryPersistIntervalMs);
    memoryTelemetryTimer.unref?.();
  } catch {
    /* fail-open */
  }
}

export function stopProcessTelemetry(): void {
  try {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (memoryTelemetryTimer) {
      clearInterval(memoryTelemetryTimer);
      memoryTelemetryTimer = null;
    }
    histogram?.disable();
    histogram = null;
  } catch {
    /* fail-open */
  }
}
