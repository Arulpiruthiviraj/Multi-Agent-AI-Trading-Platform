# ARGUS — CURRENT ARCHITECTURE (FORENSIC AUDIT)

**Contract (do not bypass):** [`ARGUS_ARCHITECTURE_INVARIANTS.md`](ARGUS_ARCHITECTURE_INVARIANTS.md). This file is a 2026-08-18 forensic snapshot; prefer current code if they disagree.

**Evidence grades used in this document**

| Grade | Meaning |
|---|---|
| **CODE-VERIFIED** | Call path, listener, or config key exists in current source |
| **TEST-VERIFIED** | Covered by a current unit/invariant test |
| **DOCUMENTED** | Stated in `CLAUDE.md` / operator docs; not re-measured against live SQLite in this pass |
| **UNVERIFIED** | Could not be confirmed from wiring alone |
| **PARTIAL** | Real code exists but does not do the full named behavior |
| **UNWIRED** | Class/file exists but is not on the live BUY/SELL spine |
| **DISABLED** | Gated off by env/config default |
| **EXPERIMENTAL** | Live inclusion requires a per-strategy env flag at call time |
| **SIMULATED** | In-process broker/fill model, not a remote paper API |
| **PLANNED** | Spec/comment only; no runtime path |

This audit describes what Argus **actually does**, not what it should do.

---

## 1. Executive Summary

Argus (`package.json` name `my-money-miner`) is a **single-process Node.js multi-agent trading terminal**: Express + Vite SPA + raw `ws` + SQLite. The live decision path is:

```
Alpaca IEX WebSocket → MARKET_DATA
  → idea agents → TRADE_IDEA_GENERATED
  → ChiefTraderAgent (+ optional AI debate)
  → CHIEF_APPROVED_IDEA
  → RiskAgent → RiskEngine (24 gates, persist-then-emit)
  → OrderManagementService (sole production .placeOrder caller)
  → BrokerManager → active broker
  → trades/fills → PortfolioReconciliation hydrates local portfolio
  → PortfolioMonitor (~60s) may emit PortfolioManager SELL ideas
```

**CODE-VERIFIED.** Protected by `ARGUS_ARCHITECTURE_PROTECTION.md` and `src/server/architecture.protection.test.ts` / `src/server/research/phase21.invariants.test.ts`.

Argus is **not** a day-trading profit engine today.

| Operator hope | What the code actually does |
|---|---|
| Continuously hunt potential stocks | Default IEX universe is `config/markets.json` US.benchmarks: **SPY, QQQ, IWM, DIA**. Opportunity scanner (`ARGUS_OPPORTUNITY_LOOP_ENABLED`) defaults **false**, **subscribe-only**, `ideasEmitted: 0` (`src/server/continuous/OpportunityDiscovery.ts`). |
| Sell at the right time like a day trader | `PortfolioMonitor` sells on **+15% from average cost** (`settings.takeProfitPct` default 15) or **−5% from average cost** named “trailing stop” but **not** a peak trail. No RTH flatten, no VWAP scale-out, no partials. Reasoning says “Scaling out”; emit is a **full-position SELL idea**. |
| Sell when it will go down | TechnicalAgent / KronosForecastAgent can emit SELL *ideas*, but those still need **min 2 independent agents** and **0.75** weighted confidence unless the agent is `PortfolioManager`. Directional SELL on a name not held is not an exit. |
| Make money autonomously | Organic closed paper FILLED SELL P&L was **0** at the 2026-08-18 forensic snapshot (**DOCUMENTED** in `CLAUDE.md`; **UNVERIFIED** against this machine’s `data/argus.db` in this pass). LIVE is **`LIVE_NO_GO`**. |

**Final one-line verdict:** Argus is a **gated paper-capable execution terminal** with a real 24-gate RiskEngine and an honest (strict) consensus bar. It is **not** currently a continuous stock-discovery / session-aware profit-taking machine.

---

## 2. Technology Stack

| Layer | Actual stack | Evidence |
|---|---|---|
| Runtime | Node.js, TypeScript | `package.json`, `server.ts` |
| HTTP | Express | `server.ts` |
| SPA | React + Vite (`src/App.tsx`) | `src/App.tsx` |
| WebSocket | raw `ws` | `server.ts` |
| Events | Node `EventEmitter` singleton | `src/server/core/EventBus.ts` |
| DB | SQLite + Drizzle, WAL | `src/server/db/index.ts`, `src/server/db/schema.ts` (58 `sqliteTable(`) |
| Market data | Alpaca IEX WebSocket | `src/server/services/MarketDataWorker.ts` |
| Brokers | Alpaca REST, InternalPaper, IBKR Gateway, Coinbase CDP, Questrade OAuth (read-only) | `src/brokers/` |
| LLM | `AIRouter.getInstance()` only | `config/aiModels.json` |
| Chronos | optional local HTTP `:8008` | `KronosForecastAgent` / `scripts/local_ai_service.py` |
| Port | **3000 hardcoded** (`PORT` unused) | `server.ts` |
| Bind | `127.0.0.1` if `AUTH_PASSWORD` unset; `0.0.0.0` if auth set | `server.ts` / `CLAUDE.md` |

---

## 3. Component Map

Status column uses the grades above. **Runtime?** = whether Autobot `SystemBootstrap.start()` or `server.ts` boot actually starts it — not whether this audit observed a live process.

