# ARGUS — Complete Implementation, Incident, Defect & Roadmap Forensic Audit

**Date:** 2026-09-14
**Method:** Direct code/test/config inspection (three parallel research passes + direct verification of the DB-isolation import graph, the synthetic simulator, and the certification gate — the author of this session's own simulator/P1-A work). Every claim below is backed by a file:line citation. Nothing is asserted from memory or from a prior report without being re-checked against current code.
**Status legend:** ✅ COMPLETE · 🟢 FIXED · 🟡 PARTIAL · 🔴 BROKEN · ⚪ NOT IMPLEMENTED · 🔵 IMPLEMENTED BUT UNVALIDATED · 🟠 BLOCKED · 💤 DEFERRED

---

## 1. Executive Summary

Argus's **safety spine holds**: RiskEngine's persist-then-emit, OMS idempotency, PAPER_TRADING_ONLY/LIVE_NO_GO enforcement, the capital-reservation race fix, restart-safety pause-on-unclean-shutdown, and calibration's Bayesian/Wilson-gated trust mechanism are all real, tested, and free of bypass paths — independently re-verified, not merely re-cited. The P1-A evaluator-overlap defect and P1-B heap-freeze *trigger* are both closed with real regression tests. FD-1 through FD-7 are all genuinely fixed with reproducing tests.

**But this audit also found three classes of real, previously-unreported or under-reported problems**, in descending severity:

1. **A live-path reconciliation gap**: an *unknown* or *failed* broker sync state does **not** pause trading or force reconciliation — it silently blind-retries on the next 5-minute tick (§9, Part B). Only a *confirmed measured mismatch* pauses. This is a real operational-safety gap, not previously flagged as open.
2. **An unbounded, unindexed full-table scan on the live per-trade RiskEngine path** (`db.select().from(schema.trades)` with no WHERE/LIMIT, run twice per risk evaluation) — the same defect class as P1-A, in a part of the codebase P1-A's fix never touched, and the code's own comment admits it's deliberately unfixed (§3).
3. **The Synthetic Market Session Simulator's own new work this session** genuinely hardened isolation (now architecturally, not just empirically, guaranteed — §4) and found/fixed three real bugs of its own (a `TechnicalAgent` cooldown incompatible with accelerated sessions, a `SyntheticMarketClock` re-anchor race, and an `ARGUS_ACTIVE_BROKER` env leak) — but **Test B (the mandatory tradeable-scenario certification) still does not pass**, even after an explicit, fully-disclosed calibration-seeding assist. It now fails one stage deeper (RiskEngine's `sell_position_exists` gate, correctly, because the two independently-converged agents both voted **SELL** on a symbol Argus never bought) rather than at CONSENSUS. This is a real, substantive, unresolved finding, not something papered over.

**No evidence of alpha.** The quant/calibration evidence base is unchanged from the last documented state: 0/38 (agent, bucket) pairs clear a statistically-significant above-chance bar after effective-sample-size correction; every "high win rate" raw bucket collapses to single-digit effective N once genuinely independent observations are counted. This conclusion is backed by real, tested code (`effectiveSampleSize.ts`), not prose.

**Institutional roadmap**: reliability/safety/isolation phases are real and substantially complete. Portfolio construction, microstructure, and model governance/drift detection are aspirational or entirely absent. This is expected at this stage and should **not** be rushed (§15, §21).

---

## 2. Complete Requirement Checklist — Core Pipeline (Part A)

Expected: `DATA → FEATURES → RESEARCH → STRATEGIES → FORECASTS → DIVERSITY/INDEPENDENCE → PORTFOLIO CONSTRUCTION → CAPITAL ALLOCATION → RISK → EXECUTION → RECONCILIATION → ATTRIBUTION → RESEARCH/LEARNING → VALIDATION → PROMOTION/DEGRADATION`.

| Layer | Status | Evidence |
|---|---|---|
| Data (MarketDataWorker, Alpaca/IBKR) | ✅ COMPLETE | Real WS ingestion, tick bookkeeping (`MarketDataWorker.ts`) |
| Features (indicators, regime) | ✅ COMPLETE | `technicalSignal.ts`, `RegimeEngine.ts`, Java `HmmRegimeEngine.java` |
| Research (quant strategies, Java core) | ✅ COMPLETE (as compute), 🟡 PARTIAL (as *validated*) | `src/server/quant/strategies/*`, `quant-core-java/institutional/` — real, soft-scored, mostly unvalidated (§8) |
| Strategies → Forecasts | 🟡 PARTIAL | Real `quantForecasts` object (§10) but no strategy/feature-version provenance on the persisted row |
| Diversity/Independence | ✅ COMPLETE | `effectiveSampleSize.ts` — real clustering, tested, and a real (though narrow) live consumer (`isQuantIndependentQualificationEnabled`) |
| **Portfolio construction** | ⚪ NOT IMPLEMENTED | Every idea is sized in isolation; `RiskParityOptimizer.java` exists but has zero live wiring |
| Capital allocation | 🟡 PARTIAL | `CapitalAllocation.ts` — real flat-dollar ceiling, not risk-weighted |
| Risk (25 gates) | ✅ COMPLETE | Verified fail-closed, persist-then-emit, no bypass (§9) |
| Execution (OMS/broker) | ✅ COMPLETE | Idempotent, LIVE-gated (§9) |
| **Reconciliation** | 🟡 PARTIAL — real gap found | Confirmed-mismatch path pauses; unknown/failed state does not (§9) |
| Attribution | 🟡 PARTIAL | `executionQuality.ts`/`dailyAttributionReport.ts` real but SELL-only, no execution-algo layer |
| Research/Learning (ReflectionEngine, calibration) | ✅ COMPLETE | Real Beta-Binomial + Wilson-gated trust (§11) |
| Validation (PBO) | ✅ COMPLETE, offline-only | Real CSCV algorithm, never a live gate (§8) |
| Promotion/Degradation (strategy lifecycle) | ✅ COMPLETE | `StrategyRecertification.ts` — review-only, never auto-reinstates (§12) |

