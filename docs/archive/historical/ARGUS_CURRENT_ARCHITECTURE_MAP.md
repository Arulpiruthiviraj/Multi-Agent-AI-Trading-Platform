# ARGUS_CURRENT_ARCHITECTURE_MAP.md

**Date:** 2026-08-15. Map of the running Node app. Not a rewrite plan. Ground-truth for *current* wiring; older ARGUS_PHASE* / PRE_IMPLEMENTATION docs are snapshots unless they have an errata.

## System of record

Single process: Express + Vite/static SPA + `ws`. Entry: `server.ts`. SPA: `src/App.tsx`. DB: SQLite `data/argus.db` via Drizzle.

**Live decision path (do not bypass):**

```
Alpaca / MARKET_DATA
  → TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent,
    QuantSignalAgent (no-op unless QUANT_ENGINE_ENABLED=true)
  → TRADE_IDEA_GENERATED
  → ChiefTraderAgent (weights, optional multi-model debate, two-agent confirmation, debate HOLD veto)
  → CHIEF_APPROVED_IDEA
  → RiskAgent / RiskEngine (all gates recorded, including argus_capital_allocation)
  → OrderManagementService
  → BrokerManager.getActiveBroker().placeOrder
  → trades table + ORDER_EXECUTED
```

**Not the live path:** `GET /api/v1/signals` (legacy simulation → `data/portfolio.json`). Do not merge with SQLite trades.

## Quant backbone (opt-in)

| Piece | Path | Default |
|---|---|---|
| Indicators (trend/momentum/vol/volume/S/R/priceAction) | `src/server/quant/indicators/` | Used when Quant runs |
| SMC pattern engines | `indicators/smc.ts` | Computed on Quant/backtest context; strategy experimental |
| Regime / market context | `RegimeEngine.ts`, `MarketContext.ts` | Quant only |
| Core strategies | `StrategyEngine.CORE_STRATEGIES` (5) | Live evaluateAll |
| Experimental SMC strategy | `EXPERIMENTAL_STRATEGIES` | Live only if `QUANT_SMC_STRATEGY_ENABLED=true`; backtest via `findStrategy` |
| Feature facade | `QuantitativeFeatureEngine.ts` | `quantDetail.featureSnapshot` |
| TradeThesis | `quant/thesis/assembleTradeThesis.ts` | `quantDetail.tradeThesis` |
| EV gate | `QuantSignalAgent` + `ExpectedValue.ts` | Refuses strategy ideas without sample / non-positive EV |
| Backtest | `BacktestEngine.runStrategyBacktest` | Long-only |

## Position monitoring

`PortfolioMonitor` + `evaluateThesisInvalidation` (`config/thesisInvalidation.json`). Exits are SELL *ideas*, not direct broker calls.

## Safety that must stay authoritative

RiskEngine gates, CapitalAllocation (`settings.budget` ≠ broker cash), RestrictedLiveMode, OMS idempotency/crash recovery, Alpaca circuit breaker, PortfolioReconciliation pause-on-mismatch, kill switch (`emergency-stop`).

## AI

`AIRouter` only. Gemini, OpenAI, DeepSeek, Nvidia, OpenAI-compatible/Ollama. Chronos/Kronos via `ModelRuntimeManager`. OpenAlice optional MCP. `AIOutputValidator` coerces JSON. `parseResearchNote` (Bull/Bear) exists; **not** in ChiefTrader unless `QUANT_BULL_BEAR_ENABLED=true`. NewsAgent live accuracy **44.6%/242**.

## Config JSON (reviewed files, not UI knobs)

`tradingSafety.json`, `eventNames.json`, `agentWeights.json`, `markets.json`, `smcConfluence.json`, `thesisInvalidation.json`, `noTradeReasons.json`, `bullBearResearch.json`, `consensusFixtures.json`.

## License note on TradingAgents

TauricResearch/TradingAgents is **Apache-2.0**. Argus vendors **zero** of that source. Concepts only.

## Agent Network UI

- `DigitalTwinVisualizer` — live node/edge glow from real WebSocket events only.
- `AgentWorkflowTheater` — per-agent motion scenes on the Agent Network tab. Looping stages are **educational architecture**, not a fake tick feed. Matching EventBus events pulse the corresponding card.
