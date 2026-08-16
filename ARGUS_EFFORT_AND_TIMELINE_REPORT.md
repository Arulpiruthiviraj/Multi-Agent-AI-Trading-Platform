# ARGUS Effort, Timeline, and Completion Analysis

**Date:** 2026-08-16  
**Role:** Principal Quantitative Systems Architect / Lead SRE / Technical Project Manager  
**Method:** Read-only scan of the live tree (`src/`, `server.ts`, `config/`, `python/argus_research/`, `scripts/`, `data/`), cross-checked against `FINAL_ANALYSIS.md`, `ARGUS_REAL_MONEY_GAP_ANALYSIS.md`, `ARGUS_PRODUCTION_REMEDIATION_PROGRESS.md`, and `liveReadinessEngine.ts`.  
**Authorization:** Analysis only. No code was written in this phase beyond this report.

---

## 0. Executive Verdict (read this first)

| Gate | Status |
|------|--------|
| **LIVE capital** | **NO-GO** (`LIVE_NO_GO`) |
| **Trading edge** | **8 / 100** |
| **Organic paper** | **NOT_ESTABLISHED** (0 closed PAPER `FILLED` `SELL`s in this environment) |
| **Canadian live routing** | **BLOCKED** |
| **Supervised paper plumbing** | **CONDITIONAL GO** (EventBus → ChiefTrader → RiskEngine → OMS → BrokerManager) |
| **Unattended paper certificate** | **NO-GO** |
| **Historical Replay (MODE B)** | **GO as simulation**; **FORBIDDEN** as edge / organic paper / auto-promotion |

**Brutal honesty:** Most of the *software spine* for fail-closed paper execution is built. Almost none of the *empirical proof* required for real money exists. An 8/100 edge score means **~92% of the statistical / soak validation work is still ahead** — and most of that cannot be finished by writing TypeScript. It requires GREEN multi-year data ops, research runs that may honestly FAIL, and calendar time for organic paper fills across sessions.

Do **not** treat passing vitest, Phase 24 replay P&L, VectorBT grids, or Shadow ledger updates as trading edge.

---

## 1. Overall Completion Percentages

| Dimension | Completion | How to read it |
|-----------|------------|----------------|
| **Software / Infrastructure Readiness** | **86%** | OMS isolation, RiskEngine ladder, dual-flag + LIVE_ARM, encryption fail-closed, auth-in-production, research quarantine stamps. Residual: networked no-auth when `AUTH_PASSWORD` unset, `PAPER_TRADING_ONLY` vs BrokerManager drift, paper-mode correlation SKIPPED honesty, ops runbooks. |
| **Quantitative Research Parity** | **58%** | Canonical `NEXT_BAR_OPEN` + non-zero costs + FEATURE_SUBSET (BOS/RVOL/Keltner/S-R) exist. Full `StrategyContext.evaluate()` ↔ Python parity is **false**. `BacktestEngine` remains SAME_BAR (correctly non-promotable). Warehouse software exists; durable multi-symbol GREEN parquet inventory does not. |
| **Empirical Trading Edge** | **8%** | Matches `tradingEdgeScore(emptyEvidence)` band `0–20`. CORE UNTESTED on REAL_MARKET_DATA NEXT_BAR promotion path; prior SPY WFO **FRAGILE** / robustness **FAILED**; organic paper **0**. |
| **Overall Money Readiness** | **18%** | Hostile blend: plumbing does not unlock capital. Money readiness is dominated by edge (8%) + organic soak (0%) + manual approval. **Not** an average of infra scores. |

### Weighted interpretation (money, not vanity)

```
Money readiness ≈ f(edge, organic paper, OOS/WFO/robustness PASS, LIVE arm, legal)
               ≈ heavily capped by min(edge, paper_evidence)

Infra 86% × Research 58% × Edge 8%  ≠  money readiness
```

If tomorrow every remaining bugfix shipped and CI stayed green, **money readiness would still be ~8–25%** until GREEN warehouse evidence + passing gauntlet + ≥30 organic paper trades exist.

---

## 2. Pillar Deep Dive

### A. Execution Infrastructure & Security (Plumbing) — ~86%

**Done (evidence-backed):**

