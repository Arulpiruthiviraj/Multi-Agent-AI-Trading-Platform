# 04 — Startup sequence

**Mandatory:** Node can import `src/server/db/index.ts` (migrations run here). **`npm run db:migrate` is BROKEN** (`database/migrate.ts` missing).

**Trust:** Argus is sole execution authority. Ecosystem siblings are untrusted research/verification only ([ECOSYSTEM.md](../ECOSYSTEM.md)).

## Commands

- `npm run dev` → `scripts/ecosystem-dev.ts` (optional vibe / autohedge / OpenAlice / Fincept) → `scripts/devWithOpenAlice.ts` → `tsx server.ts`.
- `npm run dev:core` → Chronos/Ollama/OpenAlice/IBKR + server (no vibe/autohedge/Fincept).
- `npm run dev:server-only` → Node only.
- Skip companions: `ARGUS_SKIP_CHRONOS` / `ARGUS_SKIP_OLLAMA` / `ARGUS_SKIP_OPENALICE` / unset `IBKR_GATEWAY_PATH` / `ENABLE_*=false`.

## Companion processes (`npm run dev`)

| Service | When | Fail behavior |
|---|---|---|
| Vibe-Trading MCP | `ENABLE_VIBE_TRADING_MCP=true` + path + `.venv` | Warn; continue |
| AutoHedge | `ENABLE_AUTOHEDGE_WORKER=true` + path + `.venv`; wallet keys forced empty | Warn; continue |
| FinceptTerminal | `ENABLE_FINCEPT_TERMINAL=true` **and** `FINCEPT_CMD` set | Warn / skip if CMD missing |
| OpenAlice Guardian | `ENABLE_OPENALICE` (default on) + checkout | Skip; Argus may set MCP URL |
| Chronos/Kronos+FinBERT `:8008` | Port free, Python on PATH (`dev:core`) | Log skip; Kronos **EXTERNAL-DEPENDENCY-DEPENDENT** |
| Ollama `:11434` | Port free, `ollama` on PATH | Non-blocking log |
| IBKR Gateway | `IBKR_GATEWAY_PATH` | 2FA still manual |

## Node boot (traced conceptually from `server.ts` / SystemBootstrap)

1. Import graph constructs OMS, RiskAgent, TechnicalAgent, ChiefTrader, Kronos agent, MarketRegimeAgent **timer** (voter unused).
2. DB migrate + seed settings / models.
3. AIRouter initialize (DB providers).
4. TradingEngine; Autobot `system.start` **only if** `autoBotEnabled`.
5. BrokerManager.initialize — default InternalPaper if none selected.
6. **MarketDataWorker.start always** if Alpaca keys (idle disconnected without keys — no fabricated ticks).
7. OMS `start()`: `reconcileStaleOrders` + `reconcileInboundBrokerOrders` + follow-up interval.
8. PortfolioReconciliation worker.
9. Listen **3000** (`127.0.0.1` if `AUTH_PASSWORD` unset).

## What requires keys

Alpaca data/trading, AlphaVantage (Fund/Macro), paid news, LLM cloud, Coinbase JWT, Questrade OAuth, `AUTH_PASSWORD` (auth on; production refuses unauthenticated boot), `ENCRYPTION_SECRET` or `data/.encryption_key`.

## Fail vs silent

- Missing **required** `tradingSafety.json` keys: **fail boot**.
- Missing Chronos: honest unavailable.
- Missing Alpaca keys: MD worker idle.
- Hung HTTP: **timeout** (Alpaca 15s, AI 20s) — no longer infinite (unit-verified).
- Missing ecosystem sibling: warn; Argus continues.

## Shutdown

Ctrl+C on `npm run dev` kills `ecosystem-dev` tracked children (Windows process-tree `taskkill`). `system.stop` does not stop MarketDataWorker. Open orders remain at broker.
