/**
 * Phase 9 (same-candidate convergence, 2026-08-27). Real DB evidence showed FundamentalAgent and
 * MacroAgent round-robin the active symbol universe independently of whichever symbol
 * ConfluenceCoordinator just decided was worth a reactive QuantEngine/Kronos re-check - so even
 * when a genuinely interesting candidate exists (a qualifying TechnicalAgent signal), Fundamental/
 * Macro's own scarce AlphaVantage-backed cycles are usually spent on an unrelated symbol instead.
 *
 * This is a tiny, in-memory, short-TTL registry of "a real signal-worthy symbol was just
 * identified" - populated by the SAME trigger condition ConfluenceCoordinator already uses
 * (a qualifying TechnicalAgent BUY/SELL), never a new signal source. It does not itself decide
 * anything, vote, or emit an idea - it only lets Fundamental/MacroAgent's existing priority
 * round-robin (agentRoundRobin.ts) prefer a recent real candidate over the generic fresh-symbol
 * set, when one exists and is also currently fresh. Falls back to prior behavior exactly
 * (unchanged) whenever no recent candidate qualifies.
 */

interface CandidateEntry {
  symbol: string;
  at: number;
}

const recent: Map<string, CandidateEntry> = new Map();

export function recordCandidate(symbol: string, atMs: number = Date.now()): void {
  recent.set(symbol.toUpperCase(), { symbol: symbol.toUpperCase(), at: atMs });
}

/** Symbols recorded within the last `maxAgeMs`, most recent first. */
export function getRecentCandidates(maxAgeMs: number, nowMs: number = Date.now()): string[] {
  const out: CandidateEntry[] = [];
  for (const entry of recent.values()) {
    if (nowMs - entry.at <= maxAgeMs) out.push(entry);
  }
  return out.sort((a, b) => b.at - a.at).map((e) => e.symbol);
}

/** Test-only reset - never called from production code. */
export function resetRecentCandidatesForTests(): void {
  recent.clear();
}