| Component | Location | Purpose | Runtime? | Called By | Calls | Status |
|---|---|---|---|---|---|---|
| SPA | `src/App.tsx` | Operator UI, 20 nav tabs | Yes (browser) | User | REST + WS | IMPLEMENTED (mixed REAL/MOCK widgets) |
| Express + WS | `server.ts` | HTTP, WS, boot | Yes | `npm run dev` | routes, BrokerManager, workers | IMPLEMENTED |
| EventBus | `src/server/core/EventBus.ts` | In-process events | Yes | Everywhere | listeners | IMPLEMENTED |
| SQLite | `src/server/db/` | Persistence | Yes (import) | services | better-sqlite3 | IMPLEMENTED |
| MarketDataWorker | `src/server/services/MarketDataWorker.ts` | IEX quotes/trades WS | Yes if Autobot started; stays up on Autobot stop | SystemBootstrap | EventBus `MARKET_DATA` | IMPLEMENTED |
| TechnicalAgent | `src/server/services/TechnicalAgent.ts` | RSI/MACD/BB ideas | Autobot + TRADING_ENABLED | pipelineAgentRuntime | `emitTradeIdea` | IMPLEMENTED |
| NewsEngine | `src/server/news/NewsEngine.ts` | RSS/news clusters; optional ideas | Clustering yes; ideas **DISABLED** | SystemBootstrap | news_clusters; ideas iff `newsEmitsTradeIdeas` | PARTIAL (catalyst/veto yes; votes default off) |
| FundamentalAgent | `src/server/services/FundamentalAgent.ts` | AlphaVantage + LLM ~60s | Autobot + TRADING_ENABLED | pipelineAgentRuntime | `emitTradeIdea` | IMPLEMENTED |
| MacroAgent | `src/server/services/MacroAgent.ts` | AlphaVantage + LLM ~75s | Autobot + TRADING_ENABLED | pipelineAgentRuntime | `emitTradeIdea` | IMPLEMENTED |
| QuantSignalAgent | `src/server/services/QuantSignalAgent.ts` | Strategy evaluateAll + EV filter | Only if `QUANT_ENGINE_ENABLED=true` | pipelineAgentRuntime | `emitTradeIdea` | DISABLED by default; EV often **0 emit** |
| KronosForecastAgent | `src/server/services/KronosForecastAgent.ts` | Local Chronos forecast | If started + Chronos up | pipelineAgentRuntime | `emitTradeIdea` | PARTIAL (honest unavailable if `/health` down) |
| ChiefTraderAgent | `src/server/services/ChiefTraderAgent.ts` | Consensus / debate | Listener always constructed | EventBus ideas | `emitChiefApproval` | IMPLEMENTED |
| EvidenceAggregator | `src/server/services/EvidenceAggregator.ts` | Weighted vote math | Used by ChiefTrader | ChiefTrader | none | IMPLEMENTED |
| RiskAgent | `src/server/services/RiskAgent.ts` | Forward CHIEF_APPROVED → RiskEngine | Constructor listener | EventBus | `evaluateRisk` | IMPLEMENTED (thin) |
| RiskEngine | `src/server/engines/RiskEngine.ts` | 24 gates + sizing | On each approval | RiskAgent | persist, emit | IMPLEMENTED |
| OMS | `src/server/services/OrderManagement.ts` | Sole `.placeOrder` | Autobot start | RISK_ASSESSMENT_COMPLETED | BrokerManager | IMPLEMENTED |
| BrokerManager | `src/brokers/BrokerManager.ts` | Active broker | Boot `initialize()` | OMS, recon | adapters | IMPLEMENTED |
| AlpacaBroker | `src/brokers/AlpacaBroker.ts` | Paper/live REST | If selected | BrokerManager | `paper-api` or `api.alpaca.markets` | IMPLEMENTED |
| InternalPaperBroker | `src/brokers/InternalPaperBroker.ts` | In-memory fills | Default if none selected | BrokerManager.tick from MARKET_DATA | none | SIMULATED |
| IBKR adapter | `src/brokers/InteractiveBrokersAdapter.ts` | Client Portal Gateway | If selected + 2FA | BrokerManager | local Gateway | PARTIAL (manual reauth) |
| CoinbaseBroker | `src/brokers/CoinbaseBroker.ts` | Live CDP | If selected | BrokerManager | Advanced Trade | LIVE-only; paper refuse |
| QuestradeBroker | `src/brokers/QuestradeBroker.ts` | Read-only | If selected | BrokerManager | OAuth | READ-ONLY (`placeOrder` throws) |
| PortfolioMonitor | `src/server/services/PortfolioMonitor.ts` | Exit ideas ~60s | Autobot start | SystemBootstrap | `emitTradeIdea` agent PortfolioManager | IMPLEMENTED (cost-basis TP/SL) |
| PortfolioReconciliation | `src/server/services/PortfolioReconciliation.ts` | Broker vs local ~300s | Autobot start | SystemBootstrap | hydrate `portfolio`; may pause | IMPLEMENTED |
| OpportunityDiscovery | `src/server/continuous/OpportunityDiscovery.ts` | Rank + subscribe | `server.ts` always starts worker | server boot | MarketDataWorker.subscribe | DISABLED default; never ideas |
| AutoTradeScheduler | `src/server/services/AutoTradeScheduler.ts` | Windowed Autobot toggle | server boot | `tradingEngine.toggle` | IMPLEMENTED (off unless settings) |
| AIRouter | `src/server/ai/` (router module) | All LLM | On debate / fund / macro | agents | providers | IMPLEMENTED |
| AdvancedQuantEngines | `src/server/engines/AdvancedQuantEngines.ts` | ATR/ADX telemetry | Autobot start | MARKET_DATA | `emitCalculation` only | UNWIRED to orders |
| MarketRegimeAgent | `src/server/services/MarketRegimeAgent.ts` | Regime event | Referenced in bootstrap (no `.start()`) | — | `MARKET_REGIME_DETECTED` | UNWIRED as voter |
| strategiesEngine | `src/server/strategiesEngine/` | Research DSL | Shadow runner optional | isolated | **never** Chief/Risk/OMS | RESEARCH-ONLY |
| OpenAlice | sibling + fire-and-forget after approval | Verification | optional | ChiefTrader | MCP | UNTRUSTED; does not place Argus orders |
| vibe-trading / autohedge / Fincept | siblings | Research UI spawn | optional `npm run dev` | orchestrator empties wallet keys | UNTRUSTED; no `placeOrder` |
| Replay / HistoricalReplayBroker | `src/server/replay/` | Research clock | Replay session | research | REPLAY fills | RESEARCH-ONLY |

---

## 4. Architecture Diagram (from actual wiring)

```
                    Alpaca IEX WS
                          │
                          ▼
                 MarketDataWorker
                  emit MARKET_DATA
                          │
          ┌───────────────┼───────────────────────────────┐
          ▼               ▼                               ▼
   TechnicalAgent   KronosForecastAgent            AdvancedQuantEngines
   (tick, 50 bars,  (optional Chronos)             (telemetry only)
    30s cooldown)
          │               │
          │         QuantSignalAgent ── QUANT_ENGINE_ENABLED + EV/R:R
          │         FundamentalAgent ── ~60s AlphaVantage+LLM
          │         MacroAgent       ── ~75s AlphaVantage+LLM
          │         NewsEngine ideas ── DISABLED (newsEmitsTradeIdeas:false)
          │               │
          └──────┬────────┘
                 ▼
        TRADE_IDEA_GENERATED
                 ▼
          ChiefTraderAgent
          EvidenceAggregator
          optional AIRouter.routeConsensus
                 │
                 ├── NO TRADE (DESK_NO_TRADE / explanation)
                 ▼
          CHIEF_APPROVED_IDEA
          (also: ManualOverride liquidate / execute-override / rebalance)
                 ▼
              RiskAgent
                 ▼
             RiskEngine
          24 gates recorded
          persistThenPublishAssessment
                 │
                 ├── persist fail → RISK_BLOCK, no OMS
                 ▼
       RISK_ASSESSMENT_COMPLETED (approved + qty>0)
                 ▼
                 OMS
          PENDING trades row
          authorizeProductionOrder
          BrokerManager.getActiveBroker().placeOrder
                 ▼
            Broker API / InternalPaper.tick
                 ▼
              fills ledger
           ORDER_FILLED / ORDER_EXECUTED
                 ▼
      PortfolioReconciliation (hydrate `portfolio`)
                 ▼
           PortfolioMonitor (~60s)
           TP / cost-stop / quant stop-target / thesis
                 ▼
        TRADE_IDEA_GENERATED agent=PortfolioManager SELL
                 ▼
        ChiefTrader isRiskExit (skip debate + min-2)
                 ▼
            RiskEngine → OMS → Broker   (SELL still gated)

AI/News/DB/UI sit beside the spine:
  AIRouter ← Fund/Macro/Debate/BullBear/Explainability
  NewsEngine clusters → RiskEngine news_veto
  SQLite ← traces, risk, trades, fills, consensus
  WebSocket wildcard → React
  OpportunityDiscovery → subscribe only (default off)
```

---

## 5. Data Flow

1. **Quotes in:** Alpaca IEX → `MarketDataWorker` → `eventBus.emit(MARKET_DATA)` (`config/eventNames.json`).
2. **InternalPaper fills:** `BrokerManager.wireInternalPaperTicksFromMarketData` calls `InternalPaperBroker.tick` on each quote (**SIMULATED** spread 0.05%).
3. **Ideas:** gated by `isLiveIdeaGenerationEnabled()` = `tradingState === 'TRADING_ENABLED' && tradingEngine.state.enabled` (`src/server/core/ideaGenerationGate.ts`). Risk-exit SELLs bypass this in ChiefTrader only.
4. **Universe:** `resolveIdeaUniverse()` = `getActiveSymbols()` else US benchmarks (`src/server/core/ideaUniverse.ts`).
5. **Consensus:** in-memory `recentIdeas` TTL `chiefTraderIdeaTtlMs` 60000 (`config/runtimeIntervals.json`).
6. **Risk persist-then-emit:** `RiskEngine.persistThenPublishAssessment` — persist failure **does not** emit `RISK_ASSESSMENT_COMPLETED` (**TEST-VERIFIED** P0.3).
7. **Orders:** OMS inserts PENDING `trades` then `placeOrder`. Timeout stays PENDING/UNKNOWN, never fabricated FILLED.
8. **Positions:** OMS does **not** insert `portfolio`. `PortfolioReconciliation` hydrates local `portfolio` from `broker.portfolio()`. **CODE-VERIFIED.** If recon has not hydrated, PortfolioMonitor sees zero holdings.

