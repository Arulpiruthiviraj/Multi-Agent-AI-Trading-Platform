# ARGUS_PHASE_EDGE_AUDIT

**Audit date:** 2026-08-16  
**Mode:** Read-only. Code is authoritative. Documentation is cited only when it matches implementation.  
**No production trading behavior was changed in this phase.**

---

## Non-negotiable baseline (re-verified against code)

| Item | Implementation status |
|---|---|
| LIVE | **NO-GO**. `liveGoNoGo(emptyEvidence)` is NO-GO. `manualLiveApproval` required for LIVE_APPROVED. Research status cannot set `settings.tradingMode`. |
| PAPER plumbing | **CONDITIONAL GO**. Single path: EventBus → ideas → ChiefTrader → RiskAgent → RiskEngine → OMS → BrokerManager → broker. |
| Trading edge | **8 / 100**. No organic PAPER FILLED SELL P&L sample. No GREEN REAL_MARKET_DATA CORE NEXT_BAR_OPEN OOS/WFO in the research warehouse. |
| CORE | **UNTESTED** (`deriveLifecycleStatus(emptyEvidence)` because `dataProvenance !== REAL_MARKET_DATA`). |
| SMC | **UNVALIDATED** (`experimentalInventory`). Live `evaluateAll()` excludes it unless `QUANT_SMC_STRATEGY_ENABLED=true`. |
| QUANT_ENGINE_ENABLED | Default **OFF** (env; QuantSignalAgent gated). |
| Risk gates | **24** names in `config/riskGateOrder.json`. |
| Vitest / tsc | Last measured this conversation: **991/991**, 152 files; `tsc --noEmit` PASS. Tests are **not** trading evidence. |
| Organic paper | Filter exists. Sample **not established**. |
| Canadian automated live | Blocked (`markets.json` / data-quality `canadian_live_blocked`). |

**Order-path contract (production):** only `OrderManagementService.executeOrder` → `activeBroker.placeOrder`. VectorBT/Python CLI, Research Lab, UI, and `server.ts` do not call `placeOrder`. Phase 21 file-scan test encodes this.

---

## A–H classification (what each major piece actually is)

