/**
 * Phase 13 (2026-08-31 strategy-starvation & real-edge audit) + Phase 14 (2026-08-31 historical-
 * replay & fair-exploration mission): strategy-level lifecycle/eligibility, reusing the existing
 * `learning_versions` Champion/Challenger table (append-only, never overwrites history) rather
 * than inventing a new table or gate. A strategy with a real, repeatedly-verified negative-
 * evidence finding (e.g. PULLBACK_CONTINUATION: effective N~22, win rate~22.7%, Wilson lower~0.101,
 * BELOW_CHANCE) can be RETIRED from real selection while it keeps being fully evaluated every
 * cycle for research/monitoring - evaluateAll() and quant_assessments.strategyEvaluations
 * persistence are completely unaffected; only the pool bestStrategyIdea() picks from is filtered.
 * Never touches consensus thresholds, RiskEngine, OMS, or calibration trust - this is a
 * strategy-selection-level decision only.
 *
 * Phase 14 richer lifecycle vocabulary (extends this module's own local `learning_versions` usage
 * only - never modifies ChampionChallengerService.ts's shared VersionStatus type or its
 * getChampion()/retireCurrentChampion() functions, which other, unrelated calibration-champion
 * consumers rely on unchanged):
 *
 *   UNTESTED           no lifecycle row exists yet - the current, pre-Phase-14 default for every
 *                      strategy that has never had an explicit eligibility decision recorded.
 *                      Fully eligible for real selection (this is today's baseline behavior).
 *   SHADOW             observed only; a real decision has been recorded but exposure is not yet
 *                      being tracked as a genuine candidate. Still eligible for real selection.
 *   CANDIDATE           showing promise, under active statistical review. Still eligible.
 *   ACTIVE_EXPLORATION bounded, monitored real exposure while evidence accumulates. Eligible.
 *   VALIDATED          passed OOS/walk-forward validation. Eligible.
 *   CHAMPION           proven current best-performing eligible strategy. Eligible.
 *   DEGRADED           was eligible; evidence has since turned negative - exposure REMOVED, a
 *                      softer/potentially-recoverable sibling of RETIRED, distinguished in
 *                      reporting only (both exclude from real selection identically).
 *   RETIRED            exposure REMOVED for negative evidence - background evaluation continues.
 *   ROLLED_BACK        a prior RETIRED/DEGRADED decision was explicitly reversed - eligible again.
 *
 * Only RETIRED and DEGRADED remove real-selection exposure. Every other status (including the
 * UNTESTED default when no row exists at all) leaves a strategy exactly as eligible as it always
 * was - this module can only ever REMOVE exposure via an explicit, evidence-backed decision, never
 * add capability beyond today's baseline, and it never lowers any consensus/calibration/RiskEngine
 * requirement to do so.
 */
import { db } from '../../db';
import { learningVersions } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';

export type StrategyLifecycleStatus =
  | 'UNTESTED'
  | 'SHADOW'
  | 'CANDIDATE'
  | 'ACTIVE_EXPLORATION'
  | 'VALIDATED'
  | 'CHAMPION'
  | 'DEGRADED'
  | 'RETIRED'
  | 'ROLLED_BACK';

const EXPOSURE_REMOVING_STATUSES: ReadonlySet<StrategyLifecycleStatus> = new Set(['RETIRED', 'DEGRADED']);

export interface StrategyLifecycleTransition {
  id: string;
  strategyId: string;
  status: StrategyLifecycleStatus;
  hypothesis: string | null;
  evidence: Record<string, unknown> | null;
  sampleSize: number;
  createdAt: string;
}

export function strategyEligibilityVersionType(strategyId: string): string {
  return `strategyEligibility:${strategyId}`;
}

