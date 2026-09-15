/**
 * Strategy lifecycle re-certification review (2026-09-14, item #9 / mandate Phase 11).
 *
 * Real gap this closes: StrategyEmissionEligibility.ts's RETIRED/DEGRADED states correctly remove
 * a strategy from real selection on real evidence (e.g. PULLBACK_CONTINUATION, retired 2026-08-31
 * at effectiveN~22/winRate~22.7%/wilsonLower~0.101), and `reinstateStrategyForEmission()` exists to
 * reverse that decision - but nothing ever calls it, and nothing re-checks whether the evidence
 * that justified the retirement still holds. A strategy that keeps being evaluated in the
 * background (by design - see that module's own header) can accumulate materially different
 * evidence with no visibility: real forensic finding, same day, same investigation - the same
 * strategy's evidence had moved to effectiveN~50/winRate~50.0%/wilsonLower~0.366 with nothing
 * having looked at it since the original retirement.
 *
 * This module ONLY reviews and reports. Per mandate Phase 11 and this codebase's own standing
 * "research produces hypotheses, never automatic production changes" rule: it NEVER calls
 * reinstateStrategyForEmission() or otherwise changes a strategy's status. A human decides that,
 * informed by this report - exactly the same discipline as every other research/observability
 * surface in this codebase (strategy-fairness, agent-edge, etc.).
 *
 * Reuses the EXISTING, already-tested agentEdgeAnalytics.ts computation (effective-N/Wilson via
 * effectiveSampleSize.ts) rather than a second, parallel statistics implementation - the same
 * table `argus-cli agent-edge` already prints includes exactly the per-(agent,strategy) rows this
 * needs.
 */
import { db } from '../../db';
import { learningVersions } from '../../db/schema';
import { like, desc } from 'drizzle-orm';
import { buildAgentEdgeReport, type AgentEdgeRow } from '../../research/agentEdgeAnalytics';
import { strategyEligibilityVersionType, type StrategyLifecycleStatus } from './StrategyEmissionEligibility';
import { structuredLogger, observeSafe } from '../../observability/StructuredLogger';

const EXPOSURE_REMOVING: ReadonlySet<StrategyLifecycleStatus> = new Set(['RETIRED', 'DEGRADED']);
const VERSION_TYPE_PREFIX = 'strategyEligibility:';

export interface RecertificationReviewRow {
  strategyId: string;
  status: StrategyLifecycleStatus;
  originalEvidence: { effectiveN?: number; winRate?: number; wilsonLower?: number } | null;
  originalHypothesis: string | null;
  retiredAt: string | null;
  /** Fresh evidence, matched by strategyId (including the __COLD_START_BOOTSTRAP-suffixed variant
   *  agentEdgeAnalytics.ts already tracks separately) - null when no fresh predictions exist yet
   *  for this exact strategy id since retirement (nothing to compare against). */
  freshEvidence: { rawN: number; effectiveN: number; winRate: number | null; wilsonLower: number | null } | null;
  /** Purely descriptive, never a recommendation to act - see this module's own header. True only
   *  when fresh evidence exists AND meaningfully diverges from what justified the original
   *  decision (effective N materially grown AND the Wilson lower bound has moved across the 0.5
   *  line in either direction), so a reviewer knows where to actually look first. */
  evidenceHasShifted: boolean;
}

/** Every strategy id currently RETIRED or DEGRADED (latest transition per strategy only - an
 *  earlier ROLLED_BACK or a more recent re-retirement both correctly resolve to the true current
 *  state via this same "most recent row wins" rule StrategyEmissionEligibility.ts already uses). */
export async function listQuarantinedStrategyIds(): Promise<string[]> {
  const rows = await db.select().from(learningVersions)
    .where(like(learningVersions.versionType, `${VERSION_TYPE_PREFIX}%`))
    .orderBy(desc(learningVersions.createdAt));

  const latestByStrategy = new Map<string, typeof rows[number]>();
  for (const r of rows) {
    const strategyId = r.versionType.slice(VERSION_TYPE_PREFIX.length);
    if (!latestByStrategy.has(strategyId)) latestByStrategy.set(strategyId, r); // first seen = most recent (already ordered desc)
  }
  return [...latestByStrategy.entries()]
    .filter(([, r]) => EXPOSURE_REMOVING.has(r.status as StrategyLifecycleStatus))
    .map(([strategyId]) => strategyId);
}

function findFreshEvidenceRow(rows: AgentEdgeRow[], strategyId: string): AgentEdgeRow | null {
  // agentEdgeAnalytics.ts tracks a cold-start-bootstrap-sourced idea for the same real strategy as
  // a DISTINCT row (never merged - see StrategyEmissionEligibility.ts's own header on why) - a
  // retirement decision make on the bootstrap-era evidence should compare against that same
  // variant first, falling back to the plain id if no bootstrap-tagged row exists.
  return rows.find((r) => r.agentName === 'QuantEngine' && r.strategyId === `${strategyId}__COLD_START_BOOTSTRAP`)
    ?? rows.find((r) => r.agentName === 'QuantEngine' && r.strategyId === strategyId)
    ?? null;
}

