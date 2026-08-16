# ARGUS_EDGE_ENHANCEMENT_REPORT

Date: 2026-08-16

This increment implements the approved P0/P1 plan from `ARGUS_PHASE_EDGE_AUDIT.md`. It does **not** claim a trading edge. It makes Argus harder to fool.

---

## 1. What was implemented

- Canonical CORE research fills: **signal at bar T → fill at bar T+1 open**, with stop/target (gap-through uses that bar’s open). Long-only. Research-only. No `placeOrder`.
- Provenance on every canonical run: strategyVersion, datasetHash, executionModelVersion, costModel, quality, rejection.
- **Zero configured costs ⇒ `THEORETICAL_ZERO_COST` ⇒ `backtestPass` cannot be true** (`zeroCostBlocksPromotion`).
- Warehouse: Alpaca **pagination**; grade **RAW then cleaned**; record `droppedBarCount`; **missing-interval** counts; dropped-before-grade cannot stay GREEN.
- In-memory research-run registry + optional `data/research/runs/<runId>/` when `ARGUS_WRITE_RESEARCH_PARQUET=true`.
- Experiment trial ledger + multiple-testing warning from the same config threshold.
- CORE NEXT_BAR walk-forward (train/val/embargo/test, **median** fold, `minWalkForwardWindows` from JSON). Golden fixture → **INSUFFICIENT_SAMPLE**.
- CORE robustness perturbations (cost/slippage/spread/delay/omit). Empty signals → **INSUFFICIENT_SAMPLE**, not ROBUST.
- Paper vs research reconciliation: UNAVAILABLE / INSUFFICIENT_SAMPLE / DIVERGENCE. Empty paper stays empty.
- Promotion evidence can be derived from a canonical artifact; without one, still `emptyEvidence`.
- ReflectionEngine: **no weight bump** below `minSampleSizeForTrust`; removed fabricated Sharpe (`stdev=0.1`) and 1.5 profit-factor heuristic.
- `WALKFORWARD_CHECK_RESULTS.json` **quarantined** (SAME_BAR + cherry-pick; not promotion).
- Evidence-based edge score function: **empty evidence = 8**.

Live path unchanged: EventBus → ChiefTrader → RiskEngine → OMS → BrokerManager.

---

## 2. Files changed (principal)

- `config/researchSafety.json` + `src/server/config/researchSafety.ts`
- `src/server/research/canonicalNextBarEngine.ts` (new)
- `src/server/research/dataQuality.ts`
- `src/server/research/ingestAlpacaWarehouse.ts`
- `src/server/research/researchRuns.ts` (new)
- `src/server/research/experimentLedger.ts` (new)
- `src/server/research/coreWalkForward.ts` (new)
- `src/server/research/coreRobustness.ts` (new)
- `src/server/research/paperReconciliation.ts` (new)
- `src/server/research/edgeScore.ts` (new)
- `src/server/research/agentWeightPolicy.ts` (new)
- `src/server/research/promotionEngine.ts`
- `src/server/research/phase22.canonical.test.ts` (new)
- `src/server/routes/researchRoutes.ts`
- `src/server/services/ReflectionEngine.ts`
- `scripts/runWalkForwardCheck.ts`
- `WALKFORWARD_CHECK_RESULTS.json`
- `src/server/research/phase19.research.test.ts`

---

## 3. Tests added

`phase22.canonical.test.ts`: next-bar fill, gap stop, zero-cost blocks promotion, Sharpe sample floor, missing intervals, dropped-bar YELLOW, ledger, WFO insufficient, robustness insufficient, reconciliation UNAVAILABLE, edge score 8, agent weight floor.

---

## 4. Tests passed

```
npx tsc --noEmit     PASS
npx vitest run       1004 passed / 153 files
```

---

## 5. Data sources used

| Source | Role |
|---|---|
| `fixtures/research/golden_sma.json` | UNIT_FIXTURE only |
| Alpaca REST | Warehouse ingest **when keys exist**; not run in this session as a filled warehouse |
| `data/research/*.parquet` | Still **UNAVAILABLE** in this checkout |

No bars were fabricated.

---

## 6. Execution model

Canonical research: **NEXT_BAR_OPEN** / `argus-research-execution-v1`.  
`BacktestEngine`: **SAME_BAR_CLOSE** (unchanged; not comparable).  
Configured research costs: **0/0/0** → `THEORETICAL_ZERO_COST`.

---

## 7. Strategy versions

`freezeStrategyVersion` still hashes `config/strategySpecs.json` + execution model (e.g. `MOMENTUM_BREAKOUT-1.0.0-<hash>`). Changing JSON changes the hash.

