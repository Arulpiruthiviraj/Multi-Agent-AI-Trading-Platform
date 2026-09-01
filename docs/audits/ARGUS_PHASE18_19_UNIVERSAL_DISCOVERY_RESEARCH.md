# ARGUS — Phase 18/19: Universal Market Discovery Architecture (Research + Forensic Design)

**Status: RESEARCH ONLY, delivered 2026-09-01.** No code, config, `.env`, or threshold was touched to
produce this document. Every source claim below is either **PROVEN** (verified in-repo by two
independent forensic passes), **INFERRED** (a reasonable conclusion from that evidence), **UNVERIFIED**
(general external knowledge not checked against this codebase), or **RECOMMENDED** (design judgment,
offered for operator decision — not yet authorized or implemented).

## A. Current architecture (PROVEN, source-verified)

Discovery today is **five to six independently-coded, ad-hoc sources**, unioned by literal array
concatenation in two places that don't even agree with each other:

- `OpportunityDiscovery.getOpportunityScanUniverse()` (`src/server/continuous/OpportunityDiscovery.ts:97-112`)
  unions: `seedSymbols` (10, hardcoded), `watchUniverseSymbols` (4, hardcoded),
  `momentumScanUniverseSymbols` (~120, hardcoded), `getCachedBroadUniverseSymbols()` (Alpaca-derived,
  capped, off by default), `getCachedMoverSymbols()` (Alpaca-derived, capped, off by default).
- `SnapshotScanner.getSnapshotScanUniverse()` (`SnapshotScanner.ts:175-183`) is a **second, slightly
  different** universe function — includes `campaignOpeningSurgeSymbols`, excludes the two dynamic
  Alpaca sources.
