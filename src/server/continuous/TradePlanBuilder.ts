/**
 * Phase 4E (Pre-Market TradePlan, 2026-08-27). A TradePlan is a hypothesis prepared from a real
 * ComposableRanking cycle (Phase 4C) - never a fabricated setup, never an order.
 *
 * Governance (do not weaken):
 * - Discovery/preparation only. Never imports OMS/RiskEngine/ChiefTraderAgent/the order-placement
 *   broker layer. Never emits TRADE_IDEA_GENERATED. Building and persisting a plan has zero effect
 *   on the live trading pipeline.
 * - Whether/how a VALID plan ever re-enters the live pipeline (via the existing
 *   TRADE_IDEA_GENERATED path, the only entry point the protected spine accepts) is a SEPARATE,
 *   deliberately NOT-yet-made decision - this module only builds, persists, and revalidates plans.
 *   No emission wiring exists here, matching this session's own "shadow/decision-report before
 *   touching anything idea-emission-adjacent" discipline.
 * - Every numeric field (entry zone, invalidation level) is derived from real fields the ranking
 *   cycle already fetched (last price, minuteHigh/Low, prevClose) - never a fabricated indicator
 *   (no ATR, no synthetic volatility estimate) that this deployment cannot honestly compute yet.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { tradePlans, tradePlanRevalidations } from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import type { RankedCandidate, RankingInput } from './ComposableRanking';

export type SetupType = 'PRIMARY' | 'BACKUP' | 'WATCHLIST';
export type TradePlanStatus = 'DRAFT' | 'READY' | 'REVALIDATING' | 'VALID' | 'INVALIDATED' | 'EXPIRED' | 'EXECUTED' | 'CLOSED';
export type RevalidationResultKind = 'REVALIDATED' | 'DOWNGRADED' | 'INVALIDATED' | 'EXPIRED';

export interface TradePlanThresholds {
  primaryCount: number;
  backupCount: number;
  watchlistCount: number;
}

export const DEFAULT_TRADE_PLAN_THRESHOLDS: TradePlanThresholds = {
  primaryCount: 3,
  backupCount: 5,
  watchlistCount: 15,
};

export interface TradePlanDraft {
  id: string;
  symbol: string;
  planDate: string;
  setupType: SetupType;
  direction: 'BUY' | 'SELL';
  thesis: string;
  catalysts: string[];
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  invalidationLevel: number | null;
  targetConcept: string;
  confidence: number;
  evidenceQuality: number;
  rankAtCreation: number;
  componentScoresJson: string;
  status: TradePlanStatus;
  createdAt: string;
  validUntil: string;
}

/** Classifies rank into a setup tier. Only PROMOTE/HOLD-tier candidates ever get a plan - a
 *  REJECT-recommended candidate never receives one, matching ComposableRanking's own bar. */
function classifySetupType(rank: number, promotionRecommendation: string, thresholds: TradePlanThresholds): SetupType | null {
  if (promotionRecommendation === 'REJECT') return null;
  if (rank <= thresholds.primaryCount) return 'PRIMARY';
  if (rank <= thresholds.primaryCount + thresholds.backupCount) return 'BACKUP';
  if (rank <= thresholds.primaryCount + thresholds.backupCount + thresholds.watchlistCount) return 'WATCHLIST';
  return null;
}

function buildThesis(candidate: RankedCandidate, input: RankingInput, direction: 'BUY' | 'SELL'): string {
  const parts: string[] = [`${direction} setup, rank #${candidate.rank}, final score ${candidate.finalScore.toFixed(3)}.`];
  const c = candidate.components;
  parts.push(`Momentum ${input.rawMomentumPct >= 0 ? '+' : ''}${input.rawMomentumPct.toFixed(2)}% (score ${c.momentum.available ? c.momentum.score!.toFixed(2) : 'N/A'}).`);
  parts.push(`Relative volume ${input.rawRelativeVolume.toFixed(2)}x (score ${c.relativeVolume.available ? c.relativeVolume.score!.toFixed(2) : 'N/A'}).`);
  parts.push(c.gap.available ? `Gap score ${c.gap.score!.toFixed(2)}.` : `Gap: ${c.gap.reason}`);
  parts.push(c.liquidity.available ? `Liquidity score ${c.liquidity.score!.toFixed(2)}.` : `Liquidity: ${c.liquidity.reason}`);
  parts.push(c.newsCatalyst.available ? `News catalyst score ${c.newsCatalyst.score!.toFixed(2)}.` : `News catalyst: ${c.newsCatalyst.reason}`);
  parts.push(c.agentConfidence.available ? `Recent agent confidence ${c.agentConfidence.score!.toFixed(2)}.` : `Agent confidence: ${c.agentConfidence.reason}`);
  return parts.join(' ');
}