function hasEvidenceShifted(
  original: RecertificationReviewRow['originalEvidence'],
  fresh: RecertificationReviewRow['freshEvidence'],
): boolean {
  if (!original || !fresh || fresh.wilsonLower === null) return false;
  const originalLower = original.wilsonLower ?? 0;
  const effectiveNGrew = fresh.effectiveN >= (original.effectiveN ?? 0) * 1.5; // meaningfully more evidence, not just noise
  const crossedFiftyLine = (originalLower < 0.5 && fresh.wilsonLower >= 0.5) || (originalLower >= 0.5 && fresh.wilsonLower < 0.5);
  return effectiveNGrew && crossedFiftyLine;
}

/**
 * The one real entry point. Bounded by construction: buildAgentEdgeReport() itself already scopes
 * its own query (agentEdgeAnalytics.ts), and the set of quarantined strategies is small (a handful
 * at most, not thousands) - never an unscoped scan of its own.
 */
export async function buildRecertificationReview(): Promise<RecertificationReviewRow[]> {
  const [quarantinedIds, freshRows] = await Promise.all([
    listQuarantinedStrategyIds(),
    buildAgentEdgeReport(),
  ]);
  if (quarantinedIds.length === 0) return [];

  const reviews: RecertificationReviewRow[] = [];
  for (const strategyId of quarantinedIds) {
    const history = await db.select().from(learningVersions)
      .where(like(learningVersions.versionType, `${strategyEligibilityVersionType(strategyId)}`))
      .orderBy(desc(learningVersions.createdAt))
      .limit(1);
    const latest = history[0];
    if (!latest) continue;

    let originalEvidence: RecertificationReviewRow['originalEvidence'] = null;
    if (latest.evidenceJson) {
      try { originalEvidence = JSON.parse(latest.evidenceJson); } catch { originalEvidence = null; }
    }

    const freshRow = findFreshEvidenceRow(freshRows, strategyId);
    const freshEvidence = freshRow
      ? { rawN: freshRow.rawN, effectiveN: freshRow.effectiveN, winRate: freshRow.winRate, wilsonLower: freshRow.wilsonLower }
      : null;

    const row: RecertificationReviewRow = {
      strategyId,
      status: latest.status as StrategyLifecycleStatus,
      originalEvidence,
      originalHypothesis: latest.hypothesis,
      retiredAt: latest.retiredAt,
      freshEvidence,
      evidenceHasShifted: hasEvidenceShifted(originalEvidence, freshEvidence),
    };
    reviews.push(row);
  }

  observeSafe(() => {
    const shiftedCount = reviews.filter((r) => r.evidenceHasShifted).length;
    structuredLogger.info(
      `Strategy re-certification review: ${reviews.length} quarantined strategies checked, ${shiftedCount} with meaningfully shifted evidence`,
      { category: 'SYSTEM', eventType: 'STRATEGY_RECERTIFICATION_REVIEWED', reviewedCount: reviews.length, shiftedCount },
    );
  });

  return reviews;
}

export function formatRecertificationReview(rows: RecertificationReviewRow[]): string {
  if (rows.length === 0) {
    return 'STRATEGY RE-CERTIFICATION REVIEW\n==================================\nNo quarantined (RETIRED/DEGRADED) strategies exist.';
  }
  const lines = [
    'STRATEGY RE-CERTIFICATION REVIEW',
    '==================================',
    'Review only - never auto-reinstates. A shifted-evidence flag means "look at this first," not "reinstate this."',
    '',
    'Strategy                    Status    RetiredAt             OrigEffN OrigWinRate OrigWilsonLo  FreshEffN FreshWinRate FreshWilsonLo  Shifted',
  ];
  for (const r of rows) {
    const oe = r.originalEvidence;
    const fe = r.freshEvidence;
    lines.push(
      `${r.strategyId.padEnd(28)} ${r.status.padEnd(9)} ${(r.retiredAt ?? 'n/a').padEnd(21)} `
      + `${String(oe?.effectiveN ?? 'n/a').padEnd(8)} ${oe?.winRate !== undefined ? (oe.winRate * 100).toFixed(1) + '%' : 'n/a'.padEnd(11)} ${oe?.wilsonLower !== undefined ? (oe.wilsonLower * 100).toFixed(1) + '%' : 'n/a'.padEnd(12)}  `
      + `${String(fe?.effectiveN ?? 'n/a').padEnd(9)} ${fe?.winRate != null ? (fe.winRate * 100).toFixed(1) + '%' : 'n/a'.padEnd(12)} ${fe?.wilsonLower != null ? (fe.wilsonLower * 100).toFixed(1) + '%' : 'n/a'.padEnd(13)}  `
      + `${r.evidenceHasShifted ? 'YES - REVIEW' : 'no'}`,
    );
  }
  return lines.join('\n');
}
