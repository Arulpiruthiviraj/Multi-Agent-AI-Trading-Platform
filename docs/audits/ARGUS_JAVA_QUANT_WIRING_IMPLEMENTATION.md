# ARGUS — Java Quant Core Wiring: Implementation Report (2026-09-10)

**Status update (same day, second pass): Phase 1 is now fully implemented, including the
tick-delivery sequencing/gap-detection/resync protocol originally left undone (see §"Phase 1
completion" below). Phase 6's AI/Quant availability state machine is now implemented. Phases 2-5
remain not implemented — they require real elapsed calendar time (live shadow soak, OOS/WFO) or
depend on evidence Phase 2/3 would produce, exactly as flagged the first time; nothing was
fabricated to check those boxes.** This document is the audit trail for the change; the
architecture rationale lives in `docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md` (not
repeated here).

## Phase 1 completion (tick sequencing, gap detection, resync)

The original pass deliberately routed around the RSI/MACD tick-delivery bug for the new
CORE-strategy path (bars fetched fresh per call). That was a legitimate scope decision for that
specific path, but left the underlying protocol gap itself unfixed. It is now fixed:

- **`QuantCoreBridge.ts`**: assigns a monotonic per-symbol sequence number to every tick
  (`nextSequence()`), sent alongside `POST /api/v1/ticks`. Tracks a parallel `volumeHistory` array
  (previously only prices were tracked locally). `forwardTick()` now returns a 3-way result
  (gap detected / no gap / call itself failed — previously collapsed into one boolean). On a
  reported gap, `resyncSymbol()` fires immediately (fire-and-forget); a 30-minute per-symbol
  safety-net resync also runs regardless of gap reports, in case a gap notification itself is lost.
- **`SymbolState.java`**: tracks `lastAppliedSequence`; a received sequence that isn't exactly
  `+1` is flagged (returned to the caller, never silently dropped — the tick is still applied
  either way). A new `resync(prices, volumes, sequence, timestampMs)` wholesale-replaces both
  `CircularDoubleArray`s via a new `reset()` method, so a resync is idempotent and self-healing
  regardless of how diverged the prior state was.
- **`QuantCoreServer.handleTicks`**: backward-compatible (`sequence` is optional — a caller not
  yet sending it never gets a false gap report); reports `gapDetected` in the tick response;
  accepts a `resync` object on the same route rather than adding a second endpoint.
- **Tests**: 3 new `CircularDoubleArrayTest` cases (reset semantics), 7 new `SymbolStateTest`
  cases (gap detection, reorder detection, resync clearing a prior gap), 4 new
  `QuantCoreServerTest` HTTP-level cases (backward-compat no-sequence tick, consecutive-sequence
  no-gap, skipped-sequence gap report, full resync-then-clean-continuation), 5 new TS
  `QuantCoreBridge.test.ts` cases (sequence assignment, gap-triggered resync, resync payload
  shape, fail-closed on unreachable Java). All passing — Java 780/780 total (0 failures, 0
  errors), TS 88/88 across the affected files.

**What this does not claim**: this is the *protocol* fix — real, tested, mechanically verified to
detect a skipped/reordered sequence and recover from it. It is not the same as "the RSI/MACD
shadow-parity divergence has been re-measured and confirmed fixed" — that requires the live engine
running with this protocol active over real trading sessions, exactly the same real-elapsed-time
constraint that applies to Phase 2/3's runtime evidence below. Re-running the same before/after
divergence-rate query from the prior forensic pass, once this has been live for real trading days,
is the concrete follow-up that would produce that evidence.

## Phase 6 completion (AI/Quant availability state machine)

Investigated before writing new code, per the mandate's own instruction not to assume the prior
audit's findings still hold: traced `AIRouter.routeConsensus()`'s internals and found the "partial
AI degradation causes an unnecessary fail-closed HOLD" gap flagged in the earlier audit pass was
**wrong** — `routeConsensus()` already excludes known-unhealthy providers (`filterRoutableProviders`
+ an `isKnownDead`/Offline-health exclusion) before fanning out to them, matching exactly what
`hasAnyRoutableProvider()`'s pre-check already predicts. `pushDebateFailClosed()` only fires when
providers already deemed routable genuinely fail at call time — a real signal, not an artifact of
stale health data. **No change was made to `ChiefTraderAgent.ts` or `AIRouter.ts`** — there was
nothing to fix, and this correction is recorded so the earlier finding isn't mistaken for still
current.

What was built instead: `src/server/core/aiQuantAvailability.ts` — `computeAiAvailability()`
(reuses `getAIProviderHealthSnapshot()`, derives `AI_HEALTHY`/`AI_DEGRADED`/`AI_UNAVAILABLE` from
healthy-vs-registered provider counts) and `computeQuantAvailability()` (`QUANT_HEALTHY`/
`QUANT_DEGRADED`; `QUANT_UNAVAILABLE` is intentionally never returned — no TS-side failure signal
exists for this pass to detect, and fabricating one would violate the "no fake validation" rule).
Wired into `GET /api/v2/runtime/health` (`aiAvailabilityState`, `quantAvailability` fields,
additive — the existing `aiProviderHealth` shape is unchanged, now computed via the shared
function instead of a second inline copy of the same logic). Pure observability — does not gate,
throttle, or influence any live decision. 9 new tests, all passing; 11/11 existing `v2Runtime`
route tests still pass (zero regression).

Every claim below is tagged `VERIFIED` (ran the code / test this pass), `VERIFIED BY TEST`,
`PARTIAL`, `PROPOSED` (designed, not built), or `UNVERIFIED`/`BLOCKED` (real gap, not glossed
over).

---

## Executive summary

The core architectural finding from the ADR — that Java's `features.*` package and
`strategy.types.StrategyContext` existed side-by-side with zero connecting code — is now closed.
Java can compute its own features from raw bars (never a TS-precomputed context) and run all 5
CORE strategies, reachable via two new, tested HTTP endpoints, combined through the **existing**
`QuantEnsembleEngine` correlation math. This is genuinely new capability, not a re-labeling.

**What this is not**: a fix for the separately-diagnosed RSI/MACD tick-delivery divergence bug (a
different data path — `SymbolState`'s raw tick accumulation, used only by the indicator-level
shadow comparison), a live vote (this stays shadow/observability-only, zero decision influence), or
a promotion of any strategy's status beyond what real evidence supports. All of Phases 2 (real
multi-day parity measurement), 3's runtime-evidence requirement, 4's "only after real runtime
evidence," 5 (OOS/WFO), and most of 6 require real elapsed calendar time or additional scoped work
this pass did not attempt — marked honestly below, not claimed.

