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
import { getTradingDateStr, tradingWallTimeToIso, TRADING_TIMEZONE } from '../core/TradingCalendar';
import { db } from '../db';
import { tradePlans, tradePlanRevisions, tradePlanRevalidations } from '../db/schema';
import { desc, eq, lt } from 'drizzle-orm';
import type { RankedCandidate, RankingInput, NewsCatalystDetail } from './ComposableRanking';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
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
  releaseAllActiveReservations,
  getActiveReservations,
  sweepExpiredReservations,
  resetManagerDbQueryCount,
  getManagerDbQueryCount,
  type DataRescuePort,
} from '../premarket/PremarketDataReservation';
import {
  emitPremarketPlanBuildStarted,
  emitPremarketPlanBuildCompleted,
  emitTradePlanVersionCreated,
  emitTradePlanUnchanged,
  emitTradePlanPromoted,
  emitTradePlanDowngraded,
  emitTradePlanExpired,
  emitPreopenRevalidationStarted,
  emitPreopenRevalidationCompleted,
  emitPremarketPlanHandedToRth,
} from '../premarket/premarketRefreshEvents';
import { emitPremarketRefreshCompleted } from '../premarket/premarketFocusEvents';

// 2026-10-09 defect hunt: TRADE_PLAN_REVALIDATION_RETENTION_DAYS and
// pruneTradePlanRevalidations() live in ./tradePlanRevalidationRetention (re-exported below).
// They were moved out of this module because the retention sweep's lazy dynamic import can
// resolve while this module is still mid-evaluation (import cycle), which threw a TDZ
// "Cannot access before initialization" on the const. The leaf module cannot cycle.
export { TRADE_PLAN_REVALIDATION_RETENTION_DAYS, pruneTradePlanRevalidations } from './tradePlanRevalidationRetention';

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
  // 2026-10-07 Discovery-D4: when relative volume is unavailable, input.rawRelativeVolume is the
  // documented 0-placeholder - rendering it as "0.00x" fabricates a measured zero in the persisted
  // thesis. Render the honest unavailable marker instead (the same PREMARKET_RVOL_UNAVAILABLE
  // marker PremarketFocusReport.formatPremarketRvol() already uses at its display boundary).
  // Display-only, forward-looking: already-persisted thesis rows are untouched.
  parts.push(c.relativeVolume.available
    ? `Relative volume ${input.rawRelativeVolume.toFixed(2)}x (score ${c.relativeVolume.score!.toFixed(2)}).`
    : `Relative volume PREMARKET_RVOL_UNAVAILABLE (score N/A).`);
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

export interface PersistTradePlanMeta {
  /** ISO timestamp of the newest evidence incorporated (never a fabricated 04:00 label). */
  evidenceAsof?: string;
  /** Market session at build (e.g. 'PRE_MARKET'). */
  sessionPhase?: string;
  /** Lifecycle reason, e.g. 'INITIAL_BUILD'. */
  reasonForRefresh?: string;
}

