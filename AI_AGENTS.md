# Argus AI Agent Architecture

Real agent roster and interaction flow, verified against `src/server/services/*` and `src/server/engines/*` on 2026-08-08.

## Agent Roster (verified status)

1. **`ChiefTraderAgent`** (`src/server/services/ChiefTraderAgent.ts`) — ✅ real. Receives all `TRADE_IDEA_GENERATED` events, applies dynamic weights (from `agent_performance_stats`, synced every 10s), computes a weighted consensus, and optionally triggers a real multi-provider AI debate (60s per-symbol cooldown) before deciding. Approves at weighted confidence > 0.75.
2. **`KronosForecastAgent`** (`src/server/services/KronosForecastAgent.ts`) — 🔴 **broken, never fires**. It listens for `'MARKET_DATA_UPDATED'`, an event nothing in this codebase emits, and even if it did fire, the underlying `KronosInference.predict()` unconditionally throws. See [KRONOS.md](./KRONOS.md) for the full evidence.
3. **`NewsEngine`** (`src/server/news/NewsEngine.ts`) — ✅ real. RSS ingestion (3 feeds, no key needed) plus 4 real paid APIs (key-gated). AI scoring of impact/trading-bias depends on a working `AIRouter` provider.
4. **`TechnicalProposerAgent`** (`src/server/services/TechnicalAgent.ts`) — ✅ real. Pure math (RSI/MACD/Bollinger Bands), no LLM call. Requires real `MARKET_DATA` ticks (Alpaca keys).
5. **`MacroEconomyAgent` / `FundamentalAnalysisAgent`** (`src/server/services/MacroAgent.ts` / `FundamentalAgent.ts`) — 🟡 real but limited: 3 hardcoded symbols each, dual-gated on an AlphaVantage key and a working AI provider. Emit a `HOLD`/`confidence:0` placeholder idea when data is unavailable rather than fabricating a signal.
6. **`RiskValidationAgent` / `RiskEngine`** (`src/server/services/RiskAgent.ts`, `src/server/engines/RiskEngine.ts`) — ✅ real. Hard-coded math, no LLM. ATR-based sizing, daily-loss/consecutive-loss/concentration circuit breakers, all computed from real trade history and real broker state. See [RISK_ENGINE.md](./RISK_ENGINE.md).
7. **`PortfolioMonitorWorker`** (`src/server/services/PortfolioMonitor.ts`) — ✅ real, but uses hardcoded ±5%/-3% exit thresholds rather than the configurable `takeProfitPct`/`trailingStopPct` settings.
8. **`ReflectionEngine`** (`src/server/services/ReflectionEngine.ts`) — 🟡 real half of a loop. Scores agents against real subsequent price movement, updates `agent_performance_stats.currentWeight` (this genuinely changes future consensus math), and writes one-sentence rules into `learned_rules` after losses via an LLM call. **The rule text is never read back into any agent's prompt** — only the numeric weight update closes a feedback loop.
9. **`AdvancedQuantEngines`** (`src/server/engines/AdvancedQuantEngines.ts`) — 🟠 real math (ATR/ADX/VWAP/OBV/MFI/Stochastic), but its output is never consumed by `ChiefTraderAgent` or `RiskEngine` — only broadcast to the frontend.
10. **`MarketRegimeAgent`** (`src/server/services/MarketRegimeAgent.ts`) — 🟠 real LLM call every 5 minutes, but the prompt is based on general model knowledge, not live computed indicators, and its output (`MARKET_REGIME_DETECTED`) has zero listeners anywhere in the codebase.
11. **`ExplainabilityAgent`** (`src/server/services/ExplainabilityAgent.ts`) — ✅ real, by design a post-hoc explainer (writes a Markdown report to `explainability_reports` after execution/veto) — correctly does not influence the decision it explains.

## Real Interaction Flow

```
MARKET_DATA (real tick, Alpaca) / independent timers (news, macro, fundamental, portfolio)
   ↓
Agents publish TRADE_IDEA_GENERATED (confidence always on a 0-1 scale)
   ↓
ChiefTraderAgent aggregates per-symbol, optionally debates via AIRouter.routeConsensus,
   weighs by agent_performance_stats.currentWeight
   ↓ (if weighted confidence > 0.75)
CHIEF_APPROVED_IDEA
   ↓
RiskAgent → RiskEngine: real ATR sizing + real circuit breakers against real trade/portfolio state
   ↓ (if approved)
RISK_ASSESSMENT_COMPLETED → OrderManagementService → BrokerManager → real broker call
   ↓
ORDER_EXECUTED → trades table (with real profitLoss for SELL fills)
   ↓
ReflectionEngine (60s later): scores agents against real price movement, updates weights,
   writes a learned_rules row (text never re-injected into prompts)
```

There is no `POSITION_CLOSED` event and no unified state-machine "cycle" driving all of this — each agent above runs independently on its own timer or event trigger. See [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md) for why.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [AGENTS.md](./AGENTS.md) — modification guidelines
- [DATA_FLOW.md](./DATA_FLOW.md) — full payload-level trace