| Capability | Location | Fact |
|------------|----------|------|
| Sacred fill path | EventBus → ChiefTrader → RiskEngine → OMS → BrokerManager | Production `placeOrder` isolated to OMS + adapters |
| OMS unknown submit | `OrderManagement.ts` | Throw without `brokerOrderId` → PENDING + `UNKNOWN` + `TRADING_PAUSED` (no fake REJECTED) |
| Dual LIVE flags | `brokerEnvironment.ts` + OMS | LIVE only if `tradingMode=LIVE` **and** `paperMode=false`; else UNKNOWN → no order |
| LIVE arm | `LiveTradingConfirmation.ts` + OMS + `AlpacaBroker` | Phrase arms process; restart clears arm; live host refuses without arm |
| Restricted live clamps | `RestrictedLiveMode.ts` + `tradingSafety.json` | $5k / 3 pos / $1k daily — ceiling only, not edge |
| Encryption | `EncryptionService.ts` | Missing secret / decrypt failure **throws**; no plaintext passthrough |
| Secrets file | `server.ts` | `data/secrets.json` presence **throws** unless override env |
| Legacy signals bypass | `server.ts` | `/api/v1/signals` → **410** quarantined |
| Data freshness | `marketDataQuality.ts` | Null age → FAIL / UNKNOWN |
| Organic filter | `organicPaper.ts` | Excludes REPLAY / UNKNOWN / MANUAL_OVERRIDE / test traces |

**Remaining fail-open / honesty gaps (engineering, not edge):**

| Gap | Severity | Files |
|-----|----------|-------|
| `AUTH_PASSWORD` unset → open `/api` + `/ws` in non-production | High if host exposed | `AuthConfig.ts`, deploy policy |
| `PAPER_TRADING_ONLY` not enforced in BrokerManager/AlpacaBroker | Medium | `BrokerManager.ts`, `AlpacaBroker.ts`, `App.tsx`, docs |
| Paper correlation/sector SKIPPED (LIVE fail-closed) | Medium honesty | `PositionSizing.ts` |
| `market_hours` skip when no Alpaca keys | Medium | RiskEngine / `docs/ARGUS.md` |
| Stale honesty in `docs/ARGUS.md` (signals/ticks/equity claims) | Low–Med | `docs/ARGUS.md` |
| Recon pause ≠ auto-flatten | Ops | OMS / runbooks |

**Verdict:** Supervised paper plumbing is largely shippable. Unattended / money-safe ops still need auth defaults, broker env alignment, and operator discipline. **Does not raise edge above 8.**

---

### B. Canonical Research & Parity — ~58%

| Engine | Fill model | Promotable? |
|--------|------------|-------------|
| `BacktestEngine.ts` | SAME_BAR_CLOSE | **No** (`SAME_BAR_CLOSE_NOT_PROMOTABLE`) |
| `canonicalNextBarEngine.ts` | NEXT_BAR_OPEN + costs | **Yes** (intended promotion path) |
| Python `core_strategies.py` / VectorBT | Subset features + same cost keys | Research grids only; `canPlaceOrders: false` |

**Costs (`config/researchSafety.json`):** commission `0.005` / share, spread `2` bps, slippage `5` bps, `zeroCostBlocksPromotion: true`. Missing keys throw in TS/Python — good.

**Parity reality:**

| Claim | Status |
|-------|--------|
| BOS / RVOL / Keltner / S-R vector parity | **FEATURE_SUBSET_PARITY** / vector established vs UNIT_FIXTURE |
| Full StrategyContext (VWAP, DMI, MACD, CMF, sector, RS, candles, StochRSI, RegimeEngine) | **`fullStrategyParity: false`** (`quantWfoGrid.json`) |
| SMC | **PROXY_NOT_FEATURE_PARITY** / UNVALIDATED |
| Mixing SAME_BAR + NEXT_BAR | `ENGINE_MISMATCH` |

**Remaining engineering:** either port full context into Python **or** permanently treat VectorBT CORE PnL as non-Argus-strategy evidence in UI/promotion; keep BacktestEngine quarantined (do not “quietly” relabel as NEXT_BAR).

---

### C. Data Warehouse & Pipeline — ~42% software / ~5% durable inventory

