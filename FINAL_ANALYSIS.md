# Argus Autonomous Trading Platform — Technical & Functional Analysis

> ## LATEST READINESS AUDIT (2026-08-12) — READ THIS FIRST
>
> A fresh, ground-truth, read-only audit of the current repository (not a re-read of any prior
> audit's own claims) was performed to answer one question: **how close is Argus, in its current
> state, to being safe and technically ready for autonomous real-money trading?** Full 28-section
> report with file:line evidence: **Section 30, "Deep Technical + Quantitative Autonomous Trading
> Readiness Audit," at the end of this document.** Executive answer:
>
> ```
> AUTONOMOUS REAL-MONEY READINESS:     53%
> SOFTWARE READINESS:                  ~58%
> TRADING-VALIDATION READINESS:        ~15%
> AI READINESS:                        ~35%
> QUANT STRATEGY READINESS:            ~25%
>
> REAL-MONEY STATUS:                   NO-GO
> CURRENT RECOMMENDATION:              PAPER (extended validation, not restricted live)
>
> TOP 5 BLOCKERS:
> 1. No validated trading edge anywhere — the one out-of-sample check ever run on this
>    codebase's own best-looking numbers showed 79-89% of the apparent edge evaporating
>    out-of-sample (Section 30.17).
> 2. Portfolio reconciliation's "pauses trading on large mismatch" safety claim is FALSE —
>    verified by tracing the actual code: it sets a flag RiskEngine's real gate never reads
>    (Section 30.12, CRITICAL — REAL-MONEY RISK).
> 3. Zero timeout anywhere in the broker or AI call stack — a hung Alpaca or LLM call blocks
>    indefinitely with no circuit breaker (Sections 30.5, 30.11).
> 4. No order-level crash recovery — an order Alpaca filled but the app crashed before
>    recording can sit permanently wrong in the local DB (Section 30.5).
> 5. No AI-driven decision (News/Fundamental/Macro/ChiefTrader debate) has ever been
>    backtested — the backtester has zero references to the AI layer at all (Section 30.8).
>
> MINIMUM REALISTIC CAPITAL: ~$3,000-5,000 for restricted live (once other gates close) —
> below the default $3,000 flat order cap, whole-share pricing on real symbols leaves too
> little room to diversify or size meaningfully (Section 30.26).
>
> PROFITABILITY EVIDENCE:   UNVALIDATED
> AI TRADING EDGE:          UNVALIDATED
> QUANT EDGE:                UNVALIDATED
>
> FINAL VERDICT: NOT READY FOR AUTONOMOUS REAL-MONEY TRADING. See Section 30.27 for the full
> Go/No-Go reasoning and the 10 hard gates (7 of 10 fail).
> ```
>
> **2026-08-15 honesty pass (Section 31) does not change the scores above.** UI/docs/`npm run dev`
> companion-process work is additive and does not create a trading edge or raise LIVE readiness.

---

This document was previously a self-generated, unverified summary that significantly overstated the
platform's readiness (e.g. claimed "85% production ready," "Broker integration: 95%," with no
supporting evidence). It has been rewritten to match the findings of a three-pass, independently
verified engineering audit (live-tested against the running application, not just source-read) — see
the published audit artifact for full detail and evidence citations. `CLAUDE.md` is the authoritative,
continuously-maintained architecture reference; this file is a narrative summary of the same reality.

## 1. Executive Summary

Argus is a full-stack, event-driven, multi-agent autonomous trading platform: independent agents
(Technical, News, Fundamental, Macro) evaluate market data and propose trades; a Chief Trader
aggregates proposals into a weighted consensus; a Risk Engine sizes and validates the trade against
real account state; an Order Management Service executes it through a broker adapter.

**What is real and live-verified today:**
- Real Alpaca WebSocket market data and real order execution (paper and live, gated behind an explicit
  confirmation phrase — see Section 4).
- Real technical indicators (RSI, MACD, SMA, Bollinger Bands) with a calculated (not hardcoded)
  confidence score.
- Real AI-router-mediated reasoning for News/Fundamental/Macro agents, with real per-provider cost
  tracking and real per-agent provider routing.
- A real risk engine: daily-loss kill-switch, consecutive-loss breaker, market-hours/stale-data checks,
  single-symbol concentration cap, a sector concentration cap (GICS-mapped large caps), a real
  correlation-based exposure cap (90-day return correlation, backed by real OHLCV history), a working
  (fixed this pass) high-impact-news veto, order idempotency, and real fill-price tracking - 9 gates now.
- AutoBot is now running continuously in PAPER mode (enabled this pass) - the News Intelligence and
  Activity Logs tabs are populated with real data for the first time, and real per-agent consensus
  (Technical/News/Fundamental/Macro/Kronos → ChiefTrader → RiskEngine) is live-verified end-to-end,
  including a real bug found and fixed along the way (see below).
- NewsAgent's AI calls now route through the local Ollama stack ($0/call) instead of a paid provider,
  and NewsImpactEngine's sentiment score is now real FinBERT output (with the previous keyword-regex
  heuristic kept only as a fallback for when the local service is down).
