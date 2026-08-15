# ARGUS_TEST_PLAN.md

## Must keep passing

RiskEngine, OMS, ChiefTrader consensus/debate HOLD, CapitalAllocation, BacktestEngine strategy path (`findStrategy` unknown-id error still lists real ids), QuantSignalAgent opt-in, AIRouter, thesis invalidation, v2 `GET /quant/strategies` five core ids plus `experimentalStrategies`.

## Added / required for the additive surface

| Area | File | Asserts |
|---|---|---|
| Config thesis rules | `ThesisInvalidation.test.ts` | Thresholds and strategy ids from JSON |
| TradeThesis | `assembleTradeThesis.test.ts` | HOLD → NO_TRADE; R:R from prices; EV not invented |
| Bull/Bear parser | `parseResearchNote.test.ts` | Invented numbers rejected; flag off by default |
| SMC detection | `smc.test.ts` | Sweep `isTradeSignal: false`; FVG; displacement |
| SMC strategy | `smcLiquiditySweep.test.ts` | Not in default `evaluateAll`; CHoCH required |
| Quant emit | `QuantSignalAgent.test.ts` | `tradeThesis.numericEvidenceSource` |

## Still untested / unknown

- Bull/Bear *live* debate quality (flag off, not wired).
- SMC walk-forward OOS (UNVALIDATED).
- Core quant OOS (still FAIL on checked combos).
- Historical AI PIT replay (UNAVAILABLE).
- Organic paper fills in this environment (zero).
