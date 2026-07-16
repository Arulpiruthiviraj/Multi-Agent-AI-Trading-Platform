# Argus Autonomous Trading Platform - Complete Technical Analysis

## 1. Executive Summary
The Argus application is a full-stack, event-driven AI autonomous trading platform. It simulates a multi-agent consensus workflow where different AI agents (Technical, News, Fundamental, Macro) evaluate market data and propose trades. A Chief Trader aggregates these proposals into a consensus decision, which is then passed to a Risk Management engine for sizing and validation, before being routed to an Order Management System (OMS) for execution.

**Current Capabilities:**
- Connects to Alpaca Paper Trading for real market data (WebSockets) and real order execution (if API keys are present).
- Calculates real-time technical indicators (RSI, MACD, SMA, EMA, Bollinger Bands).
- Evaluates mocked news sentiment, fundamental data, and macro indicators.
- Employs a dynamic consensus model based on historical agent performance.
- Validates trades against mock capital limits, position concentration caps, and session availability.
- Persists trades, portfolio holdings, and learned reflection rules into a SQLite database.

**Changes Since Previous Version:**
- Fully decoupled Risk Engine (`RiskAgent.ts`) with concentration limits and position sizing.
- Added new quantitative engines: `RSIEngine` and `MACDEngine`.
- Added `FundamentalAgent` and `MacroAgent` (currently generating simulated data insights).
- Upgraded `ChiefTraderAgent` to dynamically weight agent confidence based on historical performance rather than simple aggregation.

**Production Readiness:** 65%
While the pipeline from data ingestion to paper execution is fully functional, many inputs (such as News, Fundamental, and Macro data) are currently simulated (mocked) and the AI reflection loops are partially hardcoded heuristics rather than true LLM completions.

---

## 2. Complete Feature Inventory

| Feature | Description | Status | Files / Components | Dependencies |
|---------|-------------|--------|---------------------|--------------|
| **Market Data Streaming** | Ingests live quotes from Alpaca or falls back to mock tick data. | Fully Implemented (Hybrid) | `MarketDataWorker.ts` | Alpaca WS |
| **Technical Analysis Agent** | Computes SMA, EMA, RSI, MACD, BBands and generates signals. | Fully Implemented | `TechnicalAgent.ts`, `RSIEngine.ts`, `MACDEngine.ts` | None |
| **News Intelligence Agent** | Analyzes headlines for sentiment. | Mocked | `NewsAgent.ts` | None (Math.random) |
| **Fundamental Analysis Agent**| Evaluates P/E and EPS growth. | Mocked | `FundamentalAgent.ts` | None (Math.random) |
| **Macro Economy Agent** | Evaluates Fed stance and inflation. | Mocked | `MacroAgent.ts` | None (Math.random) |
| **Chief Trader Consensus** | Aggregates ideas and applies dynamic weightings. | Fully Implemented | `ChiefTraderAgent.ts` | `EventBus` |
| **Risk Management Engine** | Validates concentration, budget, session, and position sizing. | Partially Implemented (Mock Equity) | `RiskAgent.ts` | `EventBus` |
| **Order Execution (OMS)** | Routes orders to Alpaca Paper API. | Fully Implemented | `OrderManagement.ts` | `node-fetch` |
| **Trade Reflection / Learning**| Evaluates trades and generates text-based rules. | Prototype (Randomized triggers)| `OrderManagement.ts` (Event Listener) | None |
| **Agent Performance Dashboard**| UI to view agent win-rates and weights. | Fully Implemented | `AgentEvaluationDashboard.tsx` | Recharts |
| **Digital Twin Visualizer** | Live graph representation of system nodes. | Partially Implemented | `DigitalTwinVisualizer.tsx`, `AutoBotFlowVisualizer`| ReactFlow |
| **Trade Replay Modal** | UI to view historical trace logs. | Prototype | `TradeReplayModal.tsx` | None |
| **Database Persistence** | Stores trades, portfolio, and rules. | Fully Implemented | `db/schema.ts` | Better-SQLite3 |

---

## 3. Architecture Overview

**Core Architecture:** Event-Driven Microservices pattern using a central Node.js `EventEmitter`.

**Data Flow:**
`Alpaca WS` -> `MarketDataWorker` -> (Emits `MARKET_DATA`) -> `TechnicalAgent` -> (Emits `TRADE_IDEA_GENERATED`) -> `ChiefTraderAgent` -> (Emits `CHIEF_APPROVED_IDEA`) -> `RiskAgent` -> (Emits `RISK_ASSESSMENT_COMPLETED`) -> `OrderManagementService` -> (Emits `ORDER_EXECUTED`) -> `PortfolioMonitor` / DB.

