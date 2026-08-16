# ARGUS_RESEARCH_VALIDATION_REPORT

Canonical engine: `canonicalNextBarEngine.ts` — signal T, fill T+1 open, `canPlaceOrders: false`, `promotable: false` type, `EXECUTION_MODEL_VERSION` = `argus-research-execution-v1`.

`BacktestEngine`: SAME_BAR_CLOSE — **ENGINE_MISMATCH** vs canonical.

Costs: `researchSafety` commission/spread/slippage **0**. `zeroCostBlocksPromotion: true`.

Warehouse: ingest exists; `data/research` **UNAVAILABLE**. Fixture `fixtures/research/golden_sma.json` = UNIT_FIXTURE.

CORE evaluate() modules exist; **UNTESTED** as promotion. SMC **UNVALIDATED**.

OOS / WFO / robustness / permutation: code present, **BLOCKED — EXTERNAL EVIDENCE REQUIRED** (GREEN REAL_MARKET_DATA + non-zero costs).

Do not treat Vitest or VectorBT CLI as OOS_VALIDATED.