---

## 6. BUY Lifecycle (exact path)

Answers to the audit’s 29 questions:

1. **Market data enter:** Alpaca IEX WebSocket in `MarketDataWorker`.
2. **Receives it:** `MarketDataWorker` → EventBus `MARKET_DATA` (+ `MARKET_DATA_UPDATED`).
3. **Indicators:** `TechnicalAgent.analyzeTick` RSI/MACD/Bollinger/SMA (`quantThresholds.technicalHistoryBars` = **50**). Quant uses OHLCV via its own cycle. `AdvancedQuantEngines` computes ATR/ADX but **does not generate ideas**.
4. **Strategies evaluate:** `QuantSignalAgent.runCycle` every `quantCycleIntervalMs` **300000** iff `QUANT_ENGINE_ENABLED=true`. Live set = CORE five + experimental ids whose env is `'true'` at **call time** (`resolveStrategiesForLiveEvaluation`).
5. **Agents generating BUY ideas:** Technical, Fundamental, Macro, Kronos, Quant (if enabled and EV clears). News **does not** unless `deskIntelligence.newsEmitsTradeIdeas` (default **false**).
6. **Event:** `TRADE_IDEA_GENERATED` via `eventBus.emitTradeIdea` (gated by `gateTradeIdea` / `looksLikeListedTicker`).
7. **Receiver:** `ChiefTraderAgent.reviewIdea`.
8. **ChiefTrader evaluation:** upsert last vote per `(agent, symbol)`; optional debate if `adversarialDebateMode` and `confidence > debateTriggerConfidence` (0.6); then `evaluateConsensusSerialized`.
9. **Consensus math:** `EvidenceAggregator.aggregate` — see §11.
10. **Confidence threshold:** `tradingSafety.consensusApprovalThreshold` = **0.75**. Comparison is `result.confidence <= threshold` → reject (must **exceed** 0.75).
11. **Independent agents:** `minIndependentAgreeingAgents` = **2**. `ConsensusDebate` does not count. Unique `Set(agent)` on the winning side.
12. **Disagreement:** opposite side and hard-veto HOLD penalize by `disagreementPenalty` **0.5**. Typical Technical BUY vs Kronos SELL → **NO TRADE**.
13. **AI participate?** Optional `AIRouter.routeConsensus('ConsensusDebate')`; Fund/Macro use LLM for their ideas; Technical does **not**. Debate `successCount === 0` → fail-closed HOLD.
14. **After approval:** `eventBus.emitChiefApproval` → `CHIEF_APPROVED_IDEA`. Optional OpenAlice fire-and-forget. Mints `transactionId` via `recordConsensusTransaction`.
15. **RiskAgent:** listens `CHIEF_APPROVED_IDEA`, calls `riskEngine.evaluateRisk`. No extra pre-gates.
16–17. **Gates / order:** see §13 / `config/riskGateOrder.json`.
18. **Rejection:** first failure in evaluation order is reported; **all** gates still recorded. Also persist failure.
19. **After risk approval:** `RISK_ASSESSMENT_COMPLETED` (`emitRiskAssessment`).
20. **OMS receive:** constructor `eventBus.on('RISK_ASSESSMENT_COMPLETED')` → `executeOrder` if `approved && maxQuantity > 0`.
21. **Trade persisted:** PENDING `trades` insert **before** broker call.
22. **Broker called:** after `authorizeProductionOrder` (P0.1).
23. **Which broker:** `BrokerManager.getActiveBroker()`. Default **InternalPaperBroker** until a connection is selected.
24. **Endpoint:** Alpaca paper `https://paper-api.alpaca.markets` (`config/networkEndpoints.json`); live host `https://api.alpaca.markets` refused without LIVE arm. InternalPaper has no HTTP.
25. **Order identity:** OMS `orderId = crypto.randomUUID()`; `clientOrderId` passed for crash recovery (DEF-05/06).
26. **Fills:** `insertIncrementalFill` unique `(order_id, cumulative_quantity)` (P0.4). `recordFillProgress` emits `ORDER_FILLED`. Partial fills are incremental. Broker throw → UNKNOWN, not REJECTED.
27. **Position persisted:** broker book + recon hydrate of `portfolio`. Not OMS-direct.
28. **P&L:** broker portfolio fields; monitor uses `(live - averagePrice) / averagePrice * 100`. Closed P&L from fills/trades — organic soak **DOCUMENTED** as 0.
29. **Reconciliation:** `portfolioReconciliationMs` **300000**. Broker fetch first, then local. Hydrate-before-pause for `MISSING_LOCALLY`. `autoFlattenOnReconciliationMismatch: false`. Never auto-resume pause.

**Files:** `MarketDataWorker.ts`, `TechnicalAgent.ts`, `QuantSignalAgent.ts`, `ChiefTraderAgent.ts`, `EvidenceAggregator.ts`, `RiskAgent.ts`, `RiskEngine.ts`, `OrderManagement.ts`, `BrokerManager.ts`, `liveOrderAuthorization.ts`, `PortfolioReconciliation.ts`.

---

## 7. SELL / Exit Lifecycle

Executable exits are **SELL ideas on EventBus**, not `broker.closePosition` from HTTP (**TEST-VERIFIED** `phase21.invariants.test.ts`).

```
local portfolio rows (after recon hydrate)
        ↓
PortfolioMonitor.reviewPortfolio every portfolioMonitorMs 60000
        ↓
needs marketDataWorker.getLatestPrice — else NO_PRICE, no SELL
        ↓
if Quant lot: honor quantTargetPrice / quantStopPrice / thesisInvalidation.json
        else: PnL% vs settings.takeProfitPct (15) and trailingStopPct (5)
        ↓
emitTradeIdea { agent: PortfolioManager, side: SELL }   // riskExitAgent
        ↓
ChiefTrader isRiskExit → skip debate and min-2; still emit CHIEF_APPROVED_IDEA
        ↓
RiskEngine (SELL: autobot_enabled does not block; sell_position_exists required)
        ↓
OMS → Broker
```

**Needs a live IEX tick** on that symbol. GLD/NVDA only exit if subscribed **and** ticked.

Reasoning text says “Scaling out”. **CODE-VERIFIED:** emit is a **full quantity SELL idea**, not a partial.

### Exit capability matrix (do not assume)