---

## Before / after architecture

**Before**: `strategy.types.StrategyContext` had exactly one real constructor path outside test
fixtures — `StrategyContextCodec.decode()`, fed by a JSON body nothing in `src/` ever sent
(`/api/v1/evaluate` had zero real callers). The 5 CORE Java strategies were `REGISTERED_BUT_UNREACHABLE`.

**After**:
```
TS (QuantSignalAgent, already-fetched HistoricalDataGateway bars)
        │  POST bars (raw OHLCV, no precomputed features)
        ▼
QuantCoreServer /api/v1/quant/strategy/{id}/{symbol}  or  /api/v1/quant/ensemble/{symbol}
        │
FeaturesToStrategyContextAdapter.build(bars)
        │  calls, computes real features in Java:
        ├─ TrendFeatures.computeTrendFeatures(bars)
        ├─ MomentumFeatures.computeMomentumFeatures(bars)   ← NEW FILE, closes the roc/stochasticRSI gap
        ├─ VolatilityFeatures.computeVolatilityFeatures(bars)
        ├─ VolumeFeatures.computeVolumeFeatures(bars)
        ├─ PriceActionFeatures.computePriceActionFeatures(bars)
        ├─ SupportResistanceFeatures.computeSupportResistanceFeatures(bars)
        ├─ RegimeEngine.classifyRegime(bars)
        └─ MarketContext.getMarketContext(bars, ...)        ← only if caller supplies benchmark bars
        │
        ▼  maps into StrategyContext (14 documented field-shape/order mismatches handled explicitly)
StrategyRegistry.evaluate(strategyId, ctx)  →  real Java strategy decision logic (unchanged)
        │
        ▼
CoreStrategyRunner.Assessment  (or, for the ensemble route, 5x Assessment → QuantEnsembleEngine.combine())
        │
        ▼  HTTP response
QuantCoreBridge.fetchCoreStrategyAssessment() / fetchCoreEnsembleDecision()  — fail-closed, same
circuit-breaker pattern as every other bridge method
        │
        ▼  fire-and-forget, SHADOW ONLY
QuantSignalAgent.evaluateSymbol() logs QUANT_CORE_STRATEGY_PARITY_DIVERGENCE — zero influence on
the emitted idea, exactly like the existing compareRegimeParity() shadow call it sits next to.
```

`ChiefTrader`/`RiskEngine`/`OMS` are untouched — this path has no `emitTradeIdea` call anywhere.

---

## Section 2 — "independent implementation" vs. "independent evidence" vs. "independent production authority"