| Piece | Status |
|-------|--------|
| Ingest + quality grade | **Built** — `ingestAlpacaWarehouse.ts`, `assessDataQuality` (no class named `ResearchDataQualityEngine`) |
| Parquet only after GREEN + `ARGUS_WRITE_RESEARCH_PARQUET` | **Built** — Phase 26 honesty |
| Default symbols | SPY / QQQ / IWM |
| This environment on disk | SPY 1Day sidecar GREEN (~519 bars), **`parquetBytesWritten: false`**, **zero** `.parquet` under `data/research/`, no QQQ/IWM inventory |
| Default script window risk | Ops often run short windows; multi-year needs `ingestDailyLookbackDays` (756 in config) + keys + pyarrow |

**RED leakage risks:** YELLOW still `backtestAllowed` (exploratory); operators can misread SAME_BAR or subset-Python wins as live edge; inventory may count `.bars.json` without parquet bytes.

**Verdict:** Pipeline code is mid-maturity. Durable GREEN multi-year warehouse for the gauntlet is **mostly EXTERNAL ops**, not a missing Express route.

---

### D. Empirical Edge Validation (The Gauntlet) — Infra ~78% / Sample ~8%

**Infrastructure present:**

| Module | Role |
|--------|------|
| `promotionEngine.ts` | Lifecycle from evidence booleans only |
| `coreWalkForward.ts` | NEXT_BAR CORE WFO |
| `coreRobustness.ts` | MC / permutation / sensitivity / costStress **gates** |
| `edgeScore.ts` | Caps at 8 until REAL_MARKET_DATA lifecycle climbs |
| `scripts/run_canonical_research.ts` | Manual CORE backtest + WFO + robustness |
| `scripts/run_vectorbt_wfo.py` | DSR + OOS survivors; upserts **`RESEARCH_PARAM_CANDIDATE` only** (FORBIDDEN: PAPER_TESTING / VALIDATED / LIVE_*) |
| `paperTestingOverlay.ts` | Dead until `fullStrategyParity === true` |

**Config drift:** `quantWfoGrid.json` says `allowedUpsertStatus: "PAPER_TESTING"`; Python script forbids that upsert. Script wins at runtime — good brake, bad docs/config sync.

**Why edge is 8:** `evaluateLiveReadiness()` / `tradingEdgeScore(emptyEvidence('MOMENTUM_BREAKOUT'))` — CORE UNTESTED on REAL_MARKET_DATA NEXT_BAR_OPEN. Climbing to 45+ requires artifact-backed WFO/robustness **and** paper lifecycle — none present.

**Missing automation:** There is **no** closed loop “GREEN parquet → WFO PASS → SQLite evidence booleans → PAPER_TESTING → organic soak → VALIDATED”. Operators run scripts; promotion does not auto-arm LIVE (correct).

**Floors (`researchSafety.json`):** `minOosTrades: 30`, `minWalkForwardWindows: 3`, `minPaperTrades: 30`, `minPaperSessions: 10`.

---

### E. Organic Paper Soak & UI Honesty — UI ~88% / Soak 0%

**Organic filter:** Correct by design (`organicPaper.ts` + phase21 invariants). Count in this DB: **0**.

**UI honesty mostly remediated (Phase 25):** Mission Control fabricated WR/arena removed; signals/event-memory 410; Learning metrics from `agent_performance_stats`.

**Remaining theater risks:**

| Risk | File |
|------|------|
| Hardcoded Kelly crypto win rates (BTC/ETH/SOL) | `App.tsx` (~Kelly EDGE FOUND cards) |
| Genetic history Sharpe/DSR if history populated | `App.tsx` |
| Confusing “DSR” badges on memory rules | `ContextMemoryEngineering.tsx` |
| Win-rate `|| 0` chart zeros | `LiveBotTelemetryPanel.tsx`, `TradeEfficiencyReport.tsx` |
| Educational AgentWorkflowTheater loops | Documented architecture theater (acceptable if labeled) |

Replay Lab correctly labels **NOT LIVE · NOT PAPER**.

---

## 3. Work Remaining — Phase Plan

Phases 18–26 are largely **CLOSED as infrastructure** (see `FINAL_ANALYSIS.md` / remediation progress). What remains is numbered as **Phase 27+** so engineering and incubation stay separable.

