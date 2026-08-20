# ARGUS Headless Runtime Architecture

**Updated:** 2026-08-20

## Target shape

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
      REST API       CLI         WebSocket
         │             │             │
      Browser       Terminal      Monitoring
```

**One trading brain.** Adapters observe/control the same runtime.

## Runtime lifecycle

`ArgusRuntime` phases:

| Phase | Meaning |
|-------|---------|
| `STOPPED` | Core not booted |
| `STARTING` | `bootArgusCore()` in progress |
| `RUNNING` | Core booted, trading enabled path available |
| `SAFE_MODE` | Paused / kill-switch / non-ENABLED trading state |
| `STOPPING` | Runtime stop in progress |
| `FAILED` | Boot or stop error |

Methods:

- `initialize()` / `start()` — engine boot (idempotent)
- `stop()` — disable Autobot, pause trading, stop pipeline (does **not** exit Node)
- `status()` — unified snapshot
- `health()` — observability for CLI/operators

## Headless startup

```bash
npm run start:engine              # dedicated daemon (ARGUS_ENGINE=true)
npm run start:engine:prod         # dist/server.cjs, same core
npm run dev:headless              # alias → argus-engine.ts
npm run start:headless:prod       # alias → argus-engine-prod.mjs
```

Or via CLI:

```bash
npm run argus-cli -- start --headless
npm run argus-cli -- status
npm run argus-cli -- stop
```

`ARGUS_HEADLESS=true` skips Vite/static SPA. Vite is **dynamically imported** only when web UI is enabled.

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

Aliases: `/api/v2/portfolio`, `/api/v2/trades`, `/api/v2/orders`

Legacy routes (`/api/v2/system/*`, `/api/v2/data/*`) remain compatible.

## Safety

- All enable/disable routes go through `TradingEngine.toggle()`
- Kill switch: `/api/v1/system/emergency-stop` (CLI: `argus kill-switch`)
- Restart does **not** auto-enable LIVE or Autobot
- Replay still refused when `tradingMode === LIVE`

## Replay (Phase C preserved)

Historical Evaluation unchanged: `FullArgusReplayEngine` → RiskEngine → OMS → `HistoricalReplayBroker`.

## Process model

- **Default:** one Node process (engine + HTTP + WS)
- **PID file:** `data/.argus_engine.pid` when started via CLI `start`
- **Not supported:** multiple processes on same SQLite DB

## Troubleshooting

| Symptom | Check |
|---------|-------|
| CLI connection refused | Engine running? `npm run argus-cli -- health` |
| Health 503 | Core not booted — wait or POST `/runtime/start` |
| Port 3000 in use | Stop other Argus instance or prior `argus start` |

See also `ARGUS_CLI.md`.
