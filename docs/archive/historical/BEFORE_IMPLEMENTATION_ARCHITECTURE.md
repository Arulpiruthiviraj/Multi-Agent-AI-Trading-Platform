# BEFORE_IMPLEMENTATION_ARCHITECTURE.md

**Written:** 2026-08-15 (read-only inventory; updated same day after Phase 16P replay honesty).  
**Ground truth scores:** `ARGUS_REAL_MONEY_READINESS.md` (Phase 15: **69% / NO-GO**). Later operational work in `ARGUS_PHASE16_READINESS_REPORT.md` raised software/ops slightly to **~71% autonomous / 15% trading-validation / NO-GO**. Those later points are **not** an edge.

This document does **not** claim Argus is real-money ready. It is the map of what already exists so new work is additive.

---

## 1. Existing components (do not replace)

| Layer | Source of truth |
|-------|-----------------|
| Process | Single Node process: `server.ts` + Express + `ws` + Vite SPA (`src/App.tsx`) |
| EventBus | `src/server/core/EventBus.ts` — per-listener try/catch (Phase 16A follow-up) |
| EventStore | `src/server/core/EventStore.ts` — ring buffer + `event_traces` |
| Decision path | Agents → `TRADE_IDEA_GENERATED` → `ChiefTraderAgent` → `CHIEF_APPROVED_IDEA` → `RiskAgent`/`RiskEngine` → `OrderManagement` → `BrokerManager` |
| Sizing | `PositionSizing.ts` (shared with backtest `run()`) |
| Restricted live | `RestrictedLiveMode.ts` — clamps LIVE caps down; identity in PAPER |
| Quant (optional) | `src/server/quant/*` + `QuantSignalAgent` (`QUANT_ENGINE_ENABLED`) |
| Local models | Ollama `:11434`, Chronos/Kronos `LOCAL_AI_SERVICE_URL` default `:8008`, OpenAlice MCP (off by default), IBKR Gateway (human 2FA, never spawned) |
| Model probe | `ModelRuntimeManager` — reuse if healthy; spawn only with env flags |
| Capital slice | `settings.budget` + `CapitalAllocation.ts` + RiskEngine gate `argus_capital_allocation` |
| Diagnostics | `src/server/diagnostics/*`, `GET /api/v2/diagnostics` |
| Visualization | `DigitalTwinVisualizer.tsx` — real WS events only |
| Kill switch | `TradingEngine.setTradingState` + `POST /api/v1/system/emergency-stop` / pause / resume |

**Legacy hazard (must not be treated as the real pipeline):** `GET /api/v1/signals` in `server.ts` can still hit Alpaca REST and `data/portfolio.json`.

---

## 2. Existing decision flow (live/paper)

```
Alpaca WS → MARKET_DATA
  → TechnicalAgent (timer/tick, RSI/MACD/BB)
  → NewsEngine / FundamentalAgent / MacroAgent / KronosForecastAgent (own timers)
  → QuantSignalAgent (off unless flagged)
  → TRADE_IDEA_GENERATED (parallel, not a new sequential DAG)
  → ChiefTraderAgent (weights, optional debate, min 2 independent agents, HOLD/AI veto)
  → RiskEngine (serialized gates; Argus allocation after sizing)
  → OMS → active broker placeOrder
  → fills → portfolio
  → PortfolioMonitor (60s; settings % or quant stop/target/thesis)
  → ReflectionEngine (closed SELL P&L only)
```

Agents **already run in parallel** on timers/`MARKET_DATA`. A new blocking Chronos→Kronos→OpenAlice DAG on every tick would change live latency and still would not authorize trades. **Do not replace this flow.**

Backtest: `BacktestEngine.run()` (technical rules + shared PositionSizing) and `runStrategyBacktest()` (named quant strategy, long-only). **AI/ChiefTrader consensus is not inside the backtester.** ReplayClock exists for anti-lookahead on bars. Point-in-time historical news/LLM outputs for 2019–2022 **do not exist** in this DB — historical AI replay is **UNTESTABLE**, not missing a UI widget.

---

## 3. Feature flags / env (existing)

| Flag | Effect |
|------|--------|
| `QUANT_ENGINE_ENABLED` | QuantSignalAgent on |
| `PAPER_TRADING_ONLY` | Paper force |
| `OPENALICE_ENABLED` + `OPENALICE_MCP_URL` | Optional verification |
| `ARGUS_START_LOCAL_MODELS` / `ARGUS_START_CHRONOS` | Optional process spawn |
| `OLLAMA_HOST` / `LOCAL_AI_SERVICE_URL` | Local endpoints |
| `tradingEngine.state.tradingMode` PAPER vs LIVE | RestrictedLiveMode only when LIVE |
| `AUTH_PASSWORD` | Auth; production refuses unauthenticated boot |

---

## 4. AI models (actual, not assumed)

