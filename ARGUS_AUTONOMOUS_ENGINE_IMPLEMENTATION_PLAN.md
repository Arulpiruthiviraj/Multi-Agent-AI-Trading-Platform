# Argus Autonomous Dual-Loop Engine — Implementation Plan

Read-only audit, per instruction — **no code changed to produce this document.** Covers: what already exists (more than either directive assumed — this codebase has been under active development this same session, including by a concurrent process while this audit was written), what's genuinely missing, and a sequenced plan for the rest. Companion to `ARGUS_ARCHITECTURE_PROTECTION.md` (the immutability contract) and `ARGUS_CONSENSUS_RUNTIME_FORENSIC.md` (why consensus was starved).

## 1–10. Existing architecture and capabilities

The spine is exactly as documented in `ARGUS_ARCHITECTURE_PROTECTION.md`. What's relevant here is everything already built in the extension zone — most of section 5 through 21 of the two directives is **already substantially implemented**, not a gap:

### Already built: asset classification & penny-stock safety (`src/server/multiAsset/`)
- `AssetClassifier.ts` — fail-closed classification (`LARGE_CAP`/`MID_CAP`/`SMALL_CAP`/`MICRO_CAP`/`PENNY_STOCK`/`ETF`/`UNKNOWN`) from market cap, price, symbol overrides, or ETF allowlist. Prefers `UNKNOWN` over guessing.
- `SafetyFilter.ts` — spread (abs + bps), dollar volume, ATR-based volatility, and a hard `ASSET_MARKET_ORDER_UNFIT` block, all config-driven (`config/multiAsset.json`), all UNCALIBRATED placeholders by the config's own admission.
- `StrategyRouter.ts` / `researchCosts.ts` — asset-aware strategy allowlisting and conservative research fill-cost overlays for penny/micro.
- `ideaEligibility.ts` — `applyAssetIdeaGate()` (live-wired into `EventBus.emit()`, gates every `TRADE_IDEA_GENERATED`) and `applySubordinateAssetNotionalCap()` (live-wired into `RiskEngine.ts`'s position sizing, can only lower a cap).
- All of it is a no-op passthrough today: `ARGUS_MULTI_ASSET_ENABLED=false`, `ARGUS_PENNY_STOCK_ENABLED=false` in `.env`.
- **Real, hard constraint discovered here, not previously documented anywhere else:** even with both flags on, a penny/micro BUY is unconditionally blocked (`ASSET_MARKET_ORDER_UNFIT`) because OMS is MARKET-only and `marketOrdersFitPennyAndMicro: false`. Penny stocks cannot execute until OMS gains LIMIT-order support. See §11.

### Already built: continuous watchlist expansion (`src/server/continuous/OpportunityDiscovery.ts`)
- `OpportunityDiscoveryWorker`: a real `setInterval` loop (`continuousIntelligence.opportunityScanMs`, 120s), with in-flight overlap protection.
- `runOpportunityScan()`: classifies a seed list, runs the same penny/micro safety filter, and for shortlisted symbols not already actively subscribed, emits `WATCHLIST_SUBSCRIBE_REQUESTED` — bounded by `maxNewSubscriptionsPerCycle` (4) and `maxActiveSubscriptions` (32).
- **Explicitly and deliberately never emits `TRADE_IDEA_GENERATED`** — it only expands what `MarketDataWorker` streams live ticks for. This is the correct, safe design: discovery ≠ idea generation.
- **Gap: `opportunityDiscoveryWorker.start()` is never called anywhere in the boot sequence.** The loop is fully built, tested (`continuousIntelligence.test.ts`), flag-gated, and inert only because nothing arms it — this is a small, well-scoped wiring gap, not a design gap.
- **Gap: the seed universe is a static 9-symbol list** (`config/continuousIntelligence.json.seedSymbols`: AAPL/MSFT/NVDA/AMZN/TSLA + the 4 ETFs). It re-classifies the same known names every cycle; it does not discover *new* tickers from a broad market screen. The config's own comment is explicit about why: *"Scanning thousands of IEX symbols is intentionally not supported — Alpaca IEX is a bounded subscription feed."* Broad discovery (gainers/most-active/volume-spike screening) needs a periodic **REST** call (Polygon/FMP/Finnhub — Argus already holds keys for all three), producing a short candidate list, which only *then* gets an IEX subscription for the survivors. This piece does not exist yet. See §11.

### Already built: this closes the loop from subscription → real analysis
- `MarketDataWorker.subscribe(symbol)` / `.unsubscribe(symbol)` — real, live, bounded (`maxActiveSubscriptions` cap refuses new subscribes past it), protects the 4 core ETFs from ever being evicted (`continuousIntelligence.protectedSymbols`), and listens for `WATCHLIST_SUBSCRIBE_REQUESTED` on the EventBus (`ensureWatchlistListener()`).
- **`TechnicalAgent.analyzeTick()` and `KronosForecastAgent` are symbol-generic** — they react to whatever `MARKET_DATA` ticks arrive, not a hardcoded list. A symbol dynamically subscribed by the discovery loop gets real technical/Kronos analysis with **zero additional code** once ticks start flowing and it warms up.
- `FundamentalAgent`/`MacroAgent` now resolve their analysis target via `resolveIdeaUniverse()` (`src/server/core/ideaUniverse.ts`, new since this audit started) — falls back to US benchmarks only when `MarketDataWorker` has no active subscriptions yet, otherwise follows the live subscription set. This is the same generic-symbol pattern extended to the two agents that used to have a hardcoded 3-symbol watchlist.
- **Conclusion: the technical/fundamental/macro/Kronos side of "discover → analyze" is already end-to-end wired**, gated only by (a) the discovery loop's `start()` never being called, and (b) the seed universe being static/small. Fix those two and real analysis on dynamically-discovered symbols already happens without touching TechnicalAgent, KronosForecastAgent, FundamentalAgent, or MacroAgent again.

### Already built: portfolio-loop intelligence overlay (`src/server/continuous/portfolioIntel.ts`)
- `ensureHoldingSubscribed(symbol)` — called from `PortfolioMonitor.reviewPortfolio()` for every open position, guarantees a held position always has live ticks for exit evaluation.
- `canEmitPortfolioExitIdea(symbol)` — per-symbol cooldown (`exitIdeaCooldownMs`, 5 min) preventing a duplicate exit idea storm for one deteriorating position.
- `recordPortfolioDecision(...)` — structured `PORTFOLIO_DECISION_RECORDED` telemetry for every review cycle (HEALTHY / WATCH / WARNING / EXIT_CANDIDATE / NO_PRICE), independent of whether an idea was actually emitted.
- All gated behind `ARGUS_PORTFOLIO_INTEL_ENABLED`; identity/no-op when off. **Already fully integrated into the live `PortfolioMonitor.ts`**, not a separate parallel path.

### Already built: agent liveness (`src/server/core/pipelineAgentHealth.ts`, new since this audit started)
- Shared heartbeat map (`lastTickAt`, `lastSuccessfulTickAt`, `lastFailureAt`, `consecutiveFailures`, `currentState: IDLE|TICKING|SUCCESS|FAILED|GATED`) per agent id.
- `isPipelineAgentAlive(agentId)` compares `lastTickAt` age against `tradingSafety.pipelineAgentDeadAfterMs` (180s) — this is the generalized, config-driven version of the `lastTickAt` field added to `FundamentalAgent`/`MacroAgent` earlier this session in direct response to the forensic report's finding that a dead timer was indistinguishable from a gated-off one.
- `FundamentalAgent`/`MacroAgent` now call `notePipelineAgentTick/Success/Failure/Gated` from a `tickSafely()` wrapper with its own in-flight guard — this is strictly more thorough than the single `lastTickAt` field added earlier and should be treated as superseding it once confirmed wired for every idea agent (currently confirmed for Fundamental/Macro; verify Technical/Kronos/Quant during implementation).
- **Gap:** not yet surfaced through `getPipelineAgentSnapshot()` / a `GET .../autonomous-loops`-style endpoint. The data exists in-process; there's no HTTP surface for it yet.

### Already built: honest "why no trade" (`src/server/core/consensusExplanation.ts`, new since this audit started)
- `formatWhyNoTrade(outcome)` — plain-language explanation (independent agents agreeing vs. required, weighted confidence vs. threshold, per-agent votes excluding `ConsensusDebate`) for both APPROVED and NO-TRADE outcomes. Doesn't touch the math, purely explains it. Directly answers the "operator should see why Argus did not buy" requirement — needs a route to actually surface it (none found yet).

## 11. Missing components (the real gaps, after the above)

1. **Broad-universe discovery.** No REST-based screener (gainers/most-active/volume-spike) exists. `OpportunityDiscovery.ts` only reclassifies a static seed list. This is the single biggest gap relative to "continuously discover new stocks" — everything downstream of it (classification, safety filter, subscribe, analyze, consensus, risk, OMS) already exists and would work on whatever this screener feeds it.
2. **`opportunityDiscoveryWorker.start()` is never called.** One-line-equivalent wiring gap (following the exact `pipelineAgentRuntime.ts` pattern already used for Technical/Fundamental/Macro/Kronos/Quant), currently blocking everything in §10 from ever running, even the static-seed version.
3. **Penny-stock execution is architecturally blocked**, not just flag-gated — `marketOrdersFitPennyAndMicro: false` because OMS is MARKET-only. This needs an explicit decision (§18) before any penny-stock discovery work has a payoff.
4. **No unified autonomous-loop health endpoint.** `pipelineAgentHealth.ts`, `continuousIntelRouter` (`/api/v2/continuous-intelligence/status`), and `getPipelineAgentSnapshot()` (`/api/v1/system/pipeline-agents`) each expose *part* of the picture; nothing combines them into one "is Argus actually alive right now" view.
5. **No capital-allocation-across-many-candidates layer.** `RiskEngine`'s `argus_capital_allocation` gate and `PositionSizing` govern one order at a time; there's no ranking/prioritization step for "the scanner found 12 shortlisted candidates this cycle, budget only supports 3."
6. **No architecture-regression test suite** (the ask in directive 2 §28) — nothing currently asserts "no new file calls `BrokerManager.placeOrder` outside OMS" as an automated check; it's true today (verified by grep for this document) but unenforced.
7. **`formatWhyNoTrade()` isn't wired to a route yet** — exists, unused by any HTTP handler as of this audit.
8. **No time-based/EOD exit rule in `PortfolioMonitor`** (noted in the earlier `ARGUS_PIPELINE_STATUS.md` audit too) — a gap, not a bug, only relevant if short-horizon/penny strategies are pursued.

## 12. Components that already exist and should be reused (do not duplicate)

`AssetClassifier`, `SafetyFilter`, `StrategyRouter`, `applyAssetIdeaGate`/`applySubordinateAssetNotionalCap`, `OpportunityDiscoveryWorker`/`runOpportunityScan`, `MarketDataWorker.subscribe/unsubscribe`, `WATCHLIST_SUBSCRIBE_REQUESTED`, `resolveIdeaUniverse`, `ensureHoldingSubscribed`/`canEmitPortfolioExitIdea`/`recordPortfolioDecision`, `pipelineAgentHealth.ts`'s heartbeat functions, `formatWhyNoTrade`. A new "MarketScanner" or "CandidateLifecycleManager" component should call into these, not reimplement classification/safety/subscription logic.

## 13. Files that must NOT be modified (without an explicit, reviewed architectural decision)

`RiskEngine.ts` (beyond the existing, already-safe `applySubordinateAssetNotionalCap` hook), `OrderManagement.ts`, `BrokerManager.ts` and adapters, `ChiefTraderAgent.ts`'s consensus math (`evaluateConsensus`, `netConfidenceFromVotes`, quorum check), `TradingEngine.ts`'s arming/kill-switch logic, `PortfolioReconciliation.ts`'s pause behavior, `config/tradingSafety.json`'s `consensusApprovalThreshold`/`minIndependentAgreeingAgents`.

## 14. Files that can be extended

`src/server/continuous/OpportunityDiscovery.ts` (add a broad-screener step before the seed-list classify step), `src/server/core/pipelineAgentRuntime.ts` (add `OpportunityLoop`/`ContinuousIntelligence` as a togglable runtime alongside the existing five), `src/server/core/pipelineAgentSnapshot.ts` (surface `pipelineAgentHealth` data), a new route file for the unified health endpoint, `config/continuousIntelligence.json` (widen `seedSymbols` handling / add a `screenerEnabled` flag), `config/multiAsset.json` (only the `execution.marketOrdersFitPennyAndMicro` decision in §18, and only with explicit sign-off).

## 15. Proposed new components

- `MarketScreener` (or extend `OpportunityDiscovery.ts`): periodic REST call to one already-configured provider (Polygon/FMP/Finnhub — pick one, cache aggressively, respect rate limits the way `AlphaVantageBudget` does) for a gainers/most-active list, feeding `evaluateOpportunityCandidate()` instead of (or in addition to) the static seed list.
- `GET /api/v2/autonomous-loops` (or extend `continuousIntelRoutes.ts`): combines `getPipelineAgentSnapshot()`, `pipelineAgentHealth` per-agent heartbeats, and `getLastOpportunityScan()` into one operator-facing view.
- Architecture-regression test (`src/server/architecture.protection.test.ts`): greps the compiled source tree for `placeOrder(` calls outside `OrderManagement.ts`/adapter internals, and for `BrokerManager` imports outside the allowed caller list — fails CI if a new file introduces one.

## 16. Data flow (proposed, once the screener exists)

```
REST screener (Polygon/FMP/Finnhub gainers) — new, bounded, cached
    ↓ candidate tickers (small list, e.g. top 20)
evaluateOpportunityCandidate() — existing (classify + penny/micro safety filter)
    ↓ shortlist
WATCHLIST_SUBSCRIBE_REQUESTED — existing event
    ↓
MarketDataWorker.subscribe() — existing, bounded by maxActiveSubscriptions
    ↓ real IEX ticks
TechnicalAgent / KronosForecastAgent / FundamentalAgent / MacroAgent — existing, already symbol-generic
    ↓ TRADE_IDEA_GENERATED
ChiefTraderAgent → RiskEngine → OMS → BrokerManager — existing, untouched
```

The only new code in this diagram is the top box. Everything below it already exists and works today for AAPL/MSFT/NVDA/AMZN/TSLA/SPY/QQQ/IWM/DIA; a new symbol from the screener enters exactly the same pipeline as those already do.

## 17. Failure handling

Already-present patterns to follow (not invent): `AlphaVantageBudget`'s shared-lock timeout (this session's fix — any new shared external-data budget/lock must use the same pattern), `pipelineAgentHealth.ts`'s per-agent failure counter, `PortfolioMonitor`'s in-flight guard + try/catch-per-cycle (a scanner tick failing must not stop future ticks), `ExternalDataCache`'s fail-closed "unknown, not fabricated" pattern for a screener API outage.