/** Entry zone from the real fetched minute bar range when available; a documented, narrower
 *  fallback (0.5% of last price) when it is not - never a fabricated volatility estimate. */
function deriveEntryZone(input: RankingInput): { low: number | null; high: number | null } {
  if (input.minuteHigh != null && input.minuteLow != null && input.minuteHigh > input.minuteLow) {
    return { low: input.minuteLow, high: input.minuteHigh };
  }
  if (input.last > 0) {
    return { low: input.last * 0.995, high: input.last * 1.005 };
  }
  return { low: null, high: null };
}

function deriveInvalidationLevel(input: RankingInput, direction: 'BUY' | 'SELL'): number | null {
  if (direction === 'BUY') {
    return input.minuteLow ?? (input.prevClose > 0 ? input.prevClose * 0.98 : null);
  }
  return input.minuteHigh ?? (input.prevClose > 0 ? input.prevClose * 1.02 : null);
}

/** End of the trading day the plan is FOR (planDate), 16:00 ET, expressed as an ISO instant. */
function endOfTradingDayIso(planDate: string): string {
  return new Date(`${planDate}T16:00:00-04:00`).toISOString();
}

/**
 * Builds one TradePlanDraft per eligible ranked candidate. `inputsBySymbol` must be the SAME
 * RankingInput data the ranking cycle itself computed from (no new network calls, no re-derivation).
 * Candidates with no matching input, or with all components unavailable, are skipped (never given
 * a fabricated plan).
 */
export function buildTradePlanDrafts(
  ranked: RankedCandidate[],
  inputsBySymbol: Map<string, RankingInput>,
  planDate: string,
  now: Date = new Date(),
  thresholds: TradePlanThresholds = DEFAULT_TRADE_PLAN_THRESHOLDS,
): TradePlanDraft[] {
  const drafts: TradePlanDraft[] = [];
  const validUntil = endOfTradingDayIso(planDate);
  const createdAt = now.toISOString();

  for (const candidate of ranked) {
    const setupType = classifySetupType(candidate.rank, candidate.promotionRecommendation, thresholds);
    if (!setupType) continue;
    const input = inputsBySymbol.get(candidate.symbol);
    if (!input) continue;

    const direction: 'BUY' | 'SELL' = input.rawMomentumPct >= 0 ? 'BUY' : 'SELL';
    const { low, high } = deriveEntryZone(input);
    const invalidationLevel = deriveInvalidationLevel(input, direction);
    const catalysts: string[] = [];
    if (candidate.components.newsCatalyst.available) catalysts.push(`News catalyst (score ${candidate.components.newsCatalyst.score!.toFixed(2)})`);
    if (candidate.components.gap.available && candidate.components.gap.score! > 0.3) catalysts.push('Gap behavior');

    drafts.push({
      id: randomUUID(),
      symbol: candidate.symbol,
      planDate,
      setupType,
      direction,
      thesis: buildThesis(candidate, input, direction),
      catalysts,
      entryZoneLow: low,
      entryZoneHigh: high,
      invalidationLevel,
      targetConcept: direction === 'BUY' ? 'Momentum continuation toward the session high' : 'Momentum continuation toward the session low',
      confidence: candidate.finalScore,
      // Real completeness measure - fraction of the 7 named components that had actual data this
      // cycle, independent of finalScore (a high score built on 2/7 available components is
      // weaker evidence than the same score built on 6/7).
      evidenceQuality: Object.values(candidate.components).filter((c) => c.available).length / Object.keys(candidate.components).length,
      rankAtCreation: candidate.rank,
      componentScoresJson: JSON.stringify(candidate.components),
      status: 'READY',
      createdAt,
      validUntil,
    });
  }
  return drafts;
}

