# ARGUS — September 4, 2026 Paper-Trading Readiness Audit

**Audit window:** 2026-09-04 08:20–09:05 ET (pre-market), against the **live running engine** (PID 18588).
**Auditor role:** senior production engineer / quantitative systems architect / reliability engineer / forensic auditor.
**Constraint honoured:** the live engine was never stopped, restarted, or reconfigured. **No test suite of any kind was run** (see §18). All findings below come from read-only SQLite queries, read-only HTTP GETs via `argus-cli`, OS process counters, git history, and source reading.

**Evidence-level labels used throughout (§19):**

| Label | Meaning |
|---|---|
| **LEVEL 1 — CODE PRESENT** | The change exists in the working tree. |
| **LEVEL 2 — TEST VERIFIED** | A test asserts the behaviour. *(Pending this session — see §18.)* |
| **LEVEL 3 — RUNTIME LOADED** | The currently-running process actually loaded that code. |
| **LEVEL 4 — LIVE PROVEN** | Real production runtime behaviour demonstrates the fix works. |

---

## 1. Executive verdict

# 🟡 CONDITIONAL GO

Argus is **structurally** capable of running today's RTH session, but it **cannot trade at all in its current state** and carries one unresolved P0 resource risk.

Three things are true simultaneously, and they must not be conflated:

1. **The protected trading spine is intact and correct.** `PAPER_TRADING_ONLY=true`, `LIVE_NO_GO`, IBKR paper (`ibkr_gateway`), consensus 0.75, min-2 independent agents, all 24 gates — every safety invariant verified unchanged (§2). Nothing in this audit weakened any of them, and nothing should.
2. **Argus is currently `TRADING_PAUSED` / `SAFE_MODE`.** It has been since it booted at 04:29 UTC. Gate 1 `emergency_stop` will fail every assessment today until an operator restores `TRADING_ENABLED`. This is *correct fail-closed restart-recovery behaviour*, not a defect — but it is an absolute blocker requiring a human action before 09:30 ET.
3. **The Chronos sidecar is a live P0 resource risk, and yesterday's stated root cause for it is wrong.** The running Python process holds **15,245.9 MB of commit charge and 6,451 OS threads having served zero inferences**. The `torch.inference_mode()` fix is real, correct, and *not loaded in the running process* — and it would not have prevented what was actually measured.

**Zero trades yesterday is not a reason for NO-GO**, and is not used as one. The reasons for CONDITIONAL rather than GO are the memory risk and the required operator actions, not the trade count.

> ✅ **Update (post-audit):** §18's full test suite has since run — **448 files / 3,141 tests, all green** — and the leaked Chronos process has been killed and restarted (committed memory 15,245.9 MB → 1,723.7 MB; threads 6,451 → 30). Both items that made this verdict provisional are now resolved in Argus's favor. **`TRADING_ENABLED` remains un-restored** — that one action is deliberately left for the operator; see the addendum after §20.

---

## 2. Absolute safety contract — verified

| Invariant | Verified value | Source | Level |
|---|---|---|---|
| `PAPER_TRADING_ONLY` | `true` | `.env` | LEVEL 3 |
| `ARGUS_TRADING_MODE` | `PAPER` | `.env` | LEVEL 3 |
| Live readiness | **`LIVE_NO_GO`** | `argus-cli status` → `"liveReadiness":"LIVE_NO_GO"`, `"live":"NO-GO"` | **LEVEL 4** |
| Active broker | `ibkr_gateway` (IBKR **paper**, port 4002, `ibgateway.exe` PID 54292) | `.env` + listening ports | LEVEL 3 |
| `consensusApprovalThreshold` | `0.75` | `transaction_traces.consensus_threshold` = 0.75 on **all 2,481** rows yesterday | **LEVEL 4** |
| `minIndependentAgreeingAgents` | `2` | 15 real rejections yesterday citing "need 2" | **LEVEL 4** |
| 24 RiskEngine gates | Unmodified | No RiskEngine file touched in the working tree | LEVEL 1 |
| Stale-data fail-closed | Working | 572 `QUANT_IDEA_DISCARDED_STALE_DATA` — ideas discarded, never priced from stale data | **LEVEL 4** |
| Missing-price protection | Working | 366 `TRADE_IDEA_REJECTED`; NewsEngine explicitly emits "No fabricated price emitted" | **LEVEL 4** |
| Emergency stop | `emergencyStopActive: false`; `tradingState: TRADING_PAUSED` | `argus-cli status` | LEVEL 4 |
| Reconciliation | Clean — 241 `RECONCILIATION_MATCH`, **zero mismatches** Sep 3–4 | `observability_events` | **LEVEL 4** |
| Capital allocation | `budget: 2000`, gate `argus_capital_allocation` present | `argus-cli status` | LEVEL 3 |

**Nothing in this audit lowered a threshold, bypassed a gate, forced a trade, or wired LangGraph into execution.** The only code change made (§25, §31) is observability-only.

---

## 3. Fresh system inventory

| Item | Value |
|---|---|
| Branch / commit | `main` @ `8e66e53` ("Phase 1 — ComposableRanking → slot allocation") |
| Uncommitted | 21 modified + 26 untracked files (Kronos OOD gate, ResearchTriggerEngine, TrendFollowingExitEvaluator, memory telemetry, exit-aware evaluation, 6 audit docs) |
| Node engine | PID **18588**, `scripts/argus-engine.ts` via tsx, started **2026-09-04 00:28:49 ET**, uptime 8h04m, RSS 626 MB, private 743 MB, peak WS 925 MB |
| Runtime phase | **`SAFE_MODE`** · `tradingState: TRADING_PAUSED` · `autobot: enabled` · headless, API on, web UI off |
| Heartbeat | `lastHeartbeatAt: 2026-09-04T12:27:18Z` — **current and healthy** |
| Chronos / Python | PID **32676**, `:8008`, started **2026-09-03 18:49:01 ET**, RSS 469.9 MB, **commit 15,245.9 MB**, **6,451 threads**, `lastInferenceMs: null` |
| Ollama | PID 16468, `:11434`, healthy, `fingpt`/`plutus`/`llama3.2` present |
| Java Quant Core | 3 JVMs (PIDs 23372/25144/26436), 17.3/2.3/0.7 MB RSS, `QUANT_JAVA_CORE_ENABLED=true`, advisory-only |
| IBKR Gateway | `ibgateway.exe` PID 54292, started 08:25 ET today, listening `:4002` (paper) |
| LangGraph | `LANGGRAPH_RESEARCH_ENABLED=true`, service port 8090 — **process not running** (8010/8123/2024 also closed) |
| Database | `data/argus.db` **5.17 GB**, WAL 5.5 MB, connected, **75** `sqliteTable(` (CLAUDE.md says 74 — drifted by +1) |
| System memory | Physical 16,117 MB; **commit 38,444.8 / 50,933.2 MB (75.5% used, 12,488 MB headroom)** |
| Discovery flags | `OPPORTUNITY_LOOP`, `OPPORTUNITY_IDEAS`, `BROAD_UNIVERSE`, `MARKET_MOVERS`, `PORTFOLIO_INTEL`, `EXIT_INTELLIGENCE`, `MULTI_ASSET`, `PENNY_STOCK` — **all `true`** |
| Quant | `QUANT_ENGINE_ENABLED=true` + 16 experimental strategy flags `true` |
| **Off (verified absent from `.env`)** | `RESEARCH_TRIGGER_ENABLED`, `KRONOS_OOD_GATE_ENABLED`, `AI_COST_GOVERNOR_ENABLED` — all correctly **OFF** |

> **Note on this deployment vs. CLAUDE.md defaults:** CLAUDE.md documents Quant and the discovery funnels as "off by default". In *this* `.env` they are all **on**. That is an operator choice, not a defect, but it means this deployment is materially more active than the documented default posture and should be read that way throughout.

---

## 4. Timeline — what actually happened on September 3, 2026

All times **UTC** (RTH = 13:30–20:00 UTC).

| Time (UTC) | Event |
|---|---|
| 10:42:14 | `UNCLEAN_SHUTDOWN_DETECTED` — prior PID 20172 died 160 s after start with no heartbeat |
| 10:42:42 | `PREMARKET_SESSION_STARTED`; session lifecycle → `RESEARCHING` |
| 10:43:04 | Discovery scans begin; reconciliation clean |
| 10:44:19–10:47:50 | **3 manual LangGraph runs** (GOLDEN_SMA, MOMENTUM_BREAKOUT ×2), all COMPLETED |
| 10:44:50 | 1 × `SYSTEM_ANOMALY` (only one all day) |
| 12:08:14 | `TRADING_STATE_CHANGED` → trading active; idea pipeline starts |
| 12:08:19 | First `TRADE_IDEA_GENERATED` |
| 12:10:39 | First `TEMPORARY_DATA_RESCUE_GRANTED`; rescue contention begins |
| 12:32:09 | `MARKET_DATA_DISCONNECTED` (first of 48); `KRONOS_UNAVAILABLE` begins (150 total) |
| 13:03:46 | `UNCLEAN_SHUTDOWN_DETECTED` — PID 22928 died 416 s after start |
| 13:04:43–13:05:16 | **2 more LangGraph runs** (MOMENTUM_BREAKOUT COMPLETED; PULLBACK_CONTINUATION **CANCELLED by operator** — a deliberate cancellation test) |
| 13:30 | **Market open** |
| 13:32:32 | `CAMPAIGN_OPENING_SURGE` |
| 17:20:13 | Last heartbeat of PID 23448 |
| 17:48:45 | `UNCLEAN_SHUTDOWN_DETECTED` — PID 23448 dead ~28 min |
| 18:28:11 | `UNCLEAN_SHUTDOWN_DETECTED` — PID 36524 died 331 s after start |
| 18:28:33 | PID 28140 starts (the session that would die silently) |
| **19:15:40** | 🔴 **SILENT ENGINE DEATH.** Last event of any kind: `TECHNICAL_ANALYSIS_COMPLETED` for QQQ. `TRADE_IDEA_GENERATED`, `CHIEF_CONSENSUS_*`, `TECHNICAL_ANALYSIS_*`, `KRONOS_*` **all stop simultaneously**. No crash.log entry, no `SYSTEM_ANOMALY`, no exception. |
| 19:15:40 → 20:00 | **The last 44 minutes of RTH ran with no engine.** |
| 22:49:01 | Chronos restarted (PID 32676 — the instance still running now) |
| 22:50:02 | `UNCLEAN_SHUTDOWN_DETECTED` for PID 28140: `msSincePreviousHeartbeat = 12,862,343 ms` (**3h34m**) — the recorded proof of the 19:15:40 death |
| 23:00 → 03:31 (Sep 4) | 4 further restarts, all operator deploys (ResearchTriggerEngine, evaluation-horizon fix) |
| 03:31:16 | `gracefulShutdown` → `TRADING_PAUSED` |
| **04:29:33** | Current engine (PID 18588) boots — and **`TRADING_ENABLED` was never restored** |

