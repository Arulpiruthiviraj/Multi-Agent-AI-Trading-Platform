/**
 * Phase 4F (Missed Opportunity Intelligence, 2026-08-27). Classifies where a real candidate died
 * in the funnel, using ONLY telemetry that already exists - never hindsight-labels a rejection as
 * "should have traded." Works even when zero trades occur in a session, since it classifies
 * against ranking/consensus/subscription telemetry, not trade outcomes.
 *
 * Governance: discovery/diagnostics only. Never imports OMS/RiskEngine/the order-placement broker
 * layer. Never emits TRADE_IDEA_GENERATED. Detecting and persisting a miss has zero effect on the
 * live trading pipeline.
 */
import { db } from '../db';
import { missedOpportunities, riskAssessments, trades, agentReasoningLogs, transactionTraces, tradePlans } from '../db/schema';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import type { RankedCandidate } from './ComposableRanking';
import type { TraceLifecycleStatus } from '../services/TracingService';
import { logErrorSafely } from '../core/SecretRedaction';

/**
 * transaction_traces.lifecycleStatus values that can only exist once ChiefTrader consensus has
 * actually been REACHED (approved) for that trace - i.e. every status at or downstream of
 * TracingService's 'CONSENSUS_REACHED'. 'ANALYZING'/'INITIATED'/'NO_CONSENSUS' are intermediate
 * or explicitly-rejected states and must never count as chief approval.
 *
 * Real bug fixed here (2026-09-04 missed-opportunity forensic audit): getFunnelSignals() used to
 * derive hadChiefApproval from `txTraces.length > 0` - the mere EXISTENCE of any transaction_traces
 * row for the symbol in-window, regardless of its lifecycleStatus. Every agent-reasoning write
 * (including intermediate, non-approving ones) creates/touches a transaction_traces row via
 * TracingService.ensureTraceRow(), so this was true for almost any symbol that received so much as
 * one agent evaluation - it did not require ChiefTrader approval at all. Confirmed live: QQQ and
 * SPY were each classified EXECUTION_MISS ("Approved by both ChiefTrader and RiskEngine, but no
 * fill was ever recorded") multiple times on 2026-09-04 even though neither symbol had a single
 * CHIEF_CONSENSUS_COMPLETED approved=true event, CHIEF_APPROVED_IDEA event, or risk_assessments
 * row anywhere in the entire database for that day - ChiefTrader had in fact never approved either
 * symbol; every one of their transaction_traces rows was a rejected ("[NO TRADE] Confidence X% did
 * not clear 75%.") round. Checking lifecycleStatus directly (rather than row existence) is the
 * correct fix and only works because TracingService.ts's own logChiefConsensus()/logAgentThought()
 * ordering bug (a real terminal-status-clobbering bug found in the same investigation) is fixed
 * alongside this - see that file's logAgentReasoningRow() docstring.
 */
// Array annotated against the real TraceLifecycleStatus union (compiler-checked - a typo or a
// future status added to that type without a decision here won't silently compile). Widened to
// Set<string> only for the .has() call below, since transaction_traces.lifecycleStatus is a plain
// text column at the DB layer, not the literal type.
const CHIEF_APPROVAL_OR_LATER_STATUS_LIST: TraceLifecycleStatus[] = [
  'CONSENSUS_REACHED', 'RISK_APPROVED', 'RISK_REJECTED', 'ORDER_SUBMITTED', 'FILLED', 'CANCELLED',
];
const CHIEF_APPROVAL_OR_LATER_STATUSES = new Set<string>(CHIEF_APPROVAL_OR_LATER_STATUS_LIST);

export type MissClassification =
  | 'RANKING_MISS' | 'SUBSCRIPTION_MISS' | 'AGENT_MISS'
  | 'CONSENSUS_REJECTION' | 'RISK_REJECTION' | 'EXECUTION_MISS' | 'NOT_ACTUALLY_MISS'
  /** Session-Aware Trading Architecture Phase 7 (2026-09-05): a premarket TradePlan existed for
   *  this symbol (planDate === today) and was INVALIDATED or EXPIRED by TradePlanBuilder's own
   *  revalidation logic before any agent/ChiefTrader/RiskEngine stage was ever reached. Distinct
   *  from CONSENSUS_REJECTION/RISK_REJECTION (which require the idea to have actually been
   *  evaluated by those stages) - this classifies a real, distinct failure point: the thesis
   *  itself was withdrawn upstream of the live idea pipeline entirely. */
  | 'THESIS_INVALIDATED';

