# Argus: Autonomous Multi-Agent AI Trading Terminal 👁️🤖

Argus is an advanced, full-stack quantitative and narrative intelligence trading platform. By utilizing a **Multi-Agent Swarm Consensus** model alongside persistent local state and evolutionary memory feedback, Argus bridges the gap between unstructured geopolitical/macro sentiment and hard statistical execution.

This document serves as the master guide, detailing the installation, architecture, core modules, technical specifications, and production-grade database integration pipelines.

---

## 🚀 Quick Start & Installation

Argus is designed to run seamlessly in local node environments or cloud containers. It launches as a full-stack application featuring an Express.js backend (serving APIs and proxying AI requests) alongside a highly optimized React/Vite frontend.

### 1. Prerequisites
- **Node.js**: v18.0.0 or higher.
- **NPM** or **Yarn**: For package resolution and dependency hygiene.
- **Google Gemini API Key**: Highly recommended to activate the live multi-agent consensus and reflection modules.

### 2. Standard Setup Commands

```bash
# 1. Clone the repository and install all dependencies
npm install

# 2. Copy the sample environment file
cp .env.example .env
```

Open `.env` and configure your API keys and databases:
```env
# Google Gemini SDK Key (Essential for AI Agents and Reflection)
GEMINI_API_KEY=your_gemini_api_key_here

# Alpaca Trading API Credentials (Optional - For paper brokerage connections)
ALPACA_API_KEY=your_alpaca_key_here
ALPACA_API_SECRET=your_alpaca_secret_here

# Database URI (Optional - For durable persistent setups)
DATABASE_URL=postgres://user:password@localhost:5412/argus_production
```

### 3. Execution Scripts

| Command | Action | Runtime Notes |
| :--- | :--- | :--- |
| `npm run dev` | **Start Dev Server** | Launches Node Express with Vite hot-reloading middleware on Port `3000`. |
| `npm run build` | **Build App** | Compiles Vite React to `dist/` & bundles `server.ts` to `/dist/server.cjs` via `esbuild`. |
| `npm run start` | **Production Start** | Direct execution of compiled CommonJS Express server on Port `3000`. |

---

## 📊 Core Feature Modules

The Argus terminal UI is organized into high-density dashboard layouts:

### 1. Trading Arena & Live Dialogue (Dashboard)
- **Swarm Dialogue Graph**: Displays the live communication network of active LLM agents as they parse news and macroeconomic conditions in real-time.
- **Interactive Prompter**: Simulates custom macro shock news headlines (e.g., Fed interest rate hikes, trade sanctions) to see the swarm's narrative consensus build dynamically.
- **Broker Execution Logs**: Monitors successful trade executions on our paper exchange vs. trades blocked or vetoed by the independent Risk Manager.

### 2. Strategy Scanner (14-Period RSI Indicator)
The **Global Strategy Scanner** continuously parses price velocity and volume across the active asset universe (including equities, FX, and crypto).
- ** Wilder's RSI Engine**: Integrates a highly accurate 14-Period Wilder's smoothed Relative Strength Index.
- **Adaptive Signaling**:
  - **BUY Triggers (Oversold)**: Automatically flagged and highlighted in emerald green when the asset's RSI falls below **30**.
  - **SELL Triggers (Overbought)**: Automatically flagged and highlighted in rose red when the asset's RSI climbs above **70**.
- **Interactive Multi-Asset Toggling**: Click on any scanned asset within the matrix (such as `AAPL`, `NVDA`, `BTC`, or `SPY`) to instantly load its specific charting, historical news events, and multi-agent rationales in the primary workspace.
- **Dynamic Signal Filtering**: Quickly narrow down opportunities with dedicated filter presets for *All*, *Buy Signals*, or *Sell Signals*.

### 3. Holdings & Positions
- **Asset Ledger**: Displays all active positions, entry cost basis, target allocation parameters, and live unrealized P&L.
- **Sector Allocation Treemap**: Visualizes systemic risk and sector concentration (e.g., Semiconductors vs. Precious Metals) using an interactive, nested block-space layout.

### 4. Autonomous Command Center
- **The Black Box Bot**: Toggle the autonomous trading bot loop. Once activated, the backend runs a continuous execution loop generating trades independently of browser activity.
- **Sovereign Guardrails**: Set tight operational bounds including allocated capital budgets, max transaction cap percentage, volatility circuit breakers, and a master **Kill-Switch**.

### 5. Learning & Evolution
- **Context Memory Engineering**: Stores "Memory Rules" generated after realizing significant losses. The reflection engine writes strict negative-constraint rules which are dynamically injected into the system prompts of subsequent cycles, preventing repeat trading mistakes.
- **Trade Replay & Journaling**: Allows deep inspection of past multi-agent trade reasoning, supplemented by a personal interactive text journal for manual human note-taking and trade reflections.

---

## 🗄️ Database Architecture & Setup

Argus is engineered with a modular storage schema, allowing the platform to boot effortlessly with zero-config in-memory state or scale up to heavy-concurrency database backends.

```
                  ┌─────────────────────────────────┐
                  │      Argus Express Backend      │
                  │   (In-Memory State & Cache)     │
                  └────────────────┬────────────────┘
                                   │
                    Asynchronous State Synchronization
                             (Bulk Upserts)
                                   │
                                   ▼
                  ┌─────────────────────────────────┐
                  │    Relational Database Layer    │
                  │    (PostgreSQL / Cloud SQL)     │
                  └─────────────────────────────────┘
```

