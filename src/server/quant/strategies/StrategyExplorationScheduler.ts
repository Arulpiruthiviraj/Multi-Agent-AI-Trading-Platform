/**
 * Phase 15 (2026-09-01 bounded exploration mission), Rule 4. Real evidence found this phase:
 * `resolveStrategiesForLiveEvaluation()` currently returns 21 live strategies, but `evaluateAll()`
 * sorts them by setupScore and `bestStrategyIdea()` unconditionally picks only `eligible[0]` - a
 * single winner per symbol per cycle. Direct query of live `quant_assessments` rows showed
 * MOMENTUM_BREAKOUT clearing MIN_STRATEGY_CONFIDENCE_TO_TRADE (confidence 0.5, real conditions
 * met) while still ranking 8th-17th of 21 by setupScore - it is correctly evaluated, correctly
 * confident, and still never wins selection, so it never reaches ChiefTrader/consensus/RiskEngine
 * at all (no TRADE_IDEA_GENERATED, no CONSENSUS_TERMINAL_REASON - invisible even to the funnel
 * reports). 19 of 21 live strategies have never organically emitted, all-time.
 *
 * This module does not add a second emission channel, does not lower any confidence bar, does not
 * touch RiskEngine/ChiefTrader/consensus, and does not affect quarantined strategies (callers
 * already run `filterQuarantinedStrategies()` before this - PULLBACK_CONTINUATION's RETIRED status
 * is enforced upstream and unaffected). It only bounds how often the natural top-setupScore
 * strategy is deprioritized in favor of a different, already-qualifying strategy that has gone
 * the longest without a turn - the same real evaluations, same real confidence, same downstream
 * EV/R:R/RiskEngine/consensus gates apply to whichever strategy is picked.
 *
 * Bounded by two independent limits: a per-strategy cooldown (how long a promoted strategy holds
 * its "already had a turn" status) and a system-wide minimum interval between any two promotions
 * (regardless of symbol or strategy) - this caps the total behavioral divergence from today's
 * pure-highest-setupScore selection to at most one promotion per strategyExplorationMinIntervalMs,
 * globally, not per symbol.
 */
import { quantThresholds } from '../../config/quantThresholds';
import { MIN_STRATEGY_CONFIDENCE_TO_TRADE } from './StrategyEngine';
import type { StrategyEvaluation } from './types';

let lastExploredAtMs = new Map<string, number>();
let lastGlobalExplorationAtMs = 0;

/** Real, always-fresh Map/timestamp per process - matches MarketDataWorker's own in-memory rescue-state pattern. Test-only. */
export function resetStrategyExplorationStateForTests(): void {
  lastExploredAtMs = new Map<string, number>();
  lastGlobalExplorationAtMs = 0;
}

/**
 * `evaluations` must already be sorted descending by setupScore (evaluateAll()'s own contract)
 * and already quarantine-filtered (filterQuarantinedStrategies()'s output). Returns the same array
 * unchanged unless a bounded exploration promotion applies, in which case the promoted strategy's
 * evaluation is moved to the front so bestStrategyIdea()'s `eligible[0]` picks it instead.
 */
export function selectWithBoundedExploration(
  evaluations: StrategyEvaluation[],
  now: number = Date.now(),
): StrategyEvaluation[] {
  if (!quantThresholds.strategyExplorationEnabled) return evaluations;
  if (evaluations.length < 2) return evaluations;
  if (now - lastGlobalExplorationAtMs < quantThresholds.strategyExplorationMinIntervalMs) return evaluations;

  const eligible = evaluations.filter((e) => e.confidence >= MIN_STRATEGY_CONFIDENCE_TO_TRADE);
  if (eligible.length < 2) return evaluations;

  // eligible[0] is today's natural pick (evaluateAll() already sorts by setupScore descending).
  // The first OTHER real, qualifying strategy that hasn't been promoted within the cooldown
  // window is the most-starved candidate - still picked by its own real setupScore ranking among
  // the starved subset, never an invented one.
  const starved = eligible.slice(1).find((e) => {
    const last = lastExploredAtMs.get(e.strategy);
    return last === undefined || now - last >= quantThresholds.strategyExplorationCooldownMs;
  });
  if (!starved) return evaluations;

  lastGlobalExplorationAtMs = now;
  lastExploredAtMs.set(starved.strategy, now);
  return [starved, ...evaluations.filter((e) => e !== starved)];
}