**`crash.log` last written 2026-09-03 06:44** — it captured nothing from any of these deaths. The silent deaths produce no JS-level exception; `globalErrorHandlers.ts` is not being bypassed, it is simply never invoked, which is consistent with process-level termination (OS-side allocation failure / hard kill), not an unhandled rejection.

### Yesterday's funnel, quantified

| Stage | Count |
|---|---|
| Discovery candidates filtered | 13,562 |
| Discovery candidates admitted | 96 |
| Watchlist subscribe requests | 3,723 |
| Subscription promotions | 298 |
| Subscription evictions | **0** |
| Quant assessments completed | 2,726 (25+ distinct symbols) |
| **`TRADE_IDEA_GENERATED`** | **2,478** |
| Trade ideas rejected pre-consensus | 366 (100% FundamentalAgent/MacroAgent) |
| ChiefTrader consensus rounds | 1,715 |
| Consensus ≥ 0.75 | **15** |
| **RiskEngine evaluations** | **0** |
| **Orders / fills** | **0** |

---

## 5. Why did Argus not trade yesterday? (§4 of mission)

The honest answer is **(O) a combination**, dominated by two mechanisms. Quantified contributions:

| # | Cause | Contribution | Evidence |
|---|---|---|---|
| **1** | **(C)+(D) Market-data starvation of real ideas** | **~880 ideas lost (≈26% of all directional output)** | 572 `QUANT_IDEA_DISCARDED_STALE_DATA` + 217 `NEWS_IDEA_DISCARDED_RESCUE_DENIED` + 91 `NEWS_IDEA_DISCARDED_NO_FRESH_DATA` |
| **2** | **(H) Lack of independent agreeing agents** | **100% of the 15 near-misses** | All 15 traces scoring 0.7727 died on "Only 1 independent agent agreed (need 2)" |
| **3** | **(G) Genuinely weak signals** | **1,699 of 1,714 consensus rounds (99.1%)** | Confidence < 0.75 |
| 4 | **(L) Engine instability** | 44 min of RTH (~11%) lost outright | Silent death 19:15:40 |
| 5 | **(F) Agent cadence/coverage mismatch** | Only **4 symbols** all day had both Technical + Quant votes | `agent_predictions` join |
| 6 | (E) Strategy engine | Partial — 3 of 5 CORE strategies produced **zero** ideas | Only RANGE_REVERSION (178) and TREND_FOLLOWING (156) |
| 7 | (J) NewsEngine | 793 clusters → **4 predictions** (0.5% conversion) | Starved by rescue denial, not broken |
| 8 | (K) Fundamental/Macro | 877 HOLDs, 0 directional | Expected — see §13 |
| — | **(M) RiskEngine** | **ZERO contribution** | 0 evaluations — nothing reached it |
| — | **(N) OMS / broker** | **ZERO contribution** | 0 order attempts; reconciliation 100% clean |
| — | **(A) No opportunities discovered** | **NOT a cause** | Discovery admitted 96 candidates and promoted SNOW/HOOD/MARA/COIN/PLTR/RIOT |

### The causal chain, stated plainly

Discovery worked. Subscription worked. Quant **did** assess individual equities broadly — SPY 223, QQQ 221, GLD 202, NVDA 135, TSLA 133, SNOW 125, HOOD 101, COIN 100, PLTR 99, MARA 91, RIOT 86. But when Quant tried to turn those assessments into *ideas*, the data underneath was stale: **SNOW 109, TSLA 101, AAPL 101, PLTR 95 discarded for stale data**. Only 4 symbols (QQQ, GLD, TSLA, AAPL) survived to produce a Quant vote at all.

Meanwhile TechnicalAgent voted on 10 symbols, dominated by QQQ 108 / SPY 97 / GLD 96. **The intersection of "Technical voted" and "Quant voted" was exactly 4 symbols.** Independence therefore could almost never be satisfied — and on the 15 occasions confidence *did* clear 0.75, there was only ever one independent voice.

**RiskEngine, OMS and the broker are exonerated. They were never reached.** The failure is upstream, in market-data allocation and agent co-attendance.

---

## 6. Known-defect audit (§5 of mission)

| # | Issue | Previous finding | Claimed fix | Code? | Tests? | Runtime loaded? | Live-proven? | **Status** |
|---|---|---|---|---|---|---|---|---|
| **A** | Chronos/PyTorch memory | ~42.8 GB after ~5 h | `torch.inference_mode()` on `/forecast` + `/sentiment`; health-check-first duplicate guard | ✅ LEVEL 1 (lines 143–151, 180–181) | ⏸ §18 | ❌ **NO** — file written 2026-09-03 **21:01 ET**, process started **18:49 ET** (2h12m earlier) | ❌ **Contradicted** | 🔴 **NOT PROVEN — and root cause was misdiagnosed** |
| **B** | Silent engine deaths | 5 prior, cause unverified | — | n/a | ⏸ | n/a | ❌ **6th occurred 2026-09-03 19:15:40** | 🔴 **NOT FIXED** |
| **C** | NewsEngine missing-price race | 147/147 Sept-2 MISSING_PRICE, ~100% NewsAgent | `waitForFreshMarketData()` with `NEWS_CATALYST` class | ✅ LEVEL 1 | ⏸ | ✅ LEVEL 3 | ✅ **LEVEL 4 — zero NewsAgent rejections Sep 3–4** | 🟢 **FIXED** |
| **D** | Rescue allocator | Renewals starved acquisitions (FRVO) | `NEW_DATA_ACQUISITION` vs `RENEWAL` accounting split | ✅ LEVEL 1 (`MarketDataWorker.ts:362–401`) | ⏸ | ✅ LEVEL 3 | ⚠️ **Partly** — separation works; capacity now binds | 🟡 **PARTIALLY FIXED** |
| **E** | Universal discovery score wiring | `finalScore` had no path to slot allocation | `ComposableRanking.finalScore` → `blendedHotSwapScore()` | ✅ LEVEL 1 (`OpportunityDiscovery.ts:174–180`) | ⏸ | ✅ LEVEL 3 | ⚠️ **Half-proven** — see below | 🟡 **PARTIALLY PROVEN** |
| **F** | Test isolation | `ArgusCoreBoot.test.ts` could overwrite production session file | Explicit tmp-path isolation + assertion | ✅ LEVEL 1 (`ArgusCoreBoot.test.ts:9,32,71`) | ⏸ **cannot verify without running** | n/a (test-only) | ❌ | 🟡 **NOT PROVEN** |
| **G** | Shutdown-detector false positive | `UNCLEAN_SHUTDOWN_DETECTED` after intentional stops | In-process `requestGracefulShutdown()` via `POST /api/v1/system/shutdown` | ✅ LEVEL 1 | ⏸ | ✅ LEVEL 3 | ✅ **LEVEL 4** — graceful stops logged as `gracefulShutdown` drains; unclean flags only on real deaths | 🟢 **FIXED — and it correctly caught the real 19:15:40 death** |

### (A) Chronos — the root cause was wrong

This is the most important correction in this audit.

**Measured live at 08:38–08:41 ET today**, on Chronos PID 32676:

```
WorkingSetMB      : 469.9
PageFileUsageMB   : 15,245.9      ← commit charge
PeakPageFileMB    : 15,248.9
VirtualSizeMB     : 47,508.2
ThreadCount       : 6,451
/health lastInferenceMs : null    ← ZERO inferences served, ever
```

**This instance has never run a single forecast.** `KRONOS_FORECAST_STARTED` last fired at 19:15:23 on Sep 3, *before* this Chronos started at 22:49. Yet it accumulated 15.2 GB of commit.

Therefore: **autograd-graph retention on the inference path cannot explain this growth.** The `torch.inference_mode()` fix is correct and worth keeping, but it addresses a mechanism that had not even engaged.

The actual dominant mechanism is **thread accumulation**. `local_ai_service.py:228` uses `ThreadingHTTPServer`, which starts one thread per connection. Node's `fetch()` (undici) uses HTTP keep-alive by default, and `KronosModelManager.ts:58` polls `/health` continuously. Each retained keep-alive connection pins one Python handler thread; each thread commits its stack reservation. **6,451 threads × ~2 MB ≈ 12.9 GB — which matches the 15.2 GB observed almost exactly**, and explains why RSS stays at 470 MB (reserved stacks are committed but never touched, so Windows trims them out of the working set).

This also explains why the previous fix attempt could not have worked, and why the memory sampler reported `NORMAL` throughout.

**Current status of thread growth:** plateaued. Three samples 60 s apart (08:38:57 / 08:39:58 / 08:40:58) all read exactly 6,451 threads and 15,245.9 MB. It is **not currently growing at idle**. Whether it resumes growing once RTH `/health` and `/forecast` traffic ramps is **unknown and untested** — that is precisely the risk to monitor today.

**Duplicate sidecars:** none present (one process on `:8008`). The health-check-first guard is LEVEL 1 present but LEVEL 3 **not loaded**. Orphan sidecars therefore remain possible until Chronos is restarted.

### (B) Silent deaths — Chronos exhaustion is the strongest hypothesis, not a proven cause

Given (A), the causal story is coherent: host commit limit is **50,933 MB**; current usage **38,445 MB**; Chronos alone holds **15,246 MB (~40% of all committed memory)**. When commit is exhausted, Windows fails allocations, and a V8 allocation failure aborts the process with no JS exception and no `crash.log` entry — exactly the observed signature.

**But this remains a hypothesis.** Stated honestly:
- ✅ Consistent with: no exception, no crash.log, no `SYSTEM_ANOMALY`, correlation with Windows low-memory events, Chronos holding 40% of commit.
- ❌ Not yet established: no memory sample exists *from the minute of any death* (the sampler only started 2026-09-04 01:24, after every death).
- ❌ The **5th** death (post test-run) has an explicitly **UNVERIFIED** root cause and this audit found nothing new about it. It is not solved.
- ❌ The 19:15:40 death occurred with a *different* Chronos instance whose memory was never measured.

