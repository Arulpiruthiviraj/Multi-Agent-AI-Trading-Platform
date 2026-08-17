# Argus

Node.js multi-agent trading terminal (Express + Vite + `ws` + SQLite).

**LIVE real-money: NO-GO.** Paper: conditional. Empirical edge is not established by documentation.

**Docs:** [docs/ARGUS.md](docs/ARGUS.md) · [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) · [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md) · [docs/CONFIG.md](docs/CONFIG.md) · [docs/ARGUS_REFERENCE.md](docs/ARGUS_REFERENCE.md) · [docs/LOCAL_AI_SETUP.md](docs/LOCAL_AI_SETUP.md)

**Agents:** root `CLAUDE.md` is the live-path contract.

---

## Trust boundary (non-negotiable)

**Argus is the sole execution authority and system of record.**

External engines (`vibe-trading`, `autohedge`, `OpenAlice`, `FinceptTerminal`) are **untrusted, read-only research / signal / verification providers**. They must never:

- receive Argus broker credentials or Alpaca/IBKR secrets for order placement
- hold or use wallet private keys for on-chain execution (AutoHedge `WALLET_PRIVATE_KEY` is forcibly emptied by the orchestrator)
- bypass RiskEngine, OMS, or BrokerManager
- write to the live `trades` / `fills` path except through Argus’s own EventBus → ChiefTrader → RiskEngine → OMS pipeline

Inspiration repos (e.g. TradingAgents) are **not vendored**. Sibling checkouts stay outside this git tree.

---

## Architecture (execution + external research)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ EXTERNAL RESEARCH LAYER (untrusted · read-only · never places Argus orders) │
│  Vibe-Trading MCP (:8900) · AutoHedge worker · OpenAlice Guardian (:47332) │
│  FinceptTerminal (optional) · Chronos/Kronos (:8008) · Ollama (:11434)     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ signals / notes / verification only
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ ARGUS — SOLE EXECUTION AUTHORITY (system of record)                        │
│                                                                            │
│  MarketData / Idea Agents ──► TRADE_IDEA_GENERATED                         │
│         │                                                                  │
│         ▼                                                                  │
│  ChiefTrader (consensus) ──► CHIEF_APPROVED_IDEA                           │
│         │                                                                  │
│         ▼                                                                  │
│  RiskEngine (all gates recorded) ──► RISK_ASSESSMENT_COMPLETED             │
│         │                                                                  │
│         ▼                                                                  │
│  OMS ──► BrokerManager.getActiveBroker().placeOrder() ──► trades / fills   │
└──────────────────────────────────────────────────────────────────────────┘
```

Legacy `GET /api/v1/signals` is **HTTP 410 quarantined** — not an alternate order path.

---

## Quickstart

```bash
cp .env.example .env          # add AI/broker keys; set ecosystem paths/toggles
npm install
npm run dev                   # scripts/ecosystem-dev.ts → companions + Argus :3000
npm test
```

| Command | What it starts |
|---|---|
| `npm run dev` | `scripts/ecosystem-dev.ts`: optional Vibe / AutoHedge / OpenAlice / Fincept from `.env`, then Chronos/Ollama/IBKR + Express/Vite |
| `npm run dev:core` | Prior launcher only (`devWithOpenAlice.ts`) — Argus + Chronos/Ollama/OpenAlice/IBKR, **no** vibe/autohedge/Fincept |
| `npm run dev:server-only` | `tsx server.ts` alone (no companion processes) |

`PORT` is unused; the server listens on **3000**. Without `AUTH_PASSWORD`, the API binds **`127.0.0.1` only**.

### Ecosystem paths (`.env`)

Absolute paths to sibling repos + toggles. Missing directories log a warning and **Argus still boots**. Python services use each repo’s `.venv` interpreter directly (no `activate` required).

See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) and [docs/ECOSYSTEM.md](docs/ECOSYSTEM.md).