**Components:**
- **Frontend:** React + Vite SPA. Extensive use of Tailwind CSS and Recharts.
- **Backend:** Express API + V2 EventBus.
- **Database:** SQLite managed via Drizzle ORM.

---

## 4. Autonomous Trading Lifecycle

1. **System Initialization:** `SystemBootstrap.start()` initiates all workers. (Fully Implemented)
2. **Market Monitoring:** `MarketDataWorker` polls or streams quotes. (Fully Implemented)
3. **News / Fundamental / Macro Collection:** Agents generate ideas on intervals. (Mocked Inputs)
4. **Calculation Engines:** `TechnicalAgent` routes arrays to `RSIEngine` and `MACDEngine`. (Fully Implemented)
5. **AI Agent Collaboration:** Agents emit `TRADE_IDEA_GENERATED`. (Fully Implemented)
6. **Consensus Generation:** `ChiefTraderAgent` weights confidence and issues `CHIEF_APPROVED_IDEA`. (Fully Implemented)
7. **Risk Validation:** `RiskAgent` checks 20% concentration limits and calculates `maxQuantity`. (Partially Implemented - hardcoded total equity).
8. **Position Sizing:** Completed by `RiskAgent`. (Partially Implemented).
9. **Order Execution:** `OMS` sends a market order to Alpaca. (Fully Implemented).
10. **Portfolio Updates:** `OMS` writes directly to SQLite `portfolio` table. (Fully Implemented).
11. **Learning:** Random delayed events generate reflection rules. (Mocked).

---

## 5. AI Agent Analysis

- **TechnicalProposerAgent:** Analyzes price streams. Fully Implemented using real math. Outputs BUY/SELL ideas.
- **NewsIntelligenceAgent:** Simulates headline parsing. Mocked logic. Outputs high-confidence catalysts.
- **FundamentalAnalysisAgent:** Simulates corporate earnings data. Mocked logic. Outputs value opportunities.
- **MacroEconomyAgent:** Simulates Fed rate environments. Mocked logic. Outputs directional biases.
- **ChiefTraderAgent:** Aggregates inputs, penalizes disagreement, rewards consensus based on historic weights. Fully Implemented.
- **RiskValidationAgent:** Rule-based validator preventing overallocation. Fully Implemented.

---

## 6. Calculation Engine Analysis

- **RSIEngine:** 14-period Wilder's Smoothing. Consumed by `TechnicalAgent`. Fully Implemented.
- **MACDEngine:** 12, 26, 9 EMA crossover math. Consumed by `TechnicalAgent`. Fully Implemented.
- **SMA / EMA / BBands:** In-class calculations inside `TechnicalAgent`. Fully Implemented.

*(Note: Advanced engines like Trend, Volatility, Volume Profiles, etc. are currently Not Implemented).*

---

## 7. Parallel Processing Analysis

Processing is entirely **Event-Driven** running in standard Node.js asynchronous loops (no dedicated Worker Threads).
- `MarketDataWorker`: Websocket listener / setInterval polling (every 3s).
- `NewsAgent`: setInterval (45s).
- `FundamentalAgent`: setInterval (60s).
- `MacroAgent`: setInterval (75s).
- `ChiefTraderAgent`: Event listener + setInterval cleanup (60s).

---

## 8. Mission Control & Animation Analysis

- **Digital Twin Visualizer:** Uses `ReactFlow` to display node topology. Static nodes with some dynamic edge styling.
- **LiveTradeJourneyOverlay:** Animates SVG paths to simulate trade lifecycle. Driven by simulated UI timers, not directly piped to the backend EventBus.
- **StrategyProfitSunburst:** Static Recharts wrapper.
- **Replay Animations:** `TradeReplayModal` has placeholder UI for speed/rewind, but does not actually step through time.

---

## 9. Logging & Explainability

- **Event Tracing:** Every idea generates a random `traceId` which is passed through the pipeline.
- **Log Format:** Standard `console.log` with bracketed prefixes (e.g. `[ChiefTrader]`).
- **AI Reasoning:** The `reasoning` string is appended to and expanded by each agent (e.g. Chief Trader prepends `[Chief Consensus Approval]`).
- **Database:** Trades are logged in the `trades` table with `trace_id` and `reasoning`.

---

## 10. Broker & Market Integration

- **Supported Broker:** Alpaca.
- **Market Data:** Alpaca IEX `wss://stream.data.alpaca.markets/v2/iex` (Real implementation if keys provided, fallback to Mock).
- **Paper Trading:** `POST /v2/orders` (Real implementation if keys provided, fallback to Mock).
- **Portfolio Sync:** Only internal DB tracking is currently implemented; does not perform ledger reconciliation with Alpaca.

