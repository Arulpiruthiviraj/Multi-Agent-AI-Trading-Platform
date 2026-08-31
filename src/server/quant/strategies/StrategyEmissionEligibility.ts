/**
 * Phase 13 (2026-08-31 strategy-starvation & real-edge audit): strategy-level EMISSION quarantine,
 * reusing the existing `learning_versions` Champion/Challenger lifecycle (append-only, never
 * overwrites history) rather than inventing a new table or a new gate. A strategy with a real,
 * repeatedly-verified negative-evidence finding (e.g. PULLBACK_CONTINUATION: effective N~22, win
 * rate~22.7%, Wilson lower~0.101, BELOW_CHANCE) can be RETIRED from real selection while it keeps
 * being fully evaluated every cycle for research/monitoring - evaluateAll() and
 * quant_assessments.strategyEvaluations persistence are completely unaffected; only the pool
 * bestStrategyIdea() picks from is filtered. Never touches consensus thresholds, RiskEngine, OMS,
 * or calibration trust - this is a strategy-selection-level decision only.
 */
import { db } from '../../db';
import { learningVersions } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';

export function strategyEligibilityVersionType(strategyId: string): string {
  return `strategyEligibility:${strategyId}`;
}

function makeVersionId(strategyId: string, now: Date): string {
  return `lv-${strategyEligibilityVersionType(strategyId)}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Most recent decision for this strategy wins - RETIRED means quarantined from real selection. */
export async function isStrategyQuarantinedForEmission(strategyId: string): Promise<boolean> {
  const rows = await db.select().from(learningVersions)
    .where(eq(learningVersions.versionType, strategyEligibilityVersionType(strategyId)))
    .orderBy(desc(learningVersions.createdAt))
    .limit(1);
  return rows[0]?.status === 'RETIRED';
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
 * without deleting it or stopping its background evaluation. Always creates a NEW row - this
 * table's history is never overwritten, matching every other use of learning_versions.
 */
export async function quarantineStrategyForEmission(
  strategyId: string,
  hypothesis: string,
  evidence: Record<string, unknown>,
  sampleSize: number,
  now: Date = new Date(),
): Promise<string> {
  const id = makeVersionId(strategyId, now);
  await db.insert(learningVersions).values({
    id,
    versionType: strategyEligibilityVersionType(strategyId),
    parentVersionId: null,
    status: 'RETIRED',
    stateJson: JSON.stringify({ strategyId, quarantined: true }),
    hypothesis,
    evidenceJson: JSON.stringify(evidence),
    sampleSize,
    createdAt: now.toISOString(),
    retiredAt: now.toISOString(),
  });
  return id;
}

/** Reinstates a previously-quarantined strategy to normal real-selection eligibility. */
export async function reinstateStrategyForEmission(
  strategyId: string,
  hypothesis: string,
  now: Date = new Date(),
): Promise<string> {
  const id = makeVersionId(strategyId, now);
  await db.insert(learningVersions).values({
    id,
    versionType: strategyEligibilityVersionType(strategyId),
    parentVersionId: null,
    status: 'CHAMPION',
    stateJson: JSON.stringify({ strategyId, quarantined: false }),
    hypothesis,
    evidenceJson: null,
    sampleSize: 0,
    createdAt: now.toISOString(),
    promotedAt: now.toISOString(),
  });
  return id;
}
