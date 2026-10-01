/**
 * Institutional Architecture Proposal, Phase A3 (2026-10-01,
 * ARGUS_INSTITUTIONAL_ARCHITECTURE_PROPOSAL.md) - the minimal, general `Clock` interface the
 * proposal asks for.
 *
 * Deliberately scoped narrow for this pass: this file adds the interface and a trivial `LiveClock`
 * implementation only. It does NOT retrofit the ~18 direct `Date.now()` call sites in
 * ChiefTraderAgent.ts/OrderManagement.ts/RiskEngine.ts to accept an injected clock - a real
 * infrastructure-audit pass (an Explore agent survey, 2026-10-01) found that retrofit is
 * substantially larger and riskier than the interface itself: those call sites drive live
 * cooldown/TTL/timeout semantics, and RiskEngine.ts's own existing replay-aware line (307 vs 554)
 * shows that "always inject the simulated clock" is not even uniformly correct there (some
 * timestamps - e.g. an SQL query bound against a wall-clock `created_at` column - must stay
 * wall-clock-real even inside a replay). That retrofit is real, separate, future work.
 *
 * `ReplayClock` (`src/server/engines/backtest/ReplayClock.ts`) already has a structurally
 * compatible `now(): number` method and now explicitly `implements Clock` - a non-breaking,
 * zero-behavior-change annotation, not a rewrite. `SyntheticMarketClock` (`src/server/replay/
 * SyntheticMarketClock.ts`) already extends `ReplayClock`, so it satisfies `Clock` automatically
 * through that existing inheritance - nothing there needed to change.
 */
export interface Clock {
  now(): number;
}

/** The real-wall-clock implementation - what every call site uses implicitly today via a bare
 *  `Date.now()`. Exists so code can be written against the `Clock` interface uniformly; using it
 *  is equivalent to today's real behavior, not a change. */
export class LiveClock implements Clock {
  now(): number {
    return Date.now();
  }
}