export async function persistTradePlanDrafts(drafts: TradePlanDraft[], meta: PersistTradePlanMeta = {}): Promise<void> {
  if (drafts.length === 0) return;
  try {
    await db.insert(tradePlans).values(drafts.map((d) => ({
      ...d,
      catalysts: JSON.stringify(d.catalysts),
      // Initial builds only: the creation time IS the original creation time. Refreshes preserve
      // the existing originalCreatedAt instead (see refreshOnePlan).
      originalCreatedAt: d.createdAt,
      evidenceAsof: meta.evidenceAsof ?? null,
      sessionPhase: meta.sessionPhase ?? null,
      reasonForRefresh: meta.reasonForRefresh ?? null,
    })));
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
    // Phase 3 idea provenance: premarket ranking-driven plans (no LLM), one consensus vote - unchanged behavior.
    origin: 'EXPERIMENTAL',
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
    const newStatus: TradePlanStatus = outcome.result === 'REVALIDATED' ? 'VALID'
      : outcome.result === 'DOWNGRADED' ? 'REVALIDATING'
        : outcome.result === 'EXPIRED' ? 'EXPIRED' : 'INVALIDATED';
    // 2026-10-07 Discovery-D2: the REGULAR-session revalidation loop runs every ~30s RTH, and
    // unconditionally persisting a history row + plan update on every cycle with no decision
    // change was ~2 writes x ~23 plans per 30s - tens of thousands of rows/day with no pruning.
    // Skip both writes when the outcome leaves the plan's status unchanged (SnapshotScanner's
    // loop supplies previousStatus from the plan row it already fetched, so no second DB read).
    // newStatus is derived from outcome.result, so an unchanged status means an unchanged result
    // class. When previousStatus is not supplied (other callers), keep the old unconditional
    // behavior - never silently drop a write.
    if (previousStatus !== undefined && newStatus === previousStatus) return;
    await db.insert(tradePlanRevalidations).values({
      planId,
      revalidatedAt: now.toISOString(),
      result: outcome.result,
      reason: outcome.reason,
      priceAtRevalidation: outcome.priceAtRevalidation,
    });
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
// Workstream B (2026-10-06; course-corrected 2026-10-06): premarket plan lifecycle.
//
// Verified 2026-10-06 ~08:29 ET on the live deployment: TradePlanBuilder ran ONCE at startup
// (08:23) and produced 5 real plans — the defect is NOT "premarket analysis isn't running", it is
// "TradePlan intelligence is a one-time startup snapshot rather than a premarket lifecycle."
// This section makes it a lifecycle:
//
//   INITIAL_BUILD        on PREMARKET_SESSION_STARTED / first PRE_MARKET tick with evidence,
//                        from evidence-as-of the build tick (evidenceAsof=now, sessionPhase=
//                        PRE_MARKET) — a late start NEVER pretends to be a 04:00 plan.
//   MID_MORNING          once after 08:30 ET (captures 08:30 economic releases).
//   LATE_REFRESH         once ~09:00-09:15 ET.
//   PREOPEN_VALIDATION   once ~09:20-09:28 ET (downgrade/expire on invalidation).
//   EVENT_DRIVEN         debounced material refreshes on high-impact NEWS_CATALYST,
//                        MARKET_DATA_GAP_DETECTED, MACRO_ANALYSIS_COMPLETED.
//
// Scheduling: the SnapshotScanner PRE_MARKET tick calls maybeRunScheduledPremarketRefresh() with
// fresh evidence; ALL scheduling state (per-kind once-per-date, debounce, cooldown, pending
// triggers) lives here. NO setTimeout/setInterval anywhere in this file — the existing
// SessionLifecycleManager / SnapshotScanner ticks are the schedulers. Event subscriptions
// (startPremarketPlanLifecycle) only record intent; the tick executes.
//
// Versioning: every refresh snapshots the PRIOR version into trade_plan_revisions (immutable,
// with a delta summary of tier/thesis/levels/entry-zone/invalidation/catalyst changes) before
// mutating, via the SAME computePlanFields() the build uses. scorePremarketCandidate() runs
// inside try/catch (workstream D owns the real scorer; the stub throws) — on throw the refresh
// falls back to the ranking path and an unchanged plan is marked UNCHANGED_NO_NEW_EVIDENCE.
//
// No-churn: recomputation is compared against a canonical snapshot hash of the plan's
// decision-relevant fields; when nothing material changed, NO revision row is written and the
// version is NOT bumped. A refresh that finds nothing material emits TRADE_PLAN_UNCHANGED and
// writes nothing further. Lifecycle is expressed via the EXISTING trade_plans.status values plus
// refreshVersion + reasonForRefresh — no parallel state machine.
//
// Expiry (stale catalyst, invalidation hit, no fresh evidence) downgrades or expires the plan —
// an expired catalyst never remains PRIMARY — and releases its data reservation. Surviving
// PRIMARY plans (except inside the pre-open validation window, where the 09:25 handover cap
// would born-expire new grants) receive a bounded pre-open data reservation.
//
// Open handoff: when the session leaves PREMARKET, PREMARKET_PLAN_HANDED_TO_RTH is emitted and
// every ACTIVE reservation is released. Intraday Fast Lane / discovery subscriptions are never
// touched — only this ledger's rows.
//
// Governance: diagnostic/planning only. This section never emits a trade idea outside the
// existing ARGUS_TRADE_PLAN_IDEAS_ENABLED-gated emitTradePlanIdea() path (unchanged, still OFF by
// default), never imports OMS/RiskEngine/ChiefTraderAgent/the order-placement broker layer.
// ─────────────────────────────────────────────────────────────────────────────

export type PlanRefreshKind = 'UNCHANGED' | 'REFRESHED' | 'EXPIRED' | 'SKIPPED';

/** Lifecycle + outcome reasons. The five lifecycle values plus PROMOTED/DOWNGRADED markers are
 *  what reasonForRefresh carries on live plans; the HIT / NO_FRESH_EVIDENCE / REJECTS / STALE /
 *  FELL_OUT values are expiry/demotion markers; UNCHANGED / STATUS / PROCESSING values are
 *  outcome-only (never persisted — unchanged plans are not written at all). */
export type PlanRefreshReason =
  | 'INITIAL_BUILD'
  | 'MID_MORNING_REFRESH'
  | 'LATE_REFRESH'
  | 'PREOPEN_VALIDATION'
  | 'EVENT_DRIVEN_MATERIAL'
  | 'PROMOTED'
  | 'DOWNGRADED'
  | 'CATALYST_STALE'
  | 'INVALIDATION_LEVEL_HIT'
  | 'NO_FRESH_EVIDENCE'
  | 'RANKING_REJECTS_THESIS'
  | 'FELL_OUT_OF_PLAN_TIERS'
  | 'VALID_UNTIL_PASSED'
  | 'UNCHANGED_NO_NEW_EVIDENCE'
  | 'STATUS_NOT_REFRESHABLE'
  | 'PROCESSING_ERROR';

export type LifecycleRefreshKind = 'MID_MORNING' | 'LATE_REFRESH' | 'PREOPEN_VALIDATION' | 'EVENT_DRIVEN';

const KIND_REASON: Record<LifecycleRefreshKind, PlanRefreshReason> = {
  MID_MORNING: 'MID_MORNING_REFRESH',
  LATE_REFRESH: 'LATE_REFRESH',
  PREOPEN_VALIDATION: 'PREOPEN_VALIDATION',
  EVENT_DRIVEN: 'EVENT_DRIVEN_MATERIAL',
};

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

export interface LifecycleTickInput {
  planDate: string;
  now: Date;
  rankedCandidates: RankedCandidate[];
  inputsBySymbol: Map<string, RankingInput>;
  /** Test-only injection for the reservation phase's rescue call; production omits it. */
  rescuePort?: DataRescuePort;
}

export interface LifecycleTickSummary {
  ran: boolean;
  tradingDate: string;
  at: string;
  actions: Array<{ action: string; kind?: string; detail?: string }>;
}

export interface LifecycleRefreshSummary {
  kind: LifecycleRefreshKind | 'INITIAL_BUILD';
  tradingDate: string;
  refreshedCount: number;
  unchangedCount: number;
  expiredCount: number;
  skippedCount: number;
  newPlans: number;
  outcomes: PlanRefreshOutcome[];
}

/** Perf sample for one build/refresh run. Reported via console + getLastRefreshPerf(). */
export interface RefreshPerfSample {
  kind: string;
  tradingDate: string;
  startedAt: string;
  durationMs: number;
  /** DB queries issued by this run (plan ledger + reservation ledger). Must stay linear in
   *  plans/candidates — the "no unbounded synchronous scans" assertion in tests. */
  dbQueries: number;
  symbolsRanked: number;
  plansProcessed: number;
  plansChanged: number;
  eventLoopLagMsBefore: number;
  eventLoopLagMsAfter: number;
}

/** Workstream D CLI contract — shape is stable, do not change without coordinating. */
export interface PremarketLifecycleStatus {
  tradingDate: string;
  sessionPhase: string;
  lastBuildAt: string | null;
  lastBuildVersion: number;
  evidenceAsof: string | null;
  nextRefreshAt: string | null;
  nextRefreshKind: 'MID_MORNING' | 'LATE_REFRESH' | 'PREOPEN_VALIDATION' | 'EVENT_DRIVEN' | null;
  planCounts: { PRIMARY: number; BACKUP: number; WATCH: number; DOWNGRADED: number; EXPIRED: number };
  oldestPlanAgeMinutes: number | null;
  refreshDue: boolean;
}

type TradePlanRow = typeof tradePlans.$inferSelect;

// ── In-memory lifecycle state (process-local; DB rows are the cross-restart truth) ──
/** Lifecycle kinds completed for a date. Best-effort across restarts: a re-run after a restart
 *  is write-free by the no-churn rule (the plan rows already reflect the evidence), so the
 *  in-memory guard only needs to be exact within a process. */
const completedKindsByDate = new Map<string, Set<string>>();
/** Set by the PREMARKET_SESSION_STARTED handler when no plans exist yet; consumed by the tick. */
let pendingInitialBuild = false;
interface PendingEventTrigger { source: string; symbol: string | null; at: number; }
let pendingEventTriggers: PendingEventTrigger[] = [];
let lastEventDrivenRunAt: number | null = null;
let lifecycleSubscribed = false;
const lifecycleMemoryByDate = new Map<string, { lastRunAt: string; lastRunKind: string }>();
let lastRefreshPerf: RefreshPerfSample | null = null;
/** Safety bound on the pending-trigger list: a bus event storm must not grow it without limit.
 *  Oldest triggers are dropped first; the refresh still runs once. Engineering bound, not an
 *  operational threshold. */
const MAX_PENDING_TRIGGERS = 100;

/** Test-only: reset all in-memory lifecycle state (the subscription itself stays idempotent). */
export function resetPremarketLifecycleForTests(): void {
  completedKindsByDate.clear();
  pendingInitialBuild = false;
  pendingEventTriggers = [];
  lastEventDrivenRunAt = null;
  lifecycleMemoryByDate.clear();
  lastRefreshPerf = null;
  planDbQueries = 0;
  resetManagerDbQueryCount();
}

/** Last measured refresh perf sample (null before the first run). */
export function getLastRefreshPerf(): RefreshPerfSample | null {
  return lastRefreshPerf;
}

// ── Perf instrumentation: DB query counting on this module's refresh/build path ──
let planDbQueries = 0;
function counted<T>(p: Promise<T>): Promise<T> {
  planDbQueries++;
  return p;
}

async function measureEventLoopLagMs(): Promise<number> {
  const start = performance.now();
  await new Promise<void>((resolve) => setImmediate(resolve));
  return performance.now() - start;
}

function recordPerf(sample: RefreshPerfSample): void {
  lastRefreshPerf = sample;
  console.log(
    `[TradePlanLifecycle] refresh kind=${sample.kind} date=${sample.tradingDate} `
    + `durationMs=${sample.durationMs.toFixed(1)} dbQueries=${sample.dbQueries} `
    + `symbolsRanked=${sample.symbolsRanked} plansProcessed=${sample.plansProcessed} `
    + `plansChanged=${sample.plansChanged} `
    + `eventLoopLagBeforeMs=${sample.eventLoopLagMsBefore.toFixed(2)} `
    + `eventLoopLagAfterMs=${sample.eventLoopLagMsAfter.toFixed(2)}`,
  );
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function markKindCompleted(planDate: string, kind: string): void {
  let set = completedKindsByDate.get(planDate);
  if (!set) {
    set = new Set();
    completedKindsByDate.set(planDate, set);
  }
  set.add(kind);
}

function isKindCompleted(planDate: string, kind: string): boolean {
  return completedKindsByDate.get(planDate)?.has(kind) ?? false;
}

type ScheduledRefreshKind = 'MID_MORNING' | 'LATE_REFRESH' | 'PREOPEN_VALIDATION';

function kindWindowEt(kind: ScheduledRefreshKind): [string, string] {
  const c = continuousIntelligence;
  switch (kind) {
    case 'MID_MORNING': return [c.premarketMidMorningRefreshStartEt, c.premarketMidMorningRefreshEndEt];
    case 'LATE_REFRESH': return [c.premarketRefreshWindowStart, c.premarketRefreshWindowEnd];
    case 'PREOPEN_VALIDATION': return [c.premarketPreopenValidationStartEt, c.premarketPreopenValidationEndEt];
  }
}

function isKindDue(kind: ScheduledRefreshKind, now: Date): boolean {
  const mins = minutesInTimezone(now.getTime(), TRADING_TIMEZONE);
  const [startEt, endEt] = kindWindowEt(kind);
  const start = hhmmToMinutes(startEt);
  const end = hhmmToMinutes(endEt);
  return mins >= start && mins < end;
}

// ── Canonical snapshot + no-churn hash ──

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

/** A plan is catalyst-backed when its evidence recorded a news catalyst — either as a
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
  _candidate: RankedCandidate,
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

// ── Per-plan refresh ──

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
  await counted(db.insert(tradePlanRevisions).values({
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
  }));
  await counted(db.update(tradePlans).set({
    status: 'EXPIRED',
    refreshVersion: newVersion,
    refreshedAt: nowIso,
    reasonForRefresh: reason,
    originalCreatedAt: plan.originalCreatedAt ?? plan.createdAt,
    evidenceAsof: nowIso,
    sessionPhase: 'PRE_MARKET',
  }).where(eq(tradePlans.id, plan.id)));
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
  kind: LifecycleRefreshKind,
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
  // fetch (same no-new-network-calls constraint as the build), so dropping it would be data
  // loss rather than new evidence. Catalyst STALENESS is still detected below via the
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
    ? (tierRank(delta.tierChanged.to) > tierRank(delta.tierChanged.from) ? 'PROMOTED' : 'DOWNGRADED')
    : catalystStale ? 'CATALYST_STALE' : KIND_REASON[kind];

  await counted(db.insert(tradePlanRevisions).values({
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
  }));
  await counted(db.update(tradePlans).set({
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
    evidenceAsof: nowIso,
    sessionPhase: 'PRE_MARKET',
    scoreDecompositionJson,
  }).where(eq(tradePlans.id, plan.id)));

  // Tier drop off PRIMARY releases the pre-open data reservation (release contract).
  if (plan.setupType === 'PRIMARY' && fields.setupType !== 'PRIMARY') {
    await releaseReservationsForPlan(plan.id, 'TIER_DROP', now);
  }

  emitTradePlanVersionCreated({
    planId: plan.id,
    symbol: plan.symbol,
    tradingDate: plan.planDate,
    refreshKind: KIND_REASON[kind],
    refreshVersion: newVersion,
    refreshedAt: nowIso,
    reasonForRefresh: reason,
    changedFields: delta.changedFields.map((c) => c.field),
    tierChanged: delta.tierChanged,
    at: nowIso,
  });
  if (delta.tierChanged) {
    const tierPayload = {
      planId: plan.id, symbol: plan.symbol, tradingDate: plan.planDate,
      refreshVersion: newVersion, fromTier: delta.tierChanged.from, toTier: delta.tierChanged.to, at: nowIso,
    };
    if (reason === 'PROMOTED') emitTradePlanPromoted(tierPayload);
    else emitTradePlanDowngraded(tierPayload);
  }

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

// ── Reservation phase ──

async function requestPrimaryReservationsForPlans(
  primaries: Array<{ planId: string; symbol: string }>,
  now: Date,
  rescuePort?: DataRescuePort,
): Promise<void> {
  if (primaries.length === 0) return;
  // Skip plans that already hold an ACTIVE reservation — re-requesting would only mint
  // DUPLICATE_ACTIVE_RESERVATION denials (and their rows), breaking the no-churn contract for
  // refreshes that changed nothing.
  const active = await counted(getActiveReservations());
  const coveredPlanIds = new Set(active.map((r) => r.planId));
  for (const p of primaries) {
    if (coveredPlanIds.has(p.planId)) continue;
    try {
      await requestDataReservation(
        p.symbol, p.planId, 'PRIMARY', 'premarket_plan_lifecycle',
        continuousIntelligence.premarketReservationTtlMinutes, { now, rescuePort },
      );
    } catch (e) {
      console.error('[TradePlanLifecycle] reservation request failed for', p.symbol, e);
    }
  }
}

// ── Initial build ──

export interface InitialBuildSummary {
  planCount: number;
  primaryCount: number;
  evidenceAsof: string;
}

/**
 * Builds the date's plans from evidence-as-of now. A late start (e.g. 08:23) builds immediately
 * and records evidenceAsof=now, sessionPhase=PRE_MARKET — it NEVER pretends to be a 04:00 plan.
 * Defensive per-symbol dedupe: never creates a duplicate plan for the same symbol+date.
 */
async function buildInitialPlans(input: LifecycleTickInput): Promise<InitialBuildSummary> {
  const { planDate, now } = input;
  const nowIso = now.toISOString();
  const perfStart = performance.now();
  const lagBefore = await measureEventLoopLagMs();
  planDbQueries = 0;
  resetManagerDbQueryCount();

  emitPremarketPlanBuildStarted(planDate, nowIso);
  const drafts = buildTradePlanDrafts(input.rankedCandidates, input.inputsBySymbol, planDate, now);
  const existing = await counted(getTradePlansForDate(planDate));
  const existingSymbols = new Set(existing.map((p) => p.symbol));
  const fresh = drafts.filter((d) => !existingSymbols.has(d.symbol));
  await persistTradePlanDrafts(fresh, {
    evidenceAsof: nowIso,
    sessionPhase: 'PRE_MARKET',
    reasonForRefresh: 'INITIAL_BUILD',
  });
  // The existing gated path (unchanged behavior): one independent vote per PRIMARY-tier draft,
  // still gated by ARGUS_TRADE_PLAN_IDEAS_ENABLED + Autobot + the pipeline-agent toggle.
  for (const draft of fresh) {
    if (draft.setupType === 'PRIMARY') {
      emitTradePlanIdea(draft, input.inputsBySymbol.get(draft.symbol)?.last ?? null);
    }
  }
  const primaryCount = fresh.filter((d) => d.setupType === 'PRIMARY').length;
  await requestPrimaryReservationsForPlans(
    fresh.filter((d) => d.setupType === 'PRIMARY').map((d) => ({ planId: d.id, symbol: d.symbol })),
    now,
    input.rescuePort,
  );
  emitPremarketPlanBuildCompleted({
    tradingDate: planDate, planCount: fresh.length, primaryCount, evidenceAsof: nowIso, at: nowIso,
  });
  // The initial build IS a completed refresh cycle (version 1): emit the
  // completion so the focus-report subscriber regenerates the report. The
  // payload is bounded scalars only (same contract as the refresh path below).
  emitPremarketRefreshCompleted({
    tradingDate: planDate, refreshVersion: 1, refreshedAt: nowIso, planCount: fresh.length, at: nowIso,
  });

  const lagAfter = await measureEventLoopLagMs();
  recordPerf({
    kind: 'INITIAL_BUILD', tradingDate: planDate, startedAt: nowIso,
    durationMs: performance.now() - perfStart,
    dbQueries: planDbQueries + getManagerDbQueryCount(),
    symbolsRanked: input.rankedCandidates.length, plansProcessed: fresh.length, plansChanged: fresh.length,
    eventLoopLagMsBefore: lagBefore, eventLoopLagMsAfter: lagAfter,
  });
  lifecycleMemoryByDate.set(planDate, { lastRunAt: nowIso, lastRunKind: 'INITIAL_BUILD' });
  return { planCount: fresh.length, primaryCount, evidenceAsof: nowIso };
}

// ── Lifecycle refresh runner ──

/**
 * Runs one lifecycle refresh over the date's plans: refresh existing, admit new candidates,
 * then the reservation phase. Emits per-plan TRADE_PLAN_VERSION_CREATED / PROMOTED / DOWNGRADED /
 * EXPIRED; when nothing material changed anywhere, a single TRADE_PLAN_UNCHANGED (and no DB
 * rows were written). PREOPEN_VALIDATION additionally emits PREOPEN_REVALIDATION_STARTED /
 * COMPLETED. A per-plan failure is isolated (SKIPPED) and never aborts the run; a
 * reservation-phase failure never rolls back plan writes.
 */
async function runLifecycleRefresh(
  kind: LifecycleRefreshKind,
  input: LifecycleTickInput,
): Promise<LifecycleRefreshSummary> {
  const { planDate, now } = input;
  const nowIso = now.toISOString();
  const perfStart = performance.now();
  const lagBefore = await measureEventLoopLagMs();
  planDbQueries = 0;
  resetManagerDbQueryCount();

  const isPreopen = kind === 'PREOPEN_VALIDATION';
  if (isPreopen) emitPreopenRevalidationStarted(planDate, nowIso);

  const plans = await counted(getTradePlansForDate(planDate));
  const rankedBySymbol = new Map(input.rankedCandidates.map((r) => [r.symbol, r]));
  const existingSymbols = new Set(plans.map((p) => p.symbol));
  const outcomes: PlanRefreshOutcome[] = [];
  const primarySurvivors: Array<{ planId: string; symbol: string }> = [];

  for (const plan of plans) {
    try {
      const outcome = await refreshOnePlan(plan, rankedBySymbol, input.inputsBySymbol, now, kind);
      outcomes.push(outcome);
      if (
        (outcome.kind === 'REFRESHED' || outcome.kind === 'UNCHANGED') &&
        outcome.postRefreshSetupType === 'PRIMARY' &&
        REFRESHABLE_STATUSES.has(outcome.postRefreshStatus)
      ) {
        primarySurvivors.push({ planId: plan.id, symbol: plan.symbol });
      }
    } catch (e) {
      console.error('[TradePlanLifecycle] refresh failed for plan', plan.id, e);
      outcomes.push({
        planId: plan.id,
        symbol: plan.symbol,
        kind: 'SKIPPED',
        reason: 'PROCESSING_ERROR',
        previousRefreshVersion: priorVersionOf(plan),
        newRefreshVersion: priorVersionOf(plan),
        deltaSummary: null,
        postRefreshSetupType: plan.setupType as SetupType,
        postRefreshStatus: plan.status as TradePlanStatus,
      });
    }
  }

  // New candidates enter: a ranked candidate with no plan for this symbol+date and a
  // plan-eligible setup gets a v1 plan (existingSymbols guards against duplicates — never two
  // PRIMARYs for the same symbol+date).
  let newPlans = 0;
  const newPrimaries: Array<{ planId: string; symbol: string }> = [];
  for (const candidate of input.rankedCandidates) {
    if (existingSymbols.has(candidate.symbol)) continue;
    const candInput = input.inputsBySymbol.get(candidate.symbol);
    if (!candInput) continue;
    const fields = computePlanFields(candidate, candInput, DEFAULT_TRADE_PLAN_THRESHOLDS, new Map());
    if (!fields) continue;
    const id = randomUUID();
    await counted(db.insert(tradePlans).values({
      id,
      symbol: candidate.symbol,
      planDate,
      ...fields,
      catalysts: JSON.stringify(fields.catalysts),
      status: 'READY',
      createdAt: nowIso,
      validUntil: endOfTradingDayIso(planDate),
      validUntilConfidence: 'ASSUMED_REGULAR_CLOSE_NO_EXCHANGE_CALENDAR',
      refreshVersion: 1,
      refreshedAt: null,
      reasonForRefresh: KIND_REASON[kind],
      originalCreatedAt: nowIso,
      evidenceAsof: nowIso,
      sessionPhase: 'PRE_MARKET',
      scoreDecompositionJson: null,
    }));
    existingSymbols.add(candidate.symbol);
    newPlans++;
    if (fields.setupType === 'PRIMARY') newPrimaries.push({ planId: id, symbol: candidate.symbol });
    emitTradePlanVersionCreated({
      planId: id,
      symbol: candidate.symbol,
      tradingDate: planDate,
      refreshKind: KIND_REASON[kind],
      refreshVersion: 1,
      refreshedAt: nowIso,
      reasonForRefresh: KIND_REASON[kind],
      changedFields: [],
      tierChanged: null,
      at: nowIso,
    });
  }

  // Reservation phase: sweep expired first (honest capacity accounting). New requests are skipped
  // inside the PREOPEN_VALIDATION window — the 09:25 handover cap would born-expire them, and the
  // 09:30 session handoff releases everything regardless. Expiry/tier-drop releases already ran
  // inline above. A failure here never rolls back the plan writes.
  try {
    await sweepExpiredReservations(now);
    if (!isPreopen) {
      await requestPrimaryReservationsForPlans([...primarySurvivors, ...newPrimaries], now, input.rescuePort);
    }
  } catch (e) {
    console.error('[TradePlanLifecycle] reservation phase failed (plan writes stand)', e);
  }

  const refreshedCount = outcomes.filter((o) => o.kind === 'REFRESHED').length;
  const unchangedCount = outcomes.filter((o) => o.kind === 'UNCHANGED').length;
  const expiredCount = outcomes.filter((o) => o.kind === 'EXPIRED').length;
  const skippedCount = outcomes.filter((o) => o.kind === 'SKIPPED').length;
  const downgradedCount = outcomes.filter((o) => o.kind === 'REFRESHED' && o.reason === 'DOWNGRADED').length;

  if (refreshedCount === 0 && expiredCount === 0 && newPlans === 0) {
    // Nothing material: no DB rows were written by this run (all UNCHANGED/SKIPPED) — say so
    // once, loudly, and emit nothing further.
    emitTradePlanUnchanged({
      tradingDate: planDate, kind: KIND_REASON[kind], planCount: plans.length, at: nowIso,
    });
  }
  if (isPreopen) {
    emitPreopenRevalidationCompleted({
      tradingDate: planDate, planCount: plans.length + newPlans,
      refreshedCount, expiredCount, downgradedCount, at: nowIso,
    });
  }

  const lagAfter = await measureEventLoopLagMs();
  const plansChanged = refreshedCount + expiredCount + newPlans;
  recordPerf({
    kind: KIND_REASON[kind], tradingDate: planDate, startedAt: nowIso,
    durationMs: performance.now() - perfStart,
    dbQueries: planDbQueries + getManagerDbQueryCount(),
    symbolsRanked: input.rankedCandidates.length, plansProcessed: plans.length,
    plansChanged, eventLoopLagMsBefore: lagBefore, eventLoopLagMsAfter: lagAfter,
  });
  lifecycleMemoryByDate.set(planDate, { lastRunAt: nowIso, lastRunKind: KIND_REASON[kind] });
  // Every completed refresh cycle emits PREMARKET_REFRESH_COMPLETED so the
  // focus-report subscriber regenerates the report — including no-material-
  // change runs (the upsert on (plan_date, refresh_version) makes regeneration
  // idempotent; redelivery of the same cycle carries the same version). The
  // cycle version is the max plan refreshVersion after the run: unchanged or
  // skipped plans keep their prior version, so a no-op refresh re-emits the
  // current version rather than inventing a new one.
  const cycleVersion = Math.max(1, ...outcomes.map((o) => o.newRefreshVersion));
  emitPremarketRefreshCompleted({
    tradingDate: planDate,
    refreshVersion: cycleVersion,
    refreshedAt: nowIso,
    planCount: plans.length + newPlans,
    at: nowIso,
  });
  return {
    kind, tradingDate: planDate, refreshedCount, unchangedCount, expiredCount, skippedCount, newPlans, outcomes,
  };
}

function priorVersionOf(plan: TradePlanRow): number {
  return plan.refreshVersion ?? 1;
}

// ── Tick entry point ──

/**
 * Premarket plan lifecycle tick — called from SnapshotScanner's PRE_MARKET tick with fresh
 * evidence. Decides: initial build (no plans yet), each due scheduled refresh (once per date per
 * kind), and the debounced event-driven material refresh. Never throws into the caller.
 */
export async function maybeRunScheduledPremarketRefresh(input: LifecycleTickInput): Promise<LifecycleTickSummary> {
  const { planDate, now } = input;
  const at = now.toISOString();
  const actions: LifecycleTickSummary['actions'] = [];
  try {
    if (classifyMarketSession(now.getTime(), TRADING_TIMEZONE, true) !== 'PRE_MARKET') {
      return { ran: false, tradingDate: planDate, at, actions: [{ action: 'SKIPPED', detail: 'NOT_PRE_MARKET' }] };
    }
    const plans = await getTradePlansForDate(planDate);
    if (plans.length === 0) {
      const build = await buildInitialPlans(input);
      pendingInitialBuild = false;
      markKindCompleted(planDate, 'INITIAL_BUILD');
      actions.push({ action: 'INITIAL_BUILD', detail: `${build.planCount} plans, ${build.primaryCount} PRIMARY` });
      return { ran: true, tradingDate: planDate, at, actions };
    }
    pendingInitialBuild = false;

    for (const kind of ['MID_MORNING', 'LATE_REFRESH', 'PREOPEN_VALIDATION'] as const) {
      if (isKindDue(kind, now) && !isKindCompleted(planDate, kind)) {
        const summary = await runLifecycleRefresh(kind, input);
        markKindCompleted(planDate, kind);
        actions.push({
          action: 'REFRESH', kind,
          detail: `${summary.refreshedCount} refreshed, ${summary.expiredCount} expired, ${summary.unchangedCount} unchanged, ${summary.newPlans} new`,
        });
      }
    }

    if (shouldRunEventDriven(now)) {
      const summary = await runLifecycleRefresh('EVENT_DRIVEN', input);
      lastEventDrivenRunAt = now.getTime();
      pendingEventTriggers = [];
      actions.push({
        action: 'REFRESH', kind: 'EVENT_DRIVEN',
        detail: `${summary.refreshedCount} refreshed, ${summary.expiredCount} expired, ${summary.unchangedCount} unchanged, ${summary.newPlans} new`,
      });
    }

    return { ran: actions.length > 0, tradingDate: planDate, at, actions };
  } catch (e) {
    console.error('[TradePlanLifecycle] scheduled tick failed (scan continues)', e);
    return { ran: false, tradingDate: planDate, at, actions: [{ action: 'SKIPPED', detail: 'TICK_ERROR' }] };
  }
}

/** Debounce: fire only after a quiet period with no new triggers. Cooldown: minimum spacing
 *  between event-driven runs. The final materiality arbiter is the no-churn hash inside the
 *  refresh itself. */
function shouldRunEventDriven(now: Date): boolean {
  if (pendingEventTriggers.length === 0) return false;
  const nowMs = now.getTime();
  const newestTriggerAt = Math.max(...pendingEventTriggers.map((t) => t.at));
  const quietMs = nowMs - newestTriggerAt;
  const sinceLastRun = lastEventDrivenRunAt == null
    ? Number.POSITIVE_INFINITY
    : nowMs - lastEventDrivenRunAt;
  return quietMs >= continuousIntelligence.premarketEventDrivenDebounceMs
    && sinceLastRun >= continuousIntelligence.premarketEventDrivenCooldownMs;
}

function queueEventTrigger(source: string, symbol: string | null): void {
  pendingEventTriggers.push({ source, symbol, at: Date.now() });
  if (pendingEventTriggers.length > MAX_PENDING_TRIGGERS) {
    pendingEventTriggers.splice(0, pendingEventTriggers.length - MAX_PENDING_TRIGGERS);
  }
}

/** Test-only: queue an event-driven trigger at an explicit timestamp (fake-clock friendly;
 *  production handlers always use Date.now()). */
export function queueEventTriggerForTests(source: string, symbol: string | null, at: Date): void {
  pendingEventTriggers.push({ source, symbol, at: at.getTime() });
  if (pendingEventTriggers.length > MAX_PENDING_TRIGGERS) {
    pendingEventTriggers.splice(0, pendingEventTriggers.length - MAX_PENDING_TRIGGERS);
  }
}

/** Test-only: inspect the queued event-driven triggers. */
export function getPendingEventTriggersForTests(): Array<{ source: string; symbol: string | null; at: number }> {
  return [...pendingEventTriggers];
}

// ── Event subscriptions ──

async function handlePremarketSessionStarted(tradingDate: string): Promise<void> {
  try {
    const plans = await getTradePlansForDate(tradingDate);
    if (plans.length === 0) {
      // No plans yet: the next SnapshotScanner PRE_MARKET tick (which owns fresh evidence)
      // performs the initial build from evidence-as-of that tick.
      pendingInitialBuild = true;
    } else {
      // Restart recovery: engine started during PREMARKET with existing plans for today —
      // resume/refresh/expire by age and evidence via the debounced event-driven path.
      // Never creates duplicates: the refresh only mutates existing plans and the new-candidate
      // path skips symbols that already have a plan.
      queueEventTrigger('SESSION_START_RESUME', null);
    }
  } catch (e) {
    console.error('[TradePlanLifecycle] PREMARKET_SESSION_STARTED handler failed', e);
  }
}

async function handleSessionTransition(payload: {
  from?: { marketPhase?: string } | null;
  to?: { marketPhase?: string } | null;
  tradingDate?: string;
} | null | undefined): Promise<void> {
  try {
    const from = payload?.from?.marketPhase ?? null;
    const to = payload?.to?.marketPhase ?? null;
    if (from === 'PRE_MARKET' && to !== null && to !== 'PRE_MARKET') {
      // Open handoff: release every ACTIVE pre-open reservation and hand the plans to RTH.
      // Only this ledger's rows are touched — intraday Fast Lane / discovery subscriptions and
      // MarketDataWorker's own rescue grants are never cancelled here.
      const now = new Date();
      const tradingDate = payload?.tradingDate ?? getTradingDateStr(now);
      const released = await releaseAllActiveReservations('MARKET_OPEN_HANDOVER', now);
      emitPremarketPlanHandedToRth({ tradingDate, releasedReservations: released, at: now.toISOString() });
    }
  } catch (e) {
    console.error('[TradePlanLifecycle] session-transition handler failed', e);
  }
}

/**
 * Subscribes the premarket plan lifecycle to the existing session/event bus. Idempotent.
 * Called once at boot (see src/server/core/ArgusCoreBoot.ts's SessionLifecycle block — the
 * parent wiring adds `startPremarketPlanLifecycle()` there in a matching try/catch).
 *
 * Subscriptions (intent only — the SnapshotScanner tick executes; no timers here):
 * - PREMARKET_SESSION_STARTED → initial build intent, or resume refresh when plans exist.
 * - SESSION_LIFECYCLE_STATE_CHANGED leaving PRE_MARKET → open handoff (emit + release).
 * - NEWS_CATALYST (catalystStrength HIGH only) → debounced material-refresh trigger.
 * - MARKET_DATA_GAP_DETECTED → debounced data-readiness re-validation trigger.
 * - MACRO_ANALYSIS_COMPLETED → debounced macro refresh trigger.
 *
 * Deliberately NOT subscribed (no bus event exists; not invented): new MARKET_MOVER, price
 * acceleration, sector-RS change — all three flow through the ranking inputs every scanner tick
 * and are therefore covered by the scheduled refreshes' re-ranking. Data-quality recovery is
 * covered via MARKET_DATA_GAP_DETECTED (feed interruption detected → re-validate readiness).
 */
export function startPremarketPlanLifecycle(): void {
  if (lifecycleSubscribed) return;
  lifecycleSubscribed = true;

  eventBus.on(EVENTS.PREMARKET_SESSION_STARTED, (payload: { tradingDate?: string }) => {
    void handlePremarketSessionStarted(payload?.tradingDate ?? getTradingDateStr(new Date()));
  });
  eventBus.on(EVENTS.SESSION_LIFECYCLE_STATE_CHANGED, (payload: {
    from?: { marketPhase?: string } | null;
    to?: { marketPhase?: string } | null;
    tradingDate?: string;
  }) => {
    void handleSessionTransition(payload);
  });
  eventBus.on(EVENTS.NEWS_CATALYST, (payload: { symbol?: string; catalystStrength?: string }) => {
    if (payload?.symbol && payload?.catalystStrength === 'HIGH') {
      queueEventTrigger('NEWS_CATALYST', payload.symbol);
    }
  });
  eventBus.on(EVENTS.MARKET_DATA_GAP_DETECTED, () => {
    queueEventTrigger('DATA_QUALITY', null);
  });
  eventBus.on(EVENTS.MACRO_ANALYSIS_COMPLETED, () => {
    queueEventTrigger('MACRO', null);
  });
}

// ── Workstream D CLI contract ──

/**
 * Synchronous premarket lifecycle status for workstream D's CLI. Reads the plan ledger with
 * drizzle's synchronous better-sqlite3 API (.all()) — safe because trade_plans writes for a date
 * are bounded (tier caps) and this never writes. Shape is stable; do not change without
 * coordinating with workstream D. The optional `now` parameter is clock injection for tests
 * only — production callers omit it.
 */
export function getPremarketLifecycleStatus(tradingDate?: string, now: Date = new Date()): PremarketLifecycleStatus {
  const date = tradingDate ?? getTradingDateStr(now);
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const plans = db.select().from(tradePlans).where(eq(tradePlans.planDate, date)).all();

  const isLive = (p: (typeof plans)[number]) => p.status !== 'EXPIRED' && p.status !== 'INVALIDATED';
  const live = plans.filter(isLive);
  const planCounts = {
    PRIMARY: live.filter((p) => p.setupType === 'PRIMARY').length,
    BACKUP: live.filter((p) => p.setupType === 'BACKUP').length,
    WATCH: live.filter((p) => p.setupType === 'WATCHLIST').length,
    // Overlapping buckets, not a partition: a plan demoted then expired counts in both.
    DOWNGRADED: plans.filter((p) => p.reasonForRefresh === 'DOWNGRADED').length,
    EXPIRED: plans.filter((p) => p.status === 'EXPIRED').length,
  };

  const stampOf = (p: (typeof plans)[number]) => p.refreshedAt ?? p.createdAt;
  let lastBuildAt: string | null = null;
  let lastBuildVersion = 0;
  let evidenceAsof: string | null = null;
  let sessionPhase: string = classifyMarketSession(nowMs, TRADING_TIMEZONE, true);
  let oldestPlanAgeMinutes: number | null = null;
  if (plans.length > 0) {
    let latestStamp = '';
    let latestEvidence = '';
    let latestPhase: string | null = null;
    let oldestCreated = '';
    for (const p of plans) {
      const stamp = stampOf(p);
      if (stamp > latestStamp) {
        latestStamp = stamp;
        latestPhase = p.sessionPhase;
      }
      if (p.evidenceAsof && p.evidenceAsof > latestEvidence) latestEvidence = p.evidenceAsof;
      const created = p.originalCreatedAt ?? p.createdAt;
      if (oldestCreated === '' || created < oldestCreated) oldestCreated = created;
      lastBuildVersion = Math.max(lastBuildVersion, p.refreshVersion ?? 1);
    }
    lastBuildAt = latestStamp;
    evidenceAsof = latestEvidence === '' ? null : latestEvidence;
    if (latestPhase) sessionPhase = latestPhase;
    oldestPlanAgeMinutes = Math.max(0, Math.round((nowMs - Date.parse(oldestCreated)) / 60000));
  }

  const kinds = completedKindsByDate.get(date) ?? new Set<string>();
  const mins = minutesInTimezone(nowMs, TRADING_TIMEZONE);
  const windows: Array<{
    kind: 'MID_MORNING' | 'LATE_REFRESH' | 'PREOPEN_VALIDATION';
    start: number; end: number; startEt: string;
  }> = (['MID_MORNING', 'LATE_REFRESH', 'PREOPEN_VALIDATION'] as const).map((kind) => {
    const [startEt, endEt] = kindWindowEt(kind);
    return { kind, start: hhmmToMinutes(startEt), end: hhmmToMinutes(endEt), startEt };
  });
  let nextRefreshAt: string | null = null;
  let nextRefreshKind: PremarketLifecycleStatus['nextRefreshKind'] = null;
  let refreshDue = false;
  for (const w of windows) {
    if (kinds.has(w.kind) || mins >= w.end) continue;
    if (mins >= w.start) {
      nextRefreshKind = w.kind;
      nextRefreshAt = nowIso;
      refreshDue = true;
    } else {
      nextRefreshKind = w.kind;
      nextRefreshAt = tradingWallTimeToIso(date, w.startEt);
    }
    break;
  }
  if (nextRefreshKind === null && pendingEventTriggers.length > 0) {
    const oldestTriggerAt = Math.min(...pendingEventTriggers.map((t) => t.at));
    const fireAtMs = oldestTriggerAt + continuousIntelligence.premarketEventDrivenDebounceMs;
    const cooldownOk = lastEventDrivenRunAt == null
      || nowMs - lastEventDrivenRunAt >= continuousIntelligence.premarketEventDrivenCooldownMs;
    nextRefreshKind = 'EVENT_DRIVEN';
    nextRefreshAt = new Date(Math.max(fireAtMs, nowMs)).toISOString();
    refreshDue = nowMs >= fireAtMs && cooldownOk;
  }

  return {
    tradingDate: date,
    sessionPhase,
    lastBuildAt,
    lastBuildVersion,
    evidenceAsof,
    nextRefreshAt,
    nextRefreshKind,
    planCounts,
    oldestPlanAgeMinutes,
    refreshDue,
  };
}
