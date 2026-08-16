# ARGUS Real-Money Gap Analysis & Roadmap

**Date:** 2026-08-16  
**Role:** Principal Quantitative Risk Officer / Lead SRE / Institutional Systems Auditor  
**Method:** Hostile, read-only verification against the live tree (`.ts` / `.py` / `.json` / `data/argus.db`). Documentation claims were not treated as evidence.  
**Authorization:** No implementation in this phase. Awaiting operator authorization before any remediation phase begins.

---

## 1. Executive Summary

| Dimension | Verdict |
|---|---|
| **LIVE capital** | **NO-GO** (`evaluateLiveReadiness()` → `LIVE_NO_GO`) |
| **Trading edge score** | **8 / 100** (organic paper = 0; CORE UNTESTED on promotion path) |
| **Paper path (supervised)** | **CONDITIONAL GO** — EventBus → ChiefTrader → RiskEngine → OMS → broker is fail-closed and usable |
| **Paper path (unattended / “ready” certificate)** | **NO-GO** |
| **Organic paper evidence** | **0** closed `FILLED` `SELL` with `executionEnvironment=PAPER` in `data/argus.db` |
| **Canadian automated live** | **BLOCKED** (IIROC / adapter `canadianEquities: false`) |

**Bottom line:** The execution spine is largely hardened. Real money is blocked by **missing empirical edge**, **zero organic paper**, **FRAGILE/FAILED CORE walk-forward on GREEN SPY**, and incomplete full-strategy Python parity — not by a second production `placeOrder` path.

Do **not** type `ENABLE LIVE TRADING`. Do **not** treat Shadow, VectorBT, Phase 18 replay, or passing unit tests as P&L.

---

## 2. Audit Results (Section 2 checklist)

Binary PASS/FAIL only. Nuance in the Evidence column does not upgrade FAIL to PASS.

### A. Execution & Security Spine

| # | Gate | Status | Evidence (code / data) |
|---|---|---|---|
| A1 | **OMS Isolation** | **PASS** | Production `.placeOrder(` only in `OrderManagement.ts` + `src/brokers/*` (invariant `phase21.invariants.test.ts`). `server.ts` has **no** `.placeOrder(`. `executeAutoBotTradeInSovereign` **absent**. Shadow helper `executeAutoBotTradeInShadow` mutates JSON only; listener is `ORDER_EXECUTED` FILLED (not Chief pre-risk). |
| A2 | **Encryption Fail-Closed** | **PASS** | `EncryptionService.decrypt`: missing `:` / bad IV / catch → throws `DECRYPTION_FAILED`. Does **not** return ciphertext as plaintext. Empty string short-circuits unchanged (not a decrypt success path). |
| A3 | **Plaintext Secrets** | **PASS** | No read/write of `data/secrets.json` for keys. Boot **throws** if file exists unless `ARGUS_ALLOW_PLAINTEXT_SECRETS_FILE=true` (`server.ts`). `persistEncryptedSecrets.ts` documents never writing that file. |
| A4 | **Broker Dual-Flag Safety** | **PASS*** | Enforcement is **OMS** (`assertBrokerEnvironmentAllowsOrder`: LIVE only if `tradingMode=LIVE` **and** `paperMode=false`; mismatch → UNKNOWN → no order) + runtime `LIVE_ARM` (`assertLiveOrdersArmed`) + live Alpaca host check in `AlpacaBroker.placeOrder`. `AlpacaBroker` alone is URL/`isPaper`-based and does **not** re-read SQLite dual flags; silent demotion to paper URL requires `paperTrading()` / non-LIVE authenticate path, not a mismatched LIVE+paperMode order through OMS. |
| A5 | **API Security if `AUTH_PASSWORD` unset** | **FAIL** | `isAuthEnabled` is false when password unset → HTTP `/api/*` and `/ws` allow unauthenticated access in non-production. Production (`NODE_ENV=production`) refuses boot via `enforceAuthConfigOrExit`. Hostile gate: **dev/default unset password exposes APIs and WS.** |

\*PASS at the production order path. Not a claim that Alpaca REST re-validates SQLite `paperMode` inside every HTTP POST body.

### B. Backtest Parity & Data Honesty

