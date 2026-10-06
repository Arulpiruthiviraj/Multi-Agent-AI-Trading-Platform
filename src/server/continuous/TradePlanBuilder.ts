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
 *   never CHIEF_APPROVED_IDEA, never a placeOrder call from this file. Off by default
 *   (`ARGUS_TRADE_PLAN_IDEAS_ENABLED`) for any deployment that has not made the same explicit
 *   choice. `recordTradePlanShadowPrediction()` below is unaffected and keeps running regardless -
 *   the evidence-gathering mechanism still exists even though this deployment chose not to wait
 *   for it.
 * - Every numeric field (entry zone, invalidation level) is derived from real fields the ranking
 *   cycle already fetched (last price, minuteHigh/Low, prevClose) - never a fabricated indicator
 *   (no ATR, no synthetic volatility estimate) that this deployment cannot honestly compute yet.
 */
import { createHash, randomUUID } from 'node:crypto';
import { tradingWallTimeToIso, TRADING_TIMEZONE } from '../core/TradingCalendar';
import { db } from '../db';
import { tradePlans, tradePlanRevisions, tradePlanRevalidations } from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import type { RankedCandidate, RankingInput, NewsCatalystDetail } from './ComposableRanking';
import { eventBus } from '../core/EventBus';
import { generateTraceId } from '../core/traceId';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { continuousIntelligence, isTradePlanIdeasEnabled } from '../config/continuousIntelligence';
import { marketDataWorker } from '../services/MarketDataWorker';
import { classifyMarketSession, minutesInTimezone } from '../replay/marketSession';
import {
  scorePremarketCandidate,
  type PremarketCandidateInput,
  type PremarketScoreBreakdown,
} from '../premarket/PremarketOpportunityScore';
import {
  requestDataReservation,
  releaseReservationsForPlan,
  sweepExpiredReservations,
  type DataRescuePort,
} from '../premarket/PremarketDataReservation';
import {
  emitPremarketRefreshStarted,
  emitPremarketRefreshCompleted,
  emitTradePlanRefreshed,
  emitTradePlanExpired,
} from '../premarket/premarketRefreshEvents';

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
   *  docs/architecture/ARGUS_ARCHITECTURE.md (Premarket / Session-Aware Trading Architecture section) §5.1's finding that this file previously
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
  /** F08 (2026-09-27): validUntil is computed through TradingCalendar.ts's canonical
   *  timezone/DST-correct wall-time-to-instant conversion (tradingWallTimeToIso) - no remaining
   *  hardcoded UTC offset. It still always assumes a regular 16:00 ET close: this codebase has no
   *  real NYSE holiday/early-close calendar anywhere (verified - see endOfTradingDayIso()'s doc
   *  comment), so a genuine early-close or holiday session cannot be detected or honestly
   *  represented as a different close time. Rather than silently asserting a verified 16:00 close
   *  on a day this code cannot check, that assumption is labeled explicitly. Always
   *  'ASSUMED_REGULAR_CLOSE_NO_EXCHANGE_CALENDAR' until a real exchange-calendar data source is
   *  wired in (tracked as a follow-up, not fabricated here). */
  validUntilConfidence: 'ASSUMED_REGULAR_CLOSE_NO_EXCHANGE_CALENDAR';
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

/** End of the trading day the plan is FOR (planDate), 16:00 ET, expressed as an ISO instant, via
 *  TradingCalendar.ts's canonical DST-correct wall-time conversion (tradingWallTimeToIso) - not a
 *  hardcoded UTC offset. F08 residual gap (honest, not fabricated): this always assumes a REGULAR
 *  session close. No file in this codebase carries a real NYSE holiday/early-close table (checked:
 *  TradingCalendar.ts, classifyMarketSession()/SessionLifecycle.ts, replaySafety.json - all
 *  documented as holiday-blind), so an actual 13:00 ET early close or a full holiday cannot be
 *  detected here. See TradePlanDraft.validUntilConfidence, which always reads
 *  'ASSUMED_REGULAR_CLOSE_NO_EXCHANGE_CALENDAR' for exactly this reason - never silently claimed
 *  as a verified close on a day this code cannot check. */
function endOfTradingDayIso(planDate: string): string {
  return tradingWallTimeToIso(planDate, '16:00');
}

/**
 * The decision-relevant field set of one trade plan, computed from a single ranking cycle's
 * evidence. Shared by buildTradePlanDrafts() (04:00 creation) and the late pre-market refresh
 * below (workstream B, 2026-10-06) so "recompute from current morning evidence" can never drift
 * from "build from the ranking cycle" — one function, two call sites. Returns null when the
 * candidate is not plan-eligible at all (REJECT, or ranked out of every tier).
 */
