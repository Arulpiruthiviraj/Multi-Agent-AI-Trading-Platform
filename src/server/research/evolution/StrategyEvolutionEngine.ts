/**
 * ==========================================================
 * Module: research/evolution/StrategyEvolutionEngine
 *
 * The orchestrator (Sections 4/13/17/26). Ties together: EvolutionScheduler (evidence gate) ->
 * ParameterMutation (bounded candidate generation) -> StrategyCandidateLedger (persistence +
 * lineage) -> CandidateEvaluator/CandidateWalkForward (real, evidence-gated evaluation via the
 * canonical NEXT_BAR_OPEN engine) -> promotionEngine.ts's real StrategyLifecycleStatus ladder.
 *
 * Never touches ChiefTraderAgent, RiskEngine, OrderManagement, or BrokerManager — this is a pure
 * research/evolution subsystem, exactly like research/intelligence/ (same isolation contract,
 * enforced by an equivalent boundary test). A candidate reaching even LIVE_APPROVED status here
 * does NOT itself place any order — that would require a still-nonexistent, separately-designed
 * bridge from a graduated strategy into the live idea-generation path (out of scope; see final
 * report's "remaining limitations").
 * ==========================================================
 */
import { computeStrategyId } from '../../strategiesEngine/core/id';
import type { StrategyDefinition } from '../../strategiesEngine/core/types';
import type { CanonicalDataset } from '../ohlcvTypes';
import { generateBoundedMutations } from './ParameterMutation';
import { evaluateCandidate } from './CandidateEvaluator';
import { runCandidateWalkForward } from './CandidateWalkForward';
import { checkEvolutionReadiness } from './EvolutionScheduler';
import { createCandidate, transitionCandidate } from './StrategyCandidateLedger';
import type { StrategyCandidateRecord, CandidateEvaluationRecord } from './types';
import { assertPromotionQuarantine } from '../promotionEngine';
import { researchSafety } from '../../config/researchSafety';
import { emitResearchEvent } from '../intelligence/researchEventLog';

function evaluationRecordFrom(dataset: CanonicalDataset, result: ReturnType<typeof evaluateCandidate>): CandidateEvaluationRecord {
  return {
    datasetId: result.datasetId,
    datasetHash: result.datasetHash,
    symbol: result.symbol,
    timeframe: result.timeframe,
    periodStart: dataset.bars[0] ? new Date(dataset.bars[0].timestamp).toISOString() : '',
    periodEnd: dataset.bars[dataset.bars.length - 1] ? new Date(dataset.bars[dataset.bars.length - 1].timestamp).toISOString() : '',
    executionModel: result.executionModel,
    costModel: result.costModel,
    randomSeed: null, // deterministic bar-by-bar evaluation — no randomness to seed
    backtestPass: result.backtestPass,
    rejection: result.rejection,
    metrics: {
      tradeCount: result.metrics.tradeCount,
      winRate: result.metrics.winRate,
      expectancy: result.metrics.expectancy,
      profitFactor: result.metrics.profitFactor,
      maxDrawdown: result.metrics.maxDrawdown,
      sharpe: result.metrics.sharpe.value,
    },
    evaluatedAt: result.createdAt,
  };
}

function buildMutatedDefinition(parent: StrategyDefinition, parameterValues: Record<string, number | string | boolean>): StrategyDefinition {
  const id = computeStrategyId({
    family: parent.family,
    name: parent.name,
    version: parent.version,
    entryConditions: parent.entryConditions,
    confirmationConditions: parent.confirmationConditions,
    invalidationConditions: parent.invalidationConditions,
    exitConditions: parent.exitConditions,
    stopLoss: parent.stopLoss,
    takeProfit: parent.takeProfit,
    positionSizing: parent.positionSizing,
    parameterValues,
  });
  return {
    ...parent,
    id,
    parameterValues,
    evidenceState: 'UNTESTED',
    metadata: { ...parent.metadata, origin: 'GENERATED', derivedFromId: parent.id, createdAt: new Date().toISOString() },
  };
}

export interface EvolutionCycleResult {
  ran: boolean;
  reason: string;
  candidates: StrategyCandidateRecord[];
}

/**
 * Runs one evolution cycle from a seeded parent. `force` bypasses the evidence gate — for tests
 * and the Section 33 end-to-end demonstration only; never set true by any scheduled/automatic
 * caller (there is none yet — this engine has no cron/interval wiring, matching Section 17's
 * explicit "do not run evolution after every trade" and Section 31's "organic paper trades first").
 */