Per the operator's explicit instruction not to assume these are equivalent:

- **A. Independent implementation**: `VERIFIED`. Java now computes RSI/MACD/trend/volatility/etc.
  from raw bars via its own code path (`features.*`/`indicators.*`), not by consuming TS's
  computed values. This is what this pass built.
- **B. Independent evidence**: `UNVERIFIED`. No measurement of whether Java's and TS's CORE-
  strategy outputs carry meaningfully different information content (vs. simply reproducing the
  same signal on the same bars, which — since both implementations are byte-for-byte ports of the
  same formulas per the 2026-09-09 audit — is the more likely outcome for identical input data).
  Two independent *implementations* of the same deterministic formula on the same data are
  **not** independent *evidence* — they should (and, once real-bar parity is measured, are
  expected to) agree almost exactly. This is a real, important distinction the shadow-comparison
  logging (§ above) is specifically positioned to measure once real divergence data accumulates —
  not claimed as already measured here.
- **C. Independent production authority**: Unchanged, and correctly so — this path emits zero
  trade ideas. Nothing in this pass moved Java closer to production authority; it built the
  prerequisite plumbing a future, evidence-gated authority decision would need.

---

## Existing Sept-9 overrides — evidence-based assessment (not silently left alone, not silently changed)

Traced both fully in the ADR (§9/§10) and re-confirmed here: `JavaQuantAdvisoryService.
emitJavaQuantVoteIfEligible()` and `internalQuantEnsemble.ts`'s independence-qualification path
both consume bars fetched fresh via `historicalDataGateway`/passed explicitly per call — **neither
touches `SymbolState`'s tick-accumulation path**, the confirmed root cause of the RSI/MACD shadow-
parity divergence (§ Current Divergence, prior report). **Conclusion: no evidence from this pass's
investigation justifies moving either override into a degraded/disabled state.** This is an
evidence-based "no change justified" verdict, not an unreviewed pass-through — the operator's
instruction to assess rather than blindly leave alone is satisfied by giving a real answer, and the
real answer happens to be "not exposed to this specific risk."

**What this pass's new work does NOT change about those two overrides**: the new
`/api/v1/quant/strategy/`/`/api/v1/quant/ensemble/` routes are entirely separate from
`JavaQuantAdvisoryService`'s `factor_composite` path and from `internalQuantEnsemble.ts`'s
`JAVA_RESEARCH_STRATEGY_IDS` path — no shared code, no shared route, no interaction. The 5 CORE
strategies remain shadow-only; neither override was extended to consume them.

---

## Evidence matrix

