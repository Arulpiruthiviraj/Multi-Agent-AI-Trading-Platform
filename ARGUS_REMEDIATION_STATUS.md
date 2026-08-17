# ARGUS_REMEDIATION_STATUS

**Timestamp:** 2026-08-16 (local remediation cycle)  
**Git HEAD (short):** `9f1d075` (working tree dirty — uncommitted remediation)  
**LIVE:** NO-GO  
**Empirical edge:** NOT_ESTABLISHED (0%) — organic closed PAPER FILLED SELLs still **0**

---

## Tests this cycle

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit **0** |
| `npx vitest run` | **166+ files / tests passed** (exit 0; suite includes new recon/soak tests) |
| Targeted recon + soak | 9/9 passed |
| `python scripts/probe_research_env.py` | pyarrow **25.0.1** available · vectorbt **1.1.0** · `canWriteParquet: true` · `canPlaceOrders: false` |

---

## Issues fixed this cycle (code)

### P1_RECONCILIATION — PRE_EXISTING_RECONCILED
- **Problem:** Broker FILLED orders without local `trades.brokerOrderId` (e.g. GLD/NVDA pre-existing) re-tripped `TRADING_PAUSED` every reconcile cycle after resume.
- **Fix:** Durable `reconciliation_acknowledgements` table + acknowledge/revoke APIs. `PortfolioReconciliation` skips **active** acked `brokerOrderId`s from `FILLED_ORDER_MISSING_LOCALLY` pause impact only.
- **Does not:** invent fills, authorize orders, auto-resume, or count as organic paper.
- **Files:** `drizzle/0032_reconciliation_acknowledgements.sql`, `schema.ts`, `ReconciliationAcknowledgements.ts`, `PortfolioReconciliation.ts`, `systemRoutes.ts`, tests.

### P1_CORRECTNESS — Paper soak state machine
- **Problem:** Binary `SOAK_IN_PROGRESS` / `SOAK_FLOOR_MET` only.
- **Fix:** Evidence-derived ladder `NOT_READY → READY_FOR_PAPER_SOAK → PAPER_SOAK_RUNNING → PAPER_EVIDENCE_ACCUMULATING → PAPER_VALIDATION_COMPLETE` with legacy aliases retained.
- **Files:** `paperSoakState.ts`, `researchRoutes.ts`, `organic_paper_soak_status.ts`, tests.

### P1_RESEARCH_VALIDITY — Organic classifier hardening
- Exclude `EXTERNAL_SYNC`, `PRE_EXISTING_RECONCILED`, `HISTORICAL_SIMULATION`, `HISTORICAL_REPLAY`, DIAG* symbols from organic paper.

### P2_UI / labeling — Historical simulation honesty
- Labels include `HISTORICAL_SIMULATION` + `NOT ORGANIC_PAPER` on FullArgusReplayEngine + HistoricalReplayLab.

### P2_OBSERVABILITY — Research env probe
- `scripts/probe_research_env.py` + `npm run research:probe-env`.

---

## Remaining blockers (honest)

| Class | Item |
|---|---|
| **EVIDENCE_DEPENDENT** | Organic paper soak ≥30 closed FILLED SELLs / ≥10 sessions — **calendar + real market time** |
| **EVIDENCE_DEPENDENT** | CORE WFO / robustness OOS passes — cannot manufacture |
| **EVIDENCE_DEPENDENT** | GREEN multi-year parquet warehouse population (env can write; data still ops) |
| **EXTERNAL_BLOCKER** | Canadian live routing — IIROC; `canadianEquities: false` |
| **CALENDAR_DEPENDENT** | Supervised PAPER soak duration |
| **P1 (partial)** | Full TS↔Python StrategyContext parity (still FEATURE_SUBSET) |
| **P2** | Full Historical Simulation Lab config surface expansion beyond existing MODE B replay |

---

## Safety verification (unchanged invariants)

- Single OMS production `placeOrder` path preserved  
- No VectorBT/Python/UI→Broker path added  
- LIVE still requires confirmation + arm + `PAPER_TRADING_ONLY` throw  
- Promotion statuses remain evidence-derived  
- Replay / ack / EXTERNAL_SYNC never inflate organic paper  

---

## Readiness by dimension (no inflation)

| Dimension | Status |
|---|---|
| Engineering / compiler | High (tsc+vitest green) |
| Risk / execution isolation | Intact |
| Reconciliation operability | **Improved** (ack path) |
| Research warehouse tooling | **Improved** (pyarrow available in this env) |
| Empirical edge | **0% / NOT_ESTABLISHED** |
| LIVE | **NO-GO** |

**Do not interpret this document as LIVE approval.**
