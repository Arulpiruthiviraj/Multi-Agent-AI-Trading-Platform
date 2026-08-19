# Argus agent forensics

Distinguish **LIVE PIPELINE** (can emit `TRADE_IDEA_GENERATED` that ChiefTrader may approve) from **RESEARCH / SHADOW / TELEMETRY**.

Do not describe unused UI names as voters. **No classes:** SentimentAgent, OrderFlowAgent (UI labels only). **CODE-VERIFIED** CLAUDE.md.

Heartbeats: in-memory `pipelineAgentHealth.ts`. HTTP `GET /api/v1/system/pipeline-agents`.

---

## LIVE PIPELINE — idea agents

### TechnicalAgent

| Field | Value |
|---|---|
| File | `src/server/services/TechnicalAgent.ts` |
| Purpose | Deterministic RSI/MACD/Bollinger ideas |
| Trigger | `MARKET_DATA` |
| LLM | **None** |
| Symbols | Active MarketDataWorker symbols |
| BUY/SELL/HOLD | From indicator rules; HOLD if insufficient ticks |
| DB | `agent_predictions` if emitted |
| History | `config/quantThresholds.json` `technicalHistoryBars` = **50** before `checkStrategies`. **CONFIG-VERIFIED** |
| Failure | Bad ticker gated by EventBus |

### KronosForecastAgent (catalog id KronosEngine)

| Field | Value |
|---|---|
| File | `src/server/services/KronosForecastAgent.ts` |
| Purpose | Local Chronos-T5 forecast → idea |
| Trigger | `MARKET_DATA`; HTTP `:8008` `/health` |
| LLM | Chronos numeric (not AIRouter) |
| Cooldown | `kronosPredictionCooldownMs` 60000; 30+ ticks |
| Unavailable | Honest warning; **do not fabricate** forecasts |
| DB | `kronos_predictions` (confidence INTEGER) |
| Flag | Optional; Chronos down ≠ tradingBlocked by itself (DiagnosticService) |

### FundamentalAgent

| Field | Value |
|---|---|
| File | `src/server/services/FundamentalAgent.ts` |
| Schedule | `fundamentalAgentMs` 60000 |
| APIs | Alpha Vantage + `AIRouter.routeTask` (default plutus) |
| Rate limit | Shared AV budget 25/day; `external_data_cache` |
| Unavailable | HOLD / DATA_UNAVAILABLE (confidence 0) |
| DB | `agent_predictions`, `ai_calls`, `escalation_decisions` possible |

### MacroAgent

Same pattern; interval **75000** ms; macro AV types (CPI/Fed/unemployment) often `symbol` null in cache (GLOBAL).

### NewsEngine (NewsAgent)

| Field | Value |
|---|---|
| File | `src/server/news/NewsEngine.ts` |
| Schedule | `newsEngineMs` 10000 |
| Ideas | **DISABLED** unless `deskIntelligence.newsEmitsTradeIdeas` (default **false**). **CONFIG-VERIFIED** + tests |
| Still live | RSS/paid ingest, clusters, FinBERT/LLM sentiment, **news_veto** for RiskEngine |
| `keepsBackgroundPipeline` | true — clustering continues when idea switch off |
| Hard veto | If an idea **were** emitted, NewsAgent HOLD with confidence > 0 penalizes (`consensusHardVetoAgents`) |

### QuantSignalAgent (QuantEngine)

| Field | Value |
|---|---|
| File | `src/server/services/QuantSignalAgent.ts` |
| Flag | `QUANT_ENGINE_ENABLED=true` at **call time** (runtime overlay may apply) |
| Interval | `quantCycleIntervalMs` 300000 |
| Ideas | Only if EV/Kelly allow suppress-or-emit path; experimental strategies need their env flags |
| DB | `quant_assessments` every cycle; idea optional (`emitted_trade_idea`) |
| Kelly | Suppresses **ideas only**. RiskEngine does **not** size from Kelly |

---

## LIVE PIPELINE — always-on (not idea generators except exits)

### ChiefTraderAgent

Weighted consensus + optional debate. See [ARGUS_CONSENSUS_FORENSICS.md](ARGUS_CONSENSUS_FORENSICS.md). Cannot disable from Mission Control.

### RiskValidationAgent / RiskEngine

Thin forwarder + 24 gates. Cannot disable.

### OrderManagementService

Sole `placeOrder`. Cannot disable.

### PortfolioMonitor (ideas as PortfolioManager)

~60s exit scanner. SELL ideas skip quorum. See [ARGUS_PORTFOLIO_EXIT_FORENSICS.md](ARGUS_PORTFOLIO_EXIT_FORENSICS.md).

### MarketDataWorker

Feed always started at boot. Not an idea agent.

---

## Conditional / advisory

### BullResearcher / BearResearcher

Only if `QUANT_BULL_BEAR_ENABLED`. Bear HOLD can veto. Numeric LLM fields nulled (`inventedNumericFieldsRejected`). **Not** default voters.

### OpenAlice

Fire-and-forget after approval. Never blocks. Table `openalice_verifications`. Untrusted sibling.

### ExplainabilityAgent

UI copy (`llama3.2:1b`). `explainability_reports`. Not a vote.

### ReflectionEngine

~60s. Writes `agent_predictions` (on each idea), updates weights, `learned_rules` truncated into **debate prompt only**.

---

## RESEARCH / SHADOW / TELEMETRY — not live voters

| Component | Why |
|---|---|
| `src/server/strategiesEngine/` | SHADOW / ANALYSIS_ONLY; does not import ChiefTrader/Risk/OMS/EventBus |
| MarketRegimeAgent | Exists as a service; **do not describe as a live voter** (CLAUDE.md). `MARKET_REGIME_DETECTED` may still fire — **PARTIAL** coupling |
| AdvancedQuantEngines | Unused as voter |
| EliteTraderDecision / desk scores | Advisory / UI (`GET /api/v2/desk/intelligence`) |
| BacktestEngine / VectorBT / parquet | Research. SAME_BAR_CLOSE not promotable; NEXT_BAR_OPEN is the promotion-adjacent research path |
| Opportunity discovery | Default off |
| Telemetry pulse | UI animation |

---

## Shared idea output contract

`emitTradeIdea({ traceId, symbol, side, confidence 0–1, reasoning, agent, currentPrice? })`.

Confidence never 0–100 mistaken as 85. Fail-closed malformed AI → HOLD 0.

Weights bootstrap: `config/agentWeights.json` then `agent_performance_stats.currentWeight`.
