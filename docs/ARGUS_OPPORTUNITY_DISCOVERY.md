# ARGUS opportunity discovery

Honesty: discovery is **not** automatic buying. Organic PAPER FILLED SELL P&L is independently tracked and remains **0** until soak counts it.

## What exists (code)

| Piece | Behavior | Default |
|---|---|---|
| `OpportunityDiscovery` | Bounded scan of `seedSymbols` + `watchUniverseSymbols` (+ `pennyWatchSymbols` only if penny overlay on). Emits `WATCHLIST_SUBSCRIBE_REQUESTED` only. `ideasEmitted` always 0. | `ARGUS_OPPORTUNITY_LOOP_ENABLED=false` |
| `candidateLifecycle` | In-memory DISCOVERED / WATCHING / STALE / FILTERED_OUT / PROMOTED. Capped by `maxCandidateRecords`. | n/a |
| `OpportunityScreener` | Cheap N-tick return rank. May `emitTradeIdea` as agent `OpportunityScreener` (**one vote**). No LLM. No `placeOrder`. | `ARGUS_OPPORTUNITY_IDEAS_ENABLED=false` |
| IEX subscriptions | `maxActiveSubscriptions` **12** (Alpaca default; `ibkr_gateway` raises the effective cap via `hardCapOverride` to `ibkrConnection.maxMarketDataLines`, 90), `maxNewSubscriptionsPerCycle` **20**, scan 120s. `MarketDataWorker` **prunes** least-active non-protected symbols before accepting new `WATCHLIST_SUBSCRIBE_REQUESTED` entries (Alpaca symbol-limit hygiene). | reviewed JSON (`config/continuousIntelligence.json`) |
| `MarketUniverseScanner` (broad universe) | Real, liquidity/price/spread-screened Alpaca tradable-assets funnel (3 stages: full tradable-assets list → batched snapshot screen → real ADV-shares screen), ranked by dollar volume, capped at `broadUniverseMaxCandidates`. Merges into the same scan pool `OpportunityDiscovery` already runs through `evaluateOpportunityCandidate()` — never emits `WATCHLIST_SUBSCRIBE_REQUESTED` or `TRADE_IDEA_GENERATED` itself. **Runtime-verified 2026-08-26**: scan universe went 122→134 symbols on first enable, including a name not in any curated list. Real Alpaca API cost/rate-limit exposure per refresh (`broadUniverseAssetsCacheTtlMs` cadence) — check `GET /api/v2/continuous-intelligence/status`'s `broadUniverse` block. | `ARGUS_BROAD_UNIVERSE_ENABLED=false` |
| `MarketUniverseScanner` (movers) | Real Alpaca `/v1beta1/screener/stocks/movers` top-gainers/losers funnel (`fetchTopMovers`/`refreshMoversCache`/`getCachedMoverSymbols`), re-screened through the *same* `passesScreen`/`passesAdvScreen` liquidity/ADV gates as the broad-universe funnel (the raw movers response includes illiquid sub-$1 names). Merges up to `moversTopNPerScan` (20) survivors into `getOpportunityScanUniverse()`. Never emits an idea itself. | `ARGUS_MARKET_MOVERS_ENABLED=false` |
| Campaign opening surge | When `settings.campaign_enabled`, liquid-universe RVOL/ORB scan in 09:30–09:40 ET emits confluence nudges / watchlist only — see `ARGUS_CAMPAIGN_TRACKER.md`. Does **not** enable QUANT or lower consensus. | campaign off by default |

