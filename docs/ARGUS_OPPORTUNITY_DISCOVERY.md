# ARGUS opportunity discovery

Honesty: discovery is **not** automatic buying. Organic PAPER FILLED SELL P&L is independently tracked and remains **0** until soak counts it.

## What exists (code)

| Piece | Behavior | Default |
|---|---|---|
| `OpportunityDiscovery` | Bounded scan of `seedSymbols` + `watchUniverseSymbols` (+ `pennyWatchSymbols` only if penny overlay on). Emits `WATCHLIST_SUBSCRIBE_REQUESTED` only. `ideasEmitted` always 0. | `ARGUS_OPPORTUNITY_LOOP_ENABLED=false` |
| `candidateLifecycle` | In-memory DISCOVERED / WATCHING / STALE / FILTERED_OUT / PROMOTED. Capped by `maxCandidateRecords`. | n/a |
| `OpportunityScreener` | Cheap N-tick return rank. May `emitTradeIdea` as agent `OpportunityScreener` (**one vote**). No LLM. No `placeOrder`. | `ARGUS_OPPORTUNITY_IDEAS_ENABLED=false` |
| IEX subscriptions | `maxActiveSubscriptions` **30**, `maxNewSubscriptionsPerCycle` 4, scan 120s. `MarketDataWorker` **prunes** least-active non-protected symbols before accepting new `WATCHLIST_SUBSCRIBE_REQUESTED` entries (Alpaca symbol-limit hygiene). | reviewed JSON (`config/continuousIntelligence.json`) |
| Campaign opening surge | When `settings.campaign_enabled`, liquid-universe RVOL/ORB scan in 09:30–09:40 ET emits confluence nudges / watchlist only — see `ARGUS_CAMPAIGN_TRACKER.md`. Does **not** enable QUANT or lower consensus. | campaign off by default |

Not implemented: market-wide tape scan, news/fundamental Level-4 funnel as a dedicated scanner, penny MARKET execution (`marketOrdersFitPennyAndMicro: false`).

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

