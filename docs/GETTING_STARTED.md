# Getting started — Argus + research ecosystem

**LIVE is NO-GO.** This guide gets a developer loop running safely. It does not create edge.

Related: [ECOSYSTEM.md](ECOSYSTEM.md) · [CONFIG.md](CONFIG.md) · [ARGUS.md](ARGUS.md) · [LOCAL_AI_SETUP.md](LOCAL_AI_SETUP.md) · root [README.md](../README.md)

---

## Trust invariant

| Layer | Role |
|---|---|
| **Argus** (`Multi-Agent-AI-Trading-Platform`) | **Sole** execution authority: EventBus → ChiefTrader → RiskEngine → OMS → Broker |
| **vibe-trading / autohedge / OpenAlice / FinceptTerminal** | Untrusted research / MCP / verification only — **never** broker credentials, wallet keys, OMS, or RiskEngine bypass |

Do not merge those repos into Argus. Do not point their trading MCPs at Argus’s order path.

---

## Recommended multi-repo layout

```text
WorkProjects/
├── Multi-Agent-AI-Trading-Platform/   ← Argus (this repo; system of record)
├── vibe-trading/                      ← Python .venv (MCP research tools)
├── autohedge/                         ← Python .venv (analysis worker; no wallet key)
├── OpenAlice/                         ← Node/pnpm Guardian MCP (verification)
└── FinceptTerminal/                   ← optional research UI/terminal (untrusted)
```

Paths are configured in Argus `.env` (`VIBE_TRADING_PATH`, `AUTOHEDGE_PATH`, `OPENALICE_PATH`, `FINCEPT_TERMINAL_PATH`). They are **not** git submodules of Argus.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js **24.18.0** | See `package.json` `engines` |
| npm | Ships with Node |
| Python 3.10+ | Chronos (`npm run setup:ai`) and sibling `.venv`s |
| pnpm (for OpenAlice) | `corepack enable` then `corepack prepare pnpm@11 --activate` |
| Optional: Ollama, IBKR Client Portal Gateway | See [LOCAL_AI_SETUP.md](LOCAL_AI_SETUP.md) / `.env.example` |

---

## Argus first boot

```bash
cd Multi-Agent-AI-Trading-Platform
cp .env.example .env
# Edit .env: AUTH_*, ENCRYPTION_SECRET, ALPACA_*, AI keys, ecosystem paths/toggles
npm install
npm run dev
```

Open `http://127.0.0.1:3000`. Migrations run on first DB import — **do not** run `npm run db:migrate` (broken).

### Startup modes

| Script | Use when |
|---|---|
| `npm run dev` | Full local ecosystem orchestrator (`scripts/ecosystem-dev.ts`) |
| `npm run dev:core` | Argus + Chronos/Ollama/OpenAlice/IBKR only (no vibe/autohedge/Fincept) |
| `npm run dev:server-only` | Node/Express/Vite only (CI, debugging boot) |

Ctrl+C on `npm run dev` must kill ecosystem children (orchestrator uses process-tree kill on Windows).

---

## Sibling repo setup (once per machine)

### vibe-trading

```bash
cd ../vibe-trading
python -m venv .venv
# Windows: .venv\Scripts\pip install -U vibe-trading-ai
# Unix:    .venv/bin/pip install -U vibe-trading-ai
```

In Argus `.env`: `ENABLE_VIBE_TRADING_MCP=true`, `VIBE_TRADING_PATH=<absolute path>`.

Orchestrator runs `.venv`’s `vibe-trading-mcp` (default `--transport http --port 8900`) and passes Argus AI keys into the **child env only**.

### autohedge

```bash
cd ../autohedge
python -m venv .venv
# install autohedge into that venv per upstream README
```

In Argus `.env`: `ENABLE_AUTOHEDGE_WORKER=true`, `AUTOHEDGE_PATH=<absolute path>`.

**Security:** `scripts/ecosystem-dev.ts` always sets `WALLET_PRIVATE_KEY=""` and `SOLANA_PRIVATE_KEY=""` in the child. Do not put funded keys in Argus `.env` expecting AutoHedge to trade.

### OpenAlice

Clone [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice) next to Argus (or set `OPENALICE_PATH` / `OPENALICE_REPO_PATH`). `pnpm install` on first boot if needed.

Guardian MCP must expose `issue_create` / `inbox_read` on `:47332`. A **trading** MCP (`placeOrder` / `getQuote`) is the wrong server for Argus verification.

### FinceptTerminal (optional)

Place checkout at `FINCEPT_TERMINAL_PATH`. Spawn is **opt-in** and requires an explicit `FINCEPT_CMD` (no invented default CLI). Until configured, leave `ENABLE_FINCEPT_TERMINAL=false`. Fincept remains outside the live order path.

---

## Verify

```bash
npx tsc --noEmit
npm test
```

Confirm logs show `[ecosystem]` lines for enabled siblings and that Argus still starts if a sibling path is missing.

---

## What this does **not** do

- Does not arm LIVE or invent strategy edge
- Does not merge external source into Argus
- Does not let research MCPs call `BrokerManager.placeOrder`
- Does not replace RiskEngine sizing with Kelly / LLM prices