## 18. Decision needed before penny-stock work has any payoff

Penny/micro BUY ideas are permanently blocked today regardless of how good the discovery/classification/safety work is, because OMS only submits MARKET orders. Three ways forward, not decided here:
1. Leave penny stocks discovery-only (classified, ranked, visible, never executable) until OMS gets LIMIT support — a real, separately-scoped, protected-zone change.
2. Scope and build OMS LIMIT-order support as its own reviewed project before any penny-stock execution testing.
3. Accept MARKET-order risk for penny/micro under tight notional caps (`$300`/`$500` profiles already exist) — not recommended without explicit operator sign-off given the exact "extreme spreads, halts, slippage" concern already raised.

## 19. Testing strategy

Existing coverage to build on: `multiAsset.test.ts`, `continuousIntelligence.test.ts`, `AlphaVantageBudget.test.ts`, `FundamentalAgent.test.ts`/`MacroAgent.test.ts`, `PortfolioMonitor.test.ts`, `systemRoutes.pipelineAgents.test.ts`. New tests needed: a broad-screener module (mocked REST response → bounded candidate list → respects `maxNewSubscriptionsPerCycle`), the proposed architecture-regression test (§15), and an end-to-end paper-mode test that a screener-discovered symbol reaches a real `CHIEF_APPROVED_IDEA`/`RISK_ASSESSMENT_COMPLETED` row without any new direct broker call.

## 20. Rollout strategy

1. Wire `opportunityDiscoveryWorker.start()`/`stop()` into `pipelineAgentRuntime.ts` (small, safe, immediately testable against the *existing* static seed list — proves the wiring before the screener exists).
2. Build the REST screener behind its own new flag, feeding the existing `evaluateOpportunityCandidate()` — verify in paper mode that new, previously-unseen symbols reach real consensus evaluations.
3. Build the unified `/autonomous-loops` observability endpoint.
4. Decide and act on §18 before enabling `ARGUS_PENNY_STOCK_ENABLED` in any environment that matters.
5. Add the architecture-regression test once the above land, so it protects the finished shape rather than a moving target.

All flags stay off by default at every step; nothing here changes current Argus behavior until explicitly turned on.