| Component | Class | Notes |
|---|---|---|
| Live EventBus → OMS path | **E production-real** | Fail-closed gates; Autobot-off idea gate. |
| InternalPaperBroker | **E production-real paper** | Simulated fills on ticks, not organic market evidence until stamped PAPER SELL P&L exists. |
| Alpaca historical REST (`HistoricalDataGateway`) | **E production-real** when keys exist; **throws** if missing (does not fabricate). | Cached `ohlcv_bars`. |
| Research warehouse ingest (`ingestAlpacaWarehouse`) | **B partial** | Fetches Alpaca; **no pagination** (`limit=10000`); **7-day** script window; **drops** invalid bars then grades remainder. |
| Dataset registry | **B / F** | **In-memory `Map`**. Lost on process restart. |
| Parquet warehouse (`data/research/*.parquet`) | **C/D absent** | No `data/research/` artifacts in repo. Write gated on `ARGUS_WRITE_RESEARCH_PARQUET=true` + GREEN + Python job. |
| Golden SMA (`fixtures/research/golden_sma.json`) | **C UNIT_FIXTURE** | ~24 synthetic daily bars. Deterministic unit tests only. |
| `runSmaCrossover` | **A capability / C fixture consumer** | True NEXT_BAR_OPEN. **Not a CORE strategy.** |
| `replayArgusStrategy` | **B partial** | Same `evaluate()` as Quant. Stamps NEXT_BAR_OPEN version. **Emits signals only.** Does **not** simulate T+1 fills, costs, stops, sizing, or PnL. `promotable: false` always. |
| `nextOpenFillStats` | **B stub** | qty=1, no fees/slippage/stops. |
| `BacktestEngine.run` / `runStrategyBacktest` | **E real bars + D SAME_BAR_CLOSE** | Fill at **current bar close** + slippage. PIT AI **`allowTechnicalWhenEmpty: true`** so empty ledger still allows technical BUY in strategy backtests. |
| `WalkForwardValidator` | **B / D** | Rolling train/test on **BacktestEngine SAME_BAR**. No validation fold. Does **not** retune params (honest about that). |
| `WALKFORWARD_CHECK_RESULTS.json` | **G false-positive risk** | SAME_BAR engine; combos **chosen as highest in-sample Sharpe**; tiny OOS %; **not** CORE NEXT_BAR promotion evidence. |
| `runGoldenWalkForward` | **C fixture** | **One** window (50/25/25) on golden SMA. `minWalkForwardWindows` is 3. Grid search on SMA periods only. |
| `robustness.ts` | **C fixture** | Permutation / sensitivity / cost stress **only on SMA crossover**. |
| `multipleTesting.ts` | **B warning only** | String if trials > 100. No experiment ledger, no DSR, no White’s Reality Check. |
| `promotionEngine.ts` | **A honest math / B unwired** | Status derived from **caller booleans**. GET `/research/strategy/:id/evidence` always **`emptyEvidence`**. No artifact → no pass. |
| `freezeStrategyVersion` | **A partial** | Hash of spec JSON + execution model. Not frozen into a persisted run manifest. |
| `organicPaper.ts` | **A filter / E empty** | Requires PAPER + FILLED + SELL + numeric PnL. Untagged = UNKNOWN. |
| VectorBT / `python/argus_research` | **A capability / C FEATURE_TRANSLATION** | Allowlisted jobs. `canPlaceOrders: false`. Not feature-parity with live `RegimeEngine` path. |
| Experimental strategies (ORB, VWAP, Donchian, …) | **B code exists / live off** | Extra `evaluate()` modules. **Not CORE.** Must not silently enter live `evaluateAll()`. |
| `AIPredictionValidation` | **A / E data-dependent** | Brier/calibration from `prediction_outcomes`. Directional accuracy ≠ trade PnL. |
| `ReflectionEngine` weight update | **G false-positive risk** | `currentWeight = 1 + (winRate-0.5)*2` with **no min sample**. **Sharpe uses hardcoded stdev 0.1**. Profit factor uses **1.5 heuristic**. |
| `ConfidenceCalibration` | **A real math** | Beta-binomial buckets. Distinct from flat weights. |
| Research Lab UI | **A mostly honest** | Comparison matrix UNTESTED; VectorBT capability. Other App tabs still include fabricated series (`FINAL_ANALYSIS.md`). |
| `src/server/broker/BrokerEngine.ts` | **stale / unused** | Glob may list it; not imported. Must not become a second OMS. |

---

## Evidence matrix

| Feature | Implementation | Test | Real data dependency | Current status | Missing evidence | Recommended fix (plan only) |
|---|---|---|---|---|---|---|
| CORE live ideas | `StrategyEngine` + QuantSignalAgent (off) | strategy unit tests | live bars | UNTESTED | organic + research | Do not enable QUANT to “see if it works” |
| CORE research PnL NEXT_BAR | signals only (`argusStrategyReplay`) | phase 18 replay tests | REAL_MARKET_DATA warehouse | **UNAVAILABLE** | fills, costs, stops | Canonical fill engine (P0) |
| CORE SAME_BAR backtest | `BacktestEngine.runStrategyBacktest` | strategyBacktest tests | Alpaca cache | BACKTEST capability, **ENGINE_MISMATCH** vs canonical | cannot promote | Keep; never mix PnL |
| OOS | golden SMA slice; WalkForwardValidator SAME_BAR | fixture + WFO tests | Alpaca for validator | **NOT ESTABLISHED** for CORE NEXT_BAR | frozen params, minOosTrades | After warehouse + next-bar engine |
| WFO | golden 1 window; WalkForwardValidator rolling SAME_BAR | tests | Alpaca | **NOT ESTABLISHED** (need ≥3 folds, median, NEXT_BAR) | purge/embargo on CORE | P1 after P0 engine |
| Robustness | SMA neighborhood + cost multiples | phase 17 | fixture | **NOT ESTABLISHED** for CORE | delay, omit, spread | P1 |
| Statistics | permutation on SMA PnL; MonteCarlo on R-multiples | tests | trade log | scenario only | CORE NEXT_BAR sample | P1 |
| Multiple testing | warning function | phase 18 | n/a | **no ledger** | trial count per dataset | P0 ledger |
| Regime breakdown | `BacktestEngine` by entry regime | tests | SAME_BAR trades | not promotion | NEXT_BAR regime table | P1 |
| Paper | OMS stamp + organic filter | phase 21 | Autobot PAPER fills | **NOT ESTABLISHED** | 30 trades / 10 sessions | Operational, not a code claim |
| Promotion | emptyEvidence API | phase 17/21 | artifacts | all CORE **UNTESTED** | GREEN REAL data + passes | Wire artifacts (P0) |
| Agent calibration | outcomes table + Beta buckets | tests | live predictions | sample unknown here | min-n before weights | P1 ReflectionEngine |
| Consensus value | none vs technical-only | PitReplay | PIT ledger | **UNAVAILABLE** | same period, same costs | P2 |
| Warehouse GREEN | ingest + assessDataQuality | quality tests | Alpaca keys | **no persisted parquet in repo** | long history, pagination, gap grade | P0 |

