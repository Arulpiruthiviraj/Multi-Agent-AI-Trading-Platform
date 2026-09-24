/**
 * P1-A follow-up (2026-09-23): read-only observability view over ReflectionEngine.ts's own
 * in-memory cycle instrumentation (ObservabilityMetrics.ts's reflectionEngineCycleSamples ring +
 * skipped-overlap counter). Same `build*Report()` / `format*Report()` pattern as
 * quantEvidenceReport.ts / tradingFunnelReport.ts. No DB query of its own - the ring is in-process
 * memory only (see ObservabilityMetrics.ts's header for why this is deliberate), so this report
 * only reflects the CURRENT process's own recent cycles, not historical/cross-restart data.
 *
 * What this DOES prove: the inFlight re-entrancy guard is measurably preventing overlapping
 * cycles (skippedOverlapCount), and gives real per-cycle cost visibility (duration, rows scanned,
 * per-table query duration) to distinguish "query itself is slow because tables are huge" from
 * "something else in the cycle is slow".
 *
 * What this does NOT prove: that the underlying P1-A memory leak is resolved. That requires
 * watching real RSS/heap trend over real elapsed production uptime (hours/days) post-deploy -
 * see processTelemetry.ts / ObservabilityMetrics.ts's getProcessTelemetrySamples() for that
 * separate signal. Cross-reference by timestamp: a ReflectionEngineCycleSample.ts value can be
 * compared against the nearest ProcessTelemetrySample.ts values from the same window to see
 * whether RSS/heap moved during or after a given reflection cycle - no new heap-sampling
 * infrastructure is added here to do that; it is a manual/analytical correlation over two already-
 * existing bounded rings.
 */
import {
  getReflectionEngineCycleSamples,
  getReflectionEngineSkippedOverlapCount,
  type ReflectionEngineCycleSample,
} from './ObservabilityMetrics';

export interface ReflectionEngineHealthReport {
  sampleCount: number;
  ringCapacityHint: string;
  skippedOverlapCountSinceProcessStart: number;
  cycleDurationMs: { latest: number | null; avg: number | null; p95: number | null; max: number | null };
  latestRowsScanned: {
    trades: number | null;
    agentPredictions: number | null;
    kronosPredictions: number | null;
  };
  latestQueryDurationMs: {
    trades: number | null;
    agentPredictions: number | null;
    kronosPredictions: number | null;
  };
  /** Oldest-to-newest rows-scanned trend across the retained ring, for a quick eyeball of whether
   *  table size is visibly growing cycle over cycle - not a substitute for real trend analysis. */
  rowsScannedTrend: Array<{
    ts: string;
    trades: number;
    agentPredictions: number;
    kronosPredictions: number;
  }>;
  soakEvidence: 'RUNTIME_CONFIRMATION_REQUIRED';
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function buildReflectionEngineHealthReport(): ReflectionEngineHealthReport {
  const samples: readonly ReflectionEngineCycleSample[] = getReflectionEngineCycleSamples();
  const durations = samples.map((s) => s.cycleDurationMs).sort((a, b) => a - b);
  const latest = samples.length > 0 ? samples[samples.length - 1] : null;

  return {
    sampleCount: samples.length,
    ringCapacityHint: 'bounded in-memory ring - see config/observability.json reflectionEngineMetricsRingSize',
    skippedOverlapCountSinceProcessStart: getReflectionEngineSkippedOverlapCount(),
    cycleDurationMs: {
      latest: latest ? latest.cycleDurationMs : null,
      avg: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      p95: percentile(durations, 95),
      max: durations.length > 0 ? durations[durations.length - 1] : null,
    },
    latestRowsScanned: {
      trades: latest ? latest.tradesRowsScanned : null,
      agentPredictions: latest ? latest.agentPredictionsRowsScanned : null,
      kronosPredictions: latest ? latest.kronosPredictionsRowsScanned : null,
    },
    latestQueryDurationMs: {
      trades: latest ? latest.tradesQueryDurationMs : null,
      agentPredictions: latest ? latest.agentPredictionsQueryDurationMs : null,
      kronosPredictions: latest ? latest.kronosPredictionsQueryDurationMs : null,
    },
    rowsScannedTrend: samples.map((s) => ({
      ts: new Date(s.ts).toISOString(),
      trades: s.tradesRowsScanned,
      agentPredictions: s.agentPredictionsRowsScanned,
      kronosPredictions: s.kronosPredictionsRowsScanned,
    })),
    soakEvidence: 'RUNTIME_CONFIRMATION_REQUIRED',
  };
}

export function formatReflectionEngineHealthReport(r: ReflectionEngineHealthReport): string {
  const lines = [
    'ARGUS REFLECTION ENGINE HEALTH (P1-A guard verification, in-process ring only)',
    '================================================================================',
    `Samples retained (this process): ${r.sampleCount} (${r.ringCapacityHint})`,
    '',
    'RE-ENTRANCY GUARD',
    '------------------',
    `Skipped-overlap count (since process start): ${r.skippedOverlapCountSinceProcessStart}`,
    r.skippedOverlapCountSinceProcessStart > 0
      ? '  -> guard has measurably prevented at least one overlapping cycle'
      : '  -> zero overlaps prevented so far - either no overlap has been attempted yet, or cycles are comfortably faster than the interval',
    '',
    'CYCLE DURATION (ms)',
    '--------------------',
    `latest: ${r.cycleDurationMs.latest ?? 'null'}   avg: ${r.cycleDurationMs.avg != null ? r.cycleDurationMs.avg.toFixed(1) : 'null'}   p95: ${r.cycleDurationMs.p95 ?? 'null'}   max: ${r.cycleDurationMs.max ?? 'null'}`,
    '',
    'LATEST ROWS SCANNED (raw, pre-filter)',
    '--------------------------------------',
    `trades:            ${r.latestRowsScanned.trades ?? 'null'}  (query ${r.latestQueryDurationMs.trades ?? 'null'}ms)`,
    `agent_predictions: ${r.latestRowsScanned.agentPredictions ?? 'null'}  (query ${r.latestQueryDurationMs.agentPredictions ?? 'null'}ms)`,
    `kronos_predictions:${r.latestRowsScanned.kronosPredictions ?? 'null'}  (query ${r.latestQueryDurationMs.kronosPredictions ?? 'null'}ms)`,
    '',
    'WHAT THIS DOES NOT PROVE',
    '-------------------------',
    'This confirms the guard is measurably preventing overlap and shows real per-cycle cost. It',
    'does NOT confirm the P1-A memory leak is resolved - that requires watching real RSS/heap',
    'trend over real elapsed production uptime (hours/days) post-deploy. Cross-reference this',
    'ring\'s sample timestamps against processTelemetry\'s own RSS/heap samples',
    '(ObservabilityMetrics.getProcessTelemetrySamples()) by ts to correlate - no new heap-sampling',
    'mechanism was added for this. Status: LIKELY ROOT CAUSE IDENTIFIED / FIX DEPLOYED / RUNTIME',
    'CONFIRMATION REQUIRED.',
  ];
  return lines.join('\n');
}
