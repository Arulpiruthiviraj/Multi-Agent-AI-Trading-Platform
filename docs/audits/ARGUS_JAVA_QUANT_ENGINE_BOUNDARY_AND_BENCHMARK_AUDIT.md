# ARGUS — Java Quant Engine Boundary + Performance Baseline Audit (Supplement)

Read-only synthesis. No trading state, config, or `.env` was touched while producing this. This supplements — does not duplicate — `docs/audits/ARGUS_JAVA_PYTHON_NODE_PERFORMANCE_BOUNDARY_AUDIT.md` (the first architecture pass); this document goes calculation-by-calculation and, unlike the first pass, now has **real measured numbers** (see §11/§13) gathered immediately before this report was written.

---

## 1. Java vs Node Quant Code Comparison

| Calculation | Node implementation | Java implementation | Duplicate? | CPU cost | Frequency | State | Parallelizable | Java advantage | Recommendation |
|---|---|---|---|---|---|---|---|---|---|
| RSI | `RSIEngine.ts` (live), `technicalSignal.ts` | `io.argus.quantcore.indicators.RSI` | Parity pair (intentional, shadow-compared) | Trivial (measured p50=4us for RSI+MACD+BB combined, §11) | Per tick/timer, per symbol | Rolling window | Yes, per-symbol | Negligible at measured cost | **D: Node+Java parity (already correct)** |
| MACD | `MACDEngine.ts` | `io.argus.quantcore.indicators.MACD` | Parity pair | Trivial | Per tick/timer | Rolling window | Yes | Negligible | D (already correct) |
| SMA/EMA | `technicalSignal.ts` (`calcBollingerBands`, SMA helpers), Java `Bollinger`/rolling-mean utilities | Inline in `FactorAlphaEngine`/`Bollinger.java` | Effectively duplicated math (mean/stdev), not a formal parity pair | Trivial | Per tick + per institutional-factor call | Windowed | Yes | Negligible | A: Node (live); Java's copies are internal helpers to its own institutional engines, not a separate migration target |
| Bollinger Bands | `technicalSignal.ts` | `io.argus.quantcore.indicators.Bollinger` | Parity pair | Trivial | Per tick | Windowed | Yes | Negligible | D (already correct) |
| ATR | `TechnicalIndicators.ts` (real OHLC bars) | `SymbolState.tickRangeAtr` (tick-range approximation, **explicitly documented as NOT the same number**) | **Not a true duplicate** — different inputs (bars vs. degenerate tick-range) | Trivial | Per tick (Java) / per bar (Node) | Windowed | Yes | None — Java's version is a lesser approximation today | **A: Node remains authoritative.** Java's ATR is honestly disclosed as non-equivalent; do not promote it to parity status without a real bar feed into Java |
| ADX | Not found as a standalone Node module in the live path (regime/trend classification uses other signals) | Not found in `quant-core-java/` | N/A | N/A | N/A | N/A | N/A | N/A | **Neither exists today** — do not assume ADX parity work is in progress |
| Volatility (realized/rolling) | `quant/RegimeEngine.ts` and related feature files | `GarchEngine` (GARCH(1,1)), `FactorAlphaEngine`'s volatility factor | Not duplicated — Node's is a feature input to regime/strategy code; Java's GARCH is a genuinely different, heavier statistical model | GARCH fit is real CPU work (Nelder-Mead optimization) | On-demand (not per-tick) | Stateless per call | Yes | **Real** — this is exactly the kind of numeric-fit workload a JVM helps with | **B: Java** (already built, now HTTP-reachable) |
| Momentum | `TechnicalAgent`'s momentum-breakout rule; `FactorAlphaEngine`'s momentum factor | `FactorAlphaEngine.compute()` | Conceptually parallel, not literally duplicated (different math: breakout rule vs. Z-scored trailing return) | Low (Java) | On-demand | Stateless | Yes | Modest | **D/F**: keep TS authoritative for the live BUY/SELL rule; Java's factor version is a separate, additive research signal (not a duplicate to reconcile) |
| Trend calculations | `RegimeEngine.ts`, `quant/strategies/TREND_FOLLOWING` | None dedicated (HMM's BULL/BEAR_TRENDING labels are the closest analog) | Not duplicated | Low-moderate | Per evaluation cycle | Some rolling state | Yes | Low today | A: Node |
| Mean reversion | `quant/strategies/MEAN_REVERSION`, `FactorAlphaEngine`'s mean-reversion factor | `FactorAlphaEngine.compute()` | Conceptually parallel | Low | Per evaluation / on-demand | Stateless (Java) | Yes | Modest | D/F, same reasoning as momentum |
| Breakout / Pullback | `quant/strategies/MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION` (TS + Java **CORE strategy ports**, real parity-tested) | `io.argus.quantcore.strategy` package | **Real, intentional parity pair** (5 CORE strategies) | Low | Per `QUANT_ENGINE_ENABLED` cycle | Stateless per evaluation | Yes | Low at current volumes | **D: TS authoritative + Java parity (already the exact existing design, confirmed by `StrategyParityTest.java` convention)** |
| Regime detection | `lightweightRegimeClassifier.ts`, `RegimeEngine.ts` (rule-based, cheap) | `HmmRegimeEngine` (4-state Gaussian HMM, Baum-Welch EM — genuinely heavier) | **Not a duplicate** — different techniques, different cost profiles | Moderate-high (Java, EM iterations) | On-demand | Stateless per fit | Bounded (EM iterations are inherently sequential per fit, but multiple symbols parallelize) | **Real** — EM is a legitimate numeric-fit workload | **B: Java** (already built, now HTTP-reachable). Node's classifier stays as the cheap, always-on live signal; Java's HMM is a heavier, on-demand research-grade alternative, not a replacement |
| Statistical arbitrage / cointegration | None found in the live Node path | `StatArbEngine` (Engle-Granger, ADF, OU half-life) | **Not duplicated — Java-only capability** | Moderate | On-demand | Stateless | Yes (per pair) | Real — this doesn't exist in Node at all | **B: Java is the only implementation; nothing to migrate** |
| Factor calculations | Ad hoc scoring inside individual `quant/strategies/*` files | `FactorAlphaEngine` (5-factor composite) | Not a formal duplicate — Java's is a distinct, more structured composite | Moderate | On-demand | Stateless | Yes | Real for the composite Z-score math | B (already built) |
| Correlation / covariance | `RiskEngine`'s `correlation_exposure` gate (coarse `SECTOR_MAP`-based, cheap) | `EwmaCovariance.java` (real EWMA covariance estimator) | **Not duplicated** — Node's is a cheap sector-overlap heuristic for a risk gate; Java's is a real statistical estimator with no live Node caller yet | Node: trivial. Java: moderate | Node: per risk evaluation. Java: unused today | N/A | Yes | Real for Java's version, but it has **zero current consumer** | F: shared-data-contract candidate for a future portfolio-analytics feature — not yet wired to anything, calculation exists but purposeless until a caller exists |
| Portfolio calculations (equity, drawdown, exposure) | `PositionSizing.ts`, `RiskEngine.ts` gates, `HistoricalReplayBroker.portfolio()` | None found | N/A | Low (Node) | Every risk evaluation | Node's DB-backed portfolio state | Low value to parallelize | None | **A: Node, must remain** — this is intertwined with RiskEngine authorization, not a pure calculation (see §4) |
| Position sizing | `PositionSizing.ts` (FIXED_DOLLAR / PERCENT_OF_EQUITY, cheap arithmetic) | None found | N/A | Trivial | Every BUY evaluation | Stateless per call | N/A | None | **A: Node, must remain** — feeds directly into RiskEngine gate 21, an authorization boundary |
| Alpha scoring | No single "alpha score" in Node; scattered across strategy confidence + ChiefTrader weighting | `FactorAlphaEngine.composite()` is the closest thing to a real, unified alpha score in this codebase | Not duplicated — Node has no equivalent composite | Moderate (Java) | On-demand | Stateless | Yes | Real, and arguably Java is **ahead** of Node here | F: this is a genuine candidate to eventually feed ChiefTrader's reasoning context (never its vote — see §4) |
| Signal aggregation / consensus | `EvidenceAggregator.aggregate()`, `ChiefTraderAgent` | None (by design — see §16) | N/A | Trivial | Every consensus cycle | Stateless | N/A | None | **A: Node, must remain, permanently** |

**Key correction versus a naive reading of file names:** several Java "calculations" (ATR, ADX, portfolio/position sizing) either don't exist in Java at all, or exist in a form explicitly disclosed as non-equivalent to Node's. Treat the presence of a Java class name as evidence of *a* calculation, never evidence of *parity* with Node's — parity is a status this codebase requires an explicit test to claim (`StrategyParityTest.java` convention), not an assumption.

## 2. The Real Java Boundary (per component)

| Component | Boundary | Why |
|---|---|---|
| RSI/MACD/Bollinger | D — Node+Java parity (already correct) | Trivial CPU cost (§11), already shadow-compared, no reason to change |
| ATR | A — Node authoritative | Java's version is a different, lesser approximation; promoting it would require a real bar feed into Java first |
| GARCH volatility | B — Java | Genuine numeric-fit workload; no Node equivalent exists to duplicate |
| HMM regime | B — Java | Genuine EM-fit workload; Node's classifier is a different, cheaper live signal, not competing |
| StatArb/cointegration | B — Java (sole implementation) | Doesn't exist in Node; nothing to reconcile |
| Factor composite / "alpha" | F — shared data contract, research-only for now | Real capability, zero current consumer; wiring it to ChiefTrader's *reasoning* (not vote) is the natural next step, not yet done |
| Correlation/covariance (EWMA) | F — shared data contract, unused | Real Java estimator, zero caller; RiskEngine's own correlation gate stays A (Node, cheap heuristic, authorization-adjacent) |
| 5 CORE strategies | D — TS authoritative + Java parity (already the existing, correct design) | This is not a hypothetical — it's the current architecture, confirmed by the parity-test convention already in place |
| Portfolio/position sizing/consensus/RiskEngine | A — Node, permanently | Authorization-adjacent or authorization itself; see §4 |

## 3. Ideal Java Trading Engine — What "Java owns the quant computation layer" Actually Means Here

Based on the actual code, Java should own: **stateless, on-demand, numerically-heavy fits** — GARCH, HMM regime, cointegration/StatArb, factor composites. Java should **not** own: anything stateful and tick-frequency (that's Node's job today, and moving it would cost far more in HTTP round-trips than it saves — §13), and anything that touches authorization (§4). This is, in substance, what already exists — the "ideal" and the "actual" are close. The gap is **reachability** (GARCH/HMM had no endpoint until this session) and **consumption** (even now-reachable endpoints have zero caller wiring them into any reasoning context) — not missing computation.

| Candidate | KEEP IN NODE / MOVE TO JAVA | Evidence |
|---|---|---|
| Market-data feature calculation | KEEP IN NODE | Tick-frequency, stateful, tightly coupled to EventBus |
| Technical indicators | KEEP IN NODE (parity copy already in Java, unchanged) | §13's measured HTTP overhead makes moving the *authoritative* copy a net loss |
| Quant strategies (5 CORE) | KEEP DUAL (existing design) | Parity-tested, not a migration question |
| Alpha generation / factor models | JAVA (already there) | Genuine composite math, no Node equivalent |
| Statistical arbitrage | JAVA (already there, sole implementation) | N/A elsewhere |
| Regime detection (HMM) | JAVA (already there) for the heavy version; KEEP NODE for the cheap live classifier | Two different tools for two different jobs, not a single migration decision |
| Volatility models (GARCH) | JAVA (already there) | Genuine fit workload |
| Portfolio analytics | KEEP IN NODE today; Java's EWMA covariance is unused infrastructure, not yet a "layer" | No consumer exists |
| Correlation/covariance | Same as above | Same |
| Position sizing | KEEP IN NODE, permanently | Authorization-adjacent (§4) |
| Expected return / expected risk | Partially Java (GARCH forecast variance is exactly "expected risk"); expected return has no Java equivalent | Asymmetric — don't assume both sides exist |
| Signal ranking / strategy ensemble | NEITHER EXISTS TODAY | See §7/§8 — this is a real architectural gap, not a migration question |

## 4. Calculation vs. Authorization — the Boundary, Precisely

**Java may calculate** (already does, or plausibly could): expected volatility (GARCH forecast), regime classification (HMM), cointegration/spread Z-scores (StatArb), factor composite scores (FactorAlphaEngine), correlation/covariance (EwmaCovariance, unused). **None of these currently reach a vote or an order.**

**Node remains authoritative for, without exception:** RiskEngine's 24 gates (calculation AND authorization are both Node today — see §9 for why a partial split isn't recommended), the kill switch, ChiefTraderAgent's approve/reject decision, OMS order creation, BrokerManager/broker placement, position sizing (feeds a risk gate directly), trading-state control.

