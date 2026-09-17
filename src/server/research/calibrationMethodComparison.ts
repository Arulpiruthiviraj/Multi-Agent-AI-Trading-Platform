/**
 * Calibration method comparison (2026-09-15, research-integrity follow-up to the live-session
 * forensic investigation of the same date).
 *
 * Real finding this addresses: `agentConfidenceCalibration` - the table `ChiefTraderAgent.
 * calibrateConfidenceDetailed()` actually reads for every live consensus round - is written by
 * ReflectionEngine.ts using RAW, uncorrected (wins, losses) counts. A separate, already-built,
 * already-tested module (`continuous/CalibrationCandidateBuilder.ts`) computes an
 * effective-sample-size-corrected version of the same statistic via `effectiveSampleSize.ts`'s
 * `rawVsEffectiveDirectional()`, but - by that file's own explicit header comment - never writes
 * to `agentConfidenceCalibration` and has zero effect on the live consensus decision. Two real
 * statistical methods exist in this codebase; only one of them feeds the trading decision.
 *
 * This module makes that distinction explicit and comparable, with a real, named `CalibrationMethod`
 * enum, rather than leaving "which number are we even looking at" implicit. It is PURE and
 * READ-ONLY by construction - no database import, no side effects, operates only on already-fetched
 * `ClusterableRow[]` (the exact same shape `effectiveSampleSize.ts`/`CalibrationCandidateBuilder.ts`
 * already use). It does not decide whether to promote either method into production; see
 * `docs/audits/ARGUS_CALIBRATION_METHOD_COMPARISON_2026-09-15.md` for that separate, explicit,
 * evidence-gated decision this module's own output feeds.
 *
 * Both methods deliberately reuse the exact SAME Beta-Binomial posterior formula
 * (`calibratedConfidenceForBucket` in ConfidenceCalibration.ts, unmodified) - the two methods differ
 * only in which (wins, losses) counts are fed into it (raw row counts vs. time-gap-clustered
 * "effective" counts), never in the formula itself. This is intentional: it isolates exactly one
 * variable (sample-size correction for autocorrelation) rather than conflating it with an unrelated
 * change to the calibration math itself.
 */
import { calibratedConfidenceForBucket, type ConfidenceBucket } from '../services/ConfidenceCalibration';
import { wilsonInterval, clusterByTimeGap, type ClusterableRow } from './effectiveSampleSize';

export const CALIBRATION_METHODS = ['RAW_BETA_BINOMIAL', 'EFFECTIVE_N_CLUSTERED_BETA_BINOMIAL'] as const;
export type CalibrationMethod = typeof CALIBRATION_METHODS[number];

/** Production default today - ReflectionEngine.ts's write path, unchanged by this module. */
export const PRODUCTION_CALIBRATION_METHOD: CalibrationMethod = 'RAW_BETA_BINOMIAL';

export interface CalibrationMethodResult {
  method: CalibrationMethod;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  wilsonLower: number | null;
  wilsonUpper: number | null;
  calibratedConfidence: number;
}

function directionalOnly(rows: ClusterableRow[]): ClusterableRow[] {
  return rows.filter((r) => r.outcome !== 'N_A');
}

/** Mirrors ReflectionEngine.ts's raw calibration write exactly: every directional row counts as one
 *  independent observation, no clustering. This IS the production method today. */
export function computeRawCalibration(rows: ClusterableRow[], bucket: ConfidenceBucket): CalibrationMethodResult {
  const directional = directionalOnly(rows);
  const wins = directional.filter((r) => r.outcome === 'WIN').length;
  const losses = directional.length - wins;
  const interval = wilsonInterval(wins, directional.length);
  return {
    method: 'RAW_BETA_BINOMIAL',
    n: directional.length,
    wins,
    losses,
    winRate: interval.pointEstimate,
    wilsonLower: interval.lower,
    wilsonUpper: interval.upper,
    calibratedConfidence: calibratedConfidenceForBucket(bucket, wins, losses),
  };
}

/** Mirrors CalibrationCandidateBuilder.ts's effective-N computation exactly (same clustering,
 *  same Wilson interval, same Beta-Binomial posterior) - this is the OBSERVATIONAL-ONLY method
 *  today, not yet wired into any live decision. */
export function computeEffectiveNClusteredCalibration(
  rows: ClusterableRow[],
  bucket: ConfidenceBucket,
  clusterGapMs: number,
): CalibrationMethodResult {
  const directional = directionalOnly(rows);
  const clusters = clusterByTimeGap(directional, clusterGapMs).filter((c) => c.outcome !== 'N_A');
  const wins = clusters.filter((c) => c.outcome === 'WIN').length;
  const losses = clusters.length - wins;
  const interval = wilsonInterval(wins, clusters.length);
  return {
    method: 'EFFECTIVE_N_CLUSTERED_BETA_BINOMIAL',
    n: clusters.length,
    wins,
    losses,
    winRate: interval.pointEstimate,
    wilsonLower: interval.lower,
    wilsonUpper: interval.upper,
    calibratedConfidence: calibratedConfidenceForBucket(bucket, wins, losses),
  };
}