| Capability | Status | Evidence |
|---|---|---|
| Take profit (% from **average cost**) | **IMPLEMENTED** | `PortfolioMonitor` `PnL > takeProfitPct`; schema default 15; fallback `tradingSafety.fallbackTakeProfitPct` 15 |
| Stop loss vs cost | **IMPLEMENTED** (named HARD_STOP) | `PnL < -trailingStopPct` (default 5) |
| Trailing stop from **peak** | **NOT IMPLEMENTED** | Comparison is vs `holding.averagePrice`, not high-water. Name `TRAILING_STOP` is **PARTIAL** / misleading |
| Quant strategy target/stop | **IMPLEMENTED** for Quant-originated FILLED BUY lots | `trades.quantTargetPrice` / `quantStopPrice` |
| Thesis invalidation | **IMPLEMENTED** for lots with `quantInvalidationJson` | `src/server/quant/analysis/ThesisInvalidation.ts` + `config/thesisInvalidation.json` |
| Momentum reversal as **position exit** | **NOT IMPLEMENTED** as monitor path | Technical/Kronos SELL are **entry-style votes** (min 2, 0.75) unless holding and PortfolioManager fires |
| Technical reversal exit | **NOT IMPLEMENTED** dedicated | Same |
| News deterioration exit | **NOT IMPLEMENTED** | `news_veto` is RiskEngine **direction-blind** block on **new** trades, not an exit |
| Fundamental deterioration exit | **NOT IMPLEMENTED** | Fund agent ideas, not position monitor |
| Regime change exit | **NOT IMPLEMENTED** as PortfolioMonitor rule | thesis may include regime for Quant lots only |
| Time-based / RTH flatten / day-trader scale-out | **NOT IMPLEMENTED** | No 15:55 flatten, no VWAP clip, no session P&L target |
| Portfolio risk reduction (drawdown gates) | **PARTIAL** | Gates **block new BUY**; they do not themselves emit SELL |
| Daily loss protection | **PARTIAL** | `daily_loss` gate blocks new risk; not an auto-flatten |
| Emergency liquidation | **IMPLEMENTED** | Kill switch / `POST /api/v1/portfolio/liquidate` → `PipelineFlatten.submitPipelineSells` → `CHIEF_APPROVED_IDEA` ManualOverride → **still RiskEngine+OMS** |
| Better-opportunity reallocation | **PARTIAL** | `POST /api/v1/portfolio/rebalance` emits pipeline BUY/SELL vs drift (`PortfolioRebalance.ts`). Not an autonomous “sell winner to buy better name” scanner |
| Overlay exit cooldown | **DISABLED** default | `ARGUS_PORTFOLIO_INTEL_ENABLED` / `canEmitPortfolioExitIdea` |

**Day-trader gap (product vs code):** locking a swing-style **+15% from cost** is the only general “sell to realize a gain” path. There is no tape-reading, no 0.3–1% scalp, no scale-out into strength, no “I’ve made enough today.” Selling because Kronos/Technical predict down is a **separate** consensus BUY/SELL vote, not an owned-position profit-taking engine.

---

## 8. Continuous Runtime Loop

`SystemBootstrap.start()` (`src/server/core/SystemBootstrap.ts`) when Autobot enables:

OMS, Alerting, AI failure breaker, AdvancedQuantEngines, MarketDataWorker, PortfolioMonitor, PortfolioReconciliation, NewsEngine clustering, Reflection (~60s), prediction outcomes, training examples, system metrics (2s), DB backup (1d), market-data cross-check (60s), Kronos init, `startEnabledIdeaAgents()`.

`server.ts` also starts `opportunityDiscoveryWorker` (idle unless flag) and `AutoTradeScheduler` (60s; no-op unless schedule enabled).

**Market data stays up when Autobot stops.** Idea generation does not (`ideaGenerationGate`).

### Loop 1 — new opportunity (actual)

```
IEX ticks on subscribed symbols (default 4 ETFs)
        ↓
Technical: after 50 prices, then at most every technicalEvaluationCooldownMs 30000
Kronos: if Chronos healthy, cooldown kronosPredictionCooldownMs 60000
Fund ~60s / Macro ~75s on resolveIdeaUniverse()
Quant ~300s if QUANT_ENGINE_ENABLED (often 0 emit: EV sample < 20 closed trades)
        ↓
ChiefTrader: typically Technical vs Kronos disagreement → NO TRADE
        ↓
Rare CHIEF_APPROVED_IDEA → RiskEngine → maybe OMS
```

Opportunity loop does **not** sit on this path unless `ARGUS_OPPORTUNITY_LOOP_ENABLED=true`, and even then it **only subscribes**.

### Loop 2 — existing positions (actual)

```
Every 60s: SELECT portfolio
        ↓
No row / qty 0 → nothing
No live price → NO_PRICE
Else TP / cost-stop / quant rules → PortfolioManager SELL
        ↓
ChiefTrader risk-exit → RiskEngine → OMS
```

**Verified whether this happens today:** the **wiring** is real. Whether Loop 1 produces BUYs in a given session is **historically often zero** (quorum + 4-ETF universe + Kronos conflict). Loop 2 only runs on **hydrated** local positions with ticks. This audit did **not** observe a 6.5h live session (**UNVERIFIED** as runtime trace; **CODE-VERIFIED** as timers).

---

## 9. Agent Architecture

| Agent | Purpose | Inputs | Outputs | Frequency | Data | AI | Ideas? | BUY | SELL | HOLD | Veto | Direct execute |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TechnicalAgent | RSI/MACD/BB rules | MARKET_DATA | TRADE_IDEA_GENERATED | tick + 30s cooldown after 50 bars | IEX | No | Yes | Yes | Yes | — | No | No |
| NewsEngine/NewsAgent | Clusters + optional ideas | RSS/APIs | news_clusters; ideas **off** | newsEngineMs 10000 | news APIs | optional fingpt | Default **No** | if flag | if flag | — | Hard veto **if** it votes HOLD | No |
| FundamentalAgent | Valuation | AV + LLM | ideas | 60000 | AV | plutus | Yes | Yes | Yes | Yes (incl DATA_UNAVAILABLE) | Soft HOLD not hard veto | No |
| MacroAgent | Macro | AV + LLM | ideas | 75000 | AV | plutus | Yes | Yes | Yes | Yes | Soft | No |
| QuantSignalAgent | evaluateAll + EV | OHLCV | ideas or DESK_NO_TRADE | 300000 | bars | contradiction review only | If EV/R:R | Yes | long-only backtest; live side from strategy | — | AI contradiction can block Chief | No |
| KronosForecastAgent | Chronos | ticks | ideas | cooldown 60s | local :8008 | Chronos numeric | If healthy | Yes | Yes | — | No | No |
| ChiefTraderAgent | Consensus | ideas | CHIEF_APPROVED_IDEA or no-trade | on ideas | weights DB | Debate | No (approves) | Approves | Approves | Debate HOLD blocks | Debate/News HOLD | No |
| RiskAgent | Forward | CHIEF_APPROVED | evaluateRisk | on approval | — | No | No | — | — | — | No | No |
| PortfolioManager | Exits | portfolio + tick | SELL idea | 60000 | local portfolio | No | SELL only | No | Yes | No | Skips quorum | No |
| AIRouter | LLM | prompts | content | on call | providers | Yes | No | No | No | No | No | No |
| ConsensusDebate | Adversarial vote | routeConsensus | idea row | when triggered | multi-provider | Yes | Vote only | Yes | Yes | Yes | **Hard veto HOLD** | No |
| MarketRegimeAgent | Regime event | — | MARKET_REGIME_DETECTED | UNWIRED start | — | — | **No** | No | No | No | No | No |
| ExplainabilityAgent | UI copy | — | reports | — | llama3.2:1b | Yes | No | No | No | No | No | No |
| AdvancedQuantEngines | Indicator telemetry | ticks | CALCULATION_COMPLETED | every 5 ticks | IEX | No | **No** | No | No | No | No | No |
| ReflectionEngine | Weights / learned_rules | fills vs preds | agent_performance_stats | 60000 | DB | deepseek-r1 | No | No | No | No | Debate prompt only | No |

Confidence: agents emit 0–1. ChiefTrader `calibrateConfidence` then weighted average. Quant live emit also requires strategy confidence / EV / min R:R (`deskIntelligence.minRiskRewardRatio` 1.5). Kelly refuses `< minSampleSizeForTrust` **20** closed trades (`ExpectedValue.ts`).

---

## 10. Consensus Architecture

**Config (not TS literals):** `config/tradingSafety.json`, `config/agentWeights.json`.