---

## 8–12. Backtest / OOS / WFO / robustness / statistics

| Stage | CORE on golden fixture | REAL_MARKET_DATA |
|---|---|---|
| Canonical backtest | Ran; **not promotable**; typically INSUFFICIENT_SAMPLE / SYNTHETIC / ZERO_COST | **UNAVAILABLE** (no GREEN warehouse artifact here) |
| OOS | **UNTESTED** | **NOT ESTABLISHED** |
| WFO | foldCount &lt; `minWalkForwardWindows` → **INSUFFICIENT_SAMPLE** | **NOT ESTABLISHED** |
| Robustness | empty/few signals → **INSUFFICIENT_SAMPLE** | **NOT ESTABLISHED** |
| Statistics | Sharpe withheld below `minOosTrades` | **NOT ESTABLISHED** |

No CORE PnL is reported as an edge. **NO EDGE** has been demonstrated.

---

## 13. Multiple-testing analysis

Ledger increments on canonical POST/runs. Warning still fires above `multipleTestingWarnAboveTrials` (100). No White’s Reality Check / Deflated Sharpe yet (P2). `WALKFORWARD_CHECK_RESULTS.json` remains a **selection-biased SAME_BAR** file and is quarantined.

---

## 14. Regime analysis

Not newly populated for NEXT_BAR CORE (replay still has UNAVAILABLE market context). BacktestEngine SAME_BAR regime tables are **not** promotion evidence.

---

## 15. Agent calibration

`AIPredictionValidation` unchanged. Weight updates now require `minSampleSizeForTrust` (20 from `tradingSafety.json`). Sharpe is **not** invented with vol=0.1. Agents remain **UNCALIBRATED** until a real outcome sample exists.

---

## 16. Consensus effectiveness

**UNAVAILABLE**. No technical-vs-N-agent ablation on a shared NEXT_BAR sample (P2). Empty PIT still cannot authorize AI BUY unless `allowTechnicalWhenEmpty` (strategy backtest only).

---

## 17. Paper results

Organic filter unchanged. **Sample not established.** Reconciliation vs research is **UNAVAILABLE** / **INSUFFICIENT_SAMPLE** without both sides.

---

## 18. Research/paper divergence

Helper exists. Current status: **UNAVAILABLE** (no organic paper + no REAL canonical run). Not declared success.

---

## 19. Risk findings

24 gates preserved. No second kill switch. No OMS bypass. Restricted-live caps still not profitability. Live stop model still **5% assumption**, not ATR.

---

## 20. Operational findings

QUANT still defaults **OFF**. Autobot OFF still blocks entry ideas. Warehouse still needs Alpaca keys + `ARGUS_WRITE_RESEARCH_PARQUET=true` to persist parquet. Registry of research runs is **process-memory** unless that flag is set.

---

## 21. Remaining blockers (P0 leftover / P1–P2)

- Fill a GREEN **REAL_MARKET_DATA** warehouse (paginate ingest; do not use golden SMA).
- Put **reviewed non-zero** costs in `researchSafety.json` if promotion-grade research is desired; until then zero-cost blocks `backtestPass`.
- Persist runs to disk in the operator environment.
- CORE NEXT_BAR OOS/WFO/robustness on that warehouse — expect many **FAILED / FRAGILE / INSUFFICIENT_SAMPLE** outcomes.
- Organic paper: Autobot ON, PAPER broker, closed SELL P&L.
- P2: consensus ablation, ensembles, deflated Sharpe, remaining UI honesty (`FINAL_ANALYSIS.md`).

---

## 22. Current trading-edge score

**8 / 100** (band 0–20: no demonstrated edge).

Not raised: no REAL_MARKET_DATA NEXT_BAR OOS, no WFO pass, no robustness pass, no organic paper.

---

## 23. Promotion status (every strategy)

| Strategy | Status |
|---|---|
| MOMENTUM_BREAKOUT | **UNTESTED** |
| PULLBACK_CONTINUATION | **UNTESTED** |
| MEAN_REVERSION | **UNTESTED** |
| TREND_FOLLOWING | **UNTESTED** |
| RANGE_REVERSION | **UNTESTED** |
| SMC_LIQUIDITY_SWEEP | **UNVALIDATED** |
| GOLDEN_SMA | **UNIT_FIXTURE** |

**PAPER: CONDITIONAL GO** (plumbing).  
**LIVE: NO-GO**.

If later REAL NEXT_BAR results are unprofitable: report **NO EDGE**. If they only work at one parameter island: **FRAGILE**. Do not manufacture success.
