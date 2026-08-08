# Argus - TROUBLESHOOTING

Real FAQ, verified against source 2026-08-08. Previously identical boilerplate shared with 7 other stub docs in this repository — replaced with real content. For deeper debugging technique (WebSocket, EventBus, AIRouter), see [DEBUGGING.md](./DEBUGGING.md).

---

### "The bot is enabled but never trades."

Most likely cause: no configuration at all, which is not a bug but the documented degraded state. Without Alpaca keys, `MarketDataWorker` idles and `TechnicalAgent`/`AdvancedQuantEngines` never receive a tick. Without a working AI provider key, `NewsEngine`'s scoring step fails silently per-article and `FundamentalAgent`/`MacroAgent` only emit `HOLD` placeholders. See [AI_CONTEXT.md](./AI_CONTEXT.md) §30 for the full trace.

### "I configured Alpaca but the active broker still seems to be the paper simulator."

Confirmed gap: `BrokerManager.initialize()` (the method that reads your broker configuration and activates it) is never called from `server.ts`'s startup sequence. See [BROKER_ENGINE.md](./BROKER_ENGINE.md).

### "Kronos shows 'Ready' but never predicts anything."

It can't, under any configuration — this is architectural, not a config issue. See [KRONOS.md](./KRONOS.md) for the exact two independent reasons (dead trigger event + unconditional throw in the inference call).

### "I selected Questrade/Interactive Brokers/Coinbase and it said it connected, but my order was rejected."

Expected. Those three adapters are 100% stubs — `authenticate()` always returns `true` (so "connecting" always appears to succeed), but `placeOrder()` throws `Not implemented`. See [BROKER_ENGINE.md](./BROKER_ENGINE.md).

### "My take-profit / trailing-stop setting doesn't seem to change anything."

It doesn't, currently. `PortfolioMonitorWorker` (the only code that scans positions for exit criteria) uses hardcoded ±5%/-3% thresholds and never reads `settings.takeProfitPct`/`trailingStopPct`. See [RISK_ENGINE.md](./RISK_ENGINE.md).

### "AI cost / spend numbers are always $0."

Real limitation, not a display bug. No concrete `AIProvider` implementation overrides `estimateCost()` — every one inherits the `BaseAIProvider` default of `0`. See [AI_ROUTER.md](./AI_ROUTER.md).

### "I added a new AI provider in Settings but it's never actually used."

Known bug: the provider-save endpoint registers a string where `AIRouter` expects a live provider instance. Restart the server — `AIRouter.initialize()` only runs once, at boot, and will pick up the new DB row correctly on the next start.

### "Some UI panels never seem to update with real numbers."

Some of them are intentionally static mock data — 9 chart panels in `App.tsx` (win-rate, drawdown, backtest curve, benchmark, token consumption, heatmap, risk decomposition, latency, swarm transcripts) render hardcoded arrays, not a live feed. See [FRONTEND_GUIDE.md](./FRONTEND_GUIDE.md).

### "The backtest results look suspiciously constant."

They are constant — both backtest endpoints (`POST /api/v1/backtest` and `POST /api/v2/system/backtest`) return hardcoded numbers regardless of input. See [API_REFERENCE.md](./API_REFERENCE.md).

### "`npm run db:migrate` fails."

Expected — that script points at a nonexistent `database/migrate.ts` path. There's nothing to run manually; migrations execute automatically whenever the server starts. See [DATABASE.md](./DATABASE.md).

### "`npm run lint` doesn't seem to catch anything."

It can't — it's a no-op placeholder script that just prints a message. Use `npx tsc --noEmit` for real type-checking.

### "The Setup Wizard keeps reappearing every time I refresh the page."

Expected — its completion state is a plain in-memory React boolean with no persistence (no `localStorage`, no cookie, no backend flag). It also has no effect on backend trading regardless of whether it's shown or dismissed. See [AI_CONTEXT.md](./AI_CONTEXT.md) §5.

### "Database is locked" errors

No `SQLITE_BUSY` retry logic exists in this codebase. If you're running more than one instance against the same `data/argus.db`, that's the likely cause — this app assumes a single writer process.

---

**See Also**:
- [DEBUGGING.md](./DEBUGGING.md) — deeper technique
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference with full evidence for every item above
