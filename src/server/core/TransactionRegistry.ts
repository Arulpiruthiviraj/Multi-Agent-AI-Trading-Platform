/**
 * ==========================================================
 * Module: TransactionRegistry
 *
 * Purpose:
 * Phase 0 of TRANSACTION_OBSERVATORY_ARCHITECTURE.md. Mints the canonical `transactions.id`
 * (human-readable `ARG-YYYY-MM-DD-NNNNNN`) and persists ChiefTraderAgent's consensus math as
 * first-class, queryable rows (`consensus_decisions`, `consensus_evidence`) instead of leaving
 * it recoverable only by JSON-parsing one event payload.
 *
 * This is also the fix for the real bug the architecture doc identifies as the top blocker:
 * every contributing agent's own event carries its OWN self-generated traceId (three different
 * formats across agents) and ChiefTraderAgent groups ideas by symbol, not traceId - so the
 * "trade" that reaches RiskEngine today carries only one arbitrary contributing agent's id,
 * orphaning the others. `consensusEvidence` rows link the new canonical transaction id to every
 * contributing agent's evidence (via `sourceTraceId`, a soft reference - agent_predictions has
 * no stable id to hard-FK against yet; that's Phase 1) regardless of which agent's own id
 * happened to trigger the consensus cycle.
 * ==========================================================
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { like } from 'drizzle-orm';

// In-memory daily counter, reseeded from the DB on the first mint of a new calendar day. Safe
// against restarts (reseeds from real DB rows) and against the common case (single-threaded
// Node, no other writer mints ARG- ids) - not hardened against a same-tick race exactly at a
// midnight boundary, an acceptable gap for a cosmetic, non-unique-constrained display id (the
// real primary key uniqueness is still enforced by SQLite regardless).
let seededDate: string | null = null;
let counter = 0;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

async function mintTransactionId(): Promise<string> {
  const today = todayStr();
  if (seededDate !== today) {
    const rows = await db.select().from(schema.transactions)
      .where(like(schema.transactions.id, `ARG-${today}-%`));
    counter = rows.length;
    seededDate = today;
  }
  counter += 1;
  return `ARG-${today}-${String(counter).padStart(6, '0')}`;
}

export interface ConsensusEvidenceInput {
  sourceTraceId?: string;
  agent: string;
  side: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  weight: number;
  reasoning?: string;
  currentPrice?: number;
}

export interface RecordConsensusParams {
  symbol: string;
  side: 'BUY' | 'SELL' | 'HOLD';
  weightedConfidence: number;
  threshold: number;
  approved: boolean;
  reasoning?: string;
  debateUsed?: boolean;
  debateProviderCount?: number;
  evidence: ConsensusEvidenceInput[];
}

/**
 * Mints a new transaction id and persists the consensus decision + all contributing evidence
 * in one call. Used for BOTH outcomes: an approved consensus (status 'OPEN', proceeds to
 * risk/order stages in later phases) and a resolved-without-consensus window (status
 * 'NO_CONSENSUS', immediately terminal - lets future investigation answer "why didn't Argus
 * trade AAPL even though 3 agents said BUY").
 */
export async function recordConsensusTransaction(params: RecordConsensusParams): Promise<string> {
  const id = await mintTransactionId();
  const now = new Date().toISOString();
  const agreements = params.evidence.filter(e => e.side === params.side);
  const disagreements = params.evidence.filter(e => e.side !== params.side);

  await db.insert(schema.transactions).values({
    id,
    symbol: params.symbol,
    openedAt: now,
    closedAt: params.approved ? null : now,
    status: params.approved ? 'OPEN' : 'NO_CONSENSUS',
    finalDecision: params.approved ? params.side : null,
    outcome: params.approved ? 'PENDING' : 'N_A',
  });

  await db.insert(schema.consensusDecisions).values({
    transactionId: id,
    symbol: params.symbol,
    side: params.side,
    weightedConfidence: params.weightedConfidence,
    threshold: params.threshold,
    approved: params.approved,
    agreementsCount: agreements.length,
    disagreementsCount: disagreements.length,
    debateUsed: params.debateUsed ?? false,
    debateProviderCount: params.debateProviderCount,
    reasoning: params.reasoning,
    createdAt: now,
  });

  if (params.evidence.length > 0) {
    await db.insert(schema.consensusEvidence).values(
      params.evidence.map(e => ({
        transactionId: id,
        sourceTraceId: e.sourceTraceId,
        agent: e.agent,
        side: e.side,
        confidence: e.confidence,
        weight: e.weight,
        reasoning: e.reasoning,
        agreed: e.side === params.side,
        currentPrice: e.currentPrice,
      }))
    );
  }

  return id;
}
