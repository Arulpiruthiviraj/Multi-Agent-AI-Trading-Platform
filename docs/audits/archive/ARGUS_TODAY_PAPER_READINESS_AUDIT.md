# ARGUS TODAY PAPER-TRADING READINESS AUDIT

**Status:** POST-HOLD REMEDIATION — CODE/TEST VERIFY (recon Autobot-independence)  
Date/time: 2026-08-20, ~09:37–15:05 local; verify pass ~11:05 local  
Git HEAD at start of this pass: prior working tree (RiskAgent lifecycle + market_hours AbortSignal.timeout already in suite)  
Environment: local Windows 11, Node (vitest 4.1.10)  
Broker intent: **PAPER ONLY** — `PAPER_TRADING_ONLY=true` (`.env`); no LIVE arming attempted  
Consensus floors (unchanged): `consensusApprovalThreshold=0.75`, `minIndependentAgreeingAgents=2` (`config/tradingSafety.json`)  
Runtime this refresh: **headless PAPER engine RUN-VERIFIED** (PID **33604**) — `interruptedSessionHold=false` after in-process MATCH id **585**. Autobot remains **DISABLED**. Recon boot/stop contract **CODE+TEST-VERIFIED** (architecture.protection).

This document marks each item as **CODE** / **TEST** / **RUN** / **NOT VERIFIED**. It does not inflate organic edge or LIVE eligibility.

---

## FINAL STATUS

```
ARGUS STATUS: SUPERVISED_PAPER_OPERATION_READY
Mechanical execution: VERIFIED
Safety controls: VERIFIED
Restart/reconciliation: VERIFIED
Autobot autonomous operation: NOT YET RUN-VERIFIED
Organic trading performance: NOT PROVEN
Required soak: unmet
LIVE authorization: NO-GO
```

Rationale: mechanical paper path is **TEST-VERIFIED** (InternalPaper spine) and headless paper engine was **RUN-VERIFIED** (prior PID **33604**: PAPER, `LIVE_NO_GO`, **`interruptedSessionHold=false`** after MATCH). **Autobot remains DISABLED** by design — Phase 2 Autobot paper run is **NEXT**, not claimed here. Organic soak floors remain unmet. **LIVE remains NO-GO.** Consensus floors **0.75 / min 2** unchanged. See `docs/audits/archive/ARGUS_CONTROLLED_PAPER_SOAK.md`.

### One-liner verdict

**Mechanical GO; Autobot run-verify NEXT; soak 0; LIVE_NO_GO; no edge claim.**

### Suite counts (do not conflate)

| Label | Files | Tests | Notes |
|---|---:|---:|---|
| **VERIFY PASS A (historical)** | **297** | **1880** | 2026-08-20 early verify (`a009af8c` era) — preserved below in § AA |
| **Later / post-hold refresh** | **301** | **1923** | Same calendar day after hold/recon work — not the same pass as 297/1880 |
| **FINAL (soak-engineering pass, 2026-08-21)** | **326** | **2090** | Health labels + first-fill forensic + soak protocol; `npm test` exit 0 |

Do **not** label 297/1880 and 301/1923 (or 326/2090) as the “same pass.”

---

## CRITICAL blockers (remaining)

| # | Blocker | Grade | Why it blocks supervised paper trading |
|---|---|---|---|
| 1 | **`interruptedSessionHold`** | **CLEARED (RUN)** | Was dirty-marker hold on prior PID; cleared on PID **33604** via in-process MATCH id **585** (`checkedAt` 2026-08-20T15:01:56Z) |
| 2 | **Dual Argus writers (DEF-18)** | **MITIGATED (RUN)** | Orphan `server.ts` + extra `argus-engine` SIGTERM'd; single headless listener **33604** |
| 3 | **Autobot DISABLED** | **RUN** (intentional) | Left OFF after hold clear — operator must still choose ON |
| 4 | **Organic paper soak = 0** | **NOT VERIFIED** | Closed FILLED SELL P&L / 30 trades · 10 sessions · 30 days unmet — not edge evidence |
| 5 | **LIVE** | **RUN** `LIVE_NO_GO` | Not a paper unlock; do not arm |

Non-critical / research gaps (do not conflate with Autobot readiness): full calendar-**2024** Historical Evaluation rerun **NOT VERIFIED**; news pipeline fixes are CODE/DATA-VERIFIED but not a soak claim.

---

## Checklist grades (requested)