export interface RefreshedPlanFields {
  setupType: SetupType;
  direction: 'BUY' | 'SELL';
  thesis: string;
  catalysts: string[];
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  invalidationLevel: number | null;
  targetConcept: string;
  confidence: number;
  confluenceScore: number;
  catalystType: string | null;
  catalystSourceCount: number | null;
  evidenceQuality: number;
  rankAtCreation: number;
  componentScoresJson: string;
}

export function computePlanFields(
  candidate: RankedCandidate,
  input: RankingInput,
  thresholds: TradePlanThresholds = DEFAULT_TRADE_PLAN_THRESHOLDS,
  /** Optional, caller-supplied (e.g. ComposableRanking.fetchNewsCatalystDetails()) - default empty
   *  map means catalystType/catalystSourceCount stay null. */
  catalystDetailsBySymbol: Map<string, NewsCatalystDetail> = new Map(),
): RefreshedPlanFields | null {
  const setupType = classifySetupType(candidate.rank, candidate.promotionRecommendation, thresholds);
  if (!setupType) return null;

  const direction: 'BUY' | 'SELL' = input.rawMomentumPct >= 0 ? 'BUY' : 'SELL';
  const { low, high } = deriveEntryZone(input);
  const invalidationLevel = deriveInvalidationLevel(input, direction);
  const catalysts: string[] = [];
  if (candidate.components.newsCatalyst.available) catalysts.push(`News catalyst (score ${candidate.components.newsCatalyst.score!.toFixed(2)})`);
  if (candidate.components.gap.available && candidate.components.gap.score! > 0.3) catalysts.push('Gap behavior');
  const catalystDetail = catalystDetailsBySymbol.get(candidate.symbol) ?? null;

  return {
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
  };
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
    const input = inputsBySymbol.get(candidate.symbol);
    if (!input) continue;
    const fields = computePlanFields(candidate, input, thresholds, catalystDetailsBySymbol);
    if (!fields) continue;

    drafts.push({
      id: randomUUID(),
      symbol: candidate.symbol,
      planDate,
      ...fields,
      status: 'READY',
      createdAt,
      validUntil,
      validUntilConfidence: 'ASSUMED_REGULAR_CLOSE_NO_EXCHANGE_CALENDAR',
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
  /** Real post-implementation audit finding (2026-09-05): RiskEngine's gate 13 (data_freshness)
   *  checks MarketDataWorker's own live WEBSOCKET tick cache (getLatestPriceAgeMs), which is a
   *  DIFFERENT data source than the REST snapshot ComposableRanking/TradePlanBuilder score from -
   *  a PRIMARY-tier symbol outside the ~12-slot active subscription pool has a null tick age and
   *  WILL fail gate 13 regardless of this idea's own (real, not fabricated) currentPrice. True only
   *  when this call actually requested a rescue subscription for the symbol - never a guarantee
   *  gate 13 passes (a rescue grants a subscription, not an instant tick), but a real, honest
   *  improvement over emitting into a symbol nobody ever asked MarketDataWorker to track. */
  rescueRequested: boolean;
}

/**
 * 2026-09-05, explicit operator authorization - see this file's own header. Emits exactly ONE
 * TRADE_IDEA_GENERATED per PRIMARY-tier plan (never BACKUP/WATCHLIST - a deliberately conservative
 * scope given zero prior track record; the operator can widen this later). This is one independent
 * vote into the existing ChiefTraderAgent consensus (same 0.75 bar, same min-2-independent-agents
 * floor as every other agent) - never a bypass, never CHIEF_APPROVED_IDEA, never a placeOrder call
 * from this module. Gated behind THREE independent checks, matching OpportunityScreener.ts's own
 * pattern exactly: the master flag (isTradePlanIdeasEnabled), the Autobot/session-recovery/
 * campaign-lock composite gate (isLiveIdeaGenerationEnabled), and the per-agent Mission Control
 * toggle (isPipelineAgentEnabled) - any one of the three being off means zero ideas emitted.
 */
export function emitTradePlanIdea(draft: TradePlanDraft, currentPrice: number | null): TradePlanIdeaResult {
  if (draft.setupType !== 'PRIMARY') {
    return { emitted: false, reason: 'NOT_PRIMARY_TIER', symbol: draft.symbol, rescueRequested: false };
  }
  if (!isTradePlanIdeasEnabled()) {
    return { emitted: false, reason: 'FLAG_OFF', symbol: draft.symbol, rescueRequested: false };
  }
  if (!isPipelineAgentEnabled('TradePlanBuilder')) {
    return { emitted: false, reason: 'AGENT_DISABLED', symbol: draft.symbol, rescueRequested: false };
  }
  if (!isLiveIdeaGenerationEnabled()) {
    return { emitted: false, reason: 'IDEA_GENERATION_GATED', symbol: draft.symbol, rescueRequested: false };
  }
  if (currentPrice == null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { emitted: false, reason: 'INVALID_PRICE', symbol: draft.symbol, rescueRequested: false };
  }

  // Real post-implementation audit finding (2026-09-05): RiskEngine gate 13 (data_freshness)
  // checks MarketDataWorker's own live tick cache, a DIFFERENT data source than the REST snapshot
  // this idea's currentPrice came from - a PRIMARY-tier symbol outside the active ~12-slot
  // subscription pool has a null tick age and fails gate 13 regardless of anything here. Requesting
  // a rescue (the SAME bounded mechanism OpportunityDiscovery already uses for this exact problem)
  // gives the symbol a real chance to start ticking before ChiefTrader's async debate concludes -
  // not a guarantee (a rescue grants a subscription, not an instant tick), but a real, honest
  // improvement over emitting into a symbol nobody ever asked MarketDataWorker to track.
  const rescue = marketDataWorker.requestTemporaryDataRescue(draft.symbol, 'premarket_trade_plan_idea', { requestClass: 'EXPLORATION' });

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
  return { emitted: true, reason: 'EMITTED', symbol: draft.symbol, rescueRequested: rescue.granted };
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
 * docs/architecture/ARGUS_ARCHITECTURE.md (Premarket / Session-Aware Trading Architecture section) §5): records a real, graded shadow prediction
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

// ─────────────────────────────────────────────────────────────────────────────
// Workstream B (2026-10-06): late pre-market refresh + TradePlan versioning/expiry.
//
// A 04:00 plan (refreshVersion 1) must not stay authoritative at 09:29 merely because it exists.
// SnapshotScanner's PRE_MARKET tick calls maybeRunLatePremarketRefresh() once per trading date
// inside the configured ET window (~09:00-09:15). For each plan the refresh snapshots the PRIOR
// version into trade_plan_revisions (immutable, with a delta summary), then recomputes from
// current morning evidence via the SAME computePlanFields() the 04:00 build uses — never a
// second, divergent field computation. scorePremarketCandidate() is attempted inside try/catch
// (workstream D owns the real scorer; the current stub throws) — on throw the refresh falls back
// to the existing ranking path and an unchanged plan is marked UNCHANGED_NO_NEW_EVIDENCE.
//
// No-churn rule: recomputation is compared against a canonical snapshot hash of the plan's
// decision-relevant fields; when nothing material changed, NO revision row is written and the
// version is NOT bumped. Expiry (stale catalyst, invalidation hit, no fresh evidence) downgrades
// or expires the plan — an expired catalyst never remains PRIMARY — and releases its data
// reservation. Surviving PRIMARY plans receive a bounded pre-open data reservation
// (PremarketDataReservation.ts); the reservation phase never affects the plan writes above.
//
// Governance: diagnostic/planning only. This section never emits TRADE_IDEA_GENERATED, never
// imports OMS/RiskEngine/ChiefTraderAgent/the order-placement broker layer.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanRefreshKind = 'UNCHANGED' | 'REFRESHED' | 'EXPIRED' | 'SKIPPED';

/** Refresh reason codes. UNCHANGED_NO_NEW_EVIDENCE is also the fallback mark when the pre-market
 *  scorer is unavailable (stub throws) and recomputation yields no material change. */
export type PlanRefreshReason =
  | 'UNCHANGED_NO_NEW_EVIDENCE'
  | 'NEW_MORNING_EVIDENCE'
  | 'TIER_PROMOTED'
  | 'TIER_DEMOTED'
  | 'CATALYST_STALE'
  | 'INVALIDATION_LEVEL_HIT'
  | 'NO_FRESH_EVIDENCE'
  | 'RANKING_REJECTS_THESIS'
  | 'FELL_OUT_OF_PLAN_TIERS'
  | 'VALID_UNTIL_PASSED'
  | 'STATUS_NOT_REFRESHABLE'
  | 'PROCESSING_ERROR';

export interface PlanFieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface PlanDeltaSummary {
  changedFields: PlanFieldChange[];
  tierChanged: { from: SetupType; to: SetupType } | null;
}

export interface PlanRefreshOutcome {
  planId: string;
  symbol: string;
  kind: PlanRefreshKind;
  reason: PlanRefreshReason;
  previousRefreshVersion: number;
  newRefreshVersion: number;
  deltaSummary: PlanDeltaSummary | null;
  postRefreshSetupType: SetupType;
  postRefreshStatus: TradePlanStatus;
}

export interface LateRefreshInput {
  planDate: string;
  now: Date;
  rankedCandidates: RankedCandidate[];
  inputsBySymbol: Map<string, RankingInput>;
  /** Test-only injection for the reservation phase's rescue call; production omits it. */
  rescuePort?: DataRescuePort;
}

export interface LateRefreshSummary {
  ran: boolean;
  reason: string;
  tradingDate: string;
  refreshedAt: string;
  outcomes: PlanRefreshOutcome[];
}

type TradePlanRow = typeof tradePlans.$inferSelect;

/** In-memory once-per-date guard: complements the refreshVersion>=2 DB check in
 *  maybeRunLatePremarketRefresh(). Process-local by design — a restart re-derives from the DB. */
const lateRefreshRunDates = new Set<string>();

/** Test-only: clear the in-memory once-per-date guard. */
export function resetLateRefreshGuardForTests(): void {
  lateRefreshRunDates.clear();
}

function refreshHhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Canonical, decision-relevant snapshot of a plan for the no-churn hash comparison. Deliberately
 *  excludes componentScoresJson (raw component dump — confidence/confluence/evidenceQuality and
 *  the catalysts array already carry its decision-relevant substance; including the raw dump
 *  would churn on serialization noise) and all lifecycle/metadata columns (status, timestamps,
 *  version counters are versioning metadata, not plan substance). */
interface CanonicalPlanSnapshot {
  setupType: string;
  direction: string;
  thesis: string;
  catalysts: string[];
  entryZoneLow: number | null;
  entryZoneHigh: number | null;
  invalidationLevel: number | null;
  targetConcept: string;
  confidence: number;
  confluenceScore: number;
  catalystType: string | null;
  catalystSourceCount: number | null;
  evidenceQuality: number;
  rankAtCreation: number;
  scoreDecompositionJson: string | null;
}

function round6(n: number | null): number | null {
  return n == null || !Number.isFinite(n) ? n : Math.round(n * 1e6) / 1e6;
}

function parseCatalysts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').sort() : [];
  } catch {
    return [];
  }
}

