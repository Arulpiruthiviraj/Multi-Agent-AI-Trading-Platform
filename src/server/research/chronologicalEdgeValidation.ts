/**
 * Phase 10 (Agent Edge Discovery, 2026-08-31) - out-of-sample / walk-forward validation for agent
 * predictive edge, using ONLY real, already-persisted agent_predictions/prediction_outcomes rows,
 * partitioned strictly by real prediction timestamp. No future outcome is ever used to influence a
 * statistic about an earlier prediction (each row's own real, point-in-time-graded outcome is fixed
 * at write time by PredictionOutcomeEvaluator - this module only decides which time window a row's
 * ALREADY-COMPUTED outcome falls into, it never recomputes or looks ahead).
 *
 * Note on scope: ARGUS's agents (TechnicalAgent/QuantEngine/etc) are rule-based or LLM-routed, not
 * fitted statistical models with parameters estimated from a training window - so "out-of-sample"
 * here does not mean "held-out data a model was never fit on" (there is no fit step to leak
 * through). It means the honest, still-valuable question: does this agent's apparent edge hold up
 * CONSISTENTLY across chronologically separate real periods, or was an overall win rate driven by
 * one lucky/unlucky stretch that would not survive being checked against a later, unseen period?
 * TRAIN/VALIDATION/OOS below are real chronological windows of REAL predictions, never synthetic.
 */
