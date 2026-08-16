# 13 — Position management and capital

## Capital layers

| Concept | Source | Enforced by |
|---|---|---|
| Broker cash / buying power / equity | Broker `account()` | Autobot start gate vs budget; broker rejects |
| Argus allocation `settings.budget` | DB settings | `argus_capital_allocation` |
| Per-order | `maxTradeSize` / PERCENT_OF_EQUITY | PositionSizing + restricted LIVE $5k |
| Per-symbol | 20% concentration | RiskEngine |
| Daily loss kill | settings limit × 0.8 | daily_loss |
| Daily BUY notional | JSON | daily_buy_notional |
| Reserved cash | **not a ledger** | UNKNOWN / MISSING as explicit reserve |

**$2000 broker, $100 Argus:** allocation gate should block using the other $1900 **on the live path**. Weak: `/signals`; Autobot-off ticks; InternalPaper $100k default can **look** like more capital than budget.

## Position monitor (`PortfolioMonitor.ts` ~60s)

Inputs: portfolio table, prices, settings `takeProfitPct` / `trailingStopPct`, quant thesis JSON, `quantStopExitConfidence`.  
Outputs: SELL **ideas** agent `PortfolioManager`.  
Not: raw `closePosition` (except user flatten → still RiskEngine).

Regime change: thesis invalidation types in JSON. News: news_veto on **new** orders, not automatic flatten. Correlation: entry gate, not continuous unwind.

P&L: fills + portfolio marks. Journal: UI modal + learned_rules from ReflectionEngine (debate prompt only).
