# Ecosystem runbook

How Argus coexists with sibling research engines under `npm run dev` → `scripts/ecosystem-dev.ts`.

**Invariant:** Argus alone may execute. External services are untrusted research / verification inputs.

---

## Process map

```text
npm run dev
  └─ scripts/ecosystem-dev.ts          ← loads Argus .env; tracks child PIDs
        ├─ (opt) Vibe-Trading MCP      ← .venv python / vibe-trading-mcp
        ├─ (opt) AutoHedge             ← .venv; WALLET_PRIVATE_KEY forced ""
        ├─ (opt) OpenAlice Guardian    ← pnpm; lite mode; no trading MCP
        ├─ (opt) FinceptTerminal       ← only if ENABLE + FINCEPT_CMD set
        └─ scripts/devWithOpenAlice.ts ← Chronos, Ollama, IBKR, tsx server.ts
              └─ Express + Vite SPA :3000
```

| Fallback | Behavior |
|---|---|
| `npm run dev:core` | Skip vibe / autohedge / Fincept; keep Chronos/Ollama/OpenAlice/IBKR |
| `npm run dev:server-only` | Node only |

Missing sibling directories or `.venv` binaries → **warn and continue**. Argus always attempts to boot.

---

## Security matrix

| Asset | Allowed in external child? | Notes |
|---|---|---|
| `OPENAI_API_KEY` / other LLM keys | Yes (passed for research) | Centralized in Argus `.env` |
| Alpaca / IBKR / Coinbase broker secrets | **No** (do not forward) | Orchestrator does not inject broker secrets into vibe/autohedge |
| `WALLET_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` | **Forced empty** for AutoHedge | Prevents on-chain execution from this launcher |
| OpenAlice | No broker credentials | Read-only Guardian verification; never blocks RiskEngine |
| RiskEngine / OMS | Argus only | External engines never call `placeOrder` |

---

## Toggle reference

| Variable | Default in orchestrator | Effect |
|---|---|---|
| `ENABLE_VIBE_TRADING_MCP` | off unless `true` | Spawn Vibe MCP |
| `ENABLE_AUTOHEDGE_WORKER` | off unless `true` | Spawn AutoHedge CLI/worker |
| `ENABLE_OPENALICE` | on unless `false` | Spawn Guardian; sets `ARGUS_SKIP_OPENALICE` for core to avoid double spawn |
| `ENABLE_FINCEPT_TERMINAL` | off unless `true` | Spawn only when `FINCEPT_CMD` is also set |
| `ARGUS_SKIP_*` | see `.env.example` | Skip Chronos / Ollama / OpenAlice / IBKR inside `dev:core` |

Paths: `VIBE_TRADING_PATH`, `AUTOHEDGE_PATH`, `OPENALICE_PATH` (alias `OPENALICE_REPO_PATH`), `FINCEPT_TERMINAL_PATH`.

---

## Venv trick (Windows / Unix)

Orchestrator does **not** run `activate`. It resolves:

- Windows: `<repo>/.venv/Scripts/python.exe` and `*.exe` console scripts  
- Unix: `<repo>/.venv/bin/python` and scripts without extension  

If the console script is missing, it may fall back to `python -m <module>` when a fallback module is configured.

---

## Graceful shutdown

`SIGINT` / `SIGTERM` on the orchestrator:

1. Marks shutdown in progress  
2. Walks tracked child PIDs  
3. On Windows: `taskkill /pid <pid> /T /F` (kills process tree)  
4. On Unix: `child.kill(signal)`  

Do not Ctrl+C only an inner terminal and leave `ecosystem-dev` orphaned — stop the top-level `npm run dev` process.

---

## Signal ingestion honesty

Today’s orchestrator **starts** research processes for local development. It does **not** auto-wire their outputs into RiskEngine or invent a second OMS. Any future “signal normalizer” must:

1. Treat external payloads as untrusted  
2. Emit at most `TRADE_IDEA_GENERATED` (or research-only tables)  
3. Still require ChiefTrader + full RiskEngine + OMS  

Until that adapter exists, treat vibe / autohedge / Fincept as **sidecar research**, not live voters.

---

## Troubleshooting

| Symptom | Check |
|---|---|
| `[ecosystem] directory does not exist` | Absolute path in `.env`; layout under `WorkProjects/` |
| `no .venv Python` | Create venv + install package in that sibling |
| OpenAlice trading MCP tools | Wrong server — need Guardian `issue_create` / `inbox_read` |
| AutoHedge tries to trade | Confirm child env has empty wallet keys; never fund keys for this launcher |
| Port already in use | Another instance still running; kill tree or change port override |

Full env commentary: [CONFIG.md](CONFIG.md). Setup steps: [GETTING_STARTED.md](GETTING_STARTED.md).