| Requirement | Status | Evidence |
|---|---|---|
| Canonical data ownership (§4 of the mandate) | `VERIFIED`, decision made and documented | For the 5-CORE-strategy path specifically: TS-fetched `HistoricalDataGateway` OHLCV bars are canonical (same source `JavaQuantAdvisoryService`/`internalQuantEnsemble.ts` already safely use in production `SHADOW` status) — NOT `SymbolState`'s tick buffer, NOT `QuantCoreBridge.priceHistory`. Documented in this file's "Before/after" section and the ADR addendum. |
| Sequence synchronization / gap detection / resync / restart recovery (tick-level protocol) | `VERIFIED BY TEST` | Implemented same day, second pass (see §"Phase 1 completion" above): `QuantCoreBridge.ts` sequence numbering + gap-triggered/periodic resync, `SymbolState.java` gap detection + `resync()`, `CircularDoubleArray.reset()`. 19 new tests across Java (14) and TS (5), all passing. Real, mechanically-verified recovery from a skipped/reordered sequence — not yet re-measured against live divergence data (requires real elapsed trading time, same constraint as the runtime-evidence row below). |
| Java feature computation | `VERIFIED BY TEST` | `MomentumFeatures.java` (new), reusing `TrendFeatures`/`VolatilityFeatures`/`VolumeFeatures`/`PriceActionFeatures`/`SupportResistanceFeatures`/`RegimeEngine`/`MarketContext` (all pre-existing, JMIG-001). 7 tests in `MomentumFeaturesTest.java`, all passing. |
| StrategyContext adapter | `VERIFIED BY TEST` | `FeaturesToStrategyContextAdapter.java` (new). 6 tests in `FeaturesToStrategyContextAdapterTest.java`, specifically asserting against the raw `features.*` output (not hand-typed expected values) for the 5 documented field-order/shape mismatches (Structure event/trend swap, PriceVsMa diff-drop, Keltner reorder, Nearest reorder, Level abs-drop). All passing. |
| Momentum (roc/stochasticRSI) | `VERIFIED BY TEST`, resolved | Confirmed missing (repo-wide grep, zero matches) before this pass; now implemented, ported from `momentum.ts`'s exact formulas, tested against hand-computable values and null-on-insufficient-data/degenerate-range cases. |
| 5 CORE strategies (reachable, real-bars-driven) | `VERIFIED BY TEST` | `CoreStrategyRunner.evaluate()` runs `StrategyRegistry.evaluate()` (existing, unmodified strategy logic) against adapter-built contexts. HTTP-level tests in `QuantCoreServerCoreStrategyTest.java` (7 tests: 404 unknown id, 400 missing bars, `DATA_UNAVAILABLE` on insufficient history, a real BUY/SELL evaluation, ensemble combination, `UNAVAILABLE` status when nothing can evaluate). All passing. **Not yet**: individually wired/tested for `MOMENTUM_BREAKOUT`'s `marketContext` benchmark-bar path beyond the adapter's own null-safe handling (no benchmark bars supplied in these tests) — `PARTIAL`. |
| Runtime shadow evidence | `PARTIAL` | `QuantSignalAgent.ts` now fires a real `fetchCoreEnsembleDecision()` call every live evaluation cycle (`QUANT_JAVA_CORE_ENABLED` gated, fail-closed, zero decision influence — code reviewed, 27/27 existing `QuantSignalAgent` tests still pass). **No real accumulated divergence data exists yet** — this only started this session; a meaningful "runtime shadow evidence" claim requires real elapsed trading days, exactly as the ADR's own acceptance criteria state. Not fabricated. |
| Quant ensemble | `VERIFIED BY TEST` | `CoreStrategyRunner.runEnsemble()` reuses `QuantEnsembleEngine.combine()` (existing Kish/Grinold-Kahn math, unmodified) with strategy-family classification copied verbatim from `strategyFamilies.ts`'s `CORE_STRATEGY_FAMILIES` — no second correlation system. `status` (HEALTHY/DEGRADED/UNAVAILABLE) kept strictly separate from `direction` (BUY/SELL/HOLD), per the mandate's explicit requirement. |
| ChiefTrader integration | `NOT IMPLEMENTED, BY DESIGN THIS PASS` | Zero `emitTradeIdea` calls anywhere in the new code. The mandate's own Phase 4 explicitly gates this on "real runtime evidence" existing first, which (see row above) does not yet exist. Correctly left undone. |
| RiskEngine / OMS preservation | `VERIFIED` | No file under `src/server/engines/RiskEngine.ts`, `OrderManagement*`, or `BrokerManager`/adapters was touched. `grep`-confirmed zero new `placeOrder`/`emitTradeIdea` calls in any file this pass created or modified. |
| Feature/strategy parity (real captured market data) | `UNVERIFIED` | All new Java-side tests use deterministic synthetic bar series (disclosed in each test file's own header), not captured real market data — matching this pass's time budget, not a claim of real-data parity. A real measurement requires the shadow caller (now live) to accumulate real divergence samples over real trading days, same as the RSI/MACD precedent. |
| Failure handling | `VERIFIED BY TEST` | Insufficient history → `DATA_UNAVAILABLE`/`INSUFFICIENT_HISTORY` (never a fabricated HOLD), unknown strategy id → 404, malformed body → 400, zero-evaluable-strategies → ensemble `status: UNAVAILABLE`. Bridge-level: unreachable Java / non-2xx → `null`, fail-closed, tested. Java-side partial-strategy-failure (one strategy id failing mid-ensemble) is structurally isolated by construction (`evaluate()` never throws out of `runEnsemble()`'s loop — each call is independently try-free by design, returning a `DATA_UNAVAILABLE` Assessment rather than propagating an exception) but this specific scenario (a strategy that throws partway through, e.g. a bug in one `strategy/core/*.java` file) has no dedicated test — `PARTIAL`. |
| Quant health (HEALTHY/DEGRADED/UNAVAILABLE) | `VERIFIED BY TEST` | Both layers now real: `CoreStrategyRunner.EnsembleStatus` (per-ensemble-call) and the new `computeAiAvailability()`/`computeQuantAvailability()` module (process-wide, exposed via `/api/v2/runtime/health`). The originally-suspected `ChiefTraderAgent` partial-degradation gap was investigated and found not to exist (see §"Phase 6 completion" above) — corrected, not silently left as previously stated. 9 new tests. |
| Performance (p50/p95/p99) | `PARTIAL` | Still not measured for the two new routes specifically. However, `QuantCoreServerBenchmarkTest.java` (pre-existing, re-run this pass as part of the full suite) already provides real p50/p95/max figures for comparable existing routes: in-process RSI+MACD+Bollinger p50=5-6us/p95=9-10us; full HTTP round-trip GET /api/v1/indicators p50=3.6-3.7ms/p95=4.5-4.8ms; POST /api/v1/institutional/factors (200 bars) p50=5.5-5.8ms/p95=8.0-8.9ms. The new `/api/v1/quant/strategy`/`/api/v1/quant/ensemble` routes do comparable work (bars → features → strategy) and were not separately benchmarked — a real, bounded follow-up, not attempted this pass. |
| Backtest consistency (`JavaBacktestEngine`) | `VERIFIED, already correctly resolved` | Re-read this pass: `JavaBacktestEngine.java`'s own header already documents it as `ACTIVE, but scope-limited to RsiThresholdStrategy only` with `SignalDrivenBacktest.java` as the real generic successor for new strategy backtests — **not** a second competing "CORE strategies" backtest truth as the prior audit pass's framing implied. No change needed; correcting the record here rather than editing a file that was already accurate. |
| Documentation | `PARTIAL` | This file + the ADR addendum in `ARGUS_ARCHITECTURE.md`. `CLAUDE.md`/`README.md`/`ARGUS_QUANT_OWNERSHIP_MATRIX.md` were **not** updated this pass — a real gap, noted rather than silently skipped. |
| OOS/WFO validation | `BLOCKED — cannot be honestly produced without real elapsed data` | Not attempted. Fabricating this would violate the mandate's own §14. |
| Promotion funnel | `NOT IMPLEMENTED` | The 5 CORE strategies' status in `config/engineOwnership.json` was **not changed** — they remain exactly as unreachable-then-now-shadow-reachable as this pass's real evidence supports, nothing more. |

---

## Tests executed (this pass, cumulative across both sub-passes same day)

```
Java:  mvn -o test  →  780 tests, 0 failures, 0 errors  (746 baseline + 34 new:
       MomentumFeaturesTest ×7, FeaturesToStrategyContextAdapterTest ×6,
       QuantCoreServerCoreStrategyTest ×7, CircularDoubleArrayTest +3, SymbolStateTest ×7,
       QuantCoreServerTest +4)
TS:    npx tsc --noEmit  →  clean (both sub-passes)
       npx vitest run src/server/services/QuantCoreBridge.test.ts  →  52/52 passing (41 baseline + 11 new)
       npx vitest run src/server/services/QuantSignalAgent*  →  27/27 passing (0 new — regression check)
       npx vitest run src/server/core/aiQuantAvailability.test.ts  →  9/9 passing (new)
       npx vitest run src/server/routes/v2Runtime*.test.ts  →  11/11 passing (0 new — regression check on the route change)
```

## Files changed

**New:**
- `quant-core-java/src/main/java/io/argus/quantcore/features/MomentumFeatures.java`
- `quant-core-java/src/main/java/io/argus/quantcore/server/FeaturesToStrategyContextAdapter.java`
- `quant-core-java/src/main/java/io/argus/quantcore/server/CoreStrategyRunner.java`
- `quant-core-java/src/test/java/io/argus/quantcore/features/MomentumFeaturesTest.java`
- `quant-core-java/src/test/java/io/argus/quantcore/server/FeaturesToStrategyContextAdapterTest.java`
- `quant-core-java/src/test/java/io/argus/quantcore/server/QuantCoreServerCoreStrategyTest.java`
- `quant-core-java/src/test/java/io/argus/quantcore/server/SymbolStateTest.java`
- `src/server/core/aiQuantAvailability.ts`
- `src/server/core/aiQuantAvailability.test.ts`
- `docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md` (prior pass, this session)
- `docs/audits/ARGUS_JAVA_QUANT_WIRING_IMPLEMENTATION.md` (this file)

**Modified:**
- `quant-core-java/src/main/java/io/argus/quantcore/server/QuantCoreServer.java` — 2 new CORE-strategy routes + handlers + JSON serializers (first sub-pass); `handleTicks` extended with sequence/gap/resync handling, backward-compatible (second sub-pass).
- `quant-core-java/src/main/java/io/argus/quantcore/server/SymbolState.java` — sequence tracking, gap detection, `resync()`; defensive bound fix in `windowedVwap`.
- `quant-core-java/src/main/java/io/argus/quantcore/buffers/CircularDoubleArray.java` — new `reset()` method.
- `quant-core-java/src/test/java/io/argus/quantcore/buffers/CircularDoubleArrayTest.java` — 3 new tests.
- `src/server/services/QuantCoreBridge.ts` — 2 new methods + 2 new exported interfaces (first sub-pass); sequence numbering, gap-triggered + periodic resync, `resyncSymbol()` (second sub-pass) — all additive, existing method signatures unchanged from any external caller's perspective.
- `src/server/services/QuantCoreBridge.test.ts` — 11 new tests total.
- `src/server/services/QuantSignalAgent.ts` — 1 import added, 1 new fire-and-forget shadow block added (no existing logic modified).
- `src/server/routes/v2Runtime.ts` — `/runtime/health` route now computes AI health via the shared `computeAiAvailability()` function instead of an inline duplicate; adds `aiAvailabilityState`/`quantAvailability` fields, additive.
- `docs/architecture/ARGUS_ARCHITECTURE.md` — ADR pointer addendum (prior pass, this session).

**Not touched** (verified by review, not assumed): `RiskEngine.ts`, `OrderManagement*.ts`, `BrokerManager`/adapters, `ChiefTraderAgent.ts`, `AIRouter.ts`, `config/tradingSafety.json`, `config/riskGateOrder.json`, any file under `src/server/quant/strategies/` (TS strategy logic unchanged), any Java `strategy/core/*.java` (strategy decision logic unchanged).

---

## Remaining known limitations (named, not hidden)

1. The RSI/MACD tick-delivery divergence **protocol** is now fixed and tested, but the divergence
   itself has not been re-measured against real live traffic — that requires real elapsed trading
   days with this protocol active, which cannot be produced in this session.
2. No real captured-market-data parity evidence exists yet for the new CORE-strategy path — only
   synthetic-bar unit tests.
3. `MomentumBreakout`'s `marketContext` (SPY/QQQ/IWM/sector benchmark bars) path is wired in the
   adapter but has no dedicated end-to-end test with real benchmark data supplied.
4. Performance/concurrency measurement for the two new CORE-strategy routes specifically not done
   (comparable existing-route benchmarks exist and were re-run clean — see the evidence table).
5. `CLAUDE.md`/`ARGUS_QUANT_OWNERSHIP_MATRIX.md`/`README.md` not updated with this new capability.
6. No promotion-funnel status change — correctly so, given limitation #2.
7. `ChiefTraderAgent.ts`'s Phase 4 (ensemble → live vote) remains, correctly, not implemented — the
   mandate's own explicit precondition ("only after real runtime evidence") is not met.

## Architectural recommendation (mandate §16 — A/B/C/D)

**B: Java primary quant-authority *direction*, TS deterministic fallback/comparator — reaffirming the ADR, not revised by this pass's findings.** Nothing built this pass changes the ADR's reasoning (§2/§17 there): TS's `StrategyEngine.ts` remains the only quant path with zero external-process dependency, a real resilience property worth keeping regardless of how far Java's feature/strategy execution matures. This pass is a concrete step toward B (Java now has a real execution path for its own features), not a completed migration — recommend continuing to withhold any `emitTradeIdea` wiring until real shadow-parity evidence (limitation #2) exists, per the mandate's own Phase 4 gate.

---

## Phase 3 — Real independent vote (2026-09-10, third pass, explicit operator override)

**Status update: the recommendation directly above ("continuing to withhold any `emitTradeIdea` wiring") was explicitly overridden by the operator this same day, via a detailed, repeated, informed authorization mandate ("ARGUS — Autonomous Java Quant Engine Wiring") that was told this exact gap and precondition directly and chose to proceed anyway — the same pattern already established twice in this deployment for `JavaFactorComposite` and `ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED` (2026-09-09, see `CLAUDE.md`'s Java 26 Engine Authority section).**

### What was verified before building (per the mandate's own instruction to verify rather than repeat the investigation)

The mandate's own "verified findings" section, sourced from an investigation not conducted in this visible session, asserted several gaps (missing Price ROC, missing Stochastic RSI, no sequence-number protocol, no `FeaturesToStrategyContextAdapter`) that were **already closed in this session's own earlier passes** (see "Phase 1 completion" above and the original implementation section). Confirmed live by direct code inspection before writing anything new:
- `MomentumFeatures.java` already has `calculateROC`/`calculateStochasticRSI`, ported from `momentum.ts`.
- `CoreStrategyRunner.java` / `FeaturesToStrategyContextAdapter.java` already exist and are tested.
- `QuantCoreBridge.ts` already has the sequence-number/gap-detection/resync protocol.
- **More importantly: `QuantSignalAgent.ts` was already calling `quantCoreBridge.fetchCoreEnsembleDecision()` — the real Java `CoreStrategyRunner.runEnsemble()` path, computing its own features from canonical bars via `FeaturesToStrategyContextAdapter`, never fed TS's precomputed `StrategyContext` — on every real production evaluation cycle.** This was the "Phase 2/3 shadow comparison" already built and running (`QUANT_CORE_STRATEGY_PARITY_DIVERGENCE`, ~99 real observations documented in `ARGUS_JAVA_QUANT_PHASE2_PRELIMINARY_PARITY_2026-09-10.md`). The gap was never "make Java callable" — it already was. The gap was that the real result never reached a vote.

### What was built

`src/server/services/JavaCoreEnsembleVoteService.ts` (new) — `emitJavaCoreEnsembleVoteIfEligible()`, mirroring `JavaQuantAdvisoryService.emitJavaQuantVoteIfEligible()`'s exact established pattern:
- One real, independent `TRADE_IDEA_GENERATED` vote (agent `JavaCoreEnsemble`) per eligible Java CORE-ensemble decision, through the unchanged `eventBus.emitTradeIdea()` → `ChiefTraderAgent` → `RiskEngine` → `OMS` spine — never a `CHIEF_APPROVED_IDEA`, never a `placeOrder` call from this module.
- Gated behind **four** independent checks (one more than the `JavaFactorComposite` precedent, since Java's own `status` field is a real, additional gate here): `ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED` (master flag, off by default), `isPipelineAgentEnabled('JavaCoreEnsemble')` (Mission Control toggle), `isLiveIdeaGenerationEnabled()` (Autobot/session-recovery/campaign-lock composite), and `ensemble.status === 'HEALTHY'` (never votes on `DEGRADED`/`UNAVAILABLE` — insufficient bar history is never conflated with a directional HOLD, matching the mandate's own §22 requirement).
- Even when all four pass: `direction !== 'HOLD'` and `confidence >= javaCoreEnsembleVoteMinConfidence` (0.6, reusing the same reasoned policy value `javaQuantVoteMinConfidence` already established, not a new invented number) must also hold.
- Wired into the exact call site already computing the shadow comparison in `QuantSignalAgent.ts` (inside the existing `fetchCoreEnsembleDecision().then()` callback, right after the parity-logging call) — wrapped in its own `try/catch` so a failure here can never propagate into the surrounding TS evaluation.

**Distinctness from `JavaFactorComposite` (mandate §25/§27 requirement — no double-counting):** genuinely different Java engine (`CoreStrategyRunner`'s 5 CORE technical/momentum/mean-reversion strategies vs. `FactorAlphaEngine`'s 5-factor GARCH/HMM/factor-composite model), different underlying features, different math, gated by an entirely separate flag and Mission Control toggle. Both can, in principle, vote on the same symbol in the same cycle — that is two independent Java-sourced opinions from two different models, not one signal counted twice.

**Real evidence base at time of enablement (disclosed, matching the existing precedent's own disclosure discipline):** ~99 shadow observations over ~4 hours (`ARGUS_JAVA_QUANT_PHASE2_PRELIMINARY_PARITY_2026-09-10.md`) — short of this deployment's own documented "multi-week clean shadow-divergence-tracking window" precondition (`docs/architecture/ARGUS_ARCHITECTURE.md` § Java Quant Core). The operator was told this directly, in this exact document, before this override.

### Configuration added

| File | Addition |
|---|---|
| `src/server/config/tradingSafety.ts` / `config/tradingSafety.json` | `javaCoreEnsembleVoteMinConfidence` (0.6), `javaCoreEnsembleVoteEnabledEnvVar`, `isJavaCoreEnsembleVoteEnabled()` |
| `config/pipelineAgents.json` | New `JavaCoreEnsemble` togglable idea agent entry |
| `src/server/core/pipelineAgentRuntime.ts` | No-op start/stop registration (same shape as `JavaFactorComposite`/`TradePlanBuilder` — the real gate is inline in the vote function itself) |
| `.env.example` | `ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED=false` (off by default) |

### Tests

`src/server/services/JavaCoreEnsembleVoteService.test.ts` (new, 10 tests): every gate (`FLAG_OFF`, `AGENT_DISABLED`, `IDEA_GENERATION_GATED`, `NOT_HEALTHY` for both `DEGRADED` and `UNAVAILABLE`, `HOLD_DIRECTION`, `BELOW_MIN_CONFIDENCE`, `INVALID_PRICE`), plus real BUY and SELL emission proofs asserting the exact `TRADE_IDEA_GENERATED` payload shape.

### Safety diff review (mandate §41)

`git diff config/tradingSafety.json` is purely additive (+4 lines, 0 modified/deleted) — `consensusApprovalThreshold` and `minIndependentAgreeingAgents` show zero diff. `RiskEngine.ts`, `OrderManagement.ts`, `BrokerManager.ts` show zero diff for this session. Confirmed directly via `git diff`, not asserted.

### Evidence matrix (mandate §43 format — only rows this pass has real evidence for; see the mandate's own required statuses)

| Requirement | Status | Evidence |
|---|---|---|
| Canonical data source | VERIFIED | `QuantCoreBridge.ts` sequence protocol, built and tested earlier this session |
| Sequence numbers / gap detection / resync | VERIFIED | Existing tests, `QuantCoreBridge.test.ts`/`SymbolStateTest.java` |
| Java FeatureEngine (canonical bars → Java features, not TS passthrough) | VERIFIED | `FeaturesToStrategyContextAdapter.java` consumes `features.*` output computed from bars supplied to `CoreStrategyRunner.evaluate()`, never a TS `StrategyContext` |
| RangeReversion / PullbackContinuation / TrendFollowing / MomentumBreakout / MeanReversion callable | VERIFIED | `CoreStrategyRunner.java`, unit-tested |
| Price ROC / Stochastic RSI | VERIFIED | `MomentumFeatures.java`, ported and cited against `momentum.ts` |
| Java ensemble (`QuantEnsembleEngine`, correlation-adjusted `effectiveIndependentCount`) | VERIFIED | Reused, not duplicated - same engine `internalQuantEnsemble.ts` already uses |
| Node bridge | VERIFIED | `quantCoreBridge.fetchCoreEnsembleDecision()`, already a real production call site before this pass |
| Real production shadow invocation | VERIFIED | `QUANT_CORE_STRATEGY_PARITY_DIVERGENCE`, ~99 real observations |
| Independent vote reaches `TRADE_IDEA_GENERATED` | VERIFIED | This pass - `JavaCoreEnsembleVoteService.ts`, 10 tests, real `eventBus.emitTradeIdea()` call confirmed |
| ChiefTrader/RiskEngine/OMS preservation | VERIFIED | Safety diff review above; unchanged consensus threshold/independence floor |
| Status (HEALTHY/DEGRADED/UNAVAILABLE) never conflated with direction (HOLD) | VERIFIED | `NOT_HEALTHY` is a distinct rejection reason from `HOLD_DIRECTION`, both directly tested |
| Feature/strategy parity against real captured market data | INSUFFICIENT_DATA | Only the ~99-observation shadow sample exists; no dedicated real-bar parity suite built this pass |
| Restart recovery under this new vote path specifically | UNVERIFIED | Not exercised this pass - the underlying resync protocol was tested earlier this session, but not through this new vote code path specifically |
| Performance (p50/p95/p99) for the vote path | UNVERIFIED | Not measured - the vote function itself is a synchronous, no-I/O eligibility check; the real latency is in the already-existing `fetchCoreEnsembleDecision()` call, unchanged by this pass |
| Concurrency / cross-symbol isolation for the new vote path | UNVERIFIED | Not specifically tested this pass; reuses the same per-symbol `SymbolState` concurrency model already covered by earlier tests |
| Live runtime evidence (real votes actually emitted in the live process) | UNVERIFIED | Flag is off by default; enabling it and observing real votes was not done this pass (would require a live restart and real elapsed market time) |
| Real trades resulting from this vote | BLOCKED | Requires real elapsed market time after the flag is enabled; cannot be produced in this session |

### What remains explicitly not done (honest, not hidden)

- The flag (`ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED`) is **off by default** — this pass makes the vote *possible*, not *active*. Turning it on is a separate, explicit operator action.
- No dedicated real-captured-bar parity suite for the CORE-ensemble path specifically (mandate §15) — only the existing synthetic-fixture strategy tests plus the ~99-observation live shadow sample.
- MomentumBreakout's benchmark/sector market-context dependency (SPY/QQQ/IWM bars) is wired in the adapter (confirmed earlier this session) but has no dedicated end-to-end real-benchmark-data test.
- Java restart-recovery, concurrency, and performance measurement specifically through this new vote code path were not exercised this pass (the underlying protocol they depend on was tested earlier this session, but not re-verified through this exact new entry point).
- The full 45-section "Autonomous Java Quant Wiring" mandate and the separate 37-section "Full Current Architecture + Today Trading Opportunity" forensic audit both requested alongside it were not completed in full this pass — this document covers the single highest-value concrete gap identified (the missing vote link), consistent with this session's established discipline of shipping real, tested, verified increments rather than a fabricated one-shot completion claim across 82 combined sections.
