/**
 * Fast Opportunity Lane — real strategy evaluator (research/paper only, NO execution authority).
 *
 * 2026-10-06. Closes the gap found in ARGUS_OCT05_REPLAY_AND_FASTLANE_VALIDATION_2026-10-06.md
 * Phase 6: the Fast Lane previously had a real, correctly-enforced safety boundary but NO
 * evaluation path at all — `FastEvaluationResult` was defined but never constructed. This module
 * answers one question only: "given a detected fast candidate and sufficient contemporaneous
 * data, does any EXISTING Argus strategy produce valid evidence?"
 *
 * Deliberately NOT wired to emitTradeIdea/ChiefTrader in this phase. Evaluation and execution
 * integration are kept separately testable — a later, separately-authorized phase may convert a
 * VALID_STRATEGY_EVIDENCE result into the existing canonical trade-idea pathway. This module
 * cannot place orders, cannot call BrokerManager/OMS, cannot change trading state, cannot enable
 * LIVE — it has no reference to any of those at all (enforced by fastLaneArchitecture.test.ts).
 *
 * Reuses EXISTING production strategy logic, never a duplicate alpha implementation:
 *   - quantSignalAgent.evaluateSymbol(symbol) — the SAME on-demand entry point
 *     ConfluenceCoordinator already calls for a second independent agent's evaluation. Fetches
 *     REAL bars via historicalDataGateway, builds the REAL StrategyContext, runs the REAL
 *     evaluateAll() across whichever strategies are currently live (CORE + any enabled
 *     EXPERIMENTAL). A fast candidate is judged by the same strategy logic every other symbol is.
 *   - bestStrategyIdea(evaluations) — the SAME function OpportunityDiscovery/QuantSignalAgent use
 *     to pick a real, triggered, confidence-qualified idea (triggerMet + MIN_STRATEGY_CONFIDENCE_
 *     TO_TRADE enforced there, never duplicated here).
 */
import { fastLaneManager } from './FastLaneManager';
import { quantSignalAgent } from '../services/QuantSignalAgent';
import { bestStrategyIdea } from '../quant/strategies/StrategyEngine';
import { tradingSafety } from '../config/tradingSafety';
import type { FastEvaluationResult, DataSufficiencyGrade } from './FastOpportunityCandidate';
import {
  logFastEvaluationStarted,
  logFastEvaluationDataReady,
  logFastEvaluationInsufficientData,
  logFastEvaluationNoSetup,
  logFastEvaluationValidEvidence,
  logFastEvaluationExpired,
  logFastEvaluationFailed,
} from './fastLaneObservability';

// 2026-10-06 (concurrency/dedup guard, Fast Lane Evaluator spec §16-17): bounded concurrency +
// same-symbol race prevention. In-memory only, matches the established pattern every sibling
// fast-lane module uses (no new persistent state). Coalesces concurrent calls for the SAME symbol
// onto the SAME in-flight promise rather than running duplicate evaluations.
const inFlightBySymbol = new Map<string, Promise<FastEvaluationResult>>();
const lastEvaluatedAtBySymbol = new Map<string, number>();
let activeEvaluationCount = 0;

function makeResult(
  candidate: { id: string; symbol: string },
  status: FastEvaluationResult['status'],
  reasonCodes: string[],
  extra: Partial<FastEvaluationResult> = {},
): FastEvaluationResult {
  const evaluatedAt = Date.now();
  return {
    id: `${candidate.id}:${evaluatedAt}`,
    candidateId: candidate.id,
    symbol: candidate.symbol,
    evaluatedAt,
    dataAsOf: null,
    marketDataType: 'UNKNOWN',
    strategiesEvaluated: [],
    validTriggers: [],
    status,
    reasonCodes,
    dataSufficiency: {},
    ...extra,
  };
}