export async function runEvolutionCycle(opts: {
  parentCandidateId: string | null;
  parentDefinition: StrategyDefinition;
  parentGeneration: number;
  dataset: CanonicalDataset;
  maxCandidates?: number;
  force?: boolean;
}): Promise<EvolutionCycleResult> {
  if (!opts.force) {
    const readiness = await checkEvolutionReadiness();
    if (!readiness.ready) {
      return { ran: false, reason: readiness.reason, candidates: [] };
    }
  }

  emitResearchEvent('EVOLUTION_CYCLE_STARTED', { researchRunId: opts.parentCandidateId ?? opts.parentDefinition.id, reason: 'evidence gate cleared or forced' } as any);

  const mutations = generateBoundedMutations(opts.parentDefinition, { maxCandidates: opts.maxCandidates });
  const results: StrategyCandidateRecord[] = [];

  for (const mutation of mutations) {
    const definition = buildMutatedDefinition(opts.parentDefinition, mutation.parameterValues);
    const record = await createCandidate({
      parentCandidateId: opts.parentCandidateId,
      generation: opts.parentGeneration + 1,
      source: 'MUTATION',
      reason: mutation.reason,
      definition,
    });

    // Stage 1: single-period canonical backtest.
    const backtest = evaluateCandidate(definition, opts.dataset);
    if (!backtest.backtestPass) {
      await transitionCandidate({
        candidateId: record.id,
        toStatus: 'BACKTEST_ONLY',
        reason: backtest.rejection ?? 'Backtest did not pass',
        rejectionReason: backtest.rejection,
        evaluation: evaluationRecordFrom(opts.dataset, backtest),
        eventType: 'CANDIDATE_BACKTEST_FAILED',
      });
      results.push({ ...record, lifecycleStatus: 'BACKTEST_ONLY', rejectionReason: backtest.rejection });
      continue; // Section 26: failed backtests cannot advance
    }
    await transitionCandidate({
      candidateId: record.id,
      toStatus: 'BACKTEST_ONLY',
      reason: `Backtest passed: ${backtest.metrics.tradeCount} trades, expectancy ${backtest.metrics.expectancy}`,
      evaluation: evaluationRecordFrom(opts.dataset, backtest),
      eventType: 'CANDIDATE_BACKTEST_STARTED',
    });

    // Stage 2: walk-forward (this engine's own fold structure already IS the OOS mechanism —
    // see coreWalkForward.ts's own note; OOS_TESTING is the walk-forward's own in-progress state).
    await transitionCandidate({ candidateId: record.id, toStatus: 'OOS_TESTING', reason: 'Entering walk-forward evaluation', eventType: 'CANDIDATE_OOS_STARTED' });
    const wfo = runCandidateWalkForward(definition, opts.dataset);
    if (wfo.status !== 'COMPLETED') {
      await transitionCandidate({
        candidateId: record.id,
        toStatus: 'OOS_TESTING',
        reason: `Walk-forward ${wfo.status}: ${wfo.foldCount} folds`,
        rejectionReason: wfo.status,
        eventType: 'CANDIDATE_OOS_FAILED',
      });
      results.push({ ...record, lifecycleStatus: 'OOS_TESTING', rejectionReason: wfo.status });
      continue; // Section 26: failed OOS/walk-forward cannot advance
    }
    await transitionCandidate({
      candidateId: record.id,
      toStatus: 'WALK_FORWARD_TESTING',
      reason: `Walk-forward COMPLETED: ${wfo.foldCount} folds, median OOS expectancy ${wfo.medianTestExpectancy}`,
      eventType: 'CANDIDATE_WALK_FORWARD_STARTED',
    });

    // Stage 3: paper testing is NOT simulated — requires real organic paper volume for THIS
    // specific candidate, which cannot exist yet (Section 31). The candidate stops here,
    // correctly, until a real operator/future process supplies that evidence.
    results.push({ ...record, lifecycleStatus: 'WALK_FORWARD_TESTING' });
  }

  return { ran: true, reason: `Evaluated ${mutations.length} candidate(s)`, candidates: results };
}

/**
 * Attempts real promotion past WALK_FORWARD_TESTING. Requires BOTH the real
 * assertPromotionQuarantine() (unmodified, unweakened) AND real organic paper evidence for this
 * exact candidate (researchSafety.minPaperTrades) — never bypassed, never LLM-authorized.
 */
export async function attemptPromotion(opts: {
  candidateId: string;
  qualityStatus: string;
  parquetBytesWritten: boolean;
  executionModel: string;
  organicPaperTradeCountForCandidate: number;
}): Promise<{ promoted: boolean; reasons: string[] }> {
  const quarantine = assertPromotionQuarantine({
    executionModel: opts.executionModel,
    qualityStatus: opts.qualityStatus,
    parquetBytesWritten: opts.parquetBytesWritten,
  });
  const reasons = [...quarantine.reasons];
  if (opts.organicPaperTradeCountForCandidate < researchSafety.minPaperTrades) {
    reasons.push(`INSUFFICIENT_PAPER_EVIDENCE: ${opts.organicPaperTradeCountForCandidate} < ${researchSafety.minPaperTrades}`);
  }
  if (reasons.length > 0) {
    await transitionCandidate({
      candidateId: opts.candidateId,
      toStatus: 'WALK_FORWARD_TESTING',
      reason: reasons.join('; '),
      rejectionReason: reasons.join('; '),
      eventType: 'CANDIDATE_PROMOTION_BLOCKED',
    });
    return { promoted: false, reasons };
  }
  await transitionCandidate({ candidateId: opts.candidateId, toStatus: 'VALIDATED', reason: 'All promotion gates passed', eventType: 'CANDIDATE_VALIDATED' });
  await transitionCandidate({ candidateId: opts.candidateId, toStatus: 'LIVE_CANDIDATE', reason: 'Promotion gates passed; awaiting manual LIVE_APPROVED (no auto-LIVE)', eventType: 'CANDIDATE_PROMOTED' });
  return { promoted: true, reasons: [] };
}