Not implemented: news/fundamental Level-4 funnel as a dedicated scanner, penny MARKET execution (`marketOrdersFitPennyAndMicro: false`). Market-wide discovery is now real (`MarketUniverseScanner`'s broad-universe and movers funnels, above) but off by default and screened down to a liquid/tradable subset, not a full unfiltered tape. A research-only design for a further "Universal Market Discovery" architecture (continuous market-wide scanning decoupled from the fixed subscription cap) exists in [`docs/audits/ARGUS_PHASE18_19_UNIVERSAL_DISCOVERY_RESEARCH.md`](audits/ARGUS_PHASE18_19_UNIVERSAL_DISCOVERY_RESEARCH.md) as of 2026-09-01 — not implemented, no code/config changed by it.

## Temporary data rescue (bounded eviction-immunity)

`MarketDataWorker.requestTemporaryDataRescue(symbol, reason, opts)` grants a symbol a bounded,
single-use window (`temporaryDataRescueMaxDurationMs`, 5 min) of eviction-immunity so a strategy idea
that would otherwise be discarded for stale/unsubscribed data gets one more evaluation cycle with live
data. It **never implies trade eligibility** and never bypasses any RiskEngine gate — it only affects
which symbol `MarketDataWorker` keeps streaming.

Hard-capped at `maxConcurrentTemporaryDataRescues` (3) system-wide. As of 2026-09-01 (Phase 18),
admission is **request-class-aware**, not pure FIFO/capacity-only: `rescueReservedSlotsForPriorityClasses`
(1) reserves that many slots exclusively for `EXPLORATION`/`MARKET_MOVER`-class requests, so a repeat
`ROUTINE_RECOVERY` requester can no longer exhaust every slot before a genuinely starved
exploration-promoted or real-mover candidate ever gets a turn (the concrete failure pattern this fixed:
CRM/ONON exploration candidates denied while AAPL/TSLA/AI held all 3 slots on repeat routine
re-requests). `QuantSignalAgent` classifies its own rescue requests: `EXPLORATION` if
`StrategyExplorationScheduler` promoted a non-natural-top strategy this cycle, `MARKET_MOVER` if the
symbol is a current `getCachedMoverSymbols()` survivor, else `ROUTINE_RECOVERY`. Every denial is now
logged (`TEMPORARY_DATA_RESCUE_DENIED`, reason one of `INVALID_SYMBOL` / `RESCUE_CAPACITY_FULL` /
`ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY` / `AT_CAPACITY_NO_SAFE_EVICTION`) — previously silent.

`StrategyExplorationScheduler.selectWithBoundedExploration()` (Phase 15) is the pure-reordering
function that can promote a starved-but-eligible strategy ahead of the natural highest-`setupScore`
pick, bounded by `strategyExplorationCooldownMs` (24h) and `strategyExplorationMinIntervalMs` (15 min,
`config/quantThresholds.json`). It never changes ChiefTrader's weights/threshold and never itself
touches OMS/RiskEngine.

**Observability**: `argus-cli exploration-health` (joins each `STRATEGY_EXPLORATION_PROMOTED` promotion
to rescue grant/denial, idea discard/emission, consensus, RiskEngine, and OMS/fill outcomes by shared
`traceId` into a Level 0–6 success ladder) and `argus-cli rescue-occupants` (who currently holds a
rescue slot, what class, since when) — see `ARGUS_CLI.md` § Observability.

## Discovery Lineage Ledger (Phase A, 2026-09-02)

Before this phase, a candidate `MarketUniverseScanner`'s liquidity screen rejected (or a raw mover
Alpaca never returned a snapshot for at all) simply vanished with zero record — the exact gap that
made a real, externally-verified market mover (FRVO, `docs/audits/ARGUS_UNIVERSAL_DISCOVERY_PAPER_TRADING_FORENSIC_AUDIT_2026-09-01.md`)
architecturally unexplainable after the fact. Both `refreshBroadUniverseCache()` and
`refreshMoversCache()` now log a real `DISCOVERY_CANDIDATE_ADMITTED`/`DISCOVERY_CANDIDATE_FILTERED`
event per candidate (movers: every stage; broad-universe: the ADV/rank-cap stage only, to bound log
volume against a thousands-of-assets scan), with the exact reason
(`PRICE`/`DOLLAR_VOLUME`/`SPREAD`/`ADV`/`RANK_CAP`/`NO_SNAPSHOT_DATA`). `argus-cli discovery-lineage
--symbol=X` joins that decision through to subscription/quant-evaluation/idea/consensus/risk/OMS —
see `ARGUS_CLI.md` § Observability. This only covers activity after the phase shipped; it cannot
retroactively explain an earlier miss.

Watch vs BUY: unknown spread / unknown dollar volume / MARKET-unfit **do not** block watchlist subscribe (chicken-and-egg). Known wide spread, poor liquidity, and excessive volatility still reject. BUY still hits `applyAssetIdeaGate`.

## Funnel

LEVEL 1–2: reviewed universe + ticker validity + (if penny overlay on) hard safety reject for watch.  
LEVEL 3: optional screener return rank → `TRADE_IDEA_GENERATED`.  
LEVEL 5–9: existing Technical / Quant / Kronos / Fund / Macro / News ideas + ChiefTrader 0.75 / min-2 + RiskEngine + sizing + OMS.

Screener ideas **do not** satisfy consensus alone.

## Storm defense (also global)

`tradingSafety.maxTradeIdeasPerMinute` (120) and `maxAiCallsPerMinute` (90). Events: `IDEA_RATE_LIMITED`, `AI_RATE_LIMITED`. Status: `GET` continuous-intel `/status` `pipelineRate`.

## Operator

Do not set either opportunity flag “to see if it works.” Watchlist expansion without the ideas flag still does **not** create trades. Penny names appear only if listed in `pennyWatchSymbols` (default empty) **and** the penny overlay is on.

