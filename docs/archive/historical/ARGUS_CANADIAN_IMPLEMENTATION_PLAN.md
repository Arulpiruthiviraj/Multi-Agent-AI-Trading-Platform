# ARGUS_CANADIAN_IMPLEMENTATION_PLAN.md

Priorities after `ARGUS_CANADIAN_MARKET_GAP_ANALYSIS.md`. US live path stays default.

## P0 — this pass (no live CA)

1. Market/exchange **data file** (`config/markets.json`) + `resolveListing()` tests (SHOP.TO → TSX/CAD).
2. Event names and agent weights in JSON (shared with US path; not Canada-specific).
3. Position-monitor risk bands from `tradingSafety.json`.
4. Documents: gap analysis, this plan, readiness (NO-GO).

**Explicitly not P0:** enabling IBKR/Questrade Canadian orders, FX fabrication, new sequential DAG, turning on LIVE.

## P1 — research / backtest only (feature-flagged)

- Historical bars for `.TO`/`.V` if a **real** vendor is configured; else structured UNAVAILABLE.
- Toronto session calendar for **research clocks**, not as a silent replacement of NY calendar for US symbols.
- Canadian benchmarks in `MarketContext` when bars exist (XIU.TO), never SPY-as-TSX.
- Backtest UI: market filter US / CA / Both that **refuses** a CA run with no bars.

## P2 — paper CAD book (still no IIROC API routing)

- Tag Argus allocation with currency; refuse mixing CAD notional into USD budget without a timestamped FX rate.
- Questrade (or IBKR) **read** CAD cash vs Argus CAD allocation display.
- Canadian news/macro only with sourced feeds.

## Promotion gates (unchanged)

RESEARCH → BACKTEST → WALK-FORWARD/OOS → PAPER → RESTRICTED LIVE → LIVE.

Canadian **LIVE** stays blocked until a legally permitted execution venue exists. Software compiling is not that venue.
