# Argus Autonomous Trading Terminal - System Audit & Remediation Plan

## 1. Executive Summary
The Argus platform currently functions as a loosely coupled prototype. While advanced AI interactions and mock workflows exist, many frontend components rely on disjointed REST polling, fake local state (Math.random, setInterval), and hardcoded simulations instead of consuming the centralized WebSocket event streams. 

The backend Express server (`server.ts`) is a monolithic file handling APIs, state, event broadcasting, and autonomous bot loops. The AI and Broker routing systems are partially implemented but lack cohesive integration across the platform.

This remediation plan outlines the exact steps to modularize the architecture, establish a single source of truth, implement global real-time WebSockets, and eliminate all mock functionality.

## 2. Dependency & Architecture Audit

### Identified Issues
- **Broken Workflows**: The frontend has a `<SetupWizard>` that calls `/api/v1/config/settings`, but the main React App state (like AutoBot mode) often drifts from the backend SQLite DB state.
- **Mock Implementations & Fake Data**:
  - `server.ts` uses `Math.random()` extensively for market prices, volatility, delays, and slippage when in "Simulation Mode", but this logic is tightly coupled into the core loop.
  - Several frontend charts and components use `setInterval` to generate fake data instead of listening to the backend.
- **WebSocket Fragmentation**: 
  - `server.ts` broadcasts `eventBus` events to `/ws`.
  - Only `DigitalTwinVisualizer.tsx` connects to `/ws` directly.
  - Other components rely on `fetch()` polling or fake local timers.
- **Monolithic Server**:
  - `server.ts` is over 4,000 lines long, containing DB initialization, REST API routes, the `autoBotState` object, and the execution loop.
- **State Management**:
  - `autoBotState` lives in memory in `server.ts`. It synchronizes partially with SQLite, but a server restart loses transient context.
- **AI Provider System**:
  - `AIProviderManager` exists but is not fully integrated into all Agents (e.g. `ChiefTraderAgent`, `RiskAgent`, `ReflectionEngine`).

## 3. Remediation Strategy

### Phase 1: Frontend State & Real-Time Sync
1. **WebSocketProvider**: Create a global React Context `src/context/WebSocketContext.tsx` that manages a singleton WebSocket connection with auto-reconnect, exponential backoff, and state buffering.
2. **Global State Provider**: Create `src/context/ArgusStateContext.tsx` to hold the authoritative synchronized state (Orders, Portfolio, AI Events) fed by the WebSocket.
3. **Refactor Components**: Replace `setInterval` polling and `Math.random` generation in all charts (e.g., `LiveTradeJourneyOverlay`, `RiskAttributionTreemap`) to consume `WebSocketContext`.

### Phase 2: Backend Modularization
1. **API Router**: Extract all `app.get` and `app.post` routes from `server.ts` into a dedicated `src/server/routes/` directory.
2. **Trading Engine**: Decouple the autonomous bot loop from `server.ts` into `src/server/engines/TradingEngine.ts`.
3. **Broker Engine**: Expand `BrokerEngine.ts` to support plugin abstractions (Alpaca, Coinbase, Simulation) and ensure all trades route through `src/server/services/OrderManagement.ts`.

### Phase 3: AI & Intelligent Routing
1. **AI Routing Engine**: Update `AIProviderManager.ts` to implement quota tracking and task-based routing.
2. **Agent Refactoring**: Update `MacroAgent`, `RiskAgent`, `TechnicalAgent`, and `ReflectionEngine` to request inferences via `AIProviderManager.getInstance().generateWithFallback(prompt, 'gemini')`.

### Phase 4: Initialization & Storage
1. **SQLite Persistence**: Ensure all Settings, AI Keys, and Broker Credentials save to and restore from `src/server/db/schema.ts`.
2. **Onboarding Flow**: Polish the `<SetupWizard>` to detect existing configurations and provide a "Ready to trade" fast-path.

## 4. Next Steps
We will begin immediately by implementing the `WebSocketContext` on the frontend and decoupling the monolithic `server.ts` routes.
