/**
 * Calibration Drift Report (Phase 6, ARGUS_MASTER_REDESIGN_PLAN.md "Adaptive/Self-Improvement
 * Design" + "Observability" sections, 2026-09-27).
 *
 * Real gap this closes: `CalibrationCandidateBuilder.buildCalibrationCandidates()` (Phase 7D/7E)
 * recomputes an agent/bucket's calibration from its ENTIRE pooled observation history (oldest to
 * newest observation) - it answers "what is this bucket's effective-sample accuracy overall", not
 * "has this bucket's accuracy recently moved away from its own earlier accuracy." No code path in
 * this repository does the latter. This module adds exactly that, as a read-only report, using
 * data that already exists (`agent_predictions` / `kronos_predictions` + `prediction_outcomes`,
 * the same rows `CalibrationCandidateBuilder.ts` already reads) - no new data collection, no new
 * table, no new write path.
 *
 * GOVERNANCE (mirrors portfolioImpactReport.ts's own contract - see
 * calibrationDriftReport.readOnly.test.ts):
 *   - Never writes to agent_confidence_calibration, learning_versions, promotion_decisions, or any
 *     other table. Purely a read + compute + return.
 *   - Never imports ChiefTraderAgent, RiskEngine, OrderManagement, PositionSizing, or
 *     BrokerManager.placeOrder, and never emits an EventBus event.
 *   - Reuses the EXISTING effective-sample-size (autocorrelation-clustering) and Wilson-interval
 *     machinery (`effectiveSampleSize.ts`) and the EXISTING raw-row fetchers
 *     (`CalibrationCandidateBuilder.ts`'s `fetchAgentPredictionRows`/`fetchKronosRows`/
 *     `toClusterableRows`) rather than re-deriving a second calibration pipeline.
 *   - A bucket with too few effective observations in either window is reported
 *     INSUFFICIENT_SAMPLE, never a fabricated drift verdict.
 *
 * "Drift suspected" is a real, conservative statistical signal (recent window's Wilson upper bound
 * strictly below the prior window's Wilson lower bound, or vice versa - i.e. the two windows' 95%
 * intervals for the same bucket do not even overlap) - not a hard degradation certificate. This
 * report never changes `currentWeight`, `agent_confidence_calibration`, or any live gate; a human
 * (or a future, separately-authorized governance step) decides what, if anything, to do with it.
 */
// @ts-nocheck

import { db } from '../db';
import { agentConfidenceCalibration } from '../db/schema';
import type { ConfidenceBucket } from '../services/ConfidenceCalibration';
import {
  fetchAgentPredictionRows,
  fetchKronosRows,
  toClusterableRows,
  type RawRow,
} from '../continuous/CalibrationCandidateBuilder';
import { rawVsEffectiveDirectional, type RawVsEffective } from './effectiveSampleSize';
import { independenceClusterGapMs } from './predictionIndependencePolicy';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { logErrorSafely } from '../core/SecretRedaction';

export const CALIBRATION_DRIFT_REPORT_VERSION = 'calibration-drift-v1-2026-09-27';

export type DriftVerdict = 'DRIFT_SUSPECTED_DEGRADED' | 'DRIFT_SUSPECTED_IMPROVED' | 'NO_DRIFT_DETECTED' | 'INSUFFICIENT_SAMPLE';

export interface CalibrationDriftRow {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
  recentWindow: RawVsEffective;
  priorWindow: RawVsEffective;
  verdict: DriftVerdict;
  detail: string;
}

export interface CalibrationDriftReport {
  reportVersion: string;
  generatedAt: string;
  /** ADVISORY ONLY - never written back to agent_confidence_calibration or any live gate. */
  advisory: true;
  recentWindowMs: number;
  priorWindowMs: number;
  minEffectiveSamplePerWindow: number;
  rows: CalibrationDriftRow[];
}

function splitByWindow(rows: RawRow[], now: number, recentWindowMs: number, priorWindowMs: number): { recent: RawRow[]; prior: RawRow[] } {
  const recentCutoff = now - recentWindowMs;
  const priorCutoff = recentCutoff - priorWindowMs;
  const recent = rows.filter((r) => r.timestampMs >= recentCutoff && r.timestampMs <= now);
  const prior = rows.filter((r) => r.timestampMs >= priorCutoff && r.timestampMs < recentCutoff);
  return { recent, prior };
}

