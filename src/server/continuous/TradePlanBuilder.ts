/**
 * Phase 4E (Pre-Market TradePlan, 2026-08-27). A TradePlan is a hypothesis prepared from a real
 * ComposableRanking cycle (Phase 4C) - never a fabricated setup, never an order.
 *
 * Governance (do not weaken):
 * - Discovery/preparation only. Never imports OMS/RiskEngine/ChiefTraderAgent/the order-placement
 *   broker layer. Building and persisting a plan has zero effect on the live trading pipeline by
 *   itself.
 * - **2026-09-05 update, explicit operator authorization**
 *   (docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md §12): this module's prior stance was
 *   "never emits TRADE_IDEA_GENERATED... a SEPARATE, deliberately NOT-yet-made decision," gated
 *   behind accumulating real graded evidence via TradePlanShadowTracker first (matching the Java
 *   factor-composite precedent). The repository owner was told that reasoning explicitly and chose
 *   to override it for this deployment. `emitTradePlanIdea()` below is the result: it emits
 *   exactly ONE independent TRADE_IDEA_GENERATED vote per PRIMARY-tier plan, through the same
 *   architecture-protection allowlist mechanism `OpportunityScreener.ts` already uses (see
 *   `src/server/architecture.protection.test.ts`) - never a bypass of ChiefTrader/RiskEngine/OMS,
 *   never CHIEF_APPROVED_IDEA, never `.placeOrder(` from this file. Off by default
 *   (`ARGUS_TRADE_PLAN_IDEAS_ENABLED`) for any deployment that has not made the same explicit
 *   choice. `recordTradePlanShadowPrediction()` below is unaffected and keeps running regardless -
 *   the evidence-gathering mechanism still exists even though this deployment chose not to wait
 *   for it.
 * - Every numeric field (entry zone, invalidation level) is derived from real fields the ranking
 *   cycle already fetched (last price, minuteHigh/Low, prevClose) - never a fabricated indicator
 *   (no ATR, no synthetic volatility estimate) that this deployment cannot honestly compute yet.
 */
import { randomUUID } from 'node:crypto';
import { db } from '../db';
import { tradePlans, tradePlanRevalidations } from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import type { RankedCandidate, RankingInput, NewsCatalystDetail } from './ComposableRanking';
import { eventBus } from '../core/EventBus';
import { generateTraceId } from '../core/traceId';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { isTradePlanIdeasEnabled } from '../config/continuousIntelligence';

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
  /** Session-Aware Trading Architecture Phase 4 (2026-09-05): DISTINCT from confidence, per
   *  docs/architecture/ARGUS_PREMARKET_GAP_ANALYSIS.md §5.1's finding that this file previously
   *  used candidate.finalScore for both concepts. confidence is the weighted-average MAGNITUDE
   *  (how strong is the signal); confluenceScore is the fraction of AVAILABLE components that
   *  independently clear a "meaningfully supportive" bar - how many separate pieces of evidence
   *  agree, not how strong any one of them is. A plan can have high confidence driven by one
   *  dominant component and low confluence (few independent sources agree), or the reverse. */
  confluenceScore: number;
  /** Structured catalyst evidence (news_clusters.eventType/sourceCount) - null when no news
   *  catalyst detail was supplied to buildTradePlanDrafts() this cycle (optional, caller-supplied;
   *  never fabricated when absent). sourceCount is a raw corroboration count, not a calibrated
   *  reliability score - see NewsCatalystDetail's own doc comment in ComposableRanking.ts. */
  catalystType: string | null;
  catalystSourceCount: number | null;
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

/** A component "agrees" if it's available AND clears this bar - not merely present. Matches this
 *  file's own local-named-constant convention (DEFAULT_TRADE_PLAN_THRESHOLDS, PROMOTE_THRESHOLD
 *  in ComposableRanking.ts) rather than a config-file entry for a not-yet-validated construct. */
const CONFLUENCE_AGREEMENT_THRESHOLD = 0.5;

/** Fraction of AVAILABLE components that independently clear CONFLUENCE_AGREEMENT_THRESHOLD -
 *  see TradePlanDraft.confluenceScore's own doc comment for why this is distinct from confidence. */