/**
 * Evaluates one fast candidate through the real strategy pipeline. Never emits a trade idea,
 * never touches ChiefTrader/RiskEngine/OMS/BrokerManager. Always transitions the candidate's real
 * lifecycle state so its own history honestly reflects what was tried, even when no vote will
 * ever follow from it in this phase.
 *
 * 2026-10-08 (D1): the "never emits" guarantee is now enforced at runtime, not just by module
 * boundary - evaluateSymbol() is called with { emitIdeas: false }, so even the QuantEngine
 * emitTradeIdea and the fire-and-forget JavaCoreEnsemble vote inside the reused production
 * function are suppressed for fast-lane evaluations.
 *
 * 2026-10-08 (D4): a hung evaluateSymbol() promise can no longer leak a concurrency slot
 * forever - the evaluation races a tradingSafety.fastLaneEvaluationTimeoutMs watchdog; on
 * timeout the candidate is terminally transitioned and the slot released via the normal
 * finally path in evaluateFastCandidate().
 */
export async function evaluateFastCandidate(candidateId: string): Promise<FastEvaluationResult> {
  const candidate = fastLaneManager.getCandidate(candidateId);
  if (!candidate) {
    return makeResult({ id: candidateId, symbol: 'UNKNOWN' }, 'ERROR', ['CANDIDATE_NOT_FOUND']);
  }

  // Expiration check BEFORE any work - no stale momentum resurrection (spec §10).
  if (candidate.state === 'EXPIRED' || Date.now() > candidate.expiresAt) {
    fastLaneManager.transitionState(candidateId, 'EXPIRED', 'expired before evaluation started');
    logFastEvaluationExpired(candidateId, candidate.symbol);
    return makeResult(candidate, 'EXPIRED', ['CANDIDATE_EXPIRED_BEFORE_EVALUATION']);
  }

  // Dedup: coalesce concurrent calls for the same symbol onto one in-flight evaluation.
  const existing = inFlightBySymbol.get(candidate.symbol);
  if (existing) return existing;

  // Per-symbol cooldown: prevent repeated near-simultaneous detections from re-evaluating the
  // same symbol faster than fastLaneSymbolEvaluationCooldownMs.
  const lastAt = lastEvaluatedAtBySymbol.get(candidate.symbol);
  if (lastAt != null && Date.now() - lastAt < tradingSafety.fastLaneSymbolEvaluationCooldownMs) {
    return makeResult(candidate, 'ERROR', ['SYMBOL_EVALUATION_COOLDOWN_ACTIVE']);
  }

  // Bounded concurrency: refuse new evaluations once the governor's limit is reached, rather than
  // flooding the historical-bar provider with an unbounded fan-out.
  if (activeEvaluationCount >= tradingSafety.fastLaneMaxConcurrentEvaluations) {
    return makeResult(candidate, 'ERROR', ['MAX_CONCURRENT_EVALUATIONS_REACHED']);
  }

  const promise = runEvaluation(candidateId, candidate.symbol);
  inFlightBySymbol.set(candidate.symbol, promise);
  activeEvaluationCount += 1;
  try {
    return await promise;
  } finally {
    activeEvaluationCount -= 1;
    inFlightBySymbol.delete(candidate.symbol);
    lastEvaluatedAtBySymbol.set(candidate.symbol, Date.now());
  }
}

