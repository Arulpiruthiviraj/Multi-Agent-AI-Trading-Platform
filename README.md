# Argus

Node.js multi-agent trading terminal (Express + Vite + `ws` + SQLite). Package name `my-money-miner`.

**LIVE real-money: NO-GO.** Paper: `PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS` (supervised, conditional). Empirical edge is not established by documentation. Organic closed PAPER FILLED SELL P&L soak baseline remains **0** until soak counts real closes.

**Harness (CODE-VERIFIED 2026-09-01):** `npm run lint` exit 0 · `npm test` **428** files / **2889** tests · Node **≥24.18** (package `engines.node`) · schema **74** SQLite tables.

### Why "ARGUS"?

> **ARGUS** is named after **Argus Panoptes**, the many-eyed and ever-watchful guardian of Greek mythology.
>
> The name represents the philosophy behind the system: **many eyes, multiple perspectives, disciplined validation, and constant vigilance before action.**
>
> Argus brings together specialized analytical components to observe the market from different perspectives, evaluates those signals through consensus and risk controls, and only then allows an approved decision to reach execution.
>
> Its Historical Evaluation capability extends the same philosophy backward in time: Argus can examine what it predicted, compare those predictions with what actually happened, identify where and why its reasoning failed, and use that evidence to guide future improvements.
>
> **ARGUS: Many eyes. One disciplined decision process.**

That metaphor maps to the protected spine — it does **not** mean unlimited visibility or a second trading brain:

| Philosophy | In Argus |
|---|---|
| Many eyes | Specialized agents/engines (Technical, Quant, News/Catalyst, Fundamental, Macro **where those actually vote**; unused UI names are not live voters) |
| Continuous vigilance | Market data, 25-gate RiskEngine, reconciliation, process/health monitoring |
| Observe before acting | Discovery → ChiefTrader consensus → RiskEngine → PositionSizing → OMS → broker |
| Guarded execution | Consensus bar + min independent agents, OMS sole production `placeOrder`, kill switch, recon |
| Learning through observation | Historical Evaluation is evidence/diagnosis — **not** LIVE proof, **not** organic paper, **not** autonomous RiskEngine rewrite. `ReflectionEngine` updates weights/debate prompt only |

**Agents / operators:** root [`CLAUDE.md`](CLAUDE.md) is the single operational master spec (live path, 25-gate RiskEngine, AI routing, decision traces, soak floors, defects). Architecture checklist: [`ARGUS_ARCHITECTURE_INVARIANTS.md`](ARGUS_ARCHITECTURE_INVARIANTS.md). Name philosophy lives here; do not copy the full block into every other markdown file.

Opportunity discovery is **subscribe/rank** by default (`ARGUS_OPPORTUNITY_LOOP_ENABLED`), from a curated seed/watch list plus, when `ARGUS_BROAD_UNIVERSE_ENABLED=true`, a real liquidity/price/spread-screened Alpaca tradable-assets funnel (`MarketUniverseScanner.ts`), and, when `ARGUS_MARKET_MOVERS_ENABLED=true`, a real Alpaca top-gainers/losers screener run through the same liquidity/ADV screen — both still bounded/capped, still never a second order path. A bounded temporary-data-rescue mechanism (`MarketDataWorker.requestTemporaryDataRescue`, capped at `maxConcurrentTemporaryDataRescues`) lets a starved-but-qualifying candidate borrow a data slot; it reserves capacity fairly across routine-recovery vs. exploration/mover requests but never implies trade eligibility or bypasses any gate — see `docs/ARGUS_OPPORTUNITY_DISCOVERY.md`. Optional cheap screener ideas (`ARGUS_OPPORTUNITY_IDEAS_ENABLED`) are **one vote**, still require ChiefTrader min-2 + RiskEngine + OMS. No discovery flag arms LIVE. Do not enable flags merely to produce trades. Optional Daily Goal Campaign: [`ARGUS_CAMPAIGN_TRACKER.md`](ARGUS_CAMPAIGN_TRACKER.md) (flag-gated; does not lower consensus).

**FOR OPERATORS** (why idle / why a fill / daily health): [`docs/ARGUS_DOCUMENTATION_INDEX.md`](docs/ARGUS_DOCUMENTATION_INDEX.md) → `ARGUS_WHY_NOT_TRADING.md`, `ARGUS_DAILY_FORENSIC_CHECKLIST.md`.