function snapshotFromRow(plan: TradePlanRow): CanonicalPlanSnapshot {
  return {
    setupType: plan.setupType,
    direction: plan.direction,
    thesis: plan.thesis,
    catalysts: parseCatalysts(plan.catalysts),
    entryZoneLow: round6(plan.entryZoneLow),
    entryZoneHigh: round6(plan.entryZoneHigh),
    invalidationLevel: round6(plan.invalidationLevel),
    targetConcept: plan.targetConcept ?? '',
    confidence: round6(plan.confidence) ?? 0,
    confluenceScore: round6(plan.confluenceScore) ?? 0,
    catalystType: plan.catalystType,
    catalystSourceCount: plan.catalystSourceCount,
    evidenceQuality: round6(plan.evidenceQuality) ?? 0,
    rankAtCreation: plan.rankAtCreation ?? 0,
    scoreDecompositionJson: plan.scoreDecompositionJson,
  };
}

function snapshotFromRecomputed(fields: RefreshedPlanFields, scoreDecompositionJson: string | null): CanonicalPlanSnapshot {
  return {
    setupType: fields.setupType,
    direction: fields.direction,
    thesis: fields.thesis,
    catalysts: [...fields.catalysts].sort(),
    entryZoneLow: round6(fields.entryZoneLow),
    entryZoneHigh: round6(fields.entryZoneHigh),
    invalidationLevel: round6(fields.invalidationLevel),
    targetConcept: fields.targetConcept,
    confidence: round6(fields.confidence) ?? 0,
    confluenceScore: round6(fields.confluenceScore) ?? 0,
    catalystType: fields.catalystType,
    catalystSourceCount: fields.catalystSourceCount,
    evidenceQuality: round6(fields.evidenceQuality) ?? 0,
    rankAtCreation: fields.rankAtCreation,
    scoreDecompositionJson,
  };
}

