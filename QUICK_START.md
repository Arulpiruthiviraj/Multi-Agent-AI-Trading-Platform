# Quick Start Guide - Argus Trading Terminal

Real setup instructions, verified against `package.json`, `server.ts`, and the actual Setup Wizard behavior on 2026-08-08. A prior revision of this guide described a 4-tier risk system, a `PORT=5000` default that didn't match the code (which defaulted to 3000 at the time), and a "Mock Data Mode" that doesn't exist. Corrected below.

---

## 🚀 Prerequisites

- Node.js 18+ (20 LTS recommended)
- Optional: a Gemini/OpenAI/DeepSeek/NVIDIA/OpenRouter key — without one, `NewsEngine`'s AI-scoring step and `FundamentalAgent`/`MacroAgent` will fail their AI calls (caught, no crash, just no output from those agents)
- Optional: Alpaca paper API keys — without them, `MarketDataWorker` idles with no fabricated data, and `TechnicalAgent`/`AdvancedQuantEngines` never receive a tick to react to

---

## ⚡ Setup

### 1. Install
```bash
npm install
```

### 2. Environment

Create `.env` from `.env.example`:
```bash
cp .env.example .env
```

`.env.example` currently lists: `GEMINI_API_KEY`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY`, `ALPHAVANTAGE_API_KEY`, `POLYGON_API_KEY`, `FMP_API_KEY`. **It's missing `FINNHUB_API_KEY`**, which `FinnhubNewsProvider.ts` reads — add it manually if you want that news source. Other variables the code actually reads (add as needed): `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ENCRYPTION_SECRET`, `APP_PASSWORD`, `AUTH_SESSION_SECRET`, `AUTH_SESSION_TTL_HOURS`, `PORT` (defaults to `5000`), `PAPER_TRADING_ONLY`.

### 3. Database

**Nothing to run here.** Migrations execute automatically on every server start (`src/server/db/index.ts` calls Drizzle's `migrate()` at import time). The `npm run db:migrate` script (`tsx database/migrate.ts`) is **broken** — that path doesn't exist in this repo — ignore it.

### 4. Start
```bash
npm run dev
```
Open `http://localhost:5000` (or whatever you set `PORT` to).

---

## 🎯 First Steps

### 1. AI Provider