| Area | Grade | Evidence class |
|---|---|---|
| **Spine** (Chief→Risk→OMS→InternalPaper→fill→trades/fills) | **PASS (TEST)** | `paperSpineInternalPaper.test.ts` + `marketDataToRisk.test.ts` |
| **Kill switch** | **PASS (TEST)** | Spine kill case + `TradingEngine.test.ts` + `RiskEngine` pause/E-stop/SELL rules |
| **Restart / reconciliation** | **PASS (TEST+RUN)** | sessionRecovery + OMS crash recovery; live hold **cleared** on PID 33604 (MATCH 585) |
| **Disconnect (WS)** | **PASS (TEST)** | `wsClientLifecycle.test.ts` 4/4 |
| **Runtime engine / market data** | **PASS (RUN)** hold cleared | Headless PID **33604**: PAPER, `LIVE_NO_GO`, Autobot **DISABLED**, `interruptedSessionHold=false` |
| **AA Full npm test** | **PASS (TEST)** | **FINAL 326 / 2090** (see suite table above); mid-day **301 / 1923** and early **297 / 1880** are historical |
| **AB Lint + build** | **PASS (CODE)** | `npm run lint` exit 0; `npm run build` exit 0 — agent `a009af8c` |

---

## A–Z working checklist

| ID | Item | Grade | Notes |
|---|---|---|---|
| **A** | Paper pipeline E2E (InternalPaper) | **TEST** | CHIEF_APPROVED_IDEA → RiskAgent → RiskEngine → OMS → InternalPaper.placeOrder → tick fill → `trades` FILLED + `fills`; duplicate cumulative fill is fillLedger no-op. |
| **B** | MARKET_DATA → idea → risk (partial spine) | **TEST** | `marketDataToRisk.test.ts` (Technical+News → Chief → Risk approved). OMS fill covered by A. |
| **C** | Consensus floors 0.75 / min 2 | **CODE+TEST** | `tradingSafety.json`; `phase21.invariants.test.ts`. Not lowered. |
| **D** | Kill switch singularity | **TEST** | `TradingEngine` tri-state + audit; toggle cannot set `tradingState`; single `emergency_stop` gate. |
| **E** | BUY blocked after kill / pause | **TEST** | Spine E-stop case; RiskEngine TRADING_PAUSED + EMERGENCY_STOP tests. |
| **F** | SELL rules (Autobot off allows exit; kill blocks all) | **TEST** | RiskEngine: Autobot-off SELL not `AUTOBOT_DISABLED`; pause/E-stop block all sides. |
| **G** | Pause not auto-cleared on restart / recon | **TEST** | `sessionRecovery` + TradingEngine re-init; AutoTradeScheduler does not auto-resume PAUSED. |
| **H** | Dirty / clean session marker | **CODE+TEST+RUN** | `sessionRecovery.loadInterruptedSessionMarker`; hold was **true** on PID 42484 after dirty marker; see § Recon / hold |
| **I** | `reconcileStaleOrders` / `clientOrderId` | **TEST** | `OrderManagement.crashRecovery.test.ts`; OMS `requestId === id` in spine. |
| **J** | No auto-flatten on recon mismatch | **CODE+TEST** | `autoFlattenOnReconciliationMismatch: false`; phase21. |
| **K** | No auto-resume pause | **TEST** | sessionRecovery + AutoTradeScheduler. |
| **L** | Fill uniqueness `(orderId, cumulativeQuantity)` | **TEST** | `fillLedger.test.ts` + spine duplicate no-op. |
| **M** | OMS sole production `placeOrder` | **TEST** | `phase21.invariants.test.ts`. |
| **N** | WS client disconnect safety | **TEST** | `wsClientLifecycle.test.ts` **4/4 PASS**. |
| **O** | 24 risk gates catalog | **CODE+TEST** | `riskGateOrder.json` length 24 in phase21. |
| **P** | `PAPER_TRADING_ONLY` / LIVE arm refuse | **CODE+RUN** | Env + architecture; headless reports `LIVE_NO_GO`. |
| **Q** | CLI login / session | **RUN** (superseded path) | CLI session login **RUN-VERIFIED** earlier (`27f648a2`) against `server.ts`; then superseded by headless engine/CLI (`bf31459d`). Kill-switch CLI vs live desk not forced this pass. |
| **R** | Engine start / health / ready | **RUN** | Headless PAPER **RUN-VERIFIED** PID **33604** — Autobot off, hold cleared. |
| **S** | Alpaca paper market-data | **RUN** (flag true) | Headless report `marketData=true`. Operator should still confirm WS OPEN before expecting `data_freshness` PASS under Autobot. |
| **T** | Reconciliation clean before Autobot | **RUN evidence + CODE fix** | GET recon/status: latest **MATCH**, mismatches **0**, unacked **0**. Hold stayed true (cross-process MATCH / Autobot-gated recon). See § Recon / hold. |
| **U** | Organic paper soak floors | **NOT VERIFIED** | Still unmet historically — **CRITICAL** for edge claims, not for mechanical path. |
| **V** | Historical Evaluation / replay fidelity | **PASS (CODE+TEST)** | decision_evidence additive; 1Day `market_hours` + Technical confidence. Full **2024** year **NOT VERIFIED**. |
| **W** | Full `npm test` green | **PASS (TEST)** | See **AA**. |
| **X** | Build / typecheck | **PASS (CODE)** | See **AB**. |
| **Y** | Second kill switch / second order path | **TEST FAIL-CLOSED** | Not introduced; invariants still hold. |
| **Z** | Operator pre-flight | **REQUIRED** | Clear recon/hold, confirm `LIVE_NO_GO`, MD WS, **then** Autobot — see Critical blockers. **Do not start Autobot from this audit.** |
| **AA** | Full `npm test` counts | **PASS (TEST)** | **301** files / **1923** tests / **0** failed — this verify pass (~353s). |
| **AB** | `npm run lint` + `npm run build` | **PASS (CODE)** | Both exit **0** — agent `a009af8c`. |
| **AC** | News pipeline (telemetry + boot-start) | **CODE + DATA** | Telemetry asymmetry + boot-start fixes **CODE-VERIFIED**; DB **DATA-VERIFIED**. Not organic soak. |
| **AD** | RiskAgent lifecycle + market_hours clock timeout | **TEST** | In suite (prior session context; counted in AA green). |

