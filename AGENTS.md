# Project Context & AI Guidelines: Argus Autonomous Trading Terminal

Guidelines for AI agents (Claude, GPT, etc.) modifying this codebase, corrected against the actual current implementation on 2026-08-08. **A prior revision of this file described the system as "purely mocked in state" outside of Gemini LLM calls, and instructed agents not to integrate real brokerage APIs "unless explicitly requested."** That description is stale — real Alpaca integration (market data WebSocket + REST order placement) exists and is live-capable today. Treat any guidance elsewhere in this repo that assumes execution is mocked as outdated until re-verified.

---

## Overview

Argus is a full-stack multi-agent trading application: React 19/Vite frontend + Express/TypeScript backend. A set of independent background agents analyze market/news/macro/fundamental data and publish ideas onto an EventBus; a weighted consensus, a real risk engine, and a real order-management layer turn approved ideas into real (paper or live) broker orders. See [AI_CONTEXT.md](./AI_CONTEXT.md) for the full current-state reference — read it before making claims about what any part of this system does.

**Before you write "this is mocked" or "this works" about any component, verify it against the source.** This repository has a documented history of both directions of error: docs claiming mock behavior for code that's actually real (the old version of this file), and docs claiming full implementation for code that's actually broken (Kronos, in multiple prior revisions of `KRONOS.md`).

---

## What's real vs. what to be careful with

| Area | Status |
|---|---|
| Real order execution via Alpaca | ✅ Real — see [BROKER_ENGINE.md](./BROKER_ENGINE.md) |
| Questrade / Interactive Brokers / Coinbase | 🔴 Non-functional stubs — do not present changes near these as making them "work" unless you've implemented real API calls |
| Risk engine (ATR sizing, circuit breakers) | ✅ Real, see [RISK_ENGINE.md](./RISK_ENGINE.md) |
| Kronos forecasting | 🔴 Cannot produce output under any configuration — see [KRONOS.md](./KRONOS.md) |
| AI cost tracking | ⚪ Fake — always `$0` for every provider |
| Reflection/learning loop | 🟡 Partial — agent weights feed back into consensus for real; rule *text* is never injected into any prompt |

---

## Rules for modifications

1. **Preserve the multi-agent architecture.** Route AI calls through `AIRouter` (`src/server/ai/AIRouter.ts`) — never instantiate a provider SDK directly in an agent. Route broker calls through `BrokerManager` (`src/brokers/BrokerManager.ts`) — never call a broker's API directly from a new agent. Preserve the EventBus flow (`TRADE_IDEA_GENERATED` → `CHIEF_APPROVED_IDEA` → `RISK_ASSESSMENT_COMPLETED` → `ORDER_EXECUTED`) rather than short-circuiting it.
2. **Do not bypass `RiskEngine`.** Every path that can place a real order (`OrderManagementService.executeOrder()`) must be reached only via an `approved: true` `RISK_ASSESSMENT_COMPLETED` event. The legacy `/api/v1/signals` endpoint already bypasses this — don't add new bypasses.
3. **Design language**: match the existing Tailwind dark theme (`#0A0F16`/`#1A1F2B` backgrounds, `indigo`/`emerald`/`amber`/`rose` accents, heavy `font-mono`/`uppercase`/`tracking-widest`). See [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md).
4. **Don't add generic header-comment boilerplate.** Most files in this repo carry an identical "Core implementation and logic for the X.ts module..." header that describes nothing specific. If you add a header comment, make it actually describe the module's real inputs/outputs/dependencies, or don't add one.
5. **Check for event-name mismatches before wiring a new listener.** Two confirmed mismatches already exist in this codebase (`MARKET_DATA` vs. `MARKET_DATA_UPDATED`; `LEARNED_NEW_RULE` vs. `NEW_RULE_LEARNED` — see [EVENTBUS.md](./EVENTBUS.md)). Verify the exact emitted string, not what a doc or a similarly-named agent assumes it is.
6. **Testing**: there is no test suite. Any test you add is a net improvement — there's no existing convention to conform to beyond "use Paper trading mode, never live, for anything you run yourself."
7. **Database changes**: update `src/server/db/schema.ts`, then run `npx drizzle-kit generate` and review the generated SQL under `drizzle/` before committing. The `npm run db:migrate` script is broken (points at a nonexistent path) — don't rely on it, and don't "fix" it by creating a `database/` directory; migrations already run automatically from `db/index.ts` on import.
8. **Documentation**: if you change behavior that a `.md` file describes, update that file in the same change. A stale doc is worse than no doc in this repo specifically, because prior agents have trusted these docs at face value and shipped incorrect work as a result (see `CODE_AUDIT_REPORT.md`, `FINAL_ANALYSIS.md` for the history).

---

## Common tasks

### Adding a new agent
1. Create the class in `src/server/services/`.
2. Subscribe to the real EventBus event (verify the exact string in `EventBus.ts` or [EVENTBUS.md](./EVENTBUS.md) first).
3. Emit `TRADE_IDEA_GENERATED` with `confidence` on a **0-1 scale** (all real emitters use this scale consistently — a prior bug in the multi-provider debate path used a 0-100 scale and silently broke consensus math; don't reintroduce that class of bug).
4. Add a default weight for your agent name in `ChiefTraderAgent`'s `agentWeights` map, and seed a corresponding row in `agent_performance_stats` if you want it to participate in the dynamic-weight sync.
5. Add a UI component if needed, and wire an actual `subscribe()` call to consume its output — don't assume the WebSocket wildcard broadcast alone makes something "connected to the UI" (see [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md) — most broadcast events currently have zero frontend consumers).

### Adding a new AI provider
1. Implement the `AIProvider` interface (`src/server/ai/providers/AIProvider.ts`) in a new file under `src/server/ai/providers/`.
2. **Implement a real `estimateCost()`.** Every existing concrete provider returns `0` — don't copy that pattern; it's a known gap, not a convention to follow.
3. Register it in `AIRouter.initialize()`'s provider-detection branch.
4. Note: saving a new provider via the config UI does not make it routable without a server restart (known bug in `configRoutes.ts` — see [AI_ROUTER.md](./AI_ROUTER.md)). Fix that bug if you're touching this area, rather than working around it silently.

### Adding a new broker
Implement `BrokerPlugin` (`src/brokers/BrokerAdapter.ts`) for real — don't add another stub that returns zeros/throws, since three of those already exist and are actively misleading in the UI (see [BROKER_ENGINE.md](./BROKER_ENGINE.md)).

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master current-state reference
- [AI_AGENTS.md](./AI_AGENTS.md) — agent roster and interaction flow
- [AI_ROUTER.md](./AI_ROUTER.md) — AIRouter implementation detail