export interface FunnelSignals {
  symbol: string;
  ranked: RankedCandidate | null;
  isActivelySubscribed: boolean;
  hadAgentIdeaThisWindow: boolean;
  hadChiefApproval: boolean;
  hadRiskAssessment: boolean;
  riskApproved: boolean | null;
  hadFilledTrade: boolean;
  /** Most recent TradePlan status for this symbol/planDate, or null if no plan exists this
   *  trading day. 'INVALIDATED'/'EXPIRED' here is a real, distinct explanation for a missing
   *  agent idea - see THESIS_INVALIDATED's own doc comment on MissClassification. */
  tradePlanStatus: string | null;
}

export interface ClassificationResult {
  classification: MissClassification;
  reason: string;
}

/**
 * First-failure-in-order classification, mirroring RiskEngine's own "first gate failure is the
 * reported reason" convention. A REJECT-recommended candidate is NOT classified as a miss at all
 * (the caller should skip it) - correctly-rejected candidates are not "missed opportunities."
 */
export function classifyMiss(signals: FunnelSignals): ClassificationResult {
  if (signals.hadFilledTrade) {
    return { classification: 'NOT_ACTUALLY_MISS', reason: 'This candidate was actually traded - not a miss.' };
  }
  if (!signals.isActivelySubscribed) {
    return { classification: 'SUBSCRIPTION_MISS', reason: 'Ranked as PROMOTE-worthy but never became an active market-data subscription this window.' };
  }
  if (!signals.hadAgentIdeaThisWindow) {
    if (signals.tradePlanStatus === 'INVALIDATED' || signals.tradePlanStatus === 'EXPIRED') {
      return { classification: 'THESIS_INVALIDATED', reason: `Premarket TradePlan was ${signals.tradePlanStatus} before any agent evaluated this symbol this window.` };
    }
    return { classification: 'AGENT_MISS', reason: 'Actively subscribed, but no agent produced a TRADE_IDEA_GENERATED for this symbol in the evaluation window.' };
  }
  if (!signals.hadChiefApproval) {
    return { classification: 'CONSENSUS_REJECTION', reason: 'Agent idea(s) generated, but ChiefTrader consensus never produced CHIEF_APPROVED_IDEA for this symbol.' };
  }
  if (signals.hadRiskAssessment && signals.riskApproved === false) {
    return { classification: 'RISK_REJECTION', reason: 'ChiefTrader approved, but RiskEngine rejected the resulting assessment.' };
  }
  return { classification: 'EXECUTION_MISS', reason: 'Approved by both ChiefTrader and RiskEngine, but no fill was ever recorded.' };
}

export interface MissedOpportunityRecord {
  id: string;
  symbol: string;
  detectedAt: string;
  classification: MissClassification;
  classificationReason: string;
  evidenceAtDecisionJson: string;
  priceAtDetection: number | null;
  evaluationHorizonMinutes: number;
  evaluationStatus: 'PENDING' | 'EVALUATED';
}

/**
 * Only PROMOTE-recommended candidates are eligible to be classified as a miss at all - a
 * correctly-REJECT-recommended candidate is not "missed," it was correctly deprioritized. This is
 * the explicit safeguard against hindsight bias the classification itself cannot provide alone.
 */