### 1. Local/Simulated DB (Out-of-the-Box)
By default, the server (`server.ts`) caches its state within an in-memory `autoBotState` object.
- **Best Use Case**: Rapid sandbox testing, demonstration loops, and local experimentation.
- **Behavior**: Data resets upon restarting the Node process.

### 2. Relational Database Migration (PostgreSQL / Cloud SQL)
For institutional deployments or persistent cloud hosting, connect a durable relational schema to safeguard historical logs, portfolio structures, and generated memory rules.

#### Step 1: Install Drivers and ORM
```bash
npm install drizzle-orm pg
npm install -D drizzle-kit @types/pg
```

#### Step 2: Configure Schema Definition
Define database tables matching the memory objects in `src/db/schema.ts`:
```typescript
import { pgTable, text, serial, doublePrecision, timestamp, integer } from 'drizzle-orm/pg-core';

export const portfolios = pgTable('portfolios', {
  id: serial('id').primaryKey(),
  balance: doublePrecision('balance').notNull(),
  allocatedBudget: doublePrecision('allocated_budget').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});

export const trades = pgTable('trades', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  type: text('type').notNull(), // 'BUY' | 'SELL'
  price: doublePrecision('price').notNull(),
  quantity: doublePrecision('quantity').notNull(),
  timestamp: timestamp('timestamp').defaultNow(),
  agentsConsensus: text('agents_consensus'),
  reasoning: text('reasoning')
});

export const memoryRules = pgTable('memory_rules', {
  id: serial('id').primaryKey(),
  ruleText: text('rule_text').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});
```

#### Step 3: Run Database Migrations
Create your config file (`drizzle.config.ts`) and push the schemas:
```bash
# Generate the migration files
npx drizzle-kit generate:pg

# Apply schema migrations directly to the live PostgreSQL database
npx drizzle-kit push:pg
```

---

## ⚙️ Critical Database Parameter Tuning

High-frequency, multi-agent AI loops create unique, high-concurrency database workloads. To ensure seamless execution without thread pooling exhaustion or socket crashes during active simulation, you must configure the following core database parameters:

### 1. Connection Pooling Limits (`DB_POOL_MAX`)
Because the autonomous loop (`setInterval`) triggers multiple concurrent asynchronous calls to the Google Gemini API (and records state changes simultaneously), standard database drivers can quickly exhaust standard connection pools.
- **Production Setting**: Ensure `DB_POOL_MAX` is set to **at least 50** in your database pool configuration.
- **Rationale**: Prevents client connection bottlenecks during high-frequency volatility spikes.
- **Example config**:
  ```typescript
  import { Pool } from 'pg';
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: parseInt(process.env.DB_POOL_MAX || '50'),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT_MS || '10000')
  });
  ```

### 2. Strict Query Timeouts (`DB_IDLE_TIMEOUT_MS`)
In rapidly evolving markets, locked database threads can freeze the node event loop, interrupting critical risk-checking algorithms.
- **Production Setting**: Limit connection lifetime timeouts to **10,000 milliseconds** (`DB_IDLE_TIMEOUT_MS=10000`).
- **Rationale**: Automatically terminates hanging database queries, forcing the bot to gracefully timeout, log the incident, and prioritize the survival of the autonomous agent loop.

### 3. State Synchronization (Asynchronous Bulk Flushing)
- Rather than performing synchronous transactional writes on every micro-tick of the simulation, the backend utilizes an **asynchronous caching model**.
- State is updated instantaneously in the server's in-memory cache to guarantee rapid micro-second calculations.
- An asynchronous background daemon flushes (upserts) the updated `autoBotState` cache to the PostgreSQL tables every **10–30 seconds**, drastically reducing database write overhead and ensuring server stability.

---

## 🧠 Multi-Agent Swarm Philosophy

Argus succeeds where simple rules fail by enforcing a strict separation of concerns among specialized agent personas:

```
                      ┌──────────────────────┐
                      │    Market Stimulus   │
                      │ (News / Price Data)  │
                      └──────────┬───────────┘
                                 │
                                 ▼
                      ┌──────────────────────┐
                      │    Proposer Agent    │  ◄── [Injects past Memory Rules]
                      │ (Macro/Tech Analysis)│
                      └──────────┬───────────┘
                                 │ BUY/SELL (Confidence Score)
                                 ▼
                      ┌──────────────────────┐
                      │  Risk Manager Agent  │  (Considers circuit breakers,
                      │    (Hard Veto)       │   drawdowns, and sector exposure)
                      └──────────┬───────────┘
                                 │
                     ┌───────────┴───────────┐
                     ▼                       ▼
               [APPROVED]                [VETOED]
          Simulate Paper Trade      Log Veto / Terminate
```

1. **The Proposer (Agent 1 - Tech/Macro)**: Scans technical indicator arrays (SMA20, EMA, RSI, MACD) and sentiment news feeds. Recommends buy/sell actions with a custom confidence index.
2. **The Risk Manager (Agent 2 - Sovereign Authority)**: Analyzes the proposed transaction against sector-exposure limits, daily drawdown quotas, and active circuit-breakers.
3. **The Reflection Engine (Agent 3 - Post-Mortem)**: Automatically dissects closed positions that realized losses. Formulates new programmatic system constraints (Context Memory Rules) and inserts them directly into future prompt loops.

---

*Argus: Autonomous Institutional AI Swarm Protocol. Built with React, Tailwind, Recharts, and Google Gemini.*