import { db } from '../db';
import { agentPredictions, predictionOutcomes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { clusterByTimeGap, wilsonInterval, classifyEvidenceStatus, type ClusterableRow } from './effectiveSampleSize';
import { independenceClusterGapMs } from './predictionIndependencePolicy';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { TELEMETRY_PULSE_TRACE_PREFIX } from '../core/telemetryPulse';

export interface SplitResult {
  label: 'TRAIN' | 'VALIDATION' | 'OOS';
  fromMs: number;
  toMs: number;
  effectiveN: number;
  winRate: number | null;
  wilsonLower: number | null;
}

export interface OosValidationResult {
  agentName: string;
  splits: SplitResult[];
  status: 'OOS_PASSED' | 'OOS_FAILED' | 'INSUFFICIENT_SAMPLE';
  reason: string;
}

export interface WalkForwardFold {
  foldIndex: number;
  fromMs: number;
  toMs: number;
  effectiveN: number;
  winRate: number | null;
  wilsonLower: number | null;
  wilsonUpper: number | null;
}

export interface WalkForwardResult {
  agentName: string;
  folds: WalkForwardFold[];
  status: 'WALK_FORWARD_PASSED' | 'WALK_FORWARD_FAILED' | 'INSUFFICIENT_SAMPLE';
  reason: string;
}

async function fetchClusterableRows(agentName: string): Promise<ClusterableRow[]> {
  const preds = await db.select().from(agentPredictions).where(eq(agentPredictions.agentName, agentName));
  const outcomes = await db.select().from(predictionOutcomes).where(eq(predictionOutcomes.sourceTable, 'agent_predictions'));
  const outcomeByPredId = new Map(outcomes.map((o) => [o.predictionId, o]));

  return preds
    .filter((p) => !p.traceId || !p.traceId.startsWith(TELEMETRY_PULSE_TRACE_PREFIX))
    .map((p) => {
      const o = outcomeByPredId.get(p.id);
      return {
        symbol: p.symbol, agent: p.agentName, side: p.prediction,
        timestampMs: new Date(p.timestamp).getTime(),
        outcome: (o?.outcome as 'WIN' | 'LOSS' | 'N_A') ?? 'N_A',
      };
    })
    .filter((r) => r.outcome !== 'N_A')
    .sort((a, b) => a.timestampMs - b.timestampMs);
}

function summarizeWindow(rows: ClusterableRow[], gapMs: number, fromMs: number, toMs: number): { effectiveN: number; winRate: number | null; wilsonLower: number | null; wilsonUpper: number | null } {
  const windowRows = rows.filter((r) => r.timestampMs >= fromMs && r.timestampMs < toMs);
  const clusters = clusterByTimeGap(windowRows, gapMs).filter((c) => c.outcome !== 'N_A');
  const wins = clusters.filter((c) => c.outcome === 'WIN').length;
  const interval = wilsonInterval(wins, clusters.length);
  return { effectiveN: clusters.length, winRate: interval.pointEstimate, wilsonLower: interval.lower, wilsonUpper: interval.upper };
}

/** Chronological 60/20/20 TRAIN/VALIDATION/OOS split. OOS_FAILED when the OOS window's own Wilson
 *  lower bound does not clear chance even though enough OOS evidence exists to judge it - i.e. an
 *  apparent overall edge did not survive being checked against the most recent, previously-unseen
 *  real period. */
export async function validateAgentOutOfSample(agentName: string): Promise<OosValidationResult> {
  const rows = await fetchClusterableRows(agentName);
  const minSampleSize = continuousIntelligence.championChallengerMinSampleSize;
  if (rows.length === 0) {
    return { agentName, splits: [], status: 'INSUFFICIENT_SAMPLE', reason: 'No graded predictions exist yet for this agent.' };
  }

  const gapMs = independenceClusterGapMs(agentName);
  const firstMs = rows[0].timestampMs;
  const lastMs = rows[rows.length - 1].timestampMs + 1;
  const span = lastMs - firstMs;
  const trainEnd = firstMs + span * 0.6;
  const validationEnd = firstMs + span * 0.8;

  const train = summarizeWindow(rows, gapMs, firstMs, trainEnd);
  const validation = summarizeWindow(rows, gapMs, trainEnd, validationEnd);
  const oos = summarizeWindow(rows, gapMs, validationEnd, lastMs);

  const splits: SplitResult[] = [
    { label: 'TRAIN', fromMs: firstMs, toMs: trainEnd, ...train },
    { label: 'VALIDATION', fromMs: trainEnd, toMs: validationEnd, ...validation },
    { label: 'OOS', fromMs: validationEnd, toMs: lastMs, ...oos },
  ];

  if (classifyEvidenceStatus(oos.effectiveN, minSampleSize) === 'INSUFFICIENT_EVIDENCE') {
    return {
      agentName, splits, status: 'INSUFFICIENT_SAMPLE',
      reason: `OOS window has only ${oos.effectiveN} effective observations (need ${minSampleSize}) - too little real evidence to judge out-of-sample performance yet.`,
    };
  }

  if (oos.wilsonLower !== null && oos.wilsonLower > 0.5) {
    return { agentName, splits, status: 'OOS_PASSED', reason: `OOS win rate's Wilson lower bound (${oos.wilsonLower.toFixed(4)}) clears chance.` };
  }
  return {
    agentName, splits, status: 'OOS_FAILED',
    reason: `OOS win rate's Wilson lower bound (${oos.wilsonLower === null ? 'N/A' : oos.wilsonLower.toFixed(4)}) does not clear chance (>0.5 required) - any apparent overall edge did not survive the most recent held-out real period.`,
  };
}

/** Rolling chronological folds (default 4) checking whether real accuracy is CONSISTENT across
 *  separate real periods, rather than driven by one stretch. Not re-fitting a model (these agents
 *  have no trainable parameters) - this is a consistency check over real, already-graded outcomes. */
export async function validateAgentWalkForward(agentName: string, foldCount = 4): Promise<WalkForwardResult> {
  const rows = await fetchClusterableRows(agentName);
  const minSampleSize = continuousIntelligence.championChallengerMinSampleSize;
  if (rows.length === 0) {
    return { agentName, folds: [], status: 'INSUFFICIENT_SAMPLE', reason: 'No graded predictions exist yet for this agent.' };
  }

  const gapMs = independenceClusterGapMs(agentName);
  const firstMs = rows[0].timestampMs;
  const lastMs = rows[rows.length - 1].timestampMs + 1;
  const span = lastMs - firstMs;

  const folds: WalkForwardFold[] = [];
  for (let i = 0; i < foldCount; i++) {
    const fromMs = firstMs + (span * i) / foldCount;
    const toMs = firstMs + (span * (i + 1)) / foldCount;
    const summary = summarizeWindow(rows, gapMs, fromMs, toMs);
    folds.push({ foldIndex: i, fromMs, toMs, ...summary });
  }

  const judgeable = folds.filter((f) => classifyEvidenceStatus(f.effectiveN, minSampleSize) === 'LEARNING_ELIGIBLE');
  if (judgeable.length < 2) {
    return {
      agentName, folds, status: 'INSUFFICIENT_SAMPLE',
      reason: `Only ${judgeable.length} of ${foldCount} chronological folds have enough effective evidence to judge (need >=2 to compare) - too little real history yet.`,
    };
  }

  const aboveChance = judgeable.filter((f) => f.wilsonLower !== null && f.wilsonLower > 0.5).length;
  const belowChance = judgeable.filter((f) => f.wilsonUpper !== null && f.wilsonUpper < 0.5).length;
  // Consistent means every judgeable fold agrees on which side of chance it sits (all-above or
  // all-below/all-inconclusive) - a mix of clearly-above and clearly-below folds means the overall
  // statistic is not a stable, real edge, it is regime- or luck-dependent.
  if (aboveChance > 0 && belowChance > 0) {
    return {
      agentName, folds, status: 'WALK_FORWARD_FAILED',
      reason: `${aboveChance} fold(s) sit clearly above chance and ${belowChance} sit clearly below chance - real performance is not consistent across chronological periods, not a stable edge.`,
    };
  }
  if (aboveChance === judgeable.length) {
    return { agentName, folds, status: 'WALK_FORWARD_PASSED', reason: `All ${judgeable.length} judgeable folds sit above chance - consistent across chronological periods.` };
  }
  return {
    agentName, folds, status: 'WALK_FORWARD_FAILED',
    reason: `No judgeable fold clears chance - no consistent edge detected across chronological periods.`,
  };
}
