# ARGUS Headless Architecture

**Phase B implemented:** 2026-08-19  
**Companion:** `ARGUS_HEADLESS_ARCHITECTURE_AUDIT.md` (Phase 0), `ARGUS_ARCHITECTURE_CONTRACT.md`

---

## 1. Current architecture

```
                    ┌─────────────────────────┐
                    │      ARGUS CORE         │
                    │  ArgusCoreBoot          │
                    │  EventBus + agents      │
                    │  ChiefTrader            │
                    │  RiskEngine + OMS       │
                    │  BrokerManager          │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                  │
              ▼                  ▼                  ▼
        Web adapter          CLI adapter       API adapter
     (Vite/static + WS)   (HTTP client)    (Express routes)
              │                  │                  │
              └──────────────────┴──────────────────┘
                         ArgusApplication
                    (single control facade)
```

There is **one** trading spine. Headless disables presentation adapters only.

---

## 2. ArgusCore boundary

**Module:** `src/server/core/ArgusCoreBoot.ts`

**Owns (engine-only boot):**

- Session recovery markers
- AIRouter initialization
- `BrokerManager.initialize()` **before** `tradingEngine.initialize()` (DEF-01)
- TradingEngine DB restore
- Boot workers: MarketDataWorker, discovery, screener, scheduler, shadow runner
- Model runtime probe
- Settings hydration

**Does not require:** Express, Vite, React, WebSocket.

**Entry:** `bootArgusCore()` or `argusApplication.bootCore()`.

---

## 3. ArgusApplication boundary

**Module:** `src/server/app/ArgusApplication.ts`

Thin facade delegating to authoritative services:

| Method | Delegates to |
|--------|----------------|
| `bootCore()` | `bootArgusCore()` |
| `setAutobotEnabled()` | `tradingEngine.toggle()` |
| `enableTrading()` / `disableTrading()` | `tradingEngine.toggle()` |
| `setTradingState()` | `tradingEngine.setTradingState()` |
| `status()` | `system`, `tradingEngine`, live readiness, pipeline snapshot |
| `positions()` / `recentTrades()` | SQLite |
| `getRecentEvents()` | EventStore ring |

No trading logic inside the application layer.

---

## 4. Web adapter

**Module:** `server.ts` (partial)

- Vite middleware (dev) when `isWebUiEnabled()`
- Static `dist/` (prod) when `isWebUiEnabled()`
- WebSocket `/ws` EventBus fan-out
- Autobot state broadcast (presentation only)

Browser disconnect does **not** stop trading.

---

## 5. API adapter

Express routes under `/api/v1`, `/api/v2` — unchanged surface.

**Fixed (Phase B):** `POST /api/v2/system/toggle` now routes through `argusApplication.setAutobotEnabled()` → `TradingEngine.toggle()` (no direct `system.start/stop` bypass).

`GET /api/v2/system/status` returns unified runtime + `consistent` flag (`system.running === tradingEngine.state.enabled`).

---

## 6. CLI adapter

**Module:** `scripts/argus-cli.ts`

Thin HTTP client — **no** RiskEngine/OMS/Broker imports.

```bash
npm run argus-cli -- status
npm run argus-cli -- positions
npm run argus-cli -- health
npm run argus-cli -- agents
npm run argus-cli -- events
```

Requires a running Argus API (`ARGUS_API_URL`, default `http://127.0.0.1:3000`).

---

## 7. Headless startup

| Command | Use |
|---------|-----|
| `npm run dev:headless` | Dev/tsx, API only, no Vite |
| `npm run start:headless` | Same (tsx → server.ts) |
| `npm run build && npm run start:headless:prod` | Production bundle, API only |
| `ARGUS_HEADLESS=true npm start` | After build, equivalent |

**Environment:**

| Variable | Effect |
|----------|--------|
| `ARGUS_HEADLESS=true` | Skip Vite + static SPA |
| `WEB_UI_ENABLED=false` | Skip UI (non-headless process) |
| `API_ENABLED=false` | Reserved; API on by default |

Trading engine behavior is unchanged in headless mode.

---

## 8. Startup ordering

1. `dotenv` + global error handlers (`server.ts` import time)
2. DB migrations (first `db` import)
3. **`argusApplication.bootCore()`** — full engine boot
4. Express + routes
5. WebSocket (optional clients)
6. Vite/static if `isWebUiEnabled()`
7. HTTP listen `:3000`

---

## 9. Shutdown ordering

`gracefulShutdown.ts` (unchanged):

1. Mark clean session
2. `tradingEngine.setTradingState(TRADING_PAUSED)`
3. `system.stop()`
4. `marketDataWorker.stop()`
5. SQLite WAL checkpoint + close
6. WebSocket + HTTP close

---

## 10. Safety invariants

Unchanged:

- ONE RiskEngine, ONE OMS, ONE EventBus
- PAPER_TRADING_ONLY, LIVE_NO_GO, kill switch, 5-layer LIVE arming
- CLI/API cannot call broker directly
- Replay isolated from live EventBus

---

## 11. Replay isolation

No Phase B changes to replay. `FullArgusReplayEngine` continues using real RiskEngine + OMS with `HistoricalReplayBroker` and no live EventBus emission.

Future: replay as environment adapter on same core abstractions (Phase 12).

---

## 12. Run without a browser

```bash
# Terminal 1 — headless engine + API
npm run dev:headless

# Terminal 2 — CLI (same runtime)
npm run argus-cli -- status

# Optional — browser dashboard (same runtime, if WEB_UI enabled)
npm run dev
# or connect to headless API only from a separate UI build
```

---

## 13. Access same runtime from CLI

CLI → HTTP → `ArgusApplication` → existing services.

Do not run a second Node process against the same SQLite file.

---

## 14. Remaining (future phases)

- Further `server.ts` decomposition (route modules only)
- In-process CLI socket (optional)
- Unified pipeline latency instrumentation (Phase 8)
- Replay as formal core adapter (Phase 12)
- `argus start/stop` top-level binary wrapping process lifecycle
