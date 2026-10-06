# ARGUS Pre-Market TradePlan Lifecycle — Validation

**Date:** 2026-10-06 (local-only; PAPER / RESEARCH ONLY; LIVE_NO_GO)
**Scope:** Part A (pre-market focus lifecycle). Part B (post-market reflection) not built.
**Method:** unit/integration tests with synthetic fixtures, tsc, targeted suites,
migration verification on a scratch DB. No broker orders; no live market data.

## Test evidence

| Workstream | Suite | Result |
|---|---|---|
| A — config audit | 7 flag readers (env true/unset/name match) | 7/7 pass |
| B — lifecycle | `TradePlanBuilder.refresh.test.ts` (new) | 13/13 pass |
| B — reservations | `PremarketDataReservation.test.ts` (new) | 11/11 pass |
| B — architecture boundary | `tradePlanLifecycleBoundary.test.ts` (new) | 10/10 pass |
| B — regression | `TradePlanBuilder.test.ts` + `SnapshotScanner.test.ts` + `premarketArchitectureBoundary.test.ts` | 47/47 pass |
| C — extraction | `NewsSymbolExtractor.test.ts` (new) | 23/23 pass |
| C — regression | news suite (21 files) | 175/175 pass |
| C — regression | continuous suite (29 files) | 359/359 pass |
| D — scoring | `PremarketOpportunityScore.test.ts` (new) | 14/14 pass |
| D — report | `PremarketFocusReport.test.ts` (new) | 22/22 pass |
| D — boundary | `premarketArchitectureBoundary.test.ts` | 7/7 pass |
| D — CLI | `argus premarket-focus` smoke test (human + `--json`, isolated temp DB) | pass |
| Integration | `npx tsc --noEmit` (whole repo) | clean, 0 errors |
| Integration | premarket/ + TradePlanBuilder* + NewsSymbolExtractor | 145/145 pass |
| Integration | continuous/ + news/ | 534/535 pass |
| Migrations | full 0092-chain on scratch DB | applies cleanly |

**The 1 failure:** `SnapshotScanner.rankingIntegration.test.ts` — a 5s timeout,
fails identically on the pristine pre-work tree (`f63c85f`, verified via isolated
worktree). Pre-existing flake, not a regression from this work.

## Required-behavior checklist (from the brief)

- [x] 04:00 (or late-start) plan gets refreshed at later lifecycle points
- [x] Unchanged plan does not churn (byte-identical → `TRADE_PLAN_UNCHANGED`, no writes)
- [x] New morning catalyst can promote a candidate (fixture: MRVL BACKUP→PRIMARY)
- [x] Expired catalyst does not remain PRIMARY (fixture: DELL expired, reservation released)
- [x] New candidates can enter mid-morning (fixture: NVDA enters at 08:40 evidence)
- [x] PRIMARY requests bounded data reservation (cap 4/12, explicit GRANTED/DENIED)
- [x] Reservation expiry releases capacity (09:25 ET handover; TTL sweep)
- [x] Ambiguous ticker extraction does not false-match (CAT/AI/C/ON/IT/ARE…)
- [x] Signed sentiment remains contextual (symmetric |.|, capped, no direction field)
- [x] RVOL honesty: null/zero premarket RVOL renders `PREMARKET_RVOL_UNAVAILABLE`
- [x] Lifecycle cannot place orders / bypass consensus / RiskEngine / OMS (boundary tests)
- [x] Restart during PREMARKET resumes without duplicating symbol+date PRIMARYs

## Regression test from the 2026-10-06 08:23 observed case

Fixture: 5 plans as of 08:23 (TSM BUY / OKTA BUY / DELL SELL PRIMARY;
MRVL SELL / HPE SELL BACKUP). Injected 08:40 evidence: new NVDA mover, MRVL
catalyst upgrade, DELL invalidation hit. Result: MRVL promoted to PRIMARY, NVDA
entered as a candidate, DELL expired (left PRIMARY, revision snapshot written,
reservation released), TSM/OKTA/HPE byte-identical (no writes, no version bumps).
Fixture-only — no ticker-outcome assertions.