| Parameter | Value |
|---|---|
| Approval threshold | 0.75 (must **exceed**) |
| Min independent agreeing | 2 (excludes ConsensusDebate) |
| Default weights | Technical 0.25, News 0.25, Fund 0.20, Kronos 0.20, Macro 0.15, Quant 0.15 |
| ConsensusDebate weight | 0.35 |
| Unlisted agent | 1.0 (PortfolioManager uses this) |
| Disagreement penalty | 0.5 |
| Hard veto HOLD | NewsAgent, ConsensusDebate (`confidence > 0`) |
| Debate trigger | idea.confidence > 0.6 |
| Debate result conf | 0.8 if ≥2 providers succeed |
| Single-model debate | 0.8 × 0.7 = **0.56** |
| Debate fail | successCount 0 → HOLD |
| Idea TTL | 60000 ms |
| Debate cooldown | consensusDebateCooldownMs 60000 |
| Eval min interval | consensusEvalMinIntervalMs 5000 (new independent agent bypasses) |
| Dynamic weights | `agent_performance_stats.currentWeight` else JSON defaults |
| Tie | higher `finalConfidence` of BUY vs SELL; both 0 → HOLD |
| Conflicting BUY/SELL | compete; penalty on the other side |
| Timeout | ideas expire; `evaluateConsensus` while debate in flight **returns without approving** |
| Risk exit | PortfolioManager SELL skips debate + min-2 |

**Math:** `netConfidenceFromVotes`:  
`(Σ agree.conf×wt − Σ disagree.conf×wt×0.5) / Σ wt`, clamped 0–1.

### Example 1 — two BUYs (can approve)

Technical BUY 0.90 wt 0.25 + Kronos BUY 0.90 wt 0.20  
Net = (0.90×0.25 + 0.90×0.20) / 0.45 = **0.90**. Independent = 2. **0.90 > 0.75** → approve unless debate HOLD.

### Example 2 — Technical vs Kronos (typical NO TRADE)

Technical BUY 0.90 wt 0.25 vs Kronos SELL 0.85 wt 0.20  

- BUY net = (0.225 − 0.85×0.20×0.5) / 0.45 = 0.140 / 0.45 = **0.311**  
- SELL net = (0.170 − 0.90×0.25×0.5) / 0.45 = **0.128**  

Winner BUY 0.311, independent agreeing = **1**. Fail threshold **and** quorum. **NO TRADE.**

### Example 3 — two BUYs + debate HOLD veto

Technical BUY 0.95 wt 0.25 + News BUY 0.95 wt 0.25 + ConsensusDebate HOLD 0.80 wt 0.35  

BUY net = (0.475 − 0.80×0.35×0.5) / 0.85 = 0.335 / 0.85 = **0.394** < 0.75. Independent would be 2 but HOLD veto kills it. **NO TRADE.**

**Quorum deadlock:** If only Technical + Kronos are live and they disagree, the system is **structurally unable** to reach 2 agreeing agents on one side. News votes are **off**. Fund/Macro may HOLD or be DATA_UNAVAILABLE (conf 0 HOLD excluded from denominator). This is a real architectural constraint, not a misconfiguration of the 0.75 bar.

---

## 11. Strategy Architecture

Live Quant: `src/server/quant/strategies/StrategyEngine.ts`. Isolated research: `src/server/strategiesEngine/` (OFF/SHADOW/ANALYSIS_ONLY) — **does not import** ChiefTrader, RiskEngine, OMS, BrokerManager, EventBus.

### CORE (in live `evaluateAll()` always)

| Strategy | Code module | Timeframe | Live connected? |
|---|---|---|---|
| MOMENTUM_BREAKOUT | quant/strategies | bars in StrategyContext | Only via QuantSignalAgent if QUANT on + EV |
| PULLBACK_CONTINUATION | same | same | same |
| MEAN_REVERSION | same | same | same |
| TREND_FOLLOWING | same | same | same |
| RANGE_REVERSION | same | same | same |

Exits for Quant lots: stored stop/target + thesis JSON, plus cost-basis backstop. Strategies themselves do not call OMS.

### EXPERIMENTAL (live only if that env is `'true'` at call time)

SMC_LIQUIDITY_SWEEP, VWAP_VOLUME_STRUCTURE, OPENING_RANGE_BREAKOUT, VWAP_MEAN_REVERSION, DONCHIAN_CHANNEL_BREAKOUT, MA_CROSSOVER, OSCILLATOR_MOMENTUM, BOLLINGER_VOLATILITY, PREVIOUS_PERIOD_BREAKOUT, CANDLESTICK_REVERSAL, GAP_CONTINUATION, FIBONACCI_PULLBACK, VOLUME_CONFIRMATION, SR_BOUNCE, RELATIVE_STRENGTH_ROTATION, STATISTICAL_MEAN_REVERSION — registry `config/quantExperimentalStrategies.json`. **UNVALIDATED.** Walk-forward OOS for checked combos **failed** (**DOCUMENTED**).

`findStrategy(id)` can **backtest** experimental ids without the live flag.

### Other

| Bucket | Status |
|---|---|
| Penny-stock overlay | **DISABLED** default `ARGUS_PENNY_STOCK_ENABLED`; OMS remains MARKET-only (unfit for illiquid — `config/multiAsset.json`) |
| SMC | Experimental env `QUANT_SMC_STRATEGY_ENABLED` |
| Research-only strategiesEngine | Never orders |
| Backtest-only | `BacktestEngine` SAME_BAR_CLOSE **non-promotable**; `canonicalNextBarEngine` NEXT_BAR_OPEN is the promotion-adjacent path |
| NOT_SUPPORTED | breadth, options, L2, pairs, CAD FX, Wheel, 0DTE, GEX, DOM/CVD — never fill zeros |

TechnicalAgent rules are **not** the Quant CORE set; they are a separate RSI/MACD/BB heuristic on ticks.

---

## 12. Risk Architecture

Catalog order `config/riskGateOrder.json`. Pass/fail from `RISK_GATE_EVALUATED` / `risk_gate_results`, not the JSON file alone.

| # | Gate | Purpose | BUY | SELL | Paper | Live | Fail-closed? | Bypass? |
|---|---|---|---|---|---|---|---|---|
| 1 | emergency_stop | TRADING_ENABLED only | Y | Y | Y | Y | Yes | No |
| 2 | autobot_enabled | New BUY needs Autobot | Y | **skip** | Y | Y | Yes for BUY | No |
| 3 | same_symbol_cooldown | FILLED same symbol | Y | — | Y | Y | Yes | No |
| 4 | post_loss_cooldown | After losing fill | Y | — | Y | Y | Yes | No |
| 5 | daily_trade_limit | maxDailyTrades; 0=skip | Y | — | Y | Y | Yes if cap>0 | No |
| 6 | duplicate_signal | Window 60000 | Y | — | Y | Y | Yes | Replay skip |
| 7 | invalid_account_equity | Equity must be >0 | Y | Y | Y | Y | Yes; no $10k fake | No |
| 8 | daily_loss | vs limit × 0.8; NY day | Y | Y | Y | Y + restricted $1000 min | Yes | No |
| 9 | consecutive_loss | Last 3 FILLED all losers | Y | — | Y | Y | Yes | No |
| 10 | portfolio_drawdown | vs peak | Y | — | Y | Y | Yes | No |
| 11 | order_rate_limit | assessments / 60s | Y | Y | Y | Y | Yes | Replay skip |
| 12 | market_hours | Alpaca `/v2/clock` | Y | Y | skip if no keys; **fail if HTTP fail** | Y | Yes on outage | Unconfigured skip |
| 13 | data_freshness | tick age ≤ 300000; **null age fail** | Y | Y | Y | Y | Yes (DEF-08) | No |
| 14 | news_veto | impact>80 in 4h, direction-blind | Y | Y | Y | Y | Yes | No |
| 15 | price_validity | ticker + finite price>0 | Y | Y | Y | Y | Yes | No |
| 16 | order_notional_cap | PositionSizing / $5000 live restricted | Y | Y | Y | Y | Zero-qty CLAMPED = FAIL | No |
| 17 | symbol_concentration | 20% equity | Y | — | Y | Y | Yes | No |
| 18 | open_positions_cap | settings / live 3 | Y | — | Y | Y | Yes | No |
| 19 | sector_concentration | 40% | Y | — | Y | Y | Yes | No |
| 20 | correlation_exposure | corr cap | Y | — | Y | Y | Yes | No |
| 21 | sufficient_size | whole shares ≥1; stop 5% not ATR | Y | Y | Y | Y | Yes | No |
| 22 | sell_position_exists | qty>0 | omit | **Y** | Y | Y | Yes | No |
| 23 | argus_capital_allocation | budget remaining | Y | — | Y | Y | Yes | No |
| 24 | daily_buy_notional | paper vs restricted live caps | Y | — | Y | Y | Yes | No |

