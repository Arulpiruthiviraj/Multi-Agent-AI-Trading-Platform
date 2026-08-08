# Argus - EVENT FLOW

Timing/sequencing view of the real event pipeline. For the full event catalog (who emits/consumes what) see [EVENTBUS.md](./EVENTBUS.md); for the full data-shape trace see [DATA_FLOW.md](./DATA_FLOW.md). This file previously contained generic boilerplate identical to several other stub docs in this repository — replaced with real sequencing detail on 2026-08-08.

## Why there's no single "event sequence"

There is no global trading cycle or state machine (a prior doc revision described one; it doesn't exist — see [SYSTEM_DESIGN.md](./SYSTEM_DESIGN.md)). Each agent runs on its own independent timer or event trigger:

| Agent | Trigger | Interval/condition |
|---|---|---|
| `TechnicalAgent` | `MARKET_DATA` event | Every real tick (needs Alpaca keys) |
| `AdvancedQuantEngines` | `MARKET_DATA` event | Every 5th tick per symbol, once ≥14 ticks of history exist |
| `NewsEngine` | `setInterval` | Every 10s |
| `FundamentalAgent` | `setInterval` | Every 60s, one of 3 hardcoded symbols round-robin |
| `MacroAgent` | `setInterval` | Every 75s, one of 3 hardcoded symbols round-robin |
| `PortfolioMonitor` | `setInterval` | Every 60s |
| `MarketRegimeAgent` | `setInterval` | Every 5 minutes |
| `PortfolioReconciliationWorker` | `setInterval` | Every 5 minutes |
| `ReflectionEngine.evaluateAgents()` | `setInterval` | Every 60s |
| `ChiefTraderAgent.syncWeights()` | `setInterval` | Every 10s |
| `ChiefTraderAgent`'s `recentIdeas` clear | `setInterval` | Every 60s |
| `SystemMetricsWorker.broadcastMetrics()` | `setInterval` | Every 2s |
| `KronosForecastAgent` | `MARKET_DATA_UPDATED` event | **Never** — see [EVENTBUS.md](./EVENTBUS.md) mismatch #1 |

Because ideas can arrive from any of these on their own schedule, `ChiefTraderAgent.reviewIdea()` is the actual synchronization point: it collects whatever ideas exist for a symbol in its 60-second rolling window and evaluates consensus fresh on every new idea, rather than waiting for a fixed set of agents to all report in.

## Timing considerations that matter in practice

- **Debate cooldown**: `ChiefTraderAgent` won't start a second multi-provider AI debate for the same symbol within 60 seconds of the last one, to bound cost — added specifically because the original design fanned out a fresh parallel debate to every registered provider on every qualifying idea.
- **News idea cooldown**: `NewsEngine` won't emit more than one `TRADE_IDEA_GENERATED` per symbol within a 5-minute window, for the same reason.
- **Order fill latency (internal simulator)**: `InternalPaperBroker.placeOrder()` queues the order as `PENDING`; it only fills on the next `tick()` call (driven by `BrokerManager.tick()`, called every 1000ms from `server.ts`). `OrderManagementService` polls briefly for the terminal status rather than assuming a synchronous fill.
- **Settings sync**: `ChiefTraderAgent`'s consensus weights are only as fresh as the last 10-second `syncWeights()` poll of `agent_performance_stats` — a weight change from `ReflectionEngine` can take up to 10s to take effect.

## Debugging event timing

Connect to `ws://localhost:5000/ws` directly (no auth required regardless of `APP_PASSWORD` — see [AI_CONTEXT.md](./AI_CONTEXT.md) §19) and watch the raw `{type, data}` wildcard stream to see real emission order. The `useEventBusTrace` hook (`src/hooks/useEventBusTrace.ts`) does this filtered by `traceId` for a single decision's lifecycle, and works correctly as of the current `EventBus` wildcard-forwarding implementation (a prior version of the server-side forwarding logic produced malformed messages that this hook could never match against).

---

**See Also**:
- [EVENTBUS.md](./EVENTBUS.md) — full event catalog and the two confirmed name mismatches
- [DATA_FLOW.md](./DATA_FLOW.md) — payload-level trace through the real pipeline
