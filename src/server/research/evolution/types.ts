/**
 * ==========================================================
 * Module: research/evolution/types
 *
 * Controlled Self-Evolving Trading System (2026-08-26). Shared types for the strategy-evolution
 * layer built ON TOP OF existing infrastructure — this file introduces NO new "genome" concept.
 * The genome IS strategiesEngine/core/types.ts's real StrategyDefinition (deterministic id,
 * entry/confirmation/invalidation/exit condition trees, stop/target/sizing rules, declared
 * StrategyParameterDef[] bounds, parameterValues, metadata.origin/derivedFromId) — confirmed via
 * direct audit to already be exactly what Section 5's "Strategy Genome" asked for. This module
 * only adds what audit confirmed is genuinely missing: a generation counter, bounded numeric
 * mutation (as opposed to strategiesEngine's existing full-grid Cartesian enumeration), candidate
 * lineage/persistence, and a REAL evidence-gated bridge into the canonical NEXT_BAR_OPEN
 * backtest/promotion pipeline (promotionEngine.ts) — which strategiesEngine's OWN promoteEvidence()
 * does NOT provide (confirmed: it is a pure ladder-order + reason-string check, zero quantitative
 * evidence required). This module never weakens, replaces, or bypasses assertPromotionQuarantine().
 * ==========================================================
 */
import type { StrategyDefinition } from '../../strategiesEngine/core/types';
import type { StrategyLifecycleStatus } from '../promotionEngine';

/** Where a candidate's parameter values came from. */
export type CandidateSource = 'MUTATION' | 'LLM_HYPOTHESIS' | 'SEED';

export interface CandidateEvolutionMetadata {
  /** Real generation counter — 0 for a hand-authored/seeded BASE, parent.generation+1 for a mutation. */
  generation: number;
  parentCandidateId: string | null;
  source: CandidateSource;
  /** Human/LLM-readable reason this candidate was proposed — never optional, matches
   *  strategiesEngine's own promoteEvidence() requirement that every transition states a reason. */
  reason: string;
}

/** One row of real, persisted candidate state (strategy_candidates table). The StrategyDefinition
 *  itself is stored as JSON (definitionJson) — it is a real, existing, fully-serializable type,
 *  not re-modeled here. */
export interface StrategyCandidateRecord {
  id: string;
  parentCandidateId: string | null;
  generation: number;
  source: CandidateSource;
  reason: string;
  definition: StrategyDefinition;
  /** Canonical (promotionEngine.ts) lifecycle status — the REAL, evidence-gated ladder, never
   *  strategiesEngine's own evidence-free one. */
  lifecycleStatus: StrategyLifecycleStatus;
  championStatus: 'CHAMPION' | 'CHALLENGER' | 'RETIRED' | 'NONE';
  rejectionReason: string | null;
  /** Reproducibility (Section 16): every evaluation's inputs are recorded, never just its output. */
  lastEvaluation: CandidateEvaluationRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface CandidateEvaluationRecord {
  datasetId: string;
  datasetHash: string;
  symbol: string;
  timeframe: string;
  periodStart: string;
  periodEnd: string;
  executionModel: string;
  costModel: string;
  randomSeed: number | null;
  backtestPass: boolean;
  rejection: string | null;
  metrics: {
    tradeCount: number;
    winRate: number | null;
    expectancy: number | null;
    profitFactor: number | null;
    maxDrawdown: number | null;
    sharpe: number | null;
  };
  evaluatedAt: string;
}