**FOR DEVELOPERS** (IDs, schema, EventBus, pipeline forensics): same index → `ARGUS_FORENSIC_DEBUGGING_GUIDE.md`, `ARGUS_DATABASE_ARCHITECTURE.md`. Do not treat new markdown as LIVE evidence.

---

## Trust boundary (non-negotiable)

**Argus is the sole execution authority and system of record.**

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ EXTERNAL RESEARCH (untrusted · read-only · never places Argus orders)     │
│  Vibe-Trading MCP (:8900) · AutoHedge worker · OpenAlice Guardian (:47332) │
│  FinceptTerminal (optional) · Chronos/Kronos (:8008) · Ollama (:11434)     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ signals / notes / verification only
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ ARGUS — SOLE EXECUTION AUTHORITY                                           │
│  MarketData / Idea Agents ──► TRADE_IDEA_GENERATED                         │
│  ChiefTrader (consensus)  ──► CHIEF_APPROVED_IDEA                          │
│  RiskEngine (25 gates)    ──► RISK_ASSESSMENT_COMPLETED                    │
│  OMS ──► BrokerManager.placeOrder() ──► trades / fills                     │
└──────────────────────────────────────────────────────────────────────────┘
```

External engines (`vibe-trading`, `autohedge`, `OpenAlice`, `FinceptTerminal`) spawned by `npm run dev` must never:

- receive Argus broker credentials or Alpaca/IBKR secrets for order placement
- hold wallet private keys for on-chain execution (orchestrator forces `WALLET_PRIVATE_KEY=""` and `SOLANA_PRIVATE_KEY=""`)
- bypass RiskEngine, OMS, or BrokerManager

Inspiration repos (e.g. TradingAgents) are **not vendored**. Sibling checkouts stay **outside** this git tree.

Legacy `GET /api/v1/signals` is **HTTP 410 quarantined** — not an alternate order path.

---

## Tech stack

| Layer | Tech |
|---|---|
| Runtime | Node.js **24.18.0** (`package.json` `engines`) |
| API / realtime | Express, raw `ws` |
| SPA | React, Vite, Tailwind |
| DB | better-sqlite3 + Drizzle, WAL, `data/argus.db` (gitignored) |
| Brokers | InternalPaper (default), Alpaca, IBKR Gateway, Coinbase (live-arm), Questrade (read-only) |
| Local AI | Ollama (`:11434`), Chronos-T5-mini (`:8008`) |

Port **3000** is hardcoded. `PORT` is unused. Without `AUTH_PASSWORD`, the API binds **`127.0.0.1` only**.

---

## Architecture Direction

Argus uses a hybrid architecture, growing incrementally rather than in one rewrite:

**TypeScript/Node** owns the application/API layer, browser/UI communication (WebSocket + React),
CLI (`argus-cli.ts`), orchestration (`ecosystem-dev.ts`, `argus.sh`), configuration, and the
non-performance-critical workflows — this includes the entire protected trading spine below.

**Java 26 engine** (`quant-core-java/`) owns quantitative calculations, indicators, strategy
calculations, strategy evaluation, and high-throughput/parallelizable market computation, as an
additive, advisory-only, isolated module — see `docs/architecture/ARGUS_ARCHITECTURE.md` § Java Quant Core. It is not
currently authoritative for anything in the live/paper trading path (see "Engine Authority Rule"
below for the *forward-looking* policy on new work, not a claim about today's runtime).

### Engine Authority Rule

For **new** performance-critical trading computation, the Java 26 engine is the preferred
authoritative implementation target — do not create a new TypeScript implementation when an
authoritative Java implementation already exists for that calculation. This avoids duplicate
calculations, split-brain decisions (two engines computing competing signals), and multiple order
paths. Full policy: `CLAUDE.md`'s "Java 26 Engine Authority" section.

All trading continues through the one protected decision path, unchanged by this policy:

```
Market Data → Idea agents (incl. Java-backed Quant signals where wired) → ChiefTraderAgent
  → RiskAgent → RiskEngine (25 gates) → OrderManagementService → BrokerManager → Broker