| # | Gate | Status | Evidence |
|---|---|---|---|
| B1 | **Look-Ahead / NEXT_BAR fill in `BacktestEngine`** | **FAIL** | `BacktestEngine.ts` remains **SAME_BAR_CLOSE**, stamped non-promotable (`SAME_BAR_CLOSE_NOT_PROMOTABLE`). Canonical promotion path is `canonicalNextBarEngine.ts` (`NEXT_BAR_OPEN`) only. Mixing models → `ENGINE_MISMATCH`. |
| B2 | **Cost realism (`researchSafety.json`)** | **PASS** | `commissionPerShare: 0.005`, `spreadBps: 2`, `slippageBps: 5`, `zeroCostBlocksPromotion: true`. `isTheoreticalZeroCost()` is false → readiness gate `ZERO_COST_RESEARCH` PASS. |
| B3 | **Sizing gate honesty at qty 0** | **PASS** | `PositionSizing.ts`: `order_notional_cap` fails when `maxSharesByCapital <= 0`; concentration/sector/correlation fail when floor shares ≤ 0; post-pass flips binding CLAMP→FAIL at zero; `sufficient_size` fails iff `maxQuantity === 0`. Covered by `PositionSizing.test.ts`. |
| B4 | **`data_freshness` null age** | **PASS** | `evaluateQuoteFreshness({ priceAgeMs: null })` → `passed: false`, grade `UNKNOWN`. RiskEngine records gate `data_freshness` from that result (replay forces age 0 by design). |

### C. Quantitative Validation Bridge

| # | Gate | Status | Evidence |
|---|---|---|---|
| C1 | **VectorBT / Python feature parity** | **FAIL** (full strategy) | CORE ids tagged `FEATURE_PARITY_ESTABLISHED` for **BOS/RVOL/Keltner/S-R vectors** vs UNIT_FIXTURE (`config/strategySpecs.json`). `config/quantWfoGrid.json` and `python/argus_research/core_strategies.py`: **`fullStrategyParity: false`** (missing VWAP, DMI, MACD, CMF, sector, RS, candles, StochRSI, RegimeEngine). SMC remains **`PROXY_NOT_FEATURE_PARITY`**. Vector subset ≠ live `evaluate()` parity ≠ validated edge. |
| C2 | **Warehouse GREEN → Parquet** | **FAIL** (operational) | Code path exists: `ingestAlpacaWarehouse.ts` + `scripts/ingest_research_warehouse.ts`; grades via `assessDataQuality` (no class named `ResearchDataQualityEngine`); Parquet only if quality **GREEN**. On disk: `SPY_1Day_2024-07-21.meta.json` is GREEN REAL_MARKET_DATA (519 bars) but **`parquetBytesWritten: false`** (pyarrow / write job not completed in this environment). No `.parquet` under `data/research/`. |
| C3 | **Organic paper ≥30 closed SELL + expectancy** | **FAIL** | `data/argus.db`: **6** rows, all `PENDING` BUY, `execution_environment` **null**, **0** organic closed PAPER SELLs. Expectancy **not established**. |

### Additional mandatory LIVE gates (engine, not in Section 2 letter list)

| Gate | Status | Note |
|---|---|---|
| STRATEGY_CORE | FAIL | Lifecycle UNTESTED |
| STRATEGY_SMC | FAIL | UNVALIDATED |
| OOS / WFO / ROBUSTNESS | FAIL | Prior GREEN SPY NEXT_BAR run: WFO **FRAGILE**, robustness **FAILED** / insufficient (`ARGUS_LIVE_READINESS.md` metrics; not re-invented here) |
| LEGAL_CA | BLOCKED | Canadian live routing unavailable |
| MANUAL_APPROVAL / promotion | FAIL | `liveGoNoGo` NO-GO on empty evidence |

---

## 3. Scorecard Snapshot

| Area | Hostile read |
|---|---|
| Production order isolation | Strong |
| Encryption / secrets file | Strong |
| Dual-flag + LIVE_ARM | Strong on OMS path |
| Dev auth when password unset | Weak |
| BacktestEngine vs canonical fills | Intentionally divergent; BacktestEngine not promotable |
| Research costs | Non-zero |
| Freshness / sizing honesty | Fail-closed |
| Python full strategy parity | Incomplete |
| Parquet warehouse | Incomplete in this env |
| Organic paper / edge | Absent / 8 |

---

## 4. Phase-by-Phase Remediation Roadmap

Phases **20–23** already encoded many spine fixes (secrets, OMS isolation, NEXT_BAR canonical path, VectorBT vector tags). The remaining work is numbered **Phase 24+** so it does not pretend those are unfinished. **Do not start any phase without explicit authorization.**

