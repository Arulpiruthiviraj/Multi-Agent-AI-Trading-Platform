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

**P4 - explicitly deferred, not forgotten:** the ~17 decorative dashboard panels, the real
`shiyu-coder/Kronos` model as a second forecaster, Trading Arena/Strategy Scanner/AI Model Lab UI builds.