Settings/AI Provider Management panel → add a provider → paste an API key → save. Note: due to a known bug (`configRoutes.ts`'s provider-save handler registers a string instead of a live provider instance in `AIRouter`), **a newly saved provider will not actually be used for routing until you restart the server.** This is a real limitation, not a UI delay.

### 2. Broker (optional, real if you configure Alpaca)

Broker Management panel → add Alpaca → paste key/secret → enable Paper Mode → connect.

**Important, verified gap**: on a fresh server start, `BrokerManager.initialize()` — the method that actually reads your saved broker connection and activates it — is not called anywhere in the startup sequence. The active broker defaults to the bare `InternalPaperBroker` (a real in-memory simulator with a hardcoded `$100,000` starting cash) regardless of what you've configured, unless something else in the request path happens to trigger initialization first. If your configured broker doesn't seem "active," this is why.

**Do not select Questrade, Interactive Brokers, or Coinbase expecting them to place real orders.** All three are non-functional stubs — they'll appear to connect (their `authenticate()` always returns `true`) but `placeOrder()` throws `Not implemented` on the first real trade. See [BROKER_ENGINE.md](./BROKER_ENGINE.md).

### 3. The Setup Wizard does not gate anything

It's worth knowing before you rely on it: the wizard only persists the AI provider keys you enter (via a real POST to `/api/v1/config/providers`). Budget/risk-level/strategy selections in the wizard only update local browser state, not the database. Completing or skipping the wizard has **zero effect** on whether the backend will actually start trading — that's controlled independently by `settings.autoBotEnabled` in the database, which can already be `true` from a previous session regardless of anything you do in a fresh browser tab. See [AI_CONTEXT.md](./AI_CONTEXT.md) §5.

### 4. Launch the bot

Mission Control → set budget/strategy/risk level → review Guardrails Panel → toggle the bot on. This calls `POST /api/v1/autobot/toggle` with **no validation** of broker or AI configuration — it will accept `enabled: true` even with nothing configured. See "What actually happens with no configuration at all" below.

---

## 🔧 Real Configuration Options

### Risk Levels (as actually coded in `RiskEngine.ts`)

| Level | % of Equity per Trade |
|-------|------------------------|
| **Conservative** | 1.0% |
| **Balanced / Medium** (default) | 2.0% |
| **Aggressive** | 3.0% |

There is no `High` tier and no 4-tier `1.0/1.5/3.0/5.0%` system as a prior revision claimed — verify against [RISK_ENGINE.md](./RISK_ENGINE.md) if you see conflicting numbers elsewhere.

### Guardrails that are real vs. cosmetic

| Setting | Enforced? |
|---|---|
| Max Trade Size | ✅ Yes, by `RiskEngine` |
| Daily Loss Limit | ✅ Yes, recomputed from real trade history on every evaluation |
| Concentration cap (30%) | ✅ Yes |
| Consecutive-loss pause (3 losses) | ✅ Yes |
| Take Profit % / Trailing Stop % | 🔴 **No** — persisted, shown in the UI, never read by any code that actually closes a position. `PortfolioMonitorWorker` uses hardcoded +5%/-3% instead. |

---

## 🧪 Testing without real money

### Paper Trading

Set `settings.tradingMode` to `PAPER` (via the UI or `POST /api/v1/config/settings`). If Alpaca is the active broker, this routes real market orders through Alpaca's paper endpoint. If the active broker is the `InternalPaperBroker` (the default — see the `BrokerManager.initialize()` gap above), everything is simulated with virtual cash regardless of this setting.

### "No API keys at all" is not a demo mode — it's mostly silence

There is no synthetic/mock market-data mode. Without Alpaca keys, `MarketDataWorker` explicitly idles rather than fabricating ticks (`console.log("...will idle in disconnected state without fabricating data")`). Concretely, with zero env keys configured:
- `TechnicalAgent`, `AdvancedQuantEngines`, `KronosForecastAgent` (which is broken anyway) never receive a trigger and never produce anything.
- `NewsEngine` still fetches real RSS every 10s (no key needed) but its AI-scoring step fails silently per-article (no usable `AIRouter` provider), so no news-derived trade idea is ever emitted either.
- `FundamentalAgent`/`MacroAgent` emit `HOLD`/`confidence:0` "DATA_UNAVAILABLE" placeholders on their timers.

**Net effect of enabling the bot with zero configuration: it "runs" (logs accumulate, workers tick) but essentially never generates a trade idea or places an order.** This is a real, verified consequence, not a hypothetical — see [AI_CONTEXT.md](./AI_CONTEXT.md) §30 for the full trace.

---

## 🐛 Troubleshooting (real, verified against the current code)

### Bot won't start
- Check the browser console and server logs.
- Verify `POST /api/v1/autobot/toggle` returns `200` — it will, even with no configuration (there's no validation to fail).
- The absence of trade activity after "starting" is very likely the no-configuration scenario above, not a startup failure.

### No market data
- Verify `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` are set.
- Check the server log for `[MarketDataWorker] Connecting to live Alpaca WebSocket...` vs. `...will idle in disconnected state`.
- Note there are **two independent Alpaca WebSocket clients** in this codebase (`server.ts` and `MarketDataWorker.ts`) — both need valid credentials and both will attempt to connect.

### AI calls failing
- Check the provider's key validity and, if newly added via the UI, **restart the server** — a newly-saved provider isn't routable until `AIRouter.initialize()` re-runs at boot (known bug, see above).

### Database issues
The real database file is `data/argus.db` (not `sqlite.db` at the repo root, which is an unused leftover file). If you need to reset it:
```bash
# Stop the server first
rm data/argus.db data/argus.db-shm
npm run dev   # migrations re-run automatically on the next startup
```

---

## 🚨 Disclaimers

- **Not financial advice.** Educational software only.
- **Not production-ready.** See [AI_CONTEXT.md](./AI_CONTEXT.md) for the full current-state audit before connecting real money.
- **Paper mode only**, until the broker-initialization gap and the non-functional broker adapters are fixed.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — full current-state reference
- [API_REFERENCE.md](./API_REFERENCE.md) — real endpoints
- [RISK_ENGINE.md](./RISK_ENGINE.md) — what's actually enforced
- [BROKER_ENGINE.md](./BROKER_ENGINE.md) — which brokers actually work