### Phase 27 — Durable GREEN Research Warehouse (Ops-heavy + small eng)

**Goal:** SPY/QQQ/IWM multi-year GREEN with parquet bytes written; inventory cannot claim GREEN without durable artifacts.

| Work | Type | Files |
|------|------|-------|
| Run ingest with keys + `ARGUS_WRITE_RESEARCH_PARQUET=true` + pyarrow | **Ops** | `scripts/ingest_research_warehouse.ts`, `ingestAlpacaWarehouse.ts` |
| Tighten inventory: parquet vs bars.json honesty | Eng | `warehouseInventory.ts`, `parquetStore.ts` |
| Document lookback / IEX limits | Eng | `config/researchSafety.json`, runbook |

**Engineering:** 8–16 h  
**Ops wall-clock:** 0.5–2 days (API pagination / rate limits)

---

### Phase 28 — Evidence Pipeline Sync & Gauntlet Automation (Eng)

**Goal:** One operator command produces artifact-backed evidence booleans; config matches Python upsert policy; no silent PAPER_TESTING.

| Work | Files |
|------|-------|
| Align `allowedUpsertStatus` with `run_vectorbt_wfo.py` | `config/quantWfoGrid.json`, `python/argus_research/` upsert path |
| Wire canonical WFO/robustness artifacts → `StrategyEvidence` / research runs | `promotionEngine.ts`, `researchRuns.ts`, `scripts/run_canonical_research.ts`, `researchRoutes.ts` |
| Fail closed if SAME_BAR or UNIT_FIXTURE presented as CORE edge | `executionModel.ts`, UI research panels |
| Optional: job status UI for research jobs | `researchJobs.ts`, Research UI components |

**Engineering:** 24–40 h  
**Does not guarantee PASS** — prior SPY run was FRAGILE/FAILED.

---

### Phase 29 — Full StrategyContext ↔ Python Parity **or** Hard Quarantine

**Goal:** Stop treating subset VectorBT as Argus live strategy evidence.

| Option | Files | Effort |
|--------|-------|--------|
| **A — Port remaining features** (VWAP, DMI, MACD, CMF, sector, RS, candles, StochRSI, RegimeEngine) | `python/argus_research/core_strategies.py`, `core_features.py`, `config/quantWfoGrid.json` (`fullStrategyParity: true` only after tests), parity vitest/python fixtures | **80–160 h** |
| **B — Quarantine (recommended near-term)** | Label VectorBT `FEATURE_SUBSET_ONLY`; block overlay forever until parity; UI/docs | **8–16 h** |

**Recommendation:** Ship **B** immediately for honesty; schedule **A** only if VectorBT is required for CORE promotion math.

---

### Phase 30 — UI Theater Residual Purge (Eng)

| Work | Files |
|------|-------|
| Remove/replace Kelly hardcoded crypto WR cards | `App.tsx` |
| Gate genetic Sharpe/DSR render to real endpoints only | `App.tsx`, `autobotRoutes.ts` |
| Rename/clarify memory “DSR” badges | `ContextMemoryEngineering.tsx` |
| Null win-rate → N/A not `0` | `LiveBotTelemetryPanel.tsx`, `TradeEfficiencyReport.tsx` |

**Engineering:** 8–16 h

---

### Phase 31 — Deploy / Auth / Paper-Env Hardening (Eng)

| Work | Files |
|------|-------|
| Fail-closed or warn-loud for networked no-auth | `AuthConfig.ts`, `server.ts` |
| Enforce or delete `PAPER_TRADING_ONLY` vs BrokerManager | `BrokerManager.ts`, `AlpacaBroker.ts`, `App.tsx`, `.env.example` |
| Refresh `docs/ARGUS.md` honesty (signals 410, ticks, equity) | `docs/ARGUS.md` |
| Optional: paper-mode UNKNOWN correlation policy | `PositionSizing.ts` |

**Engineering:** 12–24 h

---

### Phase 32 — Empirical Gauntlet Runs (Mostly incubation + interpretation)

**Goal:** CORE strategies on GREEN REAL_MARKET_DATA NEXT_BAR: OOS ≥30 trades, WFO ≥3 windows, robustness gates PASS — **or honest FAIL with no promotion**.