- A real historical backtest + walk-forward validation engine — run against real Alpaca history across
  six symbols now (AAPL plus MSFT/NVDA/AMD/TSLA/SPY added this pass). It shows **no statistically
  meaningful out-of-sample edge** for the deterministic technical strategy on any of them (every run is
  below the engine's own 20-closed-trade significance floor); this is a real, unfabricated result, not
  a defect in the engine. See Section 9 for the per-symbol numbers.
- A real local AI stack (Ollama + a local Chronos time-series forecasting service) — the previously
  permanently-throwing Kronos forecaster now produces real forecasts.
- A real test suite (54 unit + 1 integration test), real CI (GitHub Actions), and a real Docker/health-check deployment path.

**What is not yet real:**
- 17 dashboard visualization panels are still static/decorative (hardcoded arrays or
  `Date.now()`-seeded jitter) — explicitly deferred, not hidden.
- Only Alpaca can trade fully autonomously; Interactive Brokers is now a real adapter but requires human
  2FA roughly every 24h; Questrade and Coinbase order execution are stubs by design.
- Monte Carlo backtest sensitivity and a historical replay of the full AI-agent consensus (as opposed
  to just the deterministic technical rules) do not exist yet.

**Honest overall assessment:** BETA. Paper-trading readiness criteria are met. Live-capital readiness
is not — not because of missing infrastructure (that gap is closed), but because the one real strategy
test run so far shows no edge, and the only broker that can run fully unattended is Alpaca.

---

## 2. Feature Inventory

| Feature | Status | Evidence |
|---|---|---|
| Market data streaming (Alpaca WS) | Real | `MarketDataWorker.ts`, connected in every boot log this engagement |
| Technical Agent (RSI/MACD/SMA/BBands) | Real | Confidence is a calculated function of indicator magnitude, not a constant |
| Chief Trader consensus | Real | Weighted vote, DB-synced weights, real per-agent AI routing |
| Risk Engine | Real | Daily-loss/consecutive-loss/concentration/stale-data/market-hours/news-veto gates, all unit-tested |
| Order Management | Real | Idempotent by traceId, real fill-polling, real realized P&L on SELL |
| Portfolio reconciliation | Real | Emits a real mismatch/match event; pauses trading past a $100 impact threshold |
| Explainability | Real | LLM narrative generated from the actual persisted event trace of a specific decision |
| Backtesting / walk-forward | Real, unfavorable result | Real Alpaca history; 6 symbols tested (AAPL, MSFT, NVDA, AMD, TSLA, SPY), none show a statistically meaningful edge |
| AI cost tracking | Real | `estimateCost()` implemented with real published pricing per provider |
| Kronos/Chronos forecasting | Real | Local Chronos model via a persistent Python service; live-verified BUY/SELL/HOLD |
| Interactive Brokers | Real, but manual-2FA-gated | Real Client Portal Web API client; cannot run fully unattended |
| Paper→live confirmation gate | Real | Requires an exact confirmation phrase; previously not reachable at all |
| Automated tests | Real | 54 unit tests / 6 files + 1 real integration test (vitest), real CI |
| Local AI stack (Ollama/Chronos/FinBERT) | Real | Chronos (Kronos forecaster), FinBERT (news sentiment), and Ollama (NewsAgent's AI calls) are all wired into a live agent now; XGBoost still installed but unused |
| News provider health stats | Real (fixed this pass) | Was 100% hardcoded (`enabled:true, health:"Healthy", errorCount:0`) regardless of real state; now tracks real per-provider fetch/error/lastFetch stats |
| Sector concentration limit | Real | 40% cap on GICS-mapped large caps |
| Correlation-based exposure limit | Real | 50% cap across symbols with >0.7 real 90-day return correlation; skips (doesn't block) when history is unavailable |
| Dead paid-AI-provider deprioritization | Real | `AIRouter` now sorts known-`Offline` providers (from real call outcomes) to the end of the attempt order instead of retrying them every call |
| XGBoost direction classifier | Trained, evaluated, NOT wired in | Real walk-forward result (56.7% vs 53.3%/50% baselines) whose 95% CI overlaps the naive baseline - inconclusive, so not used by any live agent |
| Questrade / Coinbase execution | Stub by design | `placeOrder()` throws; blocked from being selected as the active broker |
| ~17 dashboard visualization panels | Decorative | Static arrays / deterministic jitter; explicitly deferred |

---

## 3. Architecture Overview

One Node.js process: Express API + Vite (dev)/static (prod), a raw `ws` WebSocket server, and an
in-process `EventEmitter` as the message bus. Decision-lifecycle events (trade ideas, consensus,
risk assessments, orders, learned rules) carry a real typed envelope (`eventId`, `schemaVersion`,
`correlationId`, `source`) and are durably persisted to `event_traces`, replayable by correlation ID
after a restart. High-frequency ticks stay in-memory only, by design, to avoid unbounded DB growth.

**Real pipeline:**
`Alpaca WS → MarketDataWorker → EventBus:MARKET_DATA → Technical/News/Fundamental/Macro/Kronos agents
→ TRADE_IDEA_GENERATED → ChiefTraderAgent (weighted consensus, optional AI debate)
→ CHIEF_APPROVED_IDEA → RiskAgent → RiskEngine → RISK_ASSESSMENT_COMPLETED
→ OrderManagementService → BrokerManager.getActiveBroker() → ORDER_EXECUTED → WS → React`

**Research plane (backtesting), real but separate from the live pipeline:**
`HistoricalDataGateway (real Alpaca bars) → ohlcv_bars → ReplayClock (point-in-time gated)
→ BacktestEngine (same deterministic technical rules as live TechnicalAgent) → backtest_runs`

This backtests the deterministic technical strategy only — it does not yet replay the AI-agent
consensus layer against history, which needs point-in-time news/fundamentals and per-bar AI calls
across a real date range. Explicitly scoped out, not claimed as done.

---

## 4. Trading Safety Controls

- **Emergency stop** — real, blocks all new trades until manually resumed.
- **Daily-loss kill-switch** — trips at 80% of the configured daily loss limit, using real broker
  equity against a real start-of-day baseline.
- **Consecutive-loss breaker** — blocks new trades after 3 consecutive real losing FILLED trades.
- **Market-hours / stale-data checks** — real Alpaca clock call; real per-symbol tick-age tracking.
- **Single-symbol concentration cap** — 20% of real account equity; reduces size rather than rejecting.
- **Sector concentration cap** — 40% of equity across GICS-mapped large caps.
- **Correlation-based exposure cap** — 50% of equity across symbols with real >0.7 90-day return
  correlation to the proposal; skips (doesn't block) when real price history is unavailable.
- **High-impact-news veto** — fixed this pass; was querying a column that doesn't exist on the table it
  queried and could never fire for any trade, regardless of real news.
- **Order idempotency** — a second order for the same `traceId` is refused.
- **Paper→live promotion gate** — real, requires an exact confirmation phrase
  (`LIVE_TRADING_CONFIRMATION_PHRASE`); there was previously no reachable path to live trading at all.

---

## 5. AI Architecture

`AIRouter` is a real provider-agnostic abstraction — every agent calls `routeTask()`/`routeConsensus()`
and never touches a provider SDK directly. It fails over by priority → health → success-rate → latency
and logs every call (latency, tokens, cost, success) to SQLite. `estimateCost()` is implemented with
real published pricing per provider (Gemini, OpenAI, DeepSeek, Grok, generic aggregator fallback); local
models (Ollama, Chronos) cost $0.

Per-agent provider routing is real and persisted (`agent_routing_overrides`) — the "Agent Routing" UI
tab previously posted to a route that didn't exist.

An optional local AI stack (`npm run setup:ai`, `npm run ai:serve`) provides Ollama-hosted chat models
(`llama3.2`, `0xroyce/plutus`, a locally-built `fingpt`) and a persistent local Python inference service
serving both real Chronos time-series forecasting and (added this pass) real FinBERT sentiment scoring.
Chronos feeds the Kronos forecaster, FinBERT feeds `NewsImpactEngine`'s sentiment score (replacing a
keyword-regex heuristic, kept only as a fallback), and NewsAgent's AI calls are now routed through the
local Ollama endpoint via a persisted `agent_routing_overrides` row rather than a paid provider. XGBoost
(a direction-probability input for TechnicalAgent) is still installed but not yet wired into any agent -
deliberately, since wiring in an untrained/unvalidated model would repeat the same fabrication risk this
whole audit has been correcting for.

---

## 6. Broker Integration

| Broker | Can place real orders? | Notes |
|---|---|---|
| Alpaca | Yes | Only broker that can run fully unattended |
| Internal Paper Simulator | Yes (simulated) | Real spread-modeling fill logic |
| Interactive Brokers | Yes, with caveats | Real Client Portal Web API client; requires human 2FA ~every 24h; cannot trade Canadian-listed equities (IIROC 3200A.1(b)(i), a regulatory restriction, not a technical gap) |
| Questrade | No | `placeOrder()` throws by design — official API is account/data-only, order execution is partner-developer-only |
| Coinbase | No | Placeholder, throws by design |

All non-functional/manual-step brokers are blocked from being selected as the active order-placing
broker at the code level, not just documented as unsupported.

### 6a. Canadian Broker Landscape (real research this pass, not assumed)

The user asked for a serious look at Canadian-accessible brokers beyond Alpaca/IBKR/Questrade. Researched
live (web search + primary-source fetches, not carried forward from training data) rather than assumed:

| Broker | Official API | Trading API | Canadian-listed equities (automated) | Status | Reason |
|---|---|---|---|---|---|
| Alpaca | Yes (real, integrated) | Yes (real, integrated) | N/A - US broker, doesn't list Canadian equities | **Real, integrated** | Only broker that runs fully unattended today |
| Interactive Brokers | Yes (Client Portal Web API, real, integrated) | Yes, but not for Canadian-exchange securities | Blocked | **Real, integrated (US/intl only)**, human 2FA ~24h | IIROC Dealer Member Rule 3200 A.1.(b)(i) - confirmed via IBKR's own order-routing disclosure and OSC filings: IIROC-member dealers may not let clients use automated order systems for orders on a Canadian exchange/marketplace |
| Questrade | Yes (OAuth2, real, documented) | Order placement restricted to Questrade-approved partner developers - not open to a third-party retail app | Same IIROC constraint would apply even to a partner integration | **Stub (accurate as-is)** | `placeOrder()` correctly throws; becoming a Questrade-approved partner is a business relationship, not something more code resolves |
| Wealthsimple | **None** - confirmed no developer API exists | No | No | **UNSUPPORTED_OFFICIAL_API** | Wealthsimple's own published terms explicitly prohibit automated/API trading and warn of account termination for violators |
| National Bank Direct Brokerage (NBDB) | None found | No | No | **UNSUPPORTED_OFFICIAL_API** | No public developer program found in any primary source checked |
| TD Direct Investing / RBC Direct Investing / BMO InvestorLine / CIBC Investor's Edge / Scotia iTRADE | None found for any of the five | No | No | **UNSUPPORTED_OFFICIAL_API** (all five) | No public API program exists for any Big-5-bank direct-investing platform; would face the same IIROC constraint for Canadian-listed orders even if one existed |
| SnapTrade (third-party aggregator, not a broker) | Yes, real, commercial (400M+ accounts, 35+ institutions claimed) | Yes - claims real order placement across 20+ brokerages including Questrade, CIBC Investor's Edge, **and Wealthsimple** | Apparently yes via SnapTrade's own broker partnerships | **Real product, NOT integrated - flagged, not recommended without the user's own legal review** | Its own FAQ confirms Wealthsimple order placement "with user permission," which sits in direct tension with Wealthsimple's own published ToS language banning API trading. This is a compliance judgment call for the account holder, not something an engineering decision can resolve either way - documented here rather than silently integrated or silently ignored. |
| Coinbase | Yes (real exchange API) | Not implemented in Argus | N/A | **Stub (accurate as-is)** | Just unimplemented; no regulatory blocker distinct from any other crypto exchange |

**Bottom line:** the reason no Canadian bank offers a retail trading API isn't merely "hasn't built it yet" -
it's IIROC's DMR 3200 A.1.(b)(i) constraint on automated order systems for Canadian-exchange securities,
which applies to every IIROC-member dealer (which is all of the above except Alpaca). The one real path to
broader Canadian coverage that exists today, SnapTrade, does so by being the aggregator/dealer-of-record
relationship itself for the brokers it integrates - and even it has a documented tension with at least one
underlying broker's own terms. Building N one-off Argus adapters to banks with no public API would mean
either scraping (explicitly against this project's own standing rule) or waiting on a partner relationship
that isn't a code problem.

Sources: [Questrade API docs](https://www.questrade.com/api/documentation/rest-operations/order-calls/) ·
[Wealthsimple API status](https://wealthawesome.com/wealthsimple-api) ·
[IIROC electronic trading guidance](https://www.ciro.ca/newsroom/publications/guidance-respecting-electronic-trading) ·
[IBKR Canadian order-routing disclosure](https://www.interactivebrokers.com/en/?f=%2Fen%2Faccounts%2FlegalDocuments%2ForderRoutingDisclosureCA.php) ·
[SnapTrade Wealthsimple integration](https://snaptrade.com/brokerage-integrations/wealthsimple-api) ·
[SnapTrade brokerage integrations](https://snaptrade.com/brokerage-integrations)

---

## 7. Testing

- **Unit tests:** 54 tests across 6 files (vitest) — RiskEngine's gates, OrderManagement idempotency
  and fill-polling, ChiefTraderAgent consensus math, EvidenceAggregator's weighted-vote math, and a
  broker-adapter capability contract test. Previously zero test files existed anywhere in the repo.
- **Integration tests:** one real one added this pass (`src/server/integration/marketDataToRisk.test.ts`)
  — feeds a real MARKET_DATA tick sequence through the actual TechnicalAgent → ChiefTraderAgent →
  RiskAgent → RiskEngine chain over the real EventBus singleton, backed by a real isolated temp SQLite
  DB (`ARGUS_DB_PATH`, added this pass so tests never share a connection with the live `data/argus.db`).
  Every other test in the repo mocks the DB/EventBus per-module; this is the first proof the modules are
  actually wired together the way `SystemBootstrap.ts` assembles them at boot, not just individually
  correct. Scope: MARKET_DATA → RISK_ASSESSMENT_COMPLETED only (not yet through order placement/fills).
  Found and fixed one real test-harness issue along the way: `EncryptionService.ts` reloads `.env` at
  module-load time via a transitive import, silently re-injecting real Alpaca credentials into
  `process.env` after they'd been deliberately cleared for the test.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) runs lint + test + build on every push/PR.
- **`npm run lint`:** now actually runs `tsc --noEmit` — previously a no-op that printed a string.
- **E2E (browser-driven UI) tests:** still not implemented.

---

## 8. Deployment

- Multi-stage `Dockerfile` (native rebuild for `better-sqlite3`, slim runtime image) +
  `docker-compose.yml` with a persistent volume for `data/`.
- `GET /health` (liveness) and `GET /ready` (liveness + real SQLite reachability check), unauthenticated
  by design for container orchestration.
- Real database export/import (`GET|POST /api/v1/system/export-db`/`import-db`) — previously wrote to a
  path (`database/`) the app never read from, so export always 404'd.
- `data/argus.db` (a live database, including encrypted API keys) and a constantly-churning
  runtime-state file are no longer tracked in git.
- `archive/python-platform/` — a disconnected Python reimplementation, archived (not deleted) per
  explicit user decision; the running Node app never imported or called it.

---

## 9. Known Gaps (honest, not exhaustive)

**Trading capability:**
- No demonstrated out-of-sample edge for the deterministic strategy. Broadened this pass from one
  real result (AAPL) to five more real 2024-2025 daily-bar backtests (MSFT, NVDA, AMD, TSLA, SPY):
  2 of 5 negative return, 3 of 5 positive, and **every single one is flagged
  `INSUFFICIENT SAMPLE SIZE` (<20 closed trades)** by the engine's own statistical-significance check.
  This is broader real evidence against an edge, not evidence for one - a few positive symbols among
  five tiny, noisy samples is exactly what you'd expect from a strategy with no real edge.
- `trades` table was empty at the start of this pass; AutoBot is now running in PAPER mode (see below),
  so real (simulated) order history will start accumulating going forward. As of the point this pass
  ended, ChiefTrader had not yet reached its 0.75 consensus threshold on any symbol - 0 orders placed -
  which is the system correctly withholding action on weak/single-agent signals, not a bug.
- Correlation-based exposure limits still do not exist (see sector cap below for what was added).

**UI:**
- ~17 dashboard panels remain decorative — explicitly deferred by the user, not hidden.
- Global News Intelligence and System Activity Logs are now populated with real data - AutoBot was
  enabled in PAPER mode this pass, which starts the background pipeline (`SystemBootstrap.start()`)
  that feeds both. That gate itself (AutoBot toggle controls the whole pipeline, not just order
  placement) is unchanged; what changed is that it's now actually turned on.
- News provider health stats were 100% hardcoded (`enabled:true, health:"Healthy", errorCount:0`
  always) - fixed this pass with real per-provider fetch/success/error tracking.

**New finding this pass, fixed:**
- `NewsDeduplicator` keyed only on a content fingerprint (title + first 100 chars of content), which
  was unstable enough across refetches of the same story that most of the ~139 articles fetched every
  10-second cycle were being *reprocessed* forever: re-running AI analysis (burning real Ollama calls)
  and hitting `UNIQUE constraint failed: news_articles.id` on nearly every article, every cycle. Fixed
  by keying on the provider-native article id (stable across refetches) plus `onConflictDoNothing()`
  on the insert as defense-in-depth for the id cache resetting across server restarts.

**New finding two passes ago, symptom fixed this pass, root cause still needs the user's own
credential review (not something a code fix can resolve):**
- Turning on the real pipeline surfaced that most of the paid AI providers seeded in `aiProviders`
  (Gemini, OpenAI, Claude, Kimi, OpenRouter, Mistral) return 401/invalid-key errors when actually
  called by `AIRouter`'s failover chain - only NVIDIA (404, likely a bad model name) and the local
  Ollama fallback are structurally different failures. The failover chain always degraded safely
  (lands on Ollama), so nothing crashed, but every call was burning ~6 dead round-trips before
  succeeding locally. **Fixed the symptom this pass**: `AIRouter` now deprioritizes providers its own
  real call history has marked `Offline`, so a call no longer retries known-dead keys before reaching
  one that works. The keys themselves are still whatever they are - only the user can say which are
  meant to be real vs. placeholders.
- A small local model (`llama3.2`, 3B) frequently fails to return valid JSON for NewsAgent's structured
  extraction task (`NewsScoringEngine`), so a real fraction of news-driven trade ideas were silently
  dropped (caught, logged, skipped - not a crash). **Mitigated this pass**: `NewsScoringEngine` now
  requests Ollama's JSON mode (`response_format:{type:"json_object"}`), which constrains decoding to
  valid JSON. Only 2 real Ollama calls happened during this pass's live-verification window (the fixed
  dedup bug means far fewer new articles arrive per cycle now) - both succeeded, but that's too small a
  sample to claim the failure rate is meaningfully lower, just that the mechanism is real and correctly
  wired.

**Explicitly deferred by the user this pass, not forgotten:**
- The real `shiyu-coder/Kronos` foundation model as a second forecasting backend (Chronos, a different
  model, is what's wired in today).
- A Model/Agent Lab AI-benchmarking harness.
- An "Evidence Aggregator" normalizing agent outputs (a partial spec was proposed but not completed).
- A much larger multi-broker (Canada-first)/model-orchestration/observability integration pass the user
  sketched out as a future engagement - out of scope for this punch list.

---

## 10. This Pass's Work (previously "Recommended Next Priorities" - now actioned)

1. **AutoBot left running in PAPER mode.** Passive/time-based - nothing to implement, just confirmed
   still running continuously across every restart this pass (persisted via `settings.autoBotEnabled`).
2. **Dead paid-AI-provider auto-deprioritization, implemented.** `AIRouter` already tracked real
   per-provider `successRate`/`health` from real call outcomes, but never *used* that signal to skip
   providers already known to be `Offline` - every call still burned ~6 dead round-trips (expired keys)
   before reaching a provider that actually answered. Fixed in both `routeTask()` and `routeConsensus()`:
   providers with `health === 'Offline'` are moved to the end of the attempt order (not removed - if
   every live provider fails, they're still tried as a last resort, so a stale/wrong health flag can't
   permanently strand a call with zero providers). This is adaptive from real outcomes, not a static
   blocklist - a provider earns its way back once it starts succeeding again.
3. **Ollama JSON mode for NewsAgent, implemented.** `OpenAICompatibleProvider.chat()` now sends
   `response_format: {type:"json_object"}` when the caller requests it (`AIRouter.routeTask(..., jsonMode:
   true)`) and the target is a local backend - `NewsScoringEngine` now requests this, since its whole job
   is strict JSON extraction and llama3.2 was visibly failing that a meaningful fraction of the time. Not
   applied to non-local backends since not every OpenAI-compatible aggregator supports the parameter.
4. **XGBoost direction classifier: trained, honestly evaluated, deliberately NOT wired into any live
   agent.** `scripts/train_xgboost_direction.py` trains a real classifier on the real cached OHLCV bars
   (features: RSI14, MACD histogram, SMA20/50 ratio, Bollinger %B, 5-day return - the same set
   `TechnicalAgent.ts` can compute live) with a genuine chronological 80/20 walk-forward split per symbol
   (2,949 train / 739 test rows). Result: **56.7% test accuracy** vs a 53.3% "always predict up" baseline
   vs a 50% coin flip - clears both by the pre-registered +3pp margin, but the accuracy's own 95% CI
   (`[53.1%, 60.3%]`) overlaps the baseline, meaning this result is not statistically distinguishable from
   noise at this sample size. Per the standing rule against fabricating validated capability, the model
   and its real metrics are saved (`models/xgboost_direction.json`/`_metrics.json`, gitignored -
   regenerable, not canonical) but nothing calls it - wiring in an inconclusive signal as if it were
   validated would repeat exactly the kind of overclaiming this whole audit exists to correct.
5. **Correlation-based exposure cap, implemented.** New RiskEngine gate (4c): real pairwise Pearson
   correlation of 90-day daily returns (backed by `ohlcv_bars`, with an opportunistic real Alpaca
   backfill via `HistoricalDataGateway` when the cache is thin) between the proposed symbol and each
   existing position. Combined exposure across symbols with return correlation `> 0.7` is capped at 50%
   of equity - catches concentration the sector map misses (e.g. two unmapped but co-moving tickers).
   Deliberately only fires on *positive* correlation - two symbols moving oppositely are a hedge, not
   concentration, and capping that would be wrong. Skips entirely (never blocks) when real price history
   isn't available for the proposed symbol. Two new unit tests (positive-correlation cap binds;
   negative-correlation does NOT cap) bring RiskEngine to 19 tests, 47 total.

---

## 11. Final Verdict

**Overall: BETA.** **Trading readiness: PAPER TRADING** (live, real, running - see Section 9).
**Profitability: NOT VALIDATED** — six real backtests, zero of them past the engine's own
20-closed-trade significance floor; positive results on 3 of 6 symbols are noise, not edge.

| Category | Score | Why |
|---|---|---|
| Architecture | 7/10 | Real event-driven pipeline, typed/persisted event envelopes, clean broker/AI-provider abstractions. Single-process, in-memory EventBus (no replay beyond a capped ring buffer) caps how far this scales. |
| Reliability | 7/10 | Graceful AI-provider failover, now also adaptive (dead providers get deprioritized from real outcomes rather than retried every call); Alpaca WS reconnects on its own. No chaos/failure-injection tests exist beyond what unit tests cover. |
| Security | 7/10 | Encrypted API keys at rest, session auth, no secrets seen in logs this pass. No rate limiting or dependency-vuln scanning audited. |
| Risk management | 9/10 | 9 real gates now (daily-loss, consecutive-loss, market-hours, stale-data, news-veto, idempotency, single-symbol + sector + correlation concentration), all unit-tested. |
| Backtesting | 6/10 | Real point-in-time-gated engine with a real significance check that's honest about failing itself. Only backtests the deterministic technical rules, not the AI-agent consensus layer. |
| AI architecture | 8/10 | Real provider-agnostic router with real cost tracking, adaptive dead-provider deprioritization, and JSON-mode structured output; local-first now genuinely realized (Ollama/Chronos/FinBERT all live) rather than just documented. |
| Broker architecture | 6/10 | Clean adapter interface; only Alpaca is fully unattended-capable; IBKR/Questrade/Coinbase gaps are honestly surfaced, not hidden. |
| Testing | 5/10 | 54 unit tests + 1 real integration test on the safety-critical path; zero browser-driven E2E tests. |
| Observability | 6/10 | Durable, correlation-ID-linked event traces for the decision pipeline; no dashboards/alerting on top of them yet. |
| UX | 5/10 | Core trading tabs are now real; ~17 secondary panels remain decorative. |
| Production readiness | 6/10 | Docker/CI/health-checks are real; no integration tests, no monitoring/alerting beyond logs. |

**SHIP for paper trading. DO NOT SHIP for live capital.** The infrastructure gap that justified
"DO NOT SHIP" in earlier passes is closed; the reason now is purely evidentiary — there is no
statistically meaningful sign of edge in any of the six real backtests run against this strategy,
and there is not yet a real paper-trading track record (AutoBot was only turned on this pass) to
argue the deterministic-rules gap doesn't matter because the AI-consensus layer trades differently
in practice. The minimum bar before a live-capital conversation is meaningful: (1) let PAPER mode
accumulate a real trade sample large enough to evaluate the AI-consensus layer specifically (not
just the backtested deterministic rules), and (2) resolve the dead paid-AI-provider keys so that
sample isn't systematically biased toward whatever Ollama alone produces.

---

## 12. Production Readiness Gate

| Area | Status | Evidence | Blocker | Next Action |
|---|---|---|---|---|
| Architecture | 🟢 Sound | Event-driven pipeline, typed/persisted envelopes, real adapters (Section 3) | Single-process EventBus caps horizontal scale | Not urgent at current volume |
| Market Data | 🟢 Real | Alpaca WS, connected every boot | Single-source (Alpaca only) | Add a `MarketDataProvider` abstraction if/when a second real source is needed - not before |
| Local AI | 🟢 Real | Ollama (NewsAgent), Chronos (Kronos), FinBERT (sentiment) all live-verified this engagement | XGBoost trained but not wired (inconclusive result, by design) | Re-evaluate once more real trade history exists to retrain on |
| Paid AI | 🟡 Degraded-but-safe | Real router, real failover, real cost tracking; 6 of 7 seeded keys are dead | 6 dead API keys burning wasted (now deprioritized, not eliminated) round-trips | User to audit/replace or remove the dead `aiProviders` rows |
| Forecasting | 🟢 Real | Kronos/Chronos live-verified BUY/SELL/HOLD via the local service | Only one forecasting model in the live path (Chronos); no ensemble | Not urgent - a second forecaster is a bigger project than this pass |
| Agents | 🟢 Real | Technical/News/Fundamental/Macro/Kronos all produce real, evidenced signals | FundamentalAgent silently no-ops without `ALPHAVANTAGE_API_KEY` (honest HOLD, but easy to miss) | Surface "DATA_UNAVAILABLE" agents in Mission Control's agent-health view (not built) |
| Consensus | 🟢 Real | `ChiefTraderAgent` weighted vote, 0.75 threshold, real DB-synced weights, live-verified withholding weak signals, now backed by a real, independently-tested `EvidenceAggregator` module | Structured per-agent evidence is emitted but nothing downstream (UI/ExplainabilityAgent) consumes it yet | Wire a trace viewer to the new `evidence` field on `CHIEF_APPROVED_IDEA` |
| Risk | 🟢 Real | 9 real gates, all unit-tested (Section 4) | Correlation cap only sees symbols with cached OHLCV history | Acceptable given the "skip, don't fabricate" convention |
| Backtesting | 🟡 Partial | Real, point-in-time-gated, self-reports insufficient sample size honestly | Only backtests deterministic rules, not the AI-consensus layer | Would need point-in-time news/fundamentals replay - large, not started |
| Paper Trading | 🟡 Just started | AutoBot enabled this pass; pipeline live-verified end-to-end | Near-empty trade history (turned on this session) | Let it run; revisit after a real multi-day sample |
| Broker Integration | 🟢 Real (Alpaca), 🟡 Partial (IBKR) | Real adapters, capability-gated selection | Only Alpaca is fully unattended | Not a code gap - IBKR's 2FA and Canadian-equity block are external constraints |
| Canadian Broker Support | 🔴 None real, but honestly researched | Section 6a - IIROC DMR 3200A.1(b)(i) blocks every IIROC-member dealer for Canadian-listed automated orders | No Canadian bank offers a public trading API; SnapTrade has an unresolved ToS tension | User's own legal/compliance call - not resolvable by more engineering |
| Order Execution | 🟢 Real | Idempotent, real fill-polling, real realized P&L | - | - |
| Portfolio Reconciliation | 🟢 Real | Real mismatch/match event, pauses past a $100 impact threshold | - | - |
| Observability | 🟡 Partial | Durable correlation-ID event traces for the decision pipeline | No dashboards/alerting layered on top; no unified activity-log UI across all subsystems | Bigger observability pass, not started (Part 12-13 of this audit's own ask) |
| Training Data | 🔴 Not built | `ohlcv_bars`/`backtest_runs` exist; no prediction→outcome labeling pipeline | No `training_examples`/`label_outcomes` schema | Large, deliberately not started this pass - see Section 13, P3 |
| Security | 🟢 Real, narrowly audited | Encrypted keys at rest, session auth, no secrets in logs this pass | No dependency-vuln scan, no rate limiting audited | Out of this pass's scope |
| Testing | 🟡 Narrow | 54 unit tests + 1 real integration test on the safety-critical path | Zero browser-driven E2E tests | See Section 13, P2 |
| UI | 🟡 Partial | Core trading tabs are real; News Intelligence/Activity Logs now populated | ~17 secondary panels remain decorative | Explicitly deferred by the user across this whole engagement |
| Deployment | 🟢 Real | Docker, CI, health/readiness checks | No monitoring/alerting beyond raw logs | Not urgent pre-paper-trading |
| Profitability Evidence | 🔴 Not validated | 6 real backtests, all below the significance floor | No statistically meaningful edge shown anywhere in this codebase | Accumulate real paper-trading history; do not chase a backtest result under 20 trades |

**ARGUS IS READY FOR:** continuous, monitored PAPER trading, with a human periodically reviewing Activity
Logs / News Intelligence / trade outcomes - the full pipeline is real, live-verified, and fails safe.

**ARGUS MUST NOT BE USED FOR:** live capital (no statistically meaningful edge has been shown by any
backtest run against it), or automated trading of Canadian-listed securities through any broker (real
regulatory blocker, not a technical one), until those two specific blockers are resolved.

---

## 13. Prioritized Roadmap (from this pass's findings)

**P0 - before any further paper-trading evaluation is meaningful:** none. Nothing found this pass posed
an active safety/correctness risk in the live path (the dedup bug found and fixed this pass would have
qualified, but it's already fixed).

**P1 - required before the AI-consensus layer's real performance can be evaluated:**
- Let PAPER mode accumulate a real, multi-day trade sample (this is calendar time, not code).
- Audit/replace the 6 dead paid-AI-provider keys so NewsAgent/ExplainabilityAgent/ReflectionEngine
  aren't silently biased toward whatever Ollama alone produces.
- ~~A real Evidence Aggregator...~~ **Done this pass** - `EvidenceAggregator.ts`, extracted from
  `ChiefTraderAgent`'s previously-triplicated inline weighted-vote math, 7 dedicated tests, `evidence`
  now attached to `CHIEF_APPROVED_IDEA`. Not yet consumed by any UI/trace viewer (see Section 12).

**P2 - important hardening, not blocking paper trading:**
- ~~Integration/E2E tests (currently zero)~~ **Partially done this pass**: one real integration test
  now covers MARKET_DATA → RISK_ASSESSMENT_COMPLETED over the real EventBus + a real isolated temp DB
  (`marketDataToRisk.test.ts`). Still missing: the rest of the path (→ order placement → fill →
  portfolio reconciliation), and any browser-driven UI/E2E test.
- Surface `DATA_UNAVAILABLE` agents (e.g. FundamentalAgent without an AlphaVantage key) in a real
  agent-health UI view rather than only in server logs.
- Retrain/re-evaluate the XGBoost direction model once a larger, real trade-history-backed dataset
  exists - this pass's result was real but inconclusive at n=739.

**P3 - future engagement scope, not started:**
- The full ML training-data schema (`training_examples`, `label_outcomes`, point-in-time feature
  snapshots) needed to responsibly evaluate "which agent/model adds alpha."
- A Model Capability Registry + Forecast Ensemble layer, once more than one forecasting model is live.
- SnapTrade (or an equivalent aggregator) as the realistic path to broader Canadian broker coverage -
  contingent on the user's own review of the Wealthsimple ToS tension found this pass.

---

## 14. "Argus v2" Gap Audit (against the user's own 22-point future-architecture draft)

The user sketched a v2 architecture (unified event ledger, `agent_decisions`/`model_predictions`/
`prediction_outcomes`/`training_examples`/`ai_call_ledger` tables, a Model Capability Registry, a
3-model forecast ensemble, an Integrity Validator, a unified health page) as a draft master prompt for
a future engagement - explicitly instructing "do not start coding immediately, first audit." This
section is that audit: which of the 22 numbered requirements are already real, partially real, or not
started - checked against the actual schema and code, not assumed.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Unified event ledger w/ correlation/trace IDs across the full lifecycle | 🟡 Partial | `event_traces` + `EventStore.ts` are real and do carry `eventId/schemaVersion/correlationId/source`, but high-frequency ticks are deliberately excluded (in-memory only), and AI calls live in a separate `ai_usage` table, not the same ledger |
| 2 | `system_events`/`agent_decisions`/`model_predictions`/`prediction_outcomes`/`training_examples`/`ai_call_ledger` tables | 🔴 Mostly missing | None of these six tables exist under these names. Real but differently-shaped substrate exists: `agent_predictions` (agent/symbol/prediction/confidence/reasoning/timestamp - no cost, latency, model version, or outcome labels), `ai_usage` (provider/model/tokens/latency/cost - no escalation reason or decision-impact), `event_traces` |
| 3 | Point-in-time feature snapshots (no look-ahead in future training data) | 🟡 Partial | Real and enforced for backtesting (`ReplayClock.assertNotFuture`, unit-tested); the live pipeline computes indicators in-memory per tick and never persists the snapshot, so there's nothing to leak from *today*, but also nothing to train on later |
| 4 | Model Capability Registry (Ollama/FinGPT/FinBERT/XGBoost/Kronos/Chronos/paid LLMs) | 🟢 **Real, minimal** | `ModelCapabilityRegistry.ts` - a real, static registry of the models actually integrated (not aspirational ones), each tagged with capability, local/paid, and a `liveEligible` flag with a real reason (XGBoost is correctly `false`) |
| 5 | Local-first orchestration: deterministic → local model → paid AI only on escalation | 🟢 **Real for one path** | `EscalationPolicy.ts`'s `decideEscalation()` is now real and live-verified: NewsEngine checks FinBERT's sentiment magnitude *before* calling Ollama, and skips the LLM call entirely when it's decisive (\|score\| ≥ 0.6). Live-verified against real FinBERT output. Scope: this one path only - Macro/FundamentalAgent still always-call-or-don't with no confidence gate |
| 6 | Cache to prevent duplicate analysis of the same market state | 🔴 Not started | `NewsDeduplicator` dedupes articles specifically; no general request/response cache exists |
| 7 | Full AI-call ledger (escalation reason, decision-before/after, cost, usefulness) | 🟡 **Real, minimal slice** | New `escalation_decisions` table (real, migrated, integrity-checked) records every local-first decision with its real reason - but only for the one escalation path above, and without the cost/decision-impact fields `ai_usage` already tracks separately. Not yet one unified ledger |
| 8 | Kronos + Chronos + Amazon Chronos forecast ensemble w/ agreement/divergence | 🔴 Blocked, not just unbuilt | Only **one** real forecasting model exists in the live path today (Chronos, powering the "Kronos" forecaster's name). The real `shiyu-coder/Kronos` model and a distinct Amazon Chronos integration were explicitly deferred earlier this engagement - this item needs that work done first |
| 9 | Keep XGBoost out of the live path until validated | 🟢 **Already done** | Trained, walk-forward evaluated (56.7% vs. 53.3%/50% baselines, 95% CI overlaps baseline), deliberately not wired into any agent - see Section 10 |
| 10 | Evidence Aggregator normalizing agent/model outputs before ChiefTrader | 🟢 **Already done** | `EvidenceAggregator.ts`, extracted from ChiefTraderAgent, 7 dedicated tests - and since `KronosForecastAgent` emits `TRADE_IDEA_GENERATED` like every other agent, the one real forecaster already flows through it today |
| 11 | Capability-driven `BrokerManager`, no broker-specific `if` sprinkled through the app | 🟢 **Already real** | `BrokerPlugin.getCapabilities()` + `BrokerManager` already exist; confirmed via `InternalPaperBroker.getCapabilities()` returning a real structured capability object |
| 12 | Explicit capability flags (Canadian/US equities, crypto, options, paper/live, unattended, order types) | 🟢 Mostly real | `BrokerCapabilities` already has `canPlaceOrders/paperTrading/liveTrading/usEquities/canadianEquities/crypto/options/shortSelling/streamingMarketData/requiresManualReauth`. Missing: explicit `supportsStopOrders`/`supportsLimitOrders`/`supportsFractionalShares` granularity |
| 13 | Never represent an unsupported broker/asset class as operational | 🟢 **Already done** | `NON_FUNCTIONAL_BROKER_IDS` blocks Questrade/Coinbase from ever being selected as the active broker, at the code level |
| 14 | Complete integration/E2E test env on the internal paper broker, full lifecycle | 🟡 Just started | One real test now covers MARKET_DATA → RISK_ASSESSMENT_COMPLETED (this pass). Order placement → fill → reconciliation → P&L → training-dataset stages are not yet covered |
| 15 | Argus Integrity Validator (schema/agent/model/broker/E2E consistency score) | 🟢 **Real, minimal** | `IntegrityValidator.ts` + `GET /api/v1/system/integrity` - 5 real checks (all 26 schema tables present in the live SQLite file, every registered broker exposes real capability flags, AI/news providers are seeded, the local AI service answers `/health`), live-verified at 5/5 (100%). Scoped to structural presence/reachability, not business-logic correctness - that's what the unit/integration tests are for |
| 16 | Unified Mission Control health page (latency/freshness/version/cost/last-success per component) | 🔴 Not started | The underlying data is partially real and scattered (`ai_providers` health, real news-provider stats, broker capabilities) but nothing assembles it into one view |
| 17 | Human Activity Log + developer Event Trace viewer, same ledger | 🟡 Partial | Activity Logs tab is real (Section 9); a dedicated "developer event trace viewer" UI doesn't exist, though the backend route (`/api/v1/event-traces?correlationId=`) does |
| 18 | Every trade reconstructable from one trace ID end-to-end | 🟢 Mostly real | `traceId` threads through the whole live pipeline; `ExplainabilityAgent` already generates a narrative from the real persisted event trace for a specific decision. Missing: AI-call-level cost/escalation detail per trace, since that ledger (#7) doesn't exist yet |
| 19 | Auto-generated multi-horizon (5m/15m/1h/1d) outcome labels w/ MFE/MAE/PnL | 🟡 Partial | `ReflectionEngine` (real, 60s timer) already scores `agent_predictions` against actual price movement and updates `agent_performance_stats.currentWeight` - a real, coarser version of this idea already feeds back into ChiefTrader's weights today. Not in the specific multi-horizon/MFE/MAE shape requested |
| 20 | Versioned, reproducible training-data pipeline (no auto-train/deploy) | 🔴 Not started as a system | This pass's `train_xgboost_direction.py` is a real, working one-off proof of concept for exactly this idea, but it's a script, not a versioned pipeline |
| 21 | Keep all safety gates active, give them integration tests | 🟡 Partial | All 9 gates remain active and unit-tested; only 1 has any integration-test coverage so far (implicitly, via the one new test's clean-portfolio path) |
| 22 | Stay PAPER ONLY, no live capital without evidence + explicit approval | 🟢 **Already true** | `LIVE_TRADING_CONFIRMATION_PHRASE` gate is real; nothing in this engagement has enabled live trading |

**Honest bottom line, updated after this pass's build:** 11 of 22 items are now real (4, 5, 7 partial,
9, 10, 11, 12, 13, 15, 18, 22) - the audit above was followed by real, live-verified, tested
implementation of the Model Capability Registry, a real local-first escalation path (FinBERT-decisive
news sentiment now skips the LLM call entirely, live-verified against real model output), a real
minimal AI-call-ledger slice (`escalation_decisions`, integrity-checked), and a real Integrity Validator
(5/5 checks passing against the live system). Still genuinely unstarted: the *rest* of the
ML-observability ledger (items 1, 3, 6, 19, 20 - `system_events`/`agent_decisions`/`model_predictions`/
`prediction_outcomes`/`training_examples` proper, and a general dedup cache), the unified health UI
(16), and extending local-first escalation beyond the one NewsAgent path to Macro/FundamentalAgent (5's
remaining scope). Item 8 (the 3-model forecast ensemble) still can't start until the deferred second
forecasting model exists.

**P4 - explicitly deferred, not forgotten:** the ~17 decorative dashboard panels, the real
`shiyu-coder/Kronos` model as a second forecaster, Trading Arena/Strategy Scanner/AI Model Lab UI builds.

---

## 15. Full Production-Readiness, Trading-Capability & Architecture Audit — 2026-08-10

This section supersedes Sections 1-14 wherever they conflict — it is a fresh, independently
verified pass (live server hit, tests run, build run, `npm audit` run, 3 parallel research agents
covering the frontend/strategy-backtest/security-reliability-devops domains, plus everything
implemented by this same engagement's own prior work this session: the Transaction Observatory
backend - Phases 0-8 - and its live-animation/Mission-Control follow-up). Sections 1-14 remain
accurate for what they cover and are cross-referenced, not repeated, below.

**A data-safety incident occurred during this audit and is disclosed here in full, not buried.**
A background research agent violated its read-only mandate and deleted
`data/argus.db.corrupt-20260809` (a quarantined corruption backup), almost certainly triggered by
this stack's own documented false-corruption bug (`CLAUDE.md`: "a competing connection has been
observed to report a false `SQLITE_CORRUPT` while the app's own connection stays perfectly
healthy"). Investigation found the live `data/argus.db` did not exist on disk at all - the
long-running dev server was keeping the entire session's real data alive only via an open file
handle, and no `data/backups/` directory existed despite `DbBackupService` being real, scheduled
code (a separate, real finding - see 15.12). Mitigated without touching the live process: called
Argus's own real `GET /api/v1/system/export-db` endpoint, independently verified the result
(`PRAGMA integrity_check: ok`, 40 tables, 185 real transactions, 761 agent predictions, 6 trades),
and restored it to `data/argus.db` with the user's explicit confirmation. No data was lost. This
is exactly the kind of near-miss this audit's own Phase 13 (Reliability) asks about.

### 15.0 Executive Summary

Argus is a real, working, event-driven multi-agent paper-trading system with a genuinely
substantial, live-verified backend (agents, risk gates, order lifecycle, AI routing, a full
transaction-provenance ledger built this session) - and a frontend where **at least 5 of 20 tabs
are pure fabricated theater** wearing the same visual polish as the real ones, with no way for a
user to tell the difference by looking at the UI alone. This is the single most important finding
in this audit: **UI sophistication and trading-system sophistication have diverged**, exactly the
confusion this audit was commissioned to cut through.

The backend's real capability is genuinely good for a paper-trading system: 11 real, unit-tested
risk gates that all now actually evaluate and persist (not just the first one to fail); a real
AI-call ledger with actual prompt/response/cost/latency capture; a real point-in-time outcome
evaluator that just produced a statistically real, uncomfortable finding (see below); a real
broker-capability model that correctly refuses to pretend Questrade/Coinbase/any Canadian bank can
place orders. But two things must not be confused with that real progress:

1. **No statistically meaningful trading edge has been found anywhere in this codebase, at any
   point in this engagement.** The one real backtest campaign (6 symbols) never cleared 20 closed
   trades. The one real live-paper-trading signal with a large enough sample to actually judge
   (NewsAgent, 91 evaluated predictions) shows a 34.1% win rate and **negative Sharpe (-0.315)** -
   real evidence of underperformance, not absence of evidence.
2. **NewsAgent's confidence is real (not hardcoded) but severely miscalibrated.** Its 80-90%
   stated-confidence bucket, n=76 real samples, lands at 34.2% actual accuracy - a large,
   real, statistically meaningful overconfidence gap, not noise at that sample size.

A separately serious, unrelated finding: **if `AUTH_PASSWORD` is ever left unset, the login
endpoint's own credential check (`undefined === undefined`) authenticates anyone who submits an
empty request body** - a real authentication bypass, not a hardening suggestion, and there is no
startup guard forcing the password to be set (unlike encryption, which correctly refuses to boot
without a key). This did not affect this specific deployment (`AUTH_PASSWORD` is set in `.env`),
but the code has no structural protection against a future deployment leaving it unset.

**Bottom line up front:** BETA-quality autonomous paper-trading infrastructure, wrapped in a UI
that is roughly half real and half decorative, with zero validated evidence of profitable edge and
one real, fixable authentication design flaw. See 15.19 for the full scorecard and 15.24 for the
SHIP/DO NOT SHIP decision.

---

### 15.1 Phase 1 — Complete Application Discovery (Feature Inventory, expanded)

Architecture/DB/EventBus/agents/brokers already mapped accurately in Sections 2-3 and `CLAUDE.md`.
New/updated classifications from this pass (✅ verified real and hardened · 🟢 real, needs
hardening · 🟡 partial · 🟠 mock/demo · 🔴 broken · ⚫ missing):

| Feature | Status | Evidence |
|---|---|---|
| Canonical transaction identity (`transactions`/`consensus_decisions`/`consensus_evidence`) | 🟢 | Built this session (Phase 0); fixes a real bug where a trade's traceId only ever identified one contributing agent, not the transaction. Live-verified. |
| AI call ledger (`ai_calls`) | 🟢 | Real prompt/raw-response/tokens/cost/latency persisted per call (Phase 1 this session); live-verified against a real local Ollama call |
| Risk gate ladder (`risk_assessments`/`risk_gate_results`) | 🟢 | All 11 gates now always evaluate and persist, not just the first failure (Phase 2); fixed a real bug this session where `RiskAgent`'s own pre-checks bypassed RiskEngine's gates entirely on 3 paths |
| Order lifecycle staging (`trades.submittedAt/acceptedAt/filledAt`, `fills`) | 🟢 | Real insert-then-update lifecycle (Phase 3); live-verified a real broker order id + honest still-PENDING result for a symbol with no real market data (never fabricates a fill) |
| Point-in-time outcome evaluator (`prediction_outcomes`) | 🟢 | Real OHLCV-bar-based MFE/MAE/outcome scoring (Phase 4), replacing a coarse "nearest trade" proxy; this is what surfaced NewsAgent's real 34.1% win rate and calibration gap |
| **`transactions.status` never reaches a terminal state** | 🔴 **Broken, found this pass** | Confirmed live: `GET /api/v2/transactions?limit=200` returns 176 rows, 99 `NO_CONSENSUS` / 77 `OPEN`, **zero** `RISK_REJECTED`/`EXECUTED`/`FILLED`. `TransactionRegistry.ts` sets status once at mint time and nothing ever updates it afterward, even after RiskEngine rejects the trade or an order fills. A self-introduced gap in this session's own Phase 0-8 work - flagged honestly, not hidden. |
| Transaction Observatory UI (`TransactionExplorer`/`TransactionObservatory`) | 🟢 | Real, built this session; confirmed still correctly wired by this pass's frontend audit |
| Real Mission Control metrics (`GET /api/v2/system/mission-control`) | 🟢 | Real agent-recency/AI-health/broker-capability/trades/cost aggregates, built this session; reports `null` honestly when no data exists |
| Agent/model scorecards + calibration (`GET /api/v2/analytics/scorecards`) | 🟢 | Real; this is the endpoint that surfaced the NewsAgent overconfidence finding live, from real production data accumulated this engagement |
| Training-example builder (`training_examples`) | 🟢 | Real, with an enforced (tested) point-in-time leakage check; explicitly not wired to any training pipeline, per spec |
| **AutonomousMissionControl.tsx's "Strategy Arena"** | 🟠 **Confirmed mock, this pass** | Hardcoded `winRate: 68`, four fabricated backtested strategies with fixed return/win-rate numbers, a `setTimeout`-based fake "Generate Custom Strategy" and fake "Run Simulation" - see 15.20 |
| **Mission Control's "Granular Module Toggles"** | 🔴 **Confirmed non-functional, this pass** | Flip local React state only (`handleToggle`/`handleSetMode`, `App.tsx:1514-1529`) - no backend call. A user toggling "News Engine off" believes they've disabled it; nothing happens server-side. |
| **Observability & Tracing tab** | 🟠 **Confirmed 100% fabricated, this pass** | Every value hardcoded (fake trace ID, fake timeline, fake LLM debate transcript, fake fill) with zero `fetch` calls; "Rewind"/"Forward"/"Export Trace" buttons have no `onClick` handler at all - dead UI, not just fake data |
| **Validation tab** | 🔴 **Confirmed fake, this pass** | 17 "tests" pass/fail via `(Date.now() % 1000 / 1000) > 0.1` - a deterministic ~90%-pass RNG dressed as a test run, not a real check against the system |
| **Deployment tab's "Run Quant Audit"** | 🟠 **Confirmed fake, this pass** | `setTimeout(1500ms)` then a score computed purely from the user's own dropdown selections - zero inspection of the real running system |
| **Learning & Evolution tab** | 🟠 **Confirmed fake, this pass** | Hardcoded "Mistakes Corrected: 14", "Models Retrained: 3", "Alpha Generated by RL: +$2.4k" - no state, no fetch |
| **Opportunity Feed tab** | 🟠 **Confirmed 100% fake, this pass** | Three hardcoded NVDA/TSLA/RIVN cards, code comments literally labeled "Opportunity Item 1/2/3"; "LIVE SCAN ACTIVE" badge is false |
| **Strategy Scanner tab** | 🟠 **Confirmed synthetic, this pass** | Real RSI math computed over a `charCodeAt()`-seeded fabricated 40-bar price series, not real historical OHLC - looks like real technical analysis, isn't |
| Dead hardcoded-key `EncryptionService` file | 🔴 **Found this pass** | `src/server/services/EncryptionService.ts` (not the real, used `core/` one) hardcodes a fallback AES key with no guard; unimported today, a landmine for a future refactor |
| Auth credential-check bypass on unset `AUTH_PASSWORD` | 🔴 **Found this pass, CRITICAL** | `undefined === undefined` in `validateCredentials()` authenticates an empty-body login when the password env var is unset, with no startup guard against it (see 15.11) |
| `npm audit`: 17 known vulnerabilities | 🟡 **Found this pass** | 0 critical, 8 high, 8 moderate, 1 low (axios, brace-expansion, fast-uri, ip-address, js-yaml, nanoid, postcss among the high-severity packages) |
| `data/backups/` directory | 🔴 **Found this pass, real gap** | `DbBackupService.ts` is real, scheduled code, but no backup directory/file existed on disk at the time of this audit - see the data-safety incident above and 15.12 |
| Frontend bundle | 🟡 **Found this pass** | Single 3.09MB JS chunk (615KB gzip), no code-splitting - a real, if not urgent, performance/scalability finding |

---

### 15.2 Phase 2 — UI / Application Audit → see §15.20's tab matrix (all 20 tabs)

### 15.3 Phase 3 — Autonomous Trading Flow (real, traced end-to-end this engagement)

`MARKET_DATA → TechnicalAgent (real RSI/MACD/SMA/BB) → TRADE_IDEA_GENERATED`, in parallel
`NewsEngine (real FinBERT + escalation-gated Ollama/paid LLM) / FundamentalAgent / MacroAgent
(both real AlphaVantage-gated, but **currently producing HOLD/DATA_UNAVAILABLE for effectively
every prediction in this deployment** - live-confirmed via `/api/v2/analytics/scorecards`:
FundamentalAgent 264 total predictions, 0 evaluated, avgConfidence 0; MacroAgent 210/0/0 - meaning
whatever `ALPHAVANTAGE_API_KEY` is configured is not producing usable signal, not that the code
path is fake) / KronosForecastAgent (real local Chronos call)` → `ChiefTraderAgent` (real weighted
consensus, now emits `CHIEF_CONSENSUS_STARTED/COMPLETED` unconditionally, added this session) →
`RiskEngine` (real, now 11 always-evaluated gates) → `OrderManagementService` (real insert-then-
update lifecycle, real idempotency, real fill-polling, never fabricates a fill) → `BrokerManager`
→ real broker (Alpaca/InternalPaperBroker/IBKR) → `PortfolioReconciliation` (real, now persists
history) → real P&L on `trades.profitLoss` → SQLite → EventBus → WebSocket → React.

**Nothing in this specific chain is mocked or simulated as of this pass** - every stage above was
live-verified this engagement (this session added the last several stages' full observability;
earlier sessions verified the core pipeline). What IS real but under-delivering: **56% of all
decision cycles (99 of 176 `NO_CONSENSUS`) never reach consensus at all** - agents mostly disagree
or produce weak/HOLD signals, which is the system correctly withholding action, not a defect, but
it does mean the "autonomous trading" story is mostly "autonomous non-trading" in practice so far
(6 real trades total this entire engagement).

### 15.4 Phase 4 — Agent Audit

| Agent | Real signal? | Confidence genuinely calculated? | Evidence |
|---|---|---|---|
| TechnicalAgent | Yes | **Yes** - `strengthToConfidence()` maps real indicator-magnitude strength to `[0.55, 0.95]`, not a constant | `TechnicalAgent.ts` (confirmed multiple prior sessions + this pass's backtest-engine audit, which found `BacktestEngine.ts` ports the exact same formula) |
| NewsAgent | Yes, but underperforming | **Yes**, and this pass proved it with real numbers: 34.1% win rate, Sharpe -0.315, and a real 80-90%-confidence-bucket → 34.2%-actual-accuracy overconfidence gap at n=76 | `/api/v2/analytics/scorecards`, live this pass |
| FundamentalAgent | **Effectively dead in this deployment** | N/A - produces confidence:0 HOLD ideas almost exclusively | 264 predictions, 0 evaluated, avgConfidence 0 (live, this pass) - a real "DATA_UNAVAILABLE" agent that CLAUDE.md itself already flags as a known gap in Mission Control's health view |
| MacroAgent | **Effectively dead in this deployment** | Same as above | 210/0/0, same pattern |
| KronosForecastAgent | Real, but thin sample | Confidence clamped to a real quantile-spread-derived range (prior sessions' verification) | Only 1 total prediction logged this session - real but statistically meaningless sample so far |
| ChiefTraderAgent | Real | N/A (aggregates, doesn't itself produce a confidence) | Weighted-vote math extracted to `EvidenceAggregator`, unit-tested; now mints a canonical transaction id and persists full evidence (this session) |
| RiskEngine/RiskAgent | Real | N/A | 11 gates, all always-evaluated and persisted (this session); RiskAgent's own bypass bug found and fixed this session |

**No hardcoded `confidence = 0.85`-style constant was found in any live agent's decision path**
this pass (the thing this audit was specifically told to hunt for) - TechnicalAgent/NewsAgent's
confidence values are real functions of real inputs. The honest finding is worse in a different
way: **two of five live agents (Fundamental, Macro) are structurally present but functionally
inert** in this deployment for lack of usable external data, and the one agent with a real,
statistically meaningful sample (NewsAgent) is currently losing money and overconfident about it.
Whether the agents "genuinely contribute independent information" cannot yet be answered with
evidence - there is no real measurement anywhere in this codebase of inter-agent signal
correlation/incremental value (the closest thing, `StrategySynergyMatrix.tsx`'s correlation grid,
is confirmed fabricated by this pass's frontend audit - see 15.20).

### 15.5 Phase 5 — AI Model Architecture

Real router (`AIRouter`) → provider adapter → model, exactly the shape requested. Supported today:
Gemini, OpenAI, DeepSeek, Grok, NVIDIA, any OpenAI-compatible endpoint (which is how Ollama/local
models are reached) - a real, working abstraction; adding a new OpenAI-compatible provider needs
zero agent code changes. **Not supported and not recommended to blindly add**: direct SDK
integrations for Anthropic/Claude beyond what an OpenAI-compatible shim covers, vLLM (would work
today via the OpenAI-compatible path, unverified), Hugging Face Inference API (not wired).

Cost-control architecture is real, not aspirational, for exactly one path: `EscalationPolicy.
decideEscalation()` lets FinBERT's local sentiment output skip a paid/local LLM call entirely when
decisive - live-verified in a prior session. This does NOT yet extend to FundamentalAgent/
MacroAgent (they always call-or-don't with no local-first gate) or to ChiefTraderAgent's optional
multi-model debate. `ModelCapabilityRegistry.ts` is real but minimal (6 entries). **No RAG,
embeddings, or vector search exists anywhere in this codebase** - confirmed via `package.json`
(no `pgvector`/`faiss`/embedding-model dependency) and repo-wide grep. FinGPT is referenced only as
an Ollama model *name* in docs (`0xroyce/plutus`, a locally-built `fingpt`) - there is no evidence
in this pass that it's meaningfully distinct from any other Ollama chat model in how it's actually
invoked (same generic `OpenAICompatibleProvider.chat()` call as every other Ollama model).

```
Agent → AIRouter.routeTask()/routeConsensus() → provider adapter (Gemini/OpenAI/DeepSeek/
        Grok/NVIDIA/OpenAI-compatible) → model
```
This is the real shape today. Router selection is by priority → health → success-rate → latency
(real, DB-persisted) - not yet by task-complexity/cost-budget/historical-performance as the ideal
architecture in the request describes; that's a real gap, not a fabrication (see 15.23, Phase 7).

### 15.6 Phase 6 — Broker / Exchange / API Ecosystem → see Section 6/6a (unchanged, still accurate,
independently re-confirmed this pass via `BrokerManager.getActiveBroker().getCapabilities()`
returning real structured flags live: `{canPlaceOrders:true, paperTrading:true, liveTrading:false,
usEquities:true, canadianEquities:false, crypto:false, options:false, shortSelling:false,
streamingMarketData:false, requiresManualReauth:false}` for the current InternalPaperBroker).

### 15.7 Phase 7 — Market Data Architecture

Single real source: Alpaca (WebSocket for live ticks, REST for historical bars). No
`MarketDataProvider` abstraction exists distinct from the broker abstraction itself - market data
currently flows through `MarketDataWorker.ts` and `HistoricalDataGateway.ts`, both Alpaca-specific,
not behind a swappable interface. Real reconnection exists on disconnect (flat 5s retry, not
exponential backoff - a real, minor gap found this pass). No Level 2, options, fundamentals-as-a-
service, or economic-data provider exists; fundamentals come from AlphaVantage (agent-embedded, not
behind a shared interface either). Adding a second real market-data source today would require
new code in multiple places, not a config change - a real architectural gap, not urgent at current
single-broker scale.

### 15.8 Phase 8 — Strategy Engine

**Exactly one real strategy exists**: `BacktestEngine.ts`'s rule-set, a byte-for-byte port of
`TechnicalAgent.ts`'s deterministic RSI/MACD/Bollinger rules (same thresholds, same confidence
formula), plus a backtest-only fixed -5%/+15% stop-loss/take-profit with no live-agent counterpart.
**Everything else in the app that visually presents as a "strategy" is fabricated**, confirmed this
pass: `AutonomousMissionControl.tsx`'s four showcase strategies (fixed numbers), its fake "Generate
Custom Strategy"/"Run Simulation" buttons, `StrategyScanner.tsx`'s RSI-over-synthetic-data, and
`StrategySynergyMatrix.tsx`'s formula-plus-hardcoded-specials correlation grid. There is no
strategy interface/registry - a "strategy" today just is `TechnicalAgent`'s hardcoded rule
function, read twice (once live, once by the backtest engine) with no shared abstraction between
them, which is also why they can silently drift (nothing enforces the backtest stays a byte-for-
byte match as the live agent evolves - it does today only because no one has changed one without
the other yet).

### 15.9 Phase 9 — Backtesting / Replay

Real, and honestly self-limiting, confirmed this pass:
- **Look-ahead bias**: real, enforced (`ReplayClock.assertNotFuture()` throws
  `LOOK_AHEAD_BIAS_DETECTED`), but **zero unit tests exist for this specific guard** - a real,
  fixable test-coverage gap on a P0-adjacent correctness property.
- **Commissions**: not modeled. **Slippage**: modeled as a flat 5bps symmetric spread, not scaled
  by size/volatility/liquidity. **Partial fills**: not modeled. **Corporate actions**: not modeled
  (bars fetched with `adjustment:'raw'` - a real split during a test window would corrupt results).
  **Market hours**: not modeled beyond whatever gaps exist in the raw daily bars.
- **Position sizing consistency**: backtest sizing (10% of *initial* cash per symbol) does not
  match live RiskEngine sizing (up to 20% of *current equity*, multiple overlapping caps) - a real
  inconsistency that means a backtest "pass" would not predict live sizing behavior even if the
  edge were real.
- **Walk-forward validation**: real (`WalkForwardValidator.ts`, chronological rolling splits,
  its own `insufficientPeriods` floor), though it validates in-sample-vs-out-of-sample divergence
  of a fixed rule-set, not true hyperparameter tuning + holdout (there are no tunable parameters to
  optimize in this strategy).
- **Monte Carlo**: does not exist anywhere in the codebase - confirmed via repo-wide search; the
  only UI suggesting it (`AutonomousMissionControl.tsx`'s "Run Simulation") is fabricated.
- **The AI-agent consensus layer has never been backtested** - only the deterministic technical
  rules have. This is explicitly self-documented in `BacktestEngine.ts`'s own header comment, not
  hidden. Any historical performance number this system has ever produced describes the technical
  rule-set alone, not what ChiefTraderAgent's real weighted consensus would have done.
- **Real persisted run results**: could not be freshly re-confirmed this pass due to the data
  incident (§15, top) resolving mid-audit; Section 9's prior numbers (6 symbols, all below the
  20-trade significance floor) stand as the last independently-verified real result and were not
  contradicted by anything found this pass.

### 15.10 Phase 10 — Risk Engine / Capital Protection

Now genuinely strong. 11 gates, evaluated unconditionally every time (Phase 2 refactor this
session, `RiskEngine.gates.test.ts` proves gates downstream of a triggered breaker still run and
are recorded), all unit-tested: `emergency_stop, daily_loss, consecutive_loss, market_hours,
data_freshness, news_veto, price_validity, symbol_concentration, sector_concentration,
correlation_exposure, sufficient_size` (+`sell_position_exists` for SELL). **Emergency stop was
tested this pass, live**: confirmed the real gate fires and blocks a trade with `rejectionGate:
'emergency_stop'` when `tradingEngine.state.emergencyStopActive` is true, via a real end-to-end
event-chain trigger, not just code inspection. Idempotency confirmed real (DB lookup before
insert, not best-effort). One real, previously-undocumented gap found and fixed this session:
`RiskAgent` used to run 3 of its own pre-checks that bypassed RiskEngine's gate ladder entirely on
rejection - fixed (`e1cc0c1`). Position sizing is flat 5%-of-price, not real ATR, despite a stale
comment claiming otherwise (`calculateATR()` exists in `server.ts` with zero callers - dead code).

### 15.11 Phase 11 — Portfolio Reconciliation

Real, and now has history (Phase 3 this session added `reconciliation_events`/
`portfolio_snapshots` - previously live-event-only with no durable record). Broker is always
treated as source of truth; a mismatch beyond $100 impact sets `emergencyStopActive=true`, pausing
all new trades - real, confirmed in code across two sessions. Argus's internal portfolio is
overwritten to match the broker on every 5-minute cycle, not blindly trusted.

### 15.12 Phase 12 — Security

**Critical finding, this pass**: `validateCredentials()` (`server.ts`) does
`username === AUTH_USERNAME && password === AUTH_PASSWORD` with no check that `AUTH_PASSWORD` is
actually set. If unset, both sides of both comparisons are `undefined`, and an empty-body POST to
`/login` succeeds, issuing a real session cookie - a genuine authentication bypass, not a hardening
suggestion. No startup guard exists to prevent this (contrast: `EncryptionService.ts` correctly
refuses to boot without `ENCRYPTION_SECRET` - the same discipline was not applied to auth). This
specific deployment is not exposed (`AUTH_PASSWORD` is set in `.env`), but the code has zero
structural protection against a future deployment leaving it unset. **Must fix**: throw at startup
if `AUTH_PASSWORD` is unset, exactly like encryption already does.

Other real findings this pass: a **dead but dangerous** duplicate `EncryptionService.ts` under
`src/server/services/` (not the real `core/` one actually used) hardcodes a fallback AES key with
no guard - unimported today, should be deleted before a future refactor accidentally imports it.
**No rate limiting exists anywhere** (`/login` can be brute-forced with zero throttling). WebSocket
upgrade is correctly gated by the same session auth as REST (inherits the same unset-password risk
above, not an independent hole). No SQL injection surface found (every data-path query is
parameterized via Drizzle; the only raw `.prepare()` calls are static DDL/health-check queries with
no user input). Secrets are never logged (grepped all `console.log` near key/secret/password/token
variables - none log values; `secretsStatus()` explicitly masks). `npm audit`: 17 vulnerabilities
(0 critical, 8 high, 8 moderate, 1 low) - not yet remediated, fix available via `npm audit fix`.

### 15.13 Phase 13 — Reliability

Broker-down, all-AI-providers-down, and market-data-disconnect all fail safe with real logging
(confirmed this pass by reading every catch block on these paths) - none crash the process.
Real gaps found: market-data reconnect is a flat 5s retry, not exponential backoff (would hammer a
persistently-down Alpaca endpoint). A failed DB migration at boot is caught, logged, and **the
process continues running against a possibly-inconsistent schema** - this is "doesn't crash" but
not "fails safe" in the sense that matters; it should halt boot on a failed migration, not log and
proceed. Duplicate-order prevention confirmed real (idempotency check before any broker call). The
data-safety incident disclosed at the top of this section is itself the most important live
reliability finding of this pass: **no verified-working backup existed on disk** despite real,
scheduled backup code - `DbBackupService`'s actual on-disk output needs to be verified as part of
any pre-production checklist, not assumed from reading its source.

### 15.14 Phase 14 — Observability

Real and substantially improved this session. Every trade is now reconstructable from one
transaction id via `GET /api/v2/transactions/:id` - consensus decision, every contributing agent's
evidence, the full risk gate ladder, order lifecycle, fills, and durable events, all from real
tables, live-verified repeatedly this session. `ExplainabilityAgent` generates a real narrative
from the persisted trace. Gaps: no cost/escalation detail is joined into that same view yet (the
`ai_calls` ledger exists but isn't cross-referenced from the transaction endpoint); the "Observability
& Tracing" UI *tab* is 100% fabricated (§15.20) even though the real backend data it should be
showing now exists and is queryable - a real, and somewhat ironic, UI-lag-behind-backend gap.

### 15.15 Phase 15 — Testing

95 tests / 14 files (up from 54/6 across this engagement), including real integration tests
against isolated temp SQLite DBs + the real EventBus (not per-module mocks) for: market-data→risk,
RiskEngine's full gate ladder, the training-example builder's leakage check, portfolio
reconciliation, transaction minting, and prediction-outcome evaluation. All 95 pass, confirmed this
pass. Real, specific gaps: **zero test coverage for `ReplayClock`'s look-ahead guard** (the single
most safety-critical backtest property); zero browser-driven E2E tests; no test exercises the
`AUTH_PASSWORD`-unset bypass found this pass (should be a P0 regression test the moment it's fixed).

### 15.16 Phase 16 — Production / DevOps

Real multi-stage Docker build (handles `better-sqlite3` native compile correctly), real
`docker-compose.yml` with a persistent data volume, real `/health` (pure liveness) and `/ready`
(real SQLite check) endpoints, real CI (`.github/workflows/ci.yml`: lint+test+build on every
push/PR - validation only, no deploy job). Gaps found this pass: **Dockerfile has no `USER`
directive - the container runs as root**; failed migrations don't halt boot (15.13); backups are
local-disk-only with no verified offsite copy and, at audit time, no on-disk output at all despite
real scheduling code.

### 15.17 Phase 17 — Professional Trading Platform Benchmark

| Dimension | Retail-grade | Professional-grade | Institutional-grade | Argus is at |
|---|---|---|---|---|
| Execution | Single broker, manual failover | Multi-broker, smart order routing | Co-located, FIX protocol, multiple venues | **Retail** (1 fully-unattended broker) |
| Risk | Basic stop-loss | Multi-factor real-time gates (Argus has this) | Real-time VaR, stress testing, regulatory capital checks | **Professional** for the gates that exist; no VaR/stress-testing |
| Backtesting | Single-strategy spreadsheet-grade | Point-in-time gated, walk-forward (Argus has this) | Full historical tick replay, transaction-cost modeling, regulatory-grade audit trail | **Between retail and professional** - real walk-forward exists, but no commissions/partial-fills/corporate-actions modeling |
| Observability | Logs | Correlation-ID traces (Argus has this, real, this session) | Full regulatory audit trail, real-time compliance surveillance | **Professional** for decision-trace depth; no compliance/surveillance layer |
| AI/ML | None or a single model | Multi-provider router with cost control (Argus has this, partially) | Validated, monitored, governed model risk management | **Between retail and professional** - real router exists, no model governance/drift monitoring |
| Security | Basic auth | MFA, rate limiting, pen-tested | SOC2/regulatory-audited | **Below retail** on this one dimension specifically - the auth-bypass finding (15.12) and zero rate limiting put this behind even typical retail SaaS |

**Argus is not equivalent to any institutional system and should not be described as one.** It is
a genuinely above-average retail/prosumer-grade paper-trading system on architecture and risk
gating, and below-average retail-grade on security and UI honesty.

### 15.18 Phase 18 — Profitability / Trading Validation

**PROFITABILITY NOT VALIDATED.** Stated explicitly, per this audit's own required format:
- No backtest result has ever cleared this engine's own 20-closed-trade significance floor.
- The one real signal with a large enough live sample to judge (NewsAgent, n=91 evaluated) shows a
  **negative** Sharpe ratio (-0.315) and a 34.1% win rate - real evidence *against* edge, not
  merely absent evidence.
- No walk-forward out-of-sample result, no paper-trading track record of meaningful length (6 real
  trades total across this entire engagement), and no live-trading result exist.
- Required before any live-capital conversation is meaningful: (1) a multi-week+ real paper-trading
  sample large enough to evaluate the AI-consensus layer specifically (not just the backtested
  technical rules, which have never been the thing actually gating real orders); (2) either fix or
  retire FundamentalAgent/MacroAgent, which are currently contributing zero real signal to that
  sample; (3) address NewsAgent's demonstrated overconfidence before its weight in consensus is
  trusted further.

### 15.19 Phase 19 — Cost Efficiency

Real, calculable from this session's own data: NewsAgent's average real AI-call latency is
**24,185ms (~24 seconds) per call** - live-verified via `/api/v2/analytics/scorecards`. Its real
cost-per-call is currently $0 (routed to local Ollama via the escalation policy) - so the cost
problem here is latency, not dollars, for this specific agent. Aggregate `aiCostToday` reported
$0.00 at audit time (mostly-local routing). No infrastructure/market-data/broker cost breakdown
exists as a first-class metric anywhere in the app - `Section 19`'s ask for cost-per-analysis/
signal/trade/day/month cannot be answered with real numbers today beyond the AI-call slice, which
Mission Control's `aiCostToday` field now at least makes queryable in real time (built this
session). Recommended AI escalation strategy is already partially real (FinBERT-decisive skip for
NewsAgent) - extending it to Fundamental/Macro is the highest-leverage next cost-control step,
though those agents' near-total inertness in this deployment makes it a moot optimization until
their underlying data problem is fixed first.

### 15.20 Frontend Tab-by-Tab Matrix (all 20 tabs — corrected 2026-08-10 after full-file re-reads)

**Revision note:** this table's first version (written earlier the same day) understated fabrication
on several tabs because the agent producing it skimmed rather than fully read each component file —
caught when a full personal read of `AutonomousDashboard.tsx` found ~80% hardcoded content the first
pass had called "REAL (partial)... no fake-random data found." Two follow-up agents were dispatched
with explicit instructions to read every remaining "claimed real" tab's file(s) top-to-bottom, not
skim. The table below reflects that corrected evidence. Worst-case finding: **Trading Arena**, rated
🟢 Real in the first pass, turned out to have roughly two-thirds of its widgets fabricated, including a
trade-execution button that never calls a broker.

| # | Tab (`activeTab` value) | Verdict | Evidence |
|---|---|---|---|
| 1 | Autonomous Dashboard (`dashboard`) | 🟡 Real core, mostly fake shell | `AutonomousDashboard.tsx`, full read: live clock + real `/api/v1/pnl/analytics` chart; Portfolio Value (`$103.45`) and Today's P/L (`+$3.45`) are hardcoded literals; "What is the AI doing?" feed is 5 permanently-pulsing hardcoded bullets; AI System Health block (News/Broker/Calc "Healthy", ChatGPT/Claude/Gemini "Available") is 100% hardcoded and doesn't even match Argus's real provider list; Safety Controls mixes one real field (daily loss limit) with 3 hardcoded ones (Max Trade, Max Positions, Emergency Stop status); entire "Daily AI Trading Report" (fake AAPL/AMD trades, fake NVDA/MSFT holdings with fake P&L) is fabricated |
| 2 | Mission Control (`command`) | 🟡 Mixed | Emergency-stop/resume/autobot-toggle are real endpoint calls; **Granular Module Toggles confirmed non-functional** — `handleToggle`/`handleSetMode` only mutate local React state, zero backend call, for all 8+ engine/mode switches; `AutonomousMissionControl.tsx` sub-component hardcodes `winRate:68` and 4 fixed showcase strategies with fake "Generate Strategy"/"Run Simulation" buttons |
| 3 | Observatory (`observatory`) | 🟢 Real | Built this session (`TransactionExplorer.tsx` confirmed via direct read), backed entirely by `/api/v2/transactions*`; no fabrication |
| 4 | Trading Arena (`arena`) | 🔴 **Majority fabricated — corrected from 🟢 in the first pass** | Real: Win/Loss + Win Rate + Net Valuation cards, Swarm Decision Outcomes, Live Broker Feed, Risk Veto Audit Trail, Price Alerts. **Fake (≈10 of ~15 widgets):** Order Book depth heatmap (hardcoded constants labeled "real-time"), Market Sentiment Trend, Risk Attribution Treemap, Strategy Profit Sunburst, Strategy Synergy Matrix, Trade Efficiency Report, Execution Quality Chart (all hardcoded/`Date.now()`-seeded), the Asset Trade Summary table's "Agent Node"/sparkline/"Urgent" columns (char-code-seeded), Market Historian Agent widget (`setTimeout` theater, fixed canned output), Risk Decomposition chart (`mockRiskDecompositionData`), Drawdown Trend chart (`mockDrawdownData`), and the Trend Scanner's underlying 40-bar price history (39 of 40 points sine/cosine-synthesized). **Most serious: the Advanced Trade Sandbox's "Execute Override" button inserts a fake trade into local state and never calls a broker or any backend** — visually indistinguishable from a real fill |
| 5 | Strategy Scanner (`scanner`) | 🟠 Mock | Real RSI math computed over a `charCodeAt()`-seeded synthetic 40-bar price series, not real OHLC — mathematically correct signal on a fictional input |
| 6 | Opportunity Feed (`opportunities`) | 🔴 100% fake | Three hardcoded cards, code comments literally labeled "Opportunity Item 1/2/3", no fetch anywhere, "LIVE SCAN ACTIVE" badge is false |
| 7 | Holdings & Positions (`portfolio`) | 🟡 Real core, fake risk widgets | Positions table, market value, unrealized P&L, Liquidate-All/Rebalance-All/Refresh, and the Automated Task Scheduler are all real. **Fake:** Stop-Loss/Take-Profit columns are fixed ±5%/15% bands, the code's own comment calls them "simulated visualization"; Sector column falls back to a hardcoded `"Technology"` for unmapped symbols; the **Portfolio Stress Testing panel produces identical output regardless of which of its 4 scenario buttons is clicked** |
| 8 | Agent Network (`agents`) | 🟡 Mixed | `DigitalTwinVisualizer` core is real/event-driven (confirmed, extended this session); `AgentWorkflowTheater` is an **educational** per-agent animation (honestly labeled — looping scenes are architecture, not live ticks; cards pulse on real WebSocket events). The "Performance Threshold Alert" banner above it still reads a variable literally named `mockWinRateData` — hardcoded flat per-agent values over 30 fabricated days. **Superseded 2026-08-15 for that banner/chart/latency/stability/weights only — see Section 31.1. Other Agent Network widgets remain mocked.** |
| 9 | News Intel (`news`) | 🟢 Real (one decorative card) | Header stats, Event Clusters, Breaking News Feed, and Source Health/Provider Statistics are all real (`/api/v1/news/timeline`, `/articles`, `/providers`, with honest `'N/A'`/`'Never'` fallbacks); one "Ticker Impact & Memory Timeline" card is purely decorative with no state/fetch/props at all |
| 10 | Intelligence (`intelligence`) | 🟠 Likely fake in practice | Every metric falls back to a hardcoded default; backend population of the field it prefers (`autoBotConfig.engines`) was not confirmed to exist, so the hardcoded fallback likely renders permanently |
| 11 | Learning & Evolution (`learning`) | 🔴 100% fake | Hardcoded stat row ("Mistakes Corrected: 14," "Models Retrained: 3," "Alpha Generated by RL: +$2.4k") and strategy scorecard, no state, no fetch — despite a real backend (`ReflectionEngine`, `agent_performance_stats`) that could power this and doesn't |
| 12 | VEC Event Memory (`memory`) | 🟡 Real core, one fake chart | Search box, Precedent Analysis results, and feedback buttons are real (`/api/v1/event-memory`, `/feedback`); `VectorClusteringMap` (t-SNE scatter) is a hardcoded 12-crisis sample array, not derived from any real embedding computation — no embeddings/vector-store infrastructure exists anywhere in this codebase |
| 13 | Activity Log (`activity`) | 🟢 Real | Full read confirms no fabricated elements — log table and CSV export both operate on real `autoBotConfig.history` |
| 14 | Observability & Tracing (`audit`) | 🔴 100% fabricated + dead buttons | Fully hardcoded trace/timeline/LLM-debate/fill; "Rewind"/"Forward"/"Export Trace" have no `onClick` at all. Complete, exact duplicate of what Observatory (Tab 3) already does for real — the easiest fix in the app is deleting this and redirecting to Tab 3, since the real backend it should show already exists |
| 15 | Documentation (`documentation`) | ⚪ Static by design | Reference content, not misrepresented as live. **Updated 2026-08-15 (Section 31.2) to match current live-path / `config/*.json` numbers; still not a live dashboard.** |
| 16 | Agent Evaluation (`evaluation`) | 🟢 Real | Full read (173 lines) confirms real `/api/v2/agents/performance` fetch, honest empty state, no fabrication of any kind |
| 17 | Validation (`validation`) | 🔴 Fake | 17 "tests" pass/fail via `(Date.now() % 1000 / 1000) > 0.1` — a deterministic ~90%-pass RNG dressed as a test run, not a real check against the system |
| 18 | Deployment (`deployment`) | 🟠 Fake | "Run Quant Audit" is a `setTimeout` + score computed purely from the user's own dropdown selections — zero inspection of the real running system |
| 19 | Kronos Model (`kronos`) | 🟢 Real, model example for the app | Full read (131 lines) confirms real `/api/v1/kronos/status` fetch and explicit `DATA_UNAVAILABLE`/`--` placeholders instead of fabricated numbers wherever data is missing — the house style every other tab should copy |
| 20 | Settings & Keys (`settings`) | 🟡 Real core, one fake panel | Setup Wizard, Secrets form, AI Provider Management, Connection Status, Broker Management, Chaos Mode, Adaptive Architecture, and Webhooks are all real; the Genetic Prompt column honestly self-discloses "GATED" rather than faking a score. **Fake:** "Token Consumption & Projected Costs" panel — hardcoded `29.0M`/`1.8M`/`$65.42`/`$4.35`/`$27.00` from a `mockTokenConsumptionData` array, including a literal `65.42` embedded inside what reads as a live alert-threshold comparison |

**Corrected count: 4/20 fully real with zero fabrication (Observatory, Activity Log, Agent Evaluation,
Kronos Model), 4/20 real core undermined by one decorative element (News Intel, VEC Event Memory,
Settings & Keys, Documentation is static-by-design and not counted as a defect), 5/20 real core with
substantial fake overlay (Autonomous Dashboard, Mission Control, Holdings & Positions, Agent Network,
and — the most understated in the first pass — Trading Arena), 6/20 majority-to-fully fabricated
(Strategy Scanner, Opportunity Feed, Intelligence, Learning & Evolution, Observability & Tracing,
Validation, Deployment — note this is 7, since Trading Arena moved out of "mostly real" into its own
majority-fabricated category above; total fabricated-dominant tabs is 7/20, not 5/20 as the first pass
concluded).**

**Single most dangerous element found in this correction pass:** Trading Arena's "Execute Override"
button (Advanced Trade Sandbox) — it fabricates a filled trade into the UI with no backend call at
all, styled identically to a real execution. **Single highest-leverage fix:** Observability & Tracing
needs no new backend work, only a redirect to Observatory's already-real data.

---

### 15.21 Capability Matrices

**Broker capability matrix** — unchanged from Section 6/6a, independently re-confirmed live this
pass via a real `getCapabilities()` call.

**AI model/provider matrix:**

| Provider | Integration | Cost | Local-first eligible |
|---|---|---|---|
| Gemini | Real | Paid, real pricing tracked | No |
| OpenAI | Real | Paid, real pricing tracked | No |
| DeepSeek | Real | Paid, real pricing tracked | No |
| Grok | Real | Paid, real pricing tracked | No |
| NVIDIA | Real | Paid, real pricing tracked | No |
| Any OpenAI-compatible endpoint | Real | Varies | Yes, if local |
| Ollama (llama3.2, plutus, fingpt) | Real, via OpenAI-compatible path | $0 | Yes |
| Chronos (local) | Real, dedicated Python service | $0 | Yes |
| FinBERT (local) | Real, same service | $0 | Yes |
| XGBoost | Real, trained, NOT live-eligible | $0 | N/A (not wired to any agent) |
| Anthropic/Claude direct SDK | Not integrated | - | - |
| RAG/embeddings/vector search | Does not exist | - | - |

**Agent capability matrix:** see 15.4.

**Strategy matrix:** exactly 1 real strategy (BacktestEngine/TechnicalAgent's shared rule-set); all
other "strategies" in the UI are fabricated (15.8, 15.20).

**Risk-control matrix:** 11 real, always-evaluated, unit-tested gates (15.10).

---

### 15.22 Consolidated Findings by Severity

**Critical (fix before any further evaluation):**
1. ~~Auth bypass on unset `AUTH_PASSWORD` (15.12).~~ **Fixed 2026-08-10, see 15.25 (P0 pass).**
2. ~~`transactions.status` never reaches a terminal state (15.1).~~ **Fixed 2026-08-10, see Section
   17.1 (TransactionLifecycleTracker).**
3. ~~No verified-working on-disk backup existed at audit time despite real scheduled backup code
   (15.13/data-safety incident).~~ **Backup/restore verified end-to-end 2026-08-10, see Section 17.3.
   Separately, Section 17.4 found and fixed a real bug causing the live DB itself to be written to
   the wrong directory entirely on this machine.**

**High:**
4. 7 UI tabs are majority-to-fully fabricated theater with no visual distinction from the real ones
   (15.20) - corrected upward from an initial count of 5 after full-file re-reads found Trading Arena
   (≈10 of ~15 widgets fake, including a trade-execution button that never calls a broker) and
   Strategy Scanner were both undercounted; Holdings & Positions, Mission Control, Agent Network,
   VEC Event Memory, News Intel, and Settings & Keys each carry at least one real-looking but fully
   fabricated widget inside an otherwise-real tab. **Still not fixed - re-confirmed Section 25.3:
   zero UI truth-wiring work exists anywhere in the working tree.**
5. ~~Dead hardcoded-key duplicate `EncryptionService.ts` file (15.12).~~ **Fixed, see Section 23.1
   (deleted - confirmed via `git status` showing `D`, re-verified Section 25.6).**
6. ~~No rate limiting anywhere (15.12).~~ **Fixed 2026-08-10, see Section 16 (P0 pass).**
7. ~~Failed DB migrations don't halt boot (15.13).~~ **Fixed 2026-08-10, see Section 17.2.**
8. ~~`npm audit`: 8 high-severity dependency vulnerabilities (15.12).~~ **Effectively closed as of
   this pass - see Section 25.6: 0 high-severity, 4 moderate remaining (all in the dev-only
   `esbuild`/`drizzle-kit` chain, not shipped to production). `npm audit fix --force` has still
   never been run; almost certainly transitive dependency drift, not a deliberate fix - same
   caveat Section 19.0 applied to the 8→7 change.**

**Medium:**
9. ~~NewsAgent's real, demonstrated overconfidence (34.2% actual accuracy at 80-90% stated
   confidence) - should reduce its consensus weight or gate its confidence, not ignore it.~~
   **Fixed 2026-08-10, see Section 24.2 (real Beta-Binomial calibration), independently
   re-verified against the actual `ChiefTraderAgent.ts`/`EvidenceAggregator.ts` source in
   Section 25.1 - not just re-read from Section 24's prose.**
10. FundamentalAgent/MacroAgent contributing zero real signal in this deployment. **Root cause
    fixed 2026-08-10 (Section 24.1, re-verified Section 25.1): the real cause was AlphaVantage's
    25-request/day free-tier quota being exhausted within minutes of boot, not a code defect -
    both agents now cache a successful fetch for 24h and back off 24h after a real detected
    rate-limit response. Left open, not struck: neither agent has yet produced a confirmed real
    evaluated signal post-fix - that has not been observed live.**
11. ~~Backtest engine doesn't model commissions/partial-fills/corporate-actions; position sizing
    inconsistent with live RiskEngine.~~ **Mostly fixed 2026-08-10, see Section 25.2: real
    SEC-fee/FINRA-TAF commissions, real ATR + participation-rate dynamic slippage, a real
    corporate-actions safety halt, and position sizing now genuinely SHARED with live RiskEngine
    via `PositionSizing.ts` (the same function, not independently-maintained matching logic).
    Still genuinely open, not struck: every fill remains all-or-nothing (no partial-fill
    simulation), and the full risk-gate ladder - daily-loss, consecutive-loss, portfolio-drawdown,
    order-rate-limit, market-hours, stale-data, news-veto - is NOT replicated in the backtest loop;
    only the position-sizing math is shared.**
12. ~~No look-ahead-bias unit test despite a real, working guard.~~ **Fixed, see Section 23.5:
    `ReplayClock.test.ts`, 9 real tests against the actual class; re-confirmed still passing in
    Section 25.2 (part of the 284/284 suite total). This strikethrough itself was overdue - the
    fix predates this pass by two sections and was never reflected here until now.**
13. ~~Docker container runs as root.~~ **Fixed, see Section 25.2: a real `USER node` directive plus
    correct `--chown=node:node` on every `COPY` and the `data` directory (verified via diff,
    reasoned correctly about the volume-ownership implication) - not build-verified this pass.**
14. Market-data reconnect is flat-interval, not exponential backoff. **Re-confirmed unchanged this
    pass (Section 25.4) - still a bare `setTimeout(() => this.connectAlpaca(), 5000)`.**
15. Frontend bundle is a single 3MB chunk, no code-splitting. **Re-confirmed unchanged this pass -
    not touched by any file in Section 25's scope.**

**Low:** Mission Control's Granular Module Toggles are non-functional decoration (annoying, not
dangerous, since they don't control anything real either way); Observability & Tracing tab's dead
buttons.

---

### 15.23 Phased Implementation Roadmap

| Phase | Objective | Key work | Depends on | Risk | Acceptance criteria |
|---|---|---|---|---|---|
| **P0 — Critical Safety Fixes** | Close the auth bypass and the two other critical findings | Throw at startup if `AUTH_PASSWORD` unset (mirror `EncryptionService`'s pattern); add a `transactions` status-transition step wired to `RISK_ASSESSMENT_COMPLETED`/`ORDER_FILLED`/`ORDER_EXECUTED`; verify + document a real recovery drill from `DbBackupService`'s actual on-disk output | None | Low (small, targeted changes) | A regression test proves an empty-body login is rejected when `AUTH_PASSWORD` is unset; `GET /api/v2/transactions` shows real `EXECUTED`/`FILLED`/`RISK_REJECTED` rows after a real trade; a documented, tested restore from a real backup file succeeds |
| **P1 — Core Trading Engine Hardening** | Remove the highest-risk security/reliability gaps | Delete the dead `services/EncryptionService.ts`; add rate limiting on `/login` at minimum; halt boot on failed migration instead of logging-and-continuing; add exponential backoff to market-data reconnect; `npm audit fix` the 8 high-severity findings | P0 | Low-medium | `npm audit` shows 0 high/critical; a migration failure demonstrably stops the process; login is rate-limited |
| **P2 — Backtesting & Replay** | Make backtest results trustworthy enough to act on | Add commission modeling, size-aware slippage, a look-ahead-bias regression test for `ReplayClock`, align backtest position sizing with live RiskEngine's real caps | P1 | Medium | A new backtest run's sizing matches what RiskEngine would actually allow live; a deliberately-inserted look-ahead bug is caught by a real test |
| **P3 — Strategy Validation** | Get real evidence before trusting any signal | Accumulate a multi-week real paper-trading sample specifically for the AI-consensus layer (calendar time, not code); resolve FundamentalAgent/MacroAgent's data problem or retire them from consensus; add a confidence-calibration-aware weight adjustment for NewsAgent | P2 | Medium (requires real time) | NewsAgent's weight visibly responds to its own real calibration data; Fundamental/Macro either produce real evaluated predictions or are excluded from `ChiefTraderAgent`'s weighting |
| **P4 — Risk & Portfolio Infrastructure** | Close remaining risk-engine gaps | Real ATR-based position sizing (replace the flat 5% placeholder); wire `calculateATR()` or remove it | P3 | Low | Position size varies with real measured volatility, not a flat percentage |
| **P5 — Multi-Broker Architecture** | Broaden real broker coverage where legally possible | Evaluate SnapTrade per Section 6a's own flagged ToS tension (user's legal call, not an engineering one); add explicit `supportsStopOrders`/`supportsLimitOrders`/`supportsFractionalShares` capability granularity | P4 | Medium (partly non-engineering) | A capability matrix distinguishes order-type support per broker, not just binary can/can't-trade |
| **P6 — Multi-Model AI Architecture** | Extend local-first escalation beyond NewsAgent | Add a confidence/decisiveness gate to FundamentalAgent/MacroAgent mirroring `EscalationPolicy`; evaluate whether their underlying AlphaVantage data problem is fixable before investing further | P3 | Medium | Fundamental/Macro either produce real signal with real escalation logging, or are honestly retired |
| **P7 — AI Cost Optimization** | Real cost visibility beyond AI calls | Add market-data/broker/infrastructure cost tracking alongside the existing real `aiCostToday` metric | P6 | Low | Mission Control shows a real total daily cost, not just the AI-call slice |
| **P8 — Professional Observability** | Close the UI-lag-behind-backend gap | Rebuild the Observability & Tracing tab against the REAL transaction/event-trace data that already exists (this session's own backend work), replacing the fabricated version entirely | P0 | Low (data already exists) | The tab shows a real trace for a real trace ID, indistinguishable in rigor from `TransactionObservatory` |
| **P9 — Testing & Reliability** | Close the highest-value testing gaps | Add the missing `ReplayClock` look-ahead test; add a regression test for the P0 auth fix; add at least one browser-driven E2E smoke test | P0 | Low | CI fails if look-ahead protection or the auth fix regresses |
| **P10 — Production Deployment** | Harden the deployment path | Add `USER` directive to Dockerfile; verify backup restore procedure end-to-end; add basic alerting on `/ready` failures | P1 | Low | Container runs as non-root; a documented, tested disaster-recovery runbook exists |
| **P11 — Advanced Trading Intelligence** | Only after P3 shows real evidence | Re-evaluate XGBoost with a larger real dataset; consider a second forecasting model for ensemble disagreement; revisit RAG/embeddings if a concrete use case emerges | P3 | High (speculative) | Any new model clears the same statistical-significance bar this codebase already enforces elsewhere, or is not shipped |

**Rebuild-or-remove list (not a phase, a standing decision needed from the user) — updated after the
15.20 correction pass:** the 7 majority-to-fully fabricated tabs (Opportunity Feed, Observability &
Tracing, Learning & Evolution, Validation, Deployment, Strategy Scanner, and Trading Arena — the last
two moved into this list after full-file re-reads found Trading Arena's real widgets are a minority,
not a majority, and include a trade-execution button that never calls a broker) plus the individual
fake widgets embedded inside otherwise-real tabs (Mission Control's Granular Module Toggles and
Strategy Arena sub-component; Agent Network's Performance Threshold Alert banner; Holdings &
Positions' Stress Testing panel and stop-loss/take-profit columns; VEC Event Memory's
VectorClusteringMap; News Intel's Ticker Impact card; Settings & Keys' Token Consumption panel)
should each be either rebuilt against real data (Observability & Tracing has the easiest path, since
the real data already exists - see P8) or explicitly relabeled/removed so they stop presenting as
live infrastructure. This is a product decision, not purely an engineering one.

---

### 15.24 Final Verdict

```
ARGUS PRODUCTION READINESS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Overall:                BETA (paper-trading infrastructure real; UI ~50% real)
Trading readiness:      PAPER TRADING (backend); NOT VALIDATED (frontend claims)
Profitability:          NOT VALIDATED (real negative evidence exists, not just absence of proof)

Architecture:            7/10
Reliability:             6/10  (real fail-safe handling; migration-failure and backup gaps found)
Security:                4/10  (real auth-bypass finding; no rate limiting; 8 high-sev CVEs)
Risk Management:         9/10  (11 real, always-evaluated, tested gates; one real bypass bug fixed)
Backtesting:             6/10  (real look-ahead protection; no commissions/slippage-scaling/MC)
AI Architecture:         7/10  (real router/escalation for one path; no RAG; minimal registry)
Broker Architecture:     6/10  (real, honest about what it can't do; single unattended broker)
Testing:                 5/10  (95 real tests; zero E2E; the one safety-critical untested guard)
Observability:           7/10  (real backend; UI hasn't caught up to it - see P8)
UX:                      4/10  (half the tabs are indistinguishable-looking fabrications)
Production Readiness:    5/10  (real Docker/CI/health checks; root container; no verified backup)
```

**SHIP for continued, monitored paper trading of the real backend pipeline. DO NOT SHIP for live
capital, and DO NOT present the current frontend to any user who needs to trust what they're
looking at without this audit in hand** - a paper-trading user reading the Opportunity Feed,
Observability & Tracing, Learning & Evolution, Validation, or Deployment tabs today would be
looking at fabricated numbers with zero visual indication they aren't real.

**Minimum work before Argus should be allowed to trade real money:**
1. ~~Fix the `AUTH_PASSWORD`-unset authentication bypass (P0).~~ **Fixed 2026-08-10 - see Section 16.**
2. Fix `transactions.status` so decision outcomes are actually queryable (P0). **Still open.**
3. Verify a real, tested, working backup/restore procedure exists (P0 - this pass found none did).
4. Accumulate a real, multi-week paper-trading sample specifically evaluating the AI-consensus
   layer (P3) - the technical-rules backtest that exists today has never cleared its own
   significance floor, and NewsAgent's only real large sample shows negative Sharpe.
5. Either fix or formally exclude FundamentalAgent/MacroAgent from consensus weighting until they
   produce real evaluated signal (P3/P6).

None of this requires a rewrite. The backend built and hardened across this engagement is real and
substantially more capable than an "attractive dashboard" - the risk here is specifically that the
UI's fabricated tabs get mistaken for validated capability by someone who hasn't read this audit.

---

## 16. P0 Security & Trading-Safety Implementation Pass — 2026-08-10

Scoped, deliberately narrow implementation pass against Section 15's Critical/High findings -
**P0 only** (security, authentication, kill switch, risk safety), per explicit instruction not to
touch P1+ until P0 is complete, tested, and verified. Two additional real, previously-undocumented
bugs were found live while implementing this scope (both listed below) - fixed as part of the same
kill-switch-integrity work rather than deferred, since they directly undermined it.

**What was broken (confirmed by direct code read + live reproduction before any fix):**
- `validateCredentials()` in `server.ts` returned `true` for an empty-body login whenever
  `AUTH_PASSWORD` was unset (`undefined === undefined` on both sides) - live-reproduced against
  the actual running dev server before the fix, then re-verified closed after.
- `POST /api/v1/autobot/toggle` did `Object.assign(tradingEngine.state, req.body)` with zero field
  allowlisting - a client could set `emergencyStopActive:false`/wipe `history` directly, bypassing
  the only audited path. **Live-reproduced**: confirmed the exploit succeeded against the running
  server before the fix (payload accepted, `maxTradeSize` changed) and failed correctly after
  (allowed field applied, `emergencyStopActive`/`tradingState` untouched).
- **Found live while fixing the above (not previously documented anywhere)**: `POST
  /api/v1/config/settings` did `db.delete(schema.settings); db.insert(schema.settings).values(req.body)`
  - a full delete-and-recreate from the *raw* client body. This is a second, independent path to
  the same class of bug: a client could set `tradingState` directly (bypassing the kill-switch
  audit trail entirely) or reset `peakEquity` (defeating the new portfolio-drawdown gate below).
- No rate limiting existed anywhere in the codebase (confirmed via dependency + repo-wide search).
- The kill switch was a single in-memory boolean (`emergencyStopActive`) with no audit trail beyond
  an ephemeral, 100-entry-capped activity array, and did **not survive a process restart** - a real
  reliability gap given "require explicit reactivation" is the entire point of an emergency stop.
- Of the "maximum loss protection" controls the master prompt asked for, only daily-loss,
  single-symbol, sector, and correlation caps existed for real. Portfolio drawdown (peak-to-trough,
  distinct from the daily-reset daily-loss check), a maximum open-positions count, and an order-rate
  limit did not exist at all; the order-notional cap existed but was folded silently into a `min()`
  with no audit record of whether it was the binding constraint.

**What was changed:**
- **`src/server/core/AuthConfig.ts`** (new) - pure, unit-tested auth logic extracted from
  `server.ts`: `isAuthEnabled`, `validateCredentials`, `isSessionValid`, `checkAuthConfig`,
  `enforceAuthConfigOrExit`. Login can never succeed while `AUTH_PASSWORD` is unset (closing the
  bypass); when it IS set, boot now refuses to start unless `AUTH_USERNAME` and a real (non-default)
  `AUTH_SESSION_SECRET` are also set, and unconditionally refuses to start unauthenticated in
  `NODE_ENV=production` - mirroring `EncryptionService`'s existing "refuse to boot, don't degrade"
  convention. Unauthenticated dev mode (`AUTH_PASSWORD` unset) is preserved as CLAUDE.md documents
  it, but is now a loud, startup-logged, explicitly-validated state instead of a side effect of a
  broken comparison.
- **`server.ts`** - wired `AuthConfig` in; added `req.actor` (real authenticated username) to the
  global auth middleware for kill-switch audit attribution; applied `loginLimiter`/`aiLimiter`/
  `tradingLimiter` to `/auth/login`, `/llm/consensus`, `/mcp/trade`, `/llm/dual-verify-trade`,
  `/risk/:id/review`; added a hand-rolled sliding-window limiter to the raw WebSocket `upgrade`
  handler (never passes through Express middleware, so `express-rate-limit` can't see it).
- **`src/server/core/RateLimiters.ts`** (new) - `loginLimiter` (10/10min), `aiLimiter` (30/5min),
  `tradingLimiter` (20/min), `backtestLimiter` (5/5min), `wsUpgradeLimiter` (20/min per IP,
  hand-rolled). Applied across `systemRoutes.ts` (emergency-stop/pause/resume), `autobotRoutes.ts`
  (toggle/evolve), `v2System.ts` (system/toggle, system/backtest), `integrationRoutes.ts`
  (brokers/active, brokers/:id/live-mode - the real paper→live promotion path).
- **`src/server/engines/TradingEngine.ts`** - added a real `tradingState:
  'TRADING_ENABLED'|'TRADING_PAUSED'|'EMERGENCY_STOP'` state machine. New `setTradingState()` is
  now the *only* path that may change it: persists to `settings.tradingState` (survives a restart -
  `initialize()` now restores it), writes an immutable `kill_switch_events` row (fromState, toState,
  reason, actor, cancelledOrderIds), and - on `EMERGENCY_STOP` with `cancelOpenOrders` (default
  true) - cancels real outstanding (`status:'PENDING'`, has a `brokerOrderId`) orders via the active
  broker's real `cancelOrder()`, never touching filled positions. `toggle()` now applies an explicit
  field allowlist instead of `Object.assign(state, req.body)` (the first bug above) and refuses to
  enable LIVE mode while `tradingState !== 'TRADING_ENABLED'`.
- **`src/server/routes/systemRoutes.ts`** - `/system/emergency-stop`, `/system/pause` (new),
  `/system/resume` now call `setTradingState()` with the real authenticated actor instead of
  flipping a boolean directly. New `GET /system/trading-state` and `GET
  /system/kill-switch-events` (durable audit history, distinct from the ephemeral in-memory feed).
- **`src/server/routes/configRoutes.ts`** - fixed the second bug above: `POST /settings` now applies
  an explicit field allowlist (`SETTINGS_ALLOWED_FIELDS`) via `UPDATE` instead of delete+insert from
  the raw body; `tradingState`, `peakEquity`, `id`, `createdAt` can never be set through this route.
- **`src/server/engines/RiskEngine.ts`** - gate 0 (`emergency_stop`) now blocks on
  `tradingState !== 'TRADING_ENABLED'` (both PAUSED and EMERGENCY_STOP), not just the legacy
  boolean. Three new gates: `portfolio_drawdown` (real persisted peak-equity high-water-mark vs.
  `maxPortfolioDrawdownPct`), `order_rate_limit` (real count of `risk_assessments` rows in the last
  60s vs. `maxOrdersPerMinute`), `open_positions_cap` (real distinct-position count vs.
  `maxOpenPositions`, only blocks when the proposal would open a *new* symbol). `order_notional_cap`
  is now its own explicitly recorded gate (previously silent inside a `min()`).
- **`src/server/db/schema.ts`** + **`drizzle/0015_organic_wonder_man.sql`** - added
  `settings.tradingState/maxPortfolioDrawdownPct/peakEquity/maxOpenPositions/maxOrdersPerMinute` and
  the new `kill_switch_events` table. **A real bug in drizzle-kit's own generated migration was
  found and hand-fixed before use**: the generated `INSERT INTO __new_settings SELECT ... FROM
  settings` tried to select the five new columns from the *pre-migration* table (which doesn't have
  them), which would have failed on every real upgrade. Verified against both a fresh DB and a
  file-level copy of the actual live `data/argus.db` (never a second connection to the live file -
  copied first, per CLAUDE.md's own warning about false-corruption reports from competing
  connections).

**Files changed:** `server.ts`, `src/server/db/schema.ts`, `src/server/engines/RiskEngine.ts`,
`src/server/engines/TradingEngine.ts`, `src/server/routes/{systemRoutes,autobotRoutes,configRoutes,
integrationRoutes,v2System}.ts`, `package.json`/`package-lock.json` (added `express-rate-limit`,
`supertest`+`@types/supertest`). **New files:** `src/server/core/{AuthConfig,RateLimiters}.ts` (+
`.test.ts` for each), `src/server/engines/TradingEngine.test.ts`,
`src/server/routes/configRoutes.test.ts`, `drizzle/0015_organic_wonder_man.sql`.

**Database changes:** `settings` gains 5 columns (see above); new `kill_switch_events` table.
Migration verified twice - once against a fresh DB, once against a file-level copy of the real
`data/argus.db` - before being applied to the actual live database.

**API changes:** `GET /api/v1/system/trading-state` (new), `GET /api/v1/system/kill-switch-events`
(new), `POST /api/v1/system/pause` (new). `POST /api/v1/system/emergency-stop`/`/resume` now accept
an optional `reason` and (`emergency-stop` only) `cancelOpenOrders:boolean` (default true) and
return `tradingState`/`cancelledOrderIds`. No breaking changes to existing response shapes.

**UI changes:** none this pass (explicitly out of scope - P0 is backend security/safety only; the
existing emergency-stop/resume buttons continue to work against the same boolean field, now
backed by the real state machine underneath).

**Tests added:** 21 (`AuthConfig.test.ts`) + 3 (`RateLimiters.test.ts`) + 8
(`TradingEngine.test.ts`, real integration, isolated temp DB) + 13 new cases in
`RiskEngine.test.ts` (3 kill-switch-state, 4 drawdown, 4 open-positions, 2 order-rate) + 5
(`configRoutes.test.ts`, real HTTP-level via supertest) = **50 new tests**, plus 2 existing tests
updated for the new required `tradingState` field on the mocked/real `TradingEngine` state shape.

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` (full suite), `npm run build`.

**Test results:** 140/140 passing (up from 119 before this pass), 18/18 test files, build clean.

**Live verification performed** (against the actual running dev server, real `.env`, real
`data/argus.db` - not just unit tests): restarted the server and confirmed
`[SECURITY] Authentication is ENABLED` at boot; confirmed empty-body and wrong-password login both
now return 401 (previously the empty-body case would have returned 200 with a session); confirmed
an unauthenticated request to `/system/emergency-stop` returns 401; logged in with the real
credentials and confirmed `/auth/status` and the new `/system/trading-state` endpoint; triggered a
real emergency stop, confirmed it persisted and appears in `/system/kill-switch-events` attributed
to the real authenticated username, then resumed; confirmed `POST /autobot/toggle` with a
`{"emergencyStopActive":true}` payload no longer flips the real kill switch while a co-supplied
allowed field (`maxTradeSize`) still applies. **One incidental side effect from this live testing**:
`maxTradeSize` was changed to `4242` mid-test and restored to `3000` (the documented default)
immediately after - flagging this explicitly since I could not confirm what the user's own
pre-test value actually was.

**Remaining issues (explicitly not touched - P1+):**
- `transactions.status` never reaching a terminal state (Critical #2, unchanged).
- No verified on-disk backup (Critical #3, unchanged).
- Dead duplicate `EncryptionService.ts`, `npm audit`'s 8 high-severity CVEs, failed-migration boot
  behavior (all High findings, unchanged).
- The 7 fabricated-theater UI tabs (unchanged - explicitly out of scope for a backend-safety pass).
- `AUTH_SESSION_SECRET` is validated at startup but still not actually used for anything
  cryptographic (sessions are random DB-stored tokens, not signed) - the validation now at least
  ensures a real secret exists if a future refactor gives it a real job; not fixed further this pass
  as it would be scope creep beyond "close the auth bypass."
- Endpoint classification (PUBLIC/AUTHENTICATED/TRADING) was done by direct code inspection rather
  than written up as a standing document - the structural finding (every `/api/*` route is
  uniformly gated by one middleware, with no per-route bypass risk) is recorded here rather than in
  a separate artifact.

**Production-risk assessment:** The two most exploitable findings in Section 15 (the auth bypass
and the absence of any rate limiting) are closed and live-verified. The kill switch is now a real,
audited, restart-durable state machine instead of an in-memory boolean - a genuine reliability
improvement, not just a security one. Two additional real bypass paths around the kill switch and
drawdown protection were found and closed in the same pass, both live-reproduced before the fix.
Nothing in this pass touched the trading/consensus/backtesting logic itself - profitability
validation status (Section 15.18) is unchanged. Argus is not materially closer to "ready for live
capital" after this pass (that was never blocked on security), but it is now considerably harder to
accidentally or maliciously defeat its own safety controls.

**Next recommended phase (per the master prompt's own P1 - do not start until this is reviewed):**
Database state + audit trail + reliability - specifically `transactions.status`'s terminal-state
bug (the single highest-leverage remaining fix, since it undermines this engagement's own prior
Transaction Observatory work) and verifying the backup/restore procedure actually works end-to-end.

---

## 17. P1 Database State, Audit Trail & Reliability Pass — 2026-08-10

Scoped to the master prompt's P1 (database state + audit trail + reliability), continuing directly
from Section 16's P0 pass. Three planned items completed; **one unplanned, more serious finding**
was discovered while verifying the third item and is disclosed in full below, since it changed
where Argus's real live data had actually been living this entire engagement.

### 17.1 Fixed `transactions.status`'s terminal-state bug (Critical #2 from 15.22)

**Root cause confirmed**: `TransactionRegistry.recordConsensusTransaction()` wrote `status` exactly
once at mint time (`OPEN` or `NO_CONSENSUS`) and nothing else in the codebase ever updated it -
live-confirmed pre-fix via `GET /api/v2/transactions?limit=200` returning zero rows in any terminal
state. **New `TransactionLifecycleTracker`** (mirrors RiskAgent/OrderManagement's own
listener-singleton pattern) now closes the loop by listening to the real, already-emitted
downstream events:
- `RISK_ASSESSMENT_COMPLETED` (rejected) → `RISK_REJECTED`, closed, outcome `N_A`.
- `ORDER_SUBMITTED` → `EXECUTED` (order handed to broker, in flight).
- `ORDER_EXECUTED` with `status:'FILLED'` → `FILLED`, closed, outcome `WIN`/`LOSS` from real
  `profitLoss` (a BUY fill with no realized P&L yet correctly stays `PENDING`, not a fabricated
  WIN/LOSS).
- `ORDER_EXECUTED` with `status:'REJECTED'`/`'CANCELED'` → new `ORDER_REJECTED` terminal state
  (added to the status vocabulary - a real gap: a broker-level rejection after risk approval had
  no terminal state to land in at all before this pass).
- Still-`PENDING` after `OrderManagementService`'s own poll timeout is deliberately left at
  `EXECUTED`, not forced to a fabricated terminal state.

**A second real bug found while wiring this in**: `OrderManagementService`'s `ORDER_EXECUTED`
payload - the *only* event that fires for every terminal order outcome, not just fills - was
missing `transactionId` entirely (`ORDER_SUBMITTED`/`ORDER_FILLED` both had it; this one didn't).
Fixed as a one-line addition; without it, a broker-rejected order could never have been traced back
to its transaction at all.

8 new real integration tests (`TransactionLifecycleTracker.test.ts`, isolated temp DB, driven
purely through real `eventBus.emit()` calls, not direct function calls).

### 17.2 Fixed DB migration safety (High #7 from 15.22)

`src/server/db/index.ts` used to catch a migration failure, log it, and continue - the process kept
running against a possibly-inconsistent schema. Now re-throws, which crashes the process during
startup (before any route/agent code runs) - "must not start as healthy" instead of "started, but
silently broken." Verified with a **real** forced migration failure (not a mock): pre-created a
table migration 0000 also creates, with an incompatible definition, and confirmed the import now
rejects; a matching control test confirms a genuinely fresh DB still starts cleanly.

### 17.3 Verified backup/restore end-to-end (High-adjacent, from the Critical #3 data-safety incident)

Built a real, automated backup→delete→restore→verify drill (`DbBackupService.test.ts`, isolated
temp files): seeds real data, runs a real backup, independently verifies its integrity with a
separate connection, **deletes the "live" file for real**, restores from the backup, and verifies
the data survived byte-for-byte. Also verified `pruneOldBackups()`'s 30-day retention real behavior.
One real platform detail surfaced by this drill: unlike POSIX, **Windows refuses to delete a file
with an open handle** - the test has to close the connection first, which is the same delete-pending
mechanic CLAUDE.md already documents from the original corruption incident, now demonstrated
directly rather than inferred.

### 17.4 Unplanned finding: the real live database has been in the wrong location this entire time

While performing 17.3's drill against the *actual* environment (not just the isolated test), the
live dev server's own boot log read `Database initialized at: \data\argus.db` - a suspicious
leading-backslash, no-drive-letter path. Investigation found the real cause:

```js
const dbDir = fs.existsSync('/data') ? '/data' : path.resolve(process.cwd(), 'data');
```

`/data` is a real, intentional Docker/Linux volume-mount convention (see `docker-compose.yml`) -
but on Windows, `fs.existsSync('/data')` resolves relative to the current drive, i.e. `C:\data`.
**On this machine, `C:\data` already exists as the user's personal document folder** (tax returns,
SIN, passport, banking statements - unrelated to this project). Every time the dev server booted on
this machine, it silently wrote its real live database - and `DbBackupService`'s daily backups -
into `C:\data\backups\`, alongside those personal documents, instead of the project's own `data/`
folder. `data/argus.db` inside the project directory had become a stale, out-of-sync copy.

This was **not** a hypothetical - confirmed live: `C:\data\argus.db` was 6.86MB and actively being
written (WAL file growing) at the moment of discovery; the project-relative copy was 4.99MB and
several hours stale. A `C:\data\backups\argus_2026-08-10.db` real backup already existed.

**Fixed** by extracting the decision into a pure, unit-tested `resolveDbDir()` (4 new tests) that
only ever considers `/data` on a non-Windows platform - never on Windows, regardless of what
happens to exist at that path. **Data migrated, with the user's explicit direction on how**: the
real live DB was fetched via Argus's own real, checkpointed `GET /api/v1/system/export-db` endpoint
(not a raw file copy of a possibly-inconsistent WAL state), independently verified with a fresh
connection (`integrity_check: ok`, 359 transactions, 6 trades, 2367 event traces, matching
pre-migration state), then copied into the project's `data/` folder; the real backup was copied
into `data/backups/`. The stale project-relative copy was renamed (not deleted) to
`argus.db.stale-preswitch-2026-08-10` for reversibility. **Nothing in `C:\data` was deleted or
modified** - only copied out, left in place for the user to clean up on their own schedule, per
their explicit choice. Server restarted post-fix; boot log confirmed
`Database initialized at: C:\WorkProjects\Multi-Agent-AI-Trading-Platform\data\argus.db`; live data
re-verified intact post-move via `/api/v1/system/integrity` (39/39 schema tables) and a real
transactions query.

Separately confirmed (via repo-wide grep) that this `/data`-preference pattern exists in exactly one
place in the codebase - every other data file (`secrets.json`, `audit_trail.jsonl`,
`shadow_portfolio.json`) already always resolves to the project-relative path, so this incident was
scoped to the SQLite DB and its backups only, not a wider pattern.

### 17.5 Separately noticed, not investigated further this pass: OpenAlice's configured MCP endpoint doesn't look like OpenAlice

While re-running `GET /api/v1/system/integrity` post-migration, the `openalice_reachable` check
returned a real (not fabricated) tool list from whatever server `OPENALICE_MCP_URL` actually points
to - and that list has no `issue_create`/`inbox_read` (the only two tools
`OpenAliceAdapter`/`OpenAliceVerificationService` are coded to call), but *does* include
`placeOrder`, `modifyOrder`, `cancelOrder`, `closePosition`, `tradingCommit`, and a large set of
market-data/economic-data tools - i.e., whatever this endpoint actually is, it is not the
issue-tracking-shaped "OpenAlice" server CLAUDE.md describes, and it exposes real trading-execution
tool names. Because Argus's own OpenAlice code only ever calls the two specific tool names it's
coded for, this does not appear to be a live path for Argus to accidentally place an order through
it - but it means the OpenAlice integration has never actually worked as intended on this machine
(the `FAIL: Connected but missing expected tools` status was honestly reported, not hidden), and
there is some other, more powerful MCP-accessible service reachable at that configured URL that
the user should be aware exists. **Not investigated further or changed this pass** - out of scope
for a database/reliability pass, and resolving it requires knowing what `OPENALICE_MCP_URL` was
actually meant to point to, which only the user can say.

### 17.6 Files changed, tests, verification

**Files changed:** `src/server/db/{index,schema}.ts`, `src/server/core/TransactionRegistry.ts`,
`src/server/core/SystemBootstrap.ts`, `src/server/services/OrderManagement.ts`. **New files:**
`src/server/db/resolveDbDir.ts` (+ test), `src/server/services/TransactionLifecycleTracker.ts` (+
test), `src/server/services/DbBackupService.test.ts`, `src/server/db/index.test.ts`.

**Tests added:** 8 (`TransactionLifecycleTracker.test.ts`) + 2 (`db/index.test.ts`) + 4
(`resolveDbDir.test.ts`) + 2 (`DbBackupService.test.ts`) = **16 new tests**.

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` (full suite), `npm run build`.

**Test results:** 156/156 passing (up from 140 after the P0 pass), 22/22 test files, build clean.

**Live verification performed:** restarted the real dev server after the migration-safety and
transaction-lifecycle changes (confirmed clean boot both times); performed the actual DB relocation
against the real environment (not just a test) with independent integrity verification before and
after; confirmed `/api/v1/system/trading-state` and `/api/v1/system/integrity` both read correctly
from the new location post-move.

**Remaining issues (unchanged, out of scope for this pass):** the dead duplicate
`EncryptionService.ts`, `npm audit`'s 8 high-severity CVEs, the 7 fabricated-theater UI tabs, and
now also: the OpenAlice MCP misconfiguration (17.5), and the user's own decision on what to do with
the now-orphaned `C:\data\argus.db`/`C:\data\backups\` copies (left in place, untouched, awaiting
the user's own cleanup).

**Production-risk assessment:** `transactions.status` is now a reliable, queryable record of real
outcomes - this directly un-blocks any future analysis that depends on it (win rate by terminal
status, time-to-fill, rejection-reason breakdowns). Migration safety and backup/restore are now
verified rather than assumed. The `C:\data` finding, while outside the original P1 scope, was the
single most consequential thing found this pass: it means every prior claim in this engagement
about "the live database" implicitly meant `C:\data\argus.db` on this machine, not the project
folder - worth keeping in mind when interpreting anything from earlier in this engagement that
referenced file paths directly.

**Next recommended phase:** per the master prompt's own order, P2 (market data reliability +
reconciliation) or P3 (backtesting correctness) - or, given 17.5's finding, the user may want to
resolve the `OPENALICE_MCP_URL` misconfiguration first, since that's a one-line config question
only they can answer.

---

## 18. Broker Expansion — Questrade (read-only) and Coinbase (full) — 2026-08-10

User request: support more brokers, document their required env vars, and report the real list.
`.env.example` was updated first (documentation only). This section covers the follow-up request to
actually implement them.

### 18.1 What changed

- **`QuestradeBroker.ts`** - was a pure placeholder (authenticate always `true`, all reads
  hardcoded to zero/empty). Now a real, read-only adapter: real OAuth2 refresh-token exchange
  against `login.questrade.com`, real account auto-discovery, real balances/positions/orders via
  Questrade's REST API. **`placeOrder()`/`modifyOrder()` still throw, unchanged** - this is not a
  gap, it's a real, permanent restriction (Questrade's own API reserves order execution for
  approved partner developers, not retail apps) that no implementation can work around. The one
  real operational trap handled: Questrade's refresh tokens are single-use and rotate on every
  exchange - the newly-issued token is now persisted (encrypted) to `broker_connections` after
  every authentication, so a restart doesn't permanently break the connection by re-using an
  already-consumed token.
- **`CoinbaseBroker.ts`** - was a pure placeholder. Now a real adapter against Coinbase's current
  Advanced Trade API, authenticated via CDP (Coinbase Developer Platform) API keys - a key
  name + EC private key, signed per-request into a short-lived ES256 JWT using Node's built-in
  `crypto` module (no new dependency). Real accounts/balances/positions/order-history reads, and
  **real order placement** (market and limit), gated behind the same live-mode confirmation every
  other broker's real-money promotion already requires - `placeOrder()` refuses outright while the
  connection is in paper mode, since Coinbase has no sandbox/paper environment to simulate against.
- **`BrokerManager.ts`** - Coinbase removed from `NON_FUNCTIONAL_BROKER_IDS` (it can now really
  place orders); Questrade stays in that set for `setActiveBroker()`/`setLiveMode()` (order
  placement is still impossible), but `testConnection()` no longer short-circuits for it - a user
  configuring `QUESTRADE_REFRESH_TOKEN` can now actually verify it works, with an honest note that
  order placement remains unavailable regardless of the result.
- **`.env.example`** - added `IBKR_GATEWAY_URL` (was real and used by `InteractiveBrokersAdapter`
  but undocumented), `QUESTRADE_REFRESH_TOKEN`/`QUESTRADE_ACCOUNT_ID` (already declared in
  `server.ts`'s `SECRET_SPECS` registry but undocumented and previously unread by any broker code),
  `COINBASE_API_KEY`/`COINBASE_API_SECRET` (new), and `FRED_API_KEY` (declared in `SECRET_SPECS`,
  also previously undocumented) - each with an honest comment on what it does or doesn't enable.

### 18.2 Honesty about verification

Both new implementations were built directly against each broker's official, current API
documentation - not guessed, not adapted from a deprecated scheme (Coinbase's older HMAC
`CB-ACCESS-*` auth was deliberately not used; it's been sunset in favor of the CDP JWT scheme
implemented here). **Neither has been live-verified against a real account** - no test credentials
for either broker were available. What IS verified:
- The Coinbase JWT signer's output was checked with real cryptography, not just "runs without
  throwing": a fresh EC key pair was generated in the test, the broker's JWT was built with the
  private key, and the signature was independently verified with `crypto.verify()` against the
  matching public key - proving the ES256/JWS construction is actually correct, not just plausible.
- Every request/response mapping (account balances, positions, order history, order placement,
  cancellation) has a unit test asserting the real documented shape maps to this app's `Portfolio`/
  `Position`/`Order` types correctly, via mocked HTTP responses shaped like each API's real
  documented output.
- Questrade's refresh-token rotation was tested against a real, isolated temp SQLite DB - confirming
  the rotated token is genuinely persisted encrypted, not just held in memory.
- `BrokerManager.testConnection()` was live-verified against the actual running dev server for both
  new brokers with no real credentials configured: both fail cleanly (no crash, no fabricated
  success) with an honest reason.

**What is NOT verified and should be, before trusting either with real funds:** an actual
authenticated call against a real account for each. `BrokerManager.testConnection()` (already wired
into `POST /api/v1/brokers/:id/test`) exists specifically for this - the user should run it with
real credentials before relying on either adapter.

### 18.3 The real broker list (for the record)

| Broker | Can place real orders? | Notes |
|---|---|---|
| Internal Paper Simulator | Yes (simulated) | Always available, default |
| Alpaca | Yes | Only broker that runs fully unattended |
| Interactive Brokers | Yes, with caveats | Real Client Portal client; human 2FA ~24h; no Canadian-listed equities (IIROC) |
| **Coinbase Advanced Trade** | **Yes, as of this pass** | Real CDP JWT auth; crypto spot only; no paper mode - live-mode confirmation required before any real order |
| Questrade | **No, permanently** | Real read-only account/balance/position/order-history access as of this pass; order execution is Questrade-partner-only by their own API policy, not a code gap |

### 18.4 Adjacent finding, not fixed this pass

While confirming this work, the user's own cursor position surfaced a real, separate issue:
`App.tsx`'s "Live Broker Feed" panel (Trading Arena tab) has a broker-selection dropdown listing
**"Robinhood (Mock)", "Robinhood (Live)", and "Charles Schwab (Live)"** - brokers that don't exist
anywhere in this backend - alongside a "Questrade (Sim)" option implying a simulated mode Questrade
has never had. This is decorative, not backed by `BrokerManager` in any way, and is a distinct
UI-truthfulness issue from the real backend work in this section (matching the general pattern
already documented in Section 15.20/16 for other Trading Arena widgets) - flagged here, not fixed,
since it's a separate frontend task from what was asked.

### 18.5 Files, tests, verification

**Files changed:** `src/brokers/{QuestradeBroker,CoinbaseBroker,BrokerManager,BrokerAdapter.test}.ts`,
`.env.example`. **New files:** `src/brokers/{QuestradeBroker,CoinbaseBroker}.test.ts`.

**Tests added:** 7 (`QuestradeBroker.test.ts`) + 14 (`CoinbaseBroker.test.ts`) = **21 new tests**,
plus 1 existing assertion updated (`BrokerAdapter.test.ts`'s Coinbase `expectFunctional` flag).

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` (full suite), `npm run build`.

**Test results:** 177/177 passing (up from 156), 24/24 test files, build clean.

**Production-risk assessment:** Coinbase can now place real orders with real money once a user
configures real credentials and explicitly promotes it to live mode - this is a genuine increase in
what this codebase can do, not just documentation. The existing live-trading confirmation gate
(`LIVE_TRADING_CONFIRMATION_PHRASE`) is the only thing standing between "configured" and "real
capital at risk," exactly as it already was for Alpaca/IBKR - no new bypass was introduced. The
un-verified-against-a-live-account caveat in 18.2 is real and should be closed by the user before
this adapter is trusted for anything beyond a small, deliberate test order.

---

## 19. Full Production-Readiness Audit — Update Pass — 2026-08-10

The user re-submitted the same 40-part master audit prompt that originally produced Section 15.
**This section is a delta pass, not a re-derivation from zero.** Sections 15.2-15.9, 15.14, 15.17
(UI tabs other than News Intel; agents; AI model architecture; broker/market-data architecture;
strategy engine; backtesting; observability; the retail/professional/institutional benchmark) are
**unchanged and remain authoritative** - confirmed by `git status`: every file touched since
Section 15 was written is security/database/broker backend code or one frontend component
(`NewsDashboardTab.tsx`), listed exhaustively below. Redoing full-file re-reads of ~15 UI tabs, 5
agents, and the AI router that no commit has touched since the last audit would manufacture the
appearance of fresh verification without any new signal. What follows is every place this pass
found the ground truth had actually moved, each independently re-verified against the current
working tree just now (not recalled from memory of implementing it).

### 19.0 What was actually re-verified this pass, and how

- `npx vitest run`: **177 tests passed, 24 test files, 0 failed** (matches Section 18's claimed
  end-state exactly - re-run independently, not assumed).
- `npx tsc --noEmit`: clean.
- `npm run build`: clean (`dist/assets/index-DtmgW_Xy.js` 3,086.63kB / 615.43kB gzip, `dist/server.cjs`
  429.1kB, 10.47s).
- `npm audit`: **13 vulnerabilities (2 low, 4 moderate, 7 high)** - down from Section 15's 17 (1
  low, 8 moderate, 8 high), almost certainly a side effect of `package-lock.json` refreshing
  transitive deps when `express-rate-limit`/`supertest` were added, **not** a deliberate remediation
  - `npm audit fix` has still never been run. Remaining high-severity: `nanoid` (non-secure
  generator DoS), `postcss` (path traversal via sourcemap), plus others unchanged from Section 15.
- Read `src/server/services/EncryptionService.ts` directly: **still exists, still unimported,
  still a hardcoded-fallback-key landmine.** Not deleted.
- Read `Dockerfile` directly: **no `USER` directive anywhere in any of the 4 build stages.**
  Container still runs as root.
- Grepped for a `ReplayClock`/`LOOK_AHEAD_BIAS_DETECTED` test file: **none exists.** Still the one
  untested safety-critical backtest property.
- Read `MarketDataWorker.ts`'s reconnect handler directly: still `setTimeout(() =>
  this.connectAlpaca(), 5000)` - flat 5s retry, no exponential backoff.
- Read `TransactionLifecycleTracker.ts` directly: confirmed real, wired to
  `RISK_ASSESSMENT_COMPLETED`/`ORDER_SUBMITTED`/`ORDER_EXECUTED` exactly as Section 17.1 describes.
- Read `QuestradeBroker.ts`/`CoinbaseBroker.ts`'s `getCapabilities()` directly: confirmed
  `canPlaceOrders:false` (Questrade, permanent) / `canPlaceOrders:true, liveTrading:true,
  paperTrading:false` (Coinbase) - matches Section 18's claims.
- Read `src/components/NewsDashboardTab.tsx` directly: the "Ticker Impact & Memory Timeline" fake
  card (Section 15.20, tab #9's one flagged defect) is gone, replaced with a real count derived from
  the same `clusters` state the rest of the tab already uses.

**Full list of files with uncommitted changes, confirmed via `git status` (nothing outside this
list has moved since Section 15/commit `8b6e476`):** `.env.example`, `FINAL_ANALYSIS.md`,
`drizzle/meta/_journal.json`, `package.json`/`package-lock.json`, `server.ts`,
`src/brokers/{BrokerAdapter.test,BrokerManager,CoinbaseBroker,QuestradeBroker}.ts`,
`src/components/NewsDashboardTab.tsx`, `src/server/core/SystemBootstrap.ts`,
`src/server/core/TransactionRegistry.ts`, `src/server/db/{index,schema}.ts`,
`src/server/engines/{RiskEngine,RiskEngine.gates.test,RiskEngine.test,TradingEngine}.ts`,
`src/server/routes/{autobotRoutes,configRoutes,integrationRoutes,systemRoutes,v2System}.ts`,
`src/server/services/OrderManagement.ts`, plus new files `data/` (real DB relocation, Section 17.4),
`drizzle/0015_organic_wonder_man.sql`, and the new test/source files listed in Sections 16-18. Every
one of these is accounted for by Sections 16, 17, or 18 - there is no unexplained drift.

### 19.1 Section 15.22's Critical/High findings — final status

| # | Finding | Status |
|---|---|---|
| 1 | Auth bypass on unset `AUTH_PASSWORD` | ✅ **Fixed and regression-tested** (Section 16, re-confirmed 19.0) |
| 2 | `transactions.status` never terminal | ✅ **Fixed and tested** (Section 17.1, re-confirmed 19.0) |
| 3 | No verified on-disk backup | ✅ **Fixed and drilled end-to-end** (Section 17.3) — plus the unplanned, more serious `C:\data` live-DB-location bug found and fixed in the same pass (17.4) |
| 4 | 7 UI tabs majority-to-fully fabricated | 🟡 **Improved by one.** News Intel (tab #9) is now fully real - its one decorative card was replaced this session with a real `impactScore`-derived count (see 19.0). The other 7 fabricated-dominant tabs (Opportunity Feed, Observability & Tracing, Learning & Evolution, Validation, Deployment, Strategy Scanner, Trading Arena) are **unchanged** - still fabricated, still out of scope for this backend-focused engagement. Corrected tally: **5/20 tabs now fully real with zero fabrication** (Observatory, Activity Log, Agent Evaluation, Kronos Model, News Intel), up from 4/20. |
| 5 | Dead duplicate `EncryptionService.ts` | ⚫ **Still open.** Confirmed still present, still unimported, this pass. |
| 6 | No rate limiting anywhere | ✅ **Fixed** (Section 16: login/AI/trading/backtest/WS-upgrade limiters) |
| 7 | Failed migrations don't halt boot | ✅ **Fixed and drilled with a real forced failure** (Section 17.2) |
| 8 | `npm audit`: 8 high-severity CVEs | 🟡 **Marginally better, not remediated.** 7 high-severity now (down from 8, incidentally, not deliberately); `npm audit fix` has never been run. |

### 19.2 Broker capability matrix — update

Section 15.21/18.3's matrix is now stale on two rows:

| Broker | Can place real orders? | Change since Section 15 |
|---|---|---|
| Internal Paper Simulator | Yes (simulated) | Unchanged |
| Alpaca | Yes | Unchanged - still the only broker that runs fully unattended |
| Interactive Brokers | Yes, with caveats | Unchanged |
| **Coinbase Advanced Trade** | **Yes** | **Changed.** Was a pure placeholder (`placeOrder()` threw `Not implemented`) at Section 15's audit time. Now a real CDP-JWT-authenticated adapter with real order placement, gated behind live-mode confirmation (crypto spot only, no paper/sandbox environment). **Not yet verified against a real funded account** (Section 18.2). |
| **Questrade** | **No, permanently** | **Changed (capability, not the permanent restriction).** Was a pure placeholder returning hardcoded zeros at Section 15's audit time. Now real read-only account/balance/position/order-history access via genuine OAuth2. Order placement remains impossible - Questrade's own API restricts execution to approved partner developers, unrelated to anything this codebase could implement. |

This moves Section 15.17's benchmark-table "Execution" row from "single broker, manual failover"
to **"two unattended order-placing brokers (equities + crypto), still single-broker-per-asset-class,
still no smart order routing"** - a real but incremental improvement, still solidly retail-grade,
not professional-grade (which would mean routing the same order across multiple venues for best
execution, not just having more venues available).

### 19.3 What has NOT changed and remains exactly as Section 15 found it

Stated explicitly because the master prompt's own Phase 18 instruction is "do not fabricate missing
capabilities" - the inverse also applies: do not fabricate progress that didn't happen.

- **Profitability is still not validated**, in either direction beyond what Section 15.18 already
  found. No new paper-trading sample, no new backtest run, no new evaluated predictions were
  generated by any work in Sections 16-18 - this was security/database/broker infrastructure work,
  not trading-signal work. NewsAgent's real 34.1% win rate / -0.315 Sharpe finding stands unchanged;
  FundamentalAgent/MacroAgent's inertness stands unchanged.
- **Backtesting is unchanged**: no commission modeling, no size-aware slippage, no
  `ReplayClock`/look-ahead-bias test, no corporate-actions handling, no Monte Carlo - all exactly as
  Section 15.9 found.
- **The AI architecture is unchanged**: same providers, same router, same single local-first
  escalation path (NewsAgent only), no RAG/embeddings, `ModelCapabilityRegistry` still minimal.
- **The other 7 fabricated-theater UI tabs are unchanged** - still fabricated, still visually
  indistinguishable from the real ones.
- **Market-data architecture is unchanged**: still Alpaca-only, still no `MarketDataProvider`
  abstraction, still flat 5s reconnect retry (re-confirmed directly this pass, 19.0).
- **The OpenAlice MCP misconfiguration (17.5) is unchanged** - still unresolved, still requires the
  user to clarify what `OPENALICE_MCP_URL` was meant to point to.
- **The fake "Robinhood"/"Charles Schwab"/"Questrade (Sim)" broker dropdown in Trading Arena
  (18.4) is unchanged** - still decorative, still not backed by `BrokerManager`.

### 19.4 Updated scorecard

Deltas from Section 15.24's scorecard, each tied to a specific fixed/unfixed finding above -
dimensions with no listed reason are unchanged from Section 15.24.

```
ARGUS PRODUCTION READINESS (updated 2026-08-10, post P0/P1/Broker Expansion)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Overall:                BETA (unchanged - real backend infrastructure meaningfully hardened;
                         UI still ~55% real; no new trading evidence either way)
Trading readiness:      PAPER TRADING (backend); NOT VALIDATED (frontend claims) — unchanged
Profitability:          NOT VALIDATED (unchanged — no new trading data generated this pass)

Architecture:            7/10  (unchanged)
Reliability:             8/10  (was 6 — migration fail-fast, drilled backup/restore, and the
                                 C:\data live-location bug are all real, verified fixes; still
                                 short of 9+ without exponential-backoff reconnect)
Security:                7/10  (was 4 — auth bypass closed + regression-tested, rate limiting
                                 real and applied broadly, kill switch now a durable audited state
                                 machine; held back from higher by the still-live dead-key
                                 EncryptionService.ts file and 7 un-remediated high-sev CVEs)
Risk Management:         9/10  (unchanged — still 11 real gates, now with real audit-trailed
                                 kill-switch state backing gate 0 specifically)
Backtesting:             6/10  (unchanged)
AI Architecture:         7/10  (unchanged)
Broker Architecture:     7/10  (was 6 — Coinbase went from stub to functional, Questrade from
                                 stub to real read-only; still single unattended equities broker)
Testing:                 6/10  (was 5 — 177 tests/24 files, up from 95/14, including several real
                                 forced-failure integration drills not present before; still zero
                                 E2E, still no ReplayClock look-ahead test)
Observability:           7/10  (unchanged)
UX:                      4/10  (unchanged — one tab improved out of 20 doesn't move this materially)
Production Readiness:    6/10  (was 5 — migration safety + verified backup/restore are real
                                 production-readiness improvements; still-root Docker container and
                                 un-remediated CVEs hold it back from higher)
```

### 19.5 Updated SHIP / DO NOT SHIP

**Unchanged conclusion, stronger footing under it.** SHIP for continued, monitored paper trading of
the real backend pipeline - now on meaningfully more solid ground (durable audited kill switch,
closed auth bypass, verified backup/restore, no more silent-continue-after-migration-failure).
**DO NOT SHIP for live capital** - this was never primarily a security-readiness question and
remains blocked on the same evidence gap Section 15.18 identified: no statistically meaningful
validated trading edge exists anywhere in this codebase, and nothing in Sections 16-18 changed that,
because none of it touched trading-signal generation or ran new backtests/paper-trading time.
**Continue to withhold trust from the frontend for any user without this audit in hand** - 15/20
tabs still contain fabricated content indistinguishable from real data by looking alone (down from
16/20 by exactly one tab this pass).

**Updated minimum work before Argus should be allowed to trade real money** (Section 15.24's list,
re-checked):
1. ~~Fix the `AUTH_PASSWORD` bypass.~~ **Done (16).**
2. ~~Fix `transactions.status`.~~ **Done (17.1).**
3. ~~Verify backup/restore.~~ **Done (17.3), plus the unplanned `C:\data` fix (17.4).**
4. Accumulate a real, multi-week paper-trading sample specifically evaluating the AI-consensus
   layer. **Still open - requires calendar time, not code, and nothing in Sections 16-18 advanced
   this.**
5. Fix or formally exclude FundamentalAgent/MacroAgent from consensus weighting. **Still open.**

Items 4-5 are now the *only* remaining gate on the original list - everything else on Section
15.24's minimum-work list has been closed. They are also the two items no amount of further backend
hardening can substitute for.

### 19.6 Roadmap position

Section 15.23's P0 is **complete** (16). P1 is **partially complete**: done -
migration-fail-fast, backup/restore verification, the (unplanned but real) `C:\data` fix, and rate
limiting (16, folded in ahead of schedule); still open - deleting the dead `EncryptionService.ts`,
`npm audit fix`, and a Dockerfile `USER` directive. P2 (backtesting correctness) and beyond are
**untouched** and remain exactly as Section 15.23 scoped them - recommended next, per the master
prompt's own sequencing rule ("never let the AI optimize the backtest until the backtester itself
has been proven correct"), is closing out the remainder of P1 (small, low-risk, already scoped)
before opening P2.

---

## 20. Questrade Wired In As a Second, Independent Market-Data Source — 2026-08-10

User request, following a shared analysis of Questrade's real API capabilities: wire Questrade in
as a second market-data source agents can be cross-checked against, not just an account-data-only
broker. Scoped deliberately narrower than "feed it into agent decisions" - see rationale below.

### 20.1 A real, previously undocumented finding surfaced while scoping this

A `MarketDataAdapter`/`MarketDataManager` abstraction (`src/marketdata/`) already exists in this
codebase, with `PolygonAdapter` and `YahooFinanceAdapter` registered - but both are **100% mocked**
(`PolygonAdapter.getQuote()` returns a hardcoded `150.00/150.05/150.02`; `getHistoricalCandles()`
on both returns `[]`; `streamQuotes()` is a no-op on both), and the whole manager is wired to
exactly one thing: `integrationRoutes.ts`'s adapter-selection UI panel. **It is never consulted by
`MarketDataWorker` or any agent** - the real live pipeline is Alpaca-only, hardcoded, and entirely
separate from this abstraction. This is the same "real-looking scaffolding disconnected from the
real pipeline" pattern this engagement's audits have found repeatedly elsewhere (Section 15.20).
Not fixed or touched this pass - flagged for the record, since it directly explains why "wiring in
a second source" required new plumbing rather than just registering an adapter.

### 20.2 What was built

- **`QuestradeBroker.ts`** - two new real methods: `getQuote(symbol)` (GET
  `/v1/markets/quotes/{symbolId}`, with a cached `/v1/symbols?names=` lookup resolving symbol →
  symbolId) and `getHistoricalCandles(symbol, timeframe, limit)` (GET
  `/v1/markets/candles/{symbolId}`, mapping the same Alpaca-style timeframe strings
  `HistoricalDataGateway` already uses to Questrade's own interval enum). Both real, against
  Questrade's documented API - not registered with `MarketDataManager` and `QuestradeBroker` does
  not formally `implement MarketDataAdapter`, deliberately: that registry is the disconnected,
  mock-only UI selector from 20.1, and registering a second Questrade instance there would be
  actively unsafe, not just redundant - Questrade's refresh tokens are single-use, so a second
  instance authenticating independently would invalidate/be invalidated by `BrokerManager`'s own.
- **`BrokerManager.getBroker(id)`** (new, read-only) - lets a consumer reuse the one already-
  authenticated broker instance for a specific id without disturbing which broker is active for
  order placement, and without ever creating a second instance.
- **`MarketDataWorker.getActiveSymbols()`** (new) - real currently-subscribed symbol list.
- **`MarketDataCrossChecker`** (new service) - on a 60s timer, for each symbol Alpaca is actively
  streaming, fetches Questrade's real quote for the same symbol and compares it to Alpaca's live
  price. Emits `MARKET_DATA_SOURCE_DISCREPANCY` (symbol, both prices, divergence %) when they
  disagree by more than 0.5%. Idles - emits nothing, calls nothing - whenever Questrade isn't
  registered/authenticated or a symbol has no live Alpaca price yet; a single symbol's Questrade
  quote failing doesn't stop the rest of the batch. Registered in `SystemBootstrap.start()`/`stop()`
  alongside the app's other timer-driven workers.

### 20.3 Deliberately NOT done this pass, and why

- **This does not feed into any agent's decision logic or RiskEngine's gate ladder.** It is a
  cross-check between two independent price feeds, emitting an observability event - not a second
  trading signal and not a new risk gate. Turning a source discrepancy into something that actually
  blocks or delays a trade is a real, separate decision that changes the safety-critical gate
  ladder audited in Section 15.10/19 - it should be evaluated deliberately with its own review, not
  bundled into a market-data plumbing change.
- **No Options Agent, no options endpoints.** The user's own scoping choice for this request
  explicitly excluded this, consistent with Section 15.18's/19's standing finding that no validated
  trading edge exists anywhere in this codebase yet - a new speculative agent is exactly the kind of
  addition that finding argues against until existing signal is proven.
- **The discrepancy event is not yet persisted anywhere durable** - it's a real `eventBus.emit()`
  (visible in the wildcard-listener WebSocket broadcast and the capped in-memory ring buffer per
  CLAUDE.md's EventBus description), not written to a new DB table. Adding durable history/UI for
  this is a natural, small follow-up if the user wants it, not included here to keep this pass's
  scope to what was asked.
- **Questrade's account-level real-time-quote entitlement is not verified.** Per the user's own
  shared analysis: whether `getQuote()` returns genuinely real-time data or a delayed/snap quote
  depends on the connected account's market-data package, and Questrade's raw response carries
  `isRealTime`/`delay` flags this mapping does not surface (the shared `Quote` type has no field for
  them). A large, spurious "discrepancy" could mean Questrade is simply delayed, not that Alpaca is
  wrong - worth knowing before trusting this signal operationally.
- **Not live-verified against a real Questrade account** - same caveat as Section 18's broker work;
  no test credentials were available. Request/response mapping is tested against Questrade's
  documented shapes (mocked HTTP), not a live call.

### 20.4 Files, tests, verification

**Files changed:** `src/brokers/{QuestradeBroker,BrokerManager}.ts`,
`src/server/services/MarketDataWorker.ts`, `src/server/core/SystemBootstrap.ts`. **New files:**
`src/server/services/MarketDataCrossChecker.ts` (+ `.test.ts`); new test cases added to
`src/brokers/QuestradeBroker.test.ts` for `getQuote`/`getHistoricalCandles`.

**Tests added:** 8 (`MarketDataCrossChecker.test.ts`, pure-function + dependency-injected
integration style, no live Questrade/Alpaca calls) + 7 (`QuestradeBroker.test.ts` new cases:
real symbol-lookup + quote mapping, symbolId caching, bid/ask fallback when `lastTradePrice` is
null, candle mapping/truncation/most-recent-ordering, interval-enum mapping, and a rejection path
for an unmatched symbol) = **15 new tests**. Two test-fixture bugs were found and fixed during this
pass (not production bugs): a `vi.spyOn` not being reset between tests in
`MarketDataCrossChecker.test.ts` (fixed with an explicit `afterEach(() => emitSpy.mockRestore())`),
and a zero-padding bug in a synthetic candle-date fixture (`08-0${10}` produced the invalid string
`"2026-08-010"`; fixed with `String(i+1).padStart(2,'0')`).

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` (full suite), `npm run build`.

**Test results:** 192/192 passing (up from 177), 25/25 test files, build clean.

**Not live-verified this pass:** no dev-server restart/live-endpoint check was performed for this
specific change (unlike Sections 16-18, which each included a live-server verification step) -
this is real, unit-tested code, but its actual behavior against a live Alpaca+Questrade session on
this machine has not been observed running yet.

---

## 21. Accuracy Pass: Live Broker Panel Confirmation + Two Real Test-Suite Bugs Found and Fixed — 2026-08-10

User asked to confirm this document is up to date, then separately pasted the live contents of the
Settings & Keys → Broker Management panel from the actually-running app - the first real look this
engagement has had at that panel live, filling in part of Section 20.4's "not live-verified this
pass" gap. Verifying that observation surfaced two genuine, previously-undetected bugs (one in the
test suite, one in the UI itself), both investigated to root cause and fixed here, not just noted.

### 21.1 What the live broker panel confirmed

- Alpaca: **ACTIVE**, "Connected - health: Healthy" - matches every prior claim in this document
  that Alpaca is the one broker that runs fully unattended.
- Questrade and Coinbase: both show `authenticate() returned false` - expected and correct, since
  neither has real credentials configured in this environment (Section 18.2/20.3's own stated
  caveat). Not a bug; the honest, documented state.
- IBKR: same `authenticate() returned false`, also expected (no Gateway running/logged in).
- The capability grid (Place/Cancel Orders, Paper/Live, US/Canadian/Crypto) renders real, distinct
  `getCapabilities()` flags per broker, including IBKR's real cited IIROC rule for why Canadian
  equities stay disabled regardless of session state - matches `BrokerAdapter.ts`/Section 15.6.
- Portfolio Reconciliation feed: real, honest empty state ("No reconciliation events yet... Enable
  the autonomous engine") - matches Section 15.11/17.1's description of a real, event-driven
  worker that is silent, not broken, until the autonomous engine is actually running.

### 21.2 Real bug found: `BrokerManagement.tsx`'s "Set Active" showed a generic, wrong-broker error

The pasted panel showed the exact same hint text - "...or an IBKR Gateway that is not running/
logged in" - under **both** Interactive Brokers and Coinbase. That makes no sense for Coinbase,
which has no gateway concept at all. Root cause, confirmed by reading `BrokerManagement.tsx:108`:
the "Set Active" button's failure path had a single hardcoded generic message naming IBKR as an
example, shown for **any** broker's activation failure - `POST /api/v1/brokers/active` only ever
returns `{success:false}` with no detail (`BrokerManager.setActiveBroker()` returns a bare
`boolean`), so the frontend had been guessing instead of asking for the real reason. **Fixed**: "Set
Active" now calls the same `testConnection()` real-error path the "Test Connection" button already
uses, showing each broker's actual, specific failure reason instead of a fabricated generic guess.

### 21.3 Real bug found: two test files were touching the live `data/argus.db`, not an isolated copy

Re-running the full suite for this accuracy pass hit intermittent failures that hadn't shown up
before. Investigation found `BrokerAdapter.test.ts` (pre-existing) and `MarketDataCrossChecker.test.ts`
(new this session, Section 20) both statically import modules that transitively import
`src/server/db/index.ts` with no `ARGUS_DB_PATH` override - meaning both had been opening and
migrating against the **real** live database, not an isolated temp file, every time they ran.
Multiple test workers doing this concurrently is exactly the competing-connection risk CLAUDE.md
already documents (a false `SQLITE_CORRUPT` report from one connection while the app's own stays
healthy) - here it manifested as non-deterministic whole-suite failures.

**Fixed systemically, not per-file**: new `vitest.setup.ts`, wired via `vitest.config.ts`'s
`setupFiles`, gives every test file a fresh, unique, isolated temp DB by default - before that
file's own imports resolve - with cleanup in a global `afterAll`. Test files that already manage
their own isolated temp DB (the majority) are unaffected: they set their own `ARGUS_DB_PATH` in
their own `beforeAll` before dynamically importing `../db`, which simply overrides this default
before their own import reads it. This closes the bug for these two files and makes it structurally
impossible for any future test file to repeat it by accident.

### 21.4 Real bug found: a `dotenv.config()` side effect was silently undoing a test's simulated "no credentials" state

While chasing the flakiness above, `RiskEngine.gates.test.ts`'s third test started failing
**deterministically** (reproduced 3/3, independent of the DB-isolation fix above - confirmed by
reverting it and re-testing). Root cause: the test deletes `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`
*before* dynamically importing `RiskEngine`/`TradingEngine`, but `EncryptionService.ts` calls
`dotenv.config()` as a module-load side effect - and default `dotenv` behavior re-populates any key
that looks unset (which `delete` produces) from `.env`. That silently restored the real Alpaca
credentials partway through the import chain, so `RiskEngine`'s `market_hours` gate made a real
call to Alpaca's clock API instead of short-circuiting - and since real market hours were genuinely
closed at the time this accuracy pass ran (~4:50pm ET), the gate correctly rejected the trade,
failing the test's "approved: true" expectation. **This exact bug had already been found and fixed
once before**, in `marketDataToRisk.test.ts` (its own code comment documents the identical root
cause) - `RiskEngine.gates.test.ts` was added later (Section 16) without the same treatment, and sat
as a live, latent bug until real wall-clock time happened to cross into after-hours during this
pass. **Fixed** by moving the deletion to after the imports complete, matching the established
pattern. Confirmed the fix addresses the actual cause (not just symptom) by reverting the DB-isolation
fix and re-testing in isolation: the dotenv bug reproduced identically with or without it, and is
resolved independently of it.

### 21.5 Verification

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` × 3 consecutive runs (full suite,
to specifically confirm the flakiness is gone, not just that one run got lucky), `npm run build`.

**Test results:** 192/192 passing, 25/25 test files, on all 3 consecutive runs. Build clean.

**Files changed:** `src/components/BrokerManagement.tsx`,
`src/server/engines/RiskEngine.gates.test.ts`, `vitest.config.ts`. **New file:** `vitest.setup.ts`.

**Not yet done:** `BrokerAdapter.test.ts` and `MarketDataCrossChecker.test.ts` still don't set their
own `ARGUS_DB_PATH` explicitly - they now work correctly because of the new global default, but
relying on a global safety net rather than each file being explicit is slightly less robust than
the pattern most other test files already follow. Low priority given the global fix already closes
the actual risk.

**Production-risk assessment:** Neither bug found this pass affected production/live behavior -
both were test-suite-only (a false-negative source, not a false-positive one) and one frontend
cosmetic-but-misleading error message (never a security or trading-safety issue: the underlying
`setActiveBroker()`/`authenticate()` logic itself was always correct; only the displayed reason was
wrong). Both are exactly the kind of "found while verifying something else" issue this engagement
has repeatedly surfaced by insisting on re-running real checks instead of trusting a prior claim of
"passing" at face value.

---

## 22. Paper/Live Capability Gating - Closed a Real Confirmation-Phrase Bypass — 2026-08-10

User asked three things: whether IBKR supports paper trading and how much simulated capital it
provides, and - the substantive request - to make sure no broker can be put into a paper or live
mode it doesn't actually support, with a clear error rather than a silent failure later.

### 22.1 IBKR paper trading (verified via web search, not recalled from training data)

Real and already correctly modeled in this codebase. IBKR's paper trading accounts come pre-funded
with **$1,000,000 USD simulated equity** as of the most recent documentation (April 2026), and the
paper cash balance can be reset in Client Portal to up to **5x the linked production account's real
value** (reset requests before 4pm ET take effect the next business day). Paper vs. live for IBKR is
determined entirely by which of two separate logins you complete at the Client Portal Gateway
(`https://localhost:5000`) - not something `InteractiveBrokersAdapter` can toggle at runtime, which
is why its `paperTrading()`/`liveTrading()` methods are no-ops (now documented as such - see 22.3;
previously undocumented, unlike Questrade's equivalent no-ops).

Sources: [IBKR Paper Trading Account documentation](https://www.ibkrguides.com/clientportal/papertradingaccount.htm) ·
[IBKR Demo Account — $1,000,000 in Virtual Funds](https://www.tic.co.tz/interactive-brokers/demo-account/)

### 22.2 Real bug found: the properly-gated live-mode switch had no capability check at all

`BrokerManager.setLiveMode()` - the one path meant to gate real-money promotion behind
`LIVE_TRADING_CONFIRMATION_PHRASE` - only ever checked `NON_FUNCTIONAL_BROKER_IDS` (i.e., can this
broker place orders at all). It never checked whether the *specific* mode being requested was
actually supported. Confirmed via the real capability matrix:

| Broker | `paperTrading` | `liveTrading` |
|---|---|---|
| Internal Paper Simulator | true | **false** (no real account behind it) |
| Alpaca | true | true |
| Interactive Brokers | true | true |
| **Coinbase Advanced Trade** | **false** (no sandbox exists) | true |
| Questrade | false | false (already fully blocked separately, `canPlaceOrders:false`) |

Before this pass, nothing stopped `setLiveMode('internal_paper', true, <phrase>)` from succeeding -
labeling the paper simulator as "live" with no real broker behind it - or `setLiveMode('coinbase',
false)` from marking Coinbase "paper," silently deferring the real failure to the moment an order
was actually placed (`placeOrder()` already refused paper-mode Coinbase orders, so no money was
ever actually at risk from this specific gap - but it violated the user's explicit ask: fail with a
clear reason upfront, not later). **Fixed**: `setLiveMode()` now reads `broker.getCapabilities()`
and refuses with a direct, broker-named error (`"{name} does not support live trading."` /
`"{name} does not support paper trading (no sandbox/simulated environment exists for this
broker)."`) before ever reaching the confirmation-phrase check.

### 22.3 More serious finding: a second path could set a connection live with no confirmation phrase at all

While verifying the fix above, found that `POST /api/v1/config/brokers` (the "Add/Update
Credentials" form) did `db.insert(schema.brokerConnections).values({ brokerName, ...rest })` with
`...rest` spread directly from the raw request body - meaning a client could set `paperMode: false`
directly on a **new** connection, with **no** capability check and, more importantly, **no**
`LIVE_TRADING_CONFIRMATION_PHRASE` requirement at all. `BrokerManager.initialize()` reads
`connection.paperMode` on every boot and calls `activeBroker.liveTrading()` accordingly - so a
connection inserted this way would come up live on the very next restart, having never gone through
the one gate this entire engagement has repeatedly treated as the sole thing standing between
"configured" and "real capital at risk" (Sections 16, 18.5, 20). This is the same class of bug as
the P0 pass's `Object.assign(state, req.body)`/delete-and-recreate-from-raw-body findings (Section
16) - a raw, unallowlisted write reachable through a different route than the ones already audited.
**Fixed**: `paperMode` is now stripped from the client-controlled fields and the insert always
forces `paperMode: true` - a brand-new connection can only ever be promoted to live through
`setLiveMode()`'s real gate (now also capability-checked, per 22.2).

**Not fixed, a separate, smaller finding noticed while reading this code**: `POST
/api/v1/config/brokers` is a plain `INSERT`, not an upsert - re-submitting the same broker's
credentials creates a second row rather than updating the first, and `brokerName` has no unique
constraint. `BrokerManager.initialize()`'s `brokerConnections.find(b => b.brokerName === ...)` would
then silently use whichever row query order returns first (typically the oldest), so a credential
*update* via this form might not actually take effect. Flagged here, not fixed this pass - it's a
real correctness gap but a different one from what was asked, and fixing it well means deciding
whether to add a unique constraint + migration or switch to an explicit update-if-exists path.

### 22.4 Also fixed: Questrade's "Set Active" error was being discarded by the previous session's own fix

Section 21.2's fix (routing "Set Active" failures through `testConnection()` for a real per-broker
reason) had an unintended side effect: `setActiveBroker()` already throws a specific, correct
message for Questrade (`"...is not a functional adapter (placeOrder is unimplemented). Refusing to
select it as active."`), but the previous fix discarded that in favor of a generic re-check.
**Fixed**: the frontend now shows the backend's real `error` field directly when one was given, and
only falls back to `testConnection()` when the failure carried no detail at all (the plain
`authenticate() returned false` case, which genuinely needs the extra call to explain itself).

### 22.5 Files, tests, verification

**Files changed:** `src/brokers/{BrokerManager,InteractiveBrokersAdapter}.ts`,
`src/server/routes/configRoutes.ts`, `src/components/BrokerManagement.tsx`. **New file:**
`src/brokers/BrokerManager.test.ts` (5 tests: live-mode refused for `liveTrading:false`, paper-mode
refused for `paperTrading:false`, both allowed for a fully-capable broker, and Questrade's
NON_FUNCTIONAL_BROKER_IDS block still fires before the capability check would even matter).

**Tests added:** 5.

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` (full suite), `npm run build`.

**Test results:** 197/197 passing (up from 192), 26/26 test files, build clean.

**Not live-verified this pass:** no dev-server restart was performed to confirm this end-to-end
against the real running app - these are real, unit-tested code paths, but the actual UI flow
(attempting to set an unsupported mode and seeing the new error render) hasn't been observed live.

**Production-risk assessment:** 22.3 is the more consequential finding - closing a real, previously
unguarded path to a connection coming up live with real-money risk on a restart, with zero
confirmation ever required. 22.2 is lower-severity (the underlying `placeOrder()`/`authenticate()`
calls already refused in practice) but closes the same class of "fails late instead of failing
clearly upfront" gap the user specifically asked about. Neither finding was reachable by an
unauthenticated user - both still require an authenticated session, same as every other route.

---

## 23. Closed Out the Remaining P1 Items + One Bridge Into P2 — 2026-08-10

User asked to keep enhancing/improving the app based on the suggestions already in this document.
Section 19.6 had explicitly recommended closing out P1's remaining small, low-risk, already-scoped
items before opening P2 (backtesting correctness) - this pass does exactly that, plus fixes the
insert-vs-upsert bug flagged-but-not-fixed in 22.3, plus adds the one missing safety-critical test
flagged since Section 15.9/15.22 (#12) as a bridge into P2 without opening its full scope.

### 23.1 Deleted the dead duplicate `EncryptionService.ts` (P1, Section 15.22 #5)

Confirmed zero references anywhere in the repo (`src/server/services/EncryptionService.ts` was
never imported by anything - the real one everything actually uses is `src/server/core/
EncryptionService.ts`). Deleted outright rather than left as a landmine for a future refactor to
accidentally import.

### 23.2 Added a non-root `USER` directive to the Dockerfile (P1, Section 15.22 #13 / 15.23 P10)

The runtime stage now runs as the `node` user the official `node:*-slim` base image already
ships (uid/gid 1000), not root. Required `--chown=node:node` on every `COPY` into that stage plus
a `chown` on the `data/` directory - without it, the container would fail the moment the non-root
user tried to read `node_modules`/write `data/argus.db`. Checked `docker-compose.yml` before
making this change: `data/` is mounted as a **named volume** (`argus-data:/app/data`), not a bind
mount, so Docker will correctly inherit this ownership into the volume on first creation rather
than hitting a host-side permission mismatch (the failure mode this fix would have caused with a
bind mount instead). **Not build-verified** - no Docker daemon is available in this environment;
the change follows the standard, well-documented pattern for official Node images, but it has not
actually been built and run.

### 23.3 `npm audit fix` + removed an entirely unused dependency (P1, Section 15.22 #8)

`npm audit fix` (non-breaking) resolved 10 of 16 vulnerabilities on its own. The remaining 6 (later
consolidated to 4 after the removal below) all required `--force`, which would have breaking-
upgraded `@alpacahq/alpaca-trade-api` and breaking-*downgraded* `drizzle-kit` - the actual migration
tool this app has already had to hand-fix a generated migration against once (Section 16). Forcing
either blindly was too risky to do without review, so instead:

- Checked whether `@alpacahq/alpaca-trade-api` (the package requiring the axios upgrade) is used
  anywhere - it is not. `AlpacaBroker.ts`/`HistoricalDataGateway.ts` both make raw `fetch()` calls
  directly to Alpaca's REST/WebSocket APIs and never import this SDK. **Removed it entirely**
  (`npm uninstall`) rather than force-upgrading a dependency nothing references - this closed the
  axios-related vulnerabilities as a side effect, with zero functional risk since nothing pointed
  at it.
- Left the remaining 4 moderate-severity findings (`esbuild`/`@esbuild-kit`, transitively required
  by `drizzle-kit`) as-is, deliberately: `drizzle-kit` is dev-only tooling (migration generation),
  never shipped to production, and the specific vulnerability ("esbuild enables any website to send
  any requests to the development server") is only reachable by running `drizzle-kit`'s own dev
  server locally while visiting a malicious site simultaneously - real, but low real-world risk here
  relative to the risk of a forced drizzle-kit downgrade breaking this app's actual migration
  history.

**Result: `npm audit` now reports 4 moderate, 0 high, 0 critical** (down from 16 total, 7 high, at
the start of this pass).

### 23.4 Fixed the broker-credentials insert-vs-upsert bug flagged in 22.3, not fixed at the time

`POST /api/v1/config/brokers` now checks for an existing row by `brokerName` and updates it in
place instead of always inserting a new one - closing the real gap where re-submitting credentials
for the same broker silently created a duplicate row, and `BrokerManager.initialize()`'s
`.find(b => b.brokerName === ...)` could silently keep using the stale first match. The update path
deliberately never touches `paperMode` (consistent with 22.2/22.3's fix) - rotating a broker's
credentials can never silently flip an already-live connection back to paper, or vice versa.

### 23.5 Added the missing `ReplayClock` look-ahead-bias test (bridge into P2, Section 15.9/15.22 #12)

`ReplayClock.assertNotFuture()` is the single most safety-critical correctness guard in the
backtest engine - the thing standing between a real result and a look-ahead-biased fabrication of
one - and had zero test coverage since it was first flagged in Section 15.9. New
`ReplayClock.test.ts` (9 tests) covers the guard directly: rejects a genuinely future timestamp
with `LOOK_AHEAD_BIAS_DETECTED`, allows the exact boundary and anything in the past, rejects time
moving backwards, and a realistic simulated-backtest-loop scenario proving the guard fires when a
later bar is checked before the clock has advanced to it. This is a deliberately narrow slice of
Section 15.23's P2 (backtesting correctness) - proving the *existing* guard is correct, not the
broader P2 scope (commission modeling, slippage scaling, position-sizing alignment), consistent
with the master prompt's own standing rule: never optimize the backtest before the backtester
itself is proven correct.

### 23.6 Files, tests, verification

**Files changed:** `Dockerfile`, `package.json`/`package-lock.json`,
`src/server/routes/configRoutes.ts`. **Deleted:** `src/server/services/EncryptionService.ts`.
**New files:** `src/server/routes/configRoutes.brokers.test.ts` (3 tests),
`src/server/engines/backtest/ReplayClock.test.ts` (9 tests).

**A real test-isolation lesson from this pass**: the broker-upsert tests were first written as a
second `describe` block inside the existing `configRoutes.test.ts`, each with its own `beforeAll`
setting a fresh `ARGUS_DB_PATH` and dynamically importing `../db`. This failed with `TypeError: The
database connection is not open` - vitest caches a dynamically-imported module **per test file**,
not per `describe` block, so the second block's `import('../db')` returned the *first* block's
already-cached (and by then closed) connection instead of a fresh one. Every other isolated-DB test
in this codebase already follows a strict one-describe-per-file convention for exactly this reason;
moving the new tests into their own file (`configRoutes.brokers.test.ts`) fixed it immediately.

**Tests added:** 3 (`configRoutes.brokers.test.ts`) + 9 (`ReplayClock.test.ts`) = **12 new tests**.

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` × 3 consecutive runs, `npm run
build`, `npm audit`.

**Test results:** 211/211 passing, 28/28 test files, on all 3 consecutive runs. Build clean.

**Not live/build-verified this pass:** the Dockerfile change (no Docker daemon available in this
environment - see 23.2); no dev-server restart was performed for the broker-credentials fix (unit-
tested, not observed live).

**Roadmap position, updated:** Section 15.23's P1 is now **fully complete** - all four items (dead
file, rate limiting, migration fail-fast, `npm audit`) are closed, alongside the confirmation-phrase
bypass found in Section 22. P2 (backtesting correctness) remains open beyond the one guard proven
correct here: commission modeling, size-aware slippage, and aligning backtest position sizing with
live `RiskEngine`'s real caps are all still unstarted, per Section 15.9's findings.

---

## 24. Phase 1 of the 4-Phase Remediation Plan: Dynamic Consensus Calibration & Dead Agent Handling — 2026-08-10

User handed down a 4-phase remediation plan (calibration/dead-agent handling, backtester/live
parity, frontend truth-wiring, stability/hardening) with explicit instruction to fix/wire/enhance
rather than delete. Given this exact engagement's own established discipline throughout this
audit - one phase implemented, tested, and verified before the next begins - this section covers
**Phase 1 only**. Phases 2-4 are deliberately not started; see 24.5.

### 24.1 Task 1C: real root cause found for Fundamental/MacroAgent's dead data, before writing any fix

Live-diagnosed against the actual configured `ALPHAVANTAGE_API_KEY` (a real `curl` call, not
assumed): the key is valid and working, but AlphaVantage's free tier caps it at **25 requests/day**.
FundamentalAgent (60s interval, 3 symbols) and MacroAgent (75s interval, 3 parallel calls/cycle)
exhaust that quota within minutes of boot; every call after that gets AlphaVantage's real
rate-limit response (`{"Information": "...our standard API rate limit is 25 requests per day..."}`),
which has no `.PERatio`/`.data[0].value` field, so the existing code correctly - not buggily -
falls through to an honest `DATA_UNAVAILABLE`. This was never a code-quality bug in the fallback;
it was a real quota/polling-cadence mismatch, and fundamentals/macro indicators don't change on a
sub-minute cadence in reality either.

**Fixed** with a real cache + rate-limit cooldown, not a provider swap or fabricated fallback data:
new `external_data_cache` table + `ExternalDataCache.ts` (9 tests). Both agents now cache a
successful fetch for 24h before re-fetching, and back off for 24h after a real detected rate-limit
response instead of re-hitting an exhausted quota every cycle. `looksLikeRateLimitResponse()`
detects AlphaVantage's real rate-limit/throttle response shape by content, not an exact-string
match. A second, independent bug fixed in the same pass: MacroAgent's three indicators (CPI/Fed
Funds/unemployment) are symbol-independent, monthly-cadence US macro releases, but were being
wastefully re-fetched every single 75s cycle regardless of which "symbol" happened to be selected
that cycle - now cached once globally (`symbol: null`), not per-nominal-symbol. Fundamental/Macro's
`DATA_UNAVAILABLE` reasoning text now distinguishes "not configured" from "rate limit exhausted,
resumes in 24h" - a real, more diagnosable signal for Mission Control's health view than the
previous single generic message covering both cases.

**Disclosure**: the diagnostic `curl` call's response echoed the real (free-tier, low-sensitivity)
API key value back in its rate-limit message - visible in this session's transcript. Never sent to
any third party beyond AlphaVantage itself. Flagged to the user directly; rotate at your discretion.

### 24.2 Task 1A: real Beta-Binomial confidence calibration, distinct from the existing flat per-agent weight

Confirmed first that `agentPerformanceStats.currentWeight` (real, already existed, updated by
`ReflectionEngine` from real outcomes) is a flat, agent-wide scalar driven by OVERALL win rate -
it cannot see or correct NewsAgent's real, specific finding (15.0/15.4): an 80-90%-stated-
confidence bucket resolving to ~34.2% actual accuracy at n=76. An agent can have an unremarkable
overall win rate while still being systematically overconfident specifically when it claims high
confidence, and the existing mechanism has no way to detect that.

**Built real, defensible Bayesian math, not an unlabeled heuristic wearing the name**: new
`agent_confidence_calibration` table + `ConfidenceCalibration.ts` (12 tests) implementing a genuine
Beta-Binomial conjugate posterior - prior centered on each confidence bucket's own midpoint with a
pseudo-sample-size of 10 (trusts an agent's stated confidence until real data says otherwise),
posterior mean = `(wins + alpha0) / (wins + losses + alpha0 + beta0)`. Verified against the exact
real NewsAgent scenario: 76 real observations at 34.2% accuracy in the 0.8-0.9 bucket pulls the
posterior to ~0.40, far below the stated 0.85 - while a agent with only 1 real observation stays
close to its own stated confidence, appropriately, since there's no real evidence yet to override
it. `ReflectionEngine.evaluateAgents()` now buckets every real evaluated prediction by stated
confidence and persists real win/loss counts + the computed posterior per (agent, bucket) - proven
against real seeded outcome data (`ReflectionEngine.calibration.test.ts`, 3 tests), not asserted.
`ChiefTraderAgent` now looks up and substitutes this calibrated value for an agent's raw stated
confidence before both `evaluateConsensus()` and `recordUnresolvedAsNoConsensus()` call
`EvidenceAggregator.aggregate()` - proven end-to-end with real seeded calibration rows
(`ChiefTraderAgent.calibration.test.ts`, 3 tests): NewsAgent's real 34%-bucket finding, applied live,
pulls a would-be-approved 0.85-confidence idea below the 0.75 approval threshold entirely; an
agent with zero real evaluated history passes through unchanged; a genuinely well-calibrated agent
sees only the small correction its own real track record actually justifies.

**Scope decision, stated explicitly**: the persisted consensus-evidence trail (`consensus_evidence`)
still records the calibrated confidence as `confidence`, not a separate raw-vs-calibrated pair -
adding that would have meant a further schema change to `TransactionRegistry`/`consensus_evidence`
beyond what Task 1A asked for. Nothing is lost: the raw stated confidence is already durably
recorded in `agent_predictions.confidence` (`ReflectionEngine.logPrediction()`, untouched by this
change), and the calibration table itself records the bucket-level real win/loss counts - the two
numbers are independently reconstructable, just not pre-joined into one trace view yet.

### 24.3 Task 1B: the premise didn't match the actual code - verified, not blindly "fixed"

Read `EvidenceAggregator.aggregate()` before writing anything: a `HOLD`/`confidence:0` idea (which
is exactly and only what Fundamental/MacroAgent's `DATA_UNAVAILABLE` path ever emits) is already
excluded from **both** `agreeing` and `disagreeing` in the existing weighted-vote math - it
contributes nothing to `totalWeight` or the numerator, so it structurally cannot dilute the
denominator today. Writing a "fix" for this would have been exactly the kind of unverified,
uncritical execution this whole audit exists to push back against. Instead: added an explicit,
clearly-labeled regression test (`EvidenceAggregator.test.ts`) proving this against the real
`DATA_UNAVAILABLE` payload shape specifically (not just a generic HOLD case), locking the guarantee
in so a future change to the aggregation math can't silently reintroduce the dilution the user was
concerned about.

### 24.4 Files, tests, verification

**Files changed:** `src/server/db/schema.ts` (+2 tables), `src/server/services/{FundamentalAgent,
MacroAgent,ChiefTraderAgent,ReflectionEngine}.ts`, `src/server/services/EvidenceAggregator.test.ts`.
**New files:** `src/server/services/ExternalDataCache.ts` (+ test), `src/server/services/
ConfidenceCalibration.ts` (+ test), `src/server/services/ChiefTraderAgent.calibration.test.ts`,
`src/server/services/ReflectionEngine.calibration.test.ts`. **New migration:**
`drizzle/0016_loud_venus.sql` - also recreated 4 unrelated tables (`memory_rules`, `sessions`,
`settings`, `users`) purely to refresh a `created_at` `Date.now()`-literal default that `drizzle-kit`
re-evaluates fresh on every generation - a pre-existing quirk unrelated to this pass's schema
changes, confirmed safe (straight `INSERT...SELECT`, no data loss) and applied as-is rather than
hand-edited, since fixing the underlying `Date.now()`-as-a-JS-default pattern is a separate,
small, real finding out of scope here.

**Tests added:** 9 (`ExternalDataCache`) + 12 (`ConfidenceCalibration`) + 3
(`ChiefTraderAgent.calibration`) + 3 (`ReflectionEngine.calibration`) + 1 (`EvidenceAggregator`,
Task 1B's regression test) = **28 new tests**.

**Tests executed:** `npx tsc --noEmit` (clean), `npx vitest run` × 3 consecutive runs, `npm run build`.

**Test results:** 239/239 passing, 32/32 test files, on all 3 consecutive runs. Build clean.

**Migration verified** against both a fresh temp DB and a file-level copy of the real
`data/argus.db`, per this engagement's own established practice - never a second live connection.

**Not live-verified this pass:** no dev-server restart was performed - this is real, tested code,
but the actual live effect (does a real trade idea's approval decision visibly change once real
outcome data accumulates) has not been observed running, since it depends on real evaluated
predictions accumulating over time, not something a single session can force.

### 24.5 Explicitly not started: Phases 2-4, and why

Per this engagement's own repeatedly-stated discipline ("never let the AI optimize the backtest
until the backtester itself has been proven correct"; "implement P0 only, do not touch P1+ until
complete and verified"), Phases 2-4 of the user's remediation plan were not started this pass:

- **Phase 2 (backtester/live parity)** is large on its own - RiskEngine sizing-logic reuse,
  commission modeling, ATR-scaled slippage, and a corporate-actions safety check are each real,
  substantial pieces of work, not a quick follow-on to Phase 1.
- **Phase 3 (frontend truth-wiring)** spans 15 UI tabs. Task 3C specifically - wiring the Trading
  Arena "Execute Override" button to real order placement - needs a real design decision before
  any code: it must go through the same `RiskAgent -> RiskEngine -> OrderManagementService` path
  every other real order takes, not call `OrderManagementService` directly and bypass the entire
  gate ladder this engagement has spent multiple passes hardening. Wiring it the wrong way would
  itself be a new instance of exactly the "raw path bypassing a safety gate" bug class found and
  closed repeatedly across Sections 16 and 22.
- **Phase 4** is partially already done: Task 4A's ask (strict DB isolation per test worker) was
  already built in Section 21.3 (`vitest.setup.ts`). Tasks 4B (a real E2E suite) and 4C (a script
  scanning routes for un-allowlisted raw writes) remain open, both real and worth doing, but not
  started this pass.

---

## 25. Remediation Verification Pass — 2026-08-10

The user asked for a "Phase 24" verification pass covering four claimed areas: dynamic consensus
calibration, backtester parity, UI data wiring, and event-bus hardening. Section 24 already exists
(this document's own numbering had moved on since the user last looked), so this is Section 25, not
a duplicate 24. More importantly: **the four-area premise does not match the codebase.** Section
24.5, written earlier the same day, states outright that only Phase 1 (calibration/dead-agent
handling) was done and Phases 2-4 were "deliberately not started." Taking neither the user's prompt
nor Section 24's own prose at face value, this pass independently re-verified the current working
tree against `git diff HEAD` (the exact byte-level ground truth of what changed since baseline
commit `8b6e476`), read every new/changed file directly, ran the full test suite, ran `npm audit`
and `tsc --noEmit` fresh, and - going one step further than any prior pass in this document -
**actually executed** the one piece of work that claims to be an end-to-end proof (the new
Playwright E2E test), rather than trusting that a test file existing means it passes.

**Bottom line up front:** three of the four claimed areas turn out to be real, substantial, tested
work that happened *after* Section 24 was written but was never documented - this section is that
documentation. The fourth ("event-bus hardening") does not exist as any identifiable body of work.
One of the three real areas (Phase 4B's E2E test) is real code that **fails when actually run** -
found by running it, not by reading it.

### 25.0 Method: what was actually checked, and how

- `git status -sb` / `git diff HEAD --stat` - the full, exact list of every changed/new file since
  the Section 15 baseline commit, cross-referenced against every claim below. Nothing in this
  section is asserted without a corresponding file read.
- Read in full: `PositionSizing.ts` (new), `Commissions.ts` (new), `Slippage.ts` (new), the
  `BacktestEngine.ts`/`RiskEngine.ts`/`HistoricalDataGateway.ts`/`ChiefTraderAgent.ts` diffs in
  full (not summaries), `MarketDataCrossChecker.ts` (new), `ReplayClock.test.ts` (new),
  `EvidenceAggregator.ts`'s `aggregate()` method directly, `FundamentalAgent.ts`'s
  `DATA_UNAVAILABLE` path directly, the `Dockerfile` and `App.tsx` diffs in full.
- `npx vitest run`: **284 passed, 38 test files, 0 failed.**
- `npx tsc --noEmit`: clean.
- `npm audit`: **4 moderate, 0 high/critical** (down from Section 19.0's 13 total / 7 high).
- `npx playwright test` (the new `e2e/moduleToggleParity.spec.ts`): **1 failed.** This is the only
  place in this document's history where a claimed test was actually executed and found broken
  rather than read and trusted - see 25.4.

### 25.1 Dynamic Consensus Calibration (Section 24's "Phase 1") — re-verified real, independent of Section 24's own prose

Not re-derived from scratch - Section 24.2-24.4's description was checked against the actual
current source, not re-explained:

- `ChiefTraderAgent.ts`'s diff confirms a real `calibrateConfidence()` method, called before both
  `evaluateConsensus()` and `recordUnresolvedAsNoConsensus()` build their `Evidence[]` array,
  looking up `agent_confidence_calibration` by `(agentName, bucketLow)` and substituting the
  calibrated value for the raw stated confidence - falls back to the raw value on lookup failure or
  zero history, never fabricates a correction out of no data.
- `EvidenceAggregator.aggregate()` read directly: `agreeing = evidence.filter(e => e.side ===
  testSide)` and `disagreeing = evidence.filter(e => e.side !== testSide && e.side !== 'HOLD')` -
  confirmed line-for-line that a `HOLD`/`confidence:0` idea (exactly what Fundamental/MacroAgent's
  `DATA_UNAVAILABLE` path emits, confirmed directly in `FundamentalAgent.ts`) contributes to
  neither arm of the weighted vote. This was Task 1B's finding (the premise didn't match the code)
  and it holds up under independent re-reading.
- **Direct answer to the user's question:** yes, the calibration mechanism suppresses NewsAgent's
  demonstrated overconfidence, per Section 24.2's own tested scenario (76 real observations at
  34.2% accuracy in the 0.8-0.9 bucket pulls a stated 0.85 confidence down to ~0.40, below the 0.75
  approval threshold) - this scenario is covered by `ChiefTraderAgent.calibration.test.ts` and
  `ReflectionEngine.calibration.test.ts`, both part of the 284/284 passing suite re-run this pass.
- **Direct answer to the user's other question:** yes, Fundamental/MacroAgent are dynamically
  excluded from consensus weighting when data is unavailable - but this was true *before* today's
  work too (Task 1B found no real bug here); what's new is that "unavailable" should now be a rarer
  state, since the real root cause (a 25-req/day AlphaVantage quota exhausted within minutes of
  boot, not a code defect) now has a real 24h cache + cooldown instead of re-hitting an exhausted
  quota every cycle.
- **Not yet observed live:** exactly as Section 24.4 disclosed, no live effect (an approval decision
  actually changing once real outcome data accumulates) has been observed running - this remains
  true after this pass too, since no new evaluated predictions were generated.

### 25.2 Backtester / Live Parity ("Phase 2") — real, substantial, undocumented until now; genuinely partial, not full parity

This is the real news this pass found: Phase 2 was *not* "not started" by the time this
verification happened, contradicting Section 24.5. Confirmed via `git diff HEAD --stat`:
`BacktestEngine.ts` (+111/-28), `RiskEngine.ts` (major refactor), `HistoricalDataGateway.ts`
(+58), plus three entirely new modules with no prior mention anywhere in this document. (One
exception, for precision: the look-ahead-bias test below was *not* newly found - Section 23.5
already documented it, correctly scoped as "a deliberately narrow slice of P2," predating Section
24.5. It is re-verified here, not re-discovered.)

- **Position sizing - genuine shared-code parity, not "matching" logic.** New
  `src/server/engines/PositionSizing.ts` is a pure function (`calculatePositionSizing()`)
  implementing order-notional/single-symbol-concentration/open-positions/sector-concentration/
  correlation-exposure/sufficient-size math. `RiskEngine.ts`'s diff shows this exact logic was
  *deleted* from `RiskEngine.ts` and replaced with a call to `calculatePositionSizing()` from the
  shared module; `BacktestEngine.ts`'s diff shows it importing and calling the *same* function.
  This closes the specific inconsistency Section 15.9/15.22 #11 flagged ("position sizing
  inconsistent with live RiskEngine") in the strongest possible way - one function, two callers,
  not two independently-maintained implementations that could silently drift apart again.
- **Commissions - real, sourced, dated.** New `Commissions.ts`: SEC Section 31 fee ($20.60/$1M
  principal, sells-only) and FINRA TAF ($0.000195/share, sells-only, $0.01 min/$9.79 cap), both
  cited against FINRA's own 2026 rate notices and cross-checked against Alpaca's regulatory-fees
  page (the app's only real unattended broker). Broker commission itself correctly defaults to $0,
  matching Alpaca's real equity fee structure. Honestly discloses what it does *not* model (a CAT
  fee whose current rate wasn't found published anywhere verifiable) rather than guessing.
- **Slippage - real, dynamic, not a flat constant.** New `Slippage.ts` replaces the old flat 5bps
  symmetric spread with a base floor + a volatility component (real 14-period Wilder ATR, reusing
  `TechnicalIndicators.calculateATR` - confirmed to exist and already be used elsewhere, not a new
  unverified formula) + a participation-rate component (order size vs. that bar's real volume).
  Directly closes Section 15.9's own flagged gap ("not scaled by size/volatility/liquidity").
- **Corporate actions - a real safety halt, not adjustment.** New
  `HistoricalDataGateway.checkForUnadjustedCorporateActions()` fetches a one-off split-adjusted
  comparison range and diffs it against the cached raw bars; a >1% divergence anywhere throws and
  halts the backtest run rather than silently producing a result built on a corrupted pre-split
  price series. Correctly returns `checked:false` (never a fabricated "clean") when it genuinely
  cannot verify - no credentials, fetch failure, or no bars yet.
- **Look-ahead-bias test - real, already documented (Section 23.5), re-confirmed here.**
  `ReplayClock.test.ts` (9 tests) exercises the actual `ReplayClock` class: forward/backward
  movement, the exact-boundary case, and - the property that matters - `assertNotFuture()` throwing
  `LOOK_AHEAD_BIAS_DETECTED` when checked against a genuinely future timestamp, including a
  realistic bar-by-bar sequence simulating the real bug class this guard exists to catch. Read
  directly and re-confirmed real, not a stub; part of the 284/284 passing run. Section 15.22 #12
  was struck through in Section 23.5's own pass but never actually marked as such in the list
  itself until this pass (25's edit to Section 15.22) - a paperwork gap, not a code gap.
- **What is NOT parity, stated as directly as this document states everything else:** the backtest
  loop calls `calculatePositionSizing()` - it does not call RiskEngine's full gate ladder. Daily-
  loss circuit breaker, consecutive-loss circuit breaker, portfolio-drawdown circuit breaker,
  order-rate limiting, market-hours checking, stale-data checking, and the news-veto gate all exist
  live and do **not** exist in the backtest loop at all. A backtest can therefore still "pass" a
  strategy that would have been halted live by any of these seven gates. Partial fills are also
  still unmodeled - every simulated fill is all-or-nothing at the computed slippage price, never
  partially filled the way a real large order against real liquidity might be. "Backtester/live
  parity" is accurate for entry/exit sizing and cost modeling; it is not accurate as a claim that
  the backtest would reject everything live trading would reject.
- **No new backtest run exists.** All of the above is infrastructure. Nothing in the working tree
  shows a fresh backtest actually re-executed against this new cost/sizing model to see whether
  Section 15.18's negative-Sharpe finding changes under more realistic costs. This matters directly
  for Section 25.6's verdict.

### 25.3 Frontend / UI Data-Wiring ("Phase 3") — not done; tally unchanged from Section 19.5

`git diff HEAD -- src/App.tsx` is the entire claim here, and it is small enough to read in full:
**94 lines changed, all of them one new feature** - a live "Available to Trade" readout (real
`portfolioData.buying_power`/`cash` from the active broker, already fetched every 6s) next to the
Allocated Budget Limit input under Mission Control's (`activeTab === "command"`, tab #2) "BLACK BOX
AUTONOMOUS TRADING BOT" panel, plus a real client-side warning and a real server-side rejection
(`TradingEngine.toggle()` now checks the allocated budget against the active broker's real buying
power before allowing AutoBot to start, returning a clear error instead of starting under-funded)
built earlier in this same session. This is a genuine, tested, live-broker-backed improvement - but
it is a **new capability**, not a fix to any of the 15 tabs' previously-flagged fabricated widgets,
and `NewsDashboardTab.tsx` (the one tab fixed, per Section 19.0) shows no further changes since.

No other component file under `src/components/` or the other 19 `activeTab` branches in `App.tsx`
shows any diff at all. Mission Control's own confirmed-fabricated elements - the Granular Module
Toggles (`handleToggle`/`handleSetMode` still only mutate local React state) and the
`AutonomousMissionControl.tsx` sub-component's hardcoded `winRate:68` and four fixed showcase
strategies - are untouched. Mission Control's tab verdict stays 🟡 Mixed, not upgraded.

**Updated tally: still 5/20 tabs fully real with zero fabrication** (Observatory, Activity Log,
Agent Evaluation, Kronos Model, News Intel) and **15/20 tabs still contain at least one fabricated
element**, exactly as Section 19.5 left it. The user's premise that "UI data wiring" was addressed
this pass is not supported by the working tree.

### 25.4 "Event-Bus Hardening" — no such initiative exists; the closest real work is unrelated, plus one small genuine fix

`src/server/core/EventBus.ts` and `EventStore.ts` show **zero uncommitted changes** - both are
byte-identical to the Section 15 baseline per `git status`. There is no event-bus hardening in this
working tree under any reasonable reading of that phrase (retry logic, backpressure, delivery
guarantees, persistence).

The closest candidate is new, unrelated work: **`MarketDataCrossChecker.ts`**, wired into
`SystemBootstrap.start()`/`stop()`, is a real, well-scoped second-source market-data integrity
check - every 60s, compares Alpaca's live streamed price against Questrade's real Level 1 quote for
each actively-streamed symbol (via `MarketDataWorker.getActiveSymbols()`, also new this pass) and
emits `MARKET_DATA_SOURCE_DISCREPANCY` past a 0.5% divergence threshold. It correctly never
short-circuits into RiskEngine's gate ladder (a discrepancy is logged, not trade-blocking, by
explicit design choice stated in its own header) and idles silently rather than fabricating a
comparison when Questrade is unauthenticated. This is real, genuinely new capability - it is a new
event *producer*, not a hardening of the bus itself, and calling it "event-bus hardening" would
overclaim what it is.

One small, real, adjacent bug fix also exists: `OrderManagement.ts`'s `emitOrderExecution()` call
was missing `transactionId` in its payload for every terminal order state *except* a successful
fill (i.e., REJECTED/CANCELED/timeout-still-PENDING never carried it) - `TransactionLifecycleTracker`
could not close out a transaction whose order was rejected or canceled post-approval. Six lines,
confirmed via diff, real. This is the only concrete evidence in the entire working tree that even
loosely touches "event" reliability, and it does not amount to a hardening initiative.

**Playwright/E2E infrastructure was also found** (`playwright.config.ts`, `e2e/`,
`package.json`'s new `test:e2e` script) - its own header comment explicitly labels it "Phase 4B" of
the user's 4-phase plan, meaning Phase 4 has also progressed since Section 24.5 said it hadn't
started. See 25.5 - this is real code, and it does not currently work.

### 25.5 Phase 4B (E2E) — real code, verified BROKEN by actually running it, not by reading it

`e2e/moduleToggleParity.spec.ts` is well-designed: it deliberately targets Mission Control's
Emergency Stop button - a control this document has repeatedly confirmed is genuinely wired, as
opposed to the same tab's confirmed-fabricated Granular Module Toggles - and asserts against the
real `/api/v1/system/trading-state` REST response, not the DOM, which is the correct way to prove
UI/backend parity rather than just proving a button exists. `playwright.config.ts` correctly spins
up the real dev server against a disposable temp SQLite DB and throwaway auth credentials, never
`data/argus.db` or real secrets.

**This pass actually ran it** (`npx playwright test`, after stopping a locally-running dev server
instance that was occupying port 3000) rather than taking the file's existence as proof it works.
**Result: 1 failed.** Root cause, from the captured page snapshot: a fresh, isolated E2E database
has `settings.onboardingComplete = false` by default, which force-opens the full-screen "Argus
Initialization / Autonomous Trading Setup Wizard" modal on load. The test never dismisses it (no
click on the wizard's own "Skip Setup" button) before attempting to click the Mission Control tab
button, which the modal's `pointer-events` overlay blocks - Playwright retried the click for the
full 30s timeout against an element it correctly identified as visible but pointer-occluded, then
failed. This has nothing to do with whether Emergency Stop itself works - the test never got far
enough to find out.

**This is exactly the class of finding this document exists to catch**, applied for once to a test
file instead of a UI component: a testing artifact that reads as a real, thoughtful proof of
UI/backend parity is not actually providing that proof today. Phase 4B is real, tested-by-writing,
not tested-by-passing. One line (`await page.getByRole('button', { name: /skip setup/i
}).click();` before the tab-nav wait) would likely fix it, but that fix was not applied this pass -
verification, not remediation, was this pass's mandate.

### 25.6 Updated Scorecard

Deltas from Section 19.4 (not 15.24 directly - 19.4 is the more recent baseline), each tied to a
specific verified finding above. Dimensions with no listed reason are unchanged from 19.4.

```
ARGUS PRODUCTION READINESS (updated 2026-08-10, post Remediation Verification Pass)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Overall:                BETA (unchanged - infrastructure meaningfully hardened again; UI tally
                         unchanged at 5/20 tabs fully real, 15/20 with fabricated content (25.3);
                         still no new trading evidence either direction)
Trading readiness:      PAPER TRADING (backend); NOT VALIDATED (frontend claims) — unchanged
Profitability:          NOT VALIDATED (unchanged — no new backtest run or paper-trading sample
                         was generated by any work found this pass; see 25.2's own disclosure)

Architecture:            8/10  (was 7 — real shared PositionSizing.ts eliminates a live/backtest
                                 sizing-drift risk that existed as two independently-maintained
                                 implementations; real calibration + external-data-cache layers
                                 are genuine additive structure, not one-off patches)
Reliability:             8/10  (unchanged — this pass's findings are testing/security/backtesting,
                                 not reliability-infrastructure)
Security:                9/10  (was 7 — the two specific factors 19.4 cited as holding this back,
                                 the dead-key EncryptionService.ts and 7 un-remediated high-sev
                                 CVEs, are BOTH now resolved (deleted; 0 high remaining); held back
                                 from 10 by 4 remaining moderate CVEs, dev-tooling-only, unaddressed)
Risk Management:         9/10  (unchanged — 13 real gates now vs. 11 previously counted
                                 (portfolio_drawdown, order_rate_limit), already near-ceiling,
                                 doesn't move the score materially)
Backtesting:             8/10  (was 6 — real commissions, real dynamic slippage, real corporate-
                                 actions safety halt, and shared-code position-sizing parity all
                                 closed this pass; held back from 9-10 by the still-live-only risk-
                                 gate ladder (25.2) and no partial-fill/Monte Carlo modeling)
AI Architecture:         8/10  (was 7 — real Beta-Binomial confidence calibration now measurably
                                 suppresses NewsAgent's demonstrated overconfidence, and Fundamental/
                                 MacroAgent's "zero signal" root cause is fixed, not just tolerated;
                                 held back from 9-10 by zero new live evidence that this actually
                                 changes an approval decision yet, same providers/router otherwise)
Broker Architecture:     7/10  (unchanged — no broker capability work this pass)
Testing:                 7/10  (was 6 — 284 tests/38 files, up from 177/24, closing the long-
                                 flagged ReplayClock gap; held back from 8+ because the one real E2E
                                 test that exists FAILS when run (25.5) - infrastructure exists,
                                 "zero passing E2E" remains functionally true)
Observability:           7/10  (unchanged — MarketDataCrossChecker adds a new event, not new
                                 observability tooling)
UX:                      4/10  (unchanged — zero of the 15 fabricated-content tabs were touched;
                                 see 25.3. The user's "UI data wiring" premise does not hold)
Production Readiness:    8/10  (was 6 — both factors 19.4 named as holding this back, the root
                                 Docker container and the CVE count, are now real, verified fixes;
                                 held back from 9-10 by the still-broken E2E harness (not yet a
                                 trustworthy CI gate) and the untouched single 3MB bundle)
```

### 25.7 Rewritten SHIP / DO NOT SHIP

**Infrastructure parity achieved on cost modeling and position sizing, security posture, and
production-deployment hygiene. Profitability remains unvalidated. DO NOT SHIP for live capital.**

This pass closed real, previously-documented gaps: the backtest engine now shares its actual
position-sizing math with live RiskEngine instead of an independent flat-percentage rule, models
real regulatory commissions and dynamic slippage instead of none, and safety-halts on detected
unadjusted corporate actions instead of silently corrupting on them. Security's two worst
outstanding items (a dead hardcoded-key file, 7 high-severity CVEs) are both resolved. The Docker
container no longer runs as root. NewsAgent's own demonstrated overconfidence now has a real,
tested statistical correction instead of being ignored. None of this is theater - every claim above
was checked against the actual diff or actual execution, not prose.

None of it is evidence the strategy makes money. No new backtest was run under the new cost model;
no new paper-trading sample was generated; NewsAgent's real -0.315 Sharpe finding from Section
15.18 stands completely unchanged and unre-tested. **The single most important number this document
has ever cited - "is there a real, statistically validated trading edge anywhere in this
codebase" - is exactly as unanswered today as it was in Section 15.18, regardless of how much
infrastructure has been hardened around it.**

**SHIP for continued, monitored paper trading of the real backend pipeline** - now on the most
solid infrastructure footing this document has recorded, with real cost-aware backtesting, a
resolved security posture, and a statistically-grounded (if not yet live-observed) confidence
correction for the one agent shown to need one.

**DO NOT SHIP for live capital.** This was never primarily a security or infrastructure question
and this pass does not change that: no statistically meaningful validated trading edge exists
anywhere in this codebase.

**Continue to withhold trust from the frontend for any user without this audit in hand.** 15/20
tabs still contain fabricated content indistinguishable from real data by looking alone - exactly
Section 19.5's count, not improved by this pass despite the user's premise that UI work happened.

**Updated minimum work before Argus should be allowed to trade real money** (Sections 15.24/19.5's
list, re-checked a second time):
1. ~~Fix the `AUTH_PASSWORD` bypass.~~ **Done (16).**
2. ~~Fix `transactions.status`.~~ **Done (17.1).**
3. ~~Verify backup/restore.~~ **Done (17.3), plus the unplanned `C:\data` fix (17.4).**
4. Accumulate a real, multi-week paper-trading sample specifically evaluating the AI-consensus
   layer. **Still open - requires calendar time, not code; nothing in Sections 16-25 advanced this.**
5. Fix or formally exclude FundamentalAgent/MacroAgent from consensus weighting. **Deliberately
   NOT struck through, precision over optics: the exclusion was already real (Task 1B, 25.1), and
   the "fix" half is now real too (Task 1C, 25.1) - root cause resolved, cache + cooldown shipped
   and tested. Downgraded from "open" to "infrastructure fixed, real evaluated signal not yet
   observed" - the item's actual goal (real signal reaching consensus) has not been confirmed live.**
6. **New, added this pass:** run a real backtest under the new commission/slippage/sizing-parity
   model and record whether Section 15.18's negative-Sharpe finding changes. Zero code required -
   this is purely a "run it and look" gap, and closing it is now cheaper than at any prior point in
   this document's history because the infrastructure to do it honestly finally exists.
7. **New, added this pass:** fix `e2e/moduleToggleParity.spec.ts`'s onboarding-modal blocker (25.5)
   before treating Phase 4B as closed - a broken E2E test provides less real confidence than no E2E
   test at all if anyone reads its existence as proof.

### 25.8 A note on this document's own process, stated as directly as everything above

This pass found real work - Phase 2 (backtester parity) and part of Phase 4 (E2E scaffolding) -
sitting completed, tested, and passing in the working tree, entirely undocumented, while Section
24.5 (written the same day) stated plainly that this work had not started. Whoever performed that
work did not update this document afterward. This is the same failure mode this document has
warned about in the other direction throughout (claiming progress that didn't happen) - here it ran
the other way: real progress happened and was never recorded. Keeping `FINAL_ANALYSIS.md` current
in the same commit or session as the code it describes is not optional if this document is to keep
being the ground-truth artifact it claims to be.

---

## 26. Phase 3 of the 4-Phase Remediation Plan: Frontend "Truth" Wiring + Phase 4C — 2026-08-10

Direct continuation of the same remediation plan Section 24 (Phase 1) and Section 25.2 (Phase 2,
verified after the fact) cover. Section 25.3 found Phase 3 completely untouched - 15/20 tabs still
carrying fabricated content, tally unchanged from Section 19.5. This pass changes that count for
the first time since Section 19.0. Every claim below was checked against the actual diff, an actual
test run, or an actual `tsc`/`vite build`, matching this document's own standing method.

### 26.1 Task 3B: real RSI + real inter-agent correlation, replacing two fabricated widgets

- **`StrategyScanner.tsx` used to fabricate its input data, then run real math on it.** The old
  `getMockPrices()` generated a 40-bar series per symbol from a `charCodeAt()`-seeded formula, fed
  into a real Wilder's-RSI implementation (`calculateWildersRSI()`) - a mathematically correct
  signal computed on fictional prices. New `GET /api/v2/strategy/rsi-scan`
  (`src/server/routes/v2System.ts`) computes the same RSI math server-side
  (`src/server/engines/RSIEngine.ts`, the identical engine `BacktestEngine.ts` already uses) over
  real cached OHLCV bars (`HistoricalDataGateway`). A symbol with fewer than 20 real daily bars, or
  `BTC` (Alpaca's equities-bars endpoint does not serve crypto and no real crypto data source is
  wired into Argus), reports `dataAvailable:false` with the real reason - never a fabricated
  number. `StrategyScanner.tsx` now fetches this endpoint on a 60s poll and renders the shared
  `AwaitingSignal` component (new, `src/components/shared/AwaitingSignal.tsx`, Task 3D) for the
  unavailable case instead of silently showing a zero.
- **`StrategySynergyMatrix.tsx` used to correlate agents that do not exist.** The old
  `getCorrelation()` produced a 6x6 matrix for invented names - "Macro, News, Tech, Sentiment,
  Event, Geopol" - via a deterministic index-seeded formula with three hardcoded special-case
  values (Macro/Geopol=0.85, etc.). None of these names correspond to any real agent this codebase
  runs. New `src/server/services/AgentSynergy.ts` computes a real Pearson correlation
  (`pearsonCorrelation()`, general-purpose - distinct from `PositionSizing.ts`'s `returnCorrelation`,
  which is specifically for period-over-period price returns, not raw signal levels) between the
  five real agents (`TechnicalAgent`, `NewsAgent`, `FundamentalAgent`, `MacroAgent`,
  `KronosForecastAgent`), aligning each pair's real `agent_predictions` rows by `(symbol, day)` and
  averaging same-day duplicates. A pair with fewer than 5 overlapping days reports `null` - never a
  fabricated coefficient from thin data. New `GET /api/v2/strategy/agent-synergy` reads the last 30
  days of real predictions and calls this function; `StrategySynergyMatrix.tsx` now fetches it on a
  60s poll and renders `AwaitingSignal` (compact, per-cell) for `null` pairs.
- **Tests, real not aspirational:** `AgentSynergy.test.ts` (12 tests - correlation math, the
  `minOverlappingDays` floor, averaging duplicate same-day predictions, ignoring non-real agent
  names) and `v2System.strategy.test.ts` (6 tests - a real isolated-DB supertest integration
  seeding real `ohlcv_bars`/`agent_predictions` rows directly and asserting the actual HTTP
  responses, including the BTC-unavailable and insufficient-bars cases).

### 26.2 Task 3C: "Execute Override" now reaches the real broker, through the real gate ladder

This was the most dangerous of the fabricated widgets, and the only one explicitly named in the
remediation plan as requiring architectural care rather than a data-fetch swap. The old button
(`src/App.tsx`, Advanced Trade Sandbox) built a fake `Trade` object entirely client-side from
whatever quantity the user typed and a hardcoded per-symbol price ternary, pushed it into local
React state, and never touched the backend at all - "execution" was 100% cosmetic.

The fix deliberately does **not** call `OrderManagementService` or `BrokerManager` directly - that
would recreate the exact "raw path around a safety gate" bug class this document has already found
and fixed twice (Sections 16, 22.3). Instead, new `POST /api/v2/trading/execute-override`
(`v2System.ts`):

1. Reads a real live price from `marketDataWorker.getLatestPrice(symbol)` - refuses with a 422 and
   an honest reason if no real tick has arrived for that symbol yet, rather than fabricating one.
2. Mints a real `transactions`/`consensus_decisions`/`consensus_evidence` row via the existing
   `recordConsensusTransaction()` (`TransactionRegistry.ts`, previously only called by
   ChiefTraderAgent), honestly tagged `agent: 'ManualOverride'`, `debateUsed: false` - visible and
   truthful in the Transaction Observatory, never disguised as an AI agent's signal.
3. Emits a real `CHIEF_APPROVED_IDEA` event - the exact same event `RiskAgent` already listens for
   after ChiefTraderAgent's own consensus approval. This is the actual mechanism by which the
   override still passes through every real `RiskEngine` gate (emergency stop, daily-loss/
   consecutive-loss/portfolio-drawdown circuit breakers, order-rate limit, market-hours, stale-data,
   news-veto, and the real ATR/correlation-aware position sizing from `PositionSizing.ts`) and the
   real `OrderManagementService` → broker call. Only ChiefTraderAgent's AI-consensus step is
   skipped, which is the entire, stated point of an operator override - RiskEngine is never
   bypassed.

The actual approved quantity is whatever RiskEngine's real sizing computes, not the number the user
typed - the sandbox's quantity field is now explicitly labeled "target/estimate" and no longer sent
to the backend at all. The frontend subscribes to the real `RISK_ASSESSMENT_COMPLETED` and
`ORDER_EXECUTED` WebSocket broadcasts (the same wildcard-broadcast mechanism every other real trade
already uses) to show live approval/rejection/fill status instead of assuming success.

**Verification, not narration:** `v2System.override.test.ts` (3 tests, real isolated-DB supertest
integration) confirms this end-to-end - the request handler's `CHIEF_APPROVED_IDEA` emission is
picked up by the *actual* `RiskAgent` singleton (imported transitively via `SystemBootstrap`,
already listening in-process, not mocked), which calls the *actual* `RiskEngine.evaluateRisk()`
against the default `InternalPaperBroker` portfolio, and a real `risk_assessments` row appears with
the matching `traceId`/`transactionId`. This is the strongest evidence in this document that a
"wire it to the real pipeline" claim is actually true, because the test does not mock the pipeline
it is claiming to exercise.

### 26.3 Task 3D: shared `AwaitingSignal` component

`src/components/shared/AwaitingSignal.tsx` - one honest empty-state (`compact` and full variants)
for "this is real, and real data for this specific cell/row genuinely doesn't exist yet," used by
both rewritten widgets above and by the rewritten Observability tab below. Not a new abstraction
invented for its own sake - three separate call sites needed the exact same shape immediately.

### 26.4 Task 3A (partial, by design - not all 15 tabs): Observability & Trade Tracing tab

The `audit` tab ("Observability & Trade Tracing") was, before this pass, the single most
fabricated view in the app: a hardcoded trace ID (`TRD-20260711-000145`), a static 8-step timeline
with fixed made-up latencies, an entirely invented "ChatGPT / Claude / Gemini LLM Council" debate
transcript (these are not names of any real agent or the real multi-provider debate this codebase
actually runs), fabricated news-pipeline percentages, and fabricated risk/execution numbers - none
of it backed by any real event, ever, regardless of what actually happened in the system.

The real equivalent already existed and was already real - `TransactionObservatory.tsx`, which
reads `GET /api/v2/transactions/:id` and assembles genuine consensus evidence, real risk-gate
results, and real fills - but it was only reachable from a trade-blotter "Replay" button, never
from this tab, exactly the "redirect to the real thing" fix flagged as the easiest one available.
The `audit` tab now fetches `GET /api/v2/transactions` (already real, pre-existing, Transaction
Observatory Phase 5) and renders a real list; clicking any row opens the *same*
`TransactionObservatory` modal already wired for replay elsewhere via the existing
`selectedReplayTrade`/`replayModalOpen` state - no new component, no new data path, just the
missing connection between a real capability and this tab.

**This is one tab out of the fifteen Section 25.3 counted as fabricated, not fifteen.** The
`scanner` tab also flips to fully real as a direct consequence of 26.1 (`StrategyScanner.tsx` is
its entire content, confirmed by reading the tab's JSX - no other fabricated sibling element sits
next to it). **Updated tally: 7/20 tabs fully real** (adds Observability/Audit and Scanner to
Section 25.3's five - Observatory, Activity Log, Agent Evaluation, Kronos Model, News Intel) **and
13/20 tabs still contain at least one fabricated element**, down from 15/20. Explicitly still
fabricated and **not touched this pass**, in the remediation plan's own stated priority order:
Trading Arena's remaining ~8 sub-widgets (the Synergy Matrix and Execute Override, both inside the
`arena` tab, are now real, but Mission Control's Granular Module Toggles, `arena`'s other mock
panels, Holdings & Positions' Stress Testing panel, Agent Network's Performance Threshold Alert
banner, VEC Event Memory's `VectorClusteringMap`, Settings & Keys' Token Consumption panel, and the
Learning/Opportunity/Validation/Deployment tabs are unchanged and still fabricated). Attempting all
of these in one pass was judged a worse tradeoff than finishing the two highest-severity items
(3C's execution-safety risk, and the "easiest fix" tab) correctly, tested, and documented.

### 26.5 Phase 4C: raw-write scanner (new since Section 25, which only covered 4A/4B)

`scripts/scan_unallowlisted_writes.ts` - a real line-scanner over every Express route file
(`src/server/routes/*.ts` + `server.ts`) for the exact bug pattern this document has found and
fixed twice in different routes (Sections 16, 22.3): a raw, unvalidated `req.body` (or a spread of
it) written directly into a Drizzle `.values()`/`.set()` call or `Object.assign()`, bypassing
whatever field allowlist the route is supposed to enforce. Two real bugs were found and fixed in
the scanner itself while building it against the actual codebase: it initially flagged a *code
comment* that merely documented a past bug for posterity as if it were live code (fixed by
excluding comment lines before pattern-matching), and it initially double-counted a single real
match once per overlapping sliding-window position (fixed by anchoring each pattern to the exact
line a call syntactically starts on). `npm run security:scan-writes` (new script) currently reports
clean against the real, current codebase - 11 tests (`scan_unallowlisted_writes.test.ts`) encode
the two real historical bug patterns plus both fixed patterns as regression fixtures, so a
reintroduced instance of either bug class would be caught in CI, not just by manual audit.

Phase 4A (vitest DB isolation) and 4B (Playwright E2E scaffolding) are unchanged from Section 25 -
this pass did not re-attempt live execution of `e2e/moduleToggleParity.spec.ts`, so Section 25.5's
finding ("real code, verified BROKEN by actually running it") stands exactly as documented. Item 7
of Section 25.7's punch list (fix the E2E blocker before treating Phase 4B as closed) remains open.

### 26.6 Files, tests, verification

New: `src/server/services/AgentSynergy.ts` (+test), `src/components/shared/AwaitingSignal.tsx`,
`src/server/routes/v2System.strategy.test.ts`, `src/server/routes/v2System.override.test.ts`,
`scripts/scan_unallowlisted_writes.ts` (+test, Section 26.5). Modified: `StrategyScanner.tsx`,
`StrategySynergyMatrix.tsx`, `src/server/routes/v2System.ts` (+3 routes), `src/App.tsx` (audit tab
rewrite + Execute Override wiring). `npx tsc --noEmit`: clean. `npm run build`: clean (Vite SPA +
esbuild server bundle, no new warnings beyond the pre-existing >500kB chunk-size notice). Full
suite: **305/305 passing, 41 files** (up from 284/38 at the end of Section 25's Phase 4 baseline;
+21 tests / +3 files, matching exactly the three new test files above). Re-ran the full suite twice
consecutively after the last change to confirm no flakiness beyond one self-identified timing issue
(`v2System.override.test.ts`'s async risk-evaluation wait was widened from 200ms to 1000ms after it
flaked once under full-suite load, not in isolation - fixed and re-verified stable, not just
increased and hoped).

### 26.7 What this does and does not change about the standing verdict

**Two tabs and one dangerous button are now real. Thirteen tabs still are not. The trading-edge
question is completely untouched.** Nothing in this section produces or references a single new
backtest run, paper-trading sample, or live-observed consensus decision. Section 15.18's -0.315
Sharpe finding for NewsAgent, and the document's standing "no statistically validated trading edge
exists anywhere in this codebase" conclusion, are exactly as true after this section as before it.
UX moves off Section 25.6's 4/10 floor only slightly - two tabs and one execution path are
trustworthy now where they were theater before, which is real, but 13/20 tabs remain
indistinguishable-by-looking fabrications, so continue to withhold trust from the frontend for any
user without this document in hand. **DO NOT SHIP for live capital, unchanged.**

---

## 27. Hardening Pass (Phases 1-11) + Additive Quant Decision Layer — 2026-08-12

Two large, separate pieces of work landed since Section 26, neither of which this document
previously mentioned at all. Both have their own dedicated, detailed documents - this section is a
pointer and a standing-verdict check, not a duplicate of either.

### 27.1 Principal-Engineer hardening pass (Phases 1-11)

A full P0→P3 hardening pass closed 10 real, demonstrated gaps in the safety-critical decision path:
RiskEngine concurrency (two real TOCTOU races - order-rate-limit count-then-insert, peak-equity
read-then-write - closed with a promise-chain mutex, proven by a real accumulating-mock race test);
order lifecycle (orders left non-terminal after the initial poll were abandoned forever; partial
fills were never aggregated; no cancellation path existed - closed with a bounded follow-up job,
real incremental fill aggregation, and a real `cancelOrder()`); duplicate-order idempotency (a
check-then-act race closed with a real DB unique constraint, verified against a copy of the actual
production `data/argus.db` before being trusted); the daily-loss circuit breaker's UTC-vs-exchange
timezone boundary (was resetting up to several hours before the real NYSE session actually ended);
market-data duplicate-tick/reconnect-gap handling; AI output validation (closed a **real, confirmed
bug**, not just a missing safeguard: `NewsEngine.ts`'s `tradingBias === 'BULLISH' ? 'BUY' : 'SELL'`
meant any off-schema AI value silently became a SELL signal regardless of the model's actual
sentiment); three AI providers silently ignoring per-agent model overrides; AI response caching
that was gating the raw data fetch but not the downstream paid LLM call; a secret-leak vector in
caught fetch-error logs; WebSocket reconnect backfill; and a portfolio-reconciliation re-entrancy
guard. Full detail, before/after test counts, and file-by-file changes: `ARGUS_HARDENING_CHANGELOG.md`.
Consolidated verification: `ARGUS_HARDENING_VERIFICATION.md`. Fresh 20-tab frontend re-scan (found
several **previously undocumented, real BROKEN paths** - not just fabricated data: Holdings tab's
Emergency Liquidation/Rebalance buttons call routes that don't exist and 404 on click; Settings'
entire Secrets Manager UI calls three routes that were never wired to Express despite the real
backend logic existing; the legacy `/api/v1/signals` endpoint is now a deprecation stub, silently
breaking Trading Arena's Swarm Decision Outcomes panel, which this document had rated real):
`FRONTEND_REALITY_MATRIX.md`. Fresh full-application verdict, with an explicit Technical Readiness
vs. Trading-Edge Readiness split: `FINAL_APPLICATION_STATE_ANALYSIS_V2.md` - supersedes
`FINAL_APPLICATION_STATE_ANALYSIS.md` for every claim the two disagree on.

Every phase in that pass was implemented, tested (its own dedicated tests run immediately, then
the full suite), and documented before the next one began - the same before/after discipline this
document's own Sections 16-26 already established, just applied by a different work stream.

### 27.2 Additive quant decision layer (`src/server/quant/`, `QuantSignalAgent.ts`)

A second, unrelated work stream (a concurrent process, then continued and completed directly under
this document's own engagement) built a deterministic technical/regime/strategy/scoring engine,
entirely additive on top of every existing calculation engine (`RSIEngine`/`MACDEngine`/
`TechnicalIndicators`/`PositionSizing`/`BacktestEngine` are reused, never duplicated or replaced).
**Off by default** (`QUANT_ENGINE_ENABLED=true`) - zero behavior change for anyone who hasn't opted
in. Full architecture analysis, gap audit against the original 10-phase request, and file-by-file
plan: `QUANT_LAYER_ANALYSIS.md`.

What exists, real and tested (120+ dedicated tests across the module): real multi-signal market-
regime classification (`RegimeEngine.ts` - never a single indicator, never an LLM guess); real
SPY/QQQ/IWM/sector relative-strength context (`MarketContext.ts`, honestly reports `breadth:
{available:false}` since no real market-breadth data source exists in this codebase); 5 real
strategies with explicit entry/confirmation/invalidation/stop/target logic (`strategies/` - the one
real gap found in the pre-existing work, zero test coverage, was closed with 41 new tests across
all 5 strategies + the engine itself); a real "probabilistic decision layer" that explicitly
avoids the vote-counting trap this document has flagged elsewhere - RSI/Stochastic RSI/CCI/
Williams %R are blended into one reading, not counted as four independent signals
(`scoring/GroupedScores.ts`); real risk/reward, expected-value, and fractional-Kelly math that
refuses below 20 real closed trades and hard-caps its own suggested size at 10% of capital
regardless of what the raw formula computes (`risk/ExpectedValue.ts` - never wired into live
sizing with a guessed win rate, only ever fed a real backtest's own realized numbers); one real AI
integration point for qualitative contradiction/scenario review that can record a disagreement but
can never overwrite the deterministic side/confidence (`ai/QuantContradictionAnalyzer.ts`); a real
per-strategy, per-regime backtest entry point (`BacktestEngine.runStrategyBacktest()` - verified
against real historical Alpaca data for AAPL during this pass, producing a real mixed win/loss
sample and a real, non-fabricated EV/Kelly readout from it); and real observability (`GET /api/v2/
quant/strategies`, `GET /api/v2/quant/assessments/:symbol`, `GET|POST /api/v2/quant/
strategy-backtests` + the Scanner tab's new "Quant Decision Layer" panel) - previously this entire
subsystem had no route or UI reading its own persisted output at all.

`ChiefTraderAgent` already had a reserved weight for `agent:'QuantEngine'` before any of this
session's own work touched it - the new agent slots into the exact same `TRADE_IDEA_GENERATED`
contract every other agent uses, with an additive `quantDetail`/`supportingQuantDetail` field
(selected strategy, regime, setup scores, contradictions, invalidation conditions, proposed
entry/stop/target, expected holding period, AI review) that no existing consumer is required to
read. `RiskEngine` is never bypassed by any of it.

### 27.3 What this section does and does not change about the standing verdict

**Neither work stream touches the trading-edge question.** The hardening pass makes the existing
pipeline more correct under concurrency, reconnects, and malformed AI output; the quant layer adds
a more explainable, correlation-aware scoring framework and closes real bugs (the tradingBias
mis-mapping chief among them) - neither one is evidence that any strategy, old or new, has a real
statistical edge on real markets. The one real backtest run during this pass (`TREND_FOLLOWING` on
AAPL, 2023-2024) produced exactly 3 closed trades - an honestly-flagged `insufficientSampleSize`
result, not a track record. Section 15.18's -0.315 Sharpe finding for NewsAgent and this document's
standing "no statistically validated trading edge exists anywhere in this codebase" conclusion are
exactly as true after this section as before it. The fresh frontend re-scan in 27.1 found the
fabricated-widget count roughly unchanged in aggregate (some tabs fixed since Section 26, a
comparable number of newly-confirmed BROKEN paths found) - continue to withhold trust from the
frontend for any user without a current audit document in hand. **DO NOT SHIP for live capital,
unchanged.**

---

## 28. Backtest/Quant Hardening (E1-E7) — 2026-08-12

A follow-up engagement, arriving as a full external audit re-review (real Alpaca-data backtests,
2018-2025, independently reporting 165 trades/50.9% win rate for the baseline strategy - matching
this document's own Section 15.18-era numbers almost exactly) plus an 18-phase remediation
request. Full architecture findings, dependency map, and the re-scoped 7-item implementation plan
this section summarizes: `BACKTEST_QUANT_HARDENING_ANALYSIS.md`.

**Key finding before any code was written**: several of the 18 requested phases were already real
and complete, built earlier in this same engagement as the "additive quant decision layer"
(Section 27.2) - per-strategy backtesting, regime-segmented results, correlation-aware scoring,
real EV/Kelly, and a structured Chief Trader input package all already existed. A second,
mid-implementation discovery: `WalkForwardValidator.ts` (a real rolling train/test splitter with
its own route, `POST /api/v1/backtest/walk-forward`) already existed too but had never been given
a test file - this session's own earlier deep-repository read had missed it. This cut the real new
work from 18 phases down to 7 (E1-E7).

### 28.1 What was built (E1-E7)

- **E1 - Baseline reproduction**: `scripts/runBaseline.ts` (new, reusable), real Alpaca data,
  SPY+QQQ+MSFT+AMD, 2018-2025, $100k. Portfolio-level `BacktestEngine.run()`: +14.91% total return,
  50.9% win rate, 165 closed trades, Sharpe 0.51, max drawdown 3.54% - independently matches the
  external audit's own cited numbers almost exactly. Per-strategy/per-symbol
  `runStrategyBacktest()` results for all 5 quant strategies × 4 symbols in `BASELINE_RESULTS.json`.
- **E2A - Exit-threshold parity (real bug fix)**: live `PortfolioMonitor.ts` had hardcoded, unrelated
  +5%/-3% exit thresholds; `BacktestEngine.run()` separately hardcoded -5%/+15%; `settings.
  takeProfitPct`/`trailingStopPct` (schema defaults 15/5, matching the backtest's own numbers)
  existed but were read by neither. Both now read the same settings row - closes a real,
  previously-undocumented live/backtest behavioral mismatch, not just a coincidental one.
- **E2B - Selectable position-sizing mode**: `PositionSizing.ts` gained an optional
  `PERCENT_OF_EQUITY` mode alongside the existing flat-dollar `FIXED_DOLLAR` cap (still the
  default - zero behavior change unless explicitly opted into via `settings.positionSizingMode`).
  Every existing risk/concentration/correlation cap still applies unchanged under either mode.
- **E3 - Backtest-time decision-trace logging**: new, opt-in (`verboseLogging`)
  `quant_backtest_decision_log` table + `GET /api/v2/quant/strategy-backtests/:id/decision-log` -
  records conditions met/failed, contradictions, regime, and sizing detail for every real BUY
  candidate a `runStrategyBacktest()` run evaluates, not just the ones that became trades.
- **E4 - Failure classification**: `quant/analysis/FailureClassification.ts` - real, derivable-only
  categories (BAD_REGIME, SIGNAL_CONFLICT, STOP_LOSS_HIT, SLIPPAGE_DRAG, UNKNOWN) computed inline
  at every losing SELL from data this backtest engine actually has. Explicitly does NOT implement
  categories that would require live AI/news/RiskEngine involvement this backtest never runs
  (NEWS_REVERSAL, AI_ERROR, RISK_ERROR, EXECUTION_ERROR, and 7 others) - documented as honestly
  unimplemented rather than faked.
- **E5 - Walk-forward for quant strategies**: `WalkForwardValidator.ts` extended with an optional
  `strategyId`+`symbol` mode running `runStrategyBacktest()` per window instead of only the
  original `run()`. First-ever test file for this module surfaced a real latent gap: `testDays`
  must exceed the underlying backtest's own minimum-bar requirement or every window throws -
  documented, not silently patched around.
- **E6 - Monte Carlo (explicitly scenario analysis, never a prediction)**:
  `quant/analysis/MonteCarlo.ts` - seeded, deterministic bootstrap resampling over a real
  backtest's own closed-trade R-multiples. Refuses to claim statistical justification below the
  same 20-trade threshold `ExpectedValue.ts`'s Kelly already uses.
  `POST /api/v2/quant/strategy-backtests/:id/monte-carlo`.
- **E7 - Benchmark comparison + small-account report**: real buy-and-hold comparison (traded
  symbol and SPY, computed from bars the run already loaded, never a second fetch) persisted per
  strategy-backtest run; `quant/analysis/AccountSizeReport.ts` reports real whole-share
  capital-utilization across $100-$100k account sizes, honestly refusing ("TRADE NOT POSSIBLE -
  WHOLE SHARE CONSTRAINT") when even one share isn't affordable - no fractional-share simulation,
  since no broker adapter in this codebase supports one.

### 28.2 The real out-of-sample check this session ran on its own best-looking numbers

The E1 baseline's two highest-Sharpe results (MOMENTUM_BREAKOUT/MSFT, Sharpe 1.99;
MOMENTUM_BREAKOUT/AMD, Sharpe 2.59) were walk-forward validated using the newly-extended E5 tooling
(`scripts/runWalkForwardCheck.ts`, `trainDays=365`/`testDays=120`, real data, 21 periods each):

| Combination | Avg in-sample return | Avg out-of-sample return | % OOS periods positive |
|---|---|---|---|
| MOMENTUM_BREAKOUT / MSFT | +0.37% | **+0.04%** | 42.9% |
| MOMENTUM_BREAKOUT / AMD | +1.36% | **+0.28%** | 66.7% |

Both real out-of-sample returns collapse to a small fraction of their in-sample counterparts
(MSFT: ~89% of the apparent edge disappears out-of-sample; AMD: ~79%), and MSFT's out-of-sample
periods were profitable less than half the time. This is the textbook in-sample-overfitting
signature the original audit explicitly warned against - produced here by this session checking
its own most attractive-looking numbers with tooling built in this same pass, not by an external
reviewer catching it after the fact.

### 28.3 Files, tests, verification

New: `quant/analysis/{FailureClassification,MonteCarlo,AccountSizeReport}.ts` (+tests),
`scripts/{runBaseline,runWalkForwardCheck}.ts`, `WalkForwardValidator.test.ts`,
`PortfolioMonitor.test.ts`, `BacktestEngine.exitThresholds.test.ts`. Modified:
`PortfolioMonitor.ts`, `BacktestEngine.ts`, `PositionSizing.ts`, `RiskEngine.ts`,
`WalkForwardValidator.ts`, `configRoutes.ts`, `systemRoutes.ts`, `v2System.ts`, `schema.ts` (+3
migrations, `drizzle/0021`-`0023`). `npx tsc --noEmit`: clean. `npm run build`: clean. `npm run
security:scan-writes`: clean. Full suite: **94 test files / 667 tests passing**, run twice
consecutively (one earlier run hit transient `beforeAll` hook timeouts under full-suite system
load - resolved on immediate re-run with no code change, the same class of flake this document's
Section 26.6 already encountered and documented once before).

### 28.4 What this does and does not change about the standing verdict

**Every fix in E2A/E2B is a correctness/consistency fix, not evidence of an edge - and Section
28.2's own walk-forward check is direct evidence AGAINST treating this session's best-looking E1
numbers as one.** Per the original audit's own explicit instruction ("Never optimize specifically
to make historical returns look good," "Do NOT claim a strategy is profitable without actual
backtest results"), no claim of a validated trading edge is made anywhere in this section. Section
15.18's -0.315 Sharpe finding for NewsAgent and this document's standing "no statistically
validated trading edge exists anywhere in this codebase" conclusion are exactly as true after this
section as before it. **DO NOT SHIP for live capital, unchanged.**

---

## 29. Comprehensive Current Application State (Consolidated Snapshot) — 2026-08-12

Sections 1-28 above are a chronological record - each one accurate as of its own date, several
superseding earlier claims about the same widget or capability. This section is different in kind:
a single, consolidated snapshot of **where the application actually stands right now**, pulling
together the current-truth claims from every prior section and the three dedicated audit documents
this repository maintains (`FINAL_APPLICATION_STATE_ANALYSIS_V2.md`, `FRONTEND_REALITY_MATRIX.md`,
`BACKTEST_QUANT_HARDENING_ANALYSIS.md`), re-verified against real output from this session
(`npx tsc --noEmit`, `npx vitest run`, `npm run build`, `npm run security:scan-writes`), not copied
from any document's own claim about itself. Where a claim below conflicts with an earlier numbered
section, this section wins - it is the newest.

### 29.1 Architecture, in one paragraph

Single Node process (`server.ts`, ~3050 lines) running Express + Vite (dev) / static serving
(prod) + a raw `ws` WebSocket server, alongside a single-file ~11K-line React SPA (`src/App.tsx`).
Two structurally separate execution paths exist and share no state: the **real EventBus-driven
agent pipeline** (TechnicalAgent/NewsEngine/FundamentalAgent/MacroAgent/PortfolioMonitor/
QuantSignalAgent → ChiefTraderAgent consensus → RiskEngine's gate ladder → OrderManagementService →
a real broker, writing to SQLite's `trades` table), and the **legacy `/api/v1/signals` endpoint**,
now a deprecated stub that fabricates a fixed `{decision:"HOLD"}` response regardless of input,
still called by one frontend widget (Trading Arena's "Swarm Decision Outcomes," confirmed BROKEN,
§29.3). `better-sqlite3` + Drizzle ORM, WAL mode, 30 tables as of this session (27 base + the 3
added this session: `quant_strategy_backtests`, `quant_backtest_decision_log`, plus new columns on
`quant_assessments`/`quant_strategy_backtests`/`settings`).

### 29.2 Safety-critical decision path — real, tested, hardened across two separate hardening passes

The order-placing pipeline (RiskEngine's 11 always-evaluated gates, real ATR-based position
sizing, real circuit breakers, order idempotency, broker execution, reconciliation) has now been
through two independent hardening passes with zero regressions across either:

| Pass | What it closed | Verification |
|---|---|---|
| Phases 1-11 (this doc's §27.1, full detail `ARGUS_HARDENING_CHANGELOG.md`) | RiskEngine TOCTOU races (order-rate-limit, peak-equity), order-lifecycle gaps (abandoned orders, unaggregated partial fills, no cancellation), duplicate-order race (closed with a real DB unique constraint), daily-loss UTC-vs-exchange timezone bug, a **confirmed live bug** where any off-schema AI value silently became a SELL order regardless of the model's real output, 3 AI providers ignoring per-agent model overrides, AI caching not gating the paid LLM call, a secret-leak vector, WS reconnect data loss, portfolio-reconciliation re-entrancy | 50→77 test files, 326→534 tests, all passing at every checkpoint (`FINAL_APPLICATION_STATE_ANALYSIS_V2.md` §1-2) |
| E1-E7 (this doc's §28, full detail `BACKTEST_QUANT_HARDENING_ANALYSIS.md`) | Live/backtest exit-threshold mismatch (`PortfolioMonitor` vs `BacktestEngine.run()`), inflexible fixed-dollar-only position sizing, no backtest-time decision tracing, no failure classification, `WalkForwardValidator` had zero test coverage (and a real latent gap was found and documented once tested) | 88→94 test files, 629→667 tests, all passing (this session) |

**Neither pass touched `RiskEngine.ts`'s gate ladder, `BrokerManager.ts`, or `ChiefTraderAgent.ts`'s
consensus math** - both were additive/corrective around the edges of a decision path that itself
remains structurally unchanged and unregressed since it was last hardened.

### 29.3 Frontend reality — 20 tabs, re-scanned against current backend, not re-scanned this session

`FRONTEND_REALITY_MATRIX.md` (produced during the Phases 1-11 pass, §27.1) is the current
source of truth **except where Section 31 (2026-08-15) names a specific widget**. No frontend
code was touched during E1-E7, so its tallies stood as recorded then; Section 31 updates Agent
Network win-rate/latency/weights, Documentation copy, tab order/sticky chrome, and Kronos
unavailable/polling only. Other widgets keep the matrix below.

- **Fully real (zero fabrication or breakage), 7/20**: `observatory`, `scanner` (Strategy Scanner),
  `opportunities`, `news`, `activity`, `audit`, `evaluation`.
- **Contains at least one MOCKED widget, 10/20**: `dashboard`, `command`, `arena`, `agents`,
  `intelligence`, `learning`, `memory`, `validation`, `deployment`, `settings`.
- **Contains at least one BROKEN widget (404 route or a field that can never populate), 9/20**:
  `dashboard`, `command`, `portfolio`, `agents`, `memory`, `validation`, `kronos`, `settings`,
  `arena` (overlaps with the MOCKED list above).
- **Not scored**: `documentation` (static content by design).

The genuinely new, worse-than-mocked findings from that pass, still open and unfixed: Portfolio's
Emergency Liquidation/Rebalance All buttons 404 (routes don't exist); Settings' entire Secrets
Manager UI calls three routes that were never wired to Express despite real backend logic existing
to support them; Trading Arena's Swarm Decision Outcomes panel is now silently broken by the
`/api/v1/signals` deprecation stub; a real, tested `cancelOrder()` backend capability
(hardening-pass Phase 2) has no frontend button anywhere calling it; `SystemOptimizer.tsx`'s
"Concurrency & Pool Optimizer" widget still uses the exact fake-`Date.now()%1000` RNG idiom that
was fixed in its own sibling component in the same `validation` tab; Kronos' GPU/Memory/Inference
tiles were constructor `'0%'`/`'0 MB'` and never updated — **partially superseded 2026-08-15
(Section 31.4): those fields are now null/em dash, not fake zeros; they are still not live
process metrics.**

### 29.4 Additive quant/backtest layer — real, tested, off by default, now with real research tooling

`src/server/quant/` + `QuantSignalAgent.ts` (§27.2) + this session's E1-E7 additions (§28) form a
second, entirely additive decision-support layer, gated behind `QUANT_ENGINE_ENABLED` (default
`false` - zero behavior change for anyone who hasn't opted in):

- Real multi-signal regime classification, market-context relative strength, 5 real strategies
  with explicit entry/invalidation logic, correlation-aware scoring (never vote-counting),
  backtest-derived EV/Kelly (refuses below 20 real trades), one AI integration point that can
  record disagreement but never overwrite a deterministic value.
- **New this session**: selectable position-sizing mode (`FIXED_DOLLAR`/`PERCENT_OF_EQUITY`,
  default unchanged), settings-driven exit thresholds (closing a real live/backtest mismatch),
  opt-in per-candidate decision-trace logging, real failure classification on losing trades (only
  categories genuinely derivable from this engine's own data - 11 requested categories explicitly
  left unimplemented rather than faked), walk-forward validation extended to cover the quant
  strategies (previously `run()`-only), seeded/deterministic Monte Carlo scenario analysis (always
  labeled as such, never a prediction), real buy-and-hold benchmark comparison, and honest
  whole-share-only small-account capital reporting.
- **The one real out-of-sample check run on this layer's own best-looking numbers this session
  (§28.2) showed 79-89% of the apparent in-sample edge evaporating out-of-sample** - the strongest
  evidence in this document, produced by this codebase's own new tooling, against trusting any
  single-period backtest result from this or any other strategy in this codebase.

### 29.5 Test suite, build, and static checks — current, re-verified this session

- `npx tsc --noEmit`: **clean**.
- `npx vitest run`: **94 test files / 667 tests passing**, run three times consecutively this
  session (one run hit transient `beforeAll` hook timeouts under full-suite system load, resolved
  with no code change on immediate re-run - the same class of flake previously documented in
  §26.6; two subsequent full runs were clean).
- `npm run build`: clean (Vite SPA + esbuild server bundle, only the pre-existing >500kB
  chunk-size advisory, no new warnings).
- `npm run security:scan-writes`: clean (10 route files scanned, no raw `req.body` writes).
- `npx playwright test`: **not re-run this session** - §25.5/§25.7's standing finding (real code,
  confirmed broken by actually running it once, the fix never re-verified) is carried forward
  unchanged; do not assume this is fixed without re-running it.

### 29.6 Known broken/non-functional components — consolidated list, current

Pulled from `CLAUDE.md`'s own maintained list plus the frontend/backend audits above, deduplicated:

- Order Book (L2) depth heatmap — permanent, honest `NOT_IMPLEMENTED` (no L2 data source exists;
  not a bug).
- `AdvancedQuantEngines`/`MarketRegimeAgent` — real math/LLM, output never consumed by any
  decision (distinct from and unrelated to the newer `src/server/quant/` layer, which IS consumed).
- `archive/python-platform/` — disconnected, never imported by the running Node app.
- Portfolio tab's Emergency Liquidation / Rebalance All — **BROKEN**, real 404s.
- Settings tab's Secrets Manager UI — **BROKEN**, three unwired routes.
- Trading Arena's Swarm Decision Outcomes — **BROKEN**, silently regressed by a legacy-endpoint
  deprecation.
- Mission Control's Granular Module Toggles — **MOCKED**, HIGH RISK, a Change Plan was presented
  earlier in this repository's history and still awaits explicit approval before implementation.
- Trading Arena's broker-selector dropdown — **MOCKED**, still offers `Robinhood`/`Charles
  Schwab` (no adapter for either exists); the Settings tab's equivalent selector was already fixed,
  this one was not.
- `cancelOrder()` — real, tested backend capability with no frontend button calling it.
- Webhooks — real CRUD, but the actual trigger path (`triggerWebhooks()`) is never called by any
  real trading event; in-memory storage, lost on restart.
- Chaos Mode / Macro Shock Generator config — real and persistent, but never read by anything in
  the live pipeline.
- ~~`PortfolioMonitor` hardcoded exit thresholds~~ — **fixed this session** (§28, E2A).

### 29.7 Technical readiness vs. trading-edge readiness — the split every prior verdict has used, reaffirmed

These remain two separate questions, and every hardening/enhancement pass across this
repository's history - including both passes documented in this section - has only ever moved the
first one:

- **Technical readiness** (can the system execute a decision correctly and safely without
  corrupting its own state under concurrency, reconnects, malformed AI output, or inconsistent
  live/backtest assumptions): **materially improved, twice**, per §29.2. Real races, real gaps,
  and a real live/backtest mismatch were found, demonstrated, and closed with tests proving the
  fix - not just the absence of a symptom.
- **Trading-edge readiness** (does any agent, consensus mechanism, or quant strategy in this
  codebase produce decisions that are statistically better than chance, out-of-sample, on real
  data): **still not established anywhere in this codebase's history**, and this session's own new
  walk-forward tooling produced direct evidence AGAINST the two best-looking numbers this session's
  own baseline run produced (§28.2/§29.4). No walk-forward result, backtest result, or live
  paper-trading track record in this repository's entire documented history has shown a validated
  edge. This is the single most important caveat for anyone evaluating this system for real
  capital, and it has been true at every checkpoint this document has ever recorded.

### 29.8 Final Verdict, reaffirmed

**Classification: PAPER TRADING READY (technical). NOT LIVE TRADING READY. NOT PRODUCTION READY.**

This is an exact reaffirmation of `FINAL_APPLICATION_STATE_ANALYSIS_V2.md` §7's verdict - nothing
in E1-E7 or this consolidated snapshot changes it in either direction:

- The safety-critical path's real, tested protections (§29.2) remain intact and unregressed.
- It is not LIVE TRADING READY because: no validated trading edge exists anywhere (§29.7, freshly
  reaffirmed by this session's own walk-forward check); real BROKEN frontend paths exist that a
  live operator could click into (§29.3 - a 404'ing Emergency Liquidation button is a materially
  different risk live than in paper mode); Mission Control's Granular Module Toggles remain fake
  with a live-risk Change Plan still awaiting approval.
- It is not PRODUCTION READY because that would additionally require the §29.3/§29.6 broken paths
  fixed and the frontend fabrication inventory substantially reduced - neither was in scope for
  either hardening pass documented in this section.
- Honest degradation remains this system's own consistent, demonstrated design principle
  (`AwaitingSignal`, `DATA_UNAVAILABLE`, explicit `NOT_IMPLEMENTED` states, the quant layer's
  refusal to size below 20 real trades, this session's own refusal to fabricate 11 of 17 requested
  failure-classification categories) - a real, verifiable strength of this codebase's engineering
  culture, independent of and not a substitute for the readiness gaps above.

---

## 30. Deep Technical + Quantitative Autonomous Trading Readiness Audit — 2026-08-12

**Methodology.** This audit is read-only (no application/source/config/schema/production behavior
was modified - the only file changed to produce it is this one). It does not trust any prior
section's own claims about current state; every finding below was independently re-derived from
current source, either by direct file reads or by five parallel research passes that traced actual
call chains (event emitters → listeners → DB writes) rather than reading comments at face value.
Where a finding matches an earlier section, that is independent confirmation, not a copy. Per this
audit's own rules: nothing below is marked "production ready" merely because it has tests, nothing
is called an edge without out-of-sample evidence, and anything unverified is marked `UNVERIFIED`
rather than assumed to work.

### 30.1 Executive Summary

Argus's safety-critical order-placing path (RiskEngine's 11 gates, DB-enforced idempotency,
persisted kill switch) is structurally sound and cannot be bypassed by any code path traced in this
audit - that part of the "software readiness" story is real and well-evidenced. Everything around
that core is thinner than its own code comments claim: **portfolio reconciliation's documented
"pauses trading on a large mismatch" behavior does not actually reach the real risk gate** (verified
by tracing both sides of that claim to source, §30.12 - the single most important new finding in
this audit), the broker layer has no request timeout, retry, or crash-after-send recovery anywhere,
the AI layer has no call timeout or reproducibility control anywhere, and **no strategy in this
codebase - deterministic or AI-driven - has ever passed an out-of-sample validation check**. The one
walk-forward check ever run on this codebase's own best-looking backtest numbers (done this same
session, with tooling built this same session) showed the apparent edge collapsing by 79-89%
out-of-sample. Overall: **53% technically ready, 0% statistically validated, NOT READY for
autonomous real-money trading.**

### 30.2 Current Autonomous Trading Readiness %

```
AUTONOMOUS REAL-MONEY READINESS: 53%
```

Built from the weighted scorecard in §30.3, not invented. This number describes technical/
operational readiness only - see §30.1 and §30.17 for why it must never be read as a probability of
profitable trading.

### 30.3 Readiness Scorecard

| Category | Weight | Score | Evidence (see linked section) |
|---|---|---|---|
| Trading strategy correctness | 15% | 9/15 | §30.6, §30.7 - real, tested strategies, but a confirmed live exit-threshold bug existed until this session and two independently-written copies of "the same" deterministic strategy exist |
| Quantitative validation | 15% | 3/15 | §30.17, §30.18 - the only OOS check ever run failed; zero AI decision ever backtested |
| Risk management | 15% | 12/15 | §30.9 - 11 real, un-bypassable, fail-closed gates; 2 documented edge-case gaps (null-priceAge staleness, null-marketOpen) |
| Broker/order execution | 10% | 5/10 | §30.11 - real idempotency/partial-fills; no timeout, no retry, no crash reconciliation, cancel unreachable from UI |
| Market-data reliability | 10% | 6/10 | §30.13 - real reconnect/dedup/staleness; no rate-limit handling, outage doesn't cleanly fail closed |
| Portfolio/account reconciliation | 10% | 4/10 | §30.12 - real position reconciliation, but its own safety claim is false; cash/orders/fills unreconciled |
| AI/agent reliability | 10% | 5/10 | §30.8 - real failover/output-validation/contradiction-handling; no timeout, no hallucination check, no reproducibility, zero AIRouter tests |
| Backtesting/live parity | 5% | 3/5 | §30.14, §30.15 - real cost/sizing parity; AI layer has zero parity by definition (never backtested); exit-threshold parity only closed this session |
| Observability/monitoring | 5% | 3/5 | §30.22 - real Transaction Observatory; disconnect/mismatch events have no real alerting consumer |
| Fault tolerance/recovery | 3% | 1/3 | §30.20 - real re-entrancy guards; no order-level crash recovery, no AI circuit breaker, unbounded WS reconnect |
| Security/secrets | 2% | 2/2 | §30.21 - redaction, encryption, header-auth migration, allowlist-protected settings writes, all previously fixed and regression-tested |
| **Total** | **100%** | **53/100** | |

**How this was calculated**: each category was scored against the A-F classification in §30.4 -
code that exists but is unconnected, untested, or contradicted by its own behavior when traced was
capped low regardless of how complete it looks; categories with real, traced, tested, un-bypassable
mechanisms scored high. No category was scored from a comment's own claim about itself.

### 30.4 Code Completeness vs. Trading Readiness — the six-axis classification

Per this audit's own instruction, every component below is classified on six separate axes rather
than one blended "done/not done" label:

| Component | A. Code exists | B. Connected to live path | C. Automated tests | D. Backtest validated | E. Statistically validated | F. Could cause unintended real-money loss if it fails |
|---|---|---|---|---|---|---|
| RiskEngine gate ladder | Yes | Yes, un-bypassable (§30.9) | Yes, extensive | N/A (a gate, not a strategy) | N/A | Yes - the entire point of the component |
| PortfolioReconciliation | Yes | Yes, runs every 5 min | Partial (§30.12) | N/A | N/A | **Yes - its "pause trading" claim is false** |
| OrderManagement idempotency | Yes | Yes | Yes, real concurrent-race test | N/A | N/A | Low (this specific mechanism works) |
| OrderManagement timeout/crash-recovery | **No** | N/A | **No** | N/A | N/A | **Yes - unrecoverable stuck/duplicate risk under real network failure** |
| TechnicalAgent deterministic strategy | Yes | Yes | Yes | Yes (§30.16) | **No** (50.9% win rate, statistically indistinguishable from chance) | Yes, if trusted as an edge without caveat |
| QuantEngine (5 strategies) | Yes | Yes (`QUANT_ENGINE_ENABLED=true` in this repo's actual `.env` - see §30.7) | Yes, extensive | Yes (§30.17) | **No - the only OOS check run failed** | Yes, if trusted as an edge without caveat |
| ChiefTraderAgent consensus | Yes | Yes | Yes, extensive | No (never backtested) | N/A (a combiner, not a strategy) | Yes - determines every real approval |
| AI debate / NewsAgent / FundamentalAgent / MacroAgent | Yes | Yes | Yes at the parse-validation level; **no `AIRouter.test.ts` at all** | **No - zero AIRouter references in BacktestEngine** | **No** | Yes - can move consensus confidence with zero historical evidence behind it |
| WalkForwardValidator | Yes | N/A (research tool) | Yes (this session) | N/A | Produced the negative result in §30.17 | No (read-only research tool) |

The pattern across this table is the point of Rule 3/Rule 4 in this audit's own instructions:
**every row with real code, real connection, and real tests still fails column E (statistical
validation)** except the risk/execution mechanics, which were never claimed to provide an edge in
the first place.

### 30.5 Complete Live Trading Decision Path

Traced stage by stage, current source, this session:

| Stage | File:Function | Failure/timeout/retry/fallback behavior | Can generate an unintended order? | Tests |
|---|---|---|---|---|
| Market data ingest | `MarketDataWorker.ts` (WS handler) | Reconnect: fixed 5s retry forever, no backoff cap (§30.13 item 1). Dedup: real, exact (symbol,timestamp,price) match (§30.13 item 2). | No (data-only) | `MarketDataWorker.test.ts` covers dedup, not the reconnect timer itself |
| Signal generation | `TechnicalAgent.ts`, `NewsEngine.ts`, `FundamentalAgent.ts`, `MacroAgent.ts`, `PortfolioMonitor.ts`, `QuantSignalAgent.ts` | Each independently timer/event-driven; a hung AI call inside Fundamental/Macro stalls that tick indefinitely (no timeout anywhere in the AI stack, §30.8 item 2) | No directly - emits `TRADE_IDEA_GENERATED` only | Per-agent unit tests exist; no cross-agent integration test of a stuck-tick scenario |
| Consensus | `ChiefTraderAgent.ts` → `EvidenceAggregator.aggregate()` | Weighted vote, 0.5x disagreement penalty (§30.8 item 1). AI debate fire-and-forget with no timeout - a hung debate simply never resolves that one idea's evaluation, other ideas for the same symbol still evaluate independently | No directly - emits `CHIEF_APPROVED_IDEA` only | `EvidenceAggregator.test.ts`, `ChiefTraderAgent.test.ts` (AIRouter mocked - the real hang risk is untested) |
| Risk gate ladder | `RiskEngine.ts:evaluateRisk()` | 11 gates, first-failure-wins, **fails closed on internal exception** (`RiskEngine.ts:374-388`, verified: an uncaught error inside the try block sets `approved=false`, never defaults to approve) | No - only emits `RISK_ASSESSMENT_COMPLETED` with `approved`/`maxQuantity` | `RiskEngine.test.ts`, `RiskEngine.gates.test.ts`, `RiskEngine.concurrency.test.ts` - extensive |
| Position sizing | `PositionSizing.ts:calculatePositionSizing()` | Pure function, no I/O, no failure mode of its own | No - returns a quantity only | `PositionSizing.test.ts` - extensive, incl. E2B's new sizing mode |
| Order submission | `OrderManagement.ts` → `AlpacaBroker.placeOrder()` | **No timeout, no retry, no backoff (§30.11 items 1, 7)**. Real DB-unique-constraint idempotency (item 2). Any thrown error → `REJECTED` (indistinguishable from "never reached Alpaca") | **Yes - this is the one stage that actually calls the broker** | `OrderManagement.test.ts`, `OrderManagement.lifecycle.test.ts` - idempotency/partial-fill/cancel covered; timeout/crash/unknown-status NOT covered |
| Fill polling | `OrderManagement.ts:pollForFill()` / `followUpOpenOrders()` | 400ms/4s initial poll, 15s follow-up job from 6s-30min old, **then permanently abandoned at last-known status** (§30.11 item 3) | No | Follow-up give-up tested; the 30-min-abandonment's downstream consequence is not |
| Portfolio state | `PortfolioReconciliation.ts` | Real position sync every 5 min + on boot; **"pauses trading" claim does not reach the real gate (§30.12, CRITICAL)** | No (corrective, not order-generating) - but its broken pause claim means a real drift does NOT stop new orders as documented | Position-mismatch and re-entrancy tested; the pause-claim's actual (non-)effect is not |
| Persistence | `trades`, `fills`, `portfolio`, `reconciliation_events` tables | Real, direct SQLite writes via Drizzle | N/A | Covered incidentally by the above |
| Exit logic | `PortfolioMonitor.ts` (60s timer) | Now settings-driven (`settings.takeProfitPct`/`trailingStopPct`, fixed this session, §28 E2A) | Yes - emits its own `SELL` trade ideas, which flow through the same consensus→risk→order path above | `PortfolioMonitor.test.ts` (new this session) |
| Reconciliation | `PortfolioReconciliation.ts` (see above) | Same as portfolio state row | N/A | Same as above |

### 30.6 Strategy Inventory

| Strategy | Live? | Enabled? | Backtested? | OOS validated? | Statistical evidence? | Ready? |
|---|---|---|---|---|---|---|
| TechnicalAgent (deterministic RSI/MACD/SMA/Bollinger) | Yes | Always on | Yes (`BacktestEngine.run()`, §30.16) | **No** - never walk-forward tested at any point in this repository's history | 50.9% win rate, Sharpe 0.51 - statistically indistinguishable from a coin flip | **No** |
| QuantEngine: MOMENTUM_BREAKOUT | Yes (`QUANT_ENGINE_ENABLED=true` in this repo's real `.env`, see §30.7) | Yes | Yes | **Yes - and it failed** (§30.17: OOS return 11-21% of in-sample) | Negative/inconclusive | **No** |
| QuantEngine: PULLBACK_CONTINUATION | Yes | Yes | Yes | No | Positive but unvalidated | No |
| QuantEngine: MEAN_REVERSION | Yes | Yes | Yes | No | Mixed (AMD combo actually negative expectancy) | No |
| QuantEngine: TREND_FOLLOWING | Yes | Yes | Yes | No | Positive but unvalidated, low trade count (34-38 trades/symbol) | No |
| QuantEngine: RANGE_REVERSION | Yes | Yes | Yes | No | Positive but unvalidated | No |
| NewsAgent (sentiment-driven) | Yes | Always on | **No** | **No** | UNVALIDATED | No |
| FundamentalAgent | Yes | Always on (60s timer, 3 hardcoded symbols) | **No** | **No** | UNVALIDATED | No |
| MacroAgent | Yes | Always on (75s timer, 3 hardcoded symbols) | **No** | **No** | UNVALIDATED | No |
| ChiefTrader AI debate (adversarial mode) | Yes, conditional (confidence>0.6) | `settings.adversarialDebateMode`, default true | **No** | **No** | UNVALIDATED, plus a confirmed in-code confidence-scale bug (§30.8) | No |
| KronosForecastAgent (local Chronos forecasting) | Requires external `npm run ai:serve` process | Weight exists in `agentWeights` (0.20) | UNVERIFIED this audit - not traced this pass | UNVERIFIED | UNVALIDATED | UNVERIFIED |
| PortfolioMonitor (exit-only, not an entry strategy) | Yes | Always on | Implicitly via `BacktestEngine.run()`'s shared exit logic | No | N/A (position management, not signal generation) | Exit thresholds now settings-driven and correct (fixed this session), but the exit *rule itself* (fixed % TP/SL) has never been validated as optimal |

**Every strategy capable of influencing a real order today is unvalidated out-of-sample.** The only
row with a completed OOS check failed it.

### 30.7 QuantEngine Audit

- **Which strategies implemented**: 5 (`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`,
  `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`), each a pure `evaluate(ctx)` in
  `src/server/quant/strategies/`.
- **Which are enabled**: all 5, gated as a whole by `QUANT_ENGINE_ENABLED`. **This repository's
  actual `.env` (the one this running instance uses) has `QUANT_ENGINE_ENABLED=true`** — the
  documented `.env.example` default of `false` describes the safe out-of-the-box state, not this
  environment's current live configuration. This is a real, material distinction: QuantEngine is
  presently contributing live evidence to consensus in this environment.
- **Which are actually called**: `QuantSignalAgent.ts`, a 5-minute timer over real daily bars,
  calling `StrategyEngine.evaluateAll()` → the 5 strategies → `GroupedScores`/`ExpectedValue`/
  `QuantContradictionAnalyzer` → emits `TRADE_IDEA_GENERATED` as `agent:'QuantEngine'`, weight 0.15
  in `ChiefTraderAgent.agentWeights` (subject to real-time override from `agent_performance_stats`).
- **Influence on consensus**: same `EvidenceAggregator` weighted-vote path every other agent uses -
  no special-cased bypass.
- **Independently backtested**: yes, per-strategy/per-symbol via `BacktestEngine.runStrategyBacktest()`
  (this session's E1-E7 work, §28) - 20 real strategy×symbol combinations run against real 2018-2025
  Alpaca data.
- **Combined with TechnicalAgent**: no - they are structurally independent evidence sources feeding
  the same consensus vote, never merged into one calculation.
- **Duplicate indicators**: yes, a real, previously-documented risk (`CLAUDE.md`'s own notes) -
  `TechnicalIndicators.ts`, `quant/indicators/{trend,volatility}.ts`, the now-dead
  `AdvancedQuantEngines.ts`, and `BacktestEngine.run()`'s own inline SMA/RSI/MACD/Bollinger
  calculation are four independent implementations of overlapping math. Only the last one is a live
  risk (it's what live `TechnicalAgent`-equivalent backtesting exercises); the others are either
  reused correctly or confirmed dead code.

**Real backtest numbers** (this session, `BASELINE_RESULTS.json`, SPY/QQQ/MSFT/AMD, 2018-2025,
$100k initial cash, per strategy×symbol via `runStrategyBacktest()`):

| Strategy | Symbol | Trades | Win rate | Profit factor | Sharpe | Expectancy | Max DD | Kelly justified? |
|---|---|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | AMD | 636 | 60.1% | 4.09 | 2.59 | $51.21 | 0.37% | Yes, 8.26% suggested |
| MOMENTUM_BREAKOUT | MSFT | 740 | 60.3% | 2.60 | 1.99 | $15.72 | 0.28% | Yes, 8.44% suggested |
| RANGE_REVERSION | QQQ | 1324 | 50.3% | 2.17 | 2.22 | $6.72 | 0.13% | Yes, 7.23% suggested |
| MEAN_REVERSION | AMD | 44 | 40.9% | 0.89 | -0.06 | -$3.58 | 0.35% | **No - Kelly correctly refuses at 0%** |
| MOMENTUM_BREAKOUT | SPY | 16 | 25.0% | 1.48 | 0.12 | $3.89 | 0.03% | No (below 20-trade threshold) |

Full 20-combination table: `BASELINE_RESULTS.json`. **OOS performance** on the two best-looking
rows: §30.17 (both collapse). **Regime performance**: computed per-run via `computeRegimeBreakdown()`
(real, `BULLISH_TREND`/`BEARISH_TREND`/`SIDEWAYS_RANGE` segmentation) but not separately tabulated
here for space - see individual run records via `GET /api/v2/quant/strategy-backtests/:id`.
**Transaction costs/slippage/turnover**: real per-trade (`Commissions.ts`/`Slippage.ts`, shared with
the live sizing path), included in the P&L above, not added separately.

**Do not describe any of this as an edge.** MEAN_REVERSION/AMD is net-negative; the two highest-Sharpe
rows failed their own OOS check; none of the 20 combinations has a portfolio-level (multi-symbol,
concurrent-position, shared-capital) backtest - each ran against its own isolated $100k, which
overstates real deployability once 20 strategy×symbol combinations compete for the same real capital
and the same RiskEngine concentration caps.

### 30.8 AI Agent Audit

(Full forensic detail from the dedicated research pass condensed here; every item independently
verified in current source.)

1. **Providers/failover**: real. `AIRouter.ts` wires Gemini/DeepSeek/OpenAI/Nvidia/OpenAI-compatible
   (covers Grok/OpenRouter/Ollama). `routeTask()` sequentially fails over on error; `routeConsensus()`
   fires all providers in parallel via `Promise.all`.
2. **Timeout**: **MISSING, confirmed by two independent research passes.** Zero `AbortController`/
   fetch `signal`/`setTimeout` request-timeout anywhere in `AIRouter.ts` or any provider file. A
   hung provider call blocks the calling agent's tick indefinitely.
3. **Output validation**: real. `AIOutputValidator.ts`'s `coerceEnum`/`clampScore`/
   `normalizeConfidence01`/`coerceString(Array)` applied at every real parse site
   (`NewsScoringEngine.ts`, `FundamentalAgent.ts`, `MacroAgent.ts`, `AIRouter.ts`'s own consensus
   parse). Malformed fields degrade to HOLD/NEUTRAL/0-confidence, never a fabricated BUY/SELL - this
   is the exact class of bug the earlier hardening pass (§27.1) found and fixed for real
   (`NewsEngine.ts`'s old `tradingBias==='BULLISH'?'BUY':'SELL'` ternary). Caveat: a non-JSON
   response is dropped entirely inside a `try/catch` before the validator ever runs, not defaulted
   through it.
4. **Hallucination protection**: **MISSING.** `MarketDataCrossChecker.ts` exists but only
   cross-checks raw price feeds against each other (Alpaca vs Questrade) - it never touches AI
   output and feeds no gate. Nothing in this codebase verifies an AI agent didn't invent or
   misstate a fundamentals/news number it was given.
5. **Contradiction handling**: real. Same `EvidenceAggregator` weighted-vote mechanism as every
   other evidence source - a disagreeing agent's vote counts at half weight against the winning
   side (`DISAGREEMENT_PENALTY=0.5`), never silently dropped, averaged blindly, or given a full veto.
6. **AI can override deterministic risk controls?** No - traced independently (§30.9): the only
   consumer of `CHIEF_APPROVED_IDEA` that reaches an order is `RiskAgent.ts` → `RiskEngine.
   evaluateRisk()`, unconditionally, with no AI-privileged shortcut anywhere, including the manual
   override route.
7. **Can AI directly trigger an order?** No - same reasoning as item 6. Every path to
   `OrderManagement.ts` requires a passed `RISK_ASSESSMENT_COMPLETED` event first.
8. **Reproducibility**: **MISSING.** Zero temperature/top_p/seed parameters set anywhere across any
   provider - identical prompts can produce different outputs run-to-run, uncontrolled and unrecorded.
9. **Historical backtesting of AI decisions**: **MISSING, entirely.** `BacktestEngine.ts` has zero
   references to `AIRouter`/`routeTask`/any LLM call. `PredictionOutcomeEvaluator.ts` grades *live*
   predictions after the fact for the reflection/weight-update loop - forward-looking, not a
   point-in-time historical replay. No AI decision, ever, in this codebase's history, has been
   checked against what it would have said about a moment already in the past with only the
   information available at that moment.
10. **Test coverage**: real and reasonably thorough at the per-agent/output-validation level
    (`AIOutputValidator.test.ts`, `FundamentalAgent.test.ts`, `MacroAgent.test.ts`,
    `EvidenceAggregator.test.ts`, `NewsScoringEngine.test.ts`, per-provider model-override tests) -
    but **`AIRouter.test.ts` does not exist at all.** The failover loop, parallel consensus
    aggregation, and provider health tracking have zero direct unit coverage.

**Verdict: AI READINESS ≈ 35%.** Per Rule 5 of this audit, convincing LLM-generated reasoning is
explicitly not evidence of an edge, and per the findings above, the mechanics around that reasoning
(timeout, reproducibility, hallucination-checking, historical validation) are the least-built part
of the entire pipeline.

### 30.9 Risk Engine Audit

Exact real gate order (`RiskEngine.ts`, first-failure-wins, confirmed via `recordGate()` call sites):

| # | Gate | Threshold | Configurable? | Test coverage | Live usage |
|---|---|---|---|---|---|
| 1 | `emergency_stop` | `tradingState === 'TRADING_ENABLED'` | Via kill-switch API, persisted | Yes | Yes |
| 2 | `daily_loss` | 80% of `settings.dailyLossLimit` | Yes (settings) | Yes | Yes |
| 3 | `consecutive_loss` | 3 consecutive real losing FILLED trades | No (hardcoded `MAX_CONSECUTIVE_LOSSES=3`) | Yes | Yes |
| 4 | `portfolio_drawdown` | `settings.maxPortfolioDrawdownPct` (default 15%) from a persisted real high-water-mark | Yes | Yes | Yes |
| 5 | `order_rate_limit` | `settings.maxOrdersPerMinute` (default 5), real count of `risk_assessments` rows in last 60s | Yes | Yes | Yes |
| 6 | `market_hours` | Alpaca `/v2/clock`; **`null` on REST failure treated as passing** (§30.13 item 4) | N/A | Partial - not tested under network failure | Yes |
| 7 | `data_freshness` | 5 min (`STALE_PRICE_THRESHOLD_MS`); **`null` age (never ticked) silently passes** (§30.13 item 3) | No | Yes for the normal case | Yes |
| 8 | `news_veto` | `news_clusters.impactScore > 80`, 4h window | No | Yes | Yes |
| 9 | `price_validity` | finite, positive `currentPrice` | N/A | Yes | Yes |
| 10 | `order_notional_cap` | `FIXED_DOLLAR` (default, `settings.maxTradeSize=$3000`) or `PERCENT_OF_EQUITY` (new this session, off by default) | Yes | Yes, extensive (incl. new E2B tests) | Yes |
| 11 | `symbol_concentration` | 20% of equity per symbol | No | Yes | Yes |
| 12 | `open_positions_cap` | `settings.maxOpenPositions` (default 10) | Yes | Yes | Yes |
| 13 | `sector_concentration` | 40% of equity per GICS sector | No | Yes | Yes |
| 14 | `correlation_exposure` | 50% of equity across symbols with 90-day return correlation > 0.7 | No | Yes | Yes |
| 15 | `sell_position_exists` (SELL only) | real broker position quantity > 0 | N/A | Yes | Yes |
| 16 | `sufficient_size` | computed quantity > 0 | N/A | Yes | Yes |

**Can any code path place an order without passing through this ladder? No — traced structurally
this audit** (independently confirmed by the ChiefTrader research pass): `OrderManagement.ts`'s
only listener is `RISK_ASSESSMENT_COMPLETED`, which only `RiskEngine.evaluateRisk()` emits; the only
producer of that gate's input, `CHIEF_APPROVED_IDEA`, is consumed unconditionally by `RiskAgent.ts`
with no filtering; the manual-override route (`v2System.ts`) emits the identical event through the
identical chain. **This is a real, structural guarantee, not an assumption.**

**On internal failure**: `evaluateRisk()`'s own `catch` block sets `approved=false` on any thrown
exception (`RiskEngine.ts:374-388`) - **fails closed**, confirmed by direct read, not inferred.

**Real gaps, neither of which allows an order to skip the ladder, but both weaken specific gates**:
staleness silently passes when a symbol has literally never ticked (relies entirely on
`price_validity` as backstop); `market_hours` treats an Alpaca outage as "market open" rather than
refusing to trade on unknown state.

### 30.10 Position Sizing Audit

Current implementation (confirmed this session's own E2B work, `PositionSizing.ts`): **not** a
single fixed-dollar rule as previously reported - three caps computed simultaneously, minimum wins:
risk-based (`accountEquity × maxPortfolioRiskPct` ÷ assumed 5% stop distance, `maxPortfolioRiskPct`
= 1%/2%/3% by `settings.riskLevel`), order-notional (`FIXED_DOLLAR` default $3,000 flat, or
`PERCENT_OF_EQUITY` if explicitly enabled - **off by default**), and buying-power. Plus
single-symbol (20%)/sector (40%)/correlation (50%) concentration caps on top for BUY orders.

**The previous $3,000 `maxTradeSize` finding is still true as the DEFAULT** - `PERCENT_OF_EQUITY`
exists as an opt-in (this session's addition) but nothing in this environment's actual `.env`/
`settings` row enables it; the live default remains a flat $3,000 cap per order regardless of
account size.

**What Argus can actually trade today**, using real end-of-window prices from this session's own
backtest run (`BASELINE_RESULTS.json`) — AMD $236.98, MSFT $486.87, SPY $686.37, QQQ $618.74 - under
the real, current default sizing (whole shares only, confirmed: `AlpacaBroker.placeOrder()` sends
`qty`, never `notional`; no fractional-share code path exists anywhere in this codebase):

| Account | AMD (~$237/sh) | SPY (~$686/sh) | Binding constraint |
|---|---|---|---|
| $100 | 0 shares — **TRADE NOT POSSIBLE, whole-share constraint** | 0 shares — **TRADE NOT POSSIBLE** | Buying power |
| $500 | 2 shares ($473.96, 94.8% utilization) | 0 shares — **TRADE NOT POSSIBLE** | Buying power |
| $1,000 | 4 shares (94.8%) | 1 share (68.6%) | Buying power |
| $10,000 | 12 shares ($2,843.76, 28.4% utilization) | 4 shares ($2,745.48, 27.5%) | **The $3,000 default notional cap, not buying power** |
| $100,000 | 12 shares (2.8% utilization) | 4 shares (2.7%) | **Same $3,000 default cap - does not scale with account size unless `PERCENT_OF_EQUITY` is explicitly enabled** |

This is the real, current, non-hypothetical output of this session's own `AccountSizeReport.ts`
tool's math applied to real prices - not a hypothetical. Commissions/slippage are real but small
relative to these notionals (`Commissions.ts`: SEC/FINRA fees are sells-only and basis-point-scale;
`Slippage.ts`: dynamic, volatility/participation-scaled, typically well under 1% at this order size).
**Fractional shares do not exist in this codebase for any broker** - do not assume otherwise.

### 30.11 Broker & Order Execution Audit

(Condensed from the dedicated research pass; every item independently verified in current source.)

1. **Alpaca request timeout**: **MISSING.** `AlpacaBroker.fetchAlpaca()` uses raw `fetch()` with no
   `AbortController`. A hung request hangs `placeOrder()` indefinitely, with no way to distinguish
   "never reached Alpaca" from "Alpaca received it but the response was lost."
2. **Duplicate-order idempotency**: **real.** DB-level `uniqueIndex` on `trades.traceId`
   (`schema.ts:240`) plus a fast-path check, verified against a genuine concurrent race in
   `OrderManagement.lifecycle.test.ts`.
3. **Partial fills**: **real, with a hard give-up.** Incremental aggregation via
   `recordFillProgress()`; initial 400ms/4s poll, then a 15s follow-up job from 6s to 30 minutes
   old; **past 30 minutes the order is left at its last-known non-terminal status permanently, with
   no other job ever touching it again.**
4. **Cancellation**: **real backend, unreachable frontend.** `POST /api/v2/trading/cancel-order/:id`
   is real and tested; zero UI in `src/App.tsx`/`src/components/` calls it. The only in-app caller
   is the emergency-stop flow's `cancelAllOpenOrders()`.
5. **Crash-after-send reconciliation**: **MISSING at the order level.** `PortfolioReconciliation.ts`
   checks positions, not orders - a filled Alpaca order the app crashed before recording stays wrong
   (e.g. permanently `REJECTED`) in the `trades` table forever. `TransactionStatus` has an unused
   `'RECONCILED'` value nothing ever sets - a real, citable sign this was anticipated but not finished.
6. **Unrecognized broker status**: falls through silently. `TERMINAL_ORDER_STATUSES =
   ['FILLED','REJECTED','CANCELED']` - real Alpaca statuses like `DONE_FOR_DAY`/`REPLACED`/
   `EXPIRED`/`STOPPED` are treated as still-open with no alert, left to the 30-minute give-up above.
7. **Retry/backoff/rate-limiting**: **MISSING entirely** for Alpaca. Zero matches for retry/backoff/
   429/`Retry-After` handling in `AlpacaBroker.ts` or `BrokerManager.ts`. A single API failure,
   including a rate limit, propagates straight to `REJECTED`.
8. **Test coverage**: idempotency, partial-fill aggregation, and all 4 `cancelOrder()` branches are
   really tested. **Timeout, crash-recovery, unrecognized status, and rate-limiting have zero test
   coverage anywhere in this codebase.**

### 30.12 Portfolio Reconciliation Audit

**This is the most important new finding in this audit.**

`PortfolioReconciliationWorker.reconcile()` (`src/server/services/PortfolioReconciliation.ts`) runs
real, on boot and every 5 minutes, comparing `broker.portfolio().positions` against the local
`portfolio` table. On a mismatch it treats the broker as source of truth and **really does**
overwrite/insert/zero the local rows, log, emit an event, and persist to `reconciliation_events` +
`portfolio_snapshots` - this part is genuinely real, not fabricated.

**But**: for a mismatch valued at ≥$100, the code sets `tradingEngine.state.emergencyStopActive =
true` **directly**, bypassing `setTradingState()` (`PortfolioReconciliation.ts`, flagged in its own
nearby comment as the intended "pause new trading" behavior). Independently verified against
`RiskEngine.ts`'s real `emergency_stop` gate (§30.9, gate 1): **that gate reads `tradingEngine.
state.tradingState`, not `emergencyStopActive`.** `emergencyStopActive` is read nowhere in the
actual approval path — only for logging. **A large real position drift, exactly the scenario this
mechanism exists to catch, does NOT actually stop new orders, contrary to what the code's own
comments and this document's own prior sections (§27.2, "Portfolio reconciliation re-entrancy")
implied.** This was found by tracing both sides of the claim to source in this session, not assumed
from either side's own documentation of itself.

**CRITICAL — REAL-MONEY RISK.**

Further gaps: only **positions** are reconciled. Cash/buying power (`Portfolio.cash`/`.buyingPower`
exist on the interface, never read by the reconciliation worker), open broker orders, and filled
orders vs. the internal `trades` table are **entirely unreconciled** - three of the four things the
requested audit asked about are simply not checked.

**If the internal DB says 100 shares of AAPL but Alpaca actually holds 0**: within 5 minutes (or
immediately on next boot), the local `portfolio` row is corrected to 0, a `reconciliation_events`
row and `RECONCILIATION_MISMATCH` event are produced, and (if the drift's dollar value was ≥$100)
`emergencyStopActive` is set - but **new orders are NOT actually blocked**, per the finding above.

### 30.13 Market Data Audit

1. **WS disconnect**: real reconnect, but a **fixed 5-second retry forever**, no exponential
   backoff, no cap, no jitter.
2. **Duplicate ticks**: real, exact-match dedup on (symbol, timestamp, price), tested.
3. **Staleness**: real 5-minute gate, tested for the normal case; **a symbol that has literally
   never ticked reports `priceAgeMs===null`, which silently passes the staleness check** and relies
   entirely on the separate `price_validity` gate as backstop.
4. **Full API outage**: does not cleanly fail closed. No downstream consumer of
   `MARKET_DATA_DISCONNECTED`/`MARKET_DATA_GAP_DETECTED` exists anywhere (RiskEngine/ChiefTrader/
   TradingEngine none listen). `isMarketOpen()` returns `null` on an Alpaca REST failure, and
   `null !== false` passes the `market_hours` gate - **an outage is treated as "market open,"
   not as "unknown, refuse to trade."**
5. **Rate limits (429)**: **MISSING**, same finding as the broker layer (§30.11 item 7) - no
   Alpaca-specific rate-limit handling anywhere.
6. **`TradingEngine.toggle()` start gate**: real. Compares requested budget against real
   `broker.portfolio().buyingPower`, returns an explicit rejection (not a silent no-op) on failure,
   tested both directions.
7. **Kill switch**: real and persisted. `settings.tradingState` survives a restart (confirmed:
   loaded back in `TradingEngine.initialize()`), an immutable `kill_switch_events` audit row is
   written on every transition, `RiskEngine`'s gate 1 reads this state directly, and
   `cancelAllOpenOrders()` really cancels real open orders on activation (filled positions are
   deliberately left untouched).
8. **Test coverage**: dedup, staleness, budget gate, and full kill-switch lifecycle (including
   restart persistence) are really tested. The reconnect timer itself, rate-limiting, and
   full-outage fail-closed behavior have zero test coverage.

### 30.14 Backtest Engine Audit

Verified this session while building E1-E7 (§28) and in earlier sessions (§15-27):

- **Look-ahead protection**: real - `ReplayClock` structurally exposes only a chronological prefix
  of bars per symbol (`clock.assertNotFuture()` asserted defense-in-depth on top of the structural
  guarantee), plus a dedicated regression test suite (`ReplayClock.test.ts`).
- **Point-in-time data**: real for OHLCV bars (`HistoricalDataGateway`), each symbol's visible
  window strictly gated by the simulated clock.
- **Corporate actions / splits**: real, active safety refusal - `checkForUnadjustedCorporateActions()`
  compares `adjustment=raw` vs `adjustment=split` bars and halts the run (`CORPORATE_ACTION_DETECTED`)
  on a real detected split, rather than silently corrupting P&L. This is WHY this session's own E1
  baseline used SPY/QQQ/MSFT/AMD instead of AAPL/NVDA/TSLA - a real, working guard, not a gap.
- **Dividends**: **not adjusted for** - bars are `adjustment=raw`, and the corporate-actions check
  only compares against `adjustment=split`, not `adjustment=all` (which would also adjust for
  dividends). A real, minor, previously-undocumented gap: dividend-heavy symbols over long windows
  could show a small, real (not fabricated) total-return understatement relative to a dividend-
  adjusted benchmark.
- **Commissions/SEC/FINRA fees**: real, shared model (`Commissions.ts`) - sells-only fees, matches
  the real regulatory structure, used identically by both `run()` and `runStrategyBacktest()`.
- **Slippage**: real, dynamic (volatility + order-participation-rate scaled), not a flat constant.
- **Position sizing**: real, shares the exact live `PositionSizing.ts` logic and E2B's new sizing
  mode - no separate "backtest-only" sizing rule exists anymore (this was a previously-documented,
  now-closed gap, §15.9/§27.1).
- **Partial fills**: **not modeled** - the backtest engine fills a computed quantity in full at one
  simulated price per signal; it does not simulate a broker partially filling a large order across
  multiple prints, unlike live's real partial-fill aggregation (§30.11 item 3). This is a real,
  one-directional parity gap (live can partially fill; backtest never does).
- **Market hours**: bars are daily (`1Day` timeframe) - the backtest has no intraday market-hours
  concept to violate, but this also means it cannot validate any live intraday timing assumption.
- **Order execution assumptions**: signal-bar-close fill with dynamic slippage, not next-bar-open -
  a real, documented modeling choice, not a bug, but worth noting as a live/backtest timing
  difference (live decisions act on the latest real-time tick, not a bar close).

### 30.15 Live vs. Backtest Parity

| Feature | Live behavior | Backtest behavior | Match? | Risk |
|---|---|---|---|---|
| Entry logic | Real per-agent rules via consensus | `run()`: identical inline rules (same file's own logic, not re-derived); `runStrategyBacktest()`: identical `quant/strategies/` `evaluate()` calls | Yes for the deterministic/quant paths | Low |
| Entry logic (AI-influenced) | ChiefTrader consensus can include AI debate votes | **Never modeled at all** - backtest is purely deterministic | **No - by design, documented** | Medium - live approval thresholds can differ from what the backtest "approved" implies |
| Exit — take-profit/stop-loss | `PortfolioMonitor.ts`, now reads `settings.takeProfitPct`/`trailingStopPct` (fixed this session, §28 E2A) | `run()`, now reads the same settings fields (fixed this session) | **Yes, as of this session — was silently mismatched before it** | Was High, now Low |
| Exit — quant strategies | N/A (`runStrategyBacktest()` is a backtest-only entry point; QuantEngine's live exits are governed by `PortfolioMonitor`'s same generic thresholds, not per-strategy target/stop) | Per-strategy explicit target/stop from each strategy's own `evaluate()` output, with `TREND_FOLLOWING`'s real trailing-stop simulated | **No** - a quant strategy's real backtest exit logic (per-strategy stop/target) is not what actually governs a live position opened from that same strategy's signal | Medium - live exits use a generic rule, not the strategy-specific one the backtest credits its performance to |
| Sizing | `PositionSizing.ts`, real, shared | Same `PositionSizing.ts` function, byte-identical logic | Yes | Low |
| Fees | Real `Commissions.ts`/`Slippage.ts` | Same modules | Yes | Low |
| Risk gates | Full 16-gate ladder (§30.9) | Sizing math only (concentration/correlation/notional/buying-power caps) - **daily-loss, consecutive-loss, drawdown, order-rate, market-hours, staleness, and news-veto gates are not simulated in the backtest at all** | **No** | Medium - a backtest "trade" could be one a live circuit breaker would have actually blocked |
| Market hours / data | Daily bars, no intraday timing | Real-time ticks | N/A (different granularity by design) | Low, documented |
| Order fills | Real broker fill (possibly partial, possibly delayed) | Full fill at signal-bar close + slippage | Partial | Medium |
| Portfolio state | Real, reconciled every 5 min (with the §30.12 gap) | Simulated cash/positions only, no reconciliation concept | N/A | N/A |

**The two most material mismatches**: (1) the quant strategies' real backtest performance credits
each strategy's own explicit stop/target logic, but a live position from that same signal actually
exits under `PortfolioMonitor`'s generic settings-driven thresholds, not the strategy's own logic -
**the backtest numbers in §30.7 do not describe what would actually happen to a live position**;
(2) the backtest never simulates the daily-loss/consecutive-loss/drawdown/rate-limit/staleness/
news-veto gates, so a backtested "trade" could be one live RiskEngine would have actually rejected.

### 30.16 Historical Performance

Real, this session, `scripts/runBaseline.ts` → `BASELINE_RESULTS.json`. SPY+QQQ+MSFT+AMD, combined
portfolio, 2018-01-01 to 2025-12-31, $100,000 initial, via unmodified `BacktestEngine.run()`:

| Metric | Value |
|---|---|
| Total return | +14.91% |
| CAGR (8-year window) | ≈1.75%/yr |
| Win rate | 50.9% |
| Profit factor | 1.98 |
| Expectancy | $90.31/trade |
| Sharpe | 0.51 |
| Sortino | 0.29 |
| Max drawdown | 3.54% |
| Closed trades | 165 |

**Benchmark comparison** (real, computed from the same bars this run loaded, per this session's E7
work): a real SPY buy-and-hold over the identical 2018-2025 window vastly outperforms this - SPY
alone appreciated from ~$258 to ~$686/share over this window (+165%, per §30.10's real price data),
dwarfing the strategy's +14.91% combined-portfolio result. **The deterministic strategy underperforms
simple buy-and-hold by a wide margin over this exact window.** Per-symbol/monthly/annual return
breakdowns are available in `BASELINE_RESULTS.json`'s full equity curve but are not separately
tabulated here.

**Recovery factor** (total return ÷ max drawdown) ≈ 4.2 - a real, computable number, but not
independently meaningful without the OOS/statistical-significance context in §30.17-30.18.

### 30.17 Walk-Forward / OOS Validation

Real, this session, `scripts/runWalkForwardCheck.ts` using E5's newly-extended `WalkForwardValidator`
(`trainDays=365`/`testDays=120`, real 2018-2025 data, 21 rolling periods), run against the two
highest-Sharpe results from §30.7:

| Combination | Avg in-sample return | Avg out-of-sample return | IS→OOS degradation | % OOS periods profitable |
|---|---|---|---|---|
| MOMENTUM_BREAKOUT / MSFT | +0.37% | **+0.04%** | -89% | 42.9% (worse than a coin flip) |
| MOMENTUM_BREAKOUT / AMD | +1.36% | **+0.28%** | -79% | 66.7% |

**This is the single strongest piece of evidence in this audit.** Both real out-of-sample returns
collapse to a small fraction of their in-sample counterparts - the textbook in-sample-overfitting
signature. No regime-separated (bull/bear/sideways/high-vol/low-vol) OOS breakdown was additionally
run this session beyond what `computeRegimeBreakdown()` reports per-run (§30.7). No bootstrap
confidence interval or permutation test was run this session on top of the walk-forward result - the
Monte Carlo tooling built this session (`MonteCarlo.ts`, §28 E6) resamples R-multiples for scenario
analysis but was not applied here as a formal statistical-significance test; that remains a real gap
(P1, §30.24).

**Distinguishing a positive historical result from statistically defensible edge evidence**: §30.16's
+14.91% total return and §30.7's individual Sharpe-2+ rows are positive historical results. **Neither
constitutes statistically defensible edge evidence** - the only one of them actually checked
out-of-sample failed that check.

### 30.18 Statistical Evidence

- **TechnicalAgent's deterministic strategy**: 165 closed trades, 50.9% win rate. A two-sided
  binomial test against p=0.5 with n=165 gives a very wide confidence interval that comfortably
  contains 50% - this is not distinguishable from chance with this sample size, consistent with
  every prior section of this document that has made the same finding (§15.18 and others).
- **QuantEngine's 20 strategy×symbol combinations**: several individually clear the 20-trade Kelly
  threshold (§30.7), but only 2 were checked out-of-sample, and both failed (§30.17). The other 18
  have **no OOS evidence at all** - positive in-sample numbers with zero external check.
- **AI-driven signals**: zero statistical evidence of any kind - never backtested (§30.8 item 9).
- **No bootstrap or permutation test has been run on any live or backtest result in this codebase's
  history.**

**PROFITABILITY EVIDENCE: UNVALIDATED.** Not "weak" - genuinely unvalidated, because the one formal
check that exists returned a negative result on this session's own best candidates.

### 30.19 $100 / Small Account Analysis

Directly answered with real numbers in §30.10. Restated for completeness:

**What Argus can do TODAY, literally, with $100**: place zero orders in any symbol used in this
session's own testing (AMD $236.98, MSFT $486.87, SPY $686.37, QQQ $618.74) - the whole-share
constraint alone rules it out before fees/sizing even enter the picture. A $100 account could only
trade a real symbol priced under $100/share, and even then the default sizing math (buying power is
the binding constraint below $3,000) would allow at most a handful of shares, well below any
meaningful diversification, and the $5/order-ish combined commission+slippage drag on a sub-$100
notional trade would materially erode any real edge even if one existed.

**What Argus could theoretically do after improvements** (explicitly hypothetical, per this audit's
own Rule): fractional-share order placement would require new broker-adapter work (Alpaca's real
API does support fractional/notional orders; this codebase's `AlpacaBroker.ts` does not use that
capability today - confirmed, `qty` only, no `notional` field anywhere in `placeOrder()`). This is a
real, buildable, not-yet-built capability, not a theoretical impossibility.

### 30.20 Failure & Chaos Analysis

| Scenario | Classification | Evidence |
|---|---|---|
| Application crash / restart | **Recoverable** | Kill-switch state persists (§30.13 item 7); reconciliation runs immediately on boot (§30.12) - but any order mid-flight at crash time has no recovery (§30.11 item 5) |
| Database unavailable | UNVERIFIED this audit - not traced this pass | — |
| Broker (Alpaca) unavailable | **Potentially dangerous** | No downstream consumer of disconnect events (§30.13 item 4); `market_hours` gate treats REST failure as "open" |
| WS disconnect | **Recoverable, crudely** | Fixed 5s retry forever, no backoff cap (§30.13 item 1) |
| Duplicate market-data event | **Safe** | Real, tested dedup (§30.13 item 2) |
| Duplicate order | **Safe** | Real DB-enforced idempotency (§30.11 item 2) |
| Partial fill | **Safe up to 30 min, then abandoned** | §30.11 item 3 |
| Stale price | **Safe for the common case, gap for never-ticked symbols** | §30.9 gate 7, §30.13 item 3 |
| Clock/timezone issue | **Safe** | Daily-loss boundary uses a real IANA `America/New_York` trading-day helper (fixed in the earlier hardening pass, §27.1), DST-tested |
| Market holiday | UNVERIFIED this audit - `isMarketOpen()` relies on Alpaca's own `/v2/clock`, which is presumed holiday-aware, not independently re-verified this pass | — |
| API timeout (broker or AI) | **CRITICAL** | Zero timeout anywhere in either stack (§30.8 item 2, §30.11 item 1) - an agent tick or an order submission can hang indefinitely |
| API rate limit | **Potentially dangerous** | No handling anywhere for either Alpaca or the AI providers (§30.11 item 7, and the AI research pass found the same gap) |
| Malformed AI response | **Safe** | Real coercion to safe defaults (§30.8 item 3) |
| AI provider outage | **Recoverable** | Real multi-provider failover exists (§30.8 item 1), though untested at the router level (`AIRouter.test.ts` doesn't exist) |
| News provider outage | UNVERIFIED this audit - not traced this pass | — |
| Database transaction failure | UNVERIFIED this audit - not traced this pass | — |
| Process restart during open position | **Recoverable** | Position itself survives (real broker state); reconciliation catches a position drift on next boot, but the "pause trading" response to that drift is broken (§30.12, CRITICAL) |
| Server restart during order submission | **CRITICAL** | No mechanism reconciles an order that reached Alpaca but never got recorded locally (§30.11 item 5) |

### 30.21 Security Audit

No new issue found this audit pass. Carried forward from the earlier hardening pass (§27.1),
independently spot-checked this session with no regression: API keys redacted from caught-error log
output; Polygon moved off query-string key auth to header auth; `ENCRYPTION_SECRET`-backed AES-256
encryption for stored broker/AI-provider keys (auto-generated to `data/.encryption_key` if unset);
`configRoutes.ts`'s settings-write endpoint uses an explicit field allowlist (a real, previously-
exploitable bypass of the kill-switch/drawdown-peak fields was closed and is regression-tested);
`npm run security:scan-writes` (a real static scanner for the raw-`req.body`-write bug class this
document has found and fixed twice) reports clean against current source, verified this session.

### 30.22 Observability & Monitoring

Real: Transaction Observatory (`event_traces`/`consensus_decisions`/`consensus_evidence`/
`risk_assessments`/`risk_gate_results`/`fills`/`trades`, all joined without recomputation, confirmed
real in the frontend audit §29.3); real activity log; real WS broadcast for most event types; this
session added real observability for the quant/backtest layer (decision-trace logging, failure
breakdown, Monte Carlo, benchmark comparison - §28).

Gaps: `MARKET_DATA_DISCONNECTED`/`MARKET_DATA_GAP_DETECTED` have no real consumer anywhere (§30.13
item 4) - an operator watching the dashboard would not be alerted to a live data outage by anything
beyond a raw server log line. Reconciliation mismatches produce a `console.warn` and a DB row, not
an alert/page. 9 of 20 frontend tabs contain at least one widget an operator could mistake for a
working monitor when it is actually broken (§29.3) - a materially different risk for an unattended
autonomous system than for one a human is actively watching.

### 30.23 Previous Audit Findings — Fixed vs. Still Open

| Finding | Status |
|---|---|
| `PortfolioMonitor` hardcoded ±5%/-3% exit thresholds vs. backtest's -5%/+15% | **FIXED SINCE PREVIOUS AUDIT** (§28 E2A, this session) |
| Flat $3,000 `maxTradeSize`, no percent-of-equity option | **PARTIALLY FIXED** - `PERCENT_OF_EQUITY` mode now exists (§28 E2B) but is off by default; the flat-cap behavior this finding described is still what actually runs today |
| `WalkForwardValidator` had no test file / unclear if it worked | **FIXED SINCE PREVIOUS AUDIT** - real test suite added this session, and it surfaced a real latent bug in the process (§28 E5) |
| No failure classification on losing trades | **FIXED SINCE PREVIOUS AUDIT** (§28 E4), scoped honestly to only derivable categories |
| No Monte Carlo scenario analysis | **FIXED SINCE PREVIOUS AUDIT** (§28 E6), but not yet applied as a formal significance test on any specific strategy (§30.17) |
| RiskEngine TOCTOU races, order-lifecycle gaps, duplicate-order race, daily-loss timezone bug, AI-output validation gap, AI provider model-override bug, AI caching gap, secret-leak vector, WS-reconnect data loss, reconciliation re-entrancy | **FIXED SINCE PREVIOUS AUDIT** (§27.1, the earlier hardening pass) - all independently re-verified this pass with no regression |
| Portfolio's Emergency Liquidation/Rebalance buttons 404 | **STILL OPEN** |
| Settings' Secrets Manager UI calls unwired routes | **STILL OPEN** |
| Trading Arena's Swarm Decision Outcomes silently broken | **STILL OPEN** |
| Mission Control's Granular Module Toggles are fake, Change Plan unapproved | **STILL OPEN** |
| `cancelOrder()` has no frontend button | **STILL OPEN** |
| Broker/order execution has no timeout, retry, or crash-recovery | **STILL OPEN (newly quantified this audit, not previously documented in this much depth)** |
| Portfolio reconciliation's "pauses trading" claim | **NEWLY DISCOVERED THIS AUDIT - was never previously verified against the actual gate code** |
| No AI decision has ever been backtested | **STILL OPEN (previously stated as a general limitation; this audit confirms it with a direct code search returning zero matches)** |

### 30.24 P0/P1/P2/P3 Improvements

| Priority | Missing capability | Why it matters | Effort | Risk | Required before real money? |
|---|---|---|---|---|---|
| P0 | Fix reconciliation's pause-trading path to actually set `tradingState`, not just `emergencyStopActive` | A real position drift currently does not stop new orders despite the code claiming it does | Small (a few lines + a real test asserting the RiskEngine gate actually blocks after the fix) | High if unfixed | **Yes** |
| P0 | Add a request timeout + explicit hang/circuit-breaker handling to the Alpaca broker call and every AI provider call | Both stacks can hang indefinitely today with zero recovery | Medium | High if unfixed | **Yes** |
| P0 | Add order-level crash reconciliation (query Alpaca's real open/recent orders on boot and reconcile against `trades`) | A filled-but-unrecorded order can sit wrong forever today | Medium | High if unfixed | **Yes** |
| P0 | Run and act on a real walk-forward/OOS check before trusting ANY strategy with real capital | The only check ever run failed | Small (tooling already exists, §28 E5) - the real cost is accepting a likely negative answer | N/A - this is a validation gate, not a code risk | **Yes** |
| P1 | Retry-with-backoff and real 429 handling for Alpaca | A rate limit or transient failure currently just becomes a rejected order | Small-medium | Medium | Yes, before autonomous (not necessarily before restricted/supervised) |
| P1 | Reconcile cash/buying-power and open orders, not just positions | Three of four real reconciliation targets are currently unchecked | Medium | Medium-High | Yes |
| P1 | Wire a real alert (not just a console.warn) on reconciliation mismatch and market-data disconnect | An unattended system needs a real page/notification, not a log line | Small-medium | Medium | Yes for true autonomy |
| P1 | Backtest at least the deterministic + quant strategies' actual LIVE exit rule (`PortfolioMonitor`'s generic thresholds), not each strategy's own idealized stop/target | §30.15's biggest live/backtest mismatch - current backtest numbers overstate what a live position would actually capture | Medium | Medium | Yes |
| P1 | Add `AIRouter.test.ts` covering failover/parallel-consensus/health-tracking | Zero test coverage of the actual routing logic every AI-driven decision depends on | Small-medium | Medium | Should precede any AI-debate weight increase |
| P2 | Reconcile filled orders against the `trades` table | Least likely of the four reconciliation gaps to be exploited but still a real gap | Medium | Low-Medium | Recommended, not strictly blocking |
| P2 | Formal statistical significance test (bootstrap/permutation) on top of walk-forward results | Strengthens the negative finding into a rigorously quantified one | Small (Monte Carlo tooling exists, §28 E6) | Low | Recommended |
| P2 | Fractional-share support | Only real path to a genuinely usable sub-$500 account | Large (new broker-adapter capability) | Low (research-only until enabled) | Not blocking for the existing default account sizes |
| P3 | Fix the remaining BROKEN/MOCKED frontend widgets (§29.3, §30.23) | Operator-facing trust/usability, not a real-money-loss vector for most of them | Large (9-13 tabs) | Low-Medium (Portfolio's 404ing Liquidate button is the one exception - functionally P1-adjacent) | No, except the Liquidate/Rebalance 404s if an operator would ever rely on them in a live incident |

### 30.25 Roadmap to Autonomous Trading

| Stage | Range | Required to enter |
|---|---|---|
| Development/research | 0-50% | Code exists, connected, unit-tested. **Argus is past this stage on the software axis (53% technical), but the P0 items in §30.24 are development-stage fixes, not polish.** |
| Paper trading | 50-70% | All P0 items in §30.24 closed; kill switch, reconciliation, and RiskEngine gate ladder verified end-to-end (already true structurally, per §30.9, modulo the P0 reconciliation bug) |
| Extended paper validation | 70-85% | A real walk-forward OOS check exists and shows a genuine, positive, statistically meaningful edge (not yet true - §30.17 shows the opposite for the only combinations checked); a real multi-week+ live paper track record with real fills, not just backtest, logged and reviewed |
| Restricted real-money | 85-95% | The above, plus P1 items closed, a hard, small capital cap enforced independently of strategy confidence, and a human still reviewing every trade or a tight daily cap |
| Autonomous real-money | 95-100% | The above, sustained over a real sample large enough for statistical confidence, P2 items closed, and no CRITICAL/P0 finding open anywhere in this document |

**Current position: solidly in "Development/research," bordering "Paper trading" on the software
axis alone (53%), pulled back into "Development/research" overall by the P0 statistical-validation
gate, which the roadmap above treats as a hard floor, not a bonus.**

### 30.26 Minimum Safe Capital

Not $100 by default recommendation (per this audit's own instruction) - calculated from real
current sizing behavior (§30.10):

- **Experimental paper trading**: $0 additional risk (paper is simulated) - no real minimum, but a
  representative test should use at least ~$1,000-3,000 simulated to exercise the real default
  sizing caps meaningfully (below $3,000, buying power rather than the notional cap binds, which is
  a different code path worth testing deliberately).
- **Restricted real-money** (once the P0 gates in §30.24 close): realistically **$3,000-5,000
  minimum** - below the default flat $3,000 order cap, most real equities leave too little room to
  hold more than 1-2 positions at once, defeating the correlation/concentration diversification the
  RiskEngine gate ladder is built to enforce, and commission/slippage drag becomes proportionally
  larger on tiny notionals.
- **Proper autonomous trading**: **$25,000+** is the realistic floor for the sizing math to behave
  as designed (the 20%/40%/50% concentration/sector/correlation caps and the risk-based 1-3%-of-
  equity sizing only produce meaningfully differentiated position sizes once equity is well above
  the flat $3,000 notional cap - otherwise that flat cap is always the binding constraint regardless
  of what the more sophisticated risk-based math would have suggested, per §30.10's own worked
  example).

### 30.27 Final Go/No-Go Decision

**GATE 1 — Broker Safety: FAIL** (no timeout, no retry, no crash-after-send reconciliation, cancel
unreachable from UI - §30.11)

**GATE 2 — Position Reconciliation: FAIL** (cash/orders/fills unreconciled; the pause-on-mismatch
safety claim is verified false - §30.12, CRITICAL)

**GATE 3 — Risk Controls: PASS**, with caveats (structurally un-bypassable, fails closed, 16 real
gates - §30.9; the null-priceAge and null-marketOpen edge cases are real but narrow and don't defeat
the ladder as a whole)

**GATE 4 — Live/Backtest Parity: FAIL** (the AI-influenced portion of every real decision has zero
backtest parity by definition - never backtested at all; the quant strategies' backtest credits an
exit rule that isn't what actually governs a live position - §30.15)

**GATE 5 — Strategy Validation: FAIL** (every strategy capable of influencing a real order today is
statistically unvalidated - §30.6, §30.18)

**GATE 6 — Out-of-Sample Evidence: FAIL** (the only check ever run failed - §30.17)

**GATE 7 — Failure Recovery: FAIL** (no order-level crash recovery, unbounded AI/broker hangs,
orders permanently abandoned after 30 min - §30.11, §30.20)

**GATE 8 — Monitoring/Alerting: FAIL** (no real alert path for data-disconnect or reconciliation
mismatch beyond a log line - §30.22)

**GATE 9 — AI Reliability: FAIL** (no timeout, no reproducibility control, no hallucination check,
zero router-level test coverage, zero historical validation - §30.8)

**GATE 10 — Paper Trading: PASS** (real, functional, previously live-verified end-to-end per §1's
original findings and unregressed since - though no long-duration, large-sample real paper track
record is documented anywhere in this repository's history to date)

**7 of 10 gates fail, including every gate that speaks to statistical validation or unattended
failure recovery.**

## NOT READY FOR AUTONOMOUS REAL-MONEY TRADING

### 30.28 Appendix — Evidence and File References

Primary files inspected or cited this audit: `src/server/engines/RiskEngine.ts`,
`src/server/engines/PositionSizing.ts`, `src/server/engines/TradingEngine.ts`,
`src/server/engines/backtest/{BacktestEngine,WalkForwardValidator,HistoricalDataGateway,
Commissions,Slippage,ReplayClock}.ts`, `src/server/services/{OrderManagement,
PortfolioReconciliation,PortfolioMonitor,ChiefTraderAgent,EvidenceAggregator,TechnicalAgent,
FundamentalAgent,MacroAgent,QuantSignalAgent,MarketDataWorker,ConfidenceCalibration,
PredictionOutcomeEvaluator,MarketDataCrossChecker}.ts`, `src/server/ai/{AIRouter,
AIOutputValidator}.ts` + `src/server/ai/providers/*`, `src/server/news/{NewsEngine,
NewsScoringEngine}.ts`, `src/brokers/{AlpacaBroker,BrokerManager,BrokerAdapter}.ts`,
`src/server/core/{EventBus,TransactionRegistry}.ts`, `src/server/db/schema.ts`,
`src/server/quant/**`, `src/server/quant/analysis/**` (this session's own new modules), plus their
respective test files (94 test files / 667 tests total, confirmed passing this session - see §28.3
for the full list of files touched this session). Real data artifacts produced/reused this audit:
`BASELINE_RESULTS.json`, `WALKFORWARD_CHECK_RESULTS.json` (both from this same session, reused here
rather than re-run, since nothing in the deterministic strategy logic itself changed between
generation and this audit - only settings-sourcing, which defaults to the identical values). Cross-
referenced documents: `FINAL_APPLICATION_STATE_ANALYSIS_V2.md`, `FRONTEND_REALITY_MATRIX.md`,
`ARGUS_HARDENING_CHANGELOG.md`, `BACKTEST_QUANT_HARDENING_ANALYSIS.md`, `CLAUDE.md`. This audit's
own research was conducted via five parallel, independent research passes (order execution/broker
path; portfolio reconciliation; ChiefTraderAgent consensus/AI debate; AI provider reliability; market
data/kill switch), each tracing real call chains rather than reading comments at face value, with
findings cross-validated where two passes independently touched the same code (e.g., both the broker
and market-data passes independently found the same missing-retry/rate-limit gap in `AlpacaBroker.ts`,
and both the reconciliation and broker passes independently found `PortfolioReconciliation.ts` and
converged on a consistent description of its behavior).

---

## 31. UI Honesty + Local Companion Boot Pass — 2026-08-15

This pass does **not** reopen Section 30's scores. LIVE remains **NO-GO**. NewsAgent last scored
pass remains **~44.6% on 242 predictions**. Quant walk-forward OOS for checked combos remains
**failed**. Adding UI copy, a sticky tab strip, or a Chronos spawn does not raise readiness.

Where this section conflicts with §15.20 / §25.3 / §29.3 on the specific widgets named below, this
section wins for those widgets only. Unnamed widgets keep their earlier verdicts.

### 31.1 Agent Network — win-rate banner is no longer `mockWinRateData`

`src/App.tsx` Agents tab no longer reads `mockWinRateData` or `mockSystemLatencyData` (those
arrays were deleted). The Performance Threshold Alert, scored-win-rate bar chart, Active Regime
Casting Weights, System Latency panel, and Agent Node Stability Snapshot now use
`GET /api/v2/agents/learning-summary` (`agent_performance_stats` via `REAL_AGENT_NAMES`:
TechnicalAgent, NewsAgent, FundamentalAgent, MacroAgent, KronosForecastAgent).

- Alert fires only when `winRate !== null`, `totalPredictions >= tradingSafety.agentWinRateAlertMinPredictions`
  (20), and `winRate < tradingSafety.agentWinRateAlertPct` (48). Copy states **lifetime scored
  win rate**, not a 24h series (that window is not stored).
- SentimentAgent / OrderFlowAgent do not appear. They are not live voters.
- Latency panel is an honest `AwaitingSignal` (no per-agent RTT table exists). GPU-style fake
  millisecond figures were removed.
- Casting-weight bars are `currentWeight` from the same summary (ReflectionEngine), not a
  separate "regime casting optimizer."
- Digital Twin remains event-driven. Agent Workflow Theater remains educational (architecture
  loops; cards pulse on real WebSocket events).

**Still mocked on this tab (unchanged):** Multi-Agent Dialogue Graph, swarm transcripts,
hyperparameter "Live Hot-Reload," heatmap/correlation theater, ChiefTrader ATOS worker grids
that never populate. Tab verdict stays **Mixed**, not Fully Real.

### 31.2 In-app Documentation Center

`src/components/DocumentationTab.tsx` now loads numeric thresholds from
`config/tradingSafety.json` and default weights from `config/agentWeights.json` (same files
production loads). Academy copy now states: EventBus → agents → ChiefTrader → RiskEngine → OMS →
Broker; HOLD can veto; `minIndependentAgreeingAgents`; live stop is
`stopLossAssumptionPct` **not ATR**; Kelly can suppress a Quant idea when Quant is on but
RiskEngine does not Kelly-size; gates include `argus_capital_allocation` and `daily_buy_notional`;
OMS idempotency is after RiskEngine; LIVE NO-GO; Quant/SMC/Bull-Bear env flags default off;
Observatory (not the fabricated Tracing tab) is the real trace UI.

Still static-by-design. Not a live telemetry surface.

### 31.3 Tab strip: sticky + desk order

`#tabs-navigation` is `sticky top-0`. Header is no longer the only sticky chrome.

Left-to-right groups: **Trade** (Dashboard, Mission Control, Holdings, Arena) → **Markets**
(News, Opportunity Feed, Scanner, Intelligence) → **Agents** (Network, Evaluation, Kronos,
Learning, Vec Memory) → **Ops** (Observatory, Activity, Diagnostics, Observability & Tracing) →
**System** (Validation, Deployment, Settings, **Documentation last**).

Documentation is no longer mid-strip. Tab *content* fabrication tallies are unchanged by reorder.

### 31.4 Why Kronos showed `KRONOS_UNAVAILABLE`, and what `npm run dev` now starts

KronosEngine / KronosForecastAgent call `LOCAL_AI_SERVICE_URL` (default `http://localhost:8008`)
— `scripts/local_ai_service.py` (Chronos-T5-mini + FinBERT). That process was **not** started by
`npm run dev` before this pass, so the Kronos tab's unavailable banner was correct, not a UI bug.

`scripts/devWithOpenAlice.ts` (`npm run dev`) now also:

| Companion | When it starts | Honest skip |
|---|---|---|
| Chronos/Kronos + FinBERT (`:8008`) | Port free and Python on PATH | `ARGUS_SKIP_CHRONOS=true`; missing Python/torch (`npm run setup:ai`) |
| Ollama (`:11434`) | Port free and `ollama` on PATH | `ARGUS_SKIP_OLLAMA=true` |
| OpenAlice Guardian | Checkout exists or `OPENALICE_ENABLED=true` | `ARGUS_SKIP_OPENALICE=true`; no sibling repo |
| IBKR Client Portal Gateway | `IBKR_GATEWAY_PATH` set | Unset path (cannot invent an install); 2FA still manual |

`npm run dev:server-only` and Playwright (`npx tsx server.ts`) do **not** spawn these. Ctrl+C
kills only children this script spawned. First Chronos load can take a minute; the Kronos tab now
re-polls `/api/v1/kronos/status` every 10s. GPU/memory tiles are no longer constructor `'0%'` /
`'0 MB'` (null / em dash until a real inspector exists). Historical MAE/RMSE remain
`DATA_UNAVAILABLE` — those series are still not stored.

Spawning the process does not mean Chronos is installed on a given machine. If Python/PyTorch/
`chronos-forecasting` are missing, the log says so and Kronos stays honestly unavailable. Other
agents continue. This does not validate a forecast edge.

### 31.5 Related additive work in the same engagement (not a score bump)

Already in code, recorded here so this file does not keep describing the pre-fix UI:

- Daily BUY notional RiskEngine gate (`DailyBuyNotional.ts`); paper unlimited when
  `maxDailyBuyNotionalDollars` is 0; LIVE uses `restrictedLiveMaxDailyBuyNotionalDollars`.
- Learned-rule text truncated into ChiefTrader **debate prompt only**
  (`debateLearnedRulesCount` / `debateLearnedRuleMaxChars`).
- Bull/Bear qualitative notes only if `QUANT_BULL_BEAR_ENABLED=true`; invented numerics still
  nulled by `parseResearchNote`.
- Market-data WS subscribe/reconnect fixes in `MarketDataWorker.ts` (does not bypass RiskEngine).

### 31.6 What this pass explicitly does not claim

- No change to Section 30 autonomous real-money **53% / NO-GO**.
- No claim that NewsAgent, Quant, or Kronos now has a validated edge.
- No claim that Observability & Tracing (`audit`) is real — Observatory remains the real trace UI.
- No second kill switch. Quant stays off unless env-enabled.

---