**"Agent voting" is not portfolio construction, and "confidence" is not expected return** — confirmed true of the current codebase: `ChiefTraderAgent`'s consensus produces a side+confidence, not a position size or expected-return number; sizing is a separate, simpler `PositionSizing.ts` (fixed-dollar or percent-of-equity) applied afterward with no cross-idea portfolio optimization.

---

## 3. Incident/Defect Closure Audit (Part 2)

### P1-A — Memory/RSS growth

**Root cause:** `PredictionOutcomeEvaluator`/`MultiHorizonOutcomeEvaluator` ran bare, overlap-unguarded `setInterval`s doing unbounded `.all()` queries; `HistoricalDataGateway.memoryBars` had no eviction.

**Status: 🟢 FIXED**, with real causal evidence — not merely claimed:
- Single-flight guard lives **inside** `evaluatePending()` itself (`PredictionOutcomeEvaluator.ts:189-191`, `MultiHorizonOutcomeEvaluator.ts:131-133`), so a direct concurrent call (not just the timer) is protected — proven by `singleFlightInterval.test.ts:29-44`.
- No watermark exists to advance incorrectly — the cursor is a `LEFT JOIN ... WHERE outcome.id IS NULL` anti-join, explicitly documented as deliberately not a watermark (`PredictionOutcomeEvaluator.ts:201-209`) specifically because a watermark could skip a late-arriving outcome forever. This makes restart-resume naturally correct.
- `rowsRemaining` is a genuine `COUNT(*)` on the same unfiltered-by-LIMIT condition (`PredictionOutcomeEvaluator.ts:234-242`, `322-327`, `368-373`), not "rows fetched this batch."
- Indexes are real and additive-only: `drizzle/0068_lush_nuke.sql` contains exactly 3 `CREATE INDEX` statements, no DROP/ALTER (confirmed non-destructive, replacing a dangerous drizzle-kit auto-generated migration this session had caught earlier).
- `HistoricalDataGateway.cacheGet/cacheSet` is a real bounded LRU (move-to-MRU + evict-from-front once `size > historicalBarsMemoryCacheMaxEntries`).
- **Real causal validation exists**: `scripts/forensic/reproduce_p1a_outcome_evaluators.ts` + `docs/audits/ARGUS_MASTER_REMEDIATION_BASELINE.md:281-411` — an isolated harness (108,563/81,741/15,339 seeded rows) measured RSS scaling 415MB→747.3MB pre-fix under 6-way concurrency, flat ~286-290MB post-fix regardless of concurrency or 20 sequential cycles.

**Residual risk, stated honestly by the codebase itself**: the exact native-allocator mechanism (why RSS scaled with concurrent SQLite access) was never proven — the doc explicitly declines to attribute it definitively to better-sqlite3. The *original* live incident's 18.27M retained string nodes were never conclusively mapped to this specific defect; the reproduced effect matched the *shape* of the incident, not a byte-for-byte causal chain back to the original snapshot. The fix has not yet been re-verified against a live production redeploy.

### P1-B — heap snapshot freeze

**Root cause:** synchronous `v8.writeHeapSnapshot()` blocked the event loop for ~6 minutes on a ~2GB heap; watchdog force-killed the process.