---

## 11. Database & Persistence

- **Technology:** SQLite3 via Drizzle ORM.
- **Tables:** 
  - `trades` (id, symbol, side, quantity, price, timestamp, reasoning, trace_id, status)
  - `portfolio` (symbol, quantity, averagePrice, lastUpdated)
  - `learnedRules` (traceId, cause, rule, confidence, timestamp)
  - `agentPerformanceStats` (agentName, totalDecisions, successfulDecisions, winRate, currentWeight)

---

## 12. Testing

- **Current Status:** Not Implemented. 
- There are no Unit, Integration, or E2E tests in the current repository. The `/src/components/SystemValidationSuite.tsx` is purely a frontend visualizer prototype.

---

## 13. Documentation

- **Architecture:** Described lightly in `AGENTS.md`.
- **UI Tooltips:** The application contains extensive `ContextualTooltip` wrappers.
- **Walkthroughs:** `AppWalkthrough.tsx` provides a guided tour.
- *(Note: Dedicated developer API docs or Swagger specs are Not Implemented).*

---

## 14. Missing Features

**Critical:**
- Real Portfolio Reconciliation (syncing actual broker positions with the local SQLite DB).
- Real LLM Integration for Sentiment and Reflection (currently using mocked outputs or static strings).
- Graceful API rate-limit handling for Alpaca.

**High Priority:**
- WebSocket pipe to stream EventBus events to the React Frontend (currently frontend relies on HTTP polling).
- Full implementation of Fundamental and Macro data sources (e.g., Financial Modeling Prep API).
- Automated Testing framework (Jest/Vitest).

---

## 15. Production Readiness Assessment

- **UI/UX:** 95% (Highly polished, brutalist trading terminal aesthetic).
- **Autonomous trading:** 70% (Core pipeline works, but lacks real portfolio reconciliation).
- **AI Agents:** 40% (Many rely on simulated inputs rather than real LLM reasoning).
- **Calculation Engines:** 50% (Basic indicators present, advanced quantitative models missing).
- **Risk management:** 60% (Position sizing works, but relies on hardcoded total equity).
- **Broker integration:** 90% (Alpaca API fully wired for paper trading).
- **Testing:** 0% (No tests exist).
- **Security:** 50% (Env variables used, but no user auth or role-based access).

**Overall Production Readiness:** 57%

---

## 16. File & Component Inventory (Key Selections)

**Backend:**
- `src/server/core/EventBus.ts` - Central event emitter.
- `src/server/core/SystemBootstrap.ts` - Lifecycle manager.
- `src/server/services/RiskAgent.ts` - Enforces capital constraints.
- `src/server/services/ChiefTraderAgent.ts` - Weights agent confidence.
- `src/server/engines/RSIEngine.ts` / `MACDEngine.ts` - Math utilities.
- `src/server/db/schema.ts` - Drizzle ORM definitions.

**Frontend:**
- `src/App.tsx` - Main routing and layout.
- `src/components/AutonomousMissionControl.tsx` - Primary system dashboard.
- `src/components/GuardrailsPanel.tsx` - Risk management UI.
- `src/components/TradeReplayModal.tsx` - Historical trace viewer.
- `src/components/DigitalTwinVisualizer.tsx` - Node graph.

---

## 17. Final Executive Assessment

**1. What the application currently does:**
It runs a live (or simulated) Node.js event-driven loop that detects trading signals, evaluates them against a mock committee of AI agents, passes them through a risk filter, and executes paper trades on Alpaca while logging the results to SQLite.

**2. What has been added since the previous version:**
A dedicated Risk Validation Agent with position sizing logic, structural calculation engines for RSI and MACD, mock agents for Fundamental and Macro data, and a dynamically weighted Consensus engine in the Chief Trader.

**3. What remains incomplete:**
Real LLM API calls for unstructured data parsing (News/Macro), robust Automated Testing, and WebSocket-driven UI updates.

**4. Readiness:**
- **Demonstration:** Yes.
- **Paper trading:** Yes (Functioning).
- **Live trading:** No (Lacks robust error handling, portfolio reconciliation, and test coverage).

**5. Recommended Next Priorities:**
1. Connect a WebSocket gateway to stream `EventBus` logs directly to the React `LiveBotTelemetryPanel`.
2. Implement true portfolio reconciliation with the broker via REST sync.
3. Replace the `NewsAgent` mocked logic with real Gemini API calls parsing live RSS feeds.
