# ARGUS Phase 17 — implementation report

## What shipped

- Research-only VectorBT boundary: `python/argus_research/cli.py`, `VectorBTService`, `GET/POST /api/v2/research/*`
- Canonical golden OHLCV + SHA-256 + GREEN/YELLOW/RED quality gate
- Timestamp-safe SMA (signal T → next open) shared conceptually with Python
- Walk-forward (train/val/test), parameter sweep on TRAIN only, permutation, sensitivity, cost multiples
- Promotion engine: status **derived**; empty evidence = UNTESTED; LIVE NO-GO
- Organic paper classifier (PAPER vs BACKTEST/REPLAY/UNKNOWN)
- Paper experiment freeze hash (`ARGUS_CORE_2026_Q3`, $1,000, CORE ids)
- Capital labels: research vs paper $100k vs Argus allocation vs broker equity (nullable)
- Small-account whole-share check
- Research Lab panel (no fake Sharpe)
- Event-memory remains 410 (Phase 16)

## What did not ship (honest)

- Feature-parity VectorBT ports of the five CORE strategies (would be a false ENGINE_MATCH)
- Production Parquet warehouse of US/CA history
- Organic paper sample sufficient for VALIDATED
- Rust required for boot
- LIVE or QUANT auto-enable
- Second OMS / Python broker

## Hostile audit

| Question | Answer |
|---|---|
| Can Argus accidentally trade without RiskEngine? | NO — research routes do not call OMS. |
| Can VectorBT accidentally submit an order? | NO — CLI has no broker imports; `canPlaceOrders: false`. |
| Can a future bar leak into golden SMA at T? | NO — SMA uses closes through i; fill is i+1 open. Tested. |
| Can an optimized parameter use the test set? | NO — sweep/WFO optimize train (val select); `optimizedOnTest: false`. |
| Can fake historical AI data enter validation? | NO — golden path is TECHNICAL_BACKTEST. Event-memory 410. |
| Can synthetic trades count as organic paper? | NO — UNKNOWN/BACKTEST/test traces excluded. |
| Can a strategy become VALIDATED without evidence? | NO — `deriveLifecycleStatus(emptyEvidence)` = UNTESTED. |
| Can Rust be claimed when unused? | NO — `engineUsed` / `RUST_ACCELERATION_UNAVAILABLE`. |
| Can broker equity be fabricated? | NO — `brokerEquity: null` when missing. |
| Can Canadian execution unlock? | NO — quality flags CA; promotion requires `canadianExecutionApproved`. |
| Can Autobot-off produce a BUY fill via VectorBT? | NO — VectorBT cannot fill. |
| Can an AI probability be mistaken for empirical? | Separated as MODEL_ESTIMATE. |
| Can event-memory produce fake evidence? | 410 EVENT_MEMORY_QUARANTINED. |
| Can RED data quality produce a live trade via this engine? | `backtestAllowed: false`; `liveCandidateAllowed: false`. |
| Can a stale strategy keep VALIDATED after version change? | Evidence is keyed by `strategyVersion`; empty new version is UNTESTED. |
| Can paper and backtest mix in organic counts? | Environments are labeled; only PAPER counts. |

## Versions (this environment, 2026-08-16)

Probed with system `python` **outside** Vitest (Vitest skips the CLI so tests never hang on Windows Python):

- VectorBT **1.1.0** installed
- `vectorbt_rust` **1.1.0** importable (`AVAILABLE_WITH_RUST` when probed)
- Argus still records `engineUsed`; research jobs in Vitest report UNAVAILABLE by design (`ARGUS_TEST_ALLOW_VECTORBT`)

Installing these packages does **not** raise the trading-edge score.