/** Fixed key order (interface declaration order) + rounded numbers => deterministic hash input. */
function snapshotHash(snapshot: CanonicalPlanSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function canonicalSnapshotJson(snapshot: CanonicalPlanSnapshot): string {
  return JSON.stringify(snapshot);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffSnapshots(prior: CanonicalPlanSnapshot, next: CanonicalPlanSnapshot): PlanDeltaSummary {
  const changedFields: PlanFieldChange[] = [];
  const keys: Array<keyof CanonicalPlanSnapshot> = [
    'setupType', 'direction', 'thesis', 'catalysts', 'entryZoneLow', 'entryZoneHigh',
    'invalidationLevel', 'targetConcept', 'confidence', 'confluenceScore', 'catalystType',
    'catalystSourceCount', 'evidenceQuality', 'rankAtCreation', 'scoreDecompositionJson',
  ];
  for (const key of keys) {
    if (!valuesEqual(prior[key], next[key])) {
      changedFields.push({ field: key, from: prior[key], to: next[key] });
    }
  }
  const tierChanged = prior.setupType !== next.setupType
    ? { from: prior.setupType as SetupType, to: next.setupType as SetupType }
    : null;
  return { changedFields, tierChanged };
}

function tierRank(tier: SetupType): number {
  return tier === 'PRIMARY' ? 3 : tier === 'BACKUP' ? 2 : 1;
}

/** A plan is catalyst-backed when its 04:00 evidence recorded a news catalyst — either as a
 *  catalysts[] entry or as structured catalyst metadata. */
function planHasCatalyst(plan: TradePlanRow): boolean {
  return parseCatalysts(plan.catalysts).some((c) => c.startsWith('News catalyst')) || plan.catalystType != null;
}

/** Honest mapping from the ranking cycle's evidence to the pre-market scorer's contract. Fields
 *  the ranking cycle does not carry (FinBERT sentiment/recency, 20d ADV, spread, sector/market
 *  relative strength, strategy applicability) are left undefined/null — never fabricated. The
 *  scorer's own contract scores missing inputs 0 and lists them in inputsMissing. */
function toPremarketCandidateInput(
  symbol: string,
  input: RankingInput,
  candidate: RankedCandidate,
): PremarketCandidateInput {
  return {
    symbol,
    overnightGapPct: input.prevClose > 0 && input.open != null
      ? ((input.open - input.prevClose) / input.prevClose) * 100
      : undefined,
    preMarketPctChange: input.rawMomentumPct,
    catalyst: null,
    dollarVolume: input.dailyVolume != null && input.last > 0 ? input.dailyVolume * input.last : undefined,
    advShares: undefined,
    spreadBps: null,
    sectorRelativeStrength: undefined,
    marketRelativeStrength: undefined,
    strategyApplicability: undefined,
    dataFresh: input.last > 0,
  };
}

const REFRESHABLE_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'READY', 'VALID', 'REVALIDATING']);