export function buildMissedOpportunityRecord(
  signals: FunnelSignals,
  priceAtDetection: number | null,
  evaluationHorizonMinutes: number,
  now: Date = new Date(),
): MissedOpportunityRecord | null {
  if (!signals.ranked || signals.ranked.promotionRecommendation !== 'PROMOTE') return null;
  const { classification, reason } = classifyMiss(signals);
  if (classification === 'NOT_ACTUALLY_MISS') return null;

  return {
    id: `miss-${signals.symbol}-${now.getTime()}`,
    symbol: signals.symbol,
    detectedAt: now.toISOString(),
    classification,
    classificationReason: reason,
    evidenceAtDecisionJson: JSON.stringify({
      rank: signals.ranked.rank,
      finalScore: signals.ranked.finalScore,
      components: signals.ranked.components,
      isActivelySubscribed: signals.isActivelySubscribed,
      hadAgentIdeaThisWindow: signals.hadAgentIdeaThisWindow,
      hadChiefApproval: signals.hadChiefApproval,
      hadRiskAssessment: signals.hadRiskAssessment,
      riskApproved: signals.riskApproved,
    }),
    priceAtDetection,
    evaluationHorizonMinutes,
    evaluationStatus: 'PENDING',
  };
}

export async function persistMissedOpportunities(records: MissedOpportunityRecord[]): Promise<void> {
  if (records.length === 0) return;
  try {
    await db.insert(missedOpportunities).values(records);
  } catch (e) {
    console.error('[MissedOpportunityDetector] Failed to persist missed opportunities', e);
  }
}

export interface EvaluationResult {
  priceAtEvaluation: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
}

/**
 * Retrospective evaluation using observable price data only (a sampled series between detection
 * and now) - explicitly labeled retrospective, never future knowledge. MFE/MAE are computed
 * relative to priceAtDetection, direction-agnostic (both are reported; the caller decides which
 * matters for a given direction).
 */
export function evaluateAgainstPriceSeries(priceAtDetection: number, observedPrices: number[]): EvaluationResult | null {
  if (observedPrices.length === 0 || !(priceAtDetection > 0)) return null;
  let maxUp = 0;
  let maxDown = 0;
  for (const p of observedPrices) {
    const pctChange = ((p - priceAtDetection) / priceAtDetection) * 100;
    if (pctChange > maxUp) maxUp = pctChange;
    if (pctChange < maxDown) maxDown = pctChange;
  }
  return {
    priceAtEvaluation: observedPrices[observedPrices.length - 1],
    maxFavorableExcursionPct: maxUp,
    maxAdverseExcursionPct: maxDown,
  };
}

export async function persistEvaluation(missId: string, evaluation: EvaluationResult, now: Date = new Date()): Promise<void> {
  try {
    await db.update(missedOpportunities).set({
      evaluationStatus: 'EVALUATED',
      priceAtEvaluation: evaluation.priceAtEvaluation,
      maxFavorableExcursionPct: evaluation.maxFavorableExcursionPct,
      maxAdverseExcursionPct: evaluation.maxAdverseExcursionPct,
      evaluatedAt: now.toISOString(),
    }).where(eq(missedOpportunities.id, missId));

    // Phase 4G (Learning expansion, 2026-08-27): every EVALUATED miss also becomes an
    // OBSERVATIONAL learning observation - see LearningObservationRecorder.ts's own governance
    // note on why this can never carry EXECUTED trust.
    const [updated] = await db.select().from(missedOpportunities).where(eq(missedOpportunities.id, missId)).limit(1);
    if (updated) {
      const { recordMissedOpportunityObservation } = await import('./LearningObservationRecorder');
      await recordMissedOpportunityObservation(updated, now);
    }
  } catch (e) {
    console.error('[MissedOpportunityDetector] Failed to persist evaluation', e);
  }
}

export async function getMissedOpportunities(sinceIso: string, limit = 100): Promise<Array<typeof missedOpportunities.$inferSelect>> {
  return db.select().from(missedOpportunities)
    .where(gte(missedOpportunities.detectedAt, sinceIso))
    .limit(limit);
}

export async function getPendingEvaluations(horizonElapsedBeforeIso: string, limit = 50): Promise<Array<typeof missedOpportunities.$inferSelect>> {
  return db.select().from(missedOpportunities)
    .where(and(eq(missedOpportunities.evaluationStatus, 'PENDING'), lte(missedOpportunities.detectedAt, horizonElapsedBeforeIso)))
    .limit(limit);
}

/**
 * Builds funnel signals for one symbol from already-persisted telemetry only (agent_reasoning_logs,
 * transaction_traces, risk_assessments, trades) - no new instrumentation, no fabricated stages.
 * `isActivelySubscribed` must come from the caller (MarketDataWorker.getActiveSymbols()), since
 * subscription state is in-memory, not a DB table.
 */
