# ARGUS opportunity discovery

Honesty: discovery is **not** automatic buying. Organic PAPER FILLED SELL P&L is independently tracked and remains **0** until soak counts it.

## What exists (code)

| Piece | Behavior | Default |
|---|---|---|
| `OpportunityDiscovery` | Bounded scan of `seedSymbols` + `watchUniverseSymbols` (+ `pennyWatchSymbols` only if penny overlay on). Emits `WATCHLIST_SUBSCRIBE_REQUESTED` only. `ideasEmitted` always 0. | `ARGUS_OPPORTUNITY_LOOP_ENABLED=false` |
| `candidateLifecycle` | In-memory DISCOVERED / WATCHING / STALE / FILTERED_OUT / PROMOTED. Capped by `maxCandidateRecords`. | n/a |
| `OpportunityScreener` | Cheap N-tick return rank. May `emitTradeIdea` as agent `OpportunityScreener` (**one vote**). No LLM. No `placeOrder`. | `ARGUS_OPPORTUNITY_IDEAS_ENABLED=false` |
| IEX subscriptions | `maxActiveSubscriptions` **12** (Alpaca default; `ibkr_gateway` raises the effective cap via `hardCapOverride` to `ibkrConnection.maxMarketDataLines`, 90), `maxNewSubscriptionsPerCycle` **20**, scan 120s. `MarketDataWorker` **prunes** least-active non-protected symbols before accepting new `WATCHLIST_SUBSCRIBE_REQUESTED` entries (Alpaca symbol-limit hygiene). | reviewed JSON (`config/continuousIntelligence.json`) |
| `MarketUniverseScanner` | Real, liquidity/price/spread-screened Alpaca tradable-assets funnel (3 stages: full tradable-assets list → batched snapshot screen → real ADV-shares screen), ranked by dollar volume, capped at `broadUniverseMaxCandidates`. Merges into the same scan pool `OpportunityDiscovery` already runs through `evaluateOpportunityCandidate()` — never emits `WATCHLIST_SUBSCRIBE_REQUESTED` or `TRADE_IDEA_GENERATED` itself. **Runtime-verified 2026-08-26**: scan universe went 122→134 symbols on first enable, including a name not in any curated list. Real Alpaca API cost/rate-limit exposure per refresh (`broadUniverseAssetsCacheTtlMs` cadence) — check `GET /api/v2/continuous-intelligence/status`'s `broadUniverse` block. | `ARGUS_BROAD_UNIVERSE_ENABLED=false` |
| Campaign opening surge | When `settings.campaign_enabled`, liquid-universe RVOL/ORB scan in 09:30–09:40 ET emits confluence nudges / watchlist only — see `ARGUS_CAMPAIGN_TRACKER.md`. Does **not** enable QUANT or lower consensus. | campaign off by default |

Not implemented: news/fundamental Level-4 funnel as a dedicated scanner, penny MARKET execution (`marketOrdersFitPennyAndMicro: false`). Market-wide discovery is now real (`MarketUniverseScanner`, above) but off by default and screened down to a liquid/tradable subset, not a full unfiltered tape.

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