---

## Runtime engine / headless PAPER (RUN evidence)

| Field | Value | Grade |
|---|---|---|
| Agent | `bf31459d` | — |
| Mode | Headless PAPER | **RUN** |
| PID | **33604** (supersedes 42484) | **RUN** |
| Trading mode | PAPER | **RUN** |
| Live readiness | `LIVE_NO_GO` | **RUN** |
| Autobot | **DISABLED** | **RUN** |
| marketData | **true** | **RUN** |
| interruptedSessionHold | **false** (cleared) | **RUN** — MATCH id 585 on PID 33604 |
| Engine / CLI | RUN-VERIFIED headless | **RUN** PID **33604** (supersedes 42484) |
| Prior CLI login | `27f648a2` vs `server.ts` | **RUN** then **superseded** by headless |

**Honesty:** Unit/suite green ≠ this RUN. This RUN ≠ Autobot ready or organic edge. Recon/hold root-cause + remediation: § Recon / hold (below).

---

## Recon / hold investigation (2026-08-20 ~10:22–10:35 local)

**Scope:** PAPER only. No LIVE. No kill -9. No RiskEngine bypass. Autobot **not** enabled.

### CODE — what sets `interruptedSessionHold`

| Mechanism | Location | Behavior |
|---|---|---|
| Dirty marker load | `sessionRecovery.loadInterruptedSessionMarker()` at `ArgusCoreBoot` | If prior `data/.argus_runtime_session.json` has `cleanShutdown===false` → `holdNewEntryIdeas=true` |
| Snapshot field | `pipelineAgentSnapshot.interruptedSessionHold` | `!allowsNewEntryIdeas()` |
| Entry gate | `isLiveIdeaGenerationEnabled()` | Autobot on **and** `allowsNewEntryIdeas()` |
| Release | `releaseEntryHoldAfterReconMatch()` on `EVENTS.RECONCILIATION_MATCH` | Clears hold only; **does not** `setTradingState` / resume / enable Autobot |
| Clean marker | `gracefulShutdown` → `markCleanShutdown()` | Next boot: no hold from marker |

Ack endpoints (`POST /api/v1/system/reconciliation/acknowledge`, `POST /api/v1/system/resume`) are **not** the hold release path. Ack = pre-existing FILLED orphans only. Resume = operator unpause after review. Neither invents MATCH.

### RUN — commands used (no secrets printed)