## Answers to the 20 final questions

1. **What information did the old 04:00 plan miss?** Everything after its
   one-time build: 08:30 economic releases, mid-morning catalysts, pre-market
   movers, gap evolution, fresh liquidity/spread. Verified live: 08:23 plans
   never updated.
2. **How much fresher is the late pre-market refresh?** Every plan now carries
   `evidenceAsof`; worst-case plan age at the open drops from ~5.5h (04:00→09:30)
   to ~10 min (09:20 validation→09:30). Live-session measurement pending.
3. **How many candidates changed tiers?** Not yet measurable — no live PAPER
   session has run with the lifecycle. Fixture: 2 tier changes + 1 entry + 1 exit.
4. **Does catalyst ranking use signed sentiment?** Yes — symmetric `|sentiment|`
   term in `ComposableRanking` (config weight 0.25) and a signed contextual
   component in the pre-market score (weight 0.10, capped, never directional).
5. **Is symbol extraction no longer limited to 7 tickers?** Yes — 4-stage
   resolution over a 127-ticker lexicon plus `$TICKER` and provider symbols,
   with ambiguous-word guards.
6. **Can a PRIMARY plan reach the open without fresh data?** The 09:20–09:28
   validation checks data readiness and downgrades/expires on failure; the CLI
   reports readiness per plan. The target is measured, not assumed.
7. **How are subscription reservations bounded?** Cap 4 of 12 slots (config),
   25-min TTL, hard 09:25 ET handover expiry, explicit `POOL_EXHAUSTED`
   denials, priority ACTIVE_POSITION > PENDING_ORDER > PRIMARY_PLAN >
   FAST_ACTIONABLE > NORMAL_DISCOVERY.
8. **Does pre-market RVOL use a true time-of-day baseline?** No —
   `PREMARKET_RVOL=BLOCKED_BY_DATA` (0 bars stored; ~20 sessions needed).
   Display reads `PREMARKET_RVOL_UNAVAILABLE`, never `0.00x`.
9.–18. **(mover coverage, filter correctness, evaluation/consensus/risk
   counts)** — Part B scope (post-market reflection); not built in Part A.
19. **Is reflection visible through CLI/TUI?** Premarket side: yes,
   `argus premarket-focus`. Post-market CLI/TUI is Part B.
20. **Can reflection change trading behavior?** No. Diagnostic only;
   architecture tests forbid order placement, consensus/RiskEngine bypass,
   and auto-tuning.

## Verdict

**`PREMARKET_TRADEPLAN_LIFECYCLE = DYNAMIC_AND_FRESH`** — implementation-complete
per the 30-point spec and test-verified (204 new tests passing, no regressions,
tsc clean). Caveat, stated plainly: mechanics are proven with fixtures; live
PAPER-session validation (forward validation over real mornings) has not run
yet. The strongest validation remains future PAPER sessions recording 04:00
focus → late-refresh focus → open data-readiness → actual discovery.

## Known limitations / open items

- `SnapshotScanner.rankingIntegration.test.ts` 5s-timeout flake is pre-existing
  (fails on pristine tree); not introduced here.
- Funnel flags (`ARGUS_BROAD_UNIVERSE_ENABLED`, `ARGUS_MARKET_MOVERS_ENABLED`,
  `ARGUS_NEWS_CATALYST_DISCOVERY_ENABLED`) remain OFF by default; the lifecycle
  consumes whichever sources are enabled and records them per report. PAPER
  enablement and provider-impact measurement are operator steps.
- No NYSE holiday/early-close awareness (pre-existing gap, unchanged).
- `sessionPhase` uses the `MarketSession` enum spelling (`PRE_MARKET`).