---

## 1. Current capability (what already works)

- Fail-closed live path; Autobot-off does not debate entries; RiskEngine records gates; OMS idempotency; inbound unmatched broker fills are `EXTERNAL_MANUAL`, not organic paper.
- Execution model **versioned**: `argus-research-execution-v1`. Mixing NEXT_BAR_OPEN vs SAME_BAR_CLOSE → `ENGINE_MISMATCH`.
- Data quality gate: empty/dup/invalid OHLC/bad volume → RED. `liveCandidateAllowed` **hard-false** in `assessDataQuality`.
- Promotion cannot be assigned VALIDATED; provenance must be REAL_MARKET_DATA.
- Organic paper filter rejects UNKNOWN / BACKTEST / REPLAY / test traces / REJECTED.
- Golden SMA is labeled UNIT_FIXTURE and not promotable.
- VectorBT cannot place orders.
- Empty PIT ledger does not authorize AI BUY unless explicit `allowTechnicalWhenEmpty` (used **only** inside strategy BacktestEngine).
- Strategy specs in `config/strategySpecs.json` + `freezeStrategyVersion`.
- Wilson interval + LLM vs empirical probability kinds.
- Lookahead helper for unclosed daily bars in intraday (library; not applied to every CORE feature).

---

## 2. Missing capability (blocks “prove or reject edge”)

1. **No canonical CORE NEXT_BAR_OPEN simulator** that produces a trade log with costs, stops, targets, sizing, rejected orders, and provenance fields (`strategyVersion`, `datasetHash`, `executionModelVersion`, …).
2. **No durable GREEN REAL_MARKET_DATA warehouse** in this checkout (`data/research/` empty / unwritten). Registry is RAM.
3. **No persisted research-run directory** (`data/research/runs/<runId>/`).
4. **WFO/robustness/stats are SMA-fixture or SAME_BAR**, not CORE canonical.
5. **Default research costs are zero** (`researchSafety.commissionPerShare/spreadBps/slippageBps` = 0) → theoretical fills unless stamped `THEORETICAL_ZERO_COST` and blocked from promotion.
6. **No experiment accounting** (how many symbols × params × windows were searched).
7. **No paper vs research reconciliation** from OMS rows vs research trades.
8. **No ensemble/correlation research**.
9. **ChiefTrader consensus incremental value** is not measured on a common sample.
10. **Ingest does not paginate**; HistoricalDataGateway does. Warehouse history is truncated.

---

## 3. Evidence quality

| Artifact | Quality |
|---|---|
| Golden SMA PnL | UNIT_FIXTURE. Deterministic. **Not edge.** |
| `WALKFORWARD_CHECK_RESULTS.json` | SAME_BAR; **symbol/strategy cherry-pick** (script comment: highest Sharpe from E1). OOS ~0.04% / 0.28% average period return. **Not OOS_VALIDATED.** |
| Vitest 991 | Invariant/unit. **Not paper.** |
| VectorBT installed | Capability. **FEATURE_TRANSLATION.** |
| `emptyEvidence` API | Honest UNTESTED. |
| Organic paper GET | Empty-honest if no tagged SELL PnL. |