| Command / probe | Result |
|---|---|
| `./argus status` | PID **42484**, PAPER, Autobot **DISABLED**, `System run: false`, `LIVE_NO_GO` |
| `./argus agents` | `interruptedSessionHold: true`, `ideaWorkersArmed: false`, `workersRunning: false` |
| `./argus risk` | `TRADING_ENABLED`, `emergencyStopActive: false`, `LIVE_NO_GO` |
| `GET /api/v1/system/reconciliation/status` | latest id **578** `matches:true` `mismatchCount:0`; `unackedFilledOrphans:[]`; `lastPause:null`; broker READY |
| Process list | **Orphans:** `server.ts` (12664/20288) + second `argus-engine.ts` (**23164**) alongside **42484** on :3000 — dual writers to shared SQLite (DEF-18 class) |

### Root cause

1. Prior session left `cleanShutdown: false` → boot hold on 42484.  
2. With Autobot off, `SystemBootstrap` previously **stopped** PortfolioReconciliation → **no in-process** `RECONCILIATION_MATCH` on 42484.  
3. DB showed MATCH rows (from orphan processes / prior Autobot session). Those events **do not** cross process EventBus → hold stayed true.  
4. `ideaWorkersArmed: false` is expected with Autobot off (separate from hold).

### CODE remediation (this pass) — **CODE+TEST-VERIFIED**

- Start `portfolioReconciliationWorker` at `ArgusCoreBoot` (independent of Autobot), like MarketDataWorker/NewsEngine.  
- Do **not** stop recon on Autobot `SystemBootstrap.stop()`; stop only in `gracefulShutdown` drain.  
- `./argus status` human view surfaces `interruptedSessionHold` / `ideaWorkersArmed`.  
- `./argus doctor` warns when hold is true.  
- Architecture protection test asserts the boot/stop contract (`SystemBootstrap.stop()` body has no `portfolioReconciliationWorker.stop()`; drain does).  
- Focused vitest (verify pass): `architecture.protection` + `enginePid` + `wsClientLifecycle` + `shellCli.protection` — **43/43 PASS**.  
- Full `npm test` (verify pass): **301** files / **1923** tests / **0** failed.

### SAFE operator path (after single writer + code restart)

1. Ensure **one** Argus engine owns `data/argus.db` (SIGTERM orphans; never kill -9).  
2. Prefer clean `./argus stop` then `./argus start --headless` with `PAPER_TRADING_ONLY=true` so `markCleanShutdown` clears the dirty marker **or** wait ~30s for in-process MATCH after boot-start recon.  
3. Confirm: `./argus agents` → `interruptedSessionHold: false`; `GET .../reconciliation/status` → latest `matches:true`, no unacked orphans.  
4. If `tradingState` is `TRADING_PAUSED` from drain: review recon, then existing `POST /api/v1/system/resume` — **not** blind.  
5. Autobot ON only after (3)+(4) and operator intent — **not** done in this remediation.

**Do not:** auto-flatten, blind-ack, invent a hold-clear API, enable Autobot while hold true, LIVE arm.

### Post-remediation RUN (PID 33604)

| Field | Value |
|---|---|
| Mode | headless+engineDaemon+api |
| PID | **33604** |
| Autobot | **DISABLED** |
| interruptedSessionHold | **false** |
| ideaWorkersArmed | false (expected — Autobot off) |
| Latest recon | id **585**, matches **true**, mismatchCount **0**, unacked **0** |
| tradingState | TRADING_ENABLED |
| LIVE | NO-GO |
| doctor | WARNINGS only for Git Bash `kill -0` PID visibility; hold line **CLEAR** |

Autobot **not** enabled (hold cleared + recon clean, but soak/operator intent still required).

---

## A. Paper pipeline (detail)

**Gap closed this pass:** single automated proof of **approved risk → InternalPaper placeOrder → tick fill → persisted fills** without seeding fake fill rows.

**Added:** `src/server/integration/paperSpineInternalPaper.test.ts`

1. Fixture `CHIEF_APPROVED_IDEA` (consensus already decided — avoids AI/Alpaca flake) with cached quote + Autobot/ENABLED + InternalPaper active.  
2. Real RiskAgent → RiskEngine approve → OMS `executeOrder` → `InternalPaperBroker.placeOrder` (PENDING).  
3. Background `BrokerManager.tick` / `MARKET_DATA` fills pending MARKET order (production fill path).  
4. Assert `trades.status=FILLED`, `requestId===id` (clientOrderId contract), `fills` quantity, fillLedger duplicate watermark no-op.  
5. Second case: `EMERGENCY_STOP` → assessment rejected `emergency_stop`, **zero** new trades row.

