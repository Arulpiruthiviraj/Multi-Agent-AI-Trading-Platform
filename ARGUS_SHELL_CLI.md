# ARGUS Shell CLI (`./argus`)

Industry-style **operator control plane** for the Argus Engine.

```text
./argus
    ↓
Bash command router (scripts/cli/common.sh)
    ↓
npm run argus-cli  /  npm run start:engine|build|test
    ↓
Argus Engine HTTP API
    ↓
Argus Core (ChiefTrader → RiskEngine → PositionSizing → OMS → BrokerManager)
```

The shell CLI **controls** Argus. It does **not** become Argus.

Name philosophy: [`README.md`](README.md) § Why "ARGUS"?  
HTTP client details: [`ARGUS_CLI.md`](ARGUS_CLI.md).  
Engine daemon: [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md).

---

## Installation / permissions

From the repo root (Git Bash, WSL, Linux, macOS):

```bash
chmod +x ./argus   # Unix / Git Bash when supported
./argus help
```

Works from any directory:

```bash
/path/to/Multi-Agent-AI-Trading-Platform/argus status
```

`ARGUS_ROOT` is resolved from the script location, not `cwd`.

**Windows note:** Prefer Git Bash or WSL. Process start/stop still uses the existing Node `enginePid` lifecycle — Bash does not replace Windows process management with naive `kill`.

Legacy full-ecosystem DevOps script remains at [`argus.sh`](argus.sh) (`npm run argus:ecosystem`).

---

## First-time setup

1. `npm install`
2. Copy `.env.example` → `.env` (keep `PAPER_TRADING_ONLY=true` unless you own a LIVE program)
3. `./argus doctor`
4. `./argus start` (or `./argus start --headless`)
5. If `AUTH_PASSWORD` is set on the engine: `./argus login` (uses `ARGUS_CLI_*` or `AUTH_*` env; never prints password)
6. `./argus status` / `./argus health` / `./argus ready`

---

## Command reference

| Command | Delegates to |
|---------|----------------|
| `help` / `--help` / `-h` | Local help |
| `version` / `--version` | package.json + API URL |
| `start [--dev\|--prod\|--headless]` | `argus-cli start` → engine PID spawn |
| `stop` / `restart` | `argus-cli` + SIGTERM graceful path |
| `status [--json]` | `GET /api/v2/runtime/status` |
| `health [--json]` | `GET /api/v2/runtime/health` |
| `ready [--json]` | `GET /api/v2/live-readiness` |
| `enable` / `disable` | runtime trading enable/disable |
| `kill-switch` | existing emergency-stop API |
| `positions` / `trades` / `orders` | runtime portfolio APIs |
| `config` / `risk` / `agents` / `events` / `logs` | observability APIs |
| `replay run\|list\|report\|analyze\|diagnostics` | Historical Evaluation API (inside engine) |
| `login` / `logout` | Session cookie for `AUTH_PASSWORD` mode (`data/.argus_cli_session`) |
| `doctor` | local env checks (no secrets) |
| `check` | architecture protection vitest |
| `test` / `build` | `npm test` / `npm run build` |

### Examples

```bash
./argus start --headless
./argus login          # required when AUTH_PASSWORD is set on the engine
./argus status
./argus enable
./argus positions
./argus replay run --capital 2000 --start 2025-01-01 --end 2025-12-31
./argus doctor
./argus logout
./argus stop
```

### Auth note

When `AUTH_PASSWORD` is set, `ARGUS_DEV_TOKEN` is **ignored** by the server. Use `argus login` with `ARGUS_CLI_USER`/`ARGUS_CLI_PASSWORD` (or `AUTH_USERNAME`/`AUTH_PASSWORD`). See [`ARGUS_CLI.md`](ARGUS_CLI.md) § Environment variables.
---

## Help system

```bash
./argus help
./argus --help
./argus start --help
./argus replay --help
./argus replay run --help
```

### logs / events streaming

`--follow` is **not** implemented (no streaming HTTP endpoint). The shell prints a clear refusal and exits with usage code `2`. It does **not** poll in a loop. Use a single snapshot (`./argus logs` / `./argus events`) or the UI WebSocket.

---

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General failure / doctor warnings |
| 2 | Invalid usage |
| 3 | Engine unavailable |
| 4 | Not ready (e.g. LIVE not READY) |
| 5 | Authorization failure (API unauthorized — run `argus login`) |
| 6 | Safety refusal (reserved; API message preserved) |

Doctor: `0` healthy, `1` warnings, `2` critical.

---

## JSON output

```bash
./argus status --json
./argus health --json
./argus ready --json
```

JSON comes from the engine API (via `argus-cli`), not from parsing human text.

---

## Development vs production

| Mode | Command |
|------|---------|
| Dev engine | `./argus start` or `./argus start --dev` |
| Prod engine | `npm run build` then `./argus start --prod` |
| npm aliases | `npm run start:engine` / `start:engine:prod` |

Duplicate start does **not** spawn a second engine (PID + message).

---

## Engine lifecycle

```text
argus stop → argus-cli → enginePid → SIGTERM → gracefulShutdown
  → drainTradingProcess → workers stop → WAL checkpoint → clear PID
```

Normal stop never uses `kill -9`. No second PID mechanism.

---

## Historical Evaluation (`replay`)

Runs **inside** the Argus Engine. CLI is HTTP only. Results are **HISTORICAL_SIMULATION** / **NOT_PROMOTION_EVIDENCE** — never organic paper, never LIVE.

`replay analyze` / `replay diagnostics` expose **existing** report/meta evidence. They do **not** auto-change risk thresholds, consensus, agent weights, or live behavior.

See also [`ARGUS_HISTORICAL_EVALUATION.md`](ARGUS_HISTORICAL_EVALUATION.md) and [`docs/ARGUS_REPLAY_USER_GUIDE.md`](docs/ARGUS_REPLAY_USER_GUIDE.md).

---

## Doctor

Checks bash/node/npm, `node_modules`, `.env` presence (not contents), build artifact, PID staleness, API health/readiness (sends CLI session cookie when present), optional CLI session file hint, SQLite file presence. Never prints API keys, broker secrets, passwords, session cookies, or tokens.

---

## Safety model

- No RiskEngine / OMS / BrokerManager imports in Bash or `argus-cli.ts`
- No direct `placeOrder`
- No direct DB mutation for trading controls
- Autobot / kill-switch go through Argus Application APIs
- LIVE refusals are displayed, never overridden

> **One Core. One Trading Brain. One OMS. The shell CLI controls Argus — it does not become Argus.**
