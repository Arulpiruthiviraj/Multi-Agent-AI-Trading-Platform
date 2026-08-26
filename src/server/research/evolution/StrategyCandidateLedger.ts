/**
 * Candidate persistence + lineage (Section 15/16). New `strategy_candidates` +
 * `strategy_evolution_events` tables (audit found no existing table fits — strategy_configurations
 * has no lineage/generation concept; strategy_engine_promotions tracks strategiesEngine's OWN
 * evidence-free ladder, not the canonical evidence-gated one this module uses). Consolidated into
 * one row per candidate rather than the 8 separate tables the task brief speculatively listed —
 * real evidence substance is referenced (evaluationJson), never duplicated from
 * quant_strategy_backtests-style tables.
 */
import { randomUUID } from 'crypto';
import { db } from '../../db';
import { strategyCandidates, strategyEvolutionEvents } from '../../db/schema';
import { eq, desc } from 'drizzle-orm';
import type { StrategyDefinition } from '../../strategiesEngine/core/types';
import type { StrategyLifecycleStatus } from '../promotionEngine';
import type { CandidateEvaluationRecord, CandidateSource, StrategyCandidateRecord } from './types';
import { emitResearchEvent, type ResearchEventKey } from '../intelligence/researchEventLog';

export async function createCandidate(opts: {
  parentCandidateId: string | null;
  generation: number;
  source: CandidateSource;
  reason: string;
  definition: StrategyDefinition;
}): Promise<StrategyCandidateRecord> {
  const now = new Date().toISOString();
  const id = opts.definition.id || randomUUID();
  await db.insert(strategyCandidates).values({
    id,
    parentCandidateId: opts.parentCandidateId,
    generation: opts.generation,
    source: opts.source,
    reason: opts.reason,
    definitionJson: JSON.stringify(opts.definition),
    lifecycleStatus: 'UNTESTED',
    championStatus: 'NONE',
    createdAt: now,
    updatedAt: now,
  });
  await recordEvolutionEvent(id, 'CANDIDATE_GENERATED', { fromStatus: null, toStatus: 'UNTESTED', reason: opts.reason });
  return {
    id,
    parentCandidateId: opts.parentCandidateId,
    generation: opts.generation,
    source: opts.source,
    reason: opts.reason,
    definition: opts.definition,
    lifecycleStatus: 'UNTESTED',
    championStatus: 'NONE',
    rejectionReason: null,
    lastEvaluation: null,
    createdAt: now,
    updatedAt: now,
  };
}

function toRecord(row: typeof strategyCandidates.$inferSelect): StrategyCandidateRecord {
  return {
    id: row.id,
    parentCandidateId: row.parentCandidateId,
    generation: row.generation,
    source: row.source as CandidateSource,
    reason: row.reason,
    definition: JSON.parse(row.definitionJson) as StrategyDefinition,
    lifecycleStatus: row.lifecycleStatus as StrategyLifecycleStatus,
    championStatus: row.championStatus as StrategyCandidateRecord['championStatus'],
    rejectionReason: row.rejectionReason,
    lastEvaluation: row.evaluationJson ? (JSON.parse(row.evaluationJson) as CandidateEvaluationRecord) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCandidate(id: string): Promise<StrategyCandidateRecord | null> {
  const rows = await db.select().from(strategyCandidates).where(eq(strategyCandidates.id, id));
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Real lineage: parent -> children, one hop at a time (matches the "one parameter changed per candidate" convention). */
export async function getLineage(candidateId: string): Promise<StrategyCandidateRecord[]> {
  const chain: StrategyCandidateRecord[] = [];
  let current = await getCandidate(candidateId);
  while (current) {
    chain.unshift(current);
    current = current.parentCandidateId ? await getCandidate(current.parentCandidateId) : null;
  }
  return chain;
}

export async function listByStatus(status: StrategyLifecycleStatus): Promise<StrategyCandidateRecord[]> {
  const rows = await db.select().from(strategyCandidates).where(eq(strategyCandidates.lifecycleStatus, status)).orderBy(desc(strategyCandidates.createdAt));
  return rows.map(toRecord);
}

export async function listChampionsAndChallengers(): Promise<StrategyCandidateRecord[]> {
  const rows = await db.select().from(strategyCandidates).orderBy(desc(strategyCandidates.updatedAt));
  return rows.map(toRecord).filter((r) => r.championStatus === 'CHAMPION' || r.championStatus === 'CHALLENGER');
}

/**
 * Advances (or demotes) a candidate's real lifecycle status, always recording WHY (reproducibility,
 * Section 16) and always emitting an auditable event (Section 24) — never a silent status write.
 */
export async function transitionCandidate(opts: {
  candidateId: string;
  toStatus: StrategyLifecycleStatus;
  reason: string;
  rejectionReason?: string | null;
  evaluation?: CandidateEvaluationRecord | null;
  eventType: ResearchEventKey;
}): Promise<void> {
  const current = await getCandidate(opts.candidateId);
  if (!current) throw new Error(`Unknown candidate: ${opts.candidateId}`);
  const now = new Date().toISOString();
  await db.update(strategyCandidates).set({
    lifecycleStatus: opts.toStatus,
    rejectionReason: opts.rejectionReason ?? null,
    evaluationJson: opts.evaluation ? JSON.stringify(opts.evaluation) : undefined,
    updatedAt: now,
  }).where(eq(strategyCandidates.id, opts.candidateId));
  await recordEvolutionEvent(opts.candidateId, opts.eventType, {
    fromStatus: current.lifecycleStatus,
    toStatus: opts.toStatus,
    reason: opts.reason,
    detail: opts.evaluation ?? undefined,
  });
}

export async function setChampionStatus(candidateId: string, status: StrategyCandidateRecord['championStatus'], reason: string): Promise<void> {
  await db.update(strategyCandidates).set({ championStatus: status, updatedAt: new Date().toISOString() }).where(eq(strategyCandidates.id, candidateId));
  await recordEvolutionEvent(candidateId, status === 'CHAMPION' ? 'CANDIDATE_PROMOTED' : 'CANDIDATE_REJECTED', { reason });
}

async function recordEvolutionEvent(
  candidateId: string,
  eventType: ResearchEventKey,
  opts: { fromStatus?: string | null; toStatus?: string | null; reason: string; detail?: unknown },
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(strategyEvolutionEvents).values({
    id: randomUUID(),
    candidateId,
    eventType,
    fromStatus: opts.fromStatus ?? null,
    toStatus: opts.toStatus ?? null,
    reason: opts.reason,
    detailJson: opts.detail !== undefined ? JSON.stringify(opts.detail) : null,
    createdAt: now,
  });
  emitResearchEvent(eventType, { researchRunId: candidateId, symbol: undefined });
}
