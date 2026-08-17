# Configuration reference

Canonical env commentary lives in root `.env.example`. This page summarizes **ecosystem**, **auth/bind**, and **credential isolation** for operators.

Living system: [ARGUS.md](ARGUS.md) · catalogs: [ARGUS_REFERENCE.md](ARGUS_REFERENCE.md) · runbook: [ECOSYSTEM.md](ECOSYSTEM.md)

---

## Trust rules for secrets

1. Put LLM and research API keys in **Argus** `.env` once. `scripts/ecosystem-dev.ts` may forward **selected AI keys** into research children.
2. **Never** design external engines as holders of Alpaca/IBKR order credentials for Argus execution.
3. AutoHedge: orchestrator **overrides** `WALLET_PRIVATE_KEY=""` and `SOLANA_PRIVATE_KEY=""` on every spawn. Do not treat a funded key in `.env` as “enabled trading” for AutoHedge under `npm run dev`.
4. OpenAlice must not receive broker credentials; Guardian is verification-only.
5. Production: set `AUTH_PASSWORD` (+ session secret). If unset in development, API binds **`127.0.0.1` only** and logs a loud WARNING.

---

## Ecosystem paths & toggles

| Variable | Purpose |
|---|---|
| `VIBE_TRADING_PATH` | Absolute path to vibe-trading checkout |
| `AUTOHEDGE_PATH` | Absolute path to autohedge checkout |
| `OPENALICE_PATH` | Absolute path to OpenAlice (also mirrored as `OPENALICE_REPO_PATH` for core) |
| `FINCEPT_TERMINAL_PATH` | Absolute path to FinceptTerminal (optional) |
| `ENABLE_VIBE_TRADING_MCP` | `true` → spawn Vibe MCP via `.venv` |
| `ENABLE_AUTOHEDGE_WORKER` | `true` → spawn AutoHedge via `.venv` |
| `ENABLE_OPENALICE` | `false` → skip Guardian spawn in ecosystem |
| `ENABLE_FINCEPT_TERMINAL` | `true` → spawn only if `FINCEPT_CMD` is set |
| `VIBE_TRADING_MCP_PORT` | Default `8900` |
| `VIBE_TRADING_MCP_ARGS` | Override CLI args (whitespace-separated) |
| `AUTOHEDGE_CMD` | Optional override args for AutoHedge CLI |
| `AUTOHEDGE_WORKSPACE_DIR` | Workspace dir passed to AutoHedge |
| `FINCEPT_CMD` | **Required** for Fincept spawn (no silent default binary) |

Used by `npm run dev` only. `npm run dev:core` / `dev:server-only` ignore vibe/autohedge/Fincept toggles.

---

## OpenAlice (verification)

| Variable | Purpose |
|---|---|
| `OPENALICE_ENABLED` | Argus client may call MCP |
| `OPENALICE_MCP_URL` | Must be Guardian tools, not trading MCP |
| `OPENALICE_REPO_PATH` / `OPENALICE_PATH` | Checkout location |
| `ARGUS_SKIP_OPENALICE` | Skip spawn in `dev:core` / when ecosystem already started it |
| `ARGUS_KEEP_OPENALICE_MCP_URL` | Keep a non-Guardian URL (Argus will FAIL if tools wrong) |

---

## Trading / paper safety

| Variable | Purpose |
|---|---|
| `PAPER_TRADING_ONLY=true` | `BrokerManager.setLiveMode(true)` and Alpaca LIVE arm **throw** |
| `ALPACA_*` | Real market data / paper-live broker (Argus only) |
| `IBKR_GATEWAY_*` | Local Gateway; 2FA manual |
| `QUANT_*` | Additive research/strategy flags; default off |

---

## Local companions (`dev:core`)

| Variable | Purpose |
|---|---|
| `LOCAL_AI_SERVICE_URL` / `PORT` | Chronos/Kronos default `:8008` |
| `OLLAMA_HOST` | Local LLMs |
| `ARGUS_SKIP_CHRONOS` / `ARGUS_SKIP_OLLAMA` / `ARGUS_SKIP_IBKR` | Skip companion spawn |

---

## Auth bind posture

| Condition | Bind | Log |
|---|---|---|
| `AUTH_PASSWORD` set | `0.0.0.0:3000` | Auth enabled |
| `AUTH_PASSWORD` unset (dev) | `127.0.0.1:3000` | `WARNING: AUTH_PASSWORD NOT SET. API BOUND TO LOCALHOST ONLY.` |

`PORT` env is **not** read; listen port is hardcoded **3000**.

---

## What config files are not

Reviewed JSON under `config/` (`tradingSafety.json`, strategy membership, etc.) is **not** an API/UI knob for LIVE ceilings. Do not hardcode strategy-id literals or safety thresholds in TypeScript — see `CLAUDE.md`.