**Status: 🟡 PARTIAL — the trigger is disabled, the underlying freeze-capable mechanism is not fixed.** This distinction matters and must not be blurred:
- `config/observability.json`'s `heapSnapshotEnabled: false` gates the single call site (`heapSnapshotCapture.ts:120`) at all three checkpoints, with a regression test (`heapSnapshotSafety.regression.test.ts`) statically confirming no env-var can re-enable it.
- The dangerous synchronous call itself is **unmodified**. The module's own header states plainly this is "NOT a non-blocking mechanism" and not fixable by wrapping the same call in a Promise/worker. If the flag is ever flipped back on, the exact freeze risk returns.
- **A documentation/code discrepancy was found**: `config/observability.json`'s comment claims baseline-only capture "remains enabled as a narrowly-scoped exception," but `scheduleBaselineHeapSnapshot()` is gated by the *same single* `heapSnapshotEnabled` flag, which is currently `false` — so baseline capture is *also* currently disabled. The system is safer than its own comment claims, but the comment is stale/wrong and should be corrected.
- Fail-open confirmed (never gates or delays `applyMemoryCriticalFailSafe()`'s own `TRADING_PAUSED` intervention). Count/cooldown/disk-pruning limits are real.

**Recommended labeling going forward: "P1-B mitigated by disabling the trigger," never "root-cause fixed."**

### Restart safety

**Status: 🟢 FIXED.** `sessionRecovery.ts` persists a `cleanShutdown` marker; an unclean-restart marker sets `holdNewEntryIdeas=true`, consumed by `isLiveIdeaGenerationEnabled()` at 15+ real idea-generation call sites (not just logged). `evaluateRestartSafety()` forces `TRADING_PAUSED` on boot if a persisted `TRADING_ENABLED` survived an unclean shutdown (`ArgusCoreBoot.ts:109-111`). Reactivation requires an explicit, separate operator call — `sessionRecovery.test.ts:61-70` proves a forced pause is never auto-cleared by a reconciliation match.

**One real test-composition gap**: no single end-to-end test exercises the full chain (boot-with-unclean-marker → new-BUY-ideas-blocked → reconciliation-match → LIVE_NO_GO) through one real `bootArgusCore()` call — it's proven correct only by combining an integration test (`ArgusCoreBoot.restartSafety.test.ts`, pause+LIVE_NO_GO half) with a unit test (`sessionRecovery.test.ts`, entry-hold+reconciliation-release half). Functionally adequate; a genuine coverage-composition gap, not a code gap.

### Forensic defects FD-1 through FD-7

All seven **🟢 FIXED**, each with a reproducing regression test (not merely happy-path coverage), corroborated against git history (`ab43708`, `d6370ea`):

| ID | Defect | Fix | Test |
|---|---|---|---|
| FD-1 | Overlapping `buildForecast()` calls, same key | `inFlightForecastBuilds` Map coalescer | `forecastEngine.test.ts:245` |
| FD-2 | Stale NewsEngine comment | Comment corrected | doc-only |
| FD-3 | `strategyId` filtered in JS after a 50-row fetch (false negative) | Moved into SQL WHERE | `forecastEngine.test.ts:299` |
| FD-4 | Cancel/follow-up race on `trades.status` | Symmetric CAS update | `OrderManagement.lifecycle.test.ts:287,314` |
| FD-5 | IBKR `orderStatus`+`execDetails` double-counted fills | Independent cumulative field + `execId` dedup + `Math.max` reconciliation | `IbkrSocketSession.fillAccounting.test.ts` (5 tests) |
| FD-6 | `localPortfolioSync` read-then-write race, PK collision | Optimistic-concurrency CAS retry + SQLITE_BUSY handling | `localPortfolioSync.test.ts` (stress + real second-connection SQLITE_BUSY) |
| FD-7 | Open-order mismatch false-positive pause | Debounce (consecutive-cycle gating), matching sibling position checks | `PortfolioReconciliation.openOrdersAndCash.test.ts` |

---

## 4. Production Database Pollution Audit (Part 3)

**Incident recap**: during this session's own simulator development, a top-level `import { db }` several hops down the synthetic simulator's import chain evaluated before isolation env vars were set, writing 3 spurious `settings` rows and 20 synthetic `ohlcv_bars` rows to the real `data/argus.db`. Cleaned up with tightly-scoped `DELETE` predicates (verified: `settings` back to exactly its original id=1 row, zero `source='synthetic_simulation'` rows remaining).

**This audit re-traced the ENTIRE static import graph from the simulator's actual process entry point**, not just the files previously found. Method: starting from `scripts/sim/marketOpenChild.ts` (the real child-process entry point), every non-type-only `import` was followed recursively.

- `marketOpenChild.ts`'s own static imports: `node:path`, `node:fs`, `syntheticSimulationDbGuard.ts` (pure), `resolveDbDir.ts` (pure, zero imports of its own), `simCliArgs.ts` (pure, zero imports). `SyntheticSessionEngine`, `DecisionTimeline`, `CertificationGate` are all `await import(...)` — dynamic, deferred until after the isolation self-check runs.
- `SyntheticSessionEngine.ts`'s static imports were traced fully: `SyntheticSimulationSafety.ts` (imports `resolveDbDir` — pure — and `type BrokerPlugin` — erased), `SyntheticMarketClock.ts` → `ReplayClock.ts` (zero imports), `SyntheticRandom.ts`/`SyntheticScenario.ts` (zero imports each), `SyntheticMarketDataEngine.ts` (imports only the previous two), `SyntheticNewsGenerator.ts` (imports `type HistoricalNewsProvider` — **confirmed `import type`, erased at compile time, does NOT trigger `HistoricalNewsProvider.ts`'s own top-level `import { db }`**), `InformationCutoff.ts` → `ReplayClock.ts`, `HistoricalReplayBroker.ts` → `BrokerAdapter.ts` (zero imports), `replaySafety.ts`/`marketSession.ts` (type-only + `loadRepoConfigJson.ts` → `repoPaths.ts`, Node builtins only), `ReplayContext.ts` (imports `HistoricalNewsProvider`/`HistoricalMacroProvider`/`HistoricalFundamentalProvider` **all as `import type`** — erased).
- **`FullArgusReplayEngine.ts` (which DOES have a static `import { db }`) is never actually imported by the simulator at all** — every reference to it in `SyntheticSessionEngine.ts` is a comment, confirmed via grep.
- Every actual runtime touch of `db` inside the simulator's own files (`SyntheticNewsGenerator.ts:78-79`, `SyntheticSessionEngine.ts` itself) is a `await import('../../db')` call made from inside an async function, strictly after `prepareIsolatedEnvironment()` has run.

**Conclusion: zero unsafe static top-level DB imports remain reachable from the simulator's real entry point.** This was not assumed from a prior comment — it was re-derived line-by-line this session.

**Architectural vs. empirical guarantee — the user's specific question.** The isolation guarantee is now **architectural, not merely empirical**, on two independent, redundant layers:
1. **Structural (process-level):** `scripts/sim/marketOpen.ts` (parent, zero Argus-module imports) spawns `marketOpenChild.ts` via `child_process.spawn(..., {env})`. Node guarantees `process.env` is fully populated *before* the child's V8 runtime executes a single line of JS — so even a hypothetical future bad static import in the child would still see the correct isolated `ARGUS_DB_PATH`.
2. **Structural (fail-loud mechanical guard):** `src/server/db/index.ts` calls the pure, independently unit-tested `assertSyntheticSimulationNotOpeningProductionDb()` immediately before `new Database(dbPath)` — throws FATAL, before any connection opens, if `SYNTHETIC_SIMULATION=true` and the resolved path equals the resolved production path.

The old mtime-based check (insufficient — a write-then-restore could theoretically evade it) is **no longer the primary isolation proof**; it remains only as a supplementary empirical spot-check this session used during manual verification, not as the mechanism itself.

