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
import { missedOpportunities, riskAssessments, trades, agentReasoningLogs, transactionTraces } from '../db/schema';
import { eq, and, gte, lte } from 'drizzle-orm';
import type { RankedCandidate } from './ComposableRanking';
import { logErrorSafely } from '../core/SecretRedaction';

export type MissClassification =
  | 'RANKING_MISS' | 'SUBSCRIPTION_MISS' | 'AGENT_MISS'
  | 'CONSENSUS_REJECTION' | 'RISK_REJECTION' | 'EXECUTION_MISS' | 'NOT_ACTUALLY_MISS';

export interface FunnelSignals {
  symbol: string;
  ranked: RankedCandidate | null;
  isActivelySubscribed: boolean;
  hadAgentIdeaThisWindow: boolean;
  hadChiefApproval: boolean;
  hadRiskAssessment: boolean;
  riskApproved: boolean | null;
  hadFilledTrade: boolean;
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
): Promise<FunnelSignals> {
  const [ideaLogs, txTraces, riskRows, tradeRows] = await Promise.all([
    db.select().from(agentReasoningLogs)
      .where(and(eq(agentReasoningLogs.symbol, symbol), gte(agentReasoningLogs.timestamp, windowStartIso))),
    db.select().from(transactionTraces)
      .where(and(eq(transactionTraces.symbol, symbol), gte(transactionTraces.createdAt, windowStartIso))),
    db.select().from(riskAssessments)
      .where(and(eq(riskAssessments.symbol, symbol), gte(riskAssessments.createdAt, windowStartIso))),
    db.select().from(trades)
      .where(and(eq(trades.symbol, symbol), eq(trades.status, 'FILLED'), gte(trades.timestamp, windowStartIso))),
  ]);

  const latestRisk = riskRows.length > 0
    ? riskRows.reduce((a, b) => (a.createdAt > b.createdAt ? a : b))
    : null;

  return {
    symbol,
    ranked,
    isActivelySubscribed,
    hadAgentIdeaThisWindow: ideaLogs.length > 0,
    hadChiefApproval: txTraces.length > 0,
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

  for (const candidate of candidates) {
    const lastDetected = lastDetectedAtMsBySymbol.get(candidate.symbol);
    if (lastDetected !== undefined && nowMs - lastDetected < cooldownMs) continue;

    try {
      const signals = await getFunnelSignals(
        candidate.symbol,
        candidate,
        activeSymbols.has(candidate.symbol),
        windowStartIso,
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
