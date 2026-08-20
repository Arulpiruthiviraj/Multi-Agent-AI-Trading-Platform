# ARGUS CLI

HTTP-only control interface. **Does not import RiskEngine, OMS, or BrokerManager.**

Requires a running Argus API (default `http://127.0.0.1:3000`).

## Process lifecycle

```bash
# Start dedicated engine daemon (no Vite/React)
npm run start:engine
npm run start:engine:prod   # after npm run build

# Or via CLI (spawns scripts/argus-engine.ts)
npm run argus-cli -- start --headless

# Use production build if dist/server.cjs exists
npm run argus-cli -- start --prod

# Stop engine (SIGTERM via PID file)
npm run argus-cli -- stop

# Restart
npm run argus-cli -- restart
```

PID file: `data/.argus_engine.pid`

## Runtime observability

```bash
npm run argus-cli -- status
npm run argus-cli -- health
npm run argus-cli -- config
npm run argus-cli -- risk
npm run argus-cli -- agents
npm run argus-cli -- events
npm run argus-cli -- logs
```

## Portfolio / trades

```bash
npm run argus-cli -- positions
npm run argus-cli -- trades
npm run argus-cli -- orders
```

## Trading control (subject to server safety gates)

```bash
npm run argus-cli -- enable
npm run argus-cli -- disable
npm run argus-cli -- kill-switch
```

## Historical Evaluation (Phase C)

```bash
npm run argus-cli -- replay --capital 2000 --start 2025-01-01 --end 2025-12-31
npm run argus-cli -- replay list
npm run argus-cli -- replay report <runId>
npm run argus-cli -- replay export <runId>
```

Default universe: **discovery** (no symbols required).

Advanced:

```bash
npm run argus-cli -- replay --universe symbols --symbols AAPL,NVDA --start 2025-01-01 --end 2025-03-31
```

## Environment

| Variable | Default |
|----------|---------|
| `ARGUS_API_URL` | `http://127.0.0.1:3000` |
| `ARGUS_DEV_TOKEN` | optional auth header |

## Two operating modes

**Client mode** — engine already running; CLI sends HTTP commands.

**Headless mode** — `argus start` launches engine without browser/Vite; then use any CLI command.