**Trading-edge score remains 8.** Nothing in this audit raises it.

---

## 4. Leakage risks

| Risk | Where | Severity |
|---|---|---|
| Same-bar fill uses close after signal on that bar | `BacktestEngine` | High if mixed with live/next-bar |
| `allowTechnicalWhenEmpty: true` | strategy backtest BUY | High if reported as “AI consensus worked” |
| WFO train/test both SAME_BAR; no embargo between windows | `WalkForwardValidator` rolls by `testMs` with **adjacent** windows | Medium |
| Golden WFO grid on train/val then one test — **one fold** | `walkForward.ts` | Medium (overfit theater on 24 bars) |
| `cleanOhlcv` **drops** bad/dup bars **before** quality grade | ingest | High: gappy series can still look GREEN |
| No session calendar / missing-interval detection | `dataQuality.ts` | High: holes look like valid series |
| Feature engines see bar T **close** (correct for signal) but CORE replay does not delay fill | `argusStrategyReplay` | Medium: stamped NEXT_BAR without simulating it |
| HTF look-ahead library unused by CORE evaluate | `lookAheadMtf.ts` | Medium if MTF features added later |
| Parameter search then reporting best symbol (MSFT/AMD) | `runWalkForwardCheck.ts` | **Data snooping** |
| ReflectionEngine weight from small n | live ChiefTrader | Medium: recent luck → more vote weight |
| Import CSV provenance caller-chosen | `importResearchDataset` | High if someone labels fixture REAL_MARKET_DATA |

---

## 5. Execution mismatches

| Engine | Fill | Costs | Stops | Sizing | Promotion-comparable? |
|---|---|---|---|---|---|
| Canonical (declared) | T+1 open | config bps/share (currently **0**) | strategy stop/target **not executed in replay** | RiskEngine live only | N/A until implemented |
| `runSmaCrossover` | T+1 open | optional commission | none | qty=1 | Fixture only |
| `nextOpenFillStats` | T+1 open | none | none | qty=1 | No |
| `BacktestEngine` | **same-bar close** | commission + dynamic slippage | strategy stop/target on **same bar** | PositionSizing | **No** vs NEXT_BAR |
| Live OMS | broker (paper/live) | broker | PortfolioMonitor exits | RiskEngine 5% stop assumption | Paper only when stamped |

`researchSafety` zero costs ≡ `THEORETICAL_ZERO_COST` if used for CORE PnL. Must not promote.

Live stop model is **`tradingSafety.stopLossAssumptionPct` (5%)**, not ATR. `ExpectedValue.ts` header claiming PositionSizing is ATR-based **disagrees with code**. Trust `PositionSizing.ts`.

---

## 6. Data problems

- Warehouse script: last **7 days**, first **3** benchmark symbols, all listed timeframes, **no page_token**.
- `adjustment: raw` only. Corporate actions **not modeled**.
- Timezone assumed `America/New_York` without bar-session validation.
- Zero-volume → YELLOW; duplicates → RED. **Missing expected bars: not detected.**
- `datasetRegistry` not durable.
- Alpaca fetch failure → **empty array**, provenance `UNKNOWN` (honest) but easy to confuse with “no market that day.”

---

## 7. Statistical problems

- Permutation is **sign-flip of trade PnLs**, not full price-path shuffle; `pass` if p ≤ 0.05 — mechanical.
- MonteCarlo is labeled **scenario analysis**; refuses small samples for Kelly; **not wired to promotion artifacts**.
- Sharpe on tiny samples: BacktestEngine has trust floors; ReflectionEngine **does not** (fake vol 0.1).
- No Deflated Sharpe, PBO, or White’s Reality Check.
- `minWalkForwardWindows = 3` but golden WFO produces **1** window.
- No median-fold requirement in WalkForwardValidator (uses **average** OOS).

---

## 8. Strategy problems

