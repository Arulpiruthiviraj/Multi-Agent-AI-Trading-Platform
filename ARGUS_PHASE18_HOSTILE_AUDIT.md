# ARGUS Phase 18 — hostile audit

| Question | Answer | Evidence |
|---|---|---|
| Can VectorBT place an order? | NO | `canPlaceOrders: false`; CLI has no broker |
| Can Python place an order? | NO | Allowlisted jobs; forbidden `placeOrder`/`submitOrder` |
| Can Rust place an order? | NO | Acceleration only via VectorBT |
| Can research reach OMS? | NO | `argusStrategyReplay` does not import OMS |
| Can a config flag force VALIDATED? | NO | `dataProvenance !== REAL_MARKET_DATA` → UNTESTED even if all booleans true |
| Can a test trade count as paper? | NO | `organicPaper.ts` |
| Can replay count as paper? | NO | REPLAY ≠ PAPER |
| Can synthetic data count as validation? | NO | UNIT_FIXTURE / SYNTHETIC_NOT_PROMOTABLE |
| Can future daily data leak into intraday? | Rejected | `LOOKAHEAD_DETECTED` |
| Can test data influence golden WFO? | NO | `optimizedOnTest: false` (Phase 17) |
| Can missing broker equity be fabricated? | NO | null |
| Can missing data become zero? | NO | UNAVAILABLE market context |
| Can missing AI become approval? | NO | PIT empty allowBuy false (Phase 16) |
| Can Canadian routing unlock? | NO | canadianExecutionApproved default false |
| Can QUANT accidentally enable? | NO | env still default false; research does not set it |
| Can LIVE accidentally enable? | NO | no code path |
| Can event-memory fake evidence? | NO | 410 |
| Can a stale strategy keep validation after code change? | Evidence keyed by strategyVersion + datasetHash; empty = UNTESTED |

LIVE remains **NO-GO**. Edge remains **8**.