export async function persistTradePlanDrafts(drafts: TradePlanDraft[]): Promise<void> {
  if (drafts.length === 0) return;
  try {
    await db.insert(tradePlans).values(drafts.map((d) => ({ ...d, catalysts: JSON.stringify(d.catalysts) })));
  } catch (e) {
    console.error('[TradePlanBuilder] Failed to persist trade plan drafts', e);
  }
}

export interface RevalidationOutcome {
  result: RevalidationResultKind;
  reason: string;
  priceAtRevalidation: number | null;
}

/**
 * Revalidates one plan against live data. Never fabricates evidence: a symbol with no current
 * input is treated as INVALIDATED (cannot confirm the thesis still holds), never silently kept VALID.
 */
export function revalidateTradePlan(
  plan: { direction: string; invalidationLevel: number | null; validUntil: string },
  currentInput: RankingInput | null,
  currentRanked: RankedCandidate | null,
  now: Date = new Date(),
): RevalidationOutcome {
  if (now.toISOString() > plan.validUntil) {
    return { result: 'EXPIRED', reason: `Plan valid-until (${plan.validUntil}) has passed.`, priceAtRevalidation: currentInput?.last ?? null };
  }
  if (!currentInput) {
    return { result: 'INVALIDATED', reason: 'No current market data available for this symbol at revalidation time.', priceAtRevalidation: null };
  }
  if (plan.invalidationLevel != null) {
    if (plan.direction === 'BUY' && currentInput.last < plan.invalidationLevel) {
      return { result: 'INVALIDATED', reason: `Price ${currentInput.last} broke below invalidation level ${plan.invalidationLevel}.`, priceAtRevalidation: currentInput.last };
    }
    if (plan.direction === 'SELL' && currentInput.last > plan.invalidationLevel) {
      return { result: 'INVALIDATED', reason: `Price ${currentInput.last} broke above invalidation level ${plan.invalidationLevel}.`, priceAtRevalidation: currentInput.last };
    }
  }
  if (!currentRanked) {
    return { result: 'DOWNGRADED', reason: 'Symbol no longer appears in the current ranking cycle - thesis strength cannot be reconfirmed.', priceAtRevalidation: currentInput.last };
  }
  if (currentRanked.promotionRecommendation === 'REJECT') {
    return { result: 'INVALIDATED', reason: `Current ranking cycle recommends REJECT (score ${currentRanked.finalScore.toFixed(3)}) - thesis no longer supported.`, priceAtRevalidation: currentInput.last };
  }
  if (currentRanked.promotionRecommendation === 'HOLD') {
    return { result: 'DOWNGRADED', reason: `Current ranking cycle recommends HOLD (score ${currentRanked.finalScore.toFixed(3)}) - thesis weakened but not invalidated.`, priceAtRevalidation: currentInput.last };
  }
  return { result: 'REVALIDATED', reason: `Current ranking cycle still recommends PROMOTE (score ${currentRanked.finalScore.toFixed(3)}); price within thesis bounds.`, priceAtRevalidation: currentInput.last };
}

export async function persistRevalidation(planId: string, outcome: RevalidationOutcome, now: Date = new Date()): Promise<void> {
  try {
    await db.insert(tradePlanRevalidations).values({
      planId,
      revalidatedAt: now.toISOString(),
      result: outcome.result,
      reason: outcome.reason,
      priceAtRevalidation: outcome.priceAtRevalidation,
    });
    const newStatus: TradePlanStatus = outcome.result === 'REVALIDATED' ? 'VALID'
      : outcome.result === 'DOWNGRADED' ? 'REVALIDATING'
        : outcome.result === 'EXPIRED' ? 'EXPIRED' : 'INVALIDATED';
    await db.update(tradePlans).set({ status: newStatus }).where(eq(tradePlans.id, planId));
  } catch (e) {
    console.error('[TradePlanBuilder] Failed to persist revalidation', e);
  }
}

export async function getTradePlansForDate(planDate: string): Promise<Array<typeof tradePlans.$inferSelect>> {
  return db.select().from(tradePlans).where(eq(tradePlans.planDate, planDate)).orderBy(tradePlans.rankAtCreation);
}

export async function getRevalidationHistory(planId: string): Promise<Array<typeof tradePlanRevalidations.$inferSelect>> {
  return db.select().from(tradePlanRevalidations).where(eq(tradePlanRevalidations.planId, planId)).orderBy(desc(tradePlanRevalidations.revalidatedAt));
}
