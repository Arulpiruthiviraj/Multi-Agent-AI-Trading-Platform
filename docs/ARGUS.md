# Argus

Living system document. **LIVE real-money: NO-GO.** Code + tests beat old reports. Dated audits: `docs/archive/historical/`. Local models: [LOCAL_AI_SETUP.md](LOCAL_AI_SETUP.md). Catalogs (strategies, gates, tables, env): [ARGUS_REFERENCE.md](ARGUS_REFERENCE.md). Agent contract: root `CLAUDE.md`. UI tab matrix: root `FINAL_ANALYSIS.md` §25.3 / §31.

NewsAgent last scored pass: **44.6% on 242 predictions**. Walk-forward OOS for checked quant combos **failed**. Do not invent a new readiness percentage. Adding markdown does not raise scores.

## What it is

Node.js trading terminal: Express + Vite SPA + raw `ws` + SQLite (`data/argus.db`, WAL). Package name `my-money-miner`. Port **3000** hardcoded (`PORT` unused). One process.

**Live path (do not rewrite):** EventBus → idea agents → ChiefTrader → RiskAgent → RiskEngine → OMS → `BrokerManager.getActiveBroker().placeOrder` → `trades` / `fills`.

**Not that path:** `GET /api/v1/signals` — fabricated agents, no RiskEngine/OMS/`trades`.

Do not bypass RiskEngine. Do not add a second kill switch. `settings.budget` is Argus **allocation**, not broker equity. Quant off unless `QUANT_ENGINE_ENABLED=true`. TradingAgents is inspiration only (Apache-2.0 — do not vendor).

## What it does / does not

Does: paper or Alpaca unattended orders through the live path; 18 recorded risk gates; recon can `TRADING_PAUSED`; optional Quant/Chronos/Ollama/OpenAlice/IBKR Gateway.

Does not: proven edge; L2/options/breadth/volume profile/pairs/anchored VWAP/TSI/CAD FX; fractional shares; Canadian automated routing (IIROC); historical AI replay of past years.

Paper: mechanically possible. Live: **NO-GO**.

## Startup

`npm run dev` → `scripts/devWithOpenAlice.ts` (Chronos :8008, Ollama, optional OpenAlice :47332, optional IBKR) + `tsx server.ts`. `npm run dev:server-only` = Node only.

Boot: import constructors (OMS, RiskAgent, TechnicalAgent, ChiefTrader, Kronos, MarketRegimeAgent timer) → AIRouter → TradingEngine (Autobot `system.start` only if `autoBotEnabled`) → seed settings → BrokerManager → **MarketDataWorker.start always** → model probes → listen 3000. Migrations run on first import of `src/server/db/index.ts`. **`npm run db:migrate` is broken** (`database/migrate.ts` missing).

Autobot off: ticks can still drive Technical/Kronos → pipeline if `TRADING_ENABLED`. `system.stop` does not stop MarketDataWorker.

## How a BUY happens

Alpaca WS (`MarketDataWorker`) → `TRADE_IDEA_GENERATED` (Technical after 50 ticks; or News/Fund/Macro timers; or Quant/Kronos if enabled/healthy) → ChiefTrader (optional debate if confidence > 0.6; min **2** independent agents; bar **0.75**; HOLD with confidence > 0 penalizes; debate HOLD / Bear HOLD / Quant AI disagreement can NO TRADE) → `CHIEF_APPROVED_IDEA` → RiskEngine (needs live price; all gates recorded) → whole-share MARKET → broker. OpenAlice does not block.

**SELL:** same path. Extra gate `sell_position_exists`. PortfolioMonitor (~60s) emits SELL ideas (`PortfolioManager`) — risk-exit skips debate/min-agents. Liquidate: `PipelineFlatten` emits ManualOverride `CHIEF_APPROVED_IDEA` (skips consensus, **not** RiskEngine). Rebalance: **501**.

