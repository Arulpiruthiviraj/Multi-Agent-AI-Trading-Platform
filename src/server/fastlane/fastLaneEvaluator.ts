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
  logFastLeaseAcquired,
  logFastLeaseCallerTimeout,
  logFastLeaseSettled,
  logFastLeaseQuarantined,
  logFastLeaseLateSettleDiscarded,
} from './fastLaneObservability';
import type {
  FastLaneLeaseBookSnapshot,
  FastLaneLeaseSnapshot,
  FastLaneLeaseWorkState,
} from './fastLaneObservability';

// 2026-10-06 (concurrency/dedup guard, Fast Lane Evaluator spec §16-17): bounded concurrency +
// same-symbol race prevention. In-memory only, matches the established pattern every sibling
// fast-lane module uses (no new persistent state).
//
// 2026-10-09 (P1 fast-lane lease fix): the concurrency slot and the per-symbol dedup entry are
// now ONE indivisible unit — the LEASE. The old D4 design released both on caller timeout while
// the underlying evaluateSymbol() promise could still be running, which caused (1) invisible
// concurrency (the governor believed a slot was free while work continued) and (2) duplicate
// replacement evaluations for the same symbol, defeating the dedup guard. The lease is now held
// until the underlying work SETTLES (resolves or rejects) — never released on caller timeout.
// On timeout the caller gets its timeout result immediately, but the lease stays on the book in
// CALLER_TIMED_OUT state; when the late work settles, its result is discarded (the candidate was
// already terminally transitioned) and it can never double-apply a state transition.
type LeaseState = FastLaneLeaseWorkState;

interface FastLaneLease {
  candidateId: string;
  symbol: string;
  /** Generation the lease was acquired in; stale async continuations from an older generation
   *  (e.g. after resetFastLaneEvaluatorForTests) can never touch new-generation state. */
  generation: number;
  acquiredAt: number;
  state: LeaseState;
  /** Whether this lease currently holds one of the bounded concurrency slots. A quarantined
   *  lease returns its slot to the pool while keeping the dedup entry. */
  slotHeld: boolean;
  /** Whether any caller has observed a timeout on this lease (counted once per lease). */
  timedOut: boolean;
  /** Resolves ONLY when the underlying work settles — never on caller timeout. Concurrent
   *  callers for a RUNNING lease coalesce onto this promise. */
  settlePromise: Promise<FastEvaluationResult>;
}

const leasesBySymbol = new Map<string, FastLaneLease>();
const lastEvaluatedAtBySymbol = new Map<string, number>();
/** Consecutive caller-timeouts per symbol; reset by any evaluation that settles cleanly. */
const consecutiveTimeoutsBySymbol = new Map<string, number>();
let activeEvaluationCount = 0;
/** Bumped by resetFastLaneEvaluatorForTests; stale async continuations carry the old value. */
let evaluatorGeneration = 0;

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

