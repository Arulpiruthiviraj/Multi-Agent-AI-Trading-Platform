# Comprehensive Architecture & Technical Documentation

Argus is an advanced multi-agent AI autonomous trading terminal interface. It features a full-stack architecture designed to simulate and execute continuous trading evaluations using a swarm of specialized Large Language Model (LLM) agents.

This document serves as the absolute, exhaustive reference for every system, subsystem, module, and UI component within the application.

---

## 1. Core Architectural Paradigm

The system is built on a **5-Layer Hierarchical Architecture** separating data ingress, AI analysis, mathematical weighting, consensus decision-making, and hard risk management.

### The 5 Layers:
1. **Data Layer (Inputs):** Simulates market data feeds, news headlines, and macro geopolitical events. It provides the base stimuli that awaken the AI swarm.
2. **Intelligence Layer (AI/LLM Nodes):** Utilizes `gemini-3.5-flash` via `@google/genai` on the Node.js backend. Distinct "Agents" (Prompts with distinct personas and historical contexts) process the unstructured data.
   - *Nodes include:* Macro Agent, News Agent, Tech Agent, Sentiment Agent, Event Agent, and Geopol Agent.
3. **Quantitative & Performance Layer:** Math-based tracking. Monitors the ongoing Win/Loss ratio, Sharpe Ratio, and Drawdowns of the agents from Layer 2. Dynamically adjusts the "Voting Weight" of each agent based on its live performance (Evolutionary survival of the fittest models).
4. **Decision Layer (Consensus Engine):** Aggregates the weighted votes of all agents. Proposes a final unified trade action (BUY, SELL, HOLD) alongside a confidence index.
5. **Risk Layer (The Black Box Guardrails):** The ultimate veto authority. Evaluates the Decision Layer's proposal against hard mathematical constraints (e.g., "Are we overexposed to Tech?", "Have we hit the daily loss limit?"). Under the hood, this layer features:
   - **Wilder's 14-period Average True Range (ATR) calculation:** Computes market volatility using simulated high, low, and close prices.
   - **Forced Stop-Loss minimums:** Any proposed stop-losses are strictly forced to a minimum distance of 1.5x the current ATR value, protecting positions from random intraday noise.
   - **ATR-Adjusted Dynamic Scaling:** Sizing of the trade is dynamically scaled according to the ATR-adjusted risk cap (based on the user's selected Risk Level parameters: Low = 1.0%, Medium = 1.5%, High = 3.0% of total budget risk capital allocation). If the calculated shares times the asset price is less than the initial target amount, the trade size is automatically scaled down to comply with risk guidelines. If it vetos, the trade is killed instantly.

---

## 2. Technology Stack & Runtime Environments

### Frontend (Client-Side)
- **Framework:** React 18, Vite.
- **Styling:** Tailwind CSS (Strictly utilizing a brutalist, dark-mode terminal aesthetic with `font-mono`, `#0A0F16` backgrounds, and neon accents).
- **Data Visualization:** `recharts` for composing complex SVG charting (Sunbursts, Line charts, Node graphs).
- **Icons:** `lucide-react` for consistent, crisp iconography.
- **Structure:** Single Page Application (SPA) with a multi-tab routing system handled locally via React State.

### Backend (Server-Side)
- **Framework:** Express.js (Node.js).
- **Language:** TypeScript (run via `tsx` during development, bundled via `esbuild` for production).
- **State Management:** Fully in-memory state variables (simulating a persistent Postgres/Redis layer). The state handles the active portfolio, transaction ledgers, performance metrics, and the continuous automated bot loop.
- **AI Integration:** The `@google/genai` SDK is used securely on the backend. No API keys ever leak to the browser.

---

## 3. Exhaustive Feature & UI Breakdown

The frontend application (`src/App.tsx`) is divided into 5 primary navigation tabs, each housing dense data visualizations and control modules.

### Tab 1: Trading Arena (The Main Dashboard)
The central hub for manual execution, observation, and macro simulations.
- **Top Metrics Ribbon:** Displays global real-time stats like Total Portfolio Value, Active Win Rate, Daily P&L, and Active AI Nodes.
- **Asset Target Selector & Live Market News Ticker:** Users select specific ticker symbols (AAPL, NVDA) and provide news headlines to simulate incoming market data. The ticker mimics a live Bloomberg terminal feed.
- **Multi-Agent Dialogue Graph (`MultiAgentDialogueGraph.tsx`):** A visual network graph showing the active LLM nodes discussing the current asset. Lines pulse when data is being processed, visually representing the swarm consensus building.
- **Strategy Synergy Matrix (`StrategySynergyMatrix.tsx`):** A heatmap visualizing the correlation coefficient between different agents when proposing trades. It reveals if agents are acting redundantly (High Sync) or acting as structural hedges (Inverse Correlation).
- **Trigger Dynamic Multi-Agent Pass:** The main action button that sends the simulated data to the backend, invoking the LLM swarm, running it through the Risk Layer, and returning the result.
- **Autonomous Scan Mode:** A toggle that tells the backend to run a continuous `setInterval` loop, generating its own trades automatically without human input.
- **Execution & Veto Ledgers:** Two side-by-side tables showing trades that were successfully booked to the portfolio vs. trades that were mercilessly blocked by the Risk Manager.
- **Trade Summary & Sparkline Trends:** A detailed table listing the performance per asset. It includes an *interactive sparkline chart* that reveals the specific AI logic and reasoning on hover, and highlights underperforming assets in red if they drop below a 30-day moving average.

### Tab 2: Holdings & Positions
The simulated brokerage account view.
- **Active Portfolio Ledger:** Lists all currently held assets, their allocation percentage, sector, quantity, average cost basis, and real-time (simulated) Unrealized P&L.
- **Sector Allocation Treemap / Risk Attribution (`RiskAttributionTreemap.tsx`):** A hierarchical map showing capital deployment across different market sectors, enabling rapid visualization of concentration risk.

### Tab 3: Agent Network & Evolution
Dedicated to tracking the performance of the AI models themselves.
- **Agent Regime Heatmap (`AgentRegimeHeatmap.tsx`):** Displays which agents thrive under specific market conditions (e.g., Bull Market, High Volatility, Stagnant).
- **Weight Adjustment Visualizer (`WeightAdjustmentVisualizer.tsx`):** Shows the historical shift in voting power. If the Macro agent goes on a losing streak, its line drops as the system strips its voting weight.
- **Agent Topology Map (`AgentTopologyMap.tsx`):** A structural view of the agent hierarchy and their data ingestion points.
- **Strategy Profit Sunburst (`StrategyProfitSunburst.tsx`):** A radial chart breaking down total gross profit generated, segmented by the agent that proposed the winning trade.

### Tab 4: Autonomous Trading (Command Center)
The mission control for the algorithmic "Black Box" bot.
- **Live Bot Telemetry Panel (`LiveBotTelemetryPanel.tsx`):** A matrix of terminal-like readouts showing the Bot's exact internal state (Running/Halted), CPU utilization simulation, network latency, and memory buffer usage.
- **Guardrails Panel (`GuardrailsPanel.tsx`):** The master risk configuration. Users can adjust:
  - Capital Allocation Limits (Max budget for the bot).
  - Position Sizing (Max % of capital per trade).
  - Volatility Circuit Breakers.
  - Hard Kill-Switches (Stop all trading if drawdown exceeds X%).
- **Strategy Bias Knobs:** Adjust the bot's risk tolerance (Conservative vs. Aggressive) and fundamental focus (Tech vs. Value).

### Tab 5: Learning & Memory (Context Engineering)
The self-improvement and reflection engine.
- **Context Memory Engineering (`ContextMemoryEngineering.tsx`):** The system's most advanced feature. When the bot loses a trade, an independent Reflection Agent analyzes the failure. It generates a "Rule" (e.g., "Do not buy semiconductors after an inverted yield curve flash"). This rule is stored in memory and injected into the prompts of future trades, creating an evolutionary context loop.
- **Semantic Event Memory Search:** A mock vector database interface. Users can search for historical macro shocks (e.g., "2008 Housing Crisis") to see how the system correlates it to current events.
- **Daily Realized P&L Chart:** A standard financial line chart tracking account equity growth or decay over time.
- **Trade History Ledger & Journal:** A complete record of all closed trades. Users can click to open a **Trade Replay Modal**, which breaks down exactly why the trade was taken, which agents voted for it, and allows the user to add personal text notes (Trade Journaling).

---

## 4. Backend Request Flow & The Autonomous Loop

### The Standard REST Flow (Manual Trade)
1. Frontend `POST /api/autobot/evaluate` with `symbol` and `newsHeadline`.
2. Backend instantiates the `GoogleGenAI` client.
3. The prompt is constructed, injecting current `portfolioState` and any historical `memoryRules` related to the asset.
4. The Gemini model returns a structured JSON response (Action: BUY/SELL/HOLD, Confidence: 0-100, Reasoning).
5. The result is passed through the `evaluateRiskConstraints` function.
6. If passed, the ledger is updated in memory.
7. The updated state is returned to the frontend.

### The Autonomous Bot Loop (server.ts)
When the bot is toggled ON (`POST /api/autobot/toggle`):
- A `setInterval` is launched, running every X seconds.
- The loop randomly selects a ticker from a predefined universe (AAPL, TSLA, BTC, etc.).
- It randomly generates a synthetic news headline.
- It executes the exact same evaluation pipeline described above, but entirely isolated from the frontend.
- The frontend simply polls `GET /api/autobot/state` every 2 seconds to fetch the updated ledgers, visualizers, and telemetry, creating the illusion of a live, humming terminal.

---

## 5. Design Philosophy & Code Architecture Directives

When modifying this repository, developers must adhere to the following principles:
- **No Unsolicited SDKs:** Do not integrate real brokerages (Alpaca, IBKR, Binance) or real vector databases (Pinecone, Weaviate) unless explicitly instructed. This is a simulated environment.
- **Architectural Honesty:** Preserve the brutalist aesthetic. The UI must feel like an advanced engineering terminal, not a consumer SaaS app. Rely on heavy data density, monospaced fonts, and tight margins.
- **Maintain the Multi-Agent Separation:** The prompt engineering and agent roles must remain distinct. Do not merge the Risk Manager and the Proposer into a single LLM call; their separation of duties is the core value proposition of the system.
