/**
 * Phase 9 (2026-08-31 zero-trade remediation, Phase 6 "safe maturity model"). Makes the calibration
 * lifecycle for each (agent, confidence-bucket) pair an explicit, observable classification instead
 * of a single opaque "no MODERATE trade happened" outcome. Reuses ONLY already-computed real data
 * (buildCalibrationCandidates()'s effective-N/Wilson-lower-bound math, the same champion ledger
 * ModerateTierEvaluator.ts checks) - no new statistics, no new thresholds, purely a relabeling for
 * observability:
 *
 *   UNVALIDATED - no agent_confidence_calibration row exists yet for this bucket (zero graded
 *                 outcomes have ever been recorded for it).
 *   LEARNING    - some graded outcomes exist, but effective (cluster-corrected) sample size has not
 *                 yet cleared championChallengerMinSampleSize - too little independent evidence to
 *                 say anything statistically defensible.
 *   CALIBRATED  - effective sample size clears the floor, but the effective win rate's Wilson lower
 *                 bound does not exceed the configured trust floor - real, sufficient evidence
 *                 exists, and it says "not distinguishable from chance" (or the bucket is stale).
 *   TRUSTED     - a live, non-stale CHAMPION exists for this (agent, bucket) whose OWN recorded
 *                 Wilson lower bound still clears the trust floor right now (reuses
 *                 isAgentBucketCalibrationTrustworthy()'s exact re-check, so this can never disagree
 *                 with what the MODERATE tier itself would decide).
 *
 * This module never gates a trade and never writes anything - it is a read-only lens onto data the
 * live consensus path (or its adjacent calibration workers) already produced.
 */
import { buildCalibrationCandidates, calibrationVersionType } from './CalibrationCandidateBuilder';
import { isAgentBucketCalibrationTrustworthy } from './ModerateTierEvaluator';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import { bucketMidpoint } from '../services/ConfidenceCalibration';

export type CalibrationMaturityStatus = 'UNVALIDATED' | 'LEARNING' | 'CALIBRATED' | 'TRUSTED';

export interface CalibrationMaturityRow {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
  status: CalibrationMaturityStatus;
  effectiveN: number;
  wilsonLower: number | null;
  rawN: number;
  isStale: boolean;
  detail: string;
}

export async function buildCalibrationMaturityReport(): Promise<CalibrationMaturityRow[]> {
  const candidates = await buildCalibrationCandidates();
  const minSampleSize = continuousIntelligence.championChallengerMinSampleSize;
  const minWilsonLower = tradingSafety.moderateCalibrationTrustMinWilsonLowerBound;

  const rows: CalibrationMaturityRow[] = [];
  for (const c of candidates) {
    if (c.rawN === 0) {
      rows.push({
        agentName: c.agentName, bucketLow: c.bucketLow, bucketHigh: c.bucketHigh,
        status: 'UNVALIDATED', effectiveN: 0, wilsonLower: null, rawN: 0, isStale: false,
        detail: 'No graded outcomes recorded yet for this bucket.',
      });
      continue;
    }
    if (c.effectiveN < minSampleSize) {
      rows.push({
        agentName: c.agentName, bucketLow: c.bucketLow, bucketHigh: c.bucketHigh,
        status: 'LEARNING', effectiveN: c.effectiveN, wilsonLower: c.wilsonLower, rawN: c.rawN, isStale: c.isStale,
        detail: `Effective sample size ${c.effectiveN} below the trust floor (${minSampleSize}) - too little independent evidence yet.`,
      });
      continue;
    }
    // Re-check via the exact same function the MODERATE tier itself calls, using this bucket's own
    // midpoint as a representative raw confidence - guarantees this can never disagree with what
    // evaluateModerateTierEligibility() would actually decide for an agent in this bucket.
    const trust = await isAgentBucketCalibrationTrustworthy(c.agentName, bucketMidpoint({ low: c.bucketLow, high: c.bucketHigh }));
    if (trust.trustworthy) {
      rows.push({
        agentName: c.agentName, bucketLow: c.bucketLow, bucketHigh: c.bucketHigh,
        status: 'TRUSTED', effectiveN: c.effectiveN, wilsonLower: c.wilsonLower, rawN: c.rawN, isStale: c.isStale,
        detail: trust.reason,
      });
    } else {
      rows.push({
        agentName: c.agentName, bucketLow: c.bucketLow, bucketHigh: c.bucketHigh,
        status: 'CALIBRATED', effectiveN: c.effectiveN, wilsonLower: c.wilsonLower, rawN: c.rawN, isStale: c.isStale,
        detail: `Effective sample size ${c.effectiveN} is sufficient, but Wilson lower bound ${c.wilsonLower === null ? 'N/A' : c.wilsonLower.toFixed(4)} does not exceed ${minWilsonLower} - not yet distinguishable from chance.`,
      });
    }
  }
  return rows.sort((a, b) => a.agentName.localeCompare(b.agentName) || a.bucketLow - b.bucketLow);
}

export function formatCalibrationMaturityReport(rows: CalibrationMaturityRow[]): string {
  if (rows.length === 0) return 'No calibration buckets tracked yet.';
  const lines = ['CALIBRATION MATURITY', '---------------------'];
  for (const r of rows) {
    lines.push(`${r.agentName.padEnd(24)}${`${r.bucketLow}-${r.bucketHigh}`.padEnd(10)}${r.status.padEnd(12)}effN=${r.effectiveN}${r.wilsonLower !== null ? ` wilsonLower=${r.wilsonLower.toFixed(3)}` : ''}${r.isStale ? ' STALE' : ''}`);
  }
  return lines.join('\n');
}
