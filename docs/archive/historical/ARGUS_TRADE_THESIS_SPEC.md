# ARGUS_TRADE_THESIS_SPEC.md

**Implementation:** `src/server/quant/thesis/assembleTradeThesis.ts`  
**Catalog:** `config/noTradeReasons.json`  
**Tests:** `assembleTradeThesis.test.ts`

## Object

`TradeThesis` is a journal/UI record of *why* a Quant idea exists (or why it is NO_TRADE). It is **not** an order.

| Field | Source |
|---|---|
| `entry` / `stop` / `target` | `ctx.currentPrice`, `evaluation.stop.price`, `evaluation.target.price` |
| `expectedRewardRisk` | `\|target-entry\| / \|entry-stop\|` or null |
| `estimatedExpectedValue` | Caller-supplied live EV in R, or null (never invented) |
| `supportingFactors` | `conditionsMet` |
| `contradictingFactors` | contradictions + unmet conditions |
| `missingEvidence` | Honest gaps (breadth unavailable, null RVOL/VWAP) |
| `numericEvidenceSource` | Always `'quant_engines'` |
| `noTrade` | `noTradeReasons.json` when HOLD / no evaluation |

## LLM rule

`src/server/ai/research/parseResearchNote.ts` **nulls** entry/stop/target/EV/probability if an LLM included them and lists those keys in `inventedNumericFieldsRejected`. Interpretive `confidence` (0–1) is allowed and is **not** a calibrated probability.

## Decisions

- `CANDIDATE` — a BUY/SELL side exists; still not an order.
- `NO_TRADE` — first-class. Default code is `reasons[0]` in JSON (`INSUFFICIENT_EVIDENCE`).

## Live wiring

Attached as `quantDetail.tradeThesis` in `QuantSignalAgent`. ChiefTrader approval math **unchanged**. RiskEngine **unchanged**.
