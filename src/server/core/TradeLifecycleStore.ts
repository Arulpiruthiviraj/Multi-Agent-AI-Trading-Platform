/**
 * Durable trade-lifecycle transitions. EventBus memory is not the journal.
 */
import { db } from '../db';
import * as schema from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export async function persistLifecycleTransition(input: {
  candidateId: string;
  symbol: string;
  state: string;
  reason?: string | null;
  source?: string | null;
  evidence?: unknown;
  latencyMs?: number | null;
}): Promise<void> {
  try {
    await db.insert(schema.tradeLifecycleTransitions).values({
      id: uuidv4(),
      candidateId: input.candidateId,
      symbol: input.symbol,
      state: input.state,
      reason: input.reason ?? null,
      source: input.source ?? null,
      evidenceJson: input.evidence ? JSON.stringify(input.evidence) : null,
      latencyMs: input.latencyMs ?? null,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[TradeLifecycle] persist failed', e);
  }
}

export async function listLifecycleForCandidate(candidateId: string) {
  return db.select().from(schema.tradeLifecycleTransitions)
    .where(eq(schema.tradeLifecycleTransitions.candidateId, candidateId))
    .orderBy(desc(schema.tradeLifecycleTransitions.createdAt));
}

export async function listRecentLifecycle(limit = 50) {
  return db.select().from(schema.tradeLifecycleTransitions)
    .orderBy(desc(schema.tradeLifecycleTransitions.createdAt))
    .limit(limit);
}
