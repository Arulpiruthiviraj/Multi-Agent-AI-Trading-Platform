/**
 * Counts research trials so best-of-N search cannot hide multiple-testing.
 * In-memory; optional disk when ARGUS_WRITE_RESEARCH_PARQUET=true.
 *
 * Phase: multiple-testing experiment provenance ledger (ARGUS_FINAL_FORENSIC_AUDIT.md §14/§22 -
 * "full per-trial parameter/rejection audit trail" was previously partial: aggregate trial counts
 * only, no per-trial provenance). `recordExperimentTrial()`'s original 2-argument signature is
 * unchanged and still used as-is by its one real production call site
 * (`researchRoutes.ts`'s golden-SMA backtest route) - the new per-trial detail is purely additive
 * via an optional third argument, so nothing existing breaks.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { researchSafety } from '../config/researchSafety';
import { multipleTestingWarning } from './multipleTesting';
import { researchDataDir } from './parquetStore';

export type TrialSelectionStatus = 'ACCEPTED' | 'REJECTED' | 'OVERFIT_PRUNED';

export interface TrialRecord {
  trialId: string;
  strategyId: string;
  datasetHash: string;
  parameterSet: Record<string, unknown> | null;
  evaluationTimestamp: string;
  inSampleMetrics: Record<string, unknown> | null;
  outOfSampleMetrics: Record<string, unknown> | null;
  rejectionReason: string | null;
  selectionStatus: TrialSelectionStatus;
  // Additive provenance fields (2026-08-18 remediation pass) - all optional/nullable so the
  // existing 2-argument recordExperimentTrial() call site and every existing TrialRecord in a
  // persisted ledger.json remain valid without a migration. Populate what a given caller
  // actually knows; never fabricate a value here to fill a field.
  symbol: string | null;
  datasetPeriod: { start: string; end: string } | null;
  executionModel: string | null;
  transactionCostAssumptions: Record<string, unknown> | null;
  slippageAssumptions: Record<string, unknown> | null;
  wfoConfig: Record<string, unknown> | null;
  oosConfig: Record<string, unknown> | null;
  robustnessConfig: Record<string, unknown> | null;
  /** Links a re-run/refinement trial back to the trial it was derived from - null for a root trial. */
  parentTrialId: string | null;
}

export interface ExperimentLedger {
  trials: number;
  byStrategy: Record<string, number>;
  lastDatasetHash: string | null;
  trialRecords: TrialRecord[];
}

export interface RecordTrialDetail {
  parameterSet?: Record<string, unknown>;
  inSampleMetrics?: Record<string, unknown>;
  outOfSampleMetrics?: Record<string, unknown>;
  rejectionReason?: string;
  /** Defaults to 'ACCEPTED' - matches the pre-existing call site's real semantics (it records a
   *  completed backtest run, not a rejection), so omitting this argument is not a behavior change. */
  selectionStatus?: TrialSelectionStatus;
  symbol?: string;
  datasetPeriod?: { start: string; end: string };
  executionModel?: string;
  transactionCostAssumptions?: Record<string, unknown>;
  slippageAssumptions?: Record<string, unknown>;
  wfoConfig?: Record<string, unknown>;
  oosConfig?: Record<string, unknown>;
  robustnessConfig?: Record<string, unknown>;
  parentTrialId?: string;
  /** Links this trial to a pre-registered research_experiments row (see createExperiment()). Null
   *  when a trial is run standalone, outside any formal experiment - the pre-2026-09-11 default
   *  for every existing call site, unchanged. */
  experimentId?: string;
}

const ledger: ExperimentLedger = { trials: 0, byStrategy: {}, lastDatasetHash: null, trialRecords: [] };

function persist(): void {
  if (process.env.ARGUS_WRITE_RESEARCH_PARQUET !== 'true') return;
  const dir = researchDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'experiment_ledger.json'), JSON.stringify(ledger, null, 2));
}

/**
 * 2026-09-11 (Research Memory Platform Phase 1): durable, cross-restart mirror of a trial into
 * research_trials. Fire-and-forget from recordExperimentTrial() by design (mandate's own Hot Path
 * Isolation / Failure Policy sections: research telemetry is OPTIONAL_ANALYTICS, must never block
 * or fail the caller's real backtest/walk-forward work) - exported so tests can await it directly
 * instead of racing the fire-and-forget call. A DB failure here never throws into the caller and
 * never touches the in-memory ledger, which remains the unconditional source of truth for the
 * current process's own multiple-testing warning (experimentLedgerSnapshot() behavior unchanged).
 */