async function expirePlan(
  plan: TradePlanRow,
  reason: PlanRefreshReason,
  now: Date,
): Promise<PlanRefreshOutcome> {
  const nowIso = now.toISOString();
  const priorVersion = plan.refreshVersion ?? 1;
  const newVersion = priorVersion + 1;
  const delta: PlanDeltaSummary = {
    changedFields: [{ field: 'status', from: plan.status, to: 'EXPIRED' }],
    tierChanged: null,
  };
  // Immutable prior-version snapshot first — the revision row must exist before the mutation.
  await db.insert(tradePlanRevisions).values({
    id: randomUUID(),
    planId: plan.id,
    originalPlanId: plan.id,
    planDate: plan.planDate,
    symbol: plan.symbol,
    refreshVersion: priorVersion,
    snapshotJson: canonicalSnapshotJson(snapshotFromRow(plan)),
    deltaSummaryJson: JSON.stringify(delta),
    reasonForRefresh: reason,
    createdAt: nowIso,
  });
  await db.update(tradePlans).set({
    status: 'EXPIRED',
    refreshVersion: newVersion,
    refreshedAt: nowIso,
    reasonForRefresh: reason,
    originalCreatedAt: plan.originalCreatedAt ?? plan.createdAt,
  }).where(eq(tradePlans.id, plan.id));
  // Plan expiry releases any pre-open data reservation (release contract).
  await releaseReservationsForPlan(plan.id, 'PLAN_EXPIRED', now);
  emitTradePlanExpired({
    planId: plan.id,
    symbol: plan.symbol,
    tradingDate: plan.planDate,
    reason,
    refreshVersion: newVersion,
    at: nowIso,
  });
  return {
    planId: plan.id,
    symbol: plan.symbol,
    kind: 'EXPIRED',
    reason,
    previousRefreshVersion: priorVersion,
    newRefreshVersion: newVersion,
    deltaSummary: delta,
    postRefreshSetupType: plan.setupType as SetupType,
    postRefreshStatus: 'EXPIRED',
  };
}

