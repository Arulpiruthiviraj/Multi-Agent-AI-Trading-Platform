/**
 * Phase 4H (Controlled Self-Evolution / Champion-Challenger, 2026-08-27). Versions a
 * SHADOW -> CANDIDATE -> CHAMPION lifecycle for learning-derived state (e.g. an alternative
 * agent-weighting or scoring hypothesis), with an explicit, gated promotion decision and full
 * rollback history.
 *
 * Non-negotiable: no experimental version may replace the champion without passing the promotion
 * gate (minimum sample size AND a minimum improvement margin, both config-driven - never a TS
 * literal). This module never mutates `agent_performance_stats.currentWeight`, `config/agentWeights.json`,
 * or `tradingSafety.json` consensus/threshold values - it only tracks which learning-state version
 * is currently "current" for a given `versionType`, for observability and future, separately
 * authorized wiring. It never imports OMS/RiskEngine/the order-placement broker layer.
 */
import { db } from '../db';
import { learningVersions, promotionDecisions, rollbackEvents } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { logErrorSafely } from '../core/SecretRedaction';
import { continuousIntelligence } from '../config/continuousIntelligence';

export type VersionStatus = 'SHADOW' | 'CANDIDATE' | 'CHAMPION' | 'RETIRED' | 'ROLLED_BACK';