Acceptance criteria are binary. Passing tests alone never raises the trading-edge score.

---

### Phase 24 — Auth & Operator Surface Hardening

**Goal:** Close the “AUTH_PASSWORD unset → open `/api` + `/ws`” FAIL without enabling LIVE.

| Item | Detail |
|---|---|
| **Files** | `src/server/core/AuthConfig.ts`, `server.ts` (WS upgrade gate), optional `config/tradingSafety.json` or env policy, AuthConfig tests |
| **Work** | Decide policy: require `AUTH_PASSWORD` whenever `ARGUS_REQUIRE_AUTH=true` / always outside explicit `ARGUS_ALLOW_NO_AUTH=true`; keep production refuse; document that no-auth is lab-only |
| **Acceptance** | (1) With password unset and allow-flag off, process refuses boot or refuses `/api`+`/ws`. (2) Existing production refuse still passes. (3) No LIVE enablement. (4) Edge score unchanged at 8. |

---

### Phase 25 — Shadow Ledger Honesty (ops clarity)

**Goal:** Prevent operators from mistaking Shadow for organic paper / OMS P&L.

| Item | Detail |
|---|---|
| **Files** | `server.ts` (shadow listener), `src/server/state/shadowPortfolio.ts`, UI consumers of shadow equity (e.g. ShadowPortfolioBenchmark), `FINAL_ANALYSIS` / readiness copy only if authorized |
| **Work** | Label shadow as `SIMULATION_LEDGER` / exclude from any paper counters; optional: disable shadow writes unless `SHADOW_LEDGER_ENABLED=true` |
| **Acceptance** | (1) No code path counts shadow fills as `executionEnvironment=PAPER`. (2) UI/API clearly marked NOT PAPER / NOT LIVE. (3) Organic paper query still 0 until real OMS paper closes exist. |

---

### Phase 26 — Warehouse Parquet Operationalization

**Goal:** Make GREEN REAL_MARKET_DATA durable as Parquet (checklist C2), without inventing bars.

| Item | Detail |
|---|---|
| **Files** | `scripts/ingest_research_warehouse.ts`, `src/server/research/ingestAlpacaWarehouse.ts`, `python/argus_research/` write_parquet job, env/docs for pyarrow |
| **Work** | Install/verify pyarrow in research venv; re-run ingest for SPY (and allowlisted symbols); confirm `.parquet` bytes written only when `assessDataQuality` = GREEN; refuse RED/YELLOW parquet |
| **Acceptance** | (1) At least one GREEN REAL_MARKET_DATA dataset with `parquetBytesWritten: true` and file on disk. (2) No fabricated OHLC. (3) `canPlaceOrders` remains false for research. |

---

### Phase 27 — Full Strategy Parity (optional for promotion math; required before claiming VectorBT = live TS)

**Goal:** Close C1 FAIL for **full** `StrategyContext.evaluate()` parity — or formally keep VectorBT as vector-only forever and block overlay retunes (already partially gated by `fullStrategyParity: false`).

| Item | Detail |
|---|---|
| **Files** | `python/argus_research/core_strategies.py`, `core_features.py`, parity fixtures, `config/quantWfoGrid.json`, `config/strategySpecs.json`, TS strategy modules under `src/server/quant/strategies/` |
| **Work** | Either implement missing features until `fullStrategyParity: true` **with** golden parity tests, **or** document permanent FAIL and forbid any claim that VectorBT PnL = Argus live evaluate |
| **Acceptance** | (1) `fullStrategyParity` true **only** with byte/fixture parity tests vs TS; **or** explicit permanent FAIL + no LIVE promotion from VectorBT. (2) SMC stays PROXY until separately validated. (3) No edge-score inflation from parity alone. |

---

### Phase 28 — CORE NEXT_BAR Research Until Not FRAGILE

**Goal:** Empirical research gates on GREEN REAL_MARKET_DATA with non-zero costs. Uses **canonical** NEXT_BAR only — **do not** “fix” by re-labeling `BacktestEngine` SAME_BAR as NEXT_BAR.