export async function persistTrialToDb(trial: TrialRecord, experimentId: string | null = null): Promise<void> {
  try {
    const { db } = await import('../db');
    const { researchTrials } = await import('../db/schema');
    await db.insert(researchTrials).values({
      id: trial.trialId,
      experimentId,
      strategyId: trial.strategyId,
      datasetHash: trial.datasetHash,
      parameterSetJson: trial.parameterSet ? JSON.stringify(trial.parameterSet) : null,
      evaluationTimestamp: trial.evaluationTimestamp,
      inSampleMetricsJson: trial.inSampleMetrics ? JSON.stringify(trial.inSampleMetrics) : null,
      outOfSampleMetricsJson: trial.outOfSampleMetrics ? JSON.stringify(trial.outOfSampleMetrics) : null,
      rejectionReason: trial.rejectionReason,
      selectionStatus: trial.selectionStatus,
      symbol: trial.symbol,
      datasetPeriodStart: trial.datasetPeriod?.start ?? null,
      datasetPeriodEnd: trial.datasetPeriod?.end ?? null,
      executionModel: trial.executionModel,
      transactionCostAssumptionsJson: trial.transactionCostAssumptions ? JSON.stringify(trial.transactionCostAssumptions) : null,
      slippageAssumptionsJson: trial.slippageAssumptions ? JSON.stringify(trial.slippageAssumptions) : null,
      wfoConfigJson: trial.wfoConfig ? JSON.stringify(trial.wfoConfig) : null,
      oosConfigJson: trial.oosConfig ? JSON.stringify(trial.oosConfig) : null,
      robustnessConfigJson: trial.robustnessConfig ? JSON.stringify(trial.robustnessConfig) : null,
      parentTrialId: trial.parentTrialId,
    });
  } catch (e) {
    console.error('[experimentLedger] Failed to persist trial to research_trials (in-memory ledger unaffected):', e);
  }
}

export function recordExperimentTrial(strategyId: string, datasetHash: string, detail?: RecordTrialDetail): ExperimentLedger {
  ledger.trials += 1;
  ledger.byStrategy[strategyId] = (ledger.byStrategy[strategyId] ?? 0) + 1;
  ledger.lastDatasetHash = datasetHash;
  const trial: TrialRecord = {
    trialId: crypto.randomUUID(),
    strategyId,
    datasetHash,
    parameterSet: detail?.parameterSet ?? null,
    evaluationTimestamp: new Date().toISOString(),
    inSampleMetrics: detail?.inSampleMetrics ?? null,
    outOfSampleMetrics: detail?.outOfSampleMetrics ?? null,
    rejectionReason: detail?.rejectionReason ?? null,
    selectionStatus: detail?.selectionStatus ?? 'ACCEPTED',
    symbol: detail?.symbol ?? null,
    datasetPeriod: detail?.datasetPeriod ?? null,
    executionModel: detail?.executionModel ?? null,
    transactionCostAssumptions: detail?.transactionCostAssumptions ?? null,
    slippageAssumptions: detail?.slippageAssumptions ?? null,
    wfoConfig: detail?.wfoConfig ?? null,
    oosConfig: detail?.oosConfig ?? null,
    robustnessConfig: detail?.robustnessConfig ?? null,
    parentTrialId: detail?.parentTrialId ?? null,
  };
  ledger.trialRecords.push(trial);
  persist();
  void persistTrialToDb(trial, detail?.experimentId ?? null);
  return { ...ledger, byStrategy: { ...ledger.byStrategy }, trialRecords: [...ledger.trialRecords] };
}

// ==========================================================
// Research Memory Platform Phase 1 (2026-09-11) - persisted, first-class pre-registered
// Hypothesis and Experiment entities. Confirmed real gap (audit): this codebase's pre-registered
// walk-forward validations (H1/H2/H3-style: freeze the hypothesis BEFORE inspecting new results)
// only ever existed inside a conversation transcript or a dated audit doc - nothing queryable.
// These functions give that exact discipline a durable, queryable home, without inventing new
// statistics: hypothesis confirmation still has to come from real evidence (a walk-forward run,
// an experimentAuditTrail() query, a strategy-scorecard classification) supplied by the caller.
// ==========================================================