function makeVersionId(strategyId: string, now: Date): string {
  return `lv-${strategyEligibilityVersionType(strategyId)}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The single, generic, evidence-backed lifecycle transition recorder - every other function in
 * this module (quarantine/reinstate) is a thin, backward-compatible convenience wrapper around
 * this. Always creates a NEW row - this table's history is never overwritten, matching every
 * other use of learning_versions.
 */
export async function recordStrategyLifecycleTransition(
  strategyId: string,
  status: StrategyLifecycleStatus,
  hypothesis: string,
  evidence: Record<string, unknown> | null,
  sampleSize: number,
  now: Date = new Date(),
): Promise<string> {
  const id = makeVersionId(strategyId, now);
  const removing = EXPOSURE_REMOVING_STATUSES.has(status);
  await db.insert(learningVersions).values({
    id,
    versionType: strategyEligibilityVersionType(strategyId),
    parentVersionId: null,
    status,
    stateJson: JSON.stringify({ strategyId, exposureRemoved: removing }),
    hypothesis,
    evidenceJson: evidence ? JSON.stringify(evidence) : null,
    sampleSize,
    createdAt: now.toISOString(),
    ...(removing ? { retiredAt: now.toISOString() } : {}),
    ...(status === 'CHAMPION' || status === 'VALIDATED' ? { promotedAt: now.toISOString() } : {}),
  });
  return id;
}

/** Most recent decision for this strategy - 'UNTESTED' when no row exists yet (today's baseline). */
export async function getStrategyLifecycleStatus(strategyId: string): Promise<StrategyLifecycleStatus> {
  const rows = await db.select().from(learningVersions)
    .where(eq(learningVersions.versionType, strategyEligibilityVersionType(strategyId)))
    .orderBy(desc(learningVersions.createdAt))
    .limit(1);
  return (rows[0]?.status as StrategyLifecycleStatus | undefined) ?? 'UNTESTED';
}

/** Full, timestamped, auditable history of lifecycle decisions for this strategy - never mutated, never overwritten. */
export async function getStrategyLifecycleHistory(strategyId: string): Promise<StrategyLifecycleTransition[]> {
  const rows = await db.select().from(learningVersions)
    .where(eq(learningVersions.versionType, strategyEligibilityVersionType(strategyId)))
    .orderBy(desc(learningVersions.createdAt));
  return rows.map((r) => ({
    id: r.id,
    strategyId,
    status: r.status as StrategyLifecycleStatus,
    hypothesis: r.hypothesis,
    evidence: r.evidenceJson ? JSON.parse(r.evidenceJson) : null,
    sampleSize: r.sampleSize,
    createdAt: r.createdAt,
  }));
}

/** Only RETIRED and DEGRADED remove real-selection exposure - every other status (including the
 *  UNTESTED default) leaves a strategy exactly as eligible as today's baseline. */
export async function isStrategyQuarantinedForEmission(strategyId: string): Promise<boolean> {
  const status = await getStrategyLifecycleStatus(strategyId);
  return EXPOSURE_REMOVING_STATUSES.has(status);
}

/**
 * Filters quarantined strategies OUT of the pool real selection (bestStrategyIdea) picks from.
 * Never mutates or filters the caller's own full strategyEvaluations - callers must persist that
 * separately, unfiltered, so a quarantined strategy's background evaluation continues unaffected.
 */
export async function filterQuarantinedStrategies<T extends { strategy: string }>(evaluations: T[]): Promise<T[]> {
  if (evaluations.length === 0) return evaluations;
  const uniqueStrategies = Array.from(new Set(evaluations.map((e) => e.strategy)));
  const flags = await Promise.all(
    uniqueStrategies.map(async (s) => [s, await isStrategyQuarantinedForEmission(s)] as const),
  );
  const quarantined = new Set(flags.filter(([, q]) => q).map(([s]) => s));
  if (quarantined.size === 0) return evaluations;
  return evaluations.filter((e) => !quarantined.has(e.strategy));
}

/**
 * Explicit, evidence-backed operator decision to stop a strategy from winning real selection,
 * without deleting it or stopping its background evaluation. Thin wrapper over
 * recordStrategyLifecycleTransition(..., 'RETIRED', ...) kept for backward compatibility with
 * existing call sites and tests.
 */
export async function quarantineStrategyForEmission(
  strategyId: string,
  hypothesis: string,
  evidence: Record<string, unknown>,
  sampleSize: number,
  now: Date = new Date(),
): Promise<string> {
  return recordStrategyLifecycleTransition(strategyId, 'RETIRED', hypothesis, evidence, sampleSize, now);
}

/** Reinstates a previously-quarantined strategy to normal real-selection eligibility - records the
 *  transition as ROLLED_BACK (an explicit reversal of a prior RETIRED/DEGRADED decision), not a
 *  fresh CHAMPION claim the evidence may not yet support. */
export async function reinstateStrategyForEmission(
  strategyId: string,
  hypothesis: string,
  now: Date = new Date(),
): Promise<string> {
  return recordStrategyLifecycleTransition(strategyId, 'ROLLED_BACK', hypothesis, null, 0, now);
}
