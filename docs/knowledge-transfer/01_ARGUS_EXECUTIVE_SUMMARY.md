# 01 — Executive summary

**Status:** living overlay 2026-08-15. **LIVE: NO-GO.** Do not invent a readiness % or a win rate.

## What Argus is

Single Node.js process (`my-money-miner`): Express + Vite SPA + raw `ws` + SQLite WAL (`data/argus.db`). Port **3000 hardcoded**. Event-driven multi-agent terminal that can place **whole-share MARKET** orders after **RiskEngine**.

It is **not** a proven alpha engine, not a Canadian execution venue, and not a guarantee of profitability.

## Problem it tries to solve

One operator terminal: US quotes → several idea agents → consensus → hard risk → broker → traces → optional quant/LLM overlay.

## What it currently does (IMPLEMENTED + VERIFIED in unit tests unless noted)

- Live path: EventBus `TRADE_IDEA_GENERATED` → ChiefTrader → RiskAgent → RiskEngine → OMS → `BrokerManager.placeOrder` → `trades`/`fills`.
- Paper: InternalPaperBroker (~$100k in-memory) or Alpaca paper REST (**EXTERNAL-DEPENDENCY-DEPENDENT**).
- 18 recorded risk gates; first failure is the reported reason; all still recorded.
- Recon ≥~$100 mismatch → `TRADING_PAUSED` → `emergency_stop` fails new orders (**IMPLEMENTED + VERIFIED**).
- Alpaca AbortController timeout/retry/circuit breaker; AIRouter abort + 20s timeout.
- OMS: inbound broker fills with no local row; stale PENDING/REJECTED by client_order_id; orphaned open/partial after 30 min **cancel or pause**.
- Backtest capital-gate **inequalities** (daily loss, consecutive loss, drawdown, rate limit) + live settings TP/trail on strategy exits.
- Optional Quant (`QUANT_ENGINE_ENABLED`), Chronos `:8008`, Ollama, OpenAlice MCP, IBKR Gateway spawn.

## What it does NOT do

- Validated edge / high win rate (**UNVALIDATED**; last NewsAgent pass 44.6%/242; walk-forward OOS failed).
- Full live 18-gate ladder inside BacktestEngine (**PARTIALLY IMPLEMENTED** capital slice only).
- AI/News/ChiefTrader inside the backtester (**MISSING**).
- L2, options, breadth, volume profile, TSI, anchored VWAP, pairs, CAD FX (`NOT_SUPPORTED`).
- Fractional shares; Canadian automated routing (`BLOCKED_IIROC`).
- Historical AI year-replay without PIT logs (**UNAVAILABLE**).
- LangGraph. LiteLLM runtime (stale `server.ts` comment).

## How decisions / orders / backtest / AI / quant / risk / monitoring / UI / DB / APIs work

See `05`, `11`, `12`, `07`, `08`, `13`, `18`, `16`, `10`. Short version:

- **Decision:** ≥2 independent agreeing agents, weighted confidence ≥ 0.75; optional debate if confidence > 0.6; HOLD can veto.
- **Order:** RiskEngine must approve; OMS insert then broker; AI cannot skip.
- **Backtest:** `HistoricalDataGateway` → `ohlcv_bars` → `BacktestEngine.run()` (TA-like) or `runStrategyBacktest()` (named strategy, long-only).
- **AI:** `AIRouter` only. Extra env keys without classes ≠ working providers.
- **Quant:** off by default; five CORE live; 15 experimental per env string `'true'`.
- **Risk:** cannot be overridden by AI or strategy. Sizing `stopLossAssumptionPct` **0.05**, not ATR (`AGENTS.md` is wrong).
- **Monitor:** PortfolioMonitor ~60s emits SELL **ideas**, not raw flatten (except PipelineFlatten → still RiskEngine).
- **UI:** 21 tabs; mix of real APIs and remaining theater. Arena RNG P&L charts removed.
- **DB:** 44 `sqliteTable`s. One file.
- **External:** Alpaca, AlphaVantage, Polygon, Finnhub, FMP, FRED, LLM vendors, IBKR Gateway, Coinbase JWT, Questrade OAuth read-only.

## Paper vs live

| Question | Verdict |
|---|---|
| Careful paper to exercise the path? | **PARTIALLY** — software exists; last scored env pass: **zero** organic closed paper trades |
| Real money? | **NO-GO** |
| 100% autonomous + high win rate? | **NOT A SOFTWARE STATE** — see `27` |

## Remaining incomplete (high)

`/api/v1/signals` bypass; Autobot-off TechnicalAgent on ticks; IBKR 2FA; Coinbase paper refuse; Questrade no orders; remaining fabricated tabs; dual quote feeds; SQLite writer; `PORT` unused.
