# Argus Autonomous Trading Terminal

> **Multi-Agent AI Trading Platform** — an experimental Node/Express + React application that runs a technical/news/fundamental/macro agent pipeline through a weighted consensus and a real ATR-based risk engine, with real Alpaca paper/live execution.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61dafb)](https://react.dev/)

---

## ⚠️ Read this before anything else

This README, and every other `.md` file in this repository, was rewritten on **2026-08-08** after a full source-level audit (every claim below was checked against `server.ts`, `src/server/**`, `src/App.tsx`, the SQLite schema, and the migrations — not against prior documentation). Previous versions of these docs described a system that doesn't exist in this codebase: a fully working Kronos forecaster, five working brokers, live cost tracking, and a setup wizard that gates trading. **None of that is true of the current code.** See [AI_CONTEXT.md](./AI_CONTEXT.md) for the full current-state reference and the exact file/line evidence for every claim in this document.

**Production readiness: not production-ready.** There are zero automated tests, three of five broker adapters throw on the first real order, the flagship Kronos forecasting feature cannot produce a result under any configuration, and authentication is disabled by default. Use this for local experimentation with Paper trading only.

---

## 🎯 What Argus actually is

Argus is a single Node.js process (Express + a raw `ws` WebSocket server) plus a React 19 SPA. A set of independent background workers analyze market ticks, news, and macro/fundamental data on their own timers and publish "trade ideas" onto an in-process `EventEmitter` (`EventBus`). A consensus class weighs the ideas, a risk engine sizes and vetoes the trade against a broker's real portfolio, and an order-management service submits it to whichever broker is active.

**There are two separate execution surfaces in this codebase**, and it matters which one you're looking at:
1. **The real agent pipeline** — `MarketDataWorker` → `TechnicalAgent`/`NewsEngine`/`FundamentalAgent`/`MacroAgent`/`PortfolioMonitor` → `ChiefTraderAgent` → `RiskEngine` → `OrderManagementService` → broker. This is the one described in this doc set going forward.
2. **A legacy simulation endpoint**, `GET /api/v1/signals` in `server.ts`, which builds nine hardcoded signal objects, votes by counting, and executes directly against Alpaca's REST API with its own separate ledger (`data/portfolio.json`). It bypasses the risk engine, the broker abstraction, and the `trades` table entirely. It still exists and some older UI panels still call it.

---

## ✅ What's real, 🔴 what's broken, ⚪ what's mocked

| Area | Status | Notes |
|---|---|---|
| Technical indicator agent (RSI/MACD/Bollinger) | ✅ Real | Pure math, needs Alpaca keys for tick data |
| News ingestion (3 RSS feeds) | ✅ Real | No API key required, always on |
| News ingestion (AlphaVantage/Finnhub/Polygon/FMP) | ✅ Real | Requires the respective API key |
| Chief Trader weighted consensus | ✅ Real | |
| Risk engine (ATR sizing, daily-loss/consecutive-loss/concentration circuit breakers) | ✅ Real | Falls back to a flagged flat 5% stop if there isn't yet enough bar history for a 14-period ATR |
| Alpaca broker (paper and live) | ✅ Real | Needs `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` |
| Internal paper simulator | ✅ Real (simulated fills) | Default broker |
| Questrade / Interactive Brokers / Coinbase adapters | 🔴 **Broken** | Every method returns zeros/`true`; `placeOrder()` throws `Not implemented` |
| Kronos forecasting engine | 🔴 **Broken** | The inference call unconditionally throws, and the agent listens for an event (`MARKET_DATA_UPDATED`) that nothing in the codebase ever emits. It cannot produce a result under any configuration. |
| AI provider cost tracking | ⚪ **Fake** | Every provider's `estimateCost()` returns `0`; every logged cost is `$0` regardless of real spend |
| Backtesting (`/api/v1/backtest`, `/api/v2/system/backtest`) | ⚪ **Mocked** | Both return hardcoded numbers regardless of input |
| ~9 frontend chart panels (win-rate, drawdown, benchmark, heatmap, etc.) | ⚪ **Mocked** | Static arrays defined in `App.tsx`, not backed by real data |
| Setup Wizard | 🟠 **Cosmetic** | Collects AI keys; does not persist across a refresh and has no backend enforcement power — the bot can run with or without it ever completing |
| Reflection/learning loop | 🟡 **Partial** | Writes agent-performance weights (real influence on consensus) and rule text to `learned_rules`, but the rule *text* is never re-injected into any agent's prompt |
| Authentication | 🟡 **Partial** | Real HMAC-signed sessions exist, but auth is fully **disabled** unless `APP_PASSWORD` is set, and the WebSocket has no auth at all regardless |
| Automated tests | 🔴 **None** | Zero test files, no test runner configured |

For the full audit with file:line citations, see [AI_CONTEXT.md](./AI_CONTEXT.md).

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ (20 LTS recommended)
- Optional: a Gemini/OpenAI/DeepSeek/NVIDIA/OpenRouter key for AI-scored news/fundamental/macro ideas
- Optional: Alpaca paper API keys for real market data and paper execution

### Installation

```bash
git clone <this-repo>
cd Multi-Agent-AI-Trading-Platform

npm install

cp .env.example .env
# Edit .env — see .env.example for the actual variables this app reads.
# Note: FINNHUB_API_KEY is used by FinnhubNewsProvider.ts but is not
# listed in .env.example; add it manually if you want that provider.

npm run dev
```

Open `http://localhost:5000` (the server now defaults to port 5000, overridable via `PORT`).

Database migrations run automatically on every startup (`src/server/db/index.ts` calls Drizzle's `migrate()` at import time) — there's no separate migration step to run. The `npm run db:migrate` script in `package.json` (`tsx database/migrate.ts`) points at a path that doesn't exist in this repo and will fail if invoked; ignore it.

**See [QUICK_START.md](./QUICK_START.md) for what the first-run experience actually looks like, including what the Setup Wizard does and does not do.**

---

## 📖 Documentation

Every file below was corrected during the 2026-08-08 audit pass. Where a doc still contains an aspirational/planned description, it's explicitly labeled `🔵 PLANNED — NOT IMPLEMENTED`.

- **[AI_CONTEXT.md](./AI_CONTEXT.md)** — master current-state reference (start here)
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** / **[SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md)** — actual component map
- **[DATA_FLOW.md](./DATA_FLOW.md)** / **[EVENTBUS.md](./EVENTBUS.md)** — real event names and listeners, including the ones that are silently mismatched
- **[API_REFERENCE.md](./API_REFERENCE.md)** — real routes, real ports, real request/response shapes
- **[DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md)** — actual 20-table schema
- **[RISK_ENGINE.md](./RISK_ENGINE.md)** — what `RiskEngine.ts` actually computes
- **[BROKER_ENGINE.md](./BROKER_ENGINE.md)** — which brokers work and which are stubs
- **[KRONOS.md](./KRONOS.md)** — exactly why Kronos cannot function
- **[FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md)** — real component/data wiring, including what's mocked
- **[AGENTS.md](./AGENTS.md)** / **[AI_AGENTS.md](./AI_AGENTS.md)** / **[AI_ROUTER.md](./AI_ROUTER.md)** — agent roster and AI routing, as implemented
- **[DOCUMENTATION_INDEX.md](./DOCUMENTATION_INDEX.md)** — full index

The historical point-in-time reports (`CODE_AUDIT_REPORT.md`, `FINAL_ANALYSIS.md`, `ARGUS_ANALYSIS_REPORT.md`, `ARGUS_FINAL_REPORT.md`, `IMPLEMENTATION_AUDIT.md`, `REMEDIATION_PLAN.md`) were left as-is; they're snapshots of an earlier state of the project, not living documentation — treat their specific numbers/claims as dated.

---

## 🏛️ System Architecture (as implemented)

```
React SPA (App.tsx, ~11K lines)
   │  REST (~90 routes) + 1 WebSocket (/ws, unauthenticated)
   ▼
Express (server.ts + configRoutes.ts + v2System.ts)
   │
   ▼
EventBus (Node EventEmitter singleton — no persistence, no replay)
   │
   ├─→ TechnicalAgent (real) │ NewsEngine (real) │ Fundamental/MacroAgent (real, key-gated)
   ├─→ PortfolioMonitor (real) │ KronosForecastAgent (broken — see KRONOS.md)
   └─→ AdvancedQuantEngines / MarketRegimeAgent (real math/LLM, output not consumed by any decision)
   │
   ▼
ChiefTraderAgent (weighted consensus + optional multi-provider AI debate)
   │
   ▼
AIRouter (5 real provider implementations, failover; cost tracking is fake — always $0)
   │
   ▼
RiskEngine (real ATR sizing + real circuit breakers against real trade history)
   │
   ▼
OrderManagementService → BrokerManager → { AlpacaBroker (real) | InternalPaperBroker (real sim) | Questrade/IBKR/Coinbase (stubs) }
   │
   ▼
SQLite (better-sqlite3 + Drizzle, data/argus.db, 20 tables)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the per-component breakdown and known startup gaps (e.g. `BrokerManager.initialize()` is never called from the server's own startup sequence).

---

## 💡 Design intent vs. current reality

The original design intent for this project (still worth knowing, since it explains the shape of the code):

1. **Self-documenting code** — most modules carry a header comment declaring inputs/outputs/dependencies. In practice many of these headers are generic boilerplate copy-pasted across files and don't describe the actual module.
2. **Provider agnostic AI** — real: all LLM calls do go through `AIRouter`. Cost-aware routing does not exist because cost tracking is fake.
3. **Event-driven architecture** — real for the agents that are wired up; several agents (Kronos, MarketRegimeAgent, AdvancedQuantEngines) publish events that nothing consumes.
4. **Security first** — API keys are encrypted at rest. The rest of "security first" (auth-by-default, WebSocket auth) is not implemented — see [AI_CONTEXT.md §19](./AI_CONTEXT.md).

---

## 🧪 Testing

There is no automated test suite for this application. `npm test` is not defined in `package.json`. A separate, fully disconnected Python reimplementation under `python-platform/` has one `pytest` file, but nothing in the running Node application calls that code.

**Manual testing only, and Paper mode only:**
```bash
# .env
PAPER_TRADING_ONLY=true
```
Note that `PAPER_TRADING_ONLY` is read by the legacy `/api/v1/signals` endpoint and by `AlpacaBroker`'s live/paper URL selection; it does not gate the real agent pipeline's own trading-mode setting (`settings.tradingMode`), which is set independently via the Settings UI or `POST /api/v1/autobot/toggle`.

---

## 🛡️ Risk Management

`RiskEngine.ts` (`src/server/engines/RiskEngine.ts`) currently implements:
- Real 14-period Wilder ATR computed from a live 1-minute bar aggregator built from real trade prints (falls back to a flat 5% stop, explicitly flagged in the response, if there isn't yet 15 bars of history)
- Real daily-loss and 3-consecutive-loss circuit breakers, recomputed from the `trades` table's realized P&L on every evaluation (not from in-memory counters)
- A real 30% single-symbol concentration cap against the broker's actual portfolio value
- A real high-impact-news veto (checks `news_clusters.impactScore` for the symbol within the last 4 hours)

**Not enforced despite being configurable in the UI:** `settings.takeProfitPct` and `settings.trailingStopPct` are shown in `GuardrailsPanel.tsx` but `PortfolioMonitorWorker` (the only code that scans open positions for exit criteria) uses hardcoded ±5%/-3% thresholds and never reads those settings.

See [RISK_ENGINE.md](./RISK_ENGINE.md) for the full breakdown.

---

## 🤝 Contributing

1. Read [AGENTS.md](./AGENTS.md) for the current agent-modification guidelines.
2. Before claiming a feature "works," verify it against the actual running code — this repository has a documented history of docs describing intended behavior instead of shipped behavior. Re-run a source audit rather than trusting prior `.md` files if you're unsure.
3. Add tests for new features — there are currently none, so any test is a net improvement.

---

## 📜 License

MIT License — see `LICENSE` file for details.

---

## ⚠️ Disclaimers

- **Not financial advice.** Educational software only.
- **No guarantees.** Past performance ≠ future results.
- **Not production-ready.** See the audit findings above and in [AI_CONTEXT.md](./AI_CONTEXT.md) before connecting any real broker credentials.
- **Paper mode only**, until the P0/P1 issues listed in [AI_CONTEXT.md §26](./AI_CONTEXT.md) are fixed (broker initialization at startup, non-functional broker adapters, auth-off-by-default).

---

**Last audited**: 2026-08-08 (source-level; see [AI_CONTEXT.md](./AI_CONTEXT.md) for methodology)