export async function getFunnelSignals(
  symbol: string,
  ranked: RankedCandidate | null,
  isActivelySubscribed: boolean,
  windowStartIso: string,
  /** Optional (default null - no TradePlan lookup, tradePlanStatus stays null). The caller's
   *  trading-date string (getTradingDateStr(now)) - used only to look up whether a premarket
   *  TradePlan exists for this symbol today, never to redefine the window above. */
  planDate: string | null = null,
): Promise<FunnelSignals> {
  const [ideaLogs, txTraces, riskRows, tradeRows, planRows] = await Promise.all([
    db.select().from(agentReasoningLogs)
      .where(and(eq(agentReasoningLogs.symbol, symbol), gte(agentReasoningLogs.timestamp, windowStartIso))),
    db.select().from(transactionTraces)
      .where(and(eq(transactionTraces.symbol, symbol), gte(transactionTraces.createdAt, windowStartIso))),
    db.select().from(riskAssessments)
      .where(and(eq(riskAssessments.symbol, symbol), gte(riskAssessments.createdAt, windowStartIso))),
    db.select().from(trades)
      .where(and(eq(trades.symbol, symbol), eq(trades.status, 'FILLED'), gte(trades.timestamp, windowStartIso))),
    planDate
      ? db.select({ status: tradePlans.status }).from(tradePlans)
          .where(and(eq(tradePlans.symbol, symbol), eq(tradePlans.planDate, planDate)))
          .orderBy(desc(tradePlans.createdAt)).limit(1)
      : Promise.resolve([]),
  ]);

  const latestRisk = riskRows.length > 0
    ? riskRows.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    : null;

  return {
    tradePlanStatus: planRows.length > 0 ? planRows[0].status : null,
    symbol,
    ranked,
    isActivelySubscribed,
    hadAgentIdeaThisWindow: ideaLogs.length > 0,
    hadChiefApproval: txTraces.some(t => CHIEF_APPROVAL_OR_LATER_STATUSES.has(t.lifecycleStatus)),
    hadRiskAssessment: riskRows.length > 0,
    riskApproved: latestRisk ? latestRisk.approved : null,
    hadFilledTrade: tradeRows.length > 0,
  };
}

const lastDetectedAtMsBySymbol = new Map<string, number>();

/**
 * Orchestration entry point: for each PROMOTE-recommended ranked candidate, checks funnel signals
 * and persists a missed-opportunity record if applicable. Per-symbol cooldown (config-driven, not
 * a TS literal) prevents re-flagging the same stalled candidate every scan cycle. Every DB call is
 * wrapped so a failure here can never propagate into the caller's ranking cycle.
 */
export async function runMissedOpportunityDetectionCycle(
  rankedCandidates: RankedCandidate[],
  activeSymbols: Set<string>,
  lookbackMs: number,
  cooldownMs: number,
  evaluationHorizonMinutes: number,
  now: Date = new Date(),
): Promise<void> {
  const nowMs = now.getTime();
  const windowStartIso = new Date(nowMs - lookbackMs).toISOString();
  const candidates = rankedCandidates.filter((c) => c.promotionRecommendation === 'PROMOTE');
  const records: MissedOpportunityRecord[] = [];
  const { getTradingDateStr } = await import('../core/TradingCalendar');
  const planDate = getTradingDateStr(now);

  for (const candidate of candidates) {
    const lastDetected = lastDetectedAtMsBySymbol.get(candidate.symbol);
    if (lastDetected !== undefined && nowMs - lastDetected < cooldownMs) continue;

    try {
      const signals = await getFunnelSignals(
        candidate.symbol,
        candidate,
        activeSymbols.has(candidate.symbol),
        windowStartIso,
        planDate,
      );
      const record = buildMissedOpportunityRecord(signals, null, evaluationHorizonMinutes, now);
      if (record) {
        records.push(record);
        lastDetectedAtMsBySymbol.set(candidate.symbol, nowMs);
      }
    } catch (e) {
      logErrorSafely(`[MissedOpportunityDetector] failed to build funnel signals for ${candidate.symbol}`, e);
    }
  }

  await persistMissedOpportunities(records);
}