async function refreshOnePlan(
  plan: TradePlanRow,
  rankedBySymbol: Map<string, RankedCandidate>,
  inputsBySymbol: Map<string, RankingInput>,
  now: Date,
): Promise<PlanRefreshOutcome> {
  const nowIso = now.toISOString();
  const priorVersion = plan.refreshVersion ?? 1;
  const skipped = (reason: PlanRefreshReason): PlanRefreshOutcome => ({
    planId: plan.id,
    symbol: plan.symbol,
    kind: 'SKIPPED',
    reason,
    previousRefreshVersion: priorVersion,
    newRefreshVersion: priorVersion,
    deltaSummary: null,
    postRefreshSetupType: plan.setupType as SetupType,
    postRefreshStatus: plan.status as TradePlanStatus,
  });

  if (!REFRESHABLE_STATUSES.has(plan.status)) return skipped('STATUS_NOT_REFRESHABLE');
  if (nowIso > plan.validUntil) return expirePlan(plan, 'VALID_UNTIL_PASSED', now);

  const input = inputsBySymbol.get(plan.symbol) ?? null;
  const candidate = rankedBySymbol.get(plan.symbol) ?? null;
  // No current market data or no current ranking for the symbol: the thesis cannot be
  // reconfirmed from morning evidence — expire, never silently keep VALID (fail closed, same
  // stance as revalidateTradePlan's no-data invalidation).
  if (!input || !candidate) return expirePlan(plan, 'NO_FRESH_EVIDENCE', now);

  // Invalidation first: a broken level ends the thesis regardless of what the ranking says.
  if (plan.invalidationLevel != null) {
    const broke = plan.direction === 'BUY'
      ? input.last < plan.invalidationLevel
      : input.last > plan.invalidationLevel;
    if (broke) return expirePlan(plan, 'INVALIDATION_LEVEL_HIT', now);
  }
  if (candidate.promotionRecommendation === 'REJECT') {
    return expirePlan(plan, 'RANKING_REJECTS_THESIS', now);
  }

  // Pre-market score attempt (workstream D owns the real scorer; the current stub throws).
  // On throw, fall back to the existing ranking path below — an unchanged plan is then marked
  // UNCHANGED_NO_NEW_EVIDENCE rather than refreshed on phantom evidence.
  let breakdown: PremarketScoreBreakdown | null = null;
  try {
    breakdown = scorePremarketCandidate(toPremarketCandidateInput(plan.symbol, input, candidate));
  } catch {
    breakdown = null;
  }
  const scoreDecompositionJson = breakdown ? JSON.stringify(breakdown) : plan.scoreDecompositionJson;

  const fields = computePlanFields(candidate, input, DEFAULT_TRADE_PLAN_THRESHOLDS, new Map());
  if (!fields) {
    // Rank fell out of every plan tier — morning evidence no longer supports any setup.
    return expirePlan(plan, 'FELL_OUT_OF_PLAN_TIERS', now);
  }
  // Preserve previously-recorded catalyst metadata: the refresh performs no catalyst-detail
  // fetch (same no-new-network-calls constraint as the 04:00 build), so dropping it would be
  // data loss rather than new evidence. Catalyst STALENESS is still detected below via the
  // newsCatalyst component's current availability.
  if (fields.catalystType == null) {
    fields.catalystType = plan.catalystType;
    fields.catalystSourceCount = plan.catalystSourceCount;
  }

  let catalystStale = false;
  if (planHasCatalyst(plan) && !candidate.components.newsCatalyst.available) {
    catalystStale = true;
    // An expired catalyst must not remain PRIMARY.
    if (fields.setupType === 'PRIMARY') fields.setupType = 'BACKUP';
  }

  const priorSnap = snapshotFromRow(plan);
  const nextSnap = snapshotFromRecomputed(fields, scoreDecompositionJson);
  if (snapshotHash(priorSnap) === snapshotHash(nextSnap)) {
    return {
      planId: plan.id,
      symbol: plan.symbol,
      kind: 'UNCHANGED',
      reason: 'UNCHANGED_NO_NEW_EVIDENCE',
      previousRefreshVersion: priorVersion,
      newRefreshVersion: priorVersion,
      deltaSummary: null,
      postRefreshSetupType: plan.setupType as SetupType,
      postRefreshStatus: plan.status as TradePlanStatus,
    };
  }

  const delta = diffSnapshots(priorSnap, nextSnap);
  const newVersion = priorVersion + 1;
  const reason: PlanRefreshReason = delta.tierChanged
    ? (tierRank(delta.tierChanged.to) > tierRank(delta.tierChanged.from) ? 'TIER_PROMOTED' : 'TIER_DEMOTED')
    : catalystStale ? 'CATALYST_STALE' : 'NEW_MORNING_EVIDENCE';

  await db.insert(tradePlanRevisions).values({
    id: randomUUID(),
    planId: plan.id,
    originalPlanId: plan.id,
    planDate: plan.planDate,
    symbol: plan.symbol,
    refreshVersion: priorVersion,
    snapshotJson: canonicalSnapshotJson(priorSnap),
    deltaSummaryJson: JSON.stringify(delta),
    reasonForRefresh: reason,
    createdAt: nowIso,
  });
  await db.update(tradePlans).set({
    setupType: fields.setupType,
    direction: fields.direction,
    thesis: fields.thesis,
    catalysts: JSON.stringify(fields.catalysts),
    entryZoneLow: fields.entryZoneLow,
    entryZoneHigh: fields.entryZoneHigh,
    invalidationLevel: fields.invalidationLevel,
    targetConcept: fields.targetConcept,
    confidence: fields.confidence,
    confluenceScore: fields.confluenceScore,
    catalystType: fields.catalystType,
    catalystSourceCount: fields.catalystSourceCount,
    evidenceQuality: fields.evidenceQuality,
    rankAtCreation: fields.rankAtCreation,
    componentScoresJson: fields.componentScoresJson,
    refreshVersion: newVersion,
    refreshedAt: nowIso,
    reasonForRefresh: reason,
    originalCreatedAt: plan.originalCreatedAt ?? plan.createdAt,
    scoreDecompositionJson,
  }).where(eq(tradePlans.id, plan.id));

  // Tier drop off PRIMARY releases the pre-open data reservation (release contract).
  if (plan.setupType === 'PRIMARY' && fields.setupType !== 'PRIMARY') {
    await releaseReservationsForPlan(plan.id, 'TIER_DROP', now);
  }

  emitTradePlanRefreshed({
    planId: plan.id,
    symbol: plan.symbol,
    tradingDate: plan.planDate,
    refreshVersion: newVersion,
    refreshedAt: nowIso,
    reasonForRefresh: reason,
    changedFields: delta.changedFields.map((c) => c.field),
    tierChanged: delta.tierChanged,
    at: nowIso,
  });

  return {
    planId: plan.id,
    symbol: plan.symbol,
    kind: 'REFRESHED',
    reason,
    previousRefreshVersion: priorVersion,
    newRefreshVersion: newVersion,
    deltaSummary: delta,
    postRefreshSetupType: fields.setupType,
    postRefreshStatus: plan.status as TradePlanStatus,
  };
}

