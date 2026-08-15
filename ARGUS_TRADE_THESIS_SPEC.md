# ARGUS_TRADE_THESIS_SPEC.md

## Object

`src/server/quant/thesis/assembleTradeThesis.ts` → `TradeThesis`.

Numeric fields (`entry`, `stop`, `target`, `expectedRewardRisk`, `estimatedExpectedValue`) come only from StrategyContext / strategy evaluation / optional live EV. `numericEvidenceSource` is always `quant_engines`.

## LLM rule

`parseResearchNote` **nulls** entry/stop/target/EV/probability if an LLM included them and records `inventedNumericFieldsRejected`.

## Decisions

- `CANDIDATE` — a side exists; still not an order.
- `NO_TRADE` — first-class. Codes in `config/noTradeReasons.json`.

## Live wiring

Attached as `quantDetail.tradeThesis` on QuantEngine ideas. ChiefTrader approval math **unchanged**. RiskEngine **unchanged**.