Serialized via `evaluationQueue` mutex (`evaluateRisk` only).

**Paths that prevent a trade:** any gate fail; persist fail; OMS idempotency abort; `authorizeProductionOrder` LIVE_NO_GO; Autobot-off ignoring **entry** ideas in ChiefTrader; `gateTradeIdea` dropping garbage symbols; Quant EV filter; consensus fail; no price; telemetry pulse payloads ignored.

**`placeOrder()` without RiskEngine+OMS:** production `src/` `.placeOrder(` only in `OrderManagement.ts` and `src/brokers/` adapters (**TEST-VERIFIED**). InternalPaper `closePosition` exists on the adapter but HTTP routes must not call it (`phase21` asserts no `closePosition` in routes/`server.ts`). Research Python CLI must not import BrokerManager (**TEST-VERIFIED**).

---

## 13. OMS Architecture

Listener: `RISK_ASSESSMENT_COMPLETED` → `executeOrder`.

| Concern | Behavior |
|---|---|
| Idempotency | One `trades` row per `traceId`; lookup failure **aborts before broker** |
| clientOrderId | Always passed; `reconcileStaleOrders` by `client_order_id` |
| PENDING | Insert before broker |
| Partial fills | Incremental `fills` watermark |
| Rejected | Broker terminal status; throw ≠ REJECTED (UNKNOWN) |
| Unknown | Timeout stays PENDING; follow-up 15s; crash recovery interval |
| Restart | Reconcile stale + inbound broker orders |
| Environment stamp | `execution_environment` column PAPER/LIVE/REPLAY |
| Telemetry pulse | Ignored (Digital Twin must not order) |

---

## 14. Broker Architecture

| Broker | Paper | Live | Notes |
|---|---|---|---|
| AlpacaBroker | **PAPER** REST paper-api | **LIVE** api.alpaca.markets + arm | Only fully unattended |
| InternalPaperBroker | **SIMULATION** in-process | liveTrading false | Default; $ cash from `internalPaperDefaultCash`; fills on MARKET_DATA tick |
| InteractiveBrokersAdapter | paper DU* | live U* | P0.2 fail-closed classification; 2FA ~24h; no Canadian equities |
| CoinbaseBroker | **refuses paper placeOrder** | LIVE + arm | Not a US-equity path |
| QuestradeBroker | — | — | **READ-ONLY**; placeOrder throws |
| HistoricalReplayBroker | — | — | **RESEARCH**; not soak |

---

## 15. Paper Trading Architecture

- `PAPER_TRADING_ONLY=true` refuses LIVE arm and Alpaca live authenticate (**CODE-VERIFIED** `liveOrderAuthorization.ts`, AlpacaBroker).
- `settings.tradingMode` / `brokerConnections.paperMode` select environment; OMS `authorizeProductionOrder` maps PAPER vs LIVE.
- If operator selected Alpaca paper keys: orders hit **real Alpaca paper API** — not InternalPaper.
- If no broker selected: **InternalPaperBroker** — genuine in-process simulation, still via OMS.
- Restart: LIVE_ARM memory-only cleared; paper continues.
- Kill switch: `TRADING_PAUSED` / `EMERGENCY_STOP` (gate 1). Autobot-off is **not** a second kill switch (blocks new BUY only).
- Positions/fills persist in SQLite; InternalPaper book is **in-memory** and recon hydrates `portfolio` from that book while it is the active broker.
- Paper is **not** blocked by `LIVE_NO_GO`.

Whether a given operator session uses Alpaca paper vs InternalPaper is **UNVERIFIED** without reading that process’s selected broker (this audit did not).

---

## 16. LIVE Safety Architecture

Five layers (all fail-closed):

1. Phrase `ENABLE LIVE TRADING` (`LiveTradingConfirmation.ts`).
2. `tradingState === TRADING_ENABLED`.
3. `PAPER_TRADING_ONLY` must be false.
4. Alpaca live host refuses without arm.
5. In-memory `LIVE_ARM` + OMS `evaluateLiveReadiness() === LIVE_READY`.

Current engine: **`LIVE_NO_GO`** (`liveReadinessEngine.ts`). Mandatory matrix cannot PASS (organic paper / OOS / etc.).

| Question | Answer | Evidence |
|---|---|---|
| Bypass LIVE confirmation? | **No** for live host + OMS | arm + readiness |
| External AI place order? | **No** | AIRouter never calls OMS |
| UI place order? | **No direct.** Execute-override / liquidate emit `CHIEF_APPROVED_IDEA` → RiskEngine | `v2System.ts` execute-override; `App.tsx` fetch |
| Research place order? | **No** | strategiesEngine isolated; VectorBT CLI invariant |
| Replay place order? | Replay broker / REPLAY env; **not** organic paper; not a live Alpaca path | OMS `resolveFillEnvironment` |
| MCP place order? | OpenAlice **fire-and-forget verification** after approval; siblings untrusted; orchestrator empties AutoHedge wallet keys | CLAUDE.md + ChiefTrader OpenAlice trigger |
| Adapter accidental LIVE URL? | Alpaca `liveTrading()` sets liveBaseUrl then `assertLiveOrdersArmed` on live host | AlpacaBroker.ts |

---

## 17. Database Architecture

58 `sqliteTable(` in `src/server/db/schema.ts`. Notable:

| Table | Purpose | Producer | Consumer |
|---|---|---|---|
| settings | Autobot, TP/SL %, budget, schedule | boot/UI | engines, monitor, scheduler |
| trades | Order lifecycle | OMS | recon, monitor, soak |
| fills | Incremental fill ledger | OMS/fillLedger | P&L, idempotency |
| portfolio | Local holdings | **Reconciliation hydrate** | PortfolioMonitor, UI |
| risk_assessments / risk_gate_results | Gate tape | RiskEngine | traces, UI |
| consensus_decisions / consensus_evidence | Vote record | ChiefTrader / TransactionRegistry | Observatory |
| transactions / transaction_traces | Lifecycle | registry + tracker | traces |
| event_traces / observability_events / agent_reasoning_logs | Decision tape | EventBus / observability | `getDecisionTrace` |
| ai_calls | LLM audit (promptHash in export) | AIRouter | traces |
| news_clusters | Veto input | NewsEngine | RiskEngine |
| ohlcv_bars | History | gateway | Quant, correlation |
| quant_assessments | Quant cycle | QuantSignalAgent | research |
| kill_switch_events | Pause/stop | trading state | audit |
| reconciliation_events / acknowledgements | Mismatch | recon | operator ack P0.7 |
| agent_predictions / prediction_outcomes / agent_performance_stats | Learning | agents / reflection | ChiefTrader weights |
| learned_rules | LLM rule text | Reflection | debate prompt only |

**Reconstruct one trade:** `traceId` → `getDecisionTrace` joins transaction_traces, agent_reasoning_logs, event_traces, observability_events, risk_assessments+gates, trades+fills, ai_calls (hash). `transactionId` is minted at consensus — do not join on the wrong id.

There is no table named `consensus_decisions` vs `transactions` confusion: both exist. `agent_predictions` exists; “consensus_evidence” is `consensus_evidence`.