function classify(recent: RawVsEffective, prior: RawVsEffective, minEffectiveSample: number): { verdict: DriftVerdict; detail: string } {
  if (recent.effectiveN < minEffectiveSample || prior.effectiveN < minEffectiveSample) {
    return {
      verdict: 'INSUFFICIENT_SAMPLE',
      detail: `recent effectiveN=${recent.effectiveN}, prior effectiveN=${prior.effectiveN}; floor is ${minEffectiveSample} per window`,
    };
  }
  const rLower = recent.effectiveInterval.lower;
  const rUpper = recent.effectiveInterval.upper;
  const pLower = prior.effectiveInterval.lower;
  const pUpper = prior.effectiveInterval.upper;
  if (rLower == null || rUpper == null || pLower == null || pUpper == null) {
    return { verdict: 'INSUFFICIENT_SAMPLE', detail: 'Wilson interval unavailable for one or both windows' };
  }
  if (rUpper < pLower) {
    return {
      verdict: 'DRIFT_SUSPECTED_DEGRADED',
      detail: `recent 95% interval [${rLower.toFixed(3)}, ${rUpper.toFixed(3)}] sits entirely below prior [${pLower.toFixed(3)}, ${pUpper.toFixed(3)}]`,
    };
  }
  if (rLower > pUpper) {
    return {
      verdict: 'DRIFT_SUSPECTED_IMPROVED',
      detail: `recent 95% interval [${rLower.toFixed(3)}, ${rUpper.toFixed(3)}] sits entirely above prior [${pLower.toFixed(3)}, ${pUpper.toFixed(3)}]`,
    };
  }
  return {
    verdict: 'NO_DRIFT_DETECTED',
    detail: `recent [${rLower.toFixed(3)}, ${rUpper.toFixed(3)}] overlaps prior [${pLower.toFixed(3)}, ${pUpper.toFixed(3)}]`,
  };
}

/**
 * Builds a read-only drift report over every currently-tracked (agent, bucket) row in
 * agent_confidence_calibration, comparing a recent observation window against the window
 * immediately preceding it. Never writes anything; never touches live calibration/weights/gates.
 */
export async function buildCalibrationDriftReport(now: Date = new Date()): Promise<CalibrationDriftReport> {
  const recentWindowMs = continuousIntelligence.calibrationDriftRecentWindowMs;
  const priorWindowMs = continuousIntelligence.calibrationDriftPriorWindowMs;
  const minEffectiveSample = continuousIntelligence.calibrationDriftMinEffectiveSample;
  const nowMs = now.getTime();

  const active = await db.select().from(agentConfidenceCalibration);
  const rows: CalibrationDriftRow[] = [];

  for (const row of active) {
    const bucket: ConfidenceBucket = { low: row.bucketLow, high: row.bucketHigh };
    let rawRows: RawRow[];
    try {
      rawRows = row.agentName === 'KronosEngine'
        ? await fetchKronosRows(bucket)
        : await fetchAgentPredictionRows(row.agentName, bucket);
    } catch (e) {
      logErrorSafely(`[calibrationDriftReport] failed to fetch rows for ${row.agentName} ${bucket.low}-${bucket.high}`, e);
      continue;
    }

    const { recent, prior } = splitByWindow(rawRows, nowMs, recentWindowMs, priorWindowMs);
    const gapMs = independenceClusterGapMs(row.agentName);
    const recentStats = rawVsEffectiveDirectional(toClusterableRows(row.agentName, recent), gapMs);
    const priorStats = rawVsEffectiveDirectional(toClusterableRows(row.agentName, prior), gapMs);
    const { verdict, detail } = classify(recentStats, priorStats, minEffectiveSample);

    rows.push({
      agentName: row.agentName,
      bucketLow: bucket.low,
      bucketHigh: bucket.high,
      recentWindow: recentStats,
      priorWindow: priorStats,
      verdict,
      detail,
    });
  }

  return {
    reportVersion: CALIBRATION_DRIFT_REPORT_VERSION,
    generatedAt: now.toISOString(),
    advisory: true,
    recentWindowMs,
    priorWindowMs,
    minEffectiveSamplePerWindow: minEffectiveSample,
    rows,
  };
}

export function formatCalibrationDriftReport(r: CalibrationDriftReport): string {
  const lines: string[] = [];
  lines.push(`Calibration Drift Report (${r.reportVersion}) - ADVISORY ONLY, never writes agent_confidence_calibration/currentWeight/any live gate.`);
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`Recent window: ${(r.recentWindowMs / 86400000).toFixed(1)}d  Prior window: ${(r.priorWindowMs / 86400000).toFixed(1)}d  Min effective sample/window: ${r.minEffectiveSamplePerWindow}`);
  lines.push('');
  if (r.rows.length === 0) {
    lines.push('No tracked (agent, bucket) rows found in agent_confidence_calibration.');
    return lines.join('\n');
  }
  for (const row of r.rows) {
    lines.push(`${row.agentName} [${row.bucketLow}-${row.bucketHigh}]: ${row.verdict}`);
    lines.push(`  recent:  effectiveN=${row.recentWindow.effectiveN}  wins=${row.recentWindow.effectiveWins}  winRate=${row.recentWindow.effectiveInterval.pointEstimate ?? 'null'}  95%=[${row.recentWindow.effectiveInterval.lower ?? 'null'}, ${row.recentWindow.effectiveInterval.upper ?? 'null'}]`);
    lines.push(`  prior:   effectiveN=${row.priorWindow.effectiveN}  wins=${row.priorWindow.effectiveWins}  winRate=${row.priorWindow.effectiveInterval.pointEstimate ?? 'null'}  95%=[${row.priorWindow.effectiveInterval.lower ?? 'null'}, ${row.priorWindow.effectiveInterval.upper ?? 'null'}]`);
    lines.push(`  detail:  ${row.detail}`);
  }
  return lines.join('\n');
}