| Item | Detail |
|---|---|
| **Files** | `src/server/research/canonicalNextBarEngine.ts`, WFO/robustness runners, `config/researchSafety.json`, promotion/`strategy_configurations` writers (must stay PAPER_TESTING ceiling until gates pass) |
| **Work** | Re-run OOS / walk-forward / cost stress / robustness on GREEN warehouse datasets; freeze params; record artifacts. Leave `BacktestEngine` SAME_BAR labeled unless a separate multi-sprint rewrite is authorized |
| **Acceptance** | (1) Per CORE id: WFO not FRAGILE (≥ configured folds with positive test expectancy). (2) Robustness ROBUST (or honest FAIL). (3) Costs non-zero. (4) Provenance REAL_MARKET_DATA GREEN. (5) Promotion still cannot skip RISK_GATE_PASS / paper floors. |

**Note:** Prior SPY 1Day pass showed all CORE WFO FRAGILE / robustness FAILED. Re-running may still FAIL — that is an honest outcome, not a defect to paper over.

---

### Phase 29 — The 30-Day (Session) Paper Soak

**Goal:** Close C3. Organic evidence only.

| Item | Detail |
|---|---|
| **Files** | Ops runbook; no fabricated DB rows. Monitor via `organicPaper.ts` / `evaluateLiveReadiness()` PAPER / MIN_PAPER gates. Brokers: Alpaca **paper** or InternalPaper + real ticks |
| **Work** | Supervised PAPER: Autobot on, `tradingMode=Paper`, `paperMode=true`, market data healthy, NY sessions. Close round-trips through RiskEngine→OMS only |
| **Acceptance** | (1) ≥ `researchSafety.minPaperTrades` (30) organic `FILLED` `SELL` with numeric P&L and `executionEnvironment=PAPER`. (2) ≥ `minPaperSessions` (10) NY sessions. (3) Expectancy / drawdown gates evaluated honestly (may FAIL). (4) Replay/shadow/PENDING excluded. (5) Edge score may rise only via `tradingEdgeScore` rules when evidence objects are real — never by editing the score constant. |

---

### Phase 30 — Tiny LIVE Candidate (Human Gate Only)

**Goal:** Discuss LIVE only after Phases 26–29 acceptance. Still not automatic.

| Item | Detail |
|---|---|
| **Files** | `LiveTradingConfirmation.ts`, BrokerManager `setLiveMode`, TradingEngine `toggle`, RestrictedLiveMode caps, readiness checklist |
| **Work** | Human types exact phrase `ENABLE LIVE TRADING` on a **tiny** account; LIVE_ARM + dual flags; restricted-live ceilings remain file-reviewed |
| **Acceptance** | (1) All mandatory `evaluateLiveReadiness()` gates PASS (today they do not). (2) Manual approval recorded. (3) Canadian listings still blocked. (4) First live size ≪ restricted caps. (5) Kill-switch / `TRADING_PAUSED` drilled. |

**Until Phase 29 passes: Phase 30 is forbidden.**

---

### Explicitly Out of Scope / Do Not Do

| Anti-goal | Why |
|---|---|
| Convert `BacktestEngine` to NEXT_BAR as a “quick PASS” | Different cost/stop/sizing semantics; false green vs `canonicalNextBarEngine` |
| Fabricate organic paper rows | Edge fraud |
| Raise edge score in source without evidence | Violates `edgeScore.ts` contract |
| Unlock Canadian routing via `markets.json` | Regulatory / adapter hard-block |
| Enable LIVE to “see if it works” | Checklist NO-GO |
| Treat Phase 18 historical replay fills as paper | `executionEnvironment=REPLAY` excluded by design |

---

## 5. Recommended Authorization Sequence

1. **Authorize Phase 24** (auth harden) — low risk, closes A5.  
2. **Authorize Phase 25** (shadow labeling) — clarity.  
3. **Authorize Phase 26** (parquet) — research substrate.  
4. **Decide Phase 27** (full parity vs permanent vector-only).  
5. **Authorize Phase 28** only with GREEN data + non-zero costs — expect possible continued FAIL.  
6. **Authorize Phase 29** only on live NY sessions — calendar work, not a weekend code sprint.  
7. **Phase 30** only after 28+29 actually pass.

---

## 6. Final Statement

| Question | Call |
|---|---|
| Can Argus safely trade **real capital** today? | **NO** |
| Is the OMS spine trustworthy enough for **supervised paper**? | **YES, conditionally** |
| Trading edge? | **8 / 100 — NO-GO** |
| Next action from this auditor? | **Await authorization** for Phase 24 (or an alternate phase you name). No code until then. |

*— End of read-only gap analysis —*