export interface RegisterHypothesisInput {
  statement: string;
  strategyId?: string;
  /** e.g. 'win_rate', 'expectancy', 'sharpe' - free text, not an enum; real hypotheses cite varied metrics. */
  metric?: string;
  /** e.g. 'ABOVE_CHANCE', 'POSITIVE_EXPECTANCY' - free text, stated BEFORE evidence is examined. */
  expectedDirection?: string;
  /** What would confirm/reject this hypothesis - set now, not invented after seeing the result. */
  acceptanceCriteria?: string;
  /** Honest provenance - e.g. 'claude-sonnet-5' or an operator name. Never fabricated if unknown. */
  createdBy?: string;
}

export interface ResearchHypothesisRecord {
  id: string;
  statement: string;
  strategyId: string | null;
  metric: string | null;
  expectedDirection: string | null;
  acceptanceCriteria: string | null;
  preregisteredAt: string;
  createdBy: string | null;
  resolvedAt: string | null;
  resolvedStatus: 'CONFIRMED' | 'REJECTED' | 'INCONCLUSIVE' | 'ABANDONED' | null;
  resolvedEvidenceJson: string | null;
}

/** Pre-registers a hypothesis. preregisteredAt is stamped here, at insert, and never changed -
 *  this is the timestamp that later proves the hypothesis existed before its evidence was examined. */
export async function registerHypothesis(input: RegisterHypothesisInput): Promise<string> {
  const { db } = await import('../db');
  const { researchHypotheses } = await import('../db/schema');
  const id = crypto.randomUUID();
  await db.insert(researchHypotheses).values({
    id,
    statement: input.statement,
    strategyId: input.strategyId ?? null,
    metric: input.metric ?? null,
    expectedDirection: input.expectedDirection ?? null,
    acceptanceCriteria: input.acceptanceCriteria ?? null,
    preregisteredAt: new Date().toISOString(),
    createdBy: input.createdBy ?? null,
  });
  return id;
}

export interface ResolveHypothesisInput {
  hypothesisId: string;
  status: 'CONFIRMED' | 'REJECTED' | 'INCONCLUSIVE' | 'ABANDONED';
  /** The real evidence (e.g. a walk-forward summary, a strategy-scorecard classification) that
   *  produced this resolution - never a bare verdict with no supporting record. */
  evidence: Record<string, unknown>;
}

/** Write-once: refuses to overwrite a hypothesis that has already been resolved. A revised
 *  conclusion must register a new hypothesis, never silently rewrite this one's evidence -
 *  same "corrections create new events, not silent rewrites" principle as the rest of this file. */
export async function resolveHypothesis(input: ResolveHypothesisInput): Promise<void> {
  const { db } = await import('../db');
  const { researchHypotheses } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(researchHypotheses).where(eq(researchHypotheses.id, input.hypothesisId));
  const row = rows[0];
  if (!row) throw new Error(`resolveHypothesis: no hypothesis with id ${input.hypothesisId}`);
  if (row.resolvedAt) {
    throw new Error(`resolveHypothesis: hypothesis ${input.hypothesisId} was already resolved at ${row.resolvedAt} (${row.resolvedStatus}) - resolution is write-once; register a new hypothesis for a revised conclusion`);
  }
  await db.update(researchHypotheses).set({
    resolvedAt: new Date().toISOString(),
    resolvedStatus: input.status,
    resolvedEvidenceJson: JSON.stringify(input.evidence),
  }).where(eq(researchHypotheses.id, input.hypothesisId));
}

export async function listHypotheses(strategyId?: string): Promise<ResearchHypothesisRecord[]> {
  const { db } = await import('../db');
  const { researchHypotheses } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = strategyId
    ? await db.select().from(researchHypotheses).where(eq(researchHypotheses.strategyId, strategyId))
    : await db.select().from(researchHypotheses);
  return rows as ResearchHypothesisRecord[];
}

export interface CreateExperimentInput {
  hypothesisId?: string;
  strategyId?: string;
  datasetHash?: string;
  label: string;
}