## Agents

| Role | Source | Default |
|---|---|---|
| TechnicalAgent | RSI/MACD/BB, hardcoded | On `MARKET_DATA` |
| NewsAgent | RSS + APIs + optional LLM | Autobot 10s |
| Fundamental / Macro | AlphaVantage + AIRouter | Autobot 60s / 75s |
| QuantEngine | StrategyEngine | Off until env |
| KronosEngine | Chronos | On ticks if `/health` |
| PortfolioManager | TP/trail/quant stop/thesis | Autobot 60s SELLs |
| ChiefTrader / RiskAgent | Consensus / gates | Always constructed |

**Not voters:** MarketRegimeAgent, AdvancedQuantEngines. **No classes:** SentimentAgent, OrderFlowAgent (UI names only).

LLM: `AIRouter` only — Gemini, OpenAI, DeepSeek, Nvidia, Ollama-compat. Extra env keys (Anthropic, Grok, …) have **no provider class**. Bull/Bear (`QUANT_BULL_BEAR_ENABLED`) nulls LLM prices.

## Risk (cannot be overridden by AI)

Order: `emergency_stop` (also `TRADING_PAUSED`) → daily_loss (0.8 × limit; LIVE min $1000) → consecutive_loss (3) → drawdown (settings, fallback 15%) → order_rate_limit (fallback 5/min) → market_hours (skip if no Alpaca keys; **fail-closed** if keys but clock fails) → data_freshness (5 min) → news_veto (4h, impact > 80, **direction-blind**, hardcoded) → price_validity → PositionSizing (notional, concentration, correlation, `stopLossAssumptionPct` **0.05 not ATR**) → sell_position_exists → `argus_capital_allocation` → `daily_buy_notional` (paper off if JSON 0; LIVE $15k).

Restricted LIVE file ceilings: $5k order, 3 positions, $1k daily loss — not a UI knob. Kelly/EV can suppress Quant **ideas** only.

Example: broker $2000, budget $100 → $101 BUY fails allocation.

Weak: equity fallback `|| 10000`; Autobot-off tick path; `PAPER_TRADING_ONLY` does not force BrokerManager paper.

## Brokers

InternalPaper (default, ~$100k). Alpaca paper/live REST (unattended). IBKR Gateway + **manual 2FA**; `canadianEquities: false`; `placeOrder` does not call `isCanadianListing`. Questrade: throws, never active. Coinbase: real JWT adapter, **paper `placeOrder` refuses**, not funded-account verified (`.env.example` comments may lag).

## Quant / backtest

Five CORE strategies if Quant on. Fifteen experimental modules: backtest via `findStrategy` without flags; live only if **that** env is `'true'`. Taxonomy JSON maps **760 names** — not 760 live edges. `NOT_SUPPORTED`: breadth, options, L2, profile, TSI, anchored VWAP, pairs, CAD FX.

Backtest `run()` = TA-like rules, no AI. `runStrategyBacktest()` = named strategy, **long-only**, SEC/FINRA on sells, dynamic slippage. Walk-forward does not optimize. AI year-replay **UNAVAILABLE**.

## Data / frontend / DB

Alpaca IEX top-of-book + raw daily bars in `ohlcv_bars`. Two feeds: EventBus ticks vs `liveQuotes` → InternalPaper `tick` — TechnicalAgent uses EventBus only.

SPA: `src/App.tsx`, **21 tabs**, mixed real/mock. Login return is **after** most hooks. `FINAL_ANALYSIS.md` wins for widgets.

**44** SQLite tables. Export DB + copy `data/.encryption_key`.

## Canadian

`markets.json` documents TSX/TSXV. Automated routing **BLOCKED_IIROC**. Metadata ≠ execution.

## Honest gaps

No OOS edge; UI lamps can be static/mocked; SQLite one writer; IBKR 2FA; recon $100 pause does not flatten; `/signals` still exists.
