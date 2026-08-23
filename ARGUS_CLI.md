# ARGUS CLI

The Argus CLI is a **thin HTTP client** for a running Argus Engine.

```text
argus-cli / ./argus
    │
    │ HTTP
    ▼
Argus Engine :3000
    │
    ├── ArgusCoreBoot
    ├── TradingEngine
    ├── ChiefTrader / Consensus
    ├── RiskEngine
    ├── PositionSizing
    ├── OMS
    ├── BrokerManager
    ├── SQLite
    └── Historical Evaluation
```

The CLI does **not** contain or run its own:

* RiskEngine
* OMS
* BrokerManager
* trading decision engine
* broker execution logic

**One engine. One trading brain. The CLI is a remote control and observability client.**

Shell operator entry: [`./argus`](argus) — see [`ARGUS_SHELL_CLI.md`](ARGUS_SHELL_CLI.md).  
Name philosophy: [`README.md`](README.md) § Why "ARGUS"?  
Engine: [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md).

---

## 1. Start the Argus Engine

You can run Argus without opening the browser UI.

### Development

```bash
npm run start:engine
# or:
./argus start
```

### Production build

```bash
npm run build
npm run start:engine:prod
# or:
./argus start --prod
```

### Start through the CLI

```bash
npm run argus-cli -- start --headless
./argus start --headless
```

The default engine API address is:

```text
http://127.0.0.1:3000
```

The browser UI is optional. The engine can continue running without Vite or React.

---

## 2. Check engine status

```bash
./argus status
npm run argus-cli -- status
```

For health information:

```bash
./argus health
npm run argus-cli -- health
```

Trading readiness (LIVE readiness is currently **NO-GO** — that is expected):

```bash
./argus ready
```

The CLI communicates with the running Argus Engine over HTTP.

Daily Goal Campaign (optional; does not lower consensus — see `ARGUS_CAMPAIGN_TRACKER.md`):

```bash
# Via HTTP (same host the CLI uses)
curl -s http://127.0.0.1:3000/api/v2/campaign/status
# PATCH /api/v2/campaign/settings  { campaignEnabled, budget, dailyTargetAmount, … }
```

Recent EventBus ring (observability; not a second brain):

```bash
./argus events
npm run argus-cli -- events
```

---

## 3. Portfolio and trading information

```bash
./argus positions
./argus trades
./argus orders
```

These commands read information from the running engine and its persistence layer.

---

## 4. Observability

```bash
./argus config
./argus risk
./argus agents
./argus events
./argus logs
```

These help inspect active configuration, RiskEngine state, agent availability, EventBus activity, and diagnostics.

---

## 5. Autobot controls

```bash
./argus enable
./argus disable
```

These commands do **not** bypass Argus safety protections. RiskEngine gates, trading state machine, reconciliation, paper/live separation, LIVE readiness, and kill-switch protections remain active. The CLI only sends a control request to the Argus Application layer.

---

## 6. Emergency stop

```bash
./argus kill-switch
```

Uses the existing engine kill-switch. The CLI does not implement a separate kill switch.

---

## 7. Engine lifecycle

```bash
./argus stop
./argus restart
```

Lifecycle uses the Argus engine PID/runtime infrastructure and graceful shutdown (`drainTradingProcess`), not a second PID scheme.

---

## 8. Historical Evaluation

Historical Evaluation runs **inside the Argus Engine**. The CLI submits the request over HTTP:

```text
argus-cli / ./argus
    │ HTTP
    ▼
Argus Engine
    │
    ▼
Historical Evaluation API
    │
    ▼
FullArgusReplayEngine
    │
    ├── Agents
    ├── ChiefTrader / Consensus
    ├── RiskEngine
    ├── PositionSizing
    ├── OMS
    └── HistoricalReplayBroker
```

The CLI does not independently execute the trading engine.

### Run

```bash
./argus replay run --capital 2000 --start 2025-01-01 --end 2025-12-31
```

No symbols are required when using the default **ARGUS_DISCOVERY** universe.

### List / report

```bash
./argus replay list
./argus replay report <runId>
```

### Explicit symbols

```bash
./argus replay run \
  --universe symbols \
  --symbols AAPL,NVDA \
  --capital 2000 \
  --start 2025-01-01 \
  --end 2025-12-31
```

Historical Evaluation must not shortcut:

```text
Agents → Consensus → RiskEngine → PositionSizing → OMS → HistoricalReplayBroker
```

---

## 9. Prediction-versus-reality analysis

Historical Evaluation is not merely “run → count trades → show P&amp;L.” Reports include decision funnel, agent availability, consensus mode, risk rejections, and post-run **AFTER-THE-FACT** missed-opportunity analysis. That analysis never feeds back into decisions.

A rejected candidate can still be recorded for counterfactual outcome analysis — that does **not** mean Argus should have taken the trade.

See [`ARGUS_HISTORICAL_EVALUATION.md`](ARGUS_HISTORICAL_EVALUATION.md).

---

## 10. Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ARGUS_API_URL` | `http://127.0.0.1:3000` | Argus Engine HTTP API |
| `ARGUS_CLI_USER` / `ARGUS_CLI_PASSWORD` | — | Preferred credentials for `argus login` (never printed) |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | — | Fallback credentials for `argus login` (same as server) |
| `ARGUS_CLI_SESSION_FILE` | `data/.argus_cli_session` | Persisted `argus_session` cookie for CLI requests |
| `ARGUS_DEV_TOKEN` | Optional | Dev-only mutating token when **AUTH_PASSWORD is unset**. Ignored by the server when AUTH_PASSWORD is set — use `argus login` instead. |

### Session auth (`AUTH_PASSWORD` set)

When the engine has `AUTH_PASSWORD` configured, `/api/*` requires a session cookie from `POST /api/v1/auth/login`. The CLI does **not** bypass this with `ARGUS_DEV_TOKEN`.

```bash
# Credentials from env (never logged). Prefer ARGUS_CLI_* or reuse AUTH_*.
export ARGUS_CLI_USER="$AUTH_USERNAME"
export ARGUS_CLI_PASSWORD="$AUTH_PASSWORD"

./argus login
./argus status
./argus logout
```

On HTTP 401 the CLI exits with code **5** and tells you to run `argus login` (or unset `AUTH_PASSWORD` for localhost-only no-auth mode).

---

## Architecture summary

```text
                    ┌──────────────────┐
                    │   Browser UI     │
                    │    Optional      │
                    └────────┬─────────┘
                             │ HTTP / WS
┌───────────────┐            ▼
│  ./argus CLI  │ ───HTTP──► ARGUS ENGINE
│  (Bash shell) │            │
└───────┬───────┘            ├── Argus Core
        │                    ├── TradingEngine
        ▼                    ├── Agents / Consensus
  npm run argus-cli          ├── RiskEngine / OMS
  (TypeScript HTTP)          ├── BrokerManager
                             ├── Historical Evaluation
                             └── SQLite
```

## Core principle

> **One Core. One Trading Brain. One OMS execution boundary.**

The browser is optional. The CLI is optional. Both are adapters and clients. **The Argus Engine is the runtime that owns the trading system.**