export interface ResearchExperimentRecord {
  id: string;
  hypothesisId: string | null;
  strategyId: string | null;
  datasetHash: string | null;
  label: string;
  status: 'DRAFT' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABANDONED';
  createdAt: string;
  completedAt: string | null;
  resultSummaryJson: string | null;
}

/** Groups subsequent recordExperimentTrial(..., { experimentId }) calls under one formal
 *  experiment. Starts RUNNING - this function exists to register work about to happen, not work
 *  already done. */
export async function createExperiment(input: CreateExperimentInput): Promise<string> {
  const { db } = await import('../db');
  const { researchExperiments } = await import('../db/schema');
  const id = crypto.randomUUID();
  await db.insert(researchExperiments).values({
    id,
    hypothesisId: input.hypothesisId ?? null,
    strategyId: input.strategyId ?? null,
    datasetHash: input.datasetHash ?? null,
    label: input.label,
    status: 'RUNNING',
    createdAt: new Date().toISOString(),
  });
  return id;
}

export interface CompleteExperimentInput {
  experimentId: string;
  status: 'COMPLETED' | 'FAILED' | 'ABANDONED';
  resultSummary: Record<string, unknown>;
}

/** Write-once, same discipline as resolveHypothesis() - a completed experiment's recorded result
 *  is never silently revised. */
export async function completeExperiment(input: CompleteExperimentInput): Promise<void> {
  const { db } = await import('../db');
  const { researchExperiments } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(researchExperiments).where(eq(researchExperiments.id, input.experimentId));
  const row = rows[0];
  if (!row) throw new Error(`completeExperiment: no experiment with id ${input.experimentId}`);
  if (row.completedAt) {
    throw new Error(`completeExperiment: experiment ${input.experimentId} was already completed at ${row.completedAt} - completion is write-once`);
  }
  await db.update(researchExperiments).set({
    status: input.status,
    completedAt: new Date().toISOString(),
    resultSummaryJson: JSON.stringify(input.resultSummary),
  }).where(eq(researchExperiments.id, input.experimentId));
}

export async function listExperiments(strategyId?: string): Promise<ResearchExperimentRecord[]> {
  const { db } = await import('../db');
  const { researchExperiments } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = strategyId
    ? await db.select().from(researchExperiments).where(eq(researchExperiments.strategyId, strategyId))
    : await db.select().from(researchExperiments);
  return rows as ResearchExperimentRecord[];
}

/** Durable, cross-restart trial history from research_trials - unlike experimentAuditTrail()
 *  (in-memory, current process only), this reflects every trial ever persisted, across restarts. */
export async function listTrialsFromDb(experimentId: string): Promise<TrialRecord[]> {
  const { db } = await import('../db');
  const { researchTrials } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select().from(researchTrials).where(eq(researchTrials.experimentId, experimentId));
  return rows.map((r) => ({
    trialId: r.id,
    strategyId: r.strategyId,
    datasetHash: r.datasetHash,
    parameterSet: r.parameterSetJson ? JSON.parse(r.parameterSetJson) : null,
    evaluationTimestamp: r.evaluationTimestamp,
    inSampleMetrics: r.inSampleMetricsJson ? JSON.parse(r.inSampleMetricsJson) : null,
    outOfSampleMetrics: r.outOfSampleMetricsJson ? JSON.parse(r.outOfSampleMetricsJson) : null,
    rejectionReason: r.rejectionReason,
    selectionStatus: r.selectionStatus as TrialSelectionStatus,
    symbol: r.symbol,
    datasetPeriod: r.datasetPeriodStart && r.datasetPeriodEnd ? { start: r.datasetPeriodStart, end: r.datasetPeriodEnd } : null,
    executionModel: r.executionModel,
    transactionCostAssumptions: r.transactionCostAssumptionsJson ? JSON.parse(r.transactionCostAssumptionsJson) : null,
    slippageAssumptions: r.slippageAssumptionsJson ? JSON.parse(r.slippageAssumptionsJson) : null,
    wfoConfig: r.wfoConfigJson ? JSON.parse(r.wfoConfigJson) : null,
    oosConfig: r.oosConfigJson ? JSON.parse(r.oosConfigJson) : null,
    robustnessConfig: r.robustnessConfigJson ? JSON.parse(r.robustnessConfigJson) : null,
    parentTrialId: r.parentTrialId,
  }));
}

