/**
 * Phase 7F (Agent participation fix, 2026-08-27). FundamentalAgent/MacroAgent both select one
 * symbol per tick via a deterministic round-robin over resolveIdeaUniverse() (the active
 * subscription set). Traced from source (not inferred): with no prioritization, the round-robin
 * treats a quiet anchor with zero real ticks exactly the same as a symbol TechnicalAgent/
 * QuantEngine are actively producing real ideas for right now - so as the active set grows
 * (broad-universe/momentum rotation adding more symbols through the session), each individual
 * symbol's Fundamental/Macro coverage frequency gets diluted further, and there is no bias toward
 * symbols where a coincident multi-agent evaluation is actually possible.
 *
 * Fix: prioritize round-robin selection over only the symbols with a real, fresh tick (using the
 * SAME stalePriceThresholdMs RiskEngine's data_freshness gate already uses - no new threshold
 * invented), falling back to the full universe when nothing currently qualifies (preserves prior
 * behavior in that case, e.g. before market data starts flowing). This does not fabricate a vote -
 * it only changes which real symbol gets evaluated this tick, using data that already existed.
 */
export function selectPriorityRoundRobinSymbol(
  universe: string[],
  freshSymbols: string[],
  periodMs: number,
  nowMs: number,
): string {
  const pool = freshSymbols.length > 0 ? freshSymbols : universe;
  return pool[Math.floor(nowMs / periodMs) % pool.length];
}