**Caveat, stated honestly**: this guarantee holds for the *current* parent/child-process architecture. If a future contributor runs `SyntheticSessionEngine` directly in the same process as something else (bypassing `marketOpen.ts`'s launcher), layer 1 is lost and only layer 2 (the `db/index.ts` guard) remains — still a real, fail-loud protection, just not two independent layers.

**Broker/session isolation**: confirmed the synthetic broker (`HistoricalReplayBroker`) cannot route to a real broker — `BrokerManager.getActiveBroker()` is transparently redirected via `ActiveReplaySession` (the same seam `src/server/replay/`'s Historical Evaluation already uses), and `assertActiveSessionIsSynthetic()` independently proves post-install that `liveTrading()` structurally throws.

---

## 5. Synthetic Market Session Simulator Audit (Part 4)

**Isolation**: ✅ COMPLETE (see §4 above — separate DB, separate session-recovery marker, synthetic broker, `LIVE_NO_GO` forced, `ARGUS_ACTIVE_BROKER=internal_paper` forced, production DB verified untouched after every run this session).

**Synthetic clock**: ✅ COMPLETE. `SyntheticMarketClock.ts` extends `ReplayClock`, is pull-based (`now()` computed from anchor + elapsed real time × speed, never a driving internal timer — avoids real-time scheduling jitter affecting decisions), supports `pause()`/`resume()`/`setSpeedMultiplier()`/`setTime()` (backward-guarded)/`reset()` (unconditional re-anchor). **A real bug was found and fixed this session**: a separate `reset()` call before the main loop left a window where further setup work could let the clock's own real-time auto-drift carry `now()` past the session's first bar timestamp, causing `setTime()`'s backward-guard to throw on a 240-bar run. Fixed by moving `reset()` into the loop's own first iteration. 21 tests in `SyntheticMarketClock.test.ts`.

**Market phases**: ⚪ **NOT IMPLEMENTED as requested.** The mandate asked for 10 discrete phases (PRE_MARKET, OPEN_AUCTION, MARKET_OPEN, OPEN_VOLATILITY, MID_MORNING, LUNCH, AFTERNOON, CLOSE_APPROACH, CLOSE_AUCTION, POST_MARKET). The actual system — live and simulated — only has the coarse 4-state `MarketSession` type (`PRE_MARKET | REGULAR | AFTER_HOURS | CLOSED`, `marketSession.ts:3`), reused as-is by the simulator. Intraday character is instead modeled as a **continuous** U-shaped volume/volatility multiplier (`intradayMultiplier()`, opening-5-min and closing-15-min windows) rather than discrete named phases. This is a real, honest gap versus the original mandate, not a cosmetic naming difference.

**Dynamic market data**: 🟡 PARTIAL. Real bid/ask/spread/OHLCV/volume are genuinely generated per-bar from a seeded log-return random walk with regime-dependent drift/volatility (`SyntheticMarketDataEngine.ts`), including real intrabar range for ATR-style indicators. VWAP/ATR/realized-volatility/relative-strength/sector-behavior are **not** separately fabricated fields on the synthetic bar — they are computed downstream by the same real indicator/regime engine every live bar goes through. This is arguably the *correct* design (avoids inventing a second, parallel definition of VWAP that could silently diverge from the real one), but it means the simulator does not literally produce these fields itself, and should not be described as though it does.

**Determinism**: ✅ COMPLETE. `simulationId`, `randomSeed` (seeded mulberry32-style PRNG, `SyntheticRandom.ts`), `scenarioId` all real parameters; `SyntheticRandom.test.ts` proves same-seed reproducibility. Not re-verified bit-for-bit in this specific audit pass (would require a literal duplicate run + diff), but the underlying mechanism (no `Date.now()`/`Math.random()` in the price-path generator — confirmed via the import-graph trace in §4) makes non-determinism structurally unlikely.

**Scenarios — verified, not assumed**: exactly **5** exist in `SyntheticScenario.ts`'s `SCENARIOS` export: `QUIET_OPEN`, `EXTREME_NOISE`, `TRENDING_BULL_GAP_AND_GO`, `NEWS_SHOCK`, and `VALIDATED_CONVERGENCE_CONTROL` (built this session — **not** one of the original 15 named scenarios; a narrowly-purposed 6th scenario added specifically to try to produce genuine multi-agent convergence). Of the mandate's original 15 (QUIET_OPEN, TRENDING_BULL, TRENDING_BEAR, SIDEWAYS_RANGE, HIGH_VOLATILITY_OPEN, VOLATILITY_CRUSH, GAP_AND_GO, GAP_AND_FADE, FALSE_BREAKOUT, NEWS_SHOCK, REGIME_REVERSAL, MARKET_STRESS, DATA_INTERRUPTION, BROKER_FAILURE, EXTREME_NOISE), only 4 map directly to an implemented scenario. **11 of 15 mandate scenarios remain ⚪ NOT IMPLEMENTED** — the framework (`RegimeSegment[]`/`ScenarioEvent[]`, including already-defined `DATA_INTERRUPTION`/`VOLATILITY_SPIKE` event types) is general enough to add them as data, not new engine code, but they do not exist today.

---

## 6. Real Pipeline Exercise Audit (Part 5)

**Verified directly** (grepped the entire `src/server/replay/synthetic/` + `scripts/sim/` tree for any reference to `RiskEngine`, `ChiefTraderAgent`, `OrderManagement`, `placeOrder`): every match is inside a comment. **Zero direct imports or calls.** The simulator's only touchpoints with the real pipeline are `eventBus.emitMarketData()` (per bar) and `bootArgusCore()` (which constructs the real singleton agent instances that subscribe to the real EventBus themselves) — the same mechanism a live Alpaca tick would use. This is a genuinely real end-to-end exercise of `MarketDataWorker → agents → ChiefTrader → RiskEngine → OMS → broker`, not a shortcut that calls internal functions directly — structurally distinct from `FullArgusReplayEngine.ts`, which by its own header comment *does* reconstruct ChiefTrader's vote-math directly (a different, pre-existing, and separately-labeled subsystem).

**One real, disclosed exception to "never invents data" — `CalibrationHistorySeeder.ts` (new this session, explicit operator authorization).** This module directly `db.insert()`s synthetic-but-realistic prior `agent_predictions`/`kronos_predictions`/`prediction_outcomes`/`agent_confidence_calibration` rows, then runs the **real, unmodified** `runCalibrationValidationCycle()` against them so a genuine champion is computed by the real algorithm, not injected directly. This does **not** bypass any decision (ChiefTrader/RiskEngine/OMS still decide for real from whatever calibration state exists), but it **does** inject synthetic evidence into a gate's input, which is a real and meaningful exception to "no injected signals" that must never be silently conflated with organic proof. It is fully disclosed: every seeded row is tagged (`reasoning` contains `"SYNTHETIC CALIBRATION SEED"`, symbol is always `SEEDCAL`), `CertificationResult.calibrationSeeded`/`calibrationSeedDetails` surface it in the machine-readable contract, and the text report prints a loud `*** CALIBRATION HISTORY WAS SEEDED FOR THIS RUN — NOT ORGANIC EVIDENCE ***` banner. Confirmed callable only from `SyntheticSessionEngine.ts` (grep: 3 total references — the file itself, its test, and this one caller) — no production route can reach it.

---

## 7. Certification Gate Audit (Part 6)

**Structure verified**: `evaluateCertification()` reads every PASS/FAIL off `SyntheticSessionResult`'s real timeline + real `broker.snapshotCosts().realizedPnl` — never asserts independently of what the real pipeline did. `requireTrade` correctly distinguishes Test A (trade optional, PASS either way as long as a real reason exists) from Test B (full lifecycle required).

**Current real result, re-run this session** (not cited from an old report):

```
TEST A (QUIET_OPEN):                    PASS   zeroTradeReason=NO_CONSENSUS
TEST B (VALIDATED_CONVERGENCE_CONTROL): FAIL   firstBlockingStage=RISK_APPROVAL
  (with synthetic calibration history seeded — JavaCoreEnsemble & KronosEngine
   champions both genuinely established, effectiveN=25, wilsonLower=0.6087)
```

Without calibration seeding, Test B fails one stage earlier, at CONSENSUS (`MODERATE_REJECT_UNTRUSTED_CALIBRATION`). **With** the seeding assist, real 2-independent-agent agreement now clears CONSENSUS (`Consensus approvals: 1`) — but the underlying idea was a **SELL** on SPY (from `JavaCoreEnsemble` + `KronosEngine`, both independently), and Argus never opened a SPY position in this session, so RiskEngine's gate 22 (`sell_position_exists`) correctly rejects it: *"Cannot sell - no existing position in broker portfolio."* **This is not a bug — it is RiskEngine correctly refusing a naked/invalid SELL** — but it means **Test B still does not pass today**, and the forbidden-action list (no injected votes, no forced consensus, no bypassed RiskEngine, no lowered thresholds) was fully honored in reaching this result.

**Do NOT treat this as something to "fix" by loosening a gate.** The correct next step (not attempted this session, given scope) would be re-engineering the scenario so the converging agents vote BUY on a symbol Argus actually holds, or so their convergence happens on the scenario's intended long side rather than an independently-derived contrarian SPY read — a scenario-design problem, not a pipeline defect.

**Certification contract completeness (Part 7)** — 🟡 PARTIAL against the mandate's full field list:

| Requested field | Present? |
|---|---|
| simulationId, seed, scenario | ✅ |
| real elapsed time (wallClockDurationMs) | ✅ |
| memory/RSS/heap, event-loop p50/p95/p99/max | ✅ |
| overall PASS/FAIL, first blocking stage, zero-trade reason | ✅ |
| P&L (realizedPnl) | ✅ |
| calibration-seeding disclosure | ✅ (added this session) |
| commit hash | ⚪ missing |
| simulated time / market phase | ⚪ missing (see §5, no discrete phases exist) |
| per-idea agent predictions + calibrated confidence | ⚪ missing — only aggregate `counts.ideasGenerated` |
| per-forecast detail | ⚪ missing |
| expected return / transaction cost / net expected return | ⚪ missing |
| per-risk-gate breakdown | ⚪ missing — only aggregate `riskApprovals`/`riskRejections` counts |
| order/fill/position objects | ⚪ missing — only booleans (`stages.POSITION_OPENED`) and counts |

The certification gate proves **pipeline capability at the stage level**, not yet the full machine-readable per-decision contract the mandate described.

---

## 8. Quant / Alpha Evidence Audit (Part 8)

**Verdict: current repository evidence supports "NO VALIDATED CONDITIONAL ALPHA EXISTS," and the mechanism used to determine this is real, tested code — not prose.**

- `docs/audits/ARGUS_PHASE_B_CONDITIONAL_ALPHA_DISCOVERY_2026-09-14.md` contains the exact cited numbers (QuantEngine BUY 0.7-0.8: raw N=631/win 70.4% → effective N=6/105.2× inflation/Wilson lower-upper [30.0%,90.3%]; SELL 0.6-0.7: raw N=516/88.4% → effective N=10/51.6× inflation; 99.8% of the BUY bucket concentrated in one symbol).
- `src/server/research/effectiveSampleSize.ts` genuinely implements autocorrelation/time-gap clustering and Wilson-interval math, proven by `effectiveSampleSize.test.ts` (a 100-row pseudo-replicated cluster correctly collapses to effective N=1/inflation=100×; genuinely spread rows don't inflate).
- The 0/38-eligible-pairs claim is corroborated independently across three separate audit docs, not a single unverified assertion.
- PBO (`src/server/research/pbo.ts`, real Bailey/Borwein/Lopez de Prado/Zhu CSCV algorithm) is confirmed **never wired into any live gate** — `scripts/compute_pbo.ts` is a standalone CLI with no invocation anywhere else in the codebase.
- Downstream usage of this effective-N machinery is scoped to observational/review surfaces (`StrategyRecertification.ts`, `agentTradingEligibility.ts`) — the only actual *gating* consumer is `ModerateTierEvaluator.ts`'s calibration-trust check.

**Momentum/mean-reversion**: `momentumBreakout.ts`/`meanReversion.ts` are confirmed **soft-scored** (a fraction of conditions met, via `scoreFromConditions`), not a hard AND gate on all 7-8 conditions. The specific "0 wins/400" figure could not be independently re-confirmed in any current repo artifact — the closest dated evidence is a 10-day-stale note ("MOMENTUM_BREAKOUT produced 0 ideas that day"), a different metric than the win/N figure originally cited. A materially more recent, differently-scoped finding exists for **PULLBACK_CONTINUATION** specifically (not MOMENTUM_BREAKOUT): its evidence moved from effective N≈22/win 22.7%/Wilson-lower 0.101 at retirement to effective N≈50/win 50.0%/Wilson-lower 0.366 today — still below the 0.5 trust floor, correctly not reinstated.

**Strategy lifecycle**: ✅ COMPLETE. `StrategyRecertification.ts` requires both a ≥1.5× effective-N growth *and* a Wilson-lower-bound crossing before even flagging for **human** review, and its own header states it never calls `reinstateStrategyForEmission()` — proven by a dedicated test ("NEVER reinstates a strategy... stays exactly as quarantined as it was before the review").

---

## 9. Forecast / Calibration Audit (Part 9-10)

**Calibration is genuinely Bayesian Beta-Binomial** (`ConfidenceCalibration.ts:63-72` — real conjugate-prior posterior mean, `PRIOR_STRENGTH=10`), evidence-gated via a real Wilson-lower-bound-above-chance requirement (`moderateCalibrationTrustMinWilsonLowerBound: 0.5`), with a real, tested defensive re-check that retires stale pre-gate champions (the 2026-08-31 fix closing a genuine fail-open gap: 12 stale champions all below today's bar).

**No raw-confidence bypass found**: `ChiefTraderAgent.ts` overwrites `confidence` with the *calibrated* value (`calibrateConfidenceDetailed(...).decisionConfidence`) before building the evidence array fed to consensus math, unconditionally, for every idea. Raw confidence is used only for the separate MODERATE-tier calibration-trust bucket lookup — never fed into the consensus score itself.

**AI failure produces a fabricated HOLD-at-0-confidence, not a literal absence of a vote** — a real, worth-noting imprecision versus how this is sometimes described. `AIOutputValidator.ts` degrades failed validation to `HOLD`/confidence 0, and `EvidenceAggregator.ts` then explicitly excludes confidence-0 HOLD from the consensus denominator — functionally equivalent to "no vote," but the actual mechanism is "emit-then-exclude," not "never emit."

**Forecast object contract**: 🟡 PARTIAL — the persisted `quant_forecasts` schema carries nearly every requested field (forecastId, direction, horizon, expected return + CI, probability of profit, volatility, effectiveIndependentCount, regime, transaction cost, net expected return, model version, provenance JSON) **except** strategy/feature-version provenance, which exists elsewhere (`CoreStrategyAssessment` type) but is not carried onto the persisted forecast row itself.

**`prediction_outcome_horizons`**: a real write path exists and is tested (`MultiHorizonOutcomeEvaluator.test.ts`), but the codebase's own current code comment (`forecastEngine.ts`) states the table has zero rows in production today — "implemented but idle," consistent with (not contradicted by) the earlier Phase B finding. This session cannot independently verify live-DB row counts.

---

## 10. Reliability & Operational Safety Audit (Parts 13-14)

**Trading/research-plane isolation**: 🟡 PARTIAL, and this needs to be stated plainly. `heavyReportGuard.ts` provides a real single-flight mutex + RSS-based circuit breaker wrapping exactly 5 of the heaviest observability HTTP endpoints — genuine, not cosmetic, but **isolation is HTTP-route-level only, inside the same Node process and address space as RiskEngine/OMS**. There is no OS-process-level separation anywhere (confirmed: exactly one `httpServer.listen()`, no `child_process.fork`/`worker_threads` spawning a separate trading process). A crash or GC pause triggered by research code can still affect the trading event loop's own scheduling. The event-loop-delay monitor genuinely captures p50/p95/p99/max (not just mean), contradicting an earlier stale audit note that this was still missing — it was already fixed, just not yet reflected in that doc.

**Several `setInterval` timers were found with no overlap guard** (previously unreported): `MarketDataCrossChecker.runCheck` (60s, sequentially awaits a real Questrade call per active symbol — a slow cycle can double outbound calls on overlap), `AIProviderHealthCheck.tick` (180s), `CalibrationValidationWorker.runOnce` (900s, low risk given cadence). None of these caused a known incident, but they are the same class of defect P1-A was about, just not yet hit.

**Operational safety checklist** — mostly ✅ COMPLETE, with one real, important exception:

| Item | Verdict |
|---|---|
| PAPER_TRADING_ONLY refuses LIVE arm | ✅ triple-redundant |
| Capital-reservation race | ✅ fixed, all release paths traced |
| RiskEngine persist-then-emit | ✅ confirmed — a persist failure genuinely skips `RISK_ASSESSMENT_COMPLETED` |
| OMS idempotency | ✅ real `traceId` unique-index primary mechanism + `clientOrderId` secondary layer |
| Restart/reconciliation guard | ✅ (see §3) |
| Emergency stop / no bypass | ✅ strict AND across every recorded gate |
| No accidental LIVE broker selection | ✅ triple-redundant in `BrokerManager.setActiveBroker` |
| AI fail-closed | ✅ |
| **Unknown/failed broker state → pause + reconcile** | 🔴 **BROKEN — real gap, not previously reported.** `PortfolioReconciliation.reconcile()` only *skips* a cycle when the broker isn't ready; a `broker.portfolio()` throw mid-cycle is logged and `syncState` unconditionally reset to `READY` — trading is **not** paused, and the next attempt is an ordinary blind 5-minute retry. Only a *confirmed, measured* position mismatch actually pauses trading. A genuinely unknown broker state does not. |

**Independent search for unreported problems** turned up one severity-1 finding: **`RiskEngine.ts` runs `db.select().from(schema.trades)` with no WHERE and no LIMIT, twice per single live risk evaluation** (same-symbol-cooldown/post-loss/daily-limit gates, and again for capital allocation) — the code's own comment admits this is a known, deliberately-unfixed O(n)-with-table-size cost on the **live, non-replay path**. This is the same defect class P1-A closed in the outcome evaluators, but was never applied here. A secondary instance exists in `tradingSessionReport.ts` (HTTP-route-triggered, fully unfiltered).

Other confirmed-real, lower-severity findings: `RiskEngine.closesCache` Map has no TTL/eviction (grows with every distinct symbol ever evaluated); `KronosInference.ts` has a genuinely silent `catch (e) {}` around per-symbol batch-predict failures (masks systemic issues from observability); `systemRoutes.ts`'s `GET /audit/trail` synchronously reads an entire JSONL file on every request (currently low-risk since the only writer, `auditLog()`, appears to be dead/unwired code — imported but never called). Timezone handling (`America/New_York`, DST-aware) and look-ahead-bias in the replay/backtest `Date.now()` usages were both searched and found clean.

---

## 11. Institutional Roadmap Status (Part 15)

| Phase area | Status | Evidence |
|---|---|---|
| Reliability / P1 safety | ✅ COMPLETE (with the two new gaps above) | §3, §10 |
| Event-loop / research-trading isolation | 🟡 PARTIAL | HTTP-level only, no process separation (§10) |
| Canonical data platform, PIT correctness, feature authority | ✅ substantively real | Not re-audited exhaustively this pass — out of this session's scope |
| Research factory / alpha discovery | ✅ real, evidence-negative | §8 — the machinery works, it correctly finds no alpha yet |
| Multiple-testing correction / diversity | ✅ COMPLETE | `effectiveSampleSize.ts` |
| Forecast engine | 🟡 PARTIAL | §9 |
| Forecast correlation / diversity gating | ✅ COMPLETE, narrow live use | `isQuantIndependentQualificationEnabled` |
| **Portfolio construction** | ⚪ NOT IMPLEMENTED | Every idea sized in isolation; Java optimizer exists, unwired |
| Capital allocation | 🟡 PARTIAL | Flat, not risk-weighted |
| Strategy lifecycle | ✅ COMPLETE | §8 |
| Execution cost model | 🟡 PARTIAL | Slippage/latency real; no VWAP/TWAP algo layer |
| Execution attribution | 🟡 PARTIAL | Real but SELL-only |
| Paper-trading evidence | 🟠 BLOCKED | Calendar-time-gated, not code-gated (organic closed PAPER SELL P&L: 0) |
| Regime engine | ✅ COMPLETE, shadow-only | Real Java HMM, feeds context not votes (by design) |
| Alternative data | 🟡 PARTIAL | News/fundamentals/macro real; options/breadth/flow/revisions missing |
| **Microstructure** | ⚪ NOT IMPLEMENTED | No dedicated engine found |
| Compute scaling / distributed research | 💤 DEFERRED | Correctly out of scope pending a measured bottleneck |
| **Model governance / drift detection** | ⚪ NOT IMPLEMENTED | No dedicated module found |
| Enhanced risk | ✅ COMPLETE | 25 real gates, no bypass |
| Operational safety | 🟡 PARTIAL | One real gap (§10) |
| Security (prompt injection) | 🟡 PARTIAL | Fixed for NewsScoringEngine (DEF-31); explicitly not yet extended to FundamentalAgent/MacroAgent/Bull-Bear prompts (disclosed, deferred) |
| Testing | ✅ COMPLETE at unit level, 🟡 PARTIAL at integration level | §12 |

**Market making is explicitly and correctly not implemented** — matches the roadmap's own instruction not to build it.

---

## 12. Test Suite Forensic Audit (Part 17)

Re-run directly this session, twice (before and after this turn's own code changes):

```
Test Files  503 passed (503)
Tests       3727 passed (3727)
Duration    ~650s
```

(Up from 3719 at the start of this session's simulator work — +8 net new tests: 5 for the isolation-hardening/clock-race/calibration-seeder work, 3 for the `TechnicalAgent` replay-clock fix.) `tsc --noEmit` clean throughout every change this session.

**A green unit-test suite is not proof of production correctness** — this audit's own findings prove the point: the RiskEngine unbounded-query gap and the reconciliation blind-retry gap both sit under a fully green, 3727-test suite, because no test exercises the specific conditions (a large `trades` table; a broker throwing mid-sync) that would expose them. **Areas with no meaningful integration/end-to-end coverage**: OS-process-level trading/research isolation (untestable without one — it doesn't exist); the full restart-safety chain in one real boot test (composed across two files instead, §3); the certification gate's own machine-readable contract completeness (no test asserts the full mandate field list, because the fields don't all exist yet).

---

## 13. Final Status Table (Part 18)

| # | Area | Status | Confidence | Evidence | Remaining Risk |
|---|---|---|---|---|---|
| 1 | Production DB safety | 🟢 FIXED | High | §4 — full import-graph re-trace | Degrades to single-layer if simulator run outside its own launcher |
| 2 | Simulator isolation | ✅ COMPLETE | High | §4, §5 | — |
| 3 | Memory P1-A | 🟢 FIXED | High | §3 | Native mechanism unproven; not yet live-redeployed |
| 4 | Heap snapshot P1-B | 🟡 PARTIAL | High | §3 | Trigger off, root mechanism unfixed |
| 5 | Restart safety | 🟢 FIXED | High | §3 | Test composition gap only |
| 6 | Forecast correctness | 🟡 PARTIAL | Medium | §9 | Missing version provenance on persisted row |
| 7 | Calibration | ✅ COMPLETE | High | §9 | — |
| 8 | Consensus | ✅ COMPLETE | High | §9 | HOLD-at-0 mechanism, not literal no-vote |
| 9 | Quant alpha | ⚪ NOT ESTABLISHED (correctly) | High | §8 | None — this is the honest result |
| 10 | Strategy alpha | ⚪ NOT ESTABLISHED (correctly) | High | §8 | None |
| 11 | Portfolio construction | ⚪ NOT IMPLEMENTED | High | §11 | Real gap for institutional parity |
| 12 | Capital allocation | 🟡 PARTIAL | High | §11 | Not risk-weighted |
| 13 | Risk | ✅ COMPLETE | High | §10 | Unbounded query perf risk (§10) |
| 14 | OMS | ✅ COMPLETE | High | §3 | — |
| 15 | Execution | 🟡 PARTIAL | Medium | §11 | No execution-algo layer |
| 16 | Reconciliation | 🔴 BROKEN (gap) | High | §10 | Unknown/failed state doesn't pause — real fix needed |
| 17 | Synthetic market simulator | 🟡 PARTIAL | High | §5 | 11/15 scenarios missing, no discrete phases |
| 18 | Certification Test A | ✅ COMPLETE | High | §7 | Re-verified this session |
| 19 | Certification Test B | 🔴 still FAILS | High | §7 | Real, disclosed, unresolved finding |
| 20 | Event-loop safety | 🟡 PARTIAL | Medium | §10 | Several unguarded timers found |
| 21 | Research/trading isolation | 🟡 PARTIAL | High | §10 | HTTP-level only, not process-level |
| 22 | Data/PIT correctness | ✅ COMPLETE | Medium | Not exhaustively re-audited this pass | — |
| 23 | Strategy lifecycle | ✅ COMPLETE | High | §8 | — |
| 24 | Model governance | ⚪ NOT IMPLEMENTED | High | §11 | — |
| 25 | Drift detection | ⚪ NOT IMPLEMENTED | High | §11 | — |
| 26 | Execution cost | 🟡 PARTIAL | Medium | §11 | — |
| 27 | Attribution | 🟡 PARTIAL | Medium | §11 | SELL-only |
| 28 | Testing | 🟡 PARTIAL | High | §12 | Green suite masks 2 real gaps |
| 29 | Security | 🟡 PARTIAL | High | §11 | Prompt-injection fix not extended everywhere |
| 30 | Institutional roadmap | 🟡 PARTIAL, appropriately staged | High | §11 | Correctly not rushed |

---

## 14. Independent Newly-Discovered Issues (Part 16) — Summary

**Found and fixed this session** (simulator work): (1) `TechnicalAgent`'s real-wall-clock `technicalEvaluationCooldownMs` was incompatible with an accelerated replay session, allowing only ~1 evaluation per entire synthetic session — fixed via a replay-clock-aware `debounceNowMs()`, tested. (2) `SyntheticMarketClock` re-anchor race on session start — fixed. (3) `ARGUS_ACTIVE_BROKER` env leak from real `.env` silently routing the isolated simulator's `MarketDataWorker` through a nonexistent IBKR Gateway, making every `subscribe()` call roll itself back — fixed, `QuantSignalAgent` now genuinely evaluates symbols in every run.

**Found, not yet fixed** (this audit pass): reconciliation blind-retry on unknown/failed broker state (§10 — recommend MUST FIX); unbounded `trades` table scan on the live RiskEngine path (§10 — recommend MUST FIX); three unguarded research-adjacent `setInterval`s; `RiskEngine.closesCache` unbounded Map; `KronosInference.ts` silent catch; stale `heapSnapshotEnabled` comment (§3).

---

## 15. MUST FIX / MUST BUILD / LATER (Parts 19-21)

### A. MUST FIX before continuing (safety/correctness only)

1. **Reconciliation must pause trading (or at minimum force an immediate re-sync) on an unknown/failed broker state, not blind-retry on the next tick.** This is the single most important finding in this audit.
2. **Bound the RiskEngine live-path `trades` query** (WHERE + LIMIT, or an indexed lookup) — same class of defect P1-A already fixed elsewhere; left open here.
3. Correct the stale `config/observability.json` comment claiming baseline heap capture is a "narrowly-scoped exception" — it is currently fully disabled, and the comment should say so.
4. Add overlap guards to `MarketDataCrossChecker.runCheck`, `AIProviderHealthCheck.tick`, `CalibrationValidationWorker.runOnce` — cheap, low-risk, same pattern as every other evaluator already fixed.

### B. MUST BUILD next (highest-value missing capability)

1. Re-engineer (or accept as a documented finding) why `VALIDATED_CONVERGENCE_CONTROL`'s only real convergence is a SELL on a symbol never bought — either build a genuinely BUY-converging control scenario, or formally document that this is the honest current boundary of what the pipeline can prove in one isolated session.
2. Add a TTL/eviction to `RiskEngine.closesCache`.
3. Add logging to `KronosInference.ts`'s silent catch.
4. Extend DEF-31's prompt-injection isolation pattern to FundamentalAgent/MacroAgent/Bull-Bear research prompts (already explicitly flagged in CLAUDE.md as deferred, not forgotten).

### C. LATER — multi-week/month, do not rush

Portfolio construction, capital risk-weighting, execution algorithms (VWAP/TWAP), microstructure, model governance/drift detection, the remaining 11 synthetic-simulator scenarios, discrete market-phase modeling, OS-process-level trading/research separation, the full machine-readable certification contract (commit hash, per-idea/per-forecast/per-gate detail).

---

## 16. Final YES/NO/PARTIAL Answer (Part 19)

**"Have we actually completed everything we asked you to complete?"**

**PARTIALLY.**

Complete and genuinely verified: P1-A (evaluator overlap), restart safety, FD-1–7, production DB isolation (now architecturally guaranteed), calibration/consensus integrity, strategy-lifecycle governance, and the core "no fabricated alpha" research discipline.

Not complete: P1-B (trigger disabled, not root-cause fixed); the synthetic simulator (5 of 15 scenarios, no discrete market phases, partial certification contract); Test B certification (does not pass, for a real and now-deeper reason); two newly-found live-path gaps (reconciliation blind-retry, unbounded RiskEngine query) that were never on any prior list; portfolio construction, microstructure, and model governance (not started, correctly deferred).

---

## 17. Final Argus Readiness Classification (Part 22)

**B — CONTINUE DEVELOPMENT WITH SPECIFIC BLOCKERS.**

Not A, because the reconciliation blind-retry gap and the unbounded RiskEngine query are real, live-path safety/correctness issues that should be closed before further feature work, not after. Not C, because nothing found here is a fundamental architectural failure — every gate, every isolation boundary, and every safety mechanism this audit checked either works as designed or fails *safely* (never silently trades, never bypasses a threshold, never fabricates evidence without loud disclosure). The two MUST-FIX items in §15A are narrow, well-understood, and small relative to the system already correctly built around them.