/** Composes hypothesis + experiment + its full durable trial history into one query-friendly
 *  view - the research-lineage read this whole phase exists to make possible. Returns null (never
 *  a fabricated shape) when the experiment id doesn't exist. */
export async function getExperimentWithTrials(experimentId: string): Promise<{
  experiment: ResearchExperimentRecord;
  hypothesis: ResearchHypothesisRecord | null;
  trials: TrialRecord[];
} | null> {
  const { db } = await import('../db');
  const { researchExperiments, researchHypotheses } = await import('../db/schema');
  const { eq } = await import('drizzle-orm');

  const experimentRows = await db.select().from(researchExperiments).where(eq(researchExperiments.id, experimentId));
  const experiment = experimentRows[0] as ResearchExperimentRecord | undefined;
  if (!experiment) return null;

  let hypothesis: ResearchHypothesisRecord | null = null;
  if (experiment.hypothesisId) {
    const hypothesisRows = await db.select().from(researchHypotheses).where(eq(researchHypotheses.id, experiment.hypothesisId));
    hypothesis = (hypothesisRows[0] as ResearchHypothesisRecord | undefined) ?? null;
  }

  const trials = await listTrialsFromDb(experimentId);
  return { experiment, hypothesis, trials };
}

/** Vitest isolation: fileParallelism is false so this singleton survives across files. */
export function resetExperimentLedgerForTests(): void {
  ledger.trials = 0;
  ledger.byStrategy = {};
  ledger.lastDatasetHash = null;
  ledger.trialRecords = [];
}

export function experimentLedgerSnapshot(): ExperimentLedger & ReturnType<typeof multipleTestingWarning> {
  return { ...ledger, byStrategy: { ...ledger.byStrategy }, trialRecords: [...ledger.trialRecords], ...multipleTestingWarning(ledger.trials) };
}

/** Full per-trial audit trail - accepted AND rejected/pruned trials alike, never only the winner. */
export function experimentAuditTrail(strategyId?: string): TrialRecord[] {
  const rows = strategyId ? ledger.trialRecords.filter((r) => r.strategyId === strategyId) : ledger.trialRecords;
  return [...rows];
}

export function loadLedgerFromDiskIfPresent(): void {
  const p = join(researchDataDir(), 'experiment_ledger.json');
  if (!existsSync(p)) return;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ExperimentLedger;
    ledger.trials = Number(raw.trials ?? 0);
    ledger.byStrategy = raw.byStrategy ?? {};
    ledger.lastDatasetHash = raw.lastDatasetHash ?? null;
    ledger.trialRecords = Array.isArray(raw.trialRecords) ? raw.trialRecords : [];
  } catch {
    /* corrupt ledger is not fabricated evidence */
  }
}

export function minWalkForwardWindows(): number {
  return researchSafety.minWalkForwardWindows;
}

// ==========================================================
// Deflated Sharpe Ratio (Bailey & Lopez de Prado, "The Sharpe Ratio Efficient Frontier", 2012)
//
// Real, standard, published formulation - not a novel approximation. Penalizes an observed Sharpe
// ratio for having been selected as the best of N trials: DSR is the probability that the true
// Sharpe ratio exceeds the expected maximum Sharpe ratio achievable by pure chance across N trials
// with the observed variance, given the sample's real skewness/kurtosis and length. A DSR near 1
// means the observed result is unlikely to be a data-mining artifact; a DSR near 0 or below means
// it plausibly is.
// ==========================================================

const EULER_MASCHERONI = 0.5772156649015329;

/** Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation (max error ~1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/** Inverse standard normal CDF - Acklam's rational approximation (real, published, widely used;
 *  relative error < 1.15e-9 across the full domain). */