/**
 * Runs the late pre-market refresh over every refreshable plan for planDate. Exported for tests;
 * production callers go through maybeRunLatePremarketRefresh() (window + once-per-date guards).
 * Emits PREMARKET_REFRESH_STARTED/COMPLETED plus per-plan TRADEPLAN_REFRESHED/TRADEPLAN_EXPIRED.
 * A per-plan failure is isolated (SKIPPED) and never aborts the run; a reservation-phase failure
 * never rolls back already-persisted plan writes.
 */
export async function runLatePremarketRefresh(input: LateRefreshInput): Promise<LateRefreshSummary> {
  const { planDate, now } = input;
  const nowIso = now.toISOString();
  emitPremarketRefreshStarted(planDate, nowIso);

  const plans = await getTradePlansForDate(planDate);
  const rankedBySymbol = new Map(input.rankedCandidates.map((r) => [r.symbol, r]));
  const outcomes: PlanRefreshOutcome[] = [];
  const primarySurvivors: Array<{ planId: string; symbol: string }> = [];

  for (const plan of plans) {
    try {
      const outcome = await refreshOnePlan(plan, rankedBySymbol, input.inputsBySymbol, now);
      outcomes.push(outcome);
      if (
        (outcome.kind === 'REFRESHED' || outcome.kind === 'UNCHANGED') &&
        outcome.postRefreshSetupType === 'PRIMARY' &&
        REFRESHABLE_STATUSES.has(outcome.postRefreshStatus)
      ) {
        primarySurvivors.push({ planId: plan.id, symbol: plan.symbol });
      }
    } catch (e) {
      console.error('[TradePlanBuilder] late pre-market refresh failed for plan', plan.id, e);
      outcomes.push({
        planId: plan.id,
        symbol: plan.symbol,
        kind: 'SKIPPED',
        reason: 'PROCESSING_ERROR',
        previousRefreshVersion: plan.refreshVersion ?? 1,
        newRefreshVersion: plan.refreshVersion ?? 1,
        deltaSummary: null,
        postRefreshSetupType: plan.setupType as SetupType,
        postRefreshStatus: plan.status as TradePlanStatus,
      });
    }
  }

  // Reservation phase: sweep expired first (honest capacity accounting), then request one bounded
  // reservation per surviving PRIMARY plan. PRIMARY-only by policy: the pool is sized for the
  // PRIMARY tier (3 plans <= 4 slots); BACKUP promotion at the open uses the normal discovery
  // and rescue paths. A failure here never rolls back the plan writes above.
  try {
    await sweepExpiredReservations(now);
    for (const survivor of primarySurvivors) {
      await requestDataReservation(
        survivor.symbol,
        survivor.planId,
        'PRIMARY',
        'late_premarket_refresh',
        continuousIntelligence.premarketReservationTtlMinutes,
        { now, rescuePort: input.rescuePort },
      );
    }
  } catch (e) {
    console.error('[TradePlanBuilder] late-refresh reservation phase failed (plan writes stand)', e);
  }

  const maxVersion = outcomes.reduce((m, o) => Math.max(m, o.newRefreshVersion), 1);
  emitPremarketRefreshCompleted({
    tradingDate: planDate,
    refreshVersion: maxVersion,
    refreshedAt: nowIso,
    planCount: plans.length,
    refreshedCount: outcomes.filter((o) => o.kind === 'REFRESHED').length,
    unchangedCount: outcomes.filter((o) => o.kind === 'UNCHANGED').length,
    expiredCount: outcomes.filter((o) => o.kind === 'EXPIRED').length,
    skippedCount: outcomes.filter((o) => o.kind === 'SKIPPED').length,
    at: nowIso,
  });

  return { ran: true, reason: 'COMPLETED', tradingDate: planDate, refreshedAt: nowIso, outcomes };
}