| Work | Type | Files / tools |
|------|------|----------------|
| Re-run `run_canonical_research.ts` / WFO / robustness on Phase 27 data | Ops | scripts + `coreWalkForward.ts` / `coreRobustness.ts` |
| Interpret FRAGILE/FAILED — retune only via allowlisted research, never LIVE | Research | `config/*`, research ledger |
| Persist passing evidence into promotion artifacts | Eng light | `researchRuns.ts`, `promotionEngine.ts` |

**Engineering (interpretation tooling / bugfix):** 16–40 h  
**Research calendar:** **2–8 weeks** (iterate if FAIL; cannot schedule a PASS)

---

### Phase 33 — Organic Paper Soak (Incubation-dominant)

**Goal:** ≥30 organic closed PAPER `FILLED` `SELL`s across ≥10 NY sessions; positive expectancy; drawdown within policy; Autobot + real ticks + InternalPaper or Alpaca **paper**.

| Work | Type | Files |
|------|------|-------|
| Enable supervised paper; ensure OMS stamps `executionEnvironment=PAPER` | Ops | TradingEngine, brokers, settings |
| Monitor `/api/v2/research/organic-paper` | Ops | `organicPaper.ts`, research routes |
| Exclude replay/shadow/overrides (already coded) | Verify | `organicPaper.ts` |

**Engineering:** 4–12 h (dashboards/alerts only)  
**Market incubation:** **minimum ~2–4 weeks** if the bot trades often enough to hit 30 closes / 10 sessions; **realistic 4–12 weeks** including quiet regimes, rejects, and holidays. **Cannot be fabricated.**

Config floors: `minPaperTrades: 30`, `minPaperSessions: 10`.

---

### Phase 34 — LIVE Candidate Checklist + Manual Arm (Ops / governance)

**Goal:** Human-reviewed `LIVE_CANDIDATE` after VALIDATED evidence; still **no auto LIVE**.

| Work | Files |
|------|-------|
| Walk `ARGUS_LIVE_CANDIDATE_CHECKLIST.md` / readiness matrix | ops docs |
| Confirm recon, backup, kill-switch drills | runbooks |
| Type `ENABLE LIVE TRADING` only after checklist | `LiveTradingConfirmation.ts` |
| Canadian remains BLOCKED unless legal/engineering program | `markets.json`, IBKR/Questrade adapters |

**Engineering:** 8–16 h (checklist automation / readiness UI polish)  
**Governance:** operator decision — **not** an engineering estimate

---

## 4. Time & Effort Estimation

### 4.1 Engineering effort (Senior Quant / Systems Engineer)

| Phase | Hours | Calendar (1 FTE) |
|-------|-------|------------------|
| 27 Warehouse honesty + ops assist | 8–16 | 1–2 days |
| 28 Evidence pipeline / config sync | 24–40 | 3–5 days |
| 29B Quarantine VectorBT (recommended) | 8–16 | 1–2 days |
| 29A Full Python parity (optional) | 80–160 | 2–4 weeks |
| 30 UI residual purge | 8–16 | 1–2 days |
| 31 Auth / paper-env harden | 12–24 | 2–3 days |
| 32 Gauntlet tooling / fail interpretation | 16–40 | 2–5 days |
| 33 Soak monitoring polish | 4–12 | 0.5–1.5 days |
| 34 Checklist / readiness polish | 8–16 | 1–2 days |
| **Total without 29A** | **~88–180 h** | **~2.5–5 weeks** focused eng |
| **Total with 29A** | **~160–320 h** | **~1–2 months** eng |

Buffer for regressions / hostile tests: **+20–30%**.

### 4.2 Market incubation effort (cannot be coded away)

| Gate | Minimum | Realistic | Notes |
|------|---------|-----------|-------|
| GREEN multi-year warehouse | 0.5–2 days | 1 week | Keys, pyarrow, pagination, re-grade |
| CORE OOS/WFO/robustness PASS | Unknown | **2–8+ weeks** | Prior SPY run **failed** gates; may never PASS on these strategies |
| Organic paper ≥30 / ≥10 sessions | ~10 sessions | **4–12 weeks** | Depends on signal rate, risk rejects, market hours |
| Multi-regime confidence | Not in `researchSafety` as a hard count | **+1–3 months** if required by operator policy | Bull/bear/sideways soak |
| Manual LIVE approval after VALIDATED | 1 day | 1–2 weeks | Governance + dry runs |