function normalInvCdf(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pLow = 0.02425, pHigh = 1 - pLow;
  let q: number, r: number;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

export interface DeflatedSharpeInput {
  /** SR_hat - the observed Sharpe ratio of the selected/best trial. */
  observedSharpe: number;
  /** N - number of independent trials the selection was made from. */
  numTrials: number;
  /** Standard deviation of Sharpe ratios observed across all N trials - the real "skill-less
   *  variance" this specific search produced, not an assumed constant. */
  sharpeStdDev: number;
  /** T - number of return observations backing the observed Sharpe ratio. */
  numObservations: number;
  /** gamma_3, real return skewness. Defaults to 0 (no skew) only when real return-level data
   *  isn't available to the caller - never silently treated as a measured value. */
  skewness?: number;
  /** gamma_4, real return kurtosis (not excess kurtosis - 3 is the normal-distribution value).
   *  Same honesty rule as skewness. */
  kurtosis?: number;
}

export interface DeflatedSharpeResult {
  deflatedSharpeRatio: number;
  expectedMaxSharpeUnderNull: number;
  note: string;
}

export function calculateDeflatedSharpeRatio(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const { observedSharpe, numTrials, sharpeStdDev, numObservations } = input;
  const skewness = input.skewness ?? 0;
  const kurtosis = input.kurtosis ?? 3;

  if (!Number.isFinite(numTrials) || numTrials < 2) {
    return { deflatedSharpeRatio: 0, expectedMaxSharpeUnderNull: 0, note: 'INSUFFICIENT_TRIALS: DSR requires at least 2 independent trials to estimate a null distribution - not computed.' };
  }
  if (!Number.isFinite(sharpeStdDev) || sharpeStdDev <= 0) {
    return { deflatedSharpeRatio: 0, expectedMaxSharpeUnderNull: 0, note: 'DEGENERATE_VARIANCE: sharpeStdDev must be a real positive number (the trials all reported an identical Sharpe, or an invalid value) - not computed.' };
  }
  if (!Number.isFinite(numObservations) || numObservations <= 1) {
    return { deflatedSharpeRatio: 0, expectedMaxSharpeUnderNull: 0, note: 'INSUFFICIENT_SAMPLE: numObservations must exceed 1 - not computed.' };
  }

  // E[max SR] under the null (Bailey & Lopez de Prado eq. 8) - the real expected best-of-N Sharpe
  // ratio achievable by chance alone, given this search's own observed cross-trial variance.
  const expectedMaxSharpeUnderNull = sharpeStdDev * (
    (1 - EULER_MASCHERONI) * normalInvCdf(1 - 1 / numTrials) +
    EULER_MASCHERONI * normalInvCdf(1 - 1 / (numTrials * Math.E))
  );

  const denom = Math.sqrt(1 - skewness * observedSharpe + ((kurtosis - 1) / 4) * observedSharpe * observedSharpe);
  if (!Number.isFinite(denom) || denom <= 0) {
    return { deflatedSharpeRatio: 0, expectedMaxSharpeUnderNull, note: 'DEGENERATE_VARIANCE: the supplied skewness/kurtosis produced a non-positive variance term - not computed.' };
  }

  const z = ((observedSharpe - expectedMaxSharpeUnderNull) * Math.sqrt(numObservations - 1)) / denom;
  const deflatedSharpeRatio = normalCdf(z);

  return {
    deflatedSharpeRatio,
    expectedMaxSharpeUnderNull,
    note: `Real Bailey & Lopez de Prado DSR over ${numTrials} trials, ${numObservations} observations. `
      + (input.skewness === undefined || input.kurtosis === undefined
        ? 'skewness/kurtosis not supplied - defaulted to a normal-distribution assumption (0/3), not measured from real returns.'
        : 'skewness/kurtosis were supplied from real return-level data.'),
  };
}

/** Convenience: computes DSR directly from this ledger's own recorded trials for a strategy,
 *  using each trial's outOfSampleMetrics.sharpe (when present) as the per-trial Sharpe sample.
 *  Returns null (never a fabricated DSR) when fewer than 2 trials carry a real numeric Sharpe. */
export function deflatedSharpeRatioFromLedger(strategyId: string, numObservations: number): DeflatedSharpeResult | null {
  const sharpes = ledger.trialRecords
    .filter((r) => r.strategyId === strategyId)
    .map((r) => (r.outOfSampleMetrics as any)?.sharpe)
    .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));

  if (sharpes.length < 2) return null;

  const mean = sharpes.reduce((s, v) => s + v, 0) / sharpes.length;
  const variance = sharpes.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (sharpes.length - 1);
  const sharpeStdDev = Math.sqrt(variance);
  const observedSharpe = Math.max(...sharpes);

  return calculateDeflatedSharpeRatio({ observedSharpe, numTrials: sharpes.length, sharpeStdDev, numObservations });
}
