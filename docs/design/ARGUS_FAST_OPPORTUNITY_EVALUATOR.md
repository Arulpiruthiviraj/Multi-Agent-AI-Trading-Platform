# Argus — Fast Opportunity Lane Evaluator (Design)

**Status as of 2026-10-06: `FAST_EVALUATOR_PARTIAL`.** Research/paper only. LIVE_NO_GO. No
execution authority. See the companion case study
(`docs/audits/ARGUS_FAST_EVALUATOR_OCT05_CASE_STUDY.md`) for real evidence against this design.

## What this closes

The Fast Opportunity Lane (candidate detection + lifecycle, already on `main` from a parallel
session) had a real, correctly-enforced safety boundary but **no evaluation path at all** —
`FastEvaluationResult` was defined but never constructed anywhere in the codebase, and
`emitTradeIdea` never appeared in `src/server/fastlane/`. This design adds exactly one thing:
`evaluateFastCandidate()` (`src/server/fastlane/fastLaneEvaluator.ts`), which answers one question
only:

> *Given a detected fast candidate and sufficient contemporaneous data, does any EXISTING Argus
> strategy produce valid evidence?*

It does **not** add a second trading pipeline, a new alpha formula, or an idea/ChiefTrader
connection. That last piece is deliberately deferred — see "What this does NOT do" below.

## Reuse, not reimplementation

| Step | Reused, trusted entry point |
|---|---|
| Fetch real bars + build the real `StrategyContext` | `quantSignalAgent.evaluateSymbol(symbol)` — the SAME on-demand entry point `ConfluenceCoordinator` already calls for a second independent agent's evaluation (`tradingSafety.json`'s `confluenceCoordinatorEnabled` path). Internally calls `historicalDataGateway.ensureBars`/`getBars`, `classifyRegime`, `getMarketContext`, and the real feature-computation functions (`computeMomentumFeatures`, `computeVolumeFeatures`, `computeSupportResistanceFeatures`, `computeSmcFeatures`) — nothing new written for the Fast Lane. |
| Run the real 21-strategy evaluation | `evaluateAll(strategyContext)`, called inside `evaluateSymbol` — whichever strategies are currently live (5 CORE + any enabled EXPERIMENTAL), exactly as every other caller sees. |
| Pick a real, triggered, confidence-qualified idea | `bestStrategyIdea(evaluations)` — the SAME function `OpportunityDiscovery`/`QuantSignalAgent` already use. `triggerMet` and `MIN_STRATEGY_CONFIDENCE_TO_TRADE` are enforced there, never duplicated in the Fast Lane. |

No strategy formula was copied, adapted, or reimplemented. If `evaluateAll()`'s output ever
changes, the Fast Lane's evaluation changes identically and automatically — there is one
authoritative strategy-evaluation path, not two.

## The adapter

```
FastOpportunityCandidate
        |  (candidate.symbol only — the SAME input shape ConfluenceCoordinator passes)
        v
quantSignalAgent.evaluateSymbol(symbol)   <-- fetches real bars, builds real StrategyContext
        |
        v
evaluateAll(context)  -->  StrategyEvaluation[]
        |
        v
bestStrategyIdea(evaluations)  -->  { side, confidence, strategy, reasoning } | null
        |
        v
FastEvaluationResult   (status, strategiesEvaluated, validTriggers, bestStrategy?, ...)
```

No strategy context is built by hand inside the Fast Lane — the candidate contributes only its
symbol to this pipeline. `candidate.detectionSource`/`catalyst`/TTL are used for lifecycle
state/logging, never fed into the strategy math itself (a catalyst does not get to invent a
trigger a real strategy didn't find).

## `FastEvaluationResult` contract

See `FastOpportunityCandidate.ts` for the full type. Key properties:

- `status`: `INSUFFICIENT_DATA | NO_VALID_SETUP | VALID_STRATEGY_EVIDENCE | EXPIRED | DATA_STALE | ERROR`
- `strategiesEvaluated` / `validTriggers`: real strategy IDs, taken directly from the real
  `evaluateAll()` output — never a static/predicted list.
- `dataSufficiency`: per-feature `AVAILABLE | MISSING | STALE | NOT_APPLICABLE`, populated
  honestly (a feature this path never separately checks is absent, not defaulted to `AVAILABLE`).
- No execution authority: the type carries no order/quantity/broker field, and nothing in
  `fastLaneEvaluator.ts` imports `BrokerManager`, `OrderManagementService`, or `RiskEngine`
  (enforced by `fastLaneArchitecture.test.ts`).

## Safety boundary (tested)

`fastLaneArchitecture.test.ts` proves, by reading the real source (not trusting a design doc):
- No `BrokerManager`/`.placeOrder(`/`.cancelOrder(` reference anywhere in `src/server/fastlane/`.
- `fastLaneEvaluator.ts` never calls `emitTradeIdea` and never references `ChiefTrader` — **this
  phase's evaluation has no path into consensus at all**, by design (see below).
- `fastLaneEvaluator.ts`/`fastLaneEventInjector.ts` never reference `RiskEngine`, `PositionSizing`,
  trading-state mutation, or `LIVE_ARM`.
- `isFastLaneEnabled()` defaults to `false` and fails closed for `TRADING_MODE=LIVE` regardless of
  the flag.

## Concurrency and resource governance

Two new config values (`config/tradingSafety.json`, loaded like every other operational
threshold — never hardcoded in TS): `fastLaneMaxConcurrentEvaluations` (3) and
`fastLaneSymbolEvaluationCooldownMs` (60000). The evaluator:
- Coalesces concurrent calls for the **same symbol** onto one in-flight evaluation (no duplicate
  real bar fetches from a race).
- Refuses a new evaluation once the concurrency governor's limit is reached, rather than flooding
  `historicalDataGateway`.
- Refuses re-evaluating the same symbol inside its cooldown window.
- Checks `candidate.expiresAt` before any work — an expired candidate is never evaluated at all
  (`EXPIRED` status, no bar fetch, no stale-momentum resurrection).

## What this does NOT do (deliberate, phase-scoped)

- **No `emitTradeIdea` call.** A `VALID_STRATEGY_EVIDENCE` result is not wired into ChiefTrader in
  this phase. Evaluation correctness is proven first, execution integration is a later, separately
  reviewed and authorized phase — matching the precedent every other additive voter in this
  codebase (`JavaCoreEnsembleVoteService`, `JavaQuantAdvisoryService`, `TradePlanBuilder`) set when
  it was first added, each with its own explicit, dated operator sign-off.
- **No new strategy formula.** Confirmed: zero new momentum/breakout/relative-strength logic was
  written for this lane.
- **No change to `RANK_CAP`, `broadUniverseTopNPerScan`, the hot-swap cap, or any consensus/
  RiskEngine parameter.**

## Final verdict for this phase

**`FAST_EVALUATOR_PARTIAL`** — not `READY` (no emission path exists to validate end-to-end against
real consensus yet, and real evaluation against the actual benchmark symbols could not be run
live — see the case study) and not `UNSAFE` (every safety boundary holds, verified by source
reading and architecture tests, not assumption). The evaluator is real, reuses production strategy
logic, and is proven correct against deterministic unit fixtures; it has not yet been proven
against real market data for the specific symbols this investigation cares about, because most of
those symbols never had the underlying data Argus would need regardless of what evaluates it.