**Also re-run:** `marketDataToRisk.test.ts` (idea path to approved risk; OMS fill not the focus).

---

## B. Kill switch (detail)

| Claim | Result |
|---|---|
| BUY blocked after EMERGENCY_STOP on real spine | **TEST** |
| TRADING_PAUSED / EMERGENCY_STOP block new trades | **TEST** (`RiskEngine.test.ts`) |
| Autobot-off blocks BUY, not SELL | **TEST** |
| State persists across re-initialize | **TEST** (`TradingEngine.test.ts`) |
| CLI `argus kill-switch` vs running paper engine | **NOT RUN** (Autobot not enabled for demo; hold already blocks entries) |

---

## C. Restart / reconciliation (detail)

| Claim | Result |
|---|---|
| Dirty marker holds new entry ideas until RECONCILIATION_MATCH | **TEST** + **RUN hold still true** on PID 42484 |
| Match does not auto-unpause TRADING_PAUSED | **TEST** |
| `markCleanShutdown` | **TEST** |
| `reconcileStaleOrders` via `getOrderByClientOrderId` | **TEST** |
| `autoFlattenOnReconciliationMismatch === false` | **CODE+TEST** |
| Recon mismatch pauses trading | **TEST** (`PortfolioReconciliation.tradingBlock.test.ts`) |
| Operator recon clean on live desk | **NOT VERIFIED / hold not cleared** |

---

## D. Disconnect safety

`src/server/core/wsClientLifecycle.test.ts`: **4 passed**. Grade: **PASS (TEST)**.

---

## News pipeline (parallel stream)

| Claim | Grade |
|---|---|
| Telemetry asymmetry fix | **CODE-VERIFIED** |
| Boot-start fix | **CODE-VERIFIED** |
| DB state after fixes | **DATA-VERIFIED** |
| Organic news→edge / soak | **NOT VERIFIED** (do not claim) |

---

## AA. Full npm test (testing evidence)

| Metric | Value | Grade |
|---|---|---|
| Command | `npm test` → `vitest run` | — |
| Agent | `a009af8c` | — |
| When | 2026-08-20 ~10:13–10:19 local | — |
| Label | **VERIFY PASS A (historical)** | — |
| Test files | **297 passed / 297** | **PASS (TEST)** |
| Tests | **1880 passed / 1880** | **PASS (TEST)** |
| Failed | **0** | **PASS** |
| Duration | **373.76s** (earlier local re-run after hook-timeout isolation) | — |
| Consensus / safety | Floors **not** lowered | **CODE** |

**Isolation note:** first full run after HE/decision_evidence had 3 `beforeAll` hook timeouts under suite load; mitigated via `hookTimeout` / suite timeouts. Clean re-run and parallel agent `a009af8c` agree: **1880 / 0 failed**.

**Later same-day refresh (not VERIFY PASS A):** **301 files / 1923 tests** after hold/recon Autobot-independence work — keep separate from 297/1880.

Includes prior RiskAgent lifecycle + market_hours `AbortSignal.timeout` work (already in suite).

---

## AB. Lint / build (compile evidence)

| Command | Result | Grade | Agent |
|---|---|---|---|
| `npm run lint` (`tsc --noEmit`) | **exit 0** | **PASS (CODE)** | `a009af8c` |
| `npm run build` (Vite SPA + esbuild `dist/server.cjs`) | **exit 0** | **PASS (CODE)** | `a009af8c` |

---

## Test Results (this pass)

```
# Focused HE / decision_evidence (earlier today)
npx vitest run decisionEvidence.test.ts replayTechnicalEvaluation.test.ts missedOpportunityArchitecture.test.ts
→ 13 passed
npx vitest run RiskEngine.test.ts -t "market_hours in replay mode"
→ 4 passed
npx vitest run phase18.fullReplay.test.ts -t "golden replay completes"
→ 1 passed (BUY+SELL fills; decision_evidence.json + floors 0.75/2 asserted)
npx vitest run replayStore.test.ts
→ 11 passed

# Full suite (authoritative for AA) — agent a009af8c
npm test
→ Test Files  297 passed (297)
→ Tests       1880 passed (1880)

# Headless PAPER RUN-VERIFY — agent bf31459d
→ PID 42484; PAPER; LIVE_NO_GO; Autobot DISABLED; marketData true; interruptedSessionHold true
```