| Id | Start command | Port | Health | Callers | Failure |
|----|---------------|------|--------|---------|---------|
| Ollama | `ollama serve` | 11434 | `/api/tags` | AIRouter OpenAI-compatible | Optional; cloud failover |
| Chronos/Kronos | `npm run ai:serve` (`scripts/local_ai_service.py`) | 8008 | `/health` | KronosEngine / KronosForecastAgent | Optional; throw with explain text |
| OpenAlice | External MCP | env URL | adapter healthCheck | ChiefTrader fire-and-forget | Never blocks orders |
| Cloud Gemini/OpenAI/etc. | API keys | remote | AIRouter health | All `routeTask` agents | Failover + `AI_PROVIDERS_EXHAUSTED` |

FinBERT is local sentiment in the news path when the same Python service is up.

---

## 5. Quant engines (existing)

`src/server/quant/`: RegimeEngine, MarketContext, 5 strategies, GroupedScores, ExpectedValue/Kelly (20-trade floor), FailureClassification, MonteCarlo, AccountSizeReport. **Not** a replacement for RiskEngine.

`RSIEngine` / `MACDEngine` / `TechnicalIndicators` reused, not duplicated in quant.

`AdvancedQuantEngines` / `MarketRegimeAgent` still produce events that **are not consumed** by ChiefTrader (documented CLAUDE.md).

---

## 6. Brokers

`BrokerManager`: InternalPaperBroker (default), Alpaca (unattended paper/live), IBKR CP Gateway, Coinbase (live only, no paper), Questrade read-only (`placeOrder` throws).

---

## 7. Risk controls (existing)

Emergency stop / pause, daily-loss 80% of limit, consecutive losses, portfolio drawdown, order rate, market hours (skip if no Alpaca clock), stale data, news veto, price validity, PositionSizing caps (20%/40%/50% + stop-assumption), sell-position-exists, Argus capital allocation, RestrictedLiveMode on LIVE.

**Kill switch UI already exists** (HALT / emergency-stop APIs). Do not add a second kill switch.

---

## 8. Database (27+ tables in `schema.ts`)

settings, trades, fills, portfolio, risk_assessments, risk_gate_results, transactions, consensus_*, event_traces, ohlcv_bars, backtest_runs, quant_*, agent_performance_stats, news_*, ai_*, kill_switch_events, openalice_verifications, …

DB file: `data/argus.db`. Migrations auto-run on import of `src/server/db/index.ts`. **Do not run `npm run db:migrate`.**

---

## 9. APIs / WS

`/api/v1/*` (`server.ts`, `configRoutes`, `systemRoutes`), `/api/v2/*` (`v2System.ts` including orchestration, diagnostics, quant, transactions). Wildcard EventBus → WebSocket.

---

## 10. Known gaps (honest)

- Gates 5/6/9/10 still FAIL (no OOS edge; NewsAgent 44.6%; zero organic closed paper trades).
- Historical AI replay impossible without point-in-time news/LLM logs.
- TechnicalAgent math vs `BacktestEngine.run()` still duplicated (parity PARTIAL).
- `market_hours` treats Alpaca-clock outage as skip, not block.
- No L2 → no pre-trade slippage from depth.
- Safety thresholds were **module-level magic numbers** (stale 5 min, consecutive 3, correlation 90d, disagreement 0.5, consensus 0.75) copied into tests as literals — **this is the change authorized after this inventory**.
- Restricted-live $5k/3 positions/$1k daily loss were intentionally **not API-tunable**. They may live in a reviewed config **file**, not a settings UI.

---

## 11. Files that must NOT be modified unless absolutely necessary

- `BacktestEngine.run` / `runStrategyBacktest` strategy math (parity).
- `RiskEngine` gate **order** and approve/reject semantics (only read thresholds from config).
- `OrderManagement` idempotency / crash recovery.
- `RestrictedLiveMode` clamp-never-loosen behavior.
- Broker `placeOrder` contracts.
- Do not delete `GET /api/v1/signals` without an explicit product decision.
- Do not enable LIVE or loosen RestrictedLiveMode via UI.

---

## 12. What this request asked vs what already exists

| Ask | Status before this config change |
|-----|----------------------------------|
| Local model start/health | IMPLEMENTED — NOT spawn-on-every-dev (flags) |
| Broker vs Argus $100 slice | IMPLEMENTED (`CapitalAllocation` + RiskEngine) |
| Sequential mega-pipeline | **Rejected** — agents already parallel; replacing would be a rewrite |
| Decision traces | PARTIAL — transactions + event_traces + DigitalTwin |
| Explain unavailable | IMPLEMENTED (`diagnostics` catalog) |
| Position monitor independent loop | IMPLEMENTED (`PortfolioMonitor` 60s) |
| Historical AI replay 2022 | **UNTESTABLE** — no PIT news/LLM |
| Prediction-vs-reality dashboard | PARTIAL — `PredictionOutcomeEvaluator` / paper report; insufficient sample |
| New kill switch | Already exists |
| Unrestricted live | **Must remain NO-GO** |

---

## 13. Authorized change after this document

Move operational/safety **thresholds** from scattered `const` literals into `config/tradingSafety.json`, loaded by `src/server/config/tradingSafety.ts`. Behavior stays numerically identical at current values. Tests must import the same config (or a helper that uses it) instead of repeating `0.45 / 2` or “5 minutes” as unexplained literals.

**Not in scope:** rewriting RSI periods, rewriting ChiefTrader, enabling live, fabricating historical LLM outputs.
