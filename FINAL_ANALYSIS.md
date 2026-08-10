# Argus Autonomous Trading Platform — Technical & Functional Analysis

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
| 8 | Agent Network (`agents`) | 🟡 Mixed | `DigitalTwinVisualizer` core is real/event-driven (confirmed, extended this session); the "Performance Threshold Alert" banner above it reads a variable literally named `mockWinRateData` — hardcoded flat per-agent values over 30 fabricated days |
| 9 | News Intel (`news`) | 🟢 Real (one decorative card) | Header stats, Event Clusters, Breaking News Feed, and Source Health/Provider Statistics are all real (`/api/v1/news/timeline`, `/articles`, `/providers`, with honest `'N/A'`/`'Never'` fallbacks); one "Ticker Impact & Memory Timeline" card is purely decorative with no state/fetch/props at all |
| 10 | Intelligence (`intelligence`) | 🟠 Likely fake in practice | Every metric falls back to a hardcoded default; backend population of the field it prefers (`autoBotConfig.engines`) was not confirmed to exist, so the hardcoded fallback likely renders permanently |
| 11 | Learning & Evolution (`learning`) | 🔴 100% fake | Hardcoded stat row ("Mistakes Corrected: 14," "Models Retrained: 3," "Alpha Generated by RL: +$2.4k") and strategy scorecard, no state, no fetch — despite a real backend (`ReflectionEngine`, `agent_performance_stats`) that could power this and doesn't |
| 12 | VEC Event Memory (`memory`) | 🟡 Real core, one fake chart | Search box, Precedent Analysis results, and feedback buttons are real (`/api/v1/event-memory`, `/feedback`); `VectorClusteringMap` (t-SNE scatter) is a hardcoded 12-crisis sample array, not derived from any real embedding computation — no embeddings/vector-store infrastructure exists anywhere in this codebase |
| 13 | Activity Log (`activity`) | 🟢 Real | Full read confirms no fabricated elements — log table and CSV export both operate on real `autoBotConfig.history` |
| 14 | Observability & Tracing (`audit`) | 🔴 100% fabricated + dead buttons | Fully hardcoded trace/timeline/LLM-debate/fill; "Rewind"/"Forward"/"Export Trace" have no `onClick` at all. Complete, exact duplicate of what Observatory (Tab 3) already does for real — the easiest fix in the app is deleting this and redirecting to Tab 3, since the real backend it should show already exists |
| 15 | Documentation (`documentation`) | ⚪ Static by design | Reference content, not misrepresented as live |
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
1. Auth bypass on unset `AUTH_PASSWORD` (15.12).
2. `transactions.status` never reaches a terminal state (15.1) - undermines this session's own
   observability work if not fixed; every transaction looks permanently "in progress."
3. No verified-working on-disk backup existed at audit time despite real scheduled backup code
   (15.13/data-safety incident) - must be verified as part of any pre-production checklist.

**High:**
4. 7 UI tabs are majority-to-fully fabricated theater with no visual distinction from the real ones
   (15.20) - corrected upward from an initial count of 5 after full-file re-reads found Trading Arena
   (≈10 of ~15 widgets fake, including a trade-execution button that never calls a broker) and
   Strategy Scanner were both undercounted; Holdings & Positions, Mission Control, Agent Network,
   VEC Event Memory, News Intel, and Settings & Keys each carry at least one real-looking but fully
   fabricated widget inside an otherwise-real tab.
5. Dead hardcoded-key duplicate `EncryptionService.ts` file (15.12).
6. No rate limiting anywhere (15.12).
7. Failed DB migrations don't halt boot (15.13).
8. `npm audit`: 8 high-severity dependency vulnerabilities (15.12).

**Medium:**
9. NewsAgent's real, demonstrated overconfidence (34.2% actual accuracy at 80-90% stated
   confidence) - should reduce its consensus weight or gate its confidence, not ignore it.
10. FundamentalAgent/MacroAgent contributing zero real signal in this deployment.
11. Backtest engine doesn't model commissions/partial-fills/corporate-actions; position sizing
    inconsistent with live RiskEngine.
12. No look-ahead-bias unit test despite a real, working guard.
13. Docker container runs as root.
14. Market-data reconnect is flat-interval, not exponential backoff.
15. Frontend bundle is a single 3MB chunk, no code-splitting.

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
1. Fix the `AUTH_PASSWORD`-unset authentication bypass (P0).
2. Fix `transactions.status` so decision outcomes are actually queryable (P0).
3. Verify a real, tested, working backup/restore procedure exists (P0 - this pass found none did).
4. Accumulate a real, multi-week paper-trading sample specifically evaluating the AI-consensus
   layer (P3) - the technical-rules backtest that exists today has never cleared its own
   significance floor, and NewsAgent's only real large sample shows negative Sharpe.
5. Either fix or formally exclude FundamentalAgent/MacroAgent from consensus weighting until they
   produce real evaluated signal (P3/P6).

None of this requires a rewrite. The backend built and hardened across this engagement is real and
substantially more capable than an "attractive dashboard" - the risk here is specifically that the
UI's fabricated tabs get mistaken for validated capability by someone who hasn't read this audit.