- No shared `MarketDiscoveryProvider` interface exists anywhere in this codebase (confirmed by grep —
  zero matches). Each source is a free-function module. The codebase *does* already know this pattern
  elsewhere (`historicalBarProvider.ts`'s registry for bar data) — it was simply never applied to
  discovery.

The **live-quote layer is a hard, fixed ceiling**: `MarketDataWorker`'s `activeStreams` set is capped at
`maxActiveSubscriptions` = **12** (Alpaca) or `ibkrConnection.maxMarketDataLines` = **90** (IBKR), and
both the file header and `config/continuousIntelligence.json`'s own `$comment` state outright:
*"Scanning thousands of IEX symbols is intentionally not supported."* Every downstream stage —
`QuantSignalAgent.runCycle()` (only evaluates `marketDataWorker.getActiveSymbols()`) and
`gateTradeIdea()` (requires a live price already cached by `MarketDataWorker`) — is architecturally
downstream of this same bounded pool. Discovery, subscription, and evaluation are today **the same
12/90-slot bottleneck**, not three separable stages.

A bounded escape valve exists (`requestTemporaryDataRescue`, capped at 3, made class-aware by the Phase
18 rescue-fairness fix shipped the same day as this report) but it only *reprioritizes within* the same
bounded pool — it does not expand the universe.

Selection is single-winner: `bestStrategyIdea()` picks exactly `eligible[0]` by raw `setupScore`
(`StrategyEngine.ts:160`), and `QuantSignalAgent`'s own `symbolConcurrency` is **1** — symbols are
evaluated one at a time even within the tiny subscribed set. `StrategyExplorationScheduler.ts`'s own
header comment documents this as a known limitation: *"19 of 21 live strategies have never organically
emitted, all-time."*

## B. Current limitations (PROVEN + INFERRED)

ARGUS misses broad-market opportunities not because discovery logic is wrong, but because discovery,
subscription-capacity, and evaluation-capacity are conflated into one bounded pipeline. A stock can be a
genuine mover, pass every liquidity screen, and still never be evaluated simply because the 12/90-slot
stream is occupied by something else and no rescue slot is free (the exact CRM/ONON pattern from Phase
17, now partially mitigated by the Phase 18 fairness fix). This is a capacity/coupling problem, not a
data-availability problem — Alpaca's own tradable-assets + snapshots endpoints already cover the entire
US equity universe on a polling basis (see C); ARGUS just never asks them broadly by default, and even
when it does (`ARGUS_BROAD_UNIVERSE_ENABLED`), the result is squeezed through the same 12-slot streaming
funnel.

## C. Provider capability matrix (PROVEN, source-verified this session)

| Capability | Alpaca | IBKR (ib_gateway / ib_web) | Verdict |
|---|---|---|---|
| Full-universe symbol list | `GET /v2/assets?asset_class=us_equity` — thousands of symbols, metadata only | None found | Alpaca only |
| Market-wide movers | `GET /v1beta1/screener/stocks/movers?top=N` — symbol/price/%change | No scanner subscription anywhere in this codebase (`reqScannerSubscription` — zero matches) | Alpaca only, in-repo |
| Batched snapshot/price/volume/spread | `GET /v2/stocks/snapshots?symbols=<100-batch>&feed=iex` | Per-symbol only (`reqMktData`, one ticker per call) | Alpaca scales; IBKR doesn't |
| Real-time streaming | WebSocket IEX top-of-book, hard-capped 12 (default) / 90 (IBKR override) | Per-symbol `reqMktData`, hard-capped 90 (`maxMarketDataLines`) | Both bounded; neither market-wide |
| Rate-limit/circuit-breaker | Real: `AlpacaBroker.fetchAlpaca()` — 3-failure breaker, 30s cooldown. **Not reused** by the 3 scanner files (bare timeout-only fetch). | None beyond the hard 90-line cap and a connection probe | Alpaca pattern exists but isn't wired to the scanners yet |

**UNVERIFIED / external knowledge**: IB's TWS API generically supports market-scanner subscriptions
(`reqScannerSubscription`, scan codes like `TOP_PERC_GAIN`, `HOT_BY_VOLUME`) — a real IBKR API
capability, but zero code in this repo implements it. Adding it would be new development, not wiring up
something already there.

**Other sources**: 5 real news providers (RSS, FMP, Polygon, AlphaVantage sentiment, Finnhub) already
fetch market-wide article streams and tag symbols post-hoc — a possible future catalyst-tagging input,
headline-level not screener-level, out of scope for this phase.

## D. Recommended architecture (RECOMMENDED)

Model C ("continuously stream the entire universe") is not feasible with either integrated provider —
both hard-cap real-time streaming, and IBKR has no bulk data path in this codebase at all. **Model D
(Hierarchical Universal Discovery)** is the only model consistent with actual provider capability, and
it's also the closest to what's already half-built: `MarketUniverseScanner.ts`'s broad-universe + movers
funnels are already a real Tier-0/Tier-1 (full-universe scan → liquidity-screened candidates), just not
yet wired to a proper lifecycle, dedup, or prioritized dynamic-subscription layer, and gated off by
default.

```
ENTIRE TRADABLE UNIVERSE (Alpaca /v2/assets, thousands)
        |
        v
TIER 0/1 SCAN (poll): broad-universe + movers funnels (already real, off by default)
        |
        v
MARKET_OPPORTUNITY_DETECTED (new, discovery-only, never a trade signal)
        |
        v
LIQUIDITY / SAFETY SCREEN (already real: passesScreen/passesAdvScreen)
        |
        v
CANDIDATE ADMISSION (bounded, reuses maxNewSubscriptionsPerCycle)
        |
        v
DYNAMIC / PRIORITIZED SUBSCRIPTION (reuses rescue's MARKET_MOVER/EXPLORATION classes)
        |
        v
EXISTING ARGUS PIPELINE (Technical/Quant/News/Fundamental/Macro -> ChiefTrader -> RiskEngine -> OMS)
```

Does ARGUS need a WebSocket per stock? **No (PROVEN).** Alpaca's `/v2/assets` + batched
`/v2/stocks/snapshots` already let a periodic poll cover the full tradable universe. Polling is correct
for Tier 0/1 (movers, snapshots, periodic universe scans); streaming is correct only for Tier 2/3 (a
small set of admitted, currently-interesting candidates) — a hybrid, matching Alpaca's own product
boundaries (IEX WebSocket is a small bounded subscription feed by design).

## `MARKET_OPPORTUNITY_DETECTED` event schema (RECOMMENDED, fields grounded in what's actually available)

```
MARKET_OPPORTUNITY_DETECTED {
  symbol: string
  timestamp: number
  discoverySource: 'ALPACA_MOVERS' | 'ALPACA_BROAD_UNIVERSE' | 'NEWS_CATALYST' (future)
  eventType: 'GAINER' | 'LOSER' | 'HIGH_DOLLAR_VOLUME' | 'NEW_TO_UNIVERSE'
  price: number
  percentChange: number | null
  dollarVolume: number | null
  spreadBps: number | null
  advShares: number | null
  scannerRank: number | null
  sourceProvider: 'alpaca'
  freshnessMs: number
  correlationId: string
}
```
No `sector`/`catalyst` field yet — not populated anywhere in the current Alpaca responses; would
require wiring the news providers, a later phase item, not Phase A.

## Pluggable provider interface (RECOMMENDED, minimal — do not over-build)

Do not build a 5-branch `MarketDiscoveryProvider` hierarchy for one real implementation. Extend
`MarketUniverseScanner.ts`'s existing two funnels behind a single
`interface DiscoverySource { scan(): Promise<MarketOpportunityCandidate[]> }`, with
`AlpacaMoversSource` and `AlpacaBroadUniverseSource` as the only two implementations initially —
mirroring `historicalBarProvider.ts`'s already-proven registry pattern in this exact codebase. Add
IBKR/news providers only when a second real implementation actually exists to justify the interface.

## Discovery must never equal trade signal (reaffirmed, PROVEN this boundary already holds)

`OpportunityDiscovery.ts`'s own header states *"Never emits TRADE_IDEA_GENERATED"* — it only emits
`WATCHLIST_SUBSCRIBE_REQUESTED`. `gateTradeIdea()`/`ChiefTraderAgent` are untouched by any discovery
file. `MARKET_OPPORTUNITY_DETECTED` must be exactly as inert as `WATCHLIST_SUBSCRIBE_REQUESTED` is
today — a subscribe/admit signal only, never routed to `emitTradeIdea`.

## Candidate prioritization (RECOMMENDED — reuse, don't invent)

Discovery-priority signals should be exactly the fields already computed by the existing screen: dollar
volume, ADV, spread, %change, scanner rank, freshness. This is not the same computation as `setupScore`
(a strategy-fit score) — keep them structurally separate types (`DiscoveryPriority` vs
`StrategyConfidence`), never summed or compared. Bound total admissions per cycle the same way
`maxNewSubscriptionsPerCycle` (20) already bounds `OpportunityDiscovery` today.

## Candidate lifecycle (RECOMMENDED, extends what already exists)

`candidateLifecycle.ts` already has a real state machine: `DISCOVERED|WATCHING|STALE|FILTERED_OUT|PROMOTED`.
Extend rather than replace:

```
DISCOVERED -> ADMITTED (passed liquidity screen)
  -> DATA_PENDING (subscribe requested)
    -> DATA_ACTIVE (ticks arriving) -> DATA_FRESH (within stalePriceThresholdMs)
      -> EVALUATING (QuantSignalAgent cycle picked it up)
        -> EVALUATED -> PROMOTED (won bestStrategyIdea) | REJECTED (lost / ineligible)
          -> RELEASED (subscription/rescue slot returned to pool)
```
Every transition should be a real, already-emittable event (`STRATEGY_EXPLORATION_PROMOTED`,
`TEMPORARY_DATA_RESCUE_GRANTED/DENIED`, `QUANT_IDEA_DISCARDED_STALE_DATA`,
`CONSENSUS_TERMINAL_REASON` are all real events already used by `explorationHealthReport.ts`) — this
lifecycle is mostly a labeling exercise over events that already exist, plus one new state (`ADMITTED`)
for the discovery -> subscription boundary.

## Reconciling with rescue fairness (RECOMMENDED: Option E, hybrid)

Option D alone is insufficient: the scanner provides enough data to rank, but ARGUS still needs a live
price to pass `gateTradeIdea()` — discovery data (a snapshot) is not the same as a fresh streamed tick,
so rescue/subscription is still needed for any candidate that reaches evaluation. Option C (dedicated
exploration pool) is what Phase 18 just shipped (`rescueReservedSlotsForPriorityClasses`). Recommended
next increment (Option E, hybrid): keep the reserved-slot fairness fix as-is, and add a separate, small,
capped "discovery admission" queue upstream of rescue — candidates from `MARKET_OPPORTUNITY_DETECTED`
compete for a bounded number of new subscription slots per cycle (reusing
`maxNewSubscriptionsPerCycle`), landing in the existing rescue-class system as `MARKET_MOVER`-class
requests once admitted, rather than inventing a second parallel capacity system.

## Market data architecture (RECOMMENDED, maps directly onto what already exists)

```
Level 1 (discovery, lightweight): /v2/assets + /v2/stocks/snapshots batches - already real
Level 2 (candidate): same snapshot data, narrowed to admitted candidates - no new endpoint needed
Level 3 (deep evaluation): MarketDataWorker WebSocket ticks - already real, capacity-bound
Level 4 (execution): Broker-authoritative fills - already real, untouched
```

## Failure modes (RECOMMENDED, reuse existing idioms)

Scanner/provider outage, rate limit, timeout: reuse `AlpacaBroker.fetchAlpaca()`'s circuit breaker
(3-failure/30s cooldown) — the 3 scanner files currently bypass this with a bare timeout-only fetch;
closing that gap is a legitimate later item. Stale/duplicate/thousands-of-candidates bursts: fail-closed
exclusion, exactly as `screenAssets()`/`fetchAvgDailyVolumeShares()` already do. Every failure mode
should degrade to today's behavior (curated lists only) — Universal Discovery must be additive/optional
at every layer, never a single point of failure.

## Deduplication (RECOMMENDED)

3 independently-implemented dedup blocks exist today (`OpportunityDiscovery.ts:111`,
`SnapshotScanner.ts:182`, `MarketUniverseScanner.ts:304-306`), all doing the same
`trim().toUpperCase()` + `Set`. Consolidate into one shared `normalizeSymbol()`/`dedupeCandidates()`
utility later, and track discovery-source-count as a separate observability field, never folded into
discovery priority or trading confidence.

## Observability model (RECOMMENDED — extends `explorationHealthReport.ts`)

The Level 0-6 ladder built the same session (`explorationHealthReport.ts`) already answers "why was it
evaluated but not selected / emitted but rejected / reached RiskEngine but failed" for anything that
reaches `QuantSignalAgent`. Universal Discovery only needs one earlier stage — "why was it discovered
but not admitted / admitted but not subscribed" — as new levels feeding into the same
`traceId`-correlated report, not a parallel telemetry system.

## Historical validation plan (RECOMMENDED)

`src/server/replay/` (Argus Historical Evaluation, MODE B) already runs real historical bars through
real ChiefTrader/RiskEngine/OMS against `HistoricalReplayBroker`. A discovery-coverage backtest would run
the proposed Universal Discovery scan logic against historical Alpaca snapshot/movers data (if available
point-in-time) and count unique symbols discovered vs. today's curated universe, candidates passing
liquidity, candidates that would have reached strategy evaluation — explicitly not a profitability
claim.

## Success metrics (reaffirmed, not "trades more")

Discovery coverage, discovery latency, candidate quality (liquidity survival rate), pipeline
penetration, data freshness, strategy/agent diversity, resource utilization, zero downstream bypasses.
None of these are currently measured; all are derivable from the observability extension above once
built.

## Score-normalization interaction (RECOMMENDED — real, not yet acted on)

Universal Discovery would make the existing setupScore concentration problem worse before it's better:
more candidates reaching `evaluateAll()` means more chances for a high-scoring-by-formula strategy
(e.g. OSCILLATOR_MOMENTUM, mean ~76.7) to win by raw magnitude regardless of which strategy actually
fits the new symbol best — the same MEAN_REVERSION-vs-OSCILLATOR_MOMENTUM (18.3 vs 76.7) imbalance
documented in `ARGUS_PHASE18_SCORE_NORMALIZATION_RESEARCH_NOTE.md`. That note's tiered recommendation
stands unchanged; Universal Discovery is an argument for prioritizing that work sooner in the phase
sequence below, not for skipping it.

## Implementation phases (RECOMMENDED)

- **Phase A** (this document) — done.
- **Phase B** — consolidate dedup, wire the existing scanner files through `AlpacaBroker`'s
  circuit-breaker pattern, name the `ADMITTED` lifecycle stage, add `MARKET_OPPORTUNITY_DETECTED`
  (still discovery-only, no subscription change).
- **Phase C** — the minimal `DiscoverySource` interface, still gated off by default, still capped by
  `maxNewSubscriptionsPerCycle`.
- **Phase D** — candidate lifecycle wired into `explorationHealthReport.ts`-style observability.
- **Phase E** — dynamic admission queue feeding rescue's `MARKET_MOVER` class (Option E above).
- **Phase F** — historical replay coverage validation, no profitability claim.
- **Phase G** — paper-trading observation only, supervised, per the existing soak-floor rules in
  `CLAUDE.md`.
- **Phase H** — only after G's evidence, revisit score-normalization tiering.

## Files/modules likely touched later (not changed by this report)

`OpportunityDiscovery.ts`, `SnapshotScanner.ts`, `MarketUniverseScanner.ts`, `MarketDataWorker.ts`
(admission plumbing only, never the streaming cap itself), `candidateLifecycle.ts`,
`explorationHealthReport.ts`, `config/continuousIntelligence.json` (new fields, no existing values
changed), `config/eventNames.json` (new event name).

## Safety-boundary audit

Zero files were touched to produce this document. Every recommendation stays strictly upstream of
`emitTradeIdea`/ChiefTrader/RiskEngine/OMS — discovery remains subscribe-only, exactly as
`OpportunityDiscovery.ts` is today. No consensus, gate, threshold, or capital-limit change is implied
or recommended by anything above. Implementation would start at Phase B, only on explicit operator
go-ahead — nothing above is authorized by this document alone.
