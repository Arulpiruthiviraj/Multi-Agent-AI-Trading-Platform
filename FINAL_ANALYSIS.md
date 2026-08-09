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
  single-symbol concentration cap, a working (fixed this pass) high-impact-news veto, order idempotency,
  and real fill-price tracking.
- A real historical backtest + walk-forward validation engine — run against real Alpaca history. It
  currently shows **no out-of-sample edge** for the deterministic technical strategy on AAPL; this is a
  real, unfavorable, unfabricated result, not a defect in the engine.
- A real local AI stack (Ollama + a local Chronos time-series forecasting service) — the previously
  permanently-throwing Kronos forecaster now produces real forecasts.
- A real test suite (43 tests), real CI (GitHub Actions), and a real Docker/health-check deployment path.

**What is not yet real:**
- 17 dashboard visualization panels are still static/decorative (hardcoded arrays or
  `Date.now()`-seeded jitter) — explicitly deferred, not hidden.
- Only Alpaca can trade fully autonomously; Interactive Brokers is now a real adapter but requires human
  2FA roughly every 24h; Questrade and Coinbase order execution are stubs by design.
- Sector/correlation exposure limits, Monte Carlo backtest sensitivity, and a historical replay of the
  full AI-agent consensus (as opposed to just the deterministic technical rules) do not exist yet.

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
| Backtesting / walk-forward | Real, unfavorable result | Real Alpaca history; AAPL walk-forward shows no out-of-sample edge |
| AI cost tracking | Real | `estimateCost()` implemented with real published pricing per provider |
| Kronos/Chronos forecasting | Real | Local Chronos model via a persistent Python service; live-verified BUY/SELL/HOLD |
| Interactive Brokers | Real, but manual-2FA-gated | Real Client Portal Web API client; cannot run fully unattended |
| Paper→live confirmation gate | Real | Requires an exact confirmation phrase; previously not reachable at all |
| Automated tests | Real | 43 tests / 4 files (vitest), real CI |
| Local AI stack (Ollama/Chronos/FinBERT) | Partial | Setup + boot-time health check real; only Chronos is wired into a live agent so far |
| Questrade / Coinbase execution | Stub by design | `placeOrder()` throws; blocked from being selected as the active broker |
| ~17 dashboard visualization panels | Decorative | Static arrays / deterministic jitter; explicitly deferred |
| Sector/correlation exposure limits | Missing | Not built |

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
(`llama3.2`, `0xroyce/plutus`, a locally-built `fingpt`) and a real Chronos time-series forecasting
service. Only Chronos is wired into a live decision path so far (the Kronos forecaster). FinBERT
(sentiment) and XGBoost (a direction-probability input for TechnicalAgent) are installed and documented
as the next integration points but not yet wired into any agent.

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

---

## 7. Testing

- **Unit tests:** 43 tests across 4 files (vitest) — RiskEngine's gates, OrderManagement idempotency
  and fill-polling, ChiefTraderAgent consensus math, and a broker-adapter capability contract test.
  Previously zero test files existed anywhere in the repo.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`) runs lint + test + build on every push/PR.
- **`npm run lint`:** now actually runs `tsc --noEmit` — previously a no-op that printed a string.
- **Integration/E2E tests:** still not implemented.

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
- No demonstrated out-of-sample edge for the deterministic strategy (real walk-forward result, AAPL).
- `trades` table is empty as of the last live check — no real order history exists yet.
- Sector/correlation exposure limits do not exist.

**UI:**
- ~17 dashboard panels remain decorative — explicitly deferred by the user, not hidden.
- Two dashboard tabs (Global News Intelligence, System Activity Logs) are real and correctly wired but
  show empty because the background pipeline that feeds them (`SystemBootstrap.start()`) only runs when
  the AutoBot is toggled on, and nothing starts it unconditionally at boot. A secondary bug: the News
  tab's per-provider health stats are hardcoded and can't be trusted as evidence the pipeline is running.

**Explicitly deferred by the user this pass, not forgotten:**
- The real `shiyu-coder/Kronos` foundation model as a second forecasting backend (Chronos, a different
  model, is what's wired in today).
- A Model/Agent Lab AI-benchmarking harness.
- An "Evidence Aggregator" normalizing agent outputs (a partial spec was proposed but not completed).

---

## 10. Recommended Next Priorities

1. Either improve the deterministic strategy or validate it on a different symbol/universe before any
   live-capital conversation — the current one real backtest result argues against it.
2. Accumulate a real, non-empty paper-trading history before considering live capital at all.
3. Enable the AutoBot (or add an unconditional background-worker start path) so News Intelligence and
   Activity Logs actually populate, and fix the hardcoded provider-health stats alongside it.
4. Wire FinBERT/XGBoost into NewsEngine/TechnicalAgent, and route at least one agent's calls through the
   local Ollama stack, to realize the cost savings the local AI stack was built to enable.
5. Add sector/correlation exposure limits to the risk engine.