async function runEvaluation(candidateId: string, symbol: string): Promise<FastEvaluationResult> {
  const candidate = fastLaneManager.getCandidate(candidateId);
  if (!candidate) return makeResult({ id: candidateId, symbol }, 'ERROR', ['CANDIDATE_NOT_FOUND']);

  fastLaneManager.transitionState(candidateId, 'EVALUATING', 'real strategy evaluation via quantSignalAgent.evaluateSymbol');
  logFastEvaluationStarted(candidateId, symbol);

  const dataSufficiency: Record<string, DataSufficiencyGrade> = {};

  let evaluation: Awaited<ReturnType<typeof quantSignalAgent.evaluateSymbol>> = null;
  // D4 (2026-10-08): liveness watchdog. evaluateSymbol() is awaited, but a promise that never
  // settles would skip the finally in evaluateFastCandidate() and permanently leak one of the
  // bounded concurrency slots. Race it against the configured timeout; on timeout the candidate
  // is terminally transitioned (NO_SETUP with an honest reason) and the slot is released.
  // D1 (2026-10-08): { emitIdeas: false } - this is a pure evaluation, never a vote.
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, tradingSafety.fastLaneEvaluationTimeoutMs);
    });
    evaluation = await Promise.race([
      quantSignalAgent.evaluateSymbol(symbol, { emitIdeas: false }),
      timeoutPromise,
    ]);
  } catch (e) {
    logFastEvaluationFailed(candidateId, symbol, e instanceof Error ? e.name : 'UNKNOWN_ERROR');
    fastLaneManager.transitionState(candidateId, 'NO_SETUP', 'strategy evaluation threw');
    return makeResult(candidate, 'ERROR', ['EVALUATION_THREW'], { dataSufficiency });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  if (timedOut) {
    // The underlying promise may still be pending; it holds no slot (the slot is released by the
    // caller) and its eventual settlement is discarded - it can no longer transition this
    // terminally-closed candidate because expireStale() deletes terminal records.
    logFastEvaluationFailed(candidateId, symbol, 'EVALUATION_TIMEOUT');
    fastLaneManager.transitionState(
      candidateId,
      'NO_SETUP',
      `strategy evaluation exceeded fastLaneEvaluationTimeoutMs (${tradingSafety.fastLaneEvaluationTimeoutMs}ms) - abandoned, slot released`,
    );
    return makeResult(candidate, 'ERROR', ['EVALUATION_TIMEOUT'], { dataSufficiency });
  }

  if (!evaluation) {
    // Real, honest reason: quantSignalAgent.evaluateSymbol() returns null when fewer than
    // MIN_BARS_TO_EVALUATE real bars are available in historicalDataGateway - never fabricated
    // data to force a verdict. This is also the real answer for MXL/SYNA/MPWR (zero cached bars)
    // and WOLF (stale daily-only bars) - see ARGUS_FAST_EVALUATOR_OCT05_CASE_STUDY.md.
    dataSufficiency.bars = 'MISSING';
    logFastEvaluationInsufficientData(candidateId, symbol, ['INSUFFICIENT_REAL_BARS']);
    fastLaneManager.transitionState(candidateId, 'NO_SETUP', 'insufficient real bars to evaluate');
    return makeResult(candidate, 'INSUFFICIENT_DATA', ['INSUFFICIENT_REAL_BARS'], { dataSufficiency });
  }

  dataSufficiency.bars = 'AVAILABLE';
  logFastEvaluationDataReady(candidateId, symbol, Date.now());

  const strategiesEvaluated = evaluation.strategyEvaluations.map((e) => e.strategy);
  const validTriggers = evaluation.strategyEvaluations.filter((e) => e.triggerMet).map((e) => e.strategy);
  const idea = bestStrategyIdea(evaluation.strategyEvaluations);

  if (!idea) {
    logFastEvaluationNoSetup(candidateId, symbol, strategiesEvaluated);
    fastLaneManager.transitionState(candidateId, 'NO_SETUP', 'no strategy cleared triggerMet + MIN_STRATEGY_CONFIDENCE_TO_TRADE');
    return makeResult(candidate, 'NO_VALID_SETUP', ['NO_STRATEGY_CLEARED_TRIGGER_AND_CONFIDENCE_BAR'], {
      strategiesEvaluated, validTriggers, dataSufficiency, marketDataType: 'CACHED_BARS',
    });
  }

  logFastEvaluationValidEvidence(candidateId, symbol, idea.strategy, idea.confidence);
  fastLaneManager.transitionState(candidateId, 'ACTIONABLE', `real triggered setup: ${idea.strategy}`);
  return makeResult(candidate, 'VALID_STRATEGY_EVIDENCE', ['TRIGGER_MET_CONFIDENCE_QUALIFIED'], {
    strategiesEvaluated,
    validTriggers,
    bestStrategy: idea.strategy,
    direction: idea.side,
    confidence: idea.confidence,
    dataSufficiency,
    marketDataType: 'CACHED_BARS',
  });
}

/** For tests: clear concurrency/cooldown state between runs. */
export function resetFastLaneEvaluatorForTests(): void {
  inFlightBySymbol.clear();
  lastEvaluatedAtBySymbol.clear();
  activeEvaluationCount = 0;
}

/** For tests/observability: current in-flight evaluation count. */
export function fastLaneActiveEvaluationCountForTests(): number {
  return activeEvaluationCount;
}
