# Performance audit fixes (2026-08-20)

Short note for `ARGUS_POST_MARKET_PERFORMANCE_AUDIT_2026-08-20.md` items. Full write-up: `ARGUS_NO_TRADE_REMEDIATION_STATUS.md` §6.

| Fix | What changed |
|---|---|
| **1 — NULL `profit_loss`** | `resolvePreTradeEntryPrice`: broker → local `portfolio.averagePrice` → live FILLED BUY. Empty `catch` removed. |
| **2 — Portfolio lag** | On full SELL fill, `syncLocalPortfolioAfterFullSellFill` zeros/reduces local `portfolio` immediately. |
| **3 — Bull/Bear + timeout** | Plutus defaults; `researchTimeoutMs: 8000` on consensus + Bull/Bear. ReflectionEngine stays on `deepseek-r1:14b`. |

Safety floors unchanged: consensus **0.75** / min **2**, no RiskEngine/OMS bypass, `LIVE_NO_GO`.