/** True only if this lease is still the authoritative owner of its symbol's evaluation slot. */
function isLeaseAuthoritative(lease: FastLaneLease): boolean {
  return lease.generation === evaluatorGeneration
    && leasesBySymbol.get(lease.symbol) === lease
    && lease.state === 'RUNNING';
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
 * 2026-10-09 (P1 lease fix, replaces the old D4 design): the caller races the lease's settle
 * promise against tradingSafety.fastLaneEvaluationTimeoutMs. On timeout the caller receives an
 * EVALUATION_TIMEOUT result and the candidate is terminally transitioned to NO_SETUP — but the
 * LEASE IS KEPT (slot + dedup entry) until the underlying work settles. A second
 * evaluateFastCandidate for the same symbol while the original is in flight (even past caller
 * timeout) is refused via the dedup entry — never a second concurrent evaluation.
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

  // Reap first: a permanently hung task must never hold Fast Lane capacity past its bounded
  // quarantine budget (see reapHungLeases).
  reapHungLeases();

  // Lease dedup: one lease per symbol. While a lease is on the book the symbol is owned -
  // a replacement evaluation must attach to it or be refused, never start concurrent work.
  const existing = leasesBySymbol.get(candidate.symbol);
  if (existing && existing.generation === evaluatorGeneration) {
    if (existing.state === 'QUARANTINED') {
      return makeResult(candidate, 'ERROR', ['FAST_LANE_SYMBOL_QUARANTINED']);
    }
    if (existing.state === 'CALLER_TIMED_OUT') {
      // The original evaluation is still running past its caller timeout. Refuse - the lease
      // (slot + dedup) is held until that work settles, so a replacement would be duplicate
      // concurrent work defeating the dedup guard.
      return makeResult(candidate, 'ERROR', ['PRIOR_EVALUATION_STILL_IN_FLIGHT']);
    }
    // RUNNING: coalesce concurrent calls for the same symbol onto the same in-flight
    // evaluation. Each caller races the settle promise against its own watchdog.
    return existing.settlePromise;
  }

  // Per-symbol cooldown: prevent repeated near-simultaneous detections from re-evaluating the
  // same symbol faster than fastLaneSymbolEvaluationCooldownMs. Anchored at real completion
  // (set in settleLease), not at caller timeout.
  const lastAt = lastEvaluatedAtBySymbol.get(candidate.symbol);
  if (lastAt != null && Date.now() - lastAt < tradingSafety.fastLaneSymbolEvaluationCooldownMs) {
    return makeResult(candidate, 'ERROR', ['SYMBOL_EVALUATION_COOLDOWN_ACTIVE']);
  }

  // Bounded concurrency: refuse new evaluations once the governor's limit is reached, rather than
  // flooding the historical-bar provider with an unbounded fan-out.
  if (activeEvaluationCount >= tradingSafety.fastLaneMaxConcurrentEvaluations) {
    return makeResult(candidate, 'ERROR', ['MAX_CONCURRENT_EVALUATIONS_REACHED']);
  }

  // Acquire the lease BEFORE starting work so a synchronous throw in runEvaluation's sync
  // prefix can never strand a started-but-untracked evaluation.
  const lease: FastLaneLease = {
    candidateId,
    symbol: candidate.symbol,
    generation: evaluatorGeneration,
    acquiredAt: Date.now(),
    state: 'RUNNING',
    slotHeld: true,
    timedOut: false,
    settlePromise: undefined as unknown as Promise<FastEvaluationResult>,
  };
  leasesBySymbol.set(candidate.symbol, lease);
  activeEvaluationCount += 1;
  logFastLeaseAcquired(candidateId, candidate.symbol, lease.generation);

  // The settle promise resolves ONLY when the underlying work settles (result or throw) -
  // never on caller timeout. The rejection path is converted to an ERROR result so attached
  // callers can never observe a rejection and no unhandled rejection can escape.
  lease.settlePromise = (async (): Promise<FastEvaluationResult> => {
    let result: FastEvaluationResult;
    try {
      result = await runEvaluation(candidateId, candidate.symbol, lease);
    } catch (e) {
      // Belt-and-braces: runEvaluation converts evaluateSymbol throws into ERROR results, so
      // this path should be unreachable - but a lease must never reject its attached callers.
      logFastEvaluationFailed(candidateId, candidate.symbol, e instanceof Error ? e.name : 'UNKNOWN_ERROR');
      result = makeResult(candidate, 'ERROR', ['EVALUATION_SETTLE_THREW']);
    }
    settleLease(lease, result);
    return result;
  })();

  // Caller watchdog: the caller gets a bounded wait, but the lease is NOT released here.
  // onCallerTimeout marks the lease CALLER_TIMED_OUT and terminally transitions the candidate;
  // the slot and dedup entry stay held until the work settles.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutGate = new Promise<FastEvaluationResult>((resolve) => {
    timeoutId = setTimeout(() => {
      onCallerTimeout(lease, candidate);
      resolve(makeResult(candidate, 'ERROR', ['EVALUATION_TIMEOUT']));
    }, tradingSafety.fastLaneEvaluationTimeoutMs);
  });
  try {
    return await Promise.race([lease.settlePromise, timeoutGate]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Caller-side timeout handler. Transitions the candidate terminally and marks the lease
 * CALLER_TIMED_OUT - but deliberately does NOT release the slot or the dedup entry. Safe
 * against stale timers (fired after a test reset) and double-fires via the state guard.
 */
function onCallerTimeout(lease: FastLaneLease, candidate: { id: string; symbol: string }): void {
  if (lease.generation !== evaluatorGeneration) return;
  if (leasesBySymbol.get(lease.symbol) !== lease) return;
  if (lease.state !== 'RUNNING') return; // already timed out or quarantined - never regress state
  lease.state = 'CALLER_TIMED_OUT';
  // Count consecutive timeouts once per lease (several attached callers may all observe it).
  if (!lease.timedOut) {
    lease.timedOut = true;
    consecutiveTimeoutsBySymbol.set(
      lease.symbol,
      (consecutiveTimeoutsBySymbol.get(lease.symbol) ?? 0) + 1,
    );
  }
  logFastEvaluationFailed(candidate.id, candidate.symbol, 'EVALUATION_TIMEOUT');
  logFastLeaseCallerTimeout(
    candidate.id,
    candidate.symbol,
    lease.generation,
    Date.now() - lease.acquiredAt,
    consecutiveTimeoutsBySymbol.get(lease.symbol) ?? 0,
  );
  fastLaneManager.transitionState(
    candidate.id,
    'NO_SETUP',
    `strategy evaluation exceeded fastLaneEvaluationTimeoutMs (${tradingSafety.fastLaneEvaluationTimeoutMs}ms) - caller released, lease held until the work settles`,
  );
}

/**
 * Releases a lease when the underlying work settles. Generation- and identity-guarded: a stale
 * continuation (e.g. work that settles after resetFastLaneEvaluatorForTests bumped the
 * generation) can never touch new-generation counters or maps.
 */
function settleLease(lease: FastLaneLease, result: FastEvaluationResult): void {
  if (lease.generation !== evaluatorGeneration) return;
  if (leasesBySymbol.get(lease.symbol) !== lease) return;
  leasesBySymbol.delete(lease.symbol);
  const wasTimedOut = lease.timedOut;
  const wasQuarantined = lease.state === 'QUARANTINED';
  if (lease.slotHeld) {
    lease.slotHeld = false;
    activeEvaluationCount = Math.max(0, activeEvaluationCount - 1);
  }
  // Per-symbol cooldown anchored at real completion.
  lastEvaluatedAtBySymbol.set(lease.symbol, Date.now());
  if (!wasTimedOut) {
    consecutiveTimeoutsBySymbol.delete(lease.symbol);
  }
  logFastLeaseSettled(
    lease.candidateId,
    lease.symbol,
    lease.generation,
    Date.now() - lease.acquiredAt,
    result.status,
    wasTimedOut || wasQuarantined,
  );
  if (wasTimedOut || wasQuarantined) {
    // Late settle: the candidate was already terminally transitioned (by the timeout path, or
    // the lease was quarantined) and runEvaluation's authority guard skipped every post-await
    // transition. The result is discarded here - never double-applied, never emitted.
    logFastLeaseLateSettleDiscarded(lease.candidateId, lease.symbol, lease.generation);
  }
}

/**
 * Bounded hung-work recovery (2026-10-09, hung-work Part 4).
 *
 * Investigation: quantSignalAgent.evaluateSymbol(symbol, options) accepts no AbortSignal and
 * offers no cancellation path; HistoricalDataGateway.ensureBars()/getBars() take no
 * AbortSignal and implement no timeout - the provider fetch cannot be cooperatively cancelled
 * from here without changing the production quant pipeline's signatures (out of scope for the
 * fast lane, which must reuse the production path unchanged). So instead of cancellation, the
 * lane uses bounded QUARANTINE: after fastLaneHungLeaseMaxConsecutiveTimeouts consecutive
 * caller-timeouts for a symbol, or once a lease's age passes fastLaneHungLeaseMaxAgeMs, the
 * lease is quarantined - its concurrency SLOT is returned to the pool (capacity recovers) while
 * its DEDUP ENTRY is kept, so a replacement evaluation for the same symbol is still refused and
 * quarantine can never create duplicate concurrent work. If the hung work ever settles,
 * settleLease discards its result (generation-guarded) and it can never double-apply a
 * candidate transition. Runs on every evaluateFastCandidate admission (bounded: at most
 * fastLaneMaxConcurrentEvaluations + quarantined entries to scan).
 */
function reapHungLeases(): void {
  if (leasesBySymbol.size === 0) return;
  const now = Date.now();
  const maxTimeouts = tradingSafety.fastLaneHungLeaseMaxConsecutiveTimeouts;
  const maxAgeMs = tradingSafety.fastLaneHungLeaseMaxAgeMs;
  for (const lease of leasesBySymbol.values()) {
    if (lease.generation !== evaluatorGeneration) continue;
    if (lease.state === 'QUARANTINED') continue;
    const consecutiveTimeouts = consecutiveTimeoutsBySymbol.get(lease.symbol) ?? 0;
    const ageMs = now - lease.acquiredAt;
    if (consecutiveTimeouts >= maxTimeouts) {
      quarantineLease(lease, 'CONSECUTIVE_TIMEOUTS', consecutiveTimeouts, ageMs);
    } else if (ageMs >= maxAgeMs) {
      quarantineLease(lease, 'MAX_AGE', consecutiveTimeouts, ageMs);
    }
  }
}

function quarantineLease(
  lease: FastLaneLease,
  reason: 'CONSECUTIVE_TIMEOUTS' | 'MAX_AGE',
  consecutiveTimeouts: number,
  ageMs: number,
): void {
  lease.state = 'QUARANTINED';
  if (lease.slotHeld) {
    lease.slotHeld = false;
    activeEvaluationCount = Math.max(0, activeEvaluationCount - 1);
  }
  // The dedup entry (leasesBySymbol) is deliberately KEPT: new evaluations for this symbol are
  // refused with FAST_LANE_SYMBOL_QUARANTINED until the hung work settles and releases it.
  logFastLeaseQuarantined(
    lease.candidateId,
    lease.symbol,
    lease.generation,
    reason,
    ageMs,
    consecutiveTimeouts,
  );
}

async function runEvaluation(
  candidateId: string,
  symbol: string,
  lease: FastLaneLease,
): Promise<FastEvaluationResult> {
  const candidate = fastLaneManager.getCandidate(candidateId);
  if (!candidate) return makeResult({ id: candidateId, symbol }, 'ERROR', ['CANDIDATE_NOT_FOUND']);

  fastLaneManager.transitionState(candidateId, 'EVALUATING', 'real strategy evaluation via quantSignalAgent.evaluateSymbol');
  logFastEvaluationStarted(candidateId, symbol);

  const dataSufficiency: Record<string, DataSufficiencyGrade> = {};

  // D1 (2026-10-08): { emitIdeas: false } - this is a pure evaluation, never a vote.
  // 2026-10-09 (P1 lease fix): NO internal timeout race here anymore. The caller applies its own
  // watchdog; this function awaits the real work to settle. Every post-await candidate
  // transition is guarded by isLeaseAuthoritative: if the caller already timed out (or the
  // lease was quarantined/reset) the candidate was already terminally transitioned, so the late
  // result is discarded - never double-applied, never emitted.
  let evaluation: Awaited<ReturnType<typeof quantSignalAgent.evaluateSymbol>>;
  try {
    evaluation = await quantSignalAgent.evaluateSymbol(symbol, { emitIdeas: false });
  } catch (e) {
    if (!isLeaseAuthoritative(lease)) {
      logFastLeaseLateSettleDiscarded(candidateId, symbol, lease.generation);
      return makeResult(candidate, 'ERROR', ['LATE_SETTLE_DISCARDED'], { dataSufficiency });
    }
    logFastEvaluationFailed(candidateId, symbol, e instanceof Error ? e.name : 'UNKNOWN_ERROR');
    fastLaneManager.transitionState(candidateId, 'NO_SETUP', 'strategy evaluation threw');
    return makeResult(candidate, 'ERROR', ['EVALUATION_THREW'], { dataSufficiency });
  }

  if (!isLeaseAuthoritative(lease)) {
    // Late settle: caller timed out and the candidate is already terminally NO_SETUP (or the
    // lease was quarantined/reset). Discard the late result - it must not resurrect the
    // candidate or emit any evaluation verdict.
    logFastLeaseLateSettleDiscarded(candidateId, symbol, lease.generation);
    return makeResult(candidate, 'ERROR', ['LATE_SETTLE_DISCARDED'], { dataSufficiency });
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

/**
 * For tests: clear concurrency/cooldown/timeout state between runs. Bumps the generation so
 * stale async continuations (late-settling work, pending timeout timers) from the previous
 * generation can never corrupt the fresh state.
 */
export function resetFastLaneEvaluatorForTests(): void {
  evaluatorGeneration += 1;
  leasesBySymbol.clear();
  lastEvaluatedAtBySymbol.clear();
  consecutiveTimeoutsBySymbol.clear();
  activeEvaluationCount = 0;
}

/** For tests/observability: current in-flight evaluation count (leases holding slots). */
export function fastLaneActiveEvaluationCountForTests(): number {
  return activeEvaluationCount;
}

/** For tests: the current evaluator generation (bumped by every reset). */
export function fastLaneEvaluatorGenerationForTests(): number {
  return evaluatorGeneration;
}

/** For tests: run the hung-lease reaper on demand (also runs on every admission). */
export function reapHungFastLaneLeasesForTests(): void {
  reapHungLeases();
}

/**
 * For tests/observability/diagnostics: a structured snapshot of the lease book - active lease
 * count, slots held, oldest lease age, and per-lease symbol/generation/age/state/slotHeld.
 * Oldest-first ordering.
 */
export function getFastLaneLeaseSnapshot(): FastLaneLeaseBookSnapshot {
  const now = Date.now();
  const leases: FastLaneLeaseSnapshot[] = [];
  for (const lease of leasesBySymbol.values()) {
    if (lease.generation !== evaluatorGeneration) continue;
    leases.push({
      candidateId: lease.candidateId,
      symbol: lease.symbol,
      generation: lease.generation,
      acquiredAt: lease.acquiredAt,
      ageMs: now - lease.acquiredAt,
      state: lease.state,
      slotHeld: lease.slotHeld,
      timedOut: lease.timedOut,
    });
  }
  leases.sort((a, b) => b.ageMs - a.ageMs);
  return {
    generatedAt: now,
    generation: evaluatorGeneration,
    activeLeaseCount: leases.length,
    slotsHeld: activeEvaluationCount,
    oldestLeaseAgeMs: leases.length > 0 ? leases[0].ageMs : 0,
    leases,
  };
}
