# ARGUS Headless / Engine Runtime

**Canonical** living doc for headless presentation and the engine daemon (Phase B–D).  
**Binding contract:** `ARGUS_ARCHITECTURE_CONTRACT.md` §15. **Name philosophy:** `README.md` § Why "ARGUS"?  
**Updated:** 2026-08-20

There is **one** trading core. Headless and `ARGUS_ENGINE` disable presentation adapters. They do not create a second RiskEngine, OMS, or `placeOrder` path. The browser is **not** required for the engine.

Express typically stays in the **same Node process** as the engine (HTTP adapter). Vite/React are not required. CLI is not a trading brain.

```
                    ARGUS CORE
              ┌─────────────────┐
              │ ArgusRuntime    │
              │ ArgusCoreBoot   │
              │ RiskEngine      │
              │ OMS             │
              │ BrokerManager   │
              └────────┬────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
      REST API     WebSocket      Vite/SPA
      (typical)    (optional)     (optional)
         │
        CLI (HTTP client; start/stop = process spawn)
```

## Entries

| Command | What runs |
|---------|-----------|
| `npm run start:engine` | `scripts/argus-engine.ts` — dedicated daemon (`ARGUS_ENGINE=true`, `ARGUS_HEADLESS=true`) |
| `npm run start:engine:prod` | `scripts/argus-engine-prod.mjs` → `dist/server.cjs` |
| `npm run dev:headless` / `start:headless` | **Delegates** to `argus-engine.ts` |
| `npm run start:headless:prod` | **Delegates** to `argus-engine-prod.mjs` |
| `npm run argus-cli -- start --headless` | Spawns the engine; then HTTP to `:3000` |

PID file: `data/.argus_engine.pid` (`claimEnginePid` in the daemon; CLI spawn also writes). Stale PIDs are reclaimed (`reconcileEnginePidFile`). Do not run two writers on the same SQLite file.

## Runtime lifecycle (`ArgusRuntime`)

| Phase | Meaning |
|-------|---------|
| `STOPPED` | Core not booted |
| `STARTING` | `bootArgusCore()` in progress |
| `RUNNING` | Core booted |
| `SAFE_MODE` | Paused / kill-switch / non-ENABLED trading state |
| `STOPPING` | Runtime stop in progress |
| `FAILED` | Boot or stop error |

`ArgusEngineRuntime` wraps `ArgusRuntime` — daemon status/health only, **not** a second brain.

## Presentation flags (`src/server/app/runtimeConfig.ts`)

| Variable | Effect |
|----------|--------|
| `ARGUS_HEADLESS=true` / `ARGUS_ENGINE=true` | Skip Vite + static SPA (`isWebUiEnabled()` false) |
| `WEB_UI_ENABLED=false` | Skip UI without the engine env |
| `WS_ENABLED=false` | Skip WebSocket adapter; trading continues |
| `API_ENABLED=false` | Reserved; API on by default (CLI needs HTTP) |

Vite is **dynamically imported** in `server.ts` only when `isWebUiEnabled()`. WebSocket `close` unsubscribes EventBus fan-out; it does **not** stop the engine.

## Runtime API

| Method | Path |
|--------|------|
| GET | `/api/v2/runtime/status` |
| GET | `/api/v2/runtime/health` |
| POST | `/api/v2/runtime/start` |
| POST | `/api/v2/runtime/stop` |
| GET | `/api/v2/runtime/config` |
| GET | `/api/v2/runtime/portfolio` |
| GET | `/api/v2/runtime/trades` |
| GET | `/api/v2/runtime/risk/status` |
| GET | `/api/v2/runtime/market/status` |
| POST | `/api/v2/runtime/trading/enable` |
| POST | `/api/v2/runtime/trading/disable` |

Enable/disable go through `TradingEngine.toggle()`. Kill switch remains `/api/v1/system/emergency-stop`. Restart does **not** auto-arm LIVE or Autobot.

## Core vs adapters

**ArgusCoreBoot** owns engine boot (AIRouter, BrokerManager before TradingEngine, workers, probes). It does not require Express, Vite, React, or WebSocket — those are adapters attached in `server.ts`.

**CLI:** `ARGUS_CLI.md`. HTTP for control/observability; `start`/`stop`/`restart` are process lifecycle only.

## Historical Evaluation

Unchanged by the daemon: `FullArgusReplayEngine` → production RiskEngine → OMS → `HistoricalReplayBroker`. See `ARGUS_HISTORICAL_EVALUATION.md`. Default universe `ARGUS_DISCOVERY`. Not organic paper. `LIVE_NO_GO`.

## Safety

- ONE RiskEngine, ONE OMS, ONE EventBus
- `PAPER_TRADING_ONLY`, LIVE_NO_GO, 24 gates, 5-layer LIVE arming
- CLI/API cannot call broker directly
- Replay isolated from live EventBus / live quote cache
