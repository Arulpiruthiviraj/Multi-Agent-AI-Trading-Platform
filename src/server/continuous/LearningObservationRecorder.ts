/**
 * Phase 4G (Learning expansion, 2026-08-27). Widens learning inputs beyond closed trades to
 * rejected candidates and missed opportunities - but ONLY as observational evidence, distinct
 * from EXECUTED evidence (a real fill's real P&L). This distinction (`trustLevel`) is the whole
 * point: a rejected candidate's "what if" outcome is real market data, but was never subjected to
 * RiskEngine/OMS the way a real trade was, so it must never be weighted as if it had been.
 *
 * Governance: this module ONLY writes rows to `learning_observations`. It never mutates
 * `agent_performance_stats.currentWeight`, `learned_rules`, `config/agentWeights.json`, or any
 * other live-weighted parameter - see ReflectionEngine (unchanged) for that. It never imports
 * OMS/RiskEngine/the order-placement broker layer and never emits TRADE_IDEA_GENERATED.
 */
import { db } from '../db';
import { learningObservations, trades, type missedOpportunities } from '../db/schema';
import { eq, and, gte, desc } from 'drizzle-orm';
import { logErrorSafely } from '../core/SecretRedaction';

export type ObservationType = 'CLOSED_TRADE' | 'REJECTED_CANDIDATE' | 'MISSED_OPPORTUNITY';
export type TrustLevel = 'EXECUTED' | 'OBSERVATIONAL';

export interface LearningObservation {
  id: string;
  symbol: string;
  observationType: ObservationType;
  trustLevel: TrustLevel;
  evidenceJson: string;
  outcomeJson: string | null;
  createdAt: string;
}

function makeId(prefix: string, symbol: string, now: Date): string {
  return `${prefix}-${symbol}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function persist(record: LearningObservation): Promise<void> {
  try {
    await db.insert(learningObservations).values(record);
  } catch (e) {
    logErrorSafely('[LearningObservationRecorder] failed to persist observation', e);
  }
}

/**
 * A closed (FILLED, has profitLoss) trade is EXECUTED-trust evidence - it passed through the full
 * ChiefTrader/RiskEngine/OMS spine and has a real fill.
 */
export async function recordExecutedTradeObservation(trade: typeof trades.$inferSelect, now: Date = new Date()): Promise<void> {
  if (trade.status !== 'FILLED') return;
  const record: LearningObservation = {
    id: makeId('exec', trade.symbol, now),
    symbol: trade.symbol,
    observationType: 'CLOSED_TRADE',
    trustLevel: 'EXECUTED',
    evidenceJson: JSON.stringify({
      tradeId: trade.id, side: trade.side, quantity: trade.quantity, price: trade.price,
      reasoning: trade.reasoning, traceId: trade.traceId,
    }),
    outcomeJson: trade.profitLoss !== null && trade.profitLoss !== undefined
      ? JSON.stringify({ profitLoss: trade.profitLoss })
      : null,
    createdAt: now.toISOString(),
  };
  await persist(record);
}

export interface RejectedCandidateEvidence {
  symbol: string;
  rejectionGate: string | null;
  rejectionReason: string;
  finalScore: number | null;
  traceId: string | null;
}

/**
 * A RiskEngine/consensus-rejected candidate is OBSERVATIONAL - it was correctly stopped by a real
 * gate, and recording that a gate fired is informative, but the rejection itself is not "outcome"
 * evidence the way a fill's P&L is.
 */
export async function recordRejectedCandidateObservation(evidence: RejectedCandidateEvidence, now: Date = new Date()): Promise<void> {
  const record: LearningObservation = {
    id: makeId('rej', evidence.symbol, now),
    symbol: evidence.symbol,
    observationType: 'REJECTED_CANDIDATE',
    trustLevel: 'OBSERVATIONAL',
    evidenceJson: JSON.stringify(evidence),
    outcomeJson: null,
    createdAt: now.toISOString(),
  };
  await persist(record);
}

export interface MissedOpportunityEvidence {
  symbol: string;
  classification: string;
  classificationReason: string;
  priceAtDetection: number | null;
  maxFavorableExcursionPct: number | null;
  maxAdverseExcursionPct: number | null;
}

/**
 * A retrospectively-evaluated missed opportunity is OBSERVATIONAL - the MFE/MAE outcome is real
 * price data, but nothing about it was ever risk-checked or sized, so it can never carry EXECUTED
 * trust no matter how favorable the excursion looks in hindsight.
 */
export async function recordMissedOpportunityObservation(
  miss: typeof missedOpportunities.$inferSelect,
  now: Date = new Date(),
): Promise<void> {
  if (miss.evaluationStatus !== 'EVALUATED') return;
  const record: LearningObservation = {
    id: makeId('miss', miss.symbol, now),
    symbol: miss.symbol,
    observationType: 'MISSED_OPPORTUNITY',
    trustLevel: 'OBSERVATIONAL',
    evidenceJson: JSON.stringify({
      classification: miss.classification,
      classificationReason: miss.classificationReason,
      priceAtDetection: miss.priceAtDetection,
    }),
    outcomeJson: JSON.stringify({
      maxFavorableExcursionPct: miss.maxFavorableExcursionPct,
      maxAdverseExcursionPct: miss.maxAdverseExcursionPct,
    }),
    createdAt: now.toISOString(),
  };
  await persist(record);
}

export interface LearningObservationFilter {
  observationType?: ObservationType;
  trustLevel?: TrustLevel;
  sinceIso?: string;
  limit?: number;
}

export async function getLearningObservations(filter: LearningObservationFilter = {}): Promise<Array<typeof learningObservations.$inferSelect>> {
  const conditions = [];
  if (filter.observationType) conditions.push(eq(learningObservations.observationType, filter.observationType));
  if (filter.trustLevel) conditions.push(eq(learningObservations.trustLevel, filter.trustLevel));
  if (filter.sinceIso) conditions.push(gte(learningObservations.createdAt, filter.sinceIso));
  const limit = Math.min(500, Math.max(1, filter.limit ?? 100));

  const query = db.select().from(learningObservations);
  const rows = conditions.length > 0
    ? await query.where(and(...conditions)).orderBy(desc(learningObservations.createdAt)).limit(limit)
    : await query.orderBy(desc(learningObservations.createdAt)).limit(limit);
  return rows;
}

export interface TrustLevelBreakdown {
  executed: number;
  observational: number;
  byType: Record<ObservationType, number>;
}

export async function getTrustLevelBreakdown(sinceIso: string): Promise<TrustLevelBreakdown> {
  const rows = await db.select().from(learningObservations).where(gte(learningObservations.createdAt, sinceIso));
  const breakdown: TrustLevelBreakdown = {
    executed: 0,
    observational: 0,
    byType: { CLOSED_TRADE: 0, REJECTED_CANDIDATE: 0, MISSED_OPPORTUNITY: 0 },
  };
  for (const r of rows) {
    if (r.trustLevel === 'EXECUTED') breakdown.executed++;
    else breakdown.observational++;
    breakdown.byType[r.observationType as ObservationType] = (breakdown.byType[r.observationType as ObservationType] ?? 0) + 1;
  }
  return breakdown;
}
