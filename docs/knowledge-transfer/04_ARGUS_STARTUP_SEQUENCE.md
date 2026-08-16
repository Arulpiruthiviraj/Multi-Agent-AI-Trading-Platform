# 04 — Startup sequence

**Mandatory:** Node can import `src/server/db/index.ts` (migrations run here). **`npm run db:migrate` is BROKEN** (`database/migrate.ts` missing).

## Commands

- `npm run dev` → `scripts/devWithOpenAlice.ts` then `tsx server.ts`.
- `npm run dev:server-only` → Node only.
- Skip companions: `ARGUS_SKIP_CHRONOS` / `ARGUS_SKIP_OLLAMA` / `ARGUS_SKIP_OPENALICE` / unset `IBKR_GATEWAY_PATH`.

## Companion processes (`npm run dev`)

| Service | When | Fail behavior |
|---|---|---|
| Chronos/Kronos+FinBERT `:8008` | Port free, Python on PATH | Log skip; Kronos **EXTERNAL-DEPENDENCY-DEPENDENT** |
| Ollama `:11434` | Port free, `ollama` on PATH | Non-blocking log |
| OpenAlice Guardian | Checkout or `OPENALICE_ENABLED` | Skip unless both env flags for MCP verify |
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
9. Listen **3000**.

## What requires keys

Alpaca data/trading, AlphaVantage (Fund/Macro), paid news, LLM cloud, Coinbase JWT, Questrade OAuth, `AUTH_PASSWORD` (auth on; production refuses unauthenticated boot), `ENCRYPTION_SECRET` or `data/.encryption_key`.

## Fail vs silent

- Missing **required** `tradingSafety.json` keys: **fail boot**.
- Missing Chronos: honest unavailable.
- Missing Alpaca keys: MD worker idle.
- Hung HTTP: **timeout** (Alpaca 15s, AI 20s) — no longer infinite (unit-verified).
- OpenAlice compile error: optional path; `tsc` currently fails that file.

## Shutdown

Ctrl+C kills `devWithOpenAlice` children. `system.stop` does not stop MarketDataWorker. Open orders remain at broker.