**The optimal boundary, stated as a rule:** a Java-computed number may enter a **prompt/reasoning string** (e.g., attached to an idea's `reasoning` field, or a future ChiefTrader debate context) but may **never** independently increment `independentAgreeingAgents`, set `side`/`confidence` on a vote, or bypass `RiskEngine.evaluateRisk()`. This is exactly the rule already encoded in `QuantCoreBridge.ts`'s `onSignal()` gating and in this session's new `fetchInstitutionalVolatility`/`fetchInstitutionalRegime` functions (added as advisory callers, deliberately not wired to any emission path).

## 5. Market Data Question

**Recommendation: Node keeps ingesting market data. Java does not receive it directly.**

| Option | Latency | Hops | Reliability | Verdict |
|---|---|---|---|---|
| Current (Broker→Node→EventBus→Java HTTP, optional/off) | 1 real network hop (broker) + 0-1 optional Java hop | Fewest | Java down = zero impact (already proven, §18 of the first audit) | **Keep** |
| Broker→Java→Node | Adds a mandatory hop before Node even sees a tick; a Java outage would take down market data entirely | More | Worse — couples Node's core liveness to Java's | **Reject** |
| Broker→Node→Java Quant Engine→Node Risk/OMS | Same as current, just relabeled | Same as current | Same | This is already what exists when the bridge is enabled — not a new option |

Moving ingestion to Java would convert an optional, fail-safe advisory process into a mandatory dependency for market data itself — the opposite of the fault-isolation property the first audit found and praised (§18 there).

## 6. Strategy Engine Question

**Answer: A — TS authoritative + Java parity, which is already the existing architecture.** This is not a hypothetical choice; `StrategyParityTest.java`'s existing convention and CLAUDE.md's explicit "single authoritative path" rule already establish this. Momentum Breakout, Pullback Continuation, Mean Reversion, Trend Following, and Range Reversion are the 5 CORE strategies with real Java ports (§1) — Java computes the same signal as a parity check, Node's copy is what ChiestTrader/RiskEngine/OMS actually consume. Future quantitative strategies should follow the same pattern **only once measured** (§11) to justify the parity-maintenance cost — not by default.

## 7. Alpha Engine

**Is Argus's existing Java code capable of becoming a real Alpha Engine?** Partially. `FactorAlphaEngine` is a genuine, if narrow, alpha composite (5 factors, Z-scored, combined). What's architecturally missing for the fuller vision (momentum + trend + mean-reversion + volatility + StatArb + regime + cross-sectional + volume + liquidity + microstructure, combined): 

- **No cross-sectional ranking** (comparing symbols against each other, not just each symbol against its own history) exists anywhere in Java or Node.
- **No unified combiner** across `FactorAlphaEngine` + `StatArbEngine` + `GarchEngine` + `HmmRegimeEngine` outputs exists — each is called independently today; nothing merges their outputs into one score.
- **No volume/liquidity/microstructure factor** exists in Java (Node has none either beyond `FactorAlphaEngine`'s disclosed CLV proxy).

**Conclusion: the pieces are real but disconnected — this is a genuine architectural gap, not a "finish wiring what's there" task.** Building the combiner is real, unstarted work; do not report it as already scaffolded.

## 8. Strategy Ensemble — Avoiding Correlated-Strategy Double-Counting

**Nothing in the current codebase de-correlates strategy signals before combining them.** `ChiefTraderAgent`'s `minIndependentAgreeingAgents` counts distinct **agents**, not distinct **information sources** — two agents that happen to derive their signal from correlated underlying math (e.g., two momentum variants) would count as "2 independent agents" today even though they're not really independent evidence. This is a real, current gap (not unique to a hypothetical Java ensemble) worth flagging: **any future strategy ensemble — Java or Node — needs an explicit correlation/redundancy check before treating N agreeing signals as N independent pieces of evidence.** No such check exists anywhere in this codebase today. Building it is real, unstarted design work; the first audit's `EvidenceAggregator.aggregate()` reference is vote *weighting*, not redundancy detection — a materially different problem.

## 9. Portfolio Quant

**Should Java own covariance/correlation/portfolio-risk analytics while Node authorizes?** Partially defensible in principle, but **not recommended as a near-term change**, for a concrete reason: `EwmaCovariance.java` already exists and is real, but has **zero current caller** — building a Node consumer for it, wiring it into RiskEngine's `correlation_exposure` gate as a *calculation* input (Node keeps the pass/fail authorization), would be the correct shape **if and when** the coarse `SECTOR_MAP` heuristic is found insufficient. That has not been established — no evidence in this audit shows the current sector-based gate is failing. Recommendation: **do not move this gate's calculation to Java speculatively; the existing heuristic hasn't been shown to be wrong.**

## 10. Python → Java Model Pipeline

Existing Python ML footprint: `scripts/train_xgboost_direction.py` (training), `scripts/run_vectorbt_wfo.py` (walk-forward), `python/argus_research/` (parity/feature verification against TS). **None of these currently export a model Java could consume** — there's no serialization step, no model registry, no Java-side inference loader for anything Python trains. The Chronos pattern (Python inference **server**, Node calls it over HTTP) is a working precedent for "Python owns inference," but that's a different shape than "Python trains, Java infers" — no such export/approval/inference pipeline exists today for XGBoost or any other trained model. **Building this is entirely new infrastructure, not a wiring gap** — do not assume the XGBoost work is close to production-ready for a Java consumer.

## 11. Performance Baseline — Benchmark Specification

| # | Benchmark | Input/workload | Symbols | Ticks/bars | Reps | Metric | Expected bottleneck | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Market-data processing | Real tick ingestion → `MarketDataWorker` parse/normalize | 1-31 (ARGUS_DISCOVERY size) | N/A (streaming) | N/A | Per-tick processing time | I/O-bound, unlikely CPU-bound | **UNVERIFIED — not measured this pass** (would need a live/replayed tick stream, not a unit benchmark) |
| 2 | Technical indicators | RSI+MACD+Bollinger over a 200-point series | 1 | 200 | 10,000 | p50/p95/max latency (us) | None — trivial | **MEASURED this session**: p50=4us, p95=12us, max=3874us (in-process, Java `QuantCoreServerBenchmarkTest`) |
| 3 | Strategy evaluation | 5 CORE strategy evaluation | 1 | Per-call | Not run this pass | Latency (us) | Low | UNVERIFIED — not measured this pass (existing `StrategyRegistry.evaluate` has no timing harness yet) |
| 4 | Alpha/factor calculation | `FactorAlphaEngine.compute()` over 300 bars, HTTP | 1 | 300 | 100 | p50/p95/max (us) | HTTP+JSON dominates over compute | **MEASURED this session**: p50=6352us, p95=10331us, max=28848us (full HTTP round trip) |
| 5 | Portfolio calculation | Not benchmarked (no dedicated portfolio-analytics module exists to benchmark — see §9) | N/A | N/A | N/A | N/A | N/A | Not applicable until §9's gap is filled |
| 6 | Risk calculation | `RiskEngine.evaluateRisk()`, 24 gates | N/A | N/A | Live-instrumented, not yet measured under load | Per-gate + total duration (us) | Serialization queue depth under concurrent load | **INSTRUMENTED this session** (`RiskEngine.ts` now emits `RISK_GATE_TIMING_US` at DEBUG level per evaluation) — numbers require a real/replayed load run to read, not yet gathered in this pass |
| 7 | Java HTTP call | GET `/api/v1/indicators`, POST `/api/v1/institutional/factors` | 1 | 60-300 bars | 100-200 | p50/p95/max (us) | HTTP/JSON serialization | **MEASURED this session**: indicators p50=4787us/p95=6090us/max=9030us; factors p50=6352us/p95=10331us/max=28848us |
| 8 | End-to-end decision path | Tick → idea → consensus → risk → order | N/A | N/A | Not run this pass | Total latency (ms) | Unknown — needs real instrumentation across all stages, not just RiskEngine | UNVERIFIED — this session added RiskEngine + TechnicalAgent instrumentation (items 2, 6) but did not chain them into one end-to-end trace |

**No performance number in this table was invented** — items marked MEASURED were run in this exact session (`QuantCoreServerBenchmarkTest.java`, real HTTP client, real loopback server); items marked UNVERIFIED genuinely were not run and should not be treated as known.

## 12. Node Event Loop — Should It Be Optimized Before Java Offload?

**Answer: yes, and the measured numbers in §11 make this concrete, not just a-priori caution.** In-process RSI+MACD+Bollinger costs ~4-12 microseconds. The same calculation via Java HTTP costs ~4,800-6,300 microseconds — **roughly 400-1,500x more expensive**, entirely process-boundary overhead (connection/serialization/loopback), not computation. If Java is introduced for small, per-tick indicator work *before* first checking whether Node's event loop is actually contended (Phase 0 of the first audit, still not run against a real symbol load in this pass), **the answer to the audit's own question is: this would not be solving a real problem, it would be moving a ~4-12us calculation onto a ~5,000us round trip** — a strict regression for anything at indicator frequency. `worker_threads` (in-process, no serialization, no network hop) is the only offload option that could plausibly help *if* event-loop contention is ever actually measured and found real — and it has never been tried (zero usage anywhere in this codebase, confirmed both audits).

## 13. Process Boundary Analysis — the Central Question, Now Measured

```
Node → HTTP → Java → JSON → Node
```

**Measured this session** (`QuantCoreServerBenchmarkTest.java`, loopback HTTP, JDK `HttpClient`, real embedded `QuantCoreServer`):

| Workload | In-process calc only | Full HTTP round trip | Overhead ratio |
|---|---|---|---|
| RSI+MACD+Bollinger (200-pt series) | p50=4us, p95=12us | p50=4787us, p95=6090us | **~1,000-1,200x** |
| 5-factor composite (300 bars) | not isolated separately (single-call endpoint) | p50=6352us, p95=10331us, max=28848us | N/A (no in-process comparison run) |

**Direct answer: yes, decisively — HTTP overhead eliminates any advantage Java could offer for a calculation as small as RSI.** A calculation this cheap should never cross a process boundary for its own sake. The boundary only starts to make sense for calculations whose own compute cost is comparable to or exceeds the ~5ms round-trip floor — GARCH's Nelder-Mead fit and HMM's Baum-Welch EM are the plausible candidates (not directly measured against this same floor in this pass, but both involve iterative optimization over many data points, unlike RSI's single-pass arithmetic).

## 14. Recommended Target Architecture

```
                                   ARGUS
                                     |
        +----------------------------+----------------------------+
        |                            |                              |
     Node.js                       Java                          Python
   (authoritative                (advisory,                    (research +
    trading spine,              on-demand,                     ML training +
    all tick-frequency          stateless numeric               Chronos
    work)                        fits ONLY)                      inference)
        |                            |                              |
   MarketDataWorker            FactorAlphaEngine              VectorBT/parity CLI
   EventBus                    StatArbEngine                  XGBoost training
   TechnicalAgent (RSI/MACD)   GarchEngine                     WFO runner
   ChiefTraderAgent            HmmRegimeEngine                 Chronos server (:8008)
   RiskEngine (24 gates)       (called only when the
   OMS/BrokerManager            calling context wants a
   Position sizing              heavier, on-demand fit -
                                 never per-tick)
        |                            |
        +-----------+----------------+
                     |
              (advisory numbers may
               enter reasoning text;
               never a vote)
                     |
                Broker (Alpaca/IBKR)
```

This differs from the first audit's diagram only in being more explicit about **why** the Java box is scoped the way it is: the process-boundary cost (§13) rules out anything tick-frequency, leaving only the already-correct set (GARCH/HMM/StatArb/FactorAlpha).

## 15. Migration Priority

| P | Component | Current | Target | Reason | Benefit | Complexity | Risk | Dependencies | Benchmark required |
|---|---|---|---|---|---|---|---|---|---|
| P1 | Wire `fetchInstitutionalVolatility`/`fetchInstitutionalRegime` (added this session) into an actual reasoning-context consumer | TS functions exist, zero callers | Attach to ChiefTrader's debate prompt or an idea's `reasoning` string, never its vote | Closes the "built but unconsumed" gap (§4's rule already supports this safely) | Low-moderate — richer reasoning text | Low | Low (advisory-only by construction) | None new | Not required (non-authoritative) |
| P2 | Build a cross-sectional/combiner layer for the Alpha Engine (§7) | Doesn't exist | New, explicitly scoped module | Real gap, not wiring | Unclear until built | Moderate-high | Low if kept advisory | §8's redundancy-detection gap should be solved alongside it | Needs its own correctness tests, not perf benchmarks first |
| P3 | Correlation/covariance (`EwmaCovariance`) → RiskEngine gate calculation input | Unused Java class | Node caller feeding gate 20 as a calculation input (Node keeps authorization) | Only if the existing `SECTOR_MAP` heuristic is shown insufficient | Unproven | Moderate | Moderate (touches a real risk gate) | Requires evidence the current gate is wrong first | Required — must prove current gate is insufficient before changing it |
| P3 | Technical indicators → Java as the *authoritative* copy (not parity) | N/A — not recommended | N/A | §13 shows this would be a strict latency regression via HTTP | Negative | N/A | High | `worker_threads` should be tried first if event-loop contention is ever proven | Phase 0 (event-loop contention) required and not yet done |
| Do not do | RiskEngine/OMS/kill switch to Java | N/A | N/A | Architecturally forbidden, no evidence it would help even ignoring the rule | N/A | N/A | Unacceptable | N/A | N/A |

## 16. What Must Never Move

Kill switch, RiskEngine's gate evaluation **and** authorization (both halves — see §4/§9's caution against even a partial split without evidence), OMS order creation, BrokerManager/broker adapters, ChiefTraderAgent's final approve/reject, trading-state control (`tradingEngine`), position sizing (feeds gate 21 directly). This list is unchanged from the first audit — nothing found in this deeper pass weakens it; if anything, the measured HTTP-overhead numbers (§13) reinforce it by removing "but Java is faster" as a plausible argument for touching any of these.

---

## 17. Final Architect Decision

1. **What percentage of current trading computation should be Java?** Not a meaningful percentage to name — the honest framing is: **zero percent of anything tick-frequency or authorization-adjacent, and effectively all of the genuinely heavy, on-demand statistical fits** (which are already in Java: GARCH, HMM, StatArb, factor composite). By call-count, Java's share would remain tiny (these are on-demand, not per-tick); by CPU-time-per-call, Java could reasonably own the majority of the *heavy* numeric work while still being a rounding error in the system's total request volume.
2. **Which exact files/classes should eventually move to Java?** None of Node's current live-path files should *move* — the correct next step is *connecting* what already exists in Java (§15 P1), not migrating more TS. If a future cross-sectional Alpha Engine (§7) is built, it belongs in Java from the start (new code, not a migration).
3. **Which exact files/classes should remain Node?** `MarketDataWorker.ts`, `EventBus.ts`, `TechnicalAgent.ts` (the authoritative copy), `ChiefTraderAgent.ts`, `EvidenceAggregator.ts`, `RiskEngine.ts`, `OrderManagement.ts`, `BrokerManager.ts` + all broker adapters, `PositionSizing.ts`, `TradingEngine.ts`.
4. **Which exact components belong in Python?** `python/argus_research/` (parity/feature research), `scripts/train_xgboost_direction.py`, `scripts/run_vectorbt_wfo.py`, `scripts/local_ai_service.py` (Chronos inference server) — unchanged from the first audit.
5. **Should Java receive market data directly?** No (§5).
6. **Should Java become the authoritative strategy engine?** No — TS stays authoritative with Java parity, which is already the existing design (§6).
7. **Should Java become the authoritative alpha engine?** Not yet possible — the combiner/cross-sectional layer that would make this a real "engine" rather than four independent endpoints doesn't exist (§7). Once built, it should be Java-native (new code), advisory-only.
8. **Should Java calculate portfolio risk while Node authorizes?** Only once a real gap in the current Node-side heuristic is demonstrated (§9) — not speculatively.
9. **Should technical indicators move to Java?** No — the measured HTTP overhead (§13) makes this a net loss for the authoritative copy; the existing parity copy is sufficient.
10. **Is Java HTTP overhead likely to negate the benefit for small calculations?** **Yes, measured and confirmed this session** — roughly 1,000x overhead for RSI/MACD/Bollinger (§13).
11. **Should `worker_threads` be considered before Java migration?** Yes, and it hasn't been tried at all (zero usage found in either audit pass) — it should be the first thing evaluated if Node event-loop contention is ever actually measured and found real.
12. **Single highest-value architectural improvement?** Connect the already-built, already-HTTP-reachable GARCH/HMM/FactorAlpha/StatArb outputs into an actual advisory consumer (ChiefTrader reasoning context) — real, low-risk, immediately available value from work that already exists, versus any new migration.
13. **What should NOT be changed?** Everything in §16, plus: do not move technical indicators' authoritative copy to Java, do not build a Java portfolio-risk calculator without first proving the current gate insufficient, do not treat the 5 CORE strategies' dual-implementation as a "temporary" state needing resolution — it's the intended permanent design.

---

## Final Output

### A. Current Argus Architecture
Node.js single-process authoritative trading spine; Java advisory HTTP process (now with GARCH/HMM reachable, per this session's work); Python disconnected research/ML + one inference server. See the first audit's §2 for the full traced diagram — unchanged.

### B. Ideal Node.js Responsibilities
All tick-frequency work, all authorization, all broker/OMS/kill-switch logic, the UI/API/WebSocket gateway. Unchanged from current reality.

### C. Ideal Java Responsibilities
On-demand, stateless, numerically-heavy statistical fits: GARCH, HMM regime, cointegration/StatArb, factor composites. Already built; now reachable; not yet consumed by anything (the real, actionable gap).

### D. Ideal Python Responsibilities
Research, parity verification, ML training, one inference server (Chronos). Unchanged.

### E. Java Candidates — Ranked
See §15's table.

### F. Components That Must Remain Node
See §16.

### G. Components That Should Remain Python
`python/argus_research/`, XGBoost training script, WFO runner, Chronos server.

### H. Performance Bottlenecks
None found that are currently active/unmitigated (matches the first audit); the one concrete, newly-measured fact worth calling a "bottleneck-in-waiting" is that any future per-tick Java call would cost ~1,000x its own compute time in pure HTTP overhead (§13).

### I. Benchmarks Required Before Migration
§11's table — items 1, 3, 5, 8 are the genuine remaining gaps (market-data processing, strategy evaluation, portfolio calculation, end-to-end path); items 2, 4, 6 (partially), 7 now have real numbers from this session.

### J. Recommended Target Architecture
§14's diagram.

### K. Phased Migration Plan
§15, reordered as priorities rather than sequential phases (P1 is genuinely next; the others are conditional on specific evidence being gathered first).

### L. Risks
Building an Alpha Engine combiner without first solving the correlated-strategy double-counting problem (§8) would produce a confident-looking but statistically unsound composite score. Wiring GARCH/HMM outputs into reasoning text without a clear "this is context, not a vote" convention risks the same drift toward a de facto second decision path that this session's `fetchInstitutionalVolatility`/`fetchInstitutionalRegime` design was deliberately built to avoid.

### M. Final Principal-Architect Recommendation
Don't migrate more calculation to Java. **Connect what's already there.** The single highest-leverage next step, backed by this session's own measurements, is wiring the now-reachable GARCH/HMM/FactorAlpha/StatArb endpoints into ChiefTrader's reasoning context (advisory only, never a vote) — not moving technical indicators, not building a new portfolio-risk calculator, not starting a cross-sectional Alpha Engine until the redundancy-detection problem (§8) is solved first. Node's authoritative spine and Java's advisory numeric layer are already close to the correct permanent shape; the gap is consumption, not computation.
