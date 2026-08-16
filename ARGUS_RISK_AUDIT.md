# ARGUS_RISK_AUDIT

24 gates in `RiskEngine.evaluateRiskSerialized` / `config/riskGateOrder.json` (catalog ≠ pass/fail).

## Change this increment

- **data_freshness:** `evaluateQuoteFreshness` — null/`NaN` age = **UNKNOWN, FAIL**. Stale = **RED, FAIL**. Fresh = GREEN/YELLOW PASS.
- **Sizing honesty:** `order_notional_cap` / concentration / correlation record `status`: PASS | CLAMPED | FAIL | UNKNOWN | SKIPPED. Clamp-to-zero is **FAIL**, not PASS.
- **LIVE:** `failClosedUnknownInputs` — missing correlation history or unmapped sector is **UNKNOWN FAIL** (paper still SKIPPED).

## Unchanged (still true)

- No fake LIVE equity.
- Autobot-off blocks BUY; SELL may proceed.
- News veto direction-blind.
- Stop model live: `stopLossAssumptionPct` 0.05 — ATR **NOT_LIVE** (`config/sizingModels.json`).
- Paper `maxDailyBuyNotionalDollars` 0 = unlimited paper notional.
- No second kill switch.

## Tests

`RiskEngine.test.ts` unknown freshness; `PositionSizing.test.ts` FAIL/UNKNOWN; `marketDataQuality.test.ts`.