---

## 18. Frontend Architecture

SPA: `src/App.tsx`. Nav: `src/components/responsive/responsiveNavConfig.ts` — **20** desktop tabs (dashboard, command, portfolio, arena, agents, evaluation, memory, activity, observatory, scanner, intelligence, learning, kronos, opportunities, news, settings, diagnostics, audit, validation, documentation). There is **no** `deployment` `AppTabId` (that copy lives inside validation).

Phone layout (`src/components/mobile/`, width <768 or Mobile toggle): **6** tabs `cockpit | positions | brain | risk | terminal | settings`. Settings is `MobileSettingsView` — same overlay APIs as desktop Dual configuration; scan interval / watchlist / penny spread / consensus quorum are **read-only**; `PAPER_TRADING_ONLY` is padlocked. Operator how-to: `docs/ARGUS_MOBILE_SETTINGS.md`. Phone 320/390/412 viewport QA was **not** completed (login form).

| Surface | Honesty |
|---|---|
| L2 book | Unavailable copy; no fake ladder |
| DigitalTwinVisualizer | Real WS events only |
| AgentWorkflowTheater | Educational motion |
| Arena win-rate widgets | AwaitingSignal, not RNG |
| Some network charts | MOCK — do not cite as accuracy |
| DecisionTracePanel | Persisted rows |
| Execute override | Full RiskEngine |
| Mobile Settings | Overlay toggles + TP/stop/broker/LLM-preselect; no LIVE arm |

**Trading-influencing controls (all still RiskEngine unless noted):**

| Control | Endpoint | Safeguard |
|---|---|---|
| Autobot start/stop | TradingEngine toggle via API | LIVE phrase if going LIVE; budget vs buying power |
| Execute override | `POST /api/v2/trading/execute-override` | Skips consensus only; BUY needs Autobot; needs live price |
| Liquidate | `POST /api/v1/portfolio/liquidate` | PipelineFlatten → CHIEF_APPROVED ManualOverride |
| Rebalance | `POST /api/v1/portfolio/rebalance` | Pipeline ideas + RiskEngine sizing |
| Broker/keys | settings routes | encryption; paper default |
| Pipeline agent toggles | pipeline snapshot API | Does not bypass Risk/OMS |

Signals HTTP `/api/v1/signals` = **410** quarantined. Event-memory routes **410**.

Login: `if (!isAuthenticated) return <Login/>` **after** most hooks — fetches/WS must still gate on auth (DEF-22).

---

## 19. External Integrations

| System | Purpose | Execution | Isolation | Failure | Runtime |
|---|---|---|---|---|---|
| Alpaca | Quotes + paper/live orders | Yes via OMS | TLS system CA | timeouts/circuit in tradingSafety | If keys |
| AlphaVantage | Fund/Macro | No | cache | HOLD DATA_UNAVAILABLE | If key |
| Ollama / Gemini / OpenAI / DeepSeek / NVIDIA NIM | LLM | No | AIRouter; heavy mutex | HOLD / conf 0 | If configured |
| Chronos :8008 | Kronos | No | local | unavailable warning, no fake forecast | optional |
| OpenAlice | Post-approval verify | No Argus placeOrder | fire-and-forget | ignore | optional |
| Fincept / vibe-trading / autohedge | Sibling UIs | **Never** Argus credentials / placeOrder | wallet keys emptied | N/A | `npm run dev` optional |
| MCP | Cursor/OpenAlice | No Argus OMS | — | — | optional |
| News APIs / RSS | clusters | No | — | backoff 900s | NewsEngine |
| IBKR Gateway | orders if selected | Yes via OMS | 2FA human | fail closed | optional |
| Coinbase | crypto live | Yes via OMS if selected | LIVE arm | paper refuse | optional |
| Questrade | read | No | OAuth | placeOrder throw | optional |

---

## 20. Multi-Asset Support

| Asset | Status | Notes |
|---|---|---|
| Large-cap US listed | **SUPPORTED** if subscribed + ticker regex | `looksLikeListedTicker` `^[A-Z]{1,5}(\.[A-Z])?$` |
| ETFs | **SUPPORTED** | Default universe is 4 index ETFs |
| Small/micro cap | **PARTIALLY SUPPORTED** | Same equity path; no liquidity/spread gate unless penny overlay on |
| Penny | **DISABLED** overlay; MARKET orders **unfit** per `multiAsset.json` | `ARGUS_PENNY_STOCK_ENABLED` |
| OTC | **NOT IMPLEMENTED** as a class; ticker regex may reject many OTC symbols | UNVERIFIED per-symbol |
| Crypto | **NOT** on US equity spine; Coinbase adapter separate | Coinbase paper refuse |
| Forex | **NOT IMPLEMENTED** | |
| Options / futures | **NOT_SUPPORTED** / research metadata | |
| Canadian listings | **BLOCKED** live routing IIROC; metadata in markets.json | |

Assumptions: US RTH `market_hours` (Alpaca clock); whole shares; `stopLossAssumptionPct` 0.05; FIXED_DOLLAR sizing; IEX top-of-book not L2; concentration via coarse `SECTOR_MAP`.

---

## 21. Background Processes

| Process | Interval | File |
|---|---|---|
| IEX WebSocket | event-driven | MarketDataWorker |
| Technical eval cooldown | 30000 | quantThresholds.json |
| Fund / Macro | 60000 / 75000 | runtimeIntervals |
| Quant cycle | 300000 | tradingSafety |
| News poll | 10000 | runtimeIntervals |
| PortfolioMonitor | 60000 | runtimeIntervals |
| Reconciliation | 300000; warmup 30000 | runtimeIntervals |
| OMS follow-up | 15000 | runtimeIntervals |
| OMS crash recovery | (OMS constants) | OrderManagement |
| Reflection | 60000 | |
| Metrics | 2000 | |
| Cross-check | 60000 | |
| Kronos recheck | 30000 | |
| AutoTradeScheduler | 60000 | |
| Opportunity scan | 120000 if enabled | continuousIntelligence |
| StrategyEngine shadow | 300000 if mode | |
| DB backup | 86400000 | |
| ChiefTrader weight sync | 10000 | |

---

## 22. Failure Recovery

- SIGTERM/SIGINT: `gracefulShutdown.ts` pause, stop workers, WAL checkpoint, close HTTP/WS; does **not** invent broker cancel/fill (**P1.1**).
- OMS stale/inbound reconcile.
- Broker throw → UNKNOWN.
- Recon mismatch → persist; pause after warmup; **operator ack**; never auto-flatten / auto-resume.
- Debate 0 providers → HOLD.
- Persist risk fail → no OMS.
- `unhandledRejection` → `data/logs/crash.log` + SYSTEM_ANOMALY (P0.6).
- InternalPaper state **lost on process death** unless recon/trades remain; Alpaca paper book survives at broker.

---

## 23. Observability

- `GET /api/v2/traces`, `/traces/:traceId`, export schema `argus.decision_trace.v1` with `live: "NO-GO"`.
- `GET /api/v2/live-readiness`, `/api/v2/diagnostics/why-not-trading` (includes last consensus explanation).
- `GET /api/v1/system/pipeline-agents` health (ENABLED+HEALTHY vs DEAD after `pipelineAgentDeadAfterMs` 180000).
- Secret redaction; safety logs not DEBUG.
- Digital Twin pulse **must not** trade (`isTelemetryPulsePayload`).

---

## 24. Security

- Bind localhost without `AUTH_PASSWORD`.
- Session auth when password set.
- AES-256-CBC broker keys (`ENCRYPTION_SECRET` or `data/.encryption_key`).
- `PAPER_TRADING_ONLY`.
- No second kill switch.
- Sibling engines untrusted.
- UI cannot `BrokerManager.placeOrder` (**TEST-VERIFIED**).