```

This policy does **not** require migrating the React UI, Express/API layer, CLI, persistence, or
safety controls to Java — those stay TypeScript/Node.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js **24.18.0** | Matches `engines` |
| npm | Ships with Node |
| Python 3.10+ | Chronos (`npm run setup:ai` / `npm run ai:serve`) and sibling `.venv`s |
| Optional: Ollama | Local LLMs — [ollama.com/download](https://ollama.com/download) |
| Optional: pnpm | OpenAlice Guardian (`corepack prepare pnpm@11 --activate`) |
| Optional: IBKR Client Portal Gateway | `IBKR_GATEWAY_PATH`; 2FA is still manual |

Disk for local models: ~18 GB Ollama (llama3.2 / plutus / fingpt) + ~1 GB Hugging Face (FinBERT, Chronos-T5-mini). RAM: 8 GB min; 16 GB+ for 7–8B models. 14B models (`qwen2.5:14b`, `deepseek-r1:14b`) are serialized to **one** concurrent load (see `CLAUDE.md`).

Recommended sibling layout (not git submodules):

```text
WorkProjects/
├── Multi-Agent-AI-Trading-Platform/   ← this repo
├── vibe-trading/
├── autohedge/
├── OpenAlice/
└── FinceptTerminal/                   ← optional
```

---

## Environment

```bash
cp .env.example .env
```

Canonical commentary lives in `.env.example`. Do not commit secrets.

### Auth, bind, crypto

| Variable | Role |
|---|---|
| `AUTH_USERNAME` / `AUTH_PASSWORD` | Auth on when password set; production refuses unauthenticated boot |
| `AUTH_SESSION_SECRET` | Required with `AUTH_PASSWORD` in any real deployment |
| `ENCRYPTION_SECRET` | AES key for stored API keys; else generated to `data/.encryption_key` |

### Trading / brokers

| Variable | Role |
|---|---|
| `PAPER_TRADING_ONLY` | Force paper; LIVE arm throws |
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | Market data + paper/live execution |
| `IBKR_GATEWAY_URL` | Default `https://localhost:5000/v1/api` |
| `IBKR_GATEWAY_PATH` | Optional spawn from `npm run dev` |

### AI / data

| Variable | Role |
|---|---|
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `NVIDIA_API_KEY` | Router-native cloud providers |
| `ALPHAVANTAGE_API_KEY` / `POLYGON_API_KEY` / `FMP_API_KEY` / `FRED_API_KEY` / `FINNHUB_API_KEY` | Market/news |
| Extra keys in `.env.example` | May exist for future endpoints — not every key has a provider class |

### Quant / OpenAlice (default off)

| Variable | Role |
|---|---|
| `QUANT_ENGINE_ENABLED` | Additive Quant agent |
| `QUANT_ENGINE_INTERVAL_MS` | Else `tradingSafety.quantCycleIntervalMs` |
| `QUANT_SMC_STRATEGY_ENABLED` | Include SMC in live `evaluateAll()` |
| `QUANT_BULL_BEAR_ENABLED` | Qualitative Bull/Bear notes only |
| `OPENALICE_ENABLED` / `OPENALICE_MCP_URL` | Both required; Guardian tools, **not** a trading MCP |

### Ecosystem (`npm run dev` only)

| Variable | Role |
|---|---|
| `VIBE_TRADING_PATH` / `ENABLE_VIBE_TRADING_MCP` | Vibe MCP (default port 8900) |
| `AUTOHEDGE_PATH` / `ENABLE_AUTOHEDGE_WORKER` | Analysis worker; wallet keys stripped |
| `OPENALICE_PATH` / `ENABLE_OPENALICE` | Guardian spawn |
| `FINCEPT_TERMINAL_PATH` / `ENABLE_FINCEPT_TERMINAL` | Requires explicit `FINCEPT_CMD` |
| `ARGUS_SKIP_CHRONOS` / `ARGUS_SKIP_OLLAMA` / `ARGUS_SKIP_OPENALICE` / `ARGUS_SKIP_IBKR` | Skip companions |

Missing sibling directories log a warning; **Argus still boots**. Python children use each repo’s `.venv` interpreter directly (no `activate`). Ctrl+C the **top-level** `npm run dev` so the orchestrator can `taskkill` the process tree on Windows.

`npm run dev:core` and `dev:server-only` ignore vibe/autohedge/Fincept toggles.

---

## Run, test, build

```bash
npm install
npm run dev                 # http://127.0.0.1:3000
npx tsc --noEmit
npx vitest run
npm run build
npm run start               # node dist/server.cjs
```