**Critical path to money (honest):**

```
Phase 27 warehouse ──► Phase 32 gauntlet (may FAIL) ──► Phase 33 paper soak
         │                        │
         └─ Phase 28/29/30/31 eng can run in parallel ─┘
```

- **Fastest conceivable to VALIDATED-like evidence:** ~6–10 weeks if gauntlet PASSes on first GREEN multi-year run **and** paper fills accumulate quickly.  
- **Base case:** **3–6 months** to honest LIVE_CANDIDATE discussion.  
- **If strategies have no edge:** infinite incubation — readiness stays NO-GO; engineering cannot invent expectancy.

### 4.3 What “100% Real-Money Readiness” actually means here

100% is **not** “all TypeScript written.” It means:

1. Software fail-closed on the live order path (**~86% today**),  
2. Research parity sufficient that promoted strategies match live `evaluate()` (**~58% today**),  
3. Artifact-backed OOS/WFO/robustness PASS on GREEN REAL_MARKET_DATA (**~0% today**),  
4. Organic paper floors met (**0% today**),  
5. Manual LIVE arm + ops/legal (**0% until humans decide**).

Reaching (1)+(2) without (3)+(4)+(5) is still **LIVE_NO_GO**.

---

## 5. Scorecard Snapshot by Pillar

| Pillar | Software % | Evidence % | Binding blocker |
|--------|------------|------------|-----------------|
| A Plumbing | 86 | n/a | Auth default; paper-env drift |
| B Research parity | 58 | n/a | `fullStrategyParity: false` |
| C Warehouse | 42 | ~5 | Parquet bytes / multi-symbol GREEN |
| D Gauntlet | 78 | 8 | Empty evidence; FRAGILE/FAILED history |
| E UI / soak | 88 UI | 0 soak | 0 organic fills; Kelly leftovers |

---

## 6. Immediate Next Technical Step (unblock the final stretch)

**Do this next (single critical path step):**

1. **Populate a durable GREEN research warehouse** for SPY (then QQQ/IWM) with **`ARGUS_WRITE_RESEARCH_PARQUET=true`**, Alpaca keys, and lookback consistent with `ingestDailyLookbackDays` (756), until sidecar shows **`parquetBytesWritten: true`** and `.parquet` files exist under `data/research/`.  
2. In parallel (same week of eng): **Phase 29B quarantine** + **Phase 30 Kelly purge** so operators cannot confuse subset VectorBT / UI theater with edge while waiting on data.

**Why this unblocks:** Every downstream gauntlet script and promotion gate is starved without GREEN REAL_MARKET_DATA artifacts. Paper soak can start on InternalPaper/Alpaca paper **in parallel**, but **promotion to VALIDATED / LIVE_CANDIDATE cannot** without warehouse + NEXT_BAR WFO/robustness evidence.

**Do not:** arm LIVE, raise the edge score in docs, count replay/shadow as organic paper, or treat vitest green as money readiness.

---

## 7. Sources (ground truth)

- `FINAL_ANALYSIS.md` — hostile verification; edge 8/100; organic 0  
- `ARGUS_REAL_MONEY_GAP_ANALYSIS.md` — binary PASS/FAIL gates A1–C3  
- `ARGUS_PRODUCTION_REMEDIATION_PROGRESS.md` — Phase 26 loop; EXTERNAL blockers  
- `src/server/core/liveReadinessEngine.ts` / `src/server/research/edgeScore.ts`  
- `config/researchSafety.json` / `config/quantWfoGrid.json`  
- `src/server/research/organicPaper.ts`, `canonicalNextBarEngine.ts`, `coreWalkForward.ts`, `coreRobustness.ts`  
- `python/argus_research/` + `scripts/ingest_research_warehouse.ts` / `run_vectorbt_wfo.py`

---

**Document status:** Estimation complete. LIVE remains **NO-GO**. Overall money readiness **18%**. Empirical edge **8%**. Next unblock: **GREEN parquet warehouse population**, then gauntlet re-run — not more scaffolding for its own sake.