- CORE `evaluate()` is real TS. VectorBT adapters are **FEATURE_TRANSLATION**, not live-regime parity.
- Spec JSON describes rules in **English**; thresholds from `quantThresholds.json`. Freeze hash helps, but **OOS can still use whatever is in JSON today** unless runs pin the hash.
- Many experimental modules exist; live inclusion is env-gated. **Do not add more.**
- Long-only backtests; bearish setups do not short.
- Market context in research replay is **UNAVAILABLE** (not invented) — CORE entries that require RS/sector will **under-fire** vs live if live has SPY/QQQ.

---

## 9. Paper validation problems

- Filter is correct; **counts are unknown / not established**.
- Historical OMS rows before stamp remain UNKNOWN.
- Stub brokers (`lifecycle-stub`) resolve UNKNOWN (good).
- Dual flags: `settings.tradingMode` vs broker paperMode still exist.
- Paper experiment freeze (`paperExperiment.ts`) is a **hash helper**, not a running session ledger.

---

## 10. Agent calibration problems

- `AIPredictionValidation`: real, but **price direction ≠ fill PnL**.
- NewsAgent historically poorly calibrated (prior reports); this audit does not re-score live DB.
- ChiefTrader loads `agent_performance_stats.currentWeight` with **no statisticallyMeaningful gate**.
- ReflectionEngine **invents Sharpe** and a **fake profit factor**.

---

## 11. Operational problems

- QUANT off → CORE strategies **do not** emit live ideas unless other agents fire.
- Organic paper **requires Autobot ON** + PAPER broker + closed SELL.
- Research jobs timeout; VectorBT skipped in Vitest unless `ARGUS_TEST_ALLOW_VECTORBT`.
- SQLite vs parquet: millions of bars should not live in SQLite; gateway already uses SQLite cache for backtests.

---

## False-positive evidence (do not cite as edge)

1. Golden SMA net PnL  
2. VectorBT “AVAILABLE”  
3. Test pass counts  
4. `WALKFORWARD_CHECK_RESULTS.json`  
5. SAME_BAR Sharpe from `runStrategyBacktest`  
6. LLM confidence / debate “approval”  
7. Restricted-live dollar caps  
8. Agent weight > 1 after a few wins  
9. GREEN quality after `cleanOhlcv` dropped gaps  
10. Research Lab UNTESTED rows (honest, but not a pass)

---

# Prioritized implementation plan

**Constraint:** No second OMS, no LIVE enablement, no RiskEngine bypass, no QUANT auto-on, no fake data. Prefer additive research modules. **Wait for approval before large changes.**

## P0 — Make it possible to reject CORE honestly (smallest correct set)

| ID | Change | Why | Not in scope |
|---|---|---|---|
| P0.1 | Canonical CORE research fill: signal at T (existing `evaluate`) → **fill at T+1 open**; apply **non-zero cost model from config** or stamp `THEORETICAL_ZERO_COST` and **forbid promotion**. Execute stop/target on subsequent bars without lookahead. Persist trade log + metrics with full provenance. | Today CORE replay has **no PnL**. | Do not change live OMS fills. |
| P0.2 | Warehouse: **paginate** Alpaca like `HistoricalDataGateway`; persist sidecar+parquet only GREEN; **grade raw bars before drop**; record `droppedBarCount`, `missingIntervals`; refuse GREEN if missing-interval rate exceeds config. Default ingest window **documented**, not implied complete. | Without REAL_MARKET_DATA, promotion stays UNTESTED forever (correct) but we cannot **measure** edge. | Do not fabricate gaps. |
| P0.3 | Durable registry / `data/research/runs/<runId>/` manifest (opt-in write flag). Promotion reads **files**, not hand-set booleans. GET evidence stays empty until files exist. | Prevents “boolean theater.” | Do not auto LIVE. |
| P0.4 | Experiment ledger: increment trials on each CORE run (strategyVersion × datasetHash × param hash). Surface `multipleTestingWarning`. | Stops silent mining. | Full White’s RC later. |
| P0.5 | Label `WALKFORWARD_CHECK_RESULTS.json` in code/docs as **SAME_BAR + cherry-picked + not promotion**. Do not import into `promotionEngine`. | Existing false-positive magnet. | Do not delete history; quarantine. |
| P0.6 | If `commissionPerShare/spreadBps/slippageBps` remain 0, results **cannot** set `backtestPass`. | Zero-cost edge is not an edge. | Do not invent realistic cost numbers without a source. Put numbers in `config/executionModels.json` / `researchSafety.json` as reviewed assumptions. |

