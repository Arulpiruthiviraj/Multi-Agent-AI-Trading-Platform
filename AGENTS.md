# Project Context & AI Guidelines: Argus Autonomous Trading Terminal

## Overview
This project is an advanced, multi-agent AI autonomous trading terminal interface. It features a full-stack architecture (React/Vite frontend + Express/TypeScript backend) simulating and executing continuous trading evaluations.

The core premise is utilizing Large Language Models (Gemini SDK) in a multi-agent consensus workflow to propose, verify, and execute trades, complete with a reflection mechanism to learn from losses.

## Core Features & Tabs

1. **Dashboard / Visualizers:** 
   - Displays real-time market data, correlation matrices, and agent weight voting networks.

2. **Command Center (Autonomous Trading):**
   - Controls the fully autonomous "Black Box" bot.
   - Users can configure Allocated Budget, Max Trade Cap, Strategy Focus, and Risk Level.
   - Master Kill-Switch to halt all engines.
   - Features an extensive **GuardrailsPanel** for Risk-Based Sizing, Kill-Switches, Circuit Breakers, etc.

3. **Learning & Evolution:**
   - **Strategy Backtest Engine:** Compares two strategies against simulated data (with line toggle checkboxes).
   - **Daily Realized P&L:** Visualizes performance with filtering options (Last 7 Days, Last 30 Days, MTD, YTD).
   - **Historical Trade Decisions Table:** A ledger of executed trades, featuring a custom **Trade Journal Modal** for manual note-taking and trade reflections.
   - **Memory Rules & Reflection:** The backend reflection agent extracts rules from unexpected losses and automatically feeds them into its subsequent prompts to prevent repeating mistakes.

4. **Vec Event Memory:**
   - A semantic search interface for finding historical market precedents based on macro shocks or news events.

## Backend Architecture (server.ts)

The backend provides a persistent simulation loop for the autonomous trading bot using an `autoBotState` object.

### Multi-Agent Workflow:
1. **Agent 1 (The Proposer):** Scans the market, proposes a trade (BUY/SELL/HOLD), and attaches a confidence score based on the user's strategy focus and risk level. Injects past learnings into its prompt.
2. **Agent 2 (The Risk Manager / RiskVerification Node):** Evaluates the Proposer's decision against system-wide risk tolerance, historical learned context, and **hard ATR-based mathematical constraints**:
   - Computes the 14-period **Average True Range (ATR)** using Wilder's smoothed moving average method on simulated historical High, Low, and Close prices.
   - Forces proposed stop-losses to a **minimum of 1.5x the current ATR value** to prevent noise stop-outs.
   - **Dynamically scales trade size** based on the ATR-adjusted risk cap. It computes the maximum allowable shares to trade such that the potential loss from a stop-out does not exceed the risk capital allocation (e.g., 1.0% of budget for Low, 1.5% for Medium, 3.0% for High risk levels).
   - Vetos the trade if it breaches system constraints, or approves it with the ATR-adjusted guardrails safely locked in.
3. **Agent 3 (Reflection / Memory Engine):** Periodically reviews open position drawdowns. Converts losses into strictly formatted "Learned Rules" which are persisted in `autoBotState.memoryRules`. These rules are dynamically injected back into the prompts of Agent 1 and 2 (Context/Memory Engineering).

### State Management:
- `autoBotState`: An in-memory object storing the active configuration, transaction history logs, learned rules, and global budget limits.
- Endpoints like `GET /api/autobot/state` and `POST /api/autobot/toggle` allow the frontend to sync and forcefully control the Node.js bot loop.

## Frontend Architecture (src/App.tsx & src/components/)

The React SPA utilizes Tailwind CSS for styling, Recharts for data visualization, and `lucide-react` for iconography.
- The UI is deeply stylized with dark, technical themes (`#0A0F16`, `#1A1F2B`) and uses sharp contrast via `indigo`, `emerald`, `amber`, and `rose` color accents.
- Uses extensive `font-mono`, `uppercase`, and `tracking-widest` tailwind classes for headers and labels to maintain a technical "trading terminal" aesthetic.

## AI AI Studio Configuration Directives

When modifying this repository, AI agents MUST adhere to these rules:

1. **Maintain the Multi-Agent Architecture:** Whenever updating backend bot logic in `server.ts`, preserve the Context Engineering injection points (e.g., `${pastContext}`). Do not delete or bypass the Risk Manager and Reflection Engine.
2. **Design Language Strictness:** Use Tailwind utility classes matching the existing theme exactly. Avoid unstyled standard components. Preserve the brutalist structural aesthetic. 
3. **Commenting Requirement:** Ensure all major functional pieces are heavily documented via code comments. For React blocks, use the structural ASCII banners (e.g., `/* === COMPONENT: Name === */`) so the massive file remains highly scannable for developers.
4. **Mock Execution Awareness:** Understand that outside of the Gemini LLM calls, the "execution" of trades is purely mocked in state. Do not attempt to integrate real brokerage APIs (Alpaca, IBKR) unless explicitly requested by the user.
