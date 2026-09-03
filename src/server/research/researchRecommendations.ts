/**
 * ==========================================================
 * researchRecommendations.ts
 *
 * Phase 3 (docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md): the read-only, human-reviewable view
 * over research_agent_runs rows produced by ResearchAgentRunner.ts. Pure read/reshape - no writes,
 * no new table, no mutation of any historical row. Every row already written by Phase 2 is treated
 * as an immutable research artifact; a fresh recommendation is always a NEW row (see
 * ResearchAgentRunner.ts's uuidv4() runId), never an overwrite of a past one.
 *
 * Two things are deliberately computed here, at READ time, rather than at generation time:
 *   - `stale`/`evidenceAgeMs`  - staleness is relative to "now", so it must never be baked into the
 *     persisted row (a persisted stale flag would itself go stale).
 *   - `failureReason`          - losslessly re-derived from the existing errorMessage convention
 *     ResearchAgentRunner.ts already writes (`${reason}${detail ? ': '+detail : ''}`), so a human can
 *     tell DISABLED/TIMEOUT/UNAVAILABLE/INVALID_RESPONSE apart without a schema/DB migration.
 *
 * Every view is explicitly labeled RESEARCH_RECOMMENDATION / notATradingApproval - defense in depth
 * alongside the UI's own labeling, so the API payload itself can never be mistaken for a trading
 * approval even by a caller that ignores the UI.
 * ==========================================================
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db';
import { researchAgentRuns } from '../db/schema';
import { langGraphResearch } from '../config/langGraphResearch';
import type { StrategyGraduationResult } from '../services/LangGraphResearchService';

export const STRATEGY_GRADUATION_KIND = 'STRATEGY_GRADUATION_RECOMMENDATION';

export type RecommendationRunStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'UNAVAILABLE';

export interface RecommendationView {
  disposition: 'RESEARCH_RECOMMENDATION';
  notATradingApproval: true;
  recommendationId: string;
  correlationId: string;
  strategyId: string | null;
  kind: string;
  status: RecommendationRunStatus;
  /** Re-derived from errorMessage - one of DISABLED | UNAVAILABLE | TIMEOUT | INVALID_RESPONSE |
   *  a graph-side error code, or null when status is COMPLETED. Never collapses UNAVAILABLE and
   *  FAILED into one meaning - see docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md. */
  failureReason: string | null;
  graphVersion: string | null;
  providerModel: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  result: StrategyGraduationResult | null;
  /** null when there is no result to date evidence from (e.g. still PENDING, or UNAVAILABLE). */
  stale: boolean | null;
  evidenceAgeMs: number | null;
}

type ResearchAgentRunRow = typeof researchAgentRuns.$inferSelect;

function parseResultJson(resultJson: string | null): StrategyGraduationResult | null {
  if (!resultJson) return null;
  try {
    return JSON.parse(resultJson) as StrategyGraduationResult;
  } catch {
    // A row whose resultJson somehow fails to parse is surfaced as "no result", never a fabricated
    // partial object - the caller sees status/failureReason instead.
    return null;
  }
}

function deriveFailureReason(status: string, errorMessage: string | null): string | null {
  if (status === 'COMPLETED') return null;
  if (!errorMessage) return status === 'PENDING' ? 'PENDING' : 'UNKNOWN';
  const colonIdx = errorMessage.indexOf(':');
  return colonIdx > 0 ? errorMessage.slice(0, colonIdx) : errorMessage;
}

function toView(row: ResearchAgentRunRow): RecommendationView {
  const result = parseResultJson(row.resultJson);
  let stale: boolean | null = null;
  let evidenceAgeMs: number | null = null;
  const fetchedAt = result?.provenance?.fetchedAt;
  if (fetchedAt) {
    const fetchedAtMs = Date.parse(fetchedAt);
    if (Number.isFinite(fetchedAtMs)) {
      evidenceAgeMs = Date.now() - fetchedAtMs;
      stale = evidenceAgeMs > langGraphResearch.researchRecommendationStalenessMs;
    }
  }
  return {
    disposition: 'RESEARCH_RECOMMENDATION',
    notATradingApproval: true,
    recommendationId: row.id,
    correlationId: row.correlationId,
    strategyId: row.strategyId,
    kind: row.kind,
    status: row.status as RecommendationRunStatus,
    failureReason: deriveFailureReason(row.status, row.errorMessage),
    graphVersion: row.graphVersion,
    providerModel: row.providerModel,
    durationMs: row.durationMs,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    result,
    stale,
    evidenceAgeMs,
  };
}

/** Exactly one recommendation by its id, or null if it does not exist / is not this kind. */
export async function getRecommendationById(recommendationId: string): Promise<RecommendationView | null> {
  const rows = await db
    .select()
    .from(researchAgentRuns)
    .where(and(eq(researchAgentRuns.id, recommendationId), eq(researchAgentRuns.kind, STRATEGY_GRADUATION_KIND)))
    .limit(1);
  const row = rows[0];
  return row ? toView(row) : null;
}

/** Most recent recommendations for one strategy, newest first - a real, immutable history, never
 *  the "current" recommendation overwriting the previous one. */
export async function listRecommendationsForStrategy(strategyId: string, limit = 20): Promise<RecommendationView[]> {
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit) || 20, 100));
  const rows = await db
    .select()
    .from(researchAgentRuns)
    .where(and(eq(researchAgentRuns.strategyId, strategyId), eq(researchAgentRuns.kind, STRATEGY_GRADUATION_KIND)))
    .orderBy(desc(researchAgentRuns.createdAt))
    .limit(boundedLimit);
  return rows.map(toView);
}