**P0 success metric:** Ability to run MOMENTUM_BREAKOUT-1.0.0-\<hash\> on a GREEN REAL dataset (when keys+data exist) and get **FAILED / INSUFFICIENT_SAMPLE / FRAGILE / NO EDGE** with provenance — not a green UI.

If Alpaca keys are absent, warehouse remains UNAVAILABLE. **Do not substitute golden SMA.**

## P1 — After P0 produces real trade logs

| ID | Change |
|---|---|
| P1.1 | Rolling WFO on **canonical NEXT_BAR** CORE: train / val / test, embargo, **≥3 folds**, **median** test expectancy, persist each fold. SAME_BAR WFO remains a separate labeled engine. |
| P1.2 | Robustness on CORE trade logs: param ±, slippage ±, cost ±, 1-bar delay, random omit. Classify ROBUST / FRAGILE / FAILED. Do not retune to pass. |
| P1.3 | Bootstrap CI on expectancy; keep permutation as **non-proof**. INSUFFICIENT_SAMPLE below `minOosTrades`. |
| P1.4 | ReflectionEngine: **no weight/Sharpe update** below `minSampleSizeForTrust`; delete hardcoded 0.1 vol Sharpe. |
| P1.5 | Paper/research reconciliation report from OMS `executionEnvironment=PAPER` vs research trades (same strategyVersion). DIVERGENCE status. |
| P1.6 | Regime table from **point-in-time** `classifyRegime` at signal bar only. |

## P2 — Later, still no architecture rewrite

| ID | Change |
|---|---|
| P2.1 | Consensus ablation (technical vs N-agent) on **same** NEXT_BAR sample. Allow conclusion “no incremental edge.” |
| P2.2 | Portfolio correlation of CORE returns; combine only if evidence. |
| P2.3 | Deflated Sharpe / PBO once experiment ledger has large N. |
| P2.4 | Failure-injection and latency metrics (correctness already first). |
| P2.5 | UI: remaining fabricated Agent Network series per `FINAL_ANALYSIS.md`. Research charts must show datasetHash + executionModel. |
| P2.6 | Do **not** add indicators or experimental live strategies. |

---

## What this audit will **not** claim after P0 even if P0 ships

- CORE VALIDATED  
- LIVE_CANDIDATE  
- Edge score > 8 without GREEN REAL NEXT_BAR OOS + WFO + robustness + organic paper  

A failed CORE backtest **lowers** confidence in a hidden edge; it does **not** raise the score.

---

## Current promotion status (every named strategy)

Derived from `emptyEvidence` + inventory code. **No REAL_MARKET_DATA artifact in this repo.**

| ID | Status |
|---|---|
| MOMENTUM_BREAKOUT | **UNTESTED** |
| PULLBACK_CONTINUATION | **UNTESTED** |
| MEAN_REVERSION | **UNTESTED** |
| TREND_FOLLOWING | **UNTESTED** |
| RANGE_REVERSION | **UNTESTED** |
| SMC_LIQUIDITY_SWEEP | **UNVALIDATED** |
| GOLDEN_SMA | **UNIT_FIXTURE** (not a live strategy) |

---

## Verdict (unchanged)

**PAPER: CONDITIONAL GO** (plumbing).  
**LIVE: NO-GO.**  
**Trading edge: 8 / 100.**  
**CORE: no demonstrated repeatable edge. Absence of proof is not proof of absence — and is not proof of presence.**

---

## Approval gate

This document is the **Phase 1 deliverable**.  

**Do not implement P0.1–P0.6 until explicitly approved.**  

Recommended first approval slice if you want the smallest useful increment: **P0.1 + P0.6 + P0.3** (canonical NEXT_BAR CORE runner + cost honesty + run artifacts), then **P0.2** when Alpaca keys can actually fill a warehouse. **P0.5** is documentation/quarantine only and is low-risk.
