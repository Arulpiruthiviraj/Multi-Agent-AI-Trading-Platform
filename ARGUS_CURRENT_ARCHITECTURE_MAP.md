# ARGUS_CURRENT_ARCHITECTURE_MAP.md

**Date:** 2026-08-15. Read-only map of the running Node app. Not a rewrite plan.

## System of record

Single process: Express + Vite/static SPA + `ws`. Entry: `server.ts`. SPA: `src/App.tsx`. DB: SQLite `data/argus.db` via Drizzle.

**Live decision path (do not bypass):**

```
Alpaca / MARKET_DATA
  → TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent, QuantSignalAgent (off unless QUANT_ENGINE_ENABLED)
  → TRADE_IDEA_GENERATED
  → ChiefTraderAgent (weights, optional multi-model debate, two-agent confirmation)
  → CHIEF_APPROVED_IDEA
  → RiskAgent / RiskEngine (all gates recorded)
  → OrderManagementService
  → BrokerManager.getActiveBroker().placeOrder
  → trades table + ORDER_EXECUTED
```

**Not the live path:** `GET /api/v1/signals` (legacy simulation → `data/portfolio.json`). Do not merge it with SQLite trades.

## Quant backbone (opt-in)

`src/server/quant/` — indicators, RegimeEngine, MarketContext, 5 core strategies + experimental `SMC_LIQUIDITY_SWEEP`, GroupedScores, EV/Kelly, Monte Carlo, WalkForward, FailureClassification.

Live Quant: `QuantSignalAgent` (`QUANT_ENGINE_ENABLED`). SMC live inclusion: `QUANT_SMC_STRATEGY_ENABLED` (default off). Backtest: `BacktestEngine.runStrategyBacktest` via `findStrategy`.

## Safety that must stay authoritative

RiskEngine gates, CapitalAllocation (`settings.budget` ≠ broker cash), RestrictedLiveMode, OMS idempotency/crash recovery, Alpaca circuit breaker, PortfolioMonitor exits, PortfolioReconciliation pause-on-mismatch, kill switch (`emergency-stop`).

## AI

`AIRouter` only. Providers: Gemini, OpenAI, DeepSeek, Nvidia, OpenAI-compatible/Ollama. Local Chronos/Kronos via `ModelRuntimeManager`. OpenAlice optional MCP. `AIOutputValidator` coerces structured JSON. NewsAgent live accuracy **44.6%/242** — do not increase its power without calibration.

## Feature flags / config (not UI knobs)

`config/tradingSafety.json`, `eventNames.json`, `agentWeights.json`, `markets.json`, `smcConfluence.json`, `thesisInvalidation.json`, `noTradeReasons.json`, `bullBearResearch.json`.

## License note on TradingAgents

TauricResearch/TradingAgents is **Apache-2.0**. Argus must **not** copy large source trees. Concepts only; if any file were ever vendored, NOTICE/attribution would be required. This pass vendors **zero** TradingAgents source.