---

## Files changed (this pass / related)

| File | Change |
|---|---|
| `src/server/integration/paperSpineInternalPaper.test.ts` | **NEW** — paper spine + kill BUY block |
| `src/server/research/phase21.invariants.test.ts` | Assert autoFlatten false + consensus 0.75 / min 2 |
| `src/server/replay/decisionEvidence.ts` | **NEW** — additive votes/gates/MFE-MAE evidence |
| `src/server/replay/decisionEvidence.test.ts` | **NEW** — consensus fidelity + enrich architecture |
| `src/server/replay/FullArgusReplayEngine.ts` | Persist `decision_evidence.json`; aiMode honesty; gate snapshots |
| `src/server/replay/ReplayContext.ts` | `decisionEvidence` session field |
| `config/replaySafety.json` / `replaySafety.ts` | `aiModeHonestyDescription` |
| `src/server/replay/replayStore.ts` (+ test) | Export decision_evidence + rejectionGate CSV |
| `src/server/replay/phase18.fullReplay.test.ts` | Assert decision evidence + floors on golden run |
| `ARGUS_HISTORICAL_EVALUATION.md` | Consensus / aiMode / evidence docs |
| `vitest.config.ts` | `hookTimeout: 60_000` (suite-load isolation) |
| `RiskEngine.restrictedLive.test.ts` | `{ timeout: 60000 }` + `beforeAll(..., 60_000)` |
| `LiveStrategyPerformance.test.ts` | same |
| `paperReadiness.security.test.ts` | same on DB bootstrap suite |
| News pipeline (telemetry asymmetry + boot-start) | **CODE-VERIFIED** (parallel stream); DB **DATA-VERIFIED** |
| `ARGUS_TODAY_PAPER_READINESS_AUDIT.md` | Honesty refresh: headless RUN + critical blockers |

**Do not commit** (per request). No Autobot start. No trading-code changes in this refresh.

---

## Remaining risks / operator actions

1. ~~**CRITICAL:** Clear `interruptedSessionHold`~~ — **CLEARED (RUN)** on PID **33604** via in-process MATCH id **585**. Do not re-introduce Autobot-gated recon stop.  
2. Confirm `GET /api/v2/live-readiness` stays `LIVE_NO_GO` (already RUN on PID **33604**).  
3. Confirm Alpaca **paper** MD WS OPEN before expecting `data_freshness` PASS under load.  
4. **Remaining operator choice:** Autobot ON only after hold cleared and recon understood — **not** enabled from this audit.  
5. Do not treat InternalPaper TEST spine or headless RUN as organic Alpaca soak evidence (soak still **0**).  
6. Historical Evaluation: golden/fixture path is evidence; full **2024** year rerun remains **NOT VERIFIED**.  
7. News CODE/DATA fixes ≠ trading frequency unlock.

---

## Historical Evaluation / prediction-vs-outcome (this pass)

Consensus floors **unchanged**: 0.75 / min 2 agents. No RiskEngine/OMS bypass.

| Claim | Grade | Evidence |
|---|---|---|
| 1Day `market_hours` midnight-ET fail-open for daily bars only | **CODE+TEST** | `RiskEngine.isDailyReplayFrequency` + tests |
| TechnicalAgent replay uses live `technicalSignal.ts` confidence [0.55,0.95]; no Quant-side mirroring | **CODE+TEST** | `replayTechnicalEvaluation.ts` + tests |
| AI_DISABLED cannot approve with Quant alone | **CODE+TEST** | `decisionEvidence.test.ts` |
| `aiMode` LIVE/RECORDED labeled but unwired (honest) | **CODE** | `replaySafety.aiModeHonestyDescription` |
| Additive decision evidence: votes, gates, forward MFE/MAE | **CODE+TEST** | `decisionEvidence.ts` → `decision_evidence.json` |
| Full calendar-2024 Alpaca zero-trade rerun after fixes | **NOT VERIFIED** | Separate RUN required |

**Do not commit** (per request). No LIVE.

---

## Prior pass carry-forward (still valid unless contradicted)

Earlier today: `/api/v1/pnl/analytics` double-response race fixed; replay TechnicalAgent fidelity fixed; RiskAgent lifecycle + clock timeout in suite; full suite **1880/1880** (AA). Mid-pass claim that runtime engine was **NOT VERIFIED** is **superseded** by headless PID **42484** RUN-VERIFY — with Autobot off and `interruptedSessionHold` still true.
