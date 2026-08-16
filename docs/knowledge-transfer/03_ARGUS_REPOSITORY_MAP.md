# 03 — Repository map

Glob of `src/**/*.{ts,tsx}` returns **744** paths on Windows (duplicates from `\` vs `/` are possible). Treat as **hundreds** of TypeScript files, not a precise unique count. Tests: **≥128** vitest files historically counted; glob of `*.test.ts`/`*.spec.ts` listed **257** hits with the same duplicate risk. Playwright: **1** spec (`e2e/moduleToggleParity.spec.ts`).

## Directories

| Path | Purpose | Live | Backtest | UI | Dead? |
|---|---|---|---|---|---|
| `server.ts` | HTTP, `/signals`, listen 3000 | Mix | No | Routes | Legacy path **BROKEN** vs live contract |
| `scripts/` | `devWithOpenAlice.ts`, Chronos, scans | Boot | No | No | |
| `src/App.tsx` | SPA | Consumes | Charts | Yes | |
| `src/components/` | Tabs/widgets | Mix | Mix | Yes | Some educational |
| `src/server/core/` | EventBus, auth, encryption, bootstrap | Yes | No | No | |
| `src/server/engines/` | Risk, trading, TA, backtest, AdvancedQuant, kronos | Mix | Yes | No | AdvancedQuant **DEAD as voter** |
| `src/server/services/` | Agents, OMS, MD, recon | Yes | No | No | MarketRegimeAgent **DEAD as voter** |
| `src/server/quant/` | Strategies, indicators, EV | Flag | `findStrategy` | Scanner | |
| `src/server/ai/` | Router, providers | Yes | No | No | |
| `src/server/news/` | RSS + APIs | Autobot | No | News | |
| `src/server/db/` | Schema 44 tables | Yes | ohlcv | No | |
| `src/brokers/` | Adapters | Yes | No | Settings | Questrade orders throw |
| `src/marketdata/` | Yahoo/Polygon adapters | **PARTIAL** vs Alpaca worker | Unknown | Unknown | |
| `config/` | Fail-boot JSON | Yes | Thresholds | Docs tab | |
| `drizzle/` | SQL migrations | Boot | | | |
| `e2e/` | Playwright | | | | |
| `docs/` | This pack | | | | |
| `archive/python-platform/` | Old Python | No | No | No | **DEAD** — Node never imports |
| `skills/` | Cursor skills | No | | | |

## Live-path files (traced)

`MarketDataWorker.ts` → `TechnicalAgent.ts` / `NewsEngine.ts` / `FundamentalAgent.ts` / `MacroAgent.ts` / `QuantSignalAgent.ts` / `KronosForecastAgent.ts` / `PortfolioMonitor.ts` → `ChiefTraderAgent.ts` → `RiskAgent.ts` → `RiskEngine.ts` → `OrderManagement.ts` → `BrokerManager.ts` → `AlpacaBroker.ts` | `InternalPaperBroker.ts`.

## Who calls whom (sketch)

- ChiefTrader listens to `TRADE_IDEA_GENERATED`.
- RiskAgent listens to `CHIEF_APPROVED_IDEA`.
- OMS listens to approved `RISK_ASSESSMENT_COMPLETED`.
- ReflectionEngine timer updates `agent_performance_stats.currentWeight` (ChiefTrader weights).
- PortfolioReconciliation timer vs broker positions.

Per-file class dumps of all 700+ files: **not enumerated here**; use the feature map in `29` and `rg`.