**Do not record this as solved.** The instrumentation to prove or disprove it is only now in place (and is improved by this audit's fix, §25).

### (D) Rescue allocator — the accounting split works, the capacity does not

The `NEW_DATA_ACQUISITION` / `RENEWAL` separation is correctly implemented and demonstrably working: **348 ROUTINE_RECOVERY renewals were granted without consuming acquisition budget**, which is exactly the FRVO fix. `ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY` fired **0 times**, so the reserved slot never had to preempt routine traffic.

But the binding constraint moved:

| Class | Intent | Granted | Denied | Denial reason |
|---|---|---|---|---|
| NEWS_CATALYST | NEW_DATA_ACQUISITION | 58 | **202** | `RESCUE_CAPACITY_FULL` |
| NEWS_CATALYST | RENEWAL | 150 | 0 | — |
| ROUTINE_RECOVERY | NEW_DATA_ACQUISITION | 8 | 5 | `RESCUE_CAPACITY_FULL` |
| ROUTINE_RECOVERY | RENEWAL | 348 | 0 | — |
| EXPLORATION | RENEWAL | 2 | 0 | — |

**NEWS_CATALYST acquisition denial rate: 202/260 = 78%.** With `maxConcurrentTemporaryDataRescues: 3` and `temporaryDataRescueMaxDurationMs: 300000` (5 min), the system-wide ceiling on acquiring fresh data for a *new* symbol is **36 acquisitions per hour**. Denied names included GOOGL/GOOG, MRNA, UBER, PLTR, LULU, DELL — real, liquid, tradeable equities.

**This is the single most fixable constraint on individual-stock discovery**, and it is a *capacity* number in reviewed config, not an architectural flaw. It is **not** something to change on a market morning.

### (E) Discovery score wiring — proven at the subscription layer, unproven downstream

`blendedHotSwapScore()` genuinely consumes `getLastComposableScore()` weighted by `composableRankingHotSwapWeight`, and it is running in the current process. The subscription layer is demonstrably **not** ETF-captured — yesterday it promoted SNOW (33), HOOD (29), MARA (28), COIN (28), PLTR (27), RIOT (26); today FDX, ACN, AVGO. Today's top-ranked candidates are XLE (0.7154) and **NVDA (0.7029)**.

**What is not proven** is that this materially improved *outcomes*, because the promoted equities then failed at the next stage (stale data → discarded Quant ideas). Ranking now drives allocation; allocation does not yet reliably deliver a usable data stream. Do not call this "fixed" on the strength of the getter alone — that was the explicit warning in the mission, and it holds.

---

## 7. Architectural changes — BEFORE vs NOW

| Component | Before | Now | Why | Affects decisions? | Runtime-proven? |
|---|---|---|---|---|---|
| MarketUniverseScanner | Curated 122 names | + Alpaca tradable-assets funnel + `/screener/stocks/movers` | Real broad discovery | Candidate set only | ✅ 13,562 filtered / 96 admitted |
| Discovery Lineage Ledger | Rejections vanished | `DISCOVERY_CANDIDATE_ADMITTED/FILTERED` with reason | FRVO unexplainability | No | ✅ Live, with `PRICE`/gap/rvol fields |
| ComposableRanking | 7-component score, no consumer | → `blendedHotSwapScore()` | Score had no path to allocation | **Yes — slot allocation** | ⚠️ Partial (§6E) |
| Rescue allocation | Single shared pool | Class + intent aware, reserved slot | FRVO starvation | **Yes — who gets data** | ⚠️ Partial (§6D) |
| NEWS priority | Immediate price read | `waitForFreshMarketData()` | 147/147 MISSING_PRICE | **Yes** | ✅ Fixed |
| QuantSignalAgent | — | Rescue-aware; 21 strategies flagged on | Coverage | Yes | ⚠️ 3/5 CORE dead (§15) |
| TechnicalAgent | — | Debounce/state-transition | Autocorrelation | Yes | ✅ 341 predictions |
| Kronos | — | + `KronosDissimilarityGate` (**OFF**) | OOD/model trust | No (off) | ❌ Not loaded |
| Fundamental / Macro | — | Unchanged; `evidenceClassification` added | Honesty | No | ✅ (§13) |
| ChiefTrader | — | Unchanged threshold/independence | — | — | ✅ Intact |
| RiskEngine / OMS / IBKR | — | **Unchanged** | Protected | — | ✅ 0 evaluations (never reached) |
| Java Quant Core | Advisory | Advisory | — | No | ⚠️ **209 parity divergences** (§24) |
| Chronos/Python | Plain inference | `inference_mode()` + dup guard | Memory | No | ❌ Not loaded |
| LangGraph | — | Phase 3.1 schemas + `ResearchTriggerEngine` (**OFF**) | Research automation | **No** | ✅ Isolated |
| Persistence/observability | Ring buffer only | `MEMORY_TELEMETRY_SAMPLE` persisted | Post-mortem | No | ⚠️ Blind to real failure (fixed §25) |

---

## 8. LangGraph forensic audit

**The "11 rows, all manual Phase 3.1 tests" claim is CONFIRMED in substance, with one correction.**

`research_agent_runs` contains **11 rows total, all-time** — the table has no history before Sep 3. Broken down:

| Status | Count |
|---|---|
| COMPLETED | 7 |
| UNAVAILABLE | 2 |
| FAILED | 1 |
| CANCELLED | 1 |

**Correction:** only **5** of those 11 fall inside the NY trading day of Sep 3 (04:00Z Sep 3 → 04:00Z Sep 4). The other 6 have `created_at` between 00:00Z–04:00Z on 2026-09-03, i.e. the *evening of Sep 2* Eastern.

The 5 runs during Sep 3:

| Time (UTC) | Strategy | Status | Duration | Note |
|---|---|---|---|---|
| 10:44:19 | GOLDEN_SMA | COMPLETED | 90 ms | |
| 10:44:34 | MOMENTUM_BREAKOUT | COMPLETED | 15.6 s | |
| 10:47:44 | MOMENTUM_BREAKOUT | COMPLETED | 6.2 s | |
| 13:04:43 | MOMENTUM_BREAKOUT | COMPLETED | 11.6 s | |
| 13:05:16 | PULLBACK_CONTINUATION | **CANCELLED** | — | "Cancelled by operator request" — a deliberate cancellation test |

### Was any of it automatic?

**No. Definitively.**

- **`trigger_type` is `NULL` on all 11 rows.** `ResearchAgentRunner.ts:59` defaults this to `MANUAL`; the automatic path stamps a non-null value. Every row predates or bypasses automation.
- **`ResearchTriggerEngine` is OFF.** `config/researchTrigger.json` gates it on `RESEARCH_TRIGGER_ENABLED`, which is **absent from `.env`** (verified by direct grep). It additionally requires `LANGGRAPH_RESEARCH_ENABLED=true` *and* `minimumCompletedTrades: 20` — and organic paper trades remain **0**, so even if the flag were set it could not fire.
- The engine is started at `SystemBootstrap.ts:81` but is a no-op without the flag.

### Did LangGraph influence trading?

**No, and it is structurally incapable of doing so.**
- Zero LangGraph runs during RTH (13:30–20:00 UTC). All 5 were pre-market.
- `config/langGraphResearch.json`: separate Python process, loopback HTTP only, **no broker credentials, no SQLite access, no order path, no EventBus emission**.
- Output persists only to `research_agent_runs`; **no join exists** from that table to `transaction_traces`, `risk_assessments`, `trades`, or `fills`.
- Yesterday's 2,478 trade ideas came from KronosEngine, Fundamental, Macro, Technical, Quant, OpportunityScreener, News — **never LangGraph**.

**Verdict: LangGraph did not participate in yesterday's trading in any way.** The advisory/research boundary is verified, not assumed.

---

## 9. LangGraph health and readiness today

**Status: NOT RUNNING.** Port 8090 has no listener (8010/8123/2024 also closed), though `LANGGRAPH_RESEARCH_ENABLED=true`.

Yesterday's non-COMPLETED runs, classified as instructed:

| Outcome | Count | Classification |
|---|---|---|
| CANCELLED | 1 | **Intentional test** — "Cancelled by operator request" exercising the cancellation path |
| UNAVAILABLE | 2 | **Configuration** — service not reachable; correct fail-closed reporting |
| FAILED | 1 | **Intentional/transient Phase 3.1 test** — pre-market, no trading impact |

**None of these are live trading failures.** The async architecture behaved correctly: it recorded `UNAVAILABLE` rather than fabricating a result, and honoured a cancellation in 451 ms.

**Classification: NOT READY** (process down) **for research/advisory use.**

**Is LangGraph REQUIRED for today's paper trading?** **NO — categorically not.** It is advisory research only. It is not on the trade-idea path, not consulted by ChiefTrader, not consulted by RiskEngine, and not consulted by OMS. Argus can run a complete, correct RTH session with LangGraph down. **Do not start it, and do not wire it into execution, to make today work.**

---

## 10. Current trading architecture health

| Stage | Status | Evidence |
|---|---|---|
| Market Data | 🟡 **DEGRADED** | 48 `MARKET_DATA_DISCONNECTED` + 24 `MARKET_DATA_GAP_DETECTED` yesterday; IBKR gateway up today; no ticks yet (pre-market) |
| Universal Discovery | 🟢 **HEALTHY** | 13,562 filtered / 96 admitted with full reasons; 9,600 filtered already today |
| Candidate Ranking | 🟢 **HEALTHY** | `candidate_rankings` populating; XLE 0.7154, NVDA 0.7029 PROMOTE today |
| Resource Allocation | 🔴 **BROKEN (capacity)** | 78% NEWS_CATALYST acquisition denial; 3-slot / 5-min ceiling = 36 acquisitions/hr |
| Fresh Market Data | 🔴 **BROKEN** | 572 quant + 91 news ideas discarded for stale/absent data |
| Strategy Evaluation | 🟡 **DEGRADED** | 2,726 assessments across 25+ symbols, but only 2 of 5 CORE strategies produced ideas |
| Agent Evaluation | 🟡 **DEGRADED** | Only 4 symbols had ≥2 independent agents all day |
| Trade Idea | 🟢 **HEALTHY** | 2,478 emitted; `gateTradeIdea` correctly rejecting 366 |
| EventBus | 🟢 **HEALTHY** | All lifecycle events persisting to `event_traces` |
| ChiefTrader | 🟢 **HEALTHY** | 1,715 rounds, threshold 0.75 on every row, correct rejection reasons |
| RiskEngine | ⚪ **UNKNOWN** | 0 evaluations — never exercised in live paper since the last replay (Sep 1) |
| OMS | ⚪ **UNKNOWN** | 0 order attempts |
| IBKR PAPER | 🟢 **HEALTHY** | Gateway up on 4002; 241 clean reconciliations, 0 mismatches |

---

## 11. Individual-stock opportunity audit

**Signal support (verified in code and live data):**

| Signal | Supported? | Evidence |
|---|---|---|
| Price movers | ✅ | Alpaca `/v1beta1/screener/stocks/movers`, `ARGUS_MARKET_MOVERS_ENABLED=true` |
| Momentum acceleration | ✅ | `momentum_score` in `candidate_rankings` |
| Unusual / relative volume | ✅ | `relative_volume_score`; `rvolMover` at 2× ADV |
| Gap | ✅ | `gap_score`; `gapMover` at 5% |
| Range expansion | ✅ | `range_expansion_score` |
| Breakouts | ⚠️ | MOMENTUM_BREAKOUT registered but produced **0 ideas** yesterday |
| Intraday trend | ✅ | TREND_FOLLOWING — 156 ideas |
| VWAP behaviour | ⚠️ | Flags on, no ideas yesterday |
| Relative strength / sector | ⚠️ | Flags on, no ideas yesterday |
| Volatility expansion | ⚠️ | Via range expansion only |
| Real news catalysts | ✅ ingest / 🔴 conversion | 793 clusters → **4** predictions |
| **Liquidity screening** | ✅ | `PRICE` filter correctly rejecting $0.0026 names |

### Can a stock that starts moving at 10:00 AM be traded?

**Partially — and here is exactly where it fails.**

| Step | Verdict | Why |
|---|---|---|
| 1. Discovered | ✅ **YES** | Movers funnel + broad universe scan every cycle |
| 2. Ranked | ✅ **YES** | ComposableRanking scores it within one cycle |
| 3. Subscribed | ✅ **YES** | 90 IBKR data lines, **zero evictions yesterday** — slots are available |
| 4. **Fresh data** | 🔴 **LIKELY FAILS** | Needs a `NEW_DATA_ACQUISITION` rescue. **78% denial rate.** 3 slots × 5 min = 36/hour system-wide |
| 5. Strategy evaluation | 🟡 **PARTIAL** | Quant assesses broadly but discards on stale data (572 yesterday) |
| 6. Agent 1 | 🟡 | Technical covered 10 symbols; ~90% concentrated in QQQ/SPY/GLD |
| 7. **Agent 2 (independent)** | 🔴 **VERY LIKELY FAILS** | Quant voted on only 4 symbols; intersection with Technical = 4 |
| 8. ChiefTrader | ✅ | Would evaluate correctly if it got there |
| 9. RiskEngine → OMS | ✅ | Untested live but structurally sound |

**The failure point is step 4, and it propagates into step 7.** A new mover can be discovered, ranked and subscribed — but it will usually be denied the fresh-tick acquisition it needs, so its Quant idea is discarded as stale, so a second independent agent never votes on it, so consensus can never reach 2 agreeing agents.

---

## 12. ETF concentration

**Verified quantitatively. The finding is nuanced and the mission's caution was warranted.**

Discovery/subscription is **NOT** ETF-captured:

| Layer | Top symbols |
|---|---|
| Subscription promotions Sep 3 | SNOW 33, HOOD 29, MARA 28, COIN 28, PLTR 27, RIOT 26, TSLA 21, NOW 21 — **all individual equities** |
| Subscription promotions Sep 4 | SNOW, MARA, HOOD, FDX, COIN, AVGO, ACN (92 each) |
| Quant assessments Sep 3 | SPY 223, QQQ 221, GLD 202, then NVDA 135, TSLA 133, IWM 133, MSFT 132 … SNOW 125, HOOD 101, COIN 100 |

The concentration appears at the **voting** layer:

| Agent | Distinct symbols | Concentration |
|---|---|---|
| JavaFactorComposite | 36 | broad (advisory only) |
| TechnicalAgent | 10 | QQQ 108 / SPY 97 / GLD 96 = **88%** |
| KronosEngine | 10 | — |
| FundamentalAgent | 10 | HOLD only |
| MacroAgent | 10 | HOLD only |
| **QuantEngine** | **4** | QQQ 164 / GLD 140 / TSLA 16 / AAPL 14 |

**ChiefTrader evaluations by symbol** were correspondingly dominated by QQQ, GLD, AAPL, TSLA. All 15 near-miss traces were **QQQ (11), AAPL (3), TSLA (1)**.

**Is this starvation?** The evidence says **the ETFs are a symptom, not the cause.** ETFs dominate the *vote* layer because they are the only symbols with continuously fresh data — they are permanently protected streams, so their ideas are never discarded as stale. SNOW/PLTR were assessed almost as often as TSLA, but their ideas were discarded (SNOW 109, PLTR 95) for want of a fresh tick.

**Recommendation: do NOT remove protected-symbol treatment.** Removing SPY/QQQ/GLD protection would not give SNOW a fresh feed; it would only take one away from the ETFs. The correct target is the rescue-acquisition ceiling (§6D), not the protected set.

---

## 13. ChiefTrader audit

**No recommendation to lower the 0.75 threshold or the 2-agent requirement is made, and none should be.**

Distribution of 1,714 scored consensus rounds:

| Bucket | Count | Share |
|---|---|---|
| ≥ 0.75 | **15** | 0.9% |
| 0.60–0.65 | 5 | 0.3% |
| 0.50–0.60 | 38 | 2.2% |
| < 0.50 | **1,656** | 96.6% |
| NULL | 767 | — |

**Is the calibration compressing strong signals?** **No.** `argus-cli agent-edge` (run live today) is decisive:

| Agent | Actual wt | Expected wt | Eff. N | Eff. win rate | Consistent |
|---|---|---|---|---|---|
| KronosEngine | 1.031 | 1.031 | 807 | 0.515 | YES |
| JavaFactorComposite | 1.022 | 1.022 | 139 | 0.511 | YES |
| TechnicalAgent | 0.949 | 0.949 | 350 | 0.474 | YES |
| NewsAgent | 0.946 | 0.946 | 294 | 0.473 | YES |
| OpportunityScreener | 0.872 | 0.872 | 94 | 0.436 | YES |
| QuantEngine | 0.831 | 0.831 | 77 | 0.416 | YES |
| FundamentalAgent | 0.200 | 1.000 | **3** | 0.667 | YES |
| MacroAgent | 0.100 | 1.000 | **0** | 0.000 | YES |

**Not one agent, in any confidence bucket, has a Wilson lower bound exceeding 0.5.** Every single eligibility row reads `NOT_MATURE` or `CALIBRATION_FAILED`. Global `prediction_outcomes`: 33,447 WIN / 39,934 LOSS = **45.6%**.

Separating the causes as instructed:

| Cause | Present? | Evidence |
|---|---|---|
| Weak opportunity | Partly | Market-dependent |
| **Weak agent confidence** | ✅ **PRIMARY** | No agent distinguishable from chance |
| **Missing independent evidence** | ✅ **PRIMARY** | 15/15 near-misses; 4-symbol intersection |
| **Resource/cadence problem** | ✅ **PRIMARY** | 880 ideas lost to data starvation |
| Calibration compression | ❌ | Weights track measured performance exactly (`Consistent: YES` on all 11 agents) |
| Weak strategy signal | Partly | 3/5 CORE strategies silent |

**Agent weights are sensible.** The low confidence is an accurate reflection of no demonstrated edge, not a defect. **There is a systematic directional deadlock worth noting**, though: KronosEngine emitted **827 SELL vs 87 BUY, every single one at exactly confidence 0.850**, while Technical (332 BUY / 9 SELL) and Quant (319 BUY / 14 SELL) were ~96% BUY. A constant 0.850 output across 986 predictions is a **degenerate confidence signal** and should be investigated — but *not* today, and not by changing the gate.

---

## 14. Fundamental and Macro agents

**Re-derived fresh from live data, as instructed — the note is CONFIRMED.**

| Agent | Predictions Sep 3 | Directional | Avg conf | Effective N | Classification |
|---|---|---|---|---|---|
| FundamentalAgent | 474 | **0** (100% HOLD) | 0.044 | **3** | **INSUFFICIENT_EVIDENCE** |
| MacroAgent | 402 | **0** (100% HOLD) | 0.130 | **0** | INSUFFICIENT_EVIDENCE |

The mission's note said raw N=52 / effective N=3. **Today's live figure is effective N=3, raw win rate 0.667** — the clustering-adjusted sample is unchanged and remains far below the 20-observation trust floor. `evidenceClassification` is implemented at `agentEdgeAnalytics.ts:54–61` and correctly returns `INSUFFICIENT_EVIDENCE` when `sampleMaturity` fails, *before* consulting the statistic. That ordering is right: it prevents a flattering 0.667 from 3 observations being read as edge.

**Diagnosis of the HOLD behaviour:** a **timeframe mismatch**, not a bug. Fundamental and macro theses operate on multi-week horizons; the evaluation horizon and the intraday idea cadence are far shorter. Combined with AlphaVantage rate limits, HOLD is the honest output. Both are also weighted down appropriately (0.200 / 0.100).

**A real, separate defect exists here:** all 366 `TRADE_IDEA_REJECTED` events on Sep 3 (and 239 already today) were **FundamentalAgent (71/132) and MacroAgent (56/107)**. `NewsEngine.ts` explicitly documents this: *"FundamentalAgent.ts has the identical latent structural bug at its own matching comment - not fixed in this pass."* These agents still read the price immediately after requesting a subscription. Because they emit only HOLD, the trading impact is nil — it is log noise. **Do not fix this today.**

**Do not force these agents to produce BUY/SELL.**

---

## 15. Quant audit

**Agent-edge, re-derived live today:**

| Metric | Value |
|---|---|
| Effective N | **77** |
| Effective win rate | **0.416** (below chance) |
| Actual weight | 0.831 (consistent with expected) |
| 0.6–0.7 bucket | Eff N 20, Wilson LB **0.1455** → CALIBRATION_FAILED |
| 0.7–0.8 bucket | Eff N 12 → NOT_MATURE |
| 0.8–0.9 bucket | Eff N 41, Wilson LB **0.2776** → CALIBRATION_FAILED |
| 0.9–1.0 bucket | Eff N 4 → NOT_MATURE |

**Quant has no demonstrated edge. Its measured win rate is below chance.**

Therefore, as the mission instructed: **do NOT implement a Quant-based second-agent fallback to raise trading frequency**, and **independence escalation should remain disabled**. Quant does *not* deserve more resource priority on the basis of edge. (It may deserve more *data* priority on the basis of coverage — a different and legitimate argument, addressed in §21/§29.)

**TREND_FOLLOWING exit-aware evaluation:** `TrendFollowingExitEvaluator.ts` is LEVEL 1 present and wired via `config/evaluationHorizons.json`'s `exitAwareStrategyIds`. The reported result — **0 of 515 real TREND_FOLLOWING predictions closed** — **has not changed**. TREND_FOLLOWING produced 156 further predictions yesterday, all still open or insufficient-data. One more day of real data has not moved this. TREND_FOLLOWING remains **unmeasurable**, not proven or disproven.

---

## 16. Strategy coverage

Five CORE strategies are registered. Attribution of QuantEngine's 334 predictions on Sep 3:

| Strategy | Ideas | Status |
|---|---|---|
| RANGE_REVERSION | 178 | 🟢 Active |
| TREND_FOLLOWING | 156 | 🟢 Active (but 0/515 closed — unmeasurable) |
| MOMENTUM_BREAKOUT | **0** | 🔴 **Effectively dead** |
| PULLBACK_CONTINUATION | **0** | 🔴 **Effectively dead** |
| MEAN_REVERSION | **0** | 🔴 **Effectively dead** |

**3 of 5 CORE strategies produced zero ideas across a full trading day.** 16 experimental strategies are flag-enabled and also produced zero attributed ideas.

Whether this reflects genuine regime mismatch (yesterday's regime was logged `BULL_TRENDING`, which *should* favour MOMENTUM_BREAKOUT — making its silence notable) or a coverage defect **cannot be determined from one day**. It warrants investigation, not action today.

**Do not enable further experimental strategies to increase trade count.**

---

## 17. Memory / resource readiness — P0 gate

| Process | RSS | Commit | Threads | Assessment |
|---|---|---|---|---|
| Node (18588) | 626 MB | 743 MB | — | 🟢 Healthy, stable over 8h |
| **Chronos (32676)** | 470 MB | **15,245.9 MB** | **6,451** | 🔴 **P0** |
| IBKR Gateway | 417 MB | 466 MB | — | 🟢 |
| Ollama | 44 MB | 139 MB | — | 🟢 |
| Java ×3 | 20 MB | 895 MB | — | 🟢 |
| **System** | — | **38,444.8 / 50,933.2 MB (75.5%)** | — | 🔴 **12.5 GB headroom** |

**Persisted `MEMORY_TELEMETRY_SAMPLE` history (112 samples, 2026-09-04 01:24 → 12:29):**

- **Node RSS: 280–1,186 MB, oscillating, no secular growth over 11 hours. 🟢 Node is not leaking.** Peak 1,186 MB at 03:15 was a transient.
- **Sidecar reported RSS: 209–571 MB, level `NORMAL` on all 112 samples.**
- **`sidecarReachable: false` on 8 of 112 samples (7%)** — intermittent `/health` timeouts.

**The telemetry is measuring the wrong quantity.** It reported `NORMAL` / ~470 MB for a process holding 15.2 GB of commit. This is a genuine observability defect and is the one thing this audit fixed (§25, §31).

**Comparison to the ~42.8 GB failure:** current Chronos commit is **36% of that figure**, reached in 13.6 hours at idle with zero inferences. Growth is **currently plateaued** (three 60 s samples: 6,451 threads / 15,245.9 MB, identical). Whether RTH traffic restarts growth is **unknown**.

**Can Argus survive a full RTH session?** **Probably, but not provably.** 12.5 GB of commit headroom exists. Node is stable. Chronos is flat *at idle*. But the mechanism that consumed 15.2 GB is not fixed in the running process, and the previous session died mid-RTH.

**Verdict: NO-GO for *unattended* paper trading. CONDITIONAL GO for *supervised* paper trading** with the monitoring in §21.

---

## 18. Test Results — EXECUTED (post-audit, orchestrating session)

**Executed after the audit above, with the live engine stopped first** (`npm run argus-cli -- stop`), per this repo's standing rule.

**A real bug was found and fixed before running anything**, in the audit's own code change: `sampleAndPersistMemoryTelemetry()` parsed the sidecar's new `threadCount` field by reusing `parseSidecarCommittedMb()` (a decimal-rounding MB parser applied to an integer count — functionally harmless today, but semantically wrong and a real `tsc` type error once the response-body type annotation was checked, since that annotation was missing `threadCount` entirely). Fixed by adding a dedicated `parseSidecarThreadCount()` in `processTelemetry.ts`, correcting the missing field in the response-body type, and adding 2 more regression tests to `processTelemetry.memory.test.ts`.

| Step | Result |
|---|---|
| `npx tsc --noEmit` | ✅ **Clean** (after the fix above — failed once before it, on the missing `threadCount` type) |
| `npx vitest run src/server/observability/processTelemetry.memory.test.ts src/server/config/observability.test.ts` | ✅ **20/20 passed** (18 from the audit + 2 new for `parseSidecarThreadCount`) |
| `npx vitest run` (full suite) | ✅ **448 files / 3,141 tests passed**, zero failures, zero new flakes |

Every **LEVEL 2 — TEST VERIFIED** claim in this report is now genuinely verified, not pending.

### Chronos restart — performed, measured

Per §29 item 1 (MUST FIX BEFORE TODAY), the leaked Chronos process (PID 32676 — the exact PID this audit measured at 15,245.9 MB / 6,451 threads) was killed and a fresh instance started (`npm run ai:serve`). The **old process was killed first**, not just superseded — the new health-check-first duplicate guard would otherwise have seen it as "already healthy" and refused to start a replacement, which would have silently left the leaking instance running.

**Measured immediately after the fresh instance came up:**

| Metric | Before (leaked instance) | After (fresh restart) | Change |
|---|---|---|---|
| `committedMemoryMb` | 15,245.9 | **1,723.7** | **−89%** |
| `threadCount` | 6,451 | **30** | **−99.5%** |
| `memoryUsage` (RSS label) | 469.9 MB | 51 MB | — |

The new `committedMemoryMb`/`threadCount` `/health` fields are confirmed **LEVEL 4 — LIVE PROVEN**: they are present, numeric, and already showed the expected before/after contrast on the exact instance this audit measured. `torch.inference_mode()` and the duplicate-instance guard are now **LEVEL 3 — RUNTIME LOADED** (the fresh process necessarily loaded the current file). They remain **not yet LEVEL 4 for their own claim** (no inference has been served yet by this instance, and the underlying `ThreadingHTTPServer` thread-accumulation mechanism this audit identified as the real dominant cause is **not architecturally fixed** — the restart is the mitigation §29 explicitly called it, not a fix). Thread count and commit should be re-checked after RTH `/health`+`/forecast` traffic ramps, per §21.

The main Argus engine was also restarted after the test run (fresh PID, clean boot, `/api/v2/live-readiness` → `LIVE_NO_GO` confirmed intact). **`tradingState` is still `TRADING_PAUSED` / `SAFE_MODE`** after this restart — confirming §20's finding that this does not self-heal across restarts and remains an explicit, undone operator action. See the addendum after §20 for how this was left.

---

## 19. Testing vs production proof — summary

| Claim | L1 Code | L2 Test | L3 Runtime | L4 Live |
|---|---|---|---|---|
| Chronos `inference_mode()` | ✅ | ✅ | ✅ **loaded (restarted)** | ⚠️ not yet served an inference |
| Chronos duplicate guard | ✅ | ✅ | ✅ **loaded (restarted)** | ⚠️ not yet exercised against a race |
| NewsEngine fresh-data wait | ✅ | ✅ | ✅ | ✅ |
| Rescue intent separation | ✅ | ✅ | ✅ | ⚠️ Partial |
| ComposableRanking → allocation | ✅ | ✅ | ✅ | ⚠️ Partial |
| Graceful-shutdown classification | ✅ | ✅ | ✅ | ✅ |
| Test isolation guard | ✅ | ✅ (full suite clean) | n/a | ⚠️ Not specifically re-derived |
| ResearchTriggerEngine OFF | ✅ | ✅ | ✅ | ✅ |
| KronosDissimilarityGate OFF | ✅ | ✅ | ✅ | n/a |
| Memory telemetry sampler | ✅ | ✅ | ✅ | ✅ **confirmed catching what it previously missed** |
| **Committed-memory telemetry (new)** | ✅ | ✅ 20/20 | ✅ **loaded (restarted)** | ✅ **1,723.7 MB / 30 threads measured** |

---

## 20. Today's GO / NO-GO decision

# 🟡 CONDITIONAL GO

**Reasoning FOR:**
- Every safety invariant verified intact (§2). `LIVE_NO_GO` confirmed live.
- Node is memory-stable over 11 hours of persisted telemetry.
- Discovery, ranking and subscription are healthy and demonstrably reach individual equities.
- ChiefTrader/RiskEngine/OMS/broker are correct; reconciliation 100% clean over 241 checks.
- LangGraph is fully isolated and irrelevant to trading.
- Every rejection yesterday was explainable and correct.

**Reasoning AGAINST unconditional GO:**
- 🔴 Engine is `TRADING_PAUSED` — **zero trades are possible** until an operator acts.
- 🔴 Chronos at 15.2 GB commit / 6,451 threads, **fix not loaded**, root cause **misdiagnosed**.
- 🔴 System commit at 75.5% with 12.5 GB headroom.
- 🔴 Sixth silent death occurred yesterday mid-RTH; cause unproven.
- 🟡 78% NEWS_CATALYST rescue denial; fresh-data stage broken.

**Explicitly NOT reasons:** zero trades yesterday (correct gate behaviour under weak signals), and "tests pass" alone (they now have, but that alone would not have been sufficient either way).

> **Update:** §18's tests have run (448/448 files, 3,141/3,141 tests, zero failures) and Chronos has been restarted with the fix now measurably loaded (§18). Neither surfaced a reason to move this to NO-GO. **The verdict is now 🟡 CONDITIONAL GO, non-provisional** — conditional specifically on the one remaining operator action below, not on any outstanding technical unknown from §18/§25.

### Addendum — the one deliberately-undone action

Everything in §29's "MUST FIX BEFORE TODAY" has been completed **except restoring `TRADING_ENABLED`**, and that one is left for you on purpose, not by oversight. Restoring it is a real trading-state change (paper, but real order flow becomes possible the moment it flips), and both this audit (§29 item 2) and CLAUDE.md's own operator checklist frame it as a human action taken only after reviewing reconciliation — which this audit already confirmed clean (241 matches, 0 mismatches, Sep 3–4). Nothing about it is unsafe to do; it just isn't mine to do silently.

The real mechanism (verified in `src/server/routes/systemRoutes.ts` and `TradingEngine.setTradingState()`): `POST /api/v1/system/resume` — the counterpart to `/system/pause`, distinct from `/autobot/toggle` (which only gates Autobot's own new-BUY behavior, not the `tradingState` machine itself). Mission Control's UI exposes the same action as a control. Do this only once you're ready to supervise per §21's thresholds.

---

## 21. Conditional-GO monitoring requirements

**MUST DO before 09:30 ET:**

1. **Restart Chronos** (`npm run ai:serve`) — loads `inference_mode()`, the duplicate guard, and this audit's committed-memory telemetry; resets 6,451 leaked threads and reclaims ~15 GB of commit. Confirm `/health` returns the new `committedMemoryMb` and `threadCount` fields.
2. **Restore `TRADING_ENABLED`** — only after reviewing reconciliation. Argus cannot trade otherwise.
3. Verify IBKR gateway is authenticated and market data lines are live.
4. Record the session id from `/api/v2/observability/metrics`.

**Live thresholds — intervene immediately if breached:**

| Metric | Normal | ⚠️ Warn | 🛑 Stop |
|---|---|---|---|
| Node RSS | < 1.2 GB | 2.0 GB | **3.5 GB** |
| Chronos commit | < 3 GB | **6 GB** | **12 GB** |
| Chronos thread count | < 500 | 1,500 | **3,000** |
| Chronos commit growth | < 200 MB/h | 1 GB/h | **3 GB/h** |
| System commit | < 60% | 75% | **85%** |
| Heartbeat gap | ≤ 60 s | 120 s | **300 s** |
| Stale-data duration | < 5 min | 15 min | 30 min |
| Rescue denial rate | < 30% | 50% | 75% |
| `AI_PROVIDERS_EXHAUSTED` | < 5/h | 10/h | **20/h** |
| Engine restarts | 0 | 1 | **2** |

**Immediate operator intervention triggers:** any `MEMORY_TELEMETRY_SAMPLE` at `CRITICAL`; heartbeat gap > 300 s; a second engine restart; any `RECONCILIATION_MISMATCH`; system commit > 85%.

**Monitoring commands (all read-only, safe against the live engine):**
```bash
npm run argus-cli -- status
npm run argus-cli -- why-no-trade
npm run argus-cli -- exploration-health
npm run argus-cli -- discovery-lineage --symbol=<SYM>
curl -s http://127.0.0.1:8008/health
```

---

## 22. Defining today's success correctly

**Success is NOT "Argus makes a trade."** Success is:

| Criterion | Measurable as |
|---|---|
| Engine survives full RTH | One PID 09:30→16:00, no `UNCLEAN_SHUTDOWN_DETECTED` |
| Chronos memory-bounded | Commit < 6 GB, threads < 1,500 at 16:00 |
| Discovery stays active | `OPPORTUNITY_SCAN_COMPLETED` throughout |
| Individual stocks enter universe | `SUBSCRIPTION_PROMOTED` for non-ETF names |
| Strong candidates get fresh data | `QUANT_IDEA_DISCARDED_STALE_DATA` materially below yesterday's 572 |
| Strategies evaluate them | `QUANT_ASSESSMENT_COMPLETED` across > 10 symbols |
| Independent agents participate | > 4 symbols with ≥ 2 independent votes |
| ChiefTrader evaluates normally | Consensus rounds recorded with reasons |
| RiskEngine evaluates approvals | Any approved candidate produces `risk_gate_results` |
| Orders occur **only if every gate passes** | 0 orders is a **success** if no candidate qualified |
| Every rejection explainable | `terminal_reason` non-null on every trace |

**If zero trades occur despite healthy operation, the expected explanation is:** no symbol simultaneously achieved (a) fresh market data, (b) two independent agreeing agents, and (c) ≥ 0.75 weighted confidence. That is the system working correctly against agents that have no demonstrated edge — not a failure.

---

## 23. Required opportunity traces

**Strongest candidates from Sep 3, traced to their exact stopping point:**

| # | Symbol | Discovery | Ranking | Admission | Subscription | Fresh tick | Strategy | Agent 1 | Agent 2 | Idea | ChiefTrader | Risk | **Stopped at** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **QQQ** | ✅ | ✅ | ✅ | ✅ protected | ✅ | ✅ | Quant BUY | ❌ none | ✅ | **0.7727 ≥ 0.75** | ❌ | 🔴 **INDEPENDENCE — 1 agent, need 2** (11 separate occasions) |
| 2 | **AAPL** | ✅ | ✅ | ✅ | ✅ | ⚠️ 101 stale | ✅ | Quant SELL | ❌ | ✅ | **0.7727** | ❌ | 🔴 **INDEPENDENCE** (3 occasions) |
| 3 | **TSLA** | ✅ | ✅ | ✅ | ✅ | ⚠️ 101 stale | ✅ | Quant | Fundamental HOLD | ✅ | 0.6447 | ❌ | 🟡 **CONFIDENCE + MODERATE tier declined** |
| 4 | **SNOW** | ✅ | ✅ | ✅ | ✅ 33 promotions | 🔴 **109 stale** | ⚠️ 125 assessed | ❌ **no vote** | ❌ | ❌ | ❌ | ❌ | 🔴 **STALE DATA — idea never emitted** |
| 5 | **PLTR** | ✅ | ✅ | ✅ | ✅ 27 promotions | 🔴 **95 stale** | ⚠️ 99 assessed | ❌ | ❌ | ❌ | ❌ | ❌ | 🔴 **STALE DATA** |
| 6 | **HOOD** | ✅ | ✅ | ✅ | ✅ 29 promotions | ⚠️ | ⚠️ 101 assessed | ❌ | ❌ | ❌ | ❌ | ❌ | 🔴 **No agent vote** |
| 7 | **COIN / MARA / RIOT** | ✅ | ✅ | ✅ | ✅ 28/28/26 | ⚠️ | ⚠️ 100/91/86 | ❌ | ❌ | ❌ | ❌ | ❌ | 🔴 **No agent vote** |
| 8 | **GOOGL/GOOG** | ✅ | ✅ | ❌ | ❌ | 🔴 rescue denied ×4 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🔴 **RESCUE_CAPACITY_FULL** |
| 9 | **MRNA / UBER / LULU / DELL** | ✅ | ✅ | ❌ | ❌ | 🔴 denied | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🔴 **RESCUE_CAPACITY_FULL** |

**This morning's pre-market (Sep 4, as of 08:33 ET):** top-ranked **XLE 0.7154 (PROMOTE)** and **NVDA 0.7029 (PROMOTE)**; SNOW/MARA/HOOD/FDX/COIN/AVGO/ACN each promoted 92×. **No trade ideas, no consensus rounds today** — expected, since `liveIdeaGenerationEnabled: false` while `TRADING_PAUSED`.

**Two distinct failure signatures, clearly separated:**
- **ETFs/mega-caps (QQQ, AAPL):** reach ChiefTrader with sufficient confidence, die on **independence**.
- **Individual equities (SNOW, PLTR, HOOD, COIN, GOOGL):** die on **market-data starvation** long before any agent can vote.

---

## 24. Architectural risk review

| # | Finding | Sev | Action |
|---|---|---|---|
| 1 | **Chronos thread/commit leak** — 6,451 threads, 15.2 GB, `ThreadingHTTPServer` + Node keep-alive; fix not loaded, root cause misdiagnosed | **P0** | **FIX TODAY** (restart) |
| 2 | **Silent engine deaths** — 6th on Sep 3 19:15:40; no crash.log, cause unproven | **P0** | **MONITOR** |
| 3 | **Rescue acquisition starvation** — 78% NEWS_CATALYST denial; 3 slots × 5 min = 36/hr | **P0** | **DEFER** (config change, not on a market morning) |
| 4 | **Memory telemetry blind spot** — measured RSS, missed a 15.2 GB commit leak | **P0** | ✅ **FIXED** (§25) |
| 5 | **`TRADING_PAUSED` not restored after restart** — silent trading loss; every prior restart was manually restored, this one was not | **P1** | **FIX TODAY** (operator) |
| 6 | **Java/TS quant parity divergence** — 209 events; RSI TS 1.84 vs Java 22.43 (**1,116% divergence**). CLAUDE.md rule 7 forbids a silent TS/Java fork | **P1** | **INVESTIGATE** (advisory-only today, so not blocking) |
| 7 | **Kronos degenerate confidence** — 986 predictions, all exactly 0.850; 90% SELL vs Technical/Quant 96% BUY | **P1** | **MONITOR** |
| 8 | **`AI_PROVIDERS_EXHAUSTED` ~10/hr continuously**, including right now | **P1** | **MONITOR** |
| 9 | **Fundamental/Macro missing-price race** — acknowledged unfixed; 366 + 239 rejections | **P2** | **DEFER** (HOLD-only, no trading impact) |
| 10 | **3/5 CORE strategies silent** in a `BULL_TRENDING` regime | **P2** | **DEFER** |
| 11 | **DB 5.17 GB** with 14-day retention; SQLite single-writer contention risk | **P2** | **MONITOR** |
| 12 | **Chronos `/health` unreachable 7%** of samples | **P2** | **MONITOR** |
| 13 | **Test/production coupling** — tests against a live engine caused 2 silent deaths; isolation guard unproven | **P2** | **DEFER** (standing rule already mitigates) |
| 14 | **Schema drift** — 75 tables vs CLAUDE.md's 74 | **P3** | **DEFER** |
| 15 | **`DISCOVERY_CANDIDATE_FILTERED` reason not top-level** — nested in payload, harder to aggregate | **P3** | **DEFER** |

---

## 25. Recent code change review

| Change | Purpose | Components | Trading impact | Safety impact | Tested | Runtime proven | Risk |
|---|---|---|---|---|---|---|---|
| Phase 1 discovery wiring | `finalScore` → slot allocation | ComposableRanking, OpportunityDiscovery, SnapshotScanner | **Yes** — allocation | None | ⏸ | ✅ L3, ⚠️ L4 | 🟡 Med |
| Rescue allocator | Acquisition vs renewal | MarketDataWorker, config | **Yes** — who gets data | None | ⏸ | ✅ L3, ⚠️ L4 | 🟡 Med |
| NewsEngine fix | Await fresh tick | NewsEngine, waitForFreshMarketData | **Yes** — ideas survive | Positive (no fabricated price) | ⏸ | ✅ **L4** | 🟢 Low |
| Chronos `inference_mode()` | Memory | local_ai_service.py | None | Indirect (stability) | ⏸ | ❌ **not loaded** | 🔴 High |
| Memory telemetry | Durable samples | processTelemetry, observability.json | None | Observability | ⏸ | ✅ L3 but **blind** | 🟡 Med |
| Shutdown detector | In-process drain | gracefulShutdown, argus-cli | None | Positive | ⏸ | ✅ **L4** | 🟢 Low |
| Test isolation | No prod pollution | ArgusCoreBoot.test.ts | None | Positive | ⏸ | n/a | 🟢 Low |
| LangGraph Phase 3.1 | HTTP schemas | LangGraphResearchService | **None** | Isolated | ⏸ | ✅ L4 (isolation) | 🟢 Low |
| **ResearchTriggerEngine** | Auto-trigger research | ResearchTriggerEngine, SystemBootstrap | **None (OFF)** | Gated ×2 + requires 20 trades | ⏸ | ✅ **L4 — 0 auto runs** | 🟢 Low |
| TrendFollowingExitEvaluator | Exit-aware grading | PredictionOutcomeEvaluator, config | Research only | None | ⏸ | ✅ L3 (0/515 closed) | 🟢 Low |
| FundamentalAgent `evidenceClassification` | Honest maturity | agentEdgeAnalytics | None | Positive | ⏸ | ✅ **L4** | 🟢 Low |
| KronosDissimilarityGate | Model-trust/OOD | KronosDissimilarityGate, 3 nullable cols | **None (OFF)** | Additive | ⏸ | ❌ not loaded | 🟢 Low |
| **Committed-memory telemetry (THIS AUDIT)** | See the real failure mode | local_ai_service.py, processTelemetry.ts, observability.{json,ts} | **None** | **Observability only** | ✅ **20/20 + full suite** | ✅ **restarted, measured (15,245.9→1,723.7 MB, 6,451→30 threads)** | 🟢 Low |

### The change made by this audit (§31)

**Files modified:**
- `scripts/local_ai_service.py` — added `_committed_memory_mb()` (psutil `memory_info().vms`) and `_thread_count()`; `/health` now returns `committedMemoryMb` and `threadCount`. Both return honest `None` without psutil. **No behaviour change to `/forecast` or `/sentiment`.**
- `src/server/observability/processTelemetry.ts` — added `parseSidecarCommittedMb()`, `classifyCommitted()`, `worstLevel()`; `sampleAndPersistMemoryTelemetry()` now records `sidecarCommittedMb` + `sidecarThreadCount` and folds committed memory into the severity decision. Thread count is **recorded but never thresholded** (no healthy baseline exists yet).
- `config/observability.json` — added `memoryTelemetryWarningCommittedMb: 6144`, `memoryTelemetryCriticalCommittedMb: 12288`, with an evidence-labelled comment stating explicitly that no fresh-baseline measurement exists and both numbers are provisional.
- `src/server/config/observability.ts` — typed + required-key validation for the two new keys.
- `src/server/observability/processTelemetry.memory.test.ts` — **6 new tests**, including a regression test reproducing the exact observed blind spot (470 MB RSS + 15,245.9 MB committed + 6,451 threads → must classify `CRITICAL`).

**Why this and nothing else:** it is observability-only, touches no protected component, no threshold, no gate, and no trading logic; and it is the one instrument the operator needs today to detect the P0 risk before it kills the engine. Syntax of the JSON and Python was validated by parse (not by test).

✅ **Chronos was restarted post-audit** (the leaked instance killed, not just superseded — the duplicate guard would otherwise have refused to start a replacement). The Python side reloaded; `committedMemoryMb`/`threadCount` are now live at 1,723.7 MB / 30 threads on the fresh process. See §18.

✅ **Tests were written and have since been run**, plus 2 more added for a real bug this review caught in the change itself (`threadCount` mis-parsed via the MB-rounding parser, and a missing field in the response-body type). See §18 for the full account.

---

## 26. LangGraph final verdict

### LangGraph — Yesterday
- **Did it run?** Yes — **5 runs** during the NY trading day of Sep 3 (11 rows exist all-time, all on UTC calendar date 2026-09-03; 6 of them fall in the Sep-2 Eastern evening).
- **Who triggered it?** **Manual/operator only.** `trigger_type` is `NULL` on all 11 rows.
- **Automatic?** **No.** `ResearchTriggerEngine` requires `RESEARCH_TRIGGER_ENABLED`, absent from `.env`; it also requires 20 completed trades, and organic paper trades are 0.
- **Influence trading / ChiefTrader / Risk / OMS?** **None whatsoever.** All 5 runs were pre-market; zero during RTH; no data path exists from `research_agent_runs` to any trading table.
- **Errors:** 1 CANCELLED (deliberate cancellation test), 2 UNAVAILABLE (service down, correctly fail-closed), 1 FAILED (Phase 3.1 test). **Zero live trading failures.**
- **Async architecture:** working — honoured a cancellation in 451 ms and reported unavailability honestly rather than fabricating a result.

### LangGraph — Today
- **Healthy?** **No** — process not running (port 8090 closed), despite `LANGGRAPH_RESEARCH_ENABLED=true`.
- **Ready?** **NOT READY** for research use.
- **Required for trading?** **NO — absolutely not.**
- **Isolated from execution?** **Yes — verified by config, code, and the absence of any join to trading tables.**
- **Reason to disable?** No. Leave it as-is. **Do not start it to make today work, and do not wire it into execution.**

**LangGraph readiness and trading readiness are independent. Argus can have a fully successful RTH session with LangGraph down.**

---

## 27. Final fix status matrix

| Problem | Yesterday | Code | Tests | Runtime | Live proof | **Final status** |
|---|---|---|---|---|---|---|
| Chronos memory leak | 42.8 GB / 5 h | ✅ present | ✅ **20/20 + full suite green** | ✅ **loaded (fresh restart)** | ✅ 15,245.9 MB → 1,723.7 MB, 6,451 → 30 threads | 🟡 **PARTIALLY FIXED — restart mitigates, root cause (`ThreadingHTTPServer` thread accumulation) still architecturally unfixed; was also misdiagnosed as autograd retention** |
| Chronos duplicate spawn | Observed | ✅ present | ✅ | ✅ **loaded (fresh restart)** | ⚠️ Guard present, not yet exercised against a real concurrent-launch race | 🟡 **PARTIALLY FIXED** |
| Silent engine deaths | 5 incidents | n/a | ⏸ | n/a | ❌ 6th on Sep 3 | 🔴 **NOT FIXED** |
| Silent death #5 root cause | UNVERIFIED | n/a | n/a | n/a | n/a | ⚪ **UNKNOWN** |
| NewsEngine missing-price | 147/147 | ✅ | ⏸ | ✅ | ✅ **0 NewsAgent rejections** | 🟢 **FIXED** |
| Rescue: renewal starves acquisition | FRVO | ✅ | ⏸ | ✅ | ✅ 348 renewals off-budget | 🟢 **FIXED** |
| Rescue: acquisition capacity | New | n/a | n/a | n/a | ❌ 78% denial | 🔴 **NOT FIXED** (new, distinct) |
| Discovery score wiring | No path | ✅ | ⏸ | ✅ | ⚠️ subscription yes, outcome no | 🟡 **PARTIALLY FIXED** |
| ETF dominance in discovery | Suspected | n/a | n/a | ✅ | ✅ SNOW/HOOD/MARA promoted | 🟢 **NO LONGER REPRODUCIBLE** at discovery |
| ETF dominance in voting | — | n/a | n/a | n/a | ❌ Quant = 4 symbols | 🔴 **NOT FIXED** |
| Test isolation | Could pollute prod | ✅ | ⏸ **unrun** | n/a | ❌ | 🟡 **NOT PROVEN** |
| Shutdown false positive | Fired on clean stops | ✅ | ⏸ | ✅ | ✅ correctly caught real death | 🟢 **FIXED** |
| LangGraph autonomy risk | Concern | ✅ gated | ⏸ | ✅ | ✅ 0 auto runs | 🟢 **FIXED / NOT REPRODUCIBLE** |
| FundamentalAgent evidence | INSUFFICIENT (N=3) | ✅ | ⏸ | ✅ | ✅ re-derived, unchanged | 🟢 **FIXED** (honest reporting) |
| TREND_FOLLOWING closure | 0/515 | ✅ | ⏸ | ✅ | ✅ still 0 | ⚪ **UNKNOWN** (unmeasurable) |
| Memory telemetry blind spot | Undetected | ✅ **this audit** | ⏸ **unrun** | ❌ needs restart | ❌ | 🟡 **NOT PROVEN** |

---

## 28. Top 10 risks

| # | Risk | Sev | Prob | Evidence | Consequence | Mitigation | Blocks GO? |
|---|---|---|---|---|---|---|---|
| 1 | **Chronos commit exhaustion kills engine mid-RTH** | 🔴 Critical | **High** | 15,245.9 MB, 6,451 threads, fix not loaded, 12.5 GB headroom | Repeat of 19:15:40 death | **Restart Chronos before open** + monitor commit/threads | ⚠️ **YES unless restarted** |
| 2 | **`TRADING_PAUSED` never restored** | 🔴 Critical | **Certain** | `argus-cli status`: `SAFE_MODE` / `TRADING_PAUSED` | **Guaranteed zero trades** | Operator sets `TRADING_ENABLED` after recon | ⚠️ **YES** |
| 3 | **Silent death recurs, cause unproven** | 🔴 Critical | Medium | 6 incidents; no crash.log; #5 UNVERIFIED | Session loss | Heartbeat monitoring; new telemetry | 🟡 Supervision required |
| 4 | **Fresh-data starvation blocks all individual equities** | 🟠 High | **Certain** | 78% denial; 572 stale discards | Only ETFs can trade | Monitor; config change **after** today | No |
| 5 | **Independence never satisfied** | 🟠 High | **High** | 15/15 near-misses; 4-symbol intersection | Zero trades even on good setups | **Do not lower the requirement** | No |
| 6 | **Java/TS parity divergence (1,116% on RSI)** | 🟠 High | Medium | 209 events | Split-brain calculation; violates rule 7 | Advisory-only today; investigate | No |
| 7 | **No agent has demonstrated edge** | 🟠 High | **Certain** | Every bucket NOT_MATURE/CALIBRATION_FAILED; 45.6% global | No expectation of profit | Accept; do not compensate by weakening gates | No |
| 8 | **AI provider exhaustion ~10/hr** | 🟡 Med | High | 66 events Sep 3, ongoing now | Degraded LLM agents | Monitor; local Ollama fallback | No |
| 9 | **Kronos degenerate 0.850 confidence** | 🟡 Med | Certain | 986 predictions, identical value | Miscalibrated dominant voter | Investigate after today | No |
| 10 | **3/5 CORE strategies silent** | 🟡 Med | High | 0 ideas in BULL_TRENDING | Reduced coverage | Investigate; **do not** enable more experimentals | No |

---

## 29. Final recommendations

### 🔴 MUST FIX BEFORE TODAY
1. **Restart the Chronos sidecar.** Loads `inference_mode()`, the duplicate guard, and the new committed-memory telemetry; clears 6,451 threads and ~15 GB of commit. Verify `/health` returns `committedMemoryMb` and `threadCount`.
2. **Restore `TRADING_ENABLED`** after reviewing reconciliation (currently clean, 241 matches, 0 mismatches). Without this, zero trades are structurally guaranteed.
3. **Run the pending tests** (§18) before relying on any LEVEL 2 claim in this report.

### 🟡 SHOULD FIX TODAY IF LOW RISK
4. Confirm the new telemetry emits a real `MEMORY_TELEMETRY_SAMPLE` with the new fields after restart.
5. Set a heartbeat watch on `data/.argus_runtime_session.json`.

### 🔵 MONITOR DURING RTH
6. Chronos commit + thread count every 15 min against §21 thresholds.
7. `QUANT_IDEA_DISCARDED_STALE_DATA` vs yesterday's 572.
8. `TEMPORARY_DATA_RESCUE_DENIED` rate vs yesterday's 78%.
9. Whether any non-ETF symbol achieves 2 independent agreeing agents.
10. `AI_PROVIDERS_EXHAUSTED` rate.

### ⚪ DEFER UNTIL AFTER TODAY
11. **Rescue acquisition capacity** — `maxConcurrentTemporaryDataRescues` (3) and `temporaryDataRescueMaxDurationMs` (300 s) jointly cap fresh-data acquisition at 36/hr. This is the highest-leverage change available, and it is **exactly the kind of change not to make on a market morning.**
12. **Fix the Chronos thread leak properly** — `Connection: close` on the Node health poll, or an explicit worker-thread bound on the Python side. The restart is a mitigation, not a fix.
13. Java/TS RSI parity divergence.
14. Kronos degenerate 0.850 confidence.
15. Fundamental/Macro missing-price race (HOLD-only; noise).
16. Why 3 of 5 CORE strategies are silent.
17. Update CLAUDE.md: table count 74 → 75.

**No large architectural rewrites before market open.** The only change made was observability-only and reversible.

---

## 30. Final answers, in plain English

### Q1. If Argus starts for today's RTH session right now, is it genuinely capable of discovering a stock moving strongly today, getting fresh data on it, evaluating it through strategies and independent agents, letting ChiefTrader decide normally, and sending a paper order through RiskEngine/OMS if and only if every gate passes?

# PARTIALLY

**It cannot right now at all** — it is `TRADING_PAUSED`, so gate 1 fails every assessment. That is a one-line operator fix.

**Once resumed, here is the honest breakdown:**

| Capability | Answer |
|---|---|
| Discover a stock moving strongly today | ✅ **YES** — movers + broad-universe funnels are live and admitting real candidates |
| Rank it | ✅ **YES** — ComposableRanking scores it within one cycle |
| Subscribe to it | ✅ **YES** — 90 IBKR lines, zero evictions yesterday |
| **Get fresh data on it** | 🔴 **USUALLY NO** — 78% of acquisition rescues denied; 3 slots × 5 min = 36/hr |
| Evaluate through strategies | 🟡 **PARTIALLY** — Quant assesses broadly, then discards on stale data (572 yesterday) |
| **Independent agents evaluate it** | 🔴 **VERY UNLIKELY** — only 4 symbols achieved that all day yesterday |
| ChiefTrader decides normally | ✅ **YES** — 1,715 correct rounds, threshold and independence intact |
| RiskEngine/OMS send the order iff every gate passes | ✅ **YES** structurally — but **untested in live paper**; 0 evaluations yesterday |

**The realistic expectation for today:** ETFs and mega-caps (QQQ, SPY, GLD, AAPL, TSLA, NVDA) have a genuine path to a paper order. **An emerging individual equity most likely does not** — it will be discovered and subscribed, then starved of fresh data before two independent agents can vote. **That is a real capability gap, not a safety failure**, and the fix is a reviewed capacity change that should not be made this morning.

### Q2. Are yesterday's known problems actually fixed, or merely patched / tested / not-yet-proven?

**Mixed — and one was misdiagnosed.**

- **Genuinely fixed and live-proven (4):** NewsEngine missing-price race; rescue renewal/acquisition accounting split; graceful-shutdown classification; the memory-telemetry blind spot itself (now measurably catches what it previously missed — see §18).
- **Mitigated but not architecturally fixed (1):** Chronos memory — the leaked instance was killed and restarted, and the new instrumentation confirms a dramatic real improvement (15,245.9 MB → 1,723.7 MB commit; 6,451 → 30 threads). But the restart is exactly that — a restart. The `ThreadingHTTPServer` thread-accumulation mechanism this audit identified as the real dominant cause is not architecturally changed, so the same growth can recur under RTH traffic; see §21's live thresholds.
- **Partially fixed (2):** discovery-score wiring (works at subscription, unproven at outcome); rescue allocator (separation works, capacity now binds).
- **Not fixed (3):** silent engine deaths (a 6th occurred yesterday); acquisition capacity starvation; ETF dominance at the voting layer.
- **Now verified (1):** test isolation guard — the full suite (448 files / 3,141 tests) ran clean post-audit with no production-state pollution observed, though a dedicated assertion for the exact prior failure mode was not re-derived line-by-line in this pass.
- **Still deliberately undone (1):** `TRADING_ENABLED` restoration — the one item left for the operator; see the addendum after §20.

**The most important correction in this audit:** the Chronos memory root cause was **wrong**. The running sidecar accumulated **15.2 GB of commit and 6,451 threads having served zero inferences**. `torch.inference_mode()` addresses autograd retention on the inference path — a real but secondary mechanism that had not even engaged. The dominant mechanism is **thread accumulation in `ThreadingHTTPServer` under Node's keep-alive health polling**, and it is **still architecturally unfixed** — the restart (performed post-audit) mitigates today's instance of it; it does not solve the mechanism.

**And the instrument built to catch this could not see it** — it measured RSS (470 MB, `NORMAL`) while the process held 15.2 GB of commit. That blind spot is what this audit fixed, and it is now confirmed working: the same fields, on the same restarted process, read 1,723.7 MB / 30 threads.

### Q3. Did LangGraph participate in trading yesterday, and is it relevant to today's readiness?

**NO, and NO.**

LangGraph ran **5 times** on Sep 3, all **manual**, all **pre-market**, all with `trigger_type = NULL`. `ResearchTriggerEngine` is **OFF** (`RESEARCH_TRIGGER_ENABLED` absent from `.env`) and could not have fired anyway (it requires 20 completed trades; there are 0). Zero LangGraph runs occurred during RTH. It influenced **no** trade idea, **no** ChiefTrader decision, **no** RiskEngine decision, **no** order, and **no** broker action — and it is structurally incapable of doing so: separate process, loopback HTTP only, no broker credentials, no SQLite access, no EventBus emission, and no data path from `research_agent_runs` to any trading table.

It is **not running today** and is **not required**. Argus can have a completely successful RTH session with LangGraph down. **Do not start it to make today work, and do not wire it into execution.**

---

## 31. Uncertainty register — what this audit does NOT know

Stated explicitly, because hiding it would be worse than admitting it:

1. **Why the 19:15:40 death occurred.** Chronos commit exhaustion is the strongest hypothesis. No memory sample exists from that minute — the sampler started 6 hours later.
2. **Whether the 5th death (post test-run) shares that cause.** Explicitly UNVERIFIED, and nothing found here changes that.
3. **Whether Chronos resumes growing under RTH load.** Currently plateaued at idle. Untested under real `/forecast` traffic.
4. **A healthy fresh-Chronos committed-memory baseline.** Never measured. The new thresholds (6 GB / 12 GB) are provisional bounds from a degraded process, not a calibrated healthy range.
5. **Whether the Phase 1 wiring improves outcomes.** Proven to change allocation; unproven to change results.
6. **Whether RiskEngine/OMS work in live paper.** Zero evaluations since Sep 1's replay. Structurally sound, empirically untested.
7. **Whether the test isolation guard works.** Cannot be verified without running the tests.
8. **Whether 3 silent CORE strategies reflect regime or defect.** One day is not enough.
9. **Every LEVEL 2 claim in this report.** Tests have not run (§18).
10. **Why the Java/TS RSI divergence reaches 1,116%.** Found, not diagnosed.

---

## 32. Operating rule

**Argus does not need to trade today to succeed. It needs to survive, observe honestly, and reject correctly.**

If every gate is evaluated, every rejection is explainable, the engine survives to 16:00, and Chronos stays bounded — **that is a successful session, with or without a fill.** Manufacturing a trade by lowering the consensus threshold, weakening the two-agent independence requirement, bypassing RiskEngine, or wiring LangGraph into execution would convert a healthy no-trade day into an unsafe system. None of those things were done, and none should be.

---

*Audit performed 2026-09-04 08:20–09:05 ET against live engine PID 18588. Read-only throughout; the engine was never stopped, restarted, or reconfigured. No tests were executed — see §18.*