export interface CalibrationMethodComparison {
  agentName: string;
  bucket: ConfidenceBucket;
  raw: CalibrationMethodResult;
  effective: CalibrationMethodResult;
  /** effective.calibratedConfidence - raw.calibratedConfidence. Positive = correction raises
   *  confidence; negative = correction lowers it. Not itself a verdict either way. */
  confidenceDelta: number;
  /** raw.n / effective.n - how many raw rows one effective (independent) observation represents. */
  inflationFactor: number | null;
  /** Whether the two methods disagree on whether this bucket clears trustMinWilsonLower - i.e.
   *  whether MODERATE-tier's real trust decision (ModerateTierEvaluator.ts) would differ depending
   *  on which method it read. */
  trustFlips: boolean;
  rawTrusted: boolean;
  effectiveTrusted: boolean;
  /** effective.n below the same minCalibrationSampleSize floor calibrationMaturity/isCalibrationSampleSufficient
   *  already uses elsewhere - flagged as a fact for a human/report to weigh, never auto-resolved by
   *  this function. A small effective N is not itself proof the correction is "wrong" - it may
   *  simply mean the honest amount of independent evidence really is that small. */
  effectiveNBelowMinSample: boolean;
}

export function compareCalibrationMethods(
  agentName: string,
  bucket: ConfidenceBucket,
  rows: ClusterableRow[],
  clusterGapMs: number,
  trustMinWilsonLower: number,
  minCalibrationSampleSize: number,
): CalibrationMethodComparison {
  const raw = computeRawCalibration(rows, bucket);
  const effective = computeEffectiveNClusteredCalibration(rows, bucket, clusterGapMs);
  const rawTrusted = raw.wilsonLower !== null && raw.wilsonLower > trustMinWilsonLower;
  const effectiveTrusted = effective.wilsonLower !== null && effective.wilsonLower > trustMinWilsonLower;
  return {
    agentName,
    bucket,
    raw,
    effective,
    confidenceDelta: effective.calibratedConfidence - raw.calibratedConfidence,
    inflationFactor: effective.n > 0 ? raw.n / effective.n : null,
    trustFlips: rawTrusted !== effectiveTrusted,
    rawTrusted,
    effectiveTrusted,
    effectiveNBelowMinSample: effective.n < minCalibrationSampleSize,
  };
}

export interface ConsensusReplayInput {
  /** Confidence value each real historical vote actually used under the CURRENT production method. */
  rawConfidenceByAgent: Record<string, number>;
  /** Same vote set, with each agent's confidence replaced by what the effective-N method would
   *  have produced for the bucket its raw confidence fell into (null when that agent has no
   *  effective-N comparison available - caller decides how to treat this, never silently guessed
   *  here). */
  effectiveConfidenceByAgent: Record<string, number | null>;
  weightByAgent: Record<string, number>;
}

export interface ConsensusReplayResult {
  rawWeightedConfidence: number;
  effectiveWeightedConfidence: number | null;
  rawClearsStrong: boolean;
  effectiveClearsStrong: boolean | null;
  tierFlip: boolean;
}

/** Recomputes ChiefTraderAgent's own weighted-average confidence formula (sum(weight*confidence) /
 *  sum(weight), the same math resolveWeight()-driven consensus already uses) once with each
 *  method's confidence values, so a real historical consensus round's outcome can be compared side
 *  by side without touching the live path or any production data. Returns null for the effective
 *  side only when an agent's effective comparison data is genuinely unavailable - never fabricates
 *  a number to fill the gap. */
export function replayConsensusUnderBothMethods(
  input: ConsensusReplayInput,
  strongThreshold: number,
): ConsensusReplayResult {
  const agents = Object.keys(input.rawConfidenceByAgent);
  let rawWeightSum = 0;
  let rawWeighted = 0;
  for (const agent of agents) {
    const w = input.weightByAgent[agent] ?? 0;
    rawWeightSum += w;
    rawWeighted += w * input.rawConfidenceByAgent[agent];
  }
  const rawWeightedConfidence = rawWeightSum > 0 ? rawWeighted / rawWeightSum : 0;

  const hasAllEffective = agents.every((a) => input.effectiveConfidenceByAgent[a] !== null && input.effectiveConfidenceByAgent[a] !== undefined);
  let effectiveWeightedConfidence: number | null = null;
  if (hasAllEffective) {
    let effWeightSum = 0;
    let effWeighted = 0;
    for (const agent of agents) {
      const w = input.weightByAgent[agent] ?? 0;
      effWeightSum += w;
      effWeighted += w * (input.effectiveConfidenceByAgent[agent] as number);
    }
    effectiveWeightedConfidence = effWeightSum > 0 ? effWeighted / effWeightSum : 0;
  }

  const rawClearsStrong = rawWeightedConfidence >= strongThreshold;
  const effectiveClearsStrong = effectiveWeightedConfidence === null ? null : effectiveWeightedConfidence >= strongThreshold;
  return {
    rawWeightedConfidence,
    effectiveWeightedConfidence,
    rawClearsStrong,
    effectiveClearsStrong,
    tierFlip: effectiveClearsStrong !== null && effectiveClearsStrong !== rawClearsStrong,
  };
}
