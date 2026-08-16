# ARGUS_CANADIAN_MARKET_GAP_ANALYSIS.md

**Date:** 2026-08-15. Read-only audit plus P0 listing registry. **Canadian live trading is not enabled.**

## What already works (US path — do not replace)

- Alpaca unattended US equities (paper/live).
- IBKR Client Portal adapter: US/intl orders when a human 2FA session is alive. `canadianEquities: false` by design (IIROC Dealer Member Rule 3200A.1(b)(i)).
- Questrade: real read-only balances/positions (including `.TO` symbols in tests). `placeOrder` throws; `canadianEquities: false`.
- EventBus pipeline: agents → ChiefTrader → RiskEngine → OMS → broker.
- Argus allocation vs broker equity: `settings.budget` + `CapitalAllocation` (unitless dollars today, **not** CAD-aware).
- Technical math (RSI/MACD/quant indicators) is symbol-agnostic if real bars exist.
- Backtest/walk-forward/Monte Carlo exist for **US bars** via Alpaca `HistoricalDataGateway`.
- Diagnostics, ModelRuntimeManager, RestrictedLiveMode, kill switch.

## What partially works

| Area | Status |
|------|--------|
| Symbol currency | `portfolio.currency` / `trades.currency` default **USD**. No FX book. |
| Trading calendar | `America/New_York` only (`TradingCalendar.ts`). No TSX holidays. |
| Market hours gate | Alpaca `/v2/clock` (US session). TSX hours not used. |
| Sector map | US GICS-ish tickers in `PositionSizing.SECTOR_MAP`. No XIU/XEG/etc. |
| Market context | SPY/QQQ/IWM + US sector ETFs. Breadth `available: false`. |
| IBKR balances | Summary fields can include `{amount, currency}` but Argus allocation math does not split CAD vs USD cash. |
| News/fundamentals | Provider-dependent US tickers. Canadian SEDAR/BoC not wired. |

## What is missing (not a code-cleanup issue)

- Legal automated **TSX/TSXV order routing** through IBKR Canada retail or Questrade. This is **regulatory**, not an adapter rewrite.
- Alpaca does not list Canadian-exchange equities.
- Point-in-time Canadian news/fundamentals for historical AI replay.
- CAD/USD FX from a real feed (must not be fabricated).
- TSX Composite / TSX 60 / Canadian sector ETFs as first-class `MarketContext` (Alpaca may not serve `.TO` bars).
- Commodity overlay gated by sector (oil/gold) as optional context.
- Corporate-action-adjusted Canadian history as a dedicated feed.

## What can be reused

- Same RSI/MACD/quant strategy **formulas** (no Canadian copies).
- Same RiskEngine gate ladder + Argus `$` allocation (extend with currency tag later).
- Same ChiefTrader / diagnostics / DigitalTwin.
- Questrade **read** path for CAD account snapshots (not execution).

## What needs an adapter (not a rewrite)

- `config/markets.json` + `MarketRegistry` (P0, listing suffix → CAD/TSX). **Does not place orders.**
- Historical bars adapter that can fail honestly for `.TO` when Alpaca has no data (`DATA_UNAVAILABLE`).
- FX adapter (future) with timestamped rates.
- Calendar: `America/Toronto` + TMX holidays (future).

## Files that would change for real CA research/backtest (later)

- `HistoricalDataGateway.ts`, `MarketContext.ts`, `TradingCalendar.ts`, `NewsEngine.ts`, `FundamentalAgent.ts`.
- **Must not** set IBKR `canadianEquities: true`.

## Risks

- Pretending `.TO` bars from a US vendor.
- Mixing CAD prices into USD `settings.budget`.
- Claiming paper/live Canadian execution.

## Data-provider limitations (honest)

Alpaca: US. IBKR API: no Canadian-exchange automated orders for IIROC retail. Questrade: no partner execution API. No L2. No market breadth.