| Command | What it starts |
|---|---|
| `npm run dev` | `scripts/ecosystem-dev.ts`: optional Vibe / AutoHedge / OpenAlice / Fincept, then Chronos/Ollama/IBKR + Express/Vite |
| `npm run dev:core` | `devWithOpenAlice.ts` — Argus + Chronos/Ollama/OpenAlice/IBKR |
| `npm run dev:server-only` | `tsx server.ts` alone |
| `npm run start:engine` | Dedicated daemon (`scripts/argus-engine.ts`) — same Argus Core, no Vite/React. PID: `data/.argus_engine.pid` |
| `npm run start:engine:prod` | Same after `npm run build` (`scripts/argus-engine-prod.mjs` → `dist/server.cjs`) |
| `npm run dev:headless` / `start:headless` | Aliases that **delegate** to `argus-engine` (`scripts/start-headless.ts`) |
| `npm run start:headless:prod` | Alias → `argus-engine-prod.mjs` |
| `./argus` / `npm run argus` | Thin Bash operator UX (`scripts/cli/common.sh` → `argus-cli`). Polished help/status only — not a second trading brain. See `ARGUS_SHELL_CLI.md` |
| `bash ./argus <command>` / `npm run argus -- <command>` | Shell operator control plane (Git Bash on Windows). Thin router over `argus-cli` / npm scripts. See [`ARGUS_SHELL_CLI.md`](ARGUS_SHELL_CLI.md) |
| `npm run argus-cli -- <command>` | HTTP client against the running API (`start`/`stop` spawn/SIGTERM the engine). Never imports RiskEngine/OMS/BrokerManager — not a second brain |
| `npm run lint` | `tsc --noEmit` |
| `npm test` | `vitest run` |
| `npm run test:e2e` | Playwright (`e2e/moduleToggleParity.spec.ts`) — seed **both** onboarding wizard and tour |
| `npm run security:scan-writes` | `scripts/scan_unallowlisted_writes.ts` |
| `npm run setup:ai` | `scripts/bootstrap_models.py` — Ollama pull + HF cache |
| `npm run ai:serve` | Chronos on `:8008` |
| `npm run clean` | Remove `dist/` |

Migrations run when `src/server/db/index.ts` is first imported. `npm run db:migrate` (`database/migrate.ts`) imports that same module.

### Local AI (`npm run setup:ai`)

Idempotent. Pulls `llama3.2:latest`, `llama3.2:1b`, `0xroyce/plutus:latest`. FinGPT: place a GGUF at `models/fingpt.gguf` (or `FINGPT_GGUF_PATH`) then re-run to `ollama create fingpt`. Boot log `[LocalAI] ...` is **non-blocking**.

`ollama list` should show `llama3.2:latest`, `llama3.2:1b`, `0xroyce/plutus:latest`, `fingpt:latest` when fully set up. Heavy 14B models (`deepseek-r1:14b`, `qwen2.5:14b`) are operator-pulled; the process serializes them (see `CLAUDE.md`).

### Paper soak (calendar, not a unit test)

Organic floor: **30** closed PAPER FILLED SELL P&L trades, **10** NY sessions, **30** calendar days (`config/researchSafety.json`). Replay / EXTERNAL_SYNC / DIAGNOSTIC do not count.

```bash
npx tsx scripts/organic_paper_soak_status.ts
# Must print JSON and return to the shell prompt (closes SQLite + process.exit).
# A hung soak script is a second DB writer — kill it; do not treat hang as soak evidence.
```

Historical Evaluation / replay fills are **HISTORICAL_SIMULATION** / **NOT_PROMOTION_EVIDENCE** — never organic paper.

---

## Docs

Operational detail lives in [`CLAUDE.md`](CLAUDE.md). Operator/developer forensic map: [`docs/ARGUS_DOCUMENTATION_INDEX.md`](docs/ARGUS_DOCUMENTATION_INDEX.md) (includes [mobile Settings](docs/ARGUS_MOBILE_SETTINGS.md)).

Living product docs: this README (name + setup), [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md) (engine daemon), [`ARGUS_CLI.md`](ARGUS_CLI.md), [`ARGUS_SHELL_CLI.md`](ARGUS_SHELL_CLI.md), [`ARGUS_HISTORICAL_EVALUATION.md`](ARGUS_HISTORICAL_EVALUATION.md), [`ARGUS_CAMPAIGN_TRACKER.md`](ARGUS_CAMPAIGN_TRACKER.md). Binding contracts: `CLAUDE.md`, `ARGUS_ARCHITECTURE_CONTRACT.md`, protection / invariants / AI change rules. Dated phase audits are **historical snapshots** — code + `evaluateLiveReadiness()` beat markdown.
