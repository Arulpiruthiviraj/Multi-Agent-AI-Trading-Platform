# Argus - DEBUGGING

Real debugging techniques for this codebase, verified 2026-08-08. Previously identical boilerplate shared with 7 other stub docs — replaced with actual guidance.

---

## Check these known gaps first — they explain most "why isn't X working" questions

1. **"My configured broker isn't active."** `BrokerManager.initialize()` — the method that reads `broker_connections` and activates your selection — is never called anywhere in `server.ts`'s startup sequence. The active broker defaults to the bare `InternalPaperBroker` placeholder regardless of configuration. See [BROKER_ENGINE.md](./BROKER_ENGINE.md).
2. **"I added an AI provider but nothing routes to it."** `configRoutes.ts`'s provider-save handler has a bug that registers a string instead of a live provider instance. `AIRouter.initialize()` only runs once, at boot. Restart the server after adding a provider through the UI.
3. **"Kronos says Ready but never predicts anything."** It can't — see [KRONOS.md](./KRONOS.md) for the exact two independent reasons.
4. **"The bot is running but nothing trades."** With no Alpaca keys, `TechnicalAgent`/`AdvancedQuantEngines` never receive a tick. With no working AI provider, `NewsEngine`'s scoring step fails silently per-article. See [AI_CONTEXT.md](./AI_CONTEXT.md) §30 for the full trace of what happens with zero configuration.
5. **"My take-profit/trailing-stop setting doesn't seem to do anything."** It doesn't — `PortfolioMonitorWorker` uses hardcoded ±5%/-3% thresholds and never reads those settings. See [RISK_ENGINE.md](./RISK_ENGINE.md).

## WebSocket debugging (real)

Connect directly to the socket (note the `/ws` path — the bare origin will not upgrade):
```js
const ws = new WebSocket('ws://localhost:5000/ws'); // no auth required, regardless of APP_PASSWORD
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```
Every EventBus event is forwarded here as `{type: <real event name>, data: <payload>}` via the wildcard listener in `server.ts`. See [EVENTBUS.md](./EVENTBUS.md) for the full catalog, including the two confirmed event-name mismatches that mean some emitted events are never actually delivered to their intended *internal* listener (they still reach the WebSocket, since the wildcard forwarding is independent of any specific listener existing).

## EventBus tracing

Server-side: every `eventBus.emit(...)` call is logged via `console.log` in the relevant agent (grep for the agent's name-prefixed log lines, e.g. `[ChiefTrader]`, `[Risk Engine]`, `[OMS]`).

Client-side: `src/hooks/useEventBusTrace.ts` filters the WebSocket stream by `traceId` across a fixed set of event types. Pass the `traceId` from any `TRADE_IDEA_GENERATED`/`CHIEF_APPROVED_IDEA`/`RISK_ASSESSMENT_COMPLETED`/`ORDER_EXECUTED` payload to follow one decision's full lifecycle.

Also useful: `GET /api/v2/system/trace/:traceId` returns the same data server-side, from the in-memory `EventStore.tradeTraces` map (not persisted — lost on restart, and note this is a *different* store than the `event_traces` DB table, which has no writer at all).

## AI Router debugging

- `GET /api/v1/config/providers` — real provider list, including `health`/`latency`/`successRate` (an EMA of real outcomes) and `cost` (always `0` — see [AI_ROUTER.md](./AI_ROUTER.md), this is a known limitation, not a bug in your setup).
- Server logs: `[AIRouter] Agent 'X' routing to <providerId>` on each attempt, `[AIRouter] Provider <id> failed: <message>. Failing over...` on each failure.
- `GET /api/v1/config/usage` — the full `ai_usage` log.

## Database debugging

- Real path is `data/argus.db`, not `sqlite.db` at the repo root (an unused leftover file).
- `better-sqlite3` is synchronous — a hung query blocks the whole event loop; there's no async driver swap available without changing the ORM adapter.
- No `SQLITE_BUSY` retry logic exists anywhere in the codebase.

## Common error messages and what they actually mean

| Message | Actual cause |
|---|---|
| `KRONOS_UNAVAILABLE: Python inference service is not reachable.` | Always thrown, unconditionally — see [KRONOS.md](./KRONOS.md). Not an environment issue. |
| `Gemini AI not initialized on the server.` (503 from `/api/v1/llm/dual-verify-trade`) | The module-level `ai` variable this endpoint checks is hardcoded to `null` in the current code, regardless of `GEMINI_API_KEY`. This endpoint is unconditionally broken — not a configuration problem. |
| `Not implemented` (from any Questrade/IBKR/Coinbase call) | Those three broker adapters are 100% stubs. Expected behavior for now — see [BROKER_ENGINE.md](./BROKER_ENGINE.md). |
| `No live price data available for <symbol>. Refusing to size a trade...` | `RiskEngine` correctly refusing rather than fabricating a price — check that `MarketDataWorker`/Alpaca is actually connected for that symbol. |

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — user-facing FAQ
- [EVENTBUS.md](./EVENTBUS.md) — full event catalog