function refreshNotRun(reason: string, tradingDate: string, at: string): LateRefreshSummary {
  return { ran: false, reason, tradingDate, refreshedAt: at, outcomes: [] };
}

/**
 * Late-refresh trigger for SnapshotScanner's PRE_MARKET tick. Runs the refresh at most once per
 * trading date, and only while ET wall time (minutesInTimezone — DST-correct, never a hardcoded
 * offset) is inside the configured window. The once-per-date guarantee is best-effort across
 * restarts: refreshVersion>=2 on any of the date's plans means a previous run already versioned
 * the date (a refresh that changed anything always bumps at least one plan). An UNCHANGED-only
 * run bumps nothing, so a redundant re-run after a restart is write-free by the no-churn rule.
 * Never throws: every guard failure returns ran:false.
 */
export async function maybeRunLatePremarketRefresh(input: LateRefreshInput): Promise<LateRefreshSummary> {
  const { planDate, now } = input;
  const nowIso = now.toISOString();
  try {
    // Defensive: the call site already sits inside the PRE_MARKET branch, but this function is
    // exported and must enforce its own preconditions.
    if (classifyMarketSession(now.getTime(), TRADING_TIMEZONE, true) !== 'PRE_MARKET') {
      return refreshNotRun('NOT_PRE_MARKET', planDate, nowIso);
    }
    const mins = minutesInTimezone(now.getTime(), TRADING_TIMEZONE);
    const windowStart = refreshHhmmToMinutes(continuousIntelligence.premarketRefreshWindowStart);
    const windowEnd = refreshHhmmToMinutes(continuousIntelligence.premarketRefreshWindowEnd);
    if (mins < windowStart || mins >= windowEnd) {
      return refreshNotRun('OUTSIDE_REFRESH_WINDOW', planDate, nowIso);
    }
    if (lateRefreshRunDates.has(planDate)) {
      return refreshNotRun('ALREADY_REFRESHED_THIS_PROCESS', planDate, nowIso);
    }
    const plans = await getTradePlansForDate(planDate);
    if (plans.length === 0) {
      return refreshNotRun('NO_PLANS_TO_REFRESH', planDate, nowIso);
    }
    if (plans.some((p) => (p.refreshVersion ?? 1) >= 2)) {
      lateRefreshRunDates.add(planDate);
      return refreshNotRun('ALREADY_REFRESHED', planDate, nowIso);
    }
    if (input.rankedCandidates.length === 0) {
      // No morning evidence at all — fail closed: leave the 04:00 plans untouched rather than
      // expiring everything on a data outage. Retried on the next tick (guard not set).
      return refreshNotRun('NO_RANKING_EVIDENCE', planDate, nowIso);
    }
    const summary = await runLatePremarketRefresh(input);
    lateRefreshRunDates.add(planDate);
    return summary;
  } catch (e) {
    console.error('[TradePlanBuilder] maybeRunLatePremarketRefresh failed (scan continues)', e);
    return refreshNotRun('TRIGGER_ERROR', planDate, nowIso);
  }
}
