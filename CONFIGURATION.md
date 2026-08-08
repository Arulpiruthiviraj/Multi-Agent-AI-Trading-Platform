# Argus - CONFIGURATION

Real configuration reference, verified against `.env.example`, `server.ts`, and `src/server/db/schema.ts` on 2026-08-08. Previously this file was identical placeholder boilerplate shared with 7 other doc files in this repository — replaced with real content.

---

## Environment Variables (actually read by the code)

| Variable | Read by | Required? | Notes |
|---|---|---|---|
| `GEMINI_API_KEY` | `GeminiProvider.ts` (also legacy `server.ts` Gemini block, which is currently dead — see below) | No | |
| `OPENAI_API_KEY` | `OpenAIProvider.ts`, `DeepSeekProvider.ts` | No | ⚠️ Both providers share the same fallback order (`OPENAI_API_KEY \|\| DEEPSEEK_API_KEY`) — see [AI_ROUTER.md](./AI_ROUTER.md) for the resulting cross-wiring bug if only one is set |
| `DEEPSEEK_API_KEY` | `OpenAIProvider.ts`, `DeepSeekProvider.ts` | No | Same caveat as above |
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | `AlpacaBroker.ts`, `MarketDataWorker.ts`, `server.ts`'s own separate Alpaca WS client | No | Without these, market data idles (no fabrication) and Alpaca execution is unavailable |
| `ALPHAVANTAGE_API_KEY` | `AlphaVantageNewsProvider.ts`, `MacroAgent.ts`, `FundamentalAgent.ts` | No | Gates macro/fundamental agents entirely — without it they only emit `DATA_UNAVAILABLE` placeholders |
| `POLYGON_API_KEY` | `PolygonNewsProvider.ts` | No | |
| `FMP_API_KEY` | `FMPNewsProvider.ts` | No | |
| `FINNHUB_API_KEY` | `FinnhubNewsProvider.ts` | No | **Missing from `.env.example`** — add manually if you want this provider |
| `ENCRYPTION_SECRET` | `EncryptionService.ts` | No, but recommended | If unset, a random key is generated once and persisted to `data/.encryption_key` with a startup warning. Losing that file makes previously-encrypted DB values undecryptable. |
| `APP_PASSWORD` | `server.ts` auth gate | No | **Unset = no authentication at all** on any `/api/*` route |
| `AUTH_SESSION_SECRET` | `server.ts` session signing | No | Defaults to a public, known string if `APP_PASSWORD` is set but this isn't — a startup warning fires in that case |
| `AUTH_SESSION_TTL_HOURS` | `server.ts` | No | Defaults to `720` (30 days) |
| `PORT` | `server.ts` | No | Defaults to `5000` |
| `NODE_ENV` | `server.ts` (`isProd` check), Vite | No | `production` switches to serving `dist/` statically instead of Vite middleware |
| `PAPER_TRADING_ONLY` | Legacy `/api/v1/signals` endpoint, `AlpacaBroker` live/paper URL logic | No | Does not gate the real pipeline's own `settings.tradingMode`, which is set independently |

## What's persisted in SQLite vs. `.env`

Broker credentials and AI provider keys can be saved **either** via `.env` (read as a fallback when no DB row/key is present) **or** through the UI, which encrypts and stores them in `broker_connections`/`ai_providers`. If both exist, the DB-stored, decrypted value takes precedence in the code paths that check `p.apiKeyEncrypted ? decrypt(...) : process.env[...]`.

## Real `settings` table fields (single row, `src/server/db/schema.ts`)

See [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) table #2 for the full column list. Two fields worth flagging specifically for configuration purposes: `takeProfitPct` and `trailingStopPct` are real, persisted settings that **are not enforced anywhere** — see [RISK_ENGINE.md](./RISK_ENGINE.md).

## Configuration UI vs. backend reality

- **AI Provider Management** — real CRUD against `ai_providers`, but a newly-saved provider needs a full server restart before `AIRouter` will actually route to it (known bug — see [AI_ROUTER.md](./AI_ROUTER.md)).
- **Broker Management** — real CRUD against `broker_connections`, but `BrokerManager.initialize()` (the method that reads this table and activates a broker) is never called from the server's own startup sequence — see [BROKER_ENGINE.md](./BROKER_ENGINE.md).
- **Setup Wizard** — only persists AI provider keys. Everything else it collects is local browser state only, and the wizard itself has zero backend enforcement power — see [AI_CONTEXT.md](./AI_CONTEXT.md) §5.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
- [SETUP.md](./SETUP.md) — step-by-step setup
- [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) — full settings schema