function computeConfluenceScore(candidate: RankedCandidate): number {
  const components = Object.values(candidate.components);
  const available = components.filter((c) => c.available);
  if (available.length === 0) return 0;
  const agreeing = available.filter((c) => (c.score ?? 0) >= CONFLUENCE_AGREEMENT_THRESHOLD);
  return agreeing.length / available.length;
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
  /** Optional, caller-supplied (e.g. ComposableRanking.fetchNewsCatalystDetails()) - default empty
   *  map means catalystType/catalystSourceCount stay null, identical behavior to before this
   *  parameter existed. Kept optional/pure rather than making this function fetch its own data,
   *  preserving its existing "pure, synchronous, directly testable" contract. */
  catalystDetailsBySymbol: Map<string, NewsCatalystDetail> = new Map(),
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
    const catalystDetail = catalystDetailsBySymbol.get(candidate.symbol) ?? null;

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
      confluenceScore: computeConfluenceScore(candidate),
      catalystType: catalystDetail?.eventType ?? null,
      catalystSourceCount: catalystDetail?.sourceCount ?? null,
      // Real completeness measure - fraction of the 8 named components that had actual data this
      // cycle, independent of finalScore (a high score built on 2/8 available components is
      // weaker evidence than the same score built on 6/8).
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

export interface TradePlanIdeaResult {
  emitted: boolean;
  reason: string;
  symbol: string;
}

/**
 * 2026-09-05, explicit operator authorization - see this file's own header. Emits exactly ONE
 * TRADE_IDEA_GENERATED per PRIMARY-tier plan (never BACKUP/WATCHLIST - a deliberately conservative
 * scope given zero prior track record; the operator can widen this later). This is one independent
 * vote into the existing ChiefTraderAgent consensus (same 0.75 bar, same min-2-independent-agents
 * floor as every other agent) - never a bypass, never CHIEF_APPROVED_IDEA, never `.placeOrder(`
 * from this module. Gated behind THREE independent checks, matching OpportunityScreener.ts's own
 * pattern exactly: the master flag (isTradePlanIdeasEnabled), the Autobot/session-recovery/
 * campaign-lock composite gate (isLiveIdeaGenerationEnabled), and the per-agent Mission Control
 * toggle (isPipelineAgentEnabled) - any one of the three being off means zero ideas emitted.
 */
export function emitTradePlanIdea(draft: TradePlanDraft, currentPrice: number | null): TradePlanIdeaResult {
  if (draft.setupType !== 'PRIMARY') {
    return { emitted: false, reason: 'NOT_PRIMARY_TIER', symbol: draft.symbol };
  }
  if (!isTradePlanIdeasEnabled()) {
    return { emitted: false, reason: 'FLAG_OFF', symbol: draft.symbol };
  }
  if (!isPipelineAgentEnabled('TradePlanBuilder')) {
    return { emitted: false, reason: 'AGENT_DISABLED', symbol: draft.symbol };
  }
  if (!isLiveIdeaGenerationEnabled()) {
    return { emitted: false, reason: 'IDEA_GENERATION_GATED', symbol: draft.symbol };
  }
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { emitted: false, reason: 'INVALID_PRICE', symbol: draft.symbol };
  }

  const traceId = generateTraceId(draft.symbol);
  eventBus.emitTradeIdea({
    traceId,
    symbol: draft.symbol,
    side: draft.direction,
    confidence: draft.confidence,
    currentPrice,
    reasoning: `[TradePlan ${draft.id}, PRIMARY tier, rank #${draft.rankAtCreation}] ${draft.thesis}`,
    agent: 'TradePlanBuilder',
    strategy: 'PREMARKET_TRADE_PLAN',
    timeframe: 'premarket_daily',
    evidence: { confluenceScore: draft.confluenceScore, evidenceQuality: draft.evidenceQuality, setupType: draft.setupType },
  });
  return { emitted: true, reason: 'EMITTED', symbol: draft.symbol };
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

/** Caller-supplied context for the shadow-tracking prediction below - kept optional and separate
 *  from RevalidationOutcome (which is a pure decision result, not persisted plan data) rather than
 *  re-querying the plan row this function already has no other reason to read. */
export interface TradePlanShadowContext {
  symbol: string;
  direction: 'BUY' | 'SELL';
  confidence: number;
}

/**
 * Session-Aware Trading Architecture Phase 5 gap-analysis follow-up (2026-09-05,
 * docs/architecture/ARGUS_PREMARKET_GAP_ANALYSIS.md §5): records a real, graded shadow prediction
 * the FIRST time a plan's thesis survives revalidation into VALID - via the SAME existing
 * recordPrediction() pipeline (ModelPerformanceTracker.ts) DiscoveryOutcomeTracker already uses,
 * never a new grading system. This is explicitly NOT the TRADE_IDEA_GENERATED wiring
 * TradePlanBuilder.ts's own header describes as "a SEPARATE, deliberately NOT-yet-made decision" -
 * it never calls emitTradeIdea, never touches ChiefTrader/RiskEngine/OMS, and has zero effect on
 * the live trading pipeline. Its only purpose is to start accumulating real, gradeable evidence
 * (via ReflectionEngine's existing prediction-outcome scoring) on whether TradePlan-sourced theses
 * are directionally reliable - the exact evidence gap the gap analysis flagged as missing before
 * any live wiring could be considered.
 */
async function recordTradePlanShadowPrediction(planId: string, context: TradePlanShadowContext): Promise<void> {
  try {
    const { recordPrediction } = await import('../services/ModelPerformanceTracker');
    await recordPrediction({
      agentName: 'TradePlanShadowTracker',
      symbol: context.symbol,
      side: context.direction,
      confidence: context.confidence,
      reasoning: `Shadow-mode prediction: TradePlan ${planId} reached VALID (survived revalidation) - was this thesis directionally useful in hindsight? Never emitted as a live trade idea.`,
    });
  } catch (e) {
    console.error('[TradePlanBuilder] Shadow-tracking prediction failed (does not affect the real revalidation)', e);
  }
}

export async function persistRevalidation(
  planId: string,
  outcome: RevalidationOutcome,
  now: Date = new Date(),
  /** Optional (default undefined - no shadow prediction recorded, identical behavior to before
   *  this parameter existed). SnapshotScanner.ts's REGULAR-session revalidation loop supplies
   *  `previousStatus` (the plan row it already fetched) and `shadowContext` (symbol/direction/
   *  confidence, also already in scope) so this function never needs a second DB read. */
  previousStatus?: TradePlanStatus,
  shadowContext?: TradePlanShadowContext,
): Promise<void> {
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

    if (newStatus === 'VALID' && previousStatus !== 'VALID' && shadowContext) {
      await recordTradePlanShadowPrediction(planId, shadowContext);
    }
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