---

## 25. Current Limitations (actual)

- Discovery default **off**; universe **4 ETFs**.
- Consensus **0.75 + 2 agents** + Technical/Kronos conflict → few/zero autonomous BUYs.
- News **does not vote**.
- Quant often **0 emit** without 20 closed trades EV sample.
- Exits: **+15% / −5% from cost**, not day-trader timing; “trailing” is not a trail.
- No partial scale-out despite copy.
- PortfolioMonitor blind without tick + hydrated `portfolio`.
- Empirical edge **not established**; LIVE_NO_GO.
- `npm run db:migrate` (`database/migrate.ts`) imports the same migrator as boot.
- App.tsx thin test coverage.

---

## 26. P0 / P1 / P2 / P3 Findings

### P0 — safety (working as designed, still operator-critical)

- LIVE_NO_GO + 5-layer arm — **do not weaken**.
- Sole OMS `placeOrder` — hold the invariant.
- Persist-then-emit; fill uniqueness; IBKR paper/live isolation.

### P1 — capital / “money machine” mismatch

- **Exit model is swing cost-basis, not session profit-taking.** Peak trail, time stop, partials: absent.
- **Discovery not on the idea path** by default.
- **Consensus deadlock** when the two live tick agents disagree.
- **Monitor depends on recon hydrate + IEX tick** — orphan broker positions possible until recon; NO_PRICE skips SELL.

### P2

- News catalyst-only vs quorum needs more voices.
- Quant EV filter vs operator expectation of “always looking.”
- InternalPaper vs Alpaca paper confusion.
- Misleading “TRAILING_STOP” / “Scaling out” strings.
- MarketRegimeAgent / AdvancedQuantEngines look like voters; they are not.

### P3

- SPA mock widgets vs real traces.
- Heavy SPA chunk; App.tsx tests.

---

## 27. Implemented vs Planned / Assumed

| Capability | Actually implemented | Evidence | Runtime verified this audit |
|---|---|---|---|
| EventBus idea → Chief → Risk → OMS → broker | Yes | listeners + phase21 | CODE/TEST only |
| 24 risk gates | Yes | RiskEngine + riskGateOrder.json | CODE/TEST |
| Paper Alpaca REST | Yes if selected | AlpacaBroker + networkEndpoints | UNVERIFIED session |
| InternalPaper simulation | Yes default | InternalPaperBroker + BrokerManager.tick | CODE |
| LIVE trading | Blocked | liveReadinessEngine LIVE_NO_GO | CODE |
| Continuous multi-name hunt | Overlay off; subscribe-only | OpportunityDiscovery | DISABLED |
| Day-trader scale-out | No | PortfolioMonitor | — |
| Take profit 15% from cost | Yes | schema + monitor | CODE |
| Peak trailing stop | No | PnL vs averagePrice | — |
| Quant CORE evaluateAll | Yes if QUANT on | StrategyEngine | env-dependent |
| Quant live ideas | Often filtered | ExpectedValue min 20 | CODE |
| News as voter | Default off | deskIntelligence.json | DISABLED |
| strategiesEngine orders | Never | no imports of spine | UNWIRED |
| Rebalance HTTP | Pipeline ideas | PortfolioRebalance.ts | CODE (not 501) |
| Organic profit | Not established | CLAUDE.md soak | DOCUMENTED |

---

## 28. Complete End-to-End Example

**Hypothetical CODE-VERIFIED path, not a claimed live fill.**

09:31 Autobot on, TRADING_ENABLED, Alpaca paper, IEX open, symbols SPY/QQQ/IWM/DIA.

1. SPY ticks accumulate to 50; Technical emits BUY 0.82 after cooldown.
2. Kronos (if up) emits SELL 0.80 on SPY.
3. ChiefTrader: Example 2 math → **NO TRADE**. Why-not-trading records quorum/confidence.
4. Fund tick 60s later BUY 0.70 HOLD-ish or BUY: may or may not supply a second **same-side** voice.
5. If Technical BUY + Fund BUY both >0 and Kronos SELL, Fund+Technical might still lose to disagreement penalty — **UNVERIFIED** without those exact confidences.
6. If somehow approved: RiskEngine `market_hours` PASS (clock open), `data_freshness` PASS, sizing whole shares, OMS PENDING, Alpaca paper POST, fill → trades/fills.
7. Recon hydrates `portfolio`. Next 60s monitor: SPY must be **+15%** from average to take profit, or **−5%** to stop. Intraday +0.4% day-trader clip **does not fire**.

---

## 29. Final Architecture Diagram

See §4. Dual loops:

```
[Discovery/entry]  IEX universe → agents → consensus → risk → OMS
[Inventory/exit]   portfolio rows → monitor → PortfolioManager SELL → skip quorum → risk → OMS
```

They share ChiefTrader/Risk/OMS. They do **not** share the same decision policy. Entry wants 2 agents at 0.75. Exit wants cost-basis (or Quant) thresholds and a live tick.

---

## 30. Final Verdict

Argus **is** a real, protected, paper-capable multi-agent execution terminal with honest fail-closed risk and LIVE locks.

Argus **is not** currently a money-making day-trading automaton. It watches a tiny IEX set, rarely reaches BUY quorum, and sells owned names primarily at **+15% / −5% from cost** (or Quant stop/target), not at tape-based profit-taking times.

Any future “keep looking / sell like a day trader” work must stay **additive**: more subscribe universe and/or PortfolioMonitor exit rules in `config/*.json`, still `PortfolioManager` → ChiefTrader risk-exit → RiskEngine → OMS. Do not add a second order path.

---

# ARGUS — CURRENT STATE

**Architecture:** Single-process EventBus spine: ideas → ChiefTrader → RiskEngine (24 gates) → OMS → BrokerManager. Protected; do not rewrite.

**BUY flow:** Ticks/timers → TRADE_IDEA_GENERATED → weighted consensus (0.75, min 2) → CHIEF_APPROVED_IDEA → RiskAgent → persist-then-emit → OMS `placeOrder`.

**SELL flow:** PortfolioMonitor SELL ideas (PortfolioManager) skip quorum; still RiskEngine+OMS. Plus directional SELL votes (full consensus) and ManualOverride liquidate/rebalance/override.

**Continuous scanning:** Default **four ETFs**. Opportunity loop **DISABLED**; even when on, **no ideas**.

**Position monitoring:** Every 60s on local `portfolio` if a live price exists. Cost-basis TP/SL; Quant extras. Not peak-trail, not session flatten.

**Agent consensus:** 0.75 / 2 independent; News votes off; debate can hard-veto HOLD; Technical vs Kronos disagreement structurally blocks.

**Risk controls:** 24 recorded gates; SELL not blocked by Autobot-off; kill switch is TRADING_PAUSED / EMERGENCY_STOP.

**Paper trading:** Alpaca paper REST if selected; else InternalPaper **SIMULATED**. PAPER_TRADING_ONLY blocks LIVE.

**Live trading:** **LIVE_NO_GO.** Five-layer arm. OMS refuses LIVE if readiness ≠ LIVE_READY.

**Multi-asset:** US listed equities/ETFs on Alpaca. Crypto/options/futures/forex not on this spine. Canadian live **BLOCKED**. Penny overlay **DISABLED**.

**Penny stocks:** Overlay off; MARKET-only OMS declared unfit for illiquid names.

**External integrations:** Alpaca (data+orders), AV, LLM router, optional Chronos; siblings untrusted; OpenAlice non-blocking.

**Biggest architectural weakness:** Entry discovery + exit timing do not match a day-trading P&L machine (tiny universe, strict quorum deadlock, cost-basis exits mislabeled as trailing/scale-out).

**Biggest strength:** One honest execution spine with fail-closed risk, LIVE locks, fill/idempotency invariants, and no second `placeOrder` path.
