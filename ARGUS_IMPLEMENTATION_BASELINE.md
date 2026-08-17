# ARGUS_IMPLEMENTATION_BASELINE.md

Phase 0 of the Final Real-Money Readiness Implementation Program. Measured values only, gathered this session via real commands against the live tree and `data/argus.db`.

## Build/test health
- `npx tsc --noEmit`: **PASS**, exit 0, zero errors.
- `npx vitest run`: **PASS**, **168 files / 1101 tests**, 0 failures. (Count is rising within this same session — a separate, concurrent effort is actively landing work in parallel with this one; every number in this document is a snapshot, not a static fact.)
- Python research tests: not separately isolated as a distinct suite in this repo; Python-side checks run through the allowlisted CLI bridge (`python/argus_research/cli.py`), exercised indirectly by the TypeScript research test suite above.

## Strategy evidence (real, as of this session)
- 25 real walk-forward + robustness evaluations run this session (5 CORE strategies × QQQ/AAPL/NVDA/MSFT/AMD, ~2 years real Alpaca daily data each): **0/25 WFO pass, 0/25 all-4-robustness-gates pass.**
- CORE feature parity (TS vs Python/VectorBT): `FEATURE_SUBSET_PARITY` (BOS/RVOL/Keltner/S-R only). Full `StrategyContext.evaluate()` parity: not established.
- SMC (`SMC_LIQUIDITY_SWEEP`): `PROXY_NOT_FEATURE_PARITY`, explicitly experimental/unvalidated.

## Paper trading (real, `data/argus.db` this session)
- `trades`: 10 rows — 6 diagnostic artifacts (`DIAGTEST*`/`DIAGORDER*`/`DIAGCHAIN*`, `PENDING`), 2 `REPLAY` (1 FILLED BUY/SELL pair, -$91.05), 2 `EXTERNAL_SYNC` (real pre-existing GLD/NVDA broker fills, backfilled this session).
- `transactions`: 421 `NO_CONSENSUS`, 243 `RISK_REJECTED`, 40 `OPEN` (pre-dates a same-day restart fix, not an active bug).
- Organic closed paper trades (`organicPaper.ts:isOrganicClosedPaper()`): **0**.
- `minPaperTrades` (config): 30. Current: 0/30. `minPaperSessions`: 10. Current: 0/10.

## Dataset inventory (real, this session)
- GREEN `.meta.json` sidecars: 22 files on disk under `data/research/`.
- Physical `.parquet` files: **16** (was 0 at the start of this session — `pyarrow` was missing; installed this session, verified with a real end-to-end write).
- Symbols with real GREEN daily data: SPY, QQQ, AAPL, NVDA, MSFT, AMD (all real Alpaca REST-sourced, `REAL_MARKET_DATA` provenance).

## Promotion states (real)
- Every recorded research run on disk (`data/research/runs/*/promotion.json`): `promotable: false`, `live: "NO-GO"`.
- `evaluateLiveReadiness()` (already implemented, `src/server/core/liveReadinessEngine.ts`): returns `LIVE_NO_GO` with explicit per-gate `FAIL`/`UNAVAILABLE` verdicts for `STRATEGY_CORE`, `STRATEGY_SMC`, `OOS`, `WFO`, `ROBUSTNESS`, `STATISTICS`, `BROKER_LIVE_CONFIRM`.

## Live readiness
- `LIVE Autonomous Trading`: **NO-GO**.
- 5-layer LIVE arm (confirmation phrase, in-memory arm, dual paper/live flag agreement, live-Alpaca-host refusal, restart-clears-arm): all independently verified present and correct this session.

## Canadian execution state
- `BLOCKED` (IIROC 3200A.1(b)(i)) — `markets.json` documents this; no code path unlocks automated Canadian equity routing. Correctly `EXTERNAL_BLOCKED`, not a code gap.

## Research engine capability (real, this session)
- `evaluateLiveReadiness()`: real, gate-based, already implemented.
- `reconciliation_acknowledgements` workflow (durable operator acknowledgement of pre-existing broker discrepancies, fingerprinted, revocable): real, already fully implemented and wired into `PortfolioReconciliation.ts` (`getActiveAcknowledgedOrderIds`), including routes and tests. Verified this session, not built this session.
- `experimentLedger.ts` / `multipleTesting.ts`: real trial-counting and a warn-above-threshold check exist; a full per-trial parameter/rejection audit trail (Phase 6's fuller ask) does not yet exist — partial, not complete.
- `FullArgusReplayEngine`: real, runs the actual production decision spine (Chief vote math → RiskEngine → OMS → `HistoricalReplayBroker`) against point-in-time bars. Status per its own code: not a fabricated `FULL_ARGUS_SIMULATION` claim — see the companion implementation report for the honest assessment of what it does and doesn't reconstruct point-in-time.

## Broker configuration (real, this session)
- Active broker: Alpaca. `trading_mode: PAPER`, `auto_bot_enabled: 1`, `trading_state: TRADING_ENABLED`.
- Real Autobot was enabled this session (not merely code-reviewed) — the 30-day organic paper soak began generating real activity against real Alpaca paper account state, with one real, now-fixed reconciliation defect discovered and closed along the way (see companion implementation report).

**This document intentionally does not restate every finding — it exists to anchor exact measured numbers at this point in time. Full analysis and phase-by-phase status live in `ARGUS_FINAL_REAL_MONEY_READINESS.md`.**