function makeId(prefix: string, versionType: string, now: Date): string {
  return `${prefix}-${versionType}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function createShadowVersion(
  versionType: string,
  stateJson: string,
  hypothesis: string | null,
  now: Date = new Date(),
): Promise<string> {
  const champion = await getChampion(versionType);
  const id = makeId('lv', versionType, now);
  await db.insert(learningVersions).values({
    id,
    versionType,
    parentVersionId: champion?.id ?? null,
    status: 'SHADOW',
    stateJson,
    hypothesis,
    evidenceJson: null,
    sampleSize: 0,
    createdAt: now.toISOString(),
  });
  return id;
}

export async function getChampion(versionType: string): Promise<typeof learningVersions.$inferSelect | null> {
  const rows = await db.select().from(learningVersions)
    .where(and(eq(learningVersions.versionType, versionType), eq(learningVersions.status, 'CHAMPION')))
    .orderBy(desc(learningVersions.promotedAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getVersionHistory(versionType: string, limit = 50): Promise<Array<typeof learningVersions.$inferSelect>> {
  return db.select().from(learningVersions)
    .where(eq(learningVersions.versionType, versionType))
    .orderBy(desc(learningVersions.createdAt))
    .limit(limit);
}

/** Advances a SHADOW version to CANDIDATE once it has accumulated evidence worth formally evaluating. */
export async function promoteToCandidate(versionId: string, evidenceJson: string, sampleSize: number): Promise<void> {
  await db.update(learningVersions)
    .set({ status: 'CANDIDATE', evidenceJson, sampleSize })
    .where(eq(learningVersions.id, versionId));
}

export interface PromotionMetrics {
  /** e.g. accuracy, expectancy, hit rate - whatever numeric metric this versionType is judged on. */
  metricName: string;
  candidateMetricValue: number;
  championMetricValue: number | null;
  sampleSize: number;
}

export interface PromotionGateResult {
  decision: 'PASS' | 'FAIL';
  reason: string;
}

/**
 * The gate itself: both floors are config-driven (never a TS literal). A candidate with no
 * existing champion still needs the sample-size floor, but has no improvement-margin comparison to
 * pass (first-ever champion for this versionType).
 */
export function evaluatePromotionGate(metrics: PromotionMetrics): PromotionGateResult {
  const minSampleSize = continuousIntelligence.championChallengerMinSampleSize;
  const minMargin = continuousIntelligence.championChallengerMinImprovementMargin;

  if (metrics.sampleSize < minSampleSize) {
    return { decision: 'FAIL', reason: `Sample size ${metrics.sampleSize} below required floor ${minSampleSize}.` };
  }
  if (metrics.championMetricValue === null) {
    return { decision: 'PASS', reason: `No existing champion for this version type; sample size floor (${minSampleSize}) met.` };
  }
  const improvement = metrics.candidateMetricValue - metrics.championMetricValue;
  if (improvement < minMargin) {
    return {
      decision: 'FAIL',
      reason: `Improvement ${improvement.toFixed(4)} (${metrics.metricName}) below required margin ${minMargin}.`,
    };
  }
  return { decision: 'PASS', reason: `Improvement ${improvement.toFixed(4)} (${metrics.metricName}) meets required margin ${minMargin}.` };
}

/**
 * Runs the gate and persists the decision. On PASS, retires the current champion (if any) and
 * promotes the candidate - this is the ONLY path a version can reach CHAMPION status.
 */
export async function decidePromotion(
  versionId: string,
  versionType: string,
  metrics: PromotionMetrics,
  now: Date = new Date(),
): Promise<PromotionGateResult> {
  const result = evaluatePromotionGate(metrics);
  try {
    await db.insert(promotionDecisions).values({
      versionId,
      decision: result.decision,
      reason: result.reason,
      metricsJson: JSON.stringify(metrics),
      decidedAt: now.toISOString(),
    });

    if (result.decision === 'PASS') {
      const currentChampion = await getChampion(versionType);
      if (currentChampion) {
        await db.update(learningVersions)
          .set({ status: 'RETIRED', retiredAt: now.toISOString() })
          .where(eq(learningVersions.id, currentChampion.id));
      }
      await db.update(learningVersions)
        .set({ status: 'CHAMPION', promotedAt: now.toISOString(), sampleSize: metrics.sampleSize })
        .where(eq(learningVersions.id, versionId));
    }
  } catch (e) {
    logErrorSafely('[ChampionChallengerService] failed to persist promotion decision', e);
  }
  return result;
}

/**
 * Retires the current CHAMPION for a versionType with NO replacement promoted - distinct from
 * decidePromotion()'s retire-then-promote pair, which only ever retires a champion in the same
 * breath it installs a new one. A consumer needs this when fresh evidence re-evaluates a bucket
 * and finds it no longer clears the promotion bar at all (not merely "a different candidate is
 * better") - the honest outcome is "no trustworthy champion right now", not "keep the old one
 * forever because nothing has replaced it yet". No-op (returns false) when there is no current
 * champion for this versionType.
 */
export async function retireCurrentChampion(versionType: string, reason: string, now: Date = new Date()): Promise<boolean> {
  const currentChampion = await getChampion(versionType);
  if (!currentChampion) return false;
  try {
    await db.update(learningVersions)
      .set({ status: 'RETIRED', retiredAt: now.toISOString() })
      .where(eq(learningVersions.id, currentChampion.id));
    await db.insert(promotionDecisions).values({
      versionId: currentChampion.id,
      decision: 'FAIL',
      reason,
      metricsJson: JSON.stringify({ retiredNoReplacement: true }),
      decidedAt: now.toISOString(),
    });
    return true;
  } catch (e) {
    logErrorSafely(`[ChampionChallengerService] failed to retire stale champion for ${versionType}`, e);
    return false;
  }
}

export async function getPromotionHistory(versionId: string): Promise<Array<typeof promotionDecisions.$inferSelect>> {
  return db.select().from(promotionDecisions)
    .where(eq(promotionDecisions.versionId, versionId))
    .orderBy(desc(promotionDecisions.decidedAt));
}

/**
 * Reverts a versionType's current champion back to a previously-champion (now RETIRED) version.
 * Distinct from the trading kill switch - this only concerns which learning-state version is
 * "current" for observability; it never touches TRADING_ENABLED/TRADING_PAUSED/EMERGENCY_STOP.
 */
export async function rollbackToVersion(
  versionType: string,
  toVersionId: string,
  reason: string,
  actor: string,
  now: Date = new Date(),
): Promise<void> {
  const currentChampion = await getChampion(versionType);
  if (!currentChampion) {
    throw new Error(`No current champion for versionType=${versionType} to roll back from.`);
  }
  const target = await db.select().from(learningVersions).where(eq(learningVersions.id, toVersionId)).limit(1);
  if (target.length === 0) {
    throw new Error(`Rollback target version ${toVersionId} not found.`);
  }

  await db.update(learningVersions)
    .set({ status: 'ROLLED_BACK', retiredAt: now.toISOString() })
    .where(eq(learningVersions.id, currentChampion.id));
  await db.update(learningVersions)
    .set({ status: 'CHAMPION', promotedAt: now.toISOString() })
    .where(eq(learningVersions.id, toVersionId));

  await db.insert(rollbackEvents).values({
    versionType,
    fromVersionId: currentChampion.id,
    toVersionId,
    reason,
    actor,
    createdAt: now.toISOString(),
  });
}

export async function getRollbackHistory(versionType: string, limit = 50): Promise<Array<typeof rollbackEvents.$inferSelect>> {
  return db.select().from(rollbackEvents)
    .where(eq(rollbackEvents.versionType, versionType))
    .orderBy(desc(rollbackEvents.createdAt))
    .limit(limit);
}
