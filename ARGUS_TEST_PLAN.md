# ARGUS_TEST_PLAN.md

## Must keep passing

RiskEngine, OMS, ChiefTrader consensus/debate HOLD, CapitalAllocation, BacktestEngine strategy path, QuantSignalAgent opt-in, AIRouter, thesis invalidation.

## Added this pass

- Thesis rules loaded from JSON; thresholds in tests come from that JSON.
- `assembleTradeThesis` NO_TRADE vs CANDIDATE.
- `parseResearchNote` rejects invented numbers.
- Existing SMC/strategy tests unchanged in live `evaluateAll` (still 5 strategies).

## Still untested / unknown

- Bull/Bear live debate quality (flag off).
- OOS profitability (still FAIL on checked combos).
- Historical AI PIT replay (UNAVAILABLE).
- Organic paper fills in this environment (zero).
