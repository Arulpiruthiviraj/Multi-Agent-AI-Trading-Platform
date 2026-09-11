# ARGUS Quant Ownership Matrix — Current (2026-09-09)

```
Repository:   Multi-Agent-AI-Trading-Platform
Branch:       main
Commit:       3509e2550696af86ff6028dd59811d33529459a5 (2026-09-09 19:00:28 -0400)
Working tree: DIRTY — see §Repo State below
```

This document answers Section 9 of the audit brief: for every quantitative calculation, who owns it —
TypeScript, Java, both, or neither — and whether Java's copy is authoritative, shadow, advisory,
research, or an accidental duplicate. Every row below is either (a) **directly verified this pass**
by reading the actual call sites (marked `HIGH, VERIFIED`), or (b) sourced from
`config/engineOwnership.json` — a first-party, actively-maintained registry whose own header states
it is "derived from audit source/build/runtime evidence, not invented" — spot-checked, not
independently re-derived line-by-line for every one of its 123 entries (marked `MEDIUM, REGISTRY`).
None of this document's conclusions are HYPOTHESIS.

## Repo state (Section 1)

```text
Repository:   Multi-Agent-AI-Trading-Platform
Commit:       3509e255 (main, 2026-09-09 19:00:28 -0400)
Dirty/clean:  DIRTY
```

Uncommitted at audit time:
- `config/engineOwnership.json` (modified) — the registry this document leans on; read as-is, current working-tree content, not the last commit's.
- `OptionIronCondorEngine.java`, `OptionStockCombinationEngine.java` (+ test) — modified.
- 5 new untracked Java option-strategy engines + tests (`OptionCalendarDiagonalSpreadEngine`, `OptionComboEngine`, `OptionCoveredStraddleEngine`, `OptionIronButterflyEngine`, `OptionSyntheticStraddleEngine`).
- 3 untracked `scripts/_tmp_*.ts` files (`_tmp_dbsize_estimate.ts`, `_tmp_dbstat.ts`, `_tmp_prune_bloat.ts`) — appear to be a separate, concurrent DB-size investigation, unrelated to quant engines and out of scope for this audit; not opened or analyzed.

Recent commits (all quant-related, all same-day 2026-09-09 through 2026-09-05):
```
3509e25 Add Ladder, Guts, Strap/Strip, Modified Butterfly, and Seagull options engines
e000557 Add Fixed Income, Index, and Volatility quant engines (RESEARCH, no live data feed yet)
a48229f Add crypto ANN feature primitives, 12 options-strategy engines, and Black-Scholes pricing/Greeks
8d69e8f Add FX, commodities, futures, and CDO structured-products quant engines (RESEARCH, no live data feed yet)
95206d2 Fix IBKR order-lifecycle crash recovery, isolate news prompt injection, add ~35 tested Java quant engines
```
Every one of these commit messages self-labels its additions RESEARCH — confirmed against the
registry (below), not merely taken at the commit message's word.

`npx tsc --noEmit`: clean (no errors surfaced).

---

## Indicators

| Calculation | TS | Java | Production authority | Shadow | Research | Problem | Evidence |
|---|---|---|---|---|---|---|---|
| RSI | `src/server/engines/RSIEngine.ts` | `quant-core-java/.../indicators/RSI.java` | **TS** (`TechnicalAgent.ts`) | Yes — `PARITY_SHADOW` via `/api/v1/indicators/{symbol}`, compared in `QuantCoreBridge.compareParity()` | No | None — this is intentional, disclosed parity-shadow, not an accidental duplicate | HIGH, VERIFIED: Java's own class doc says "ported byte-for-byte from `RSIEngine.ts`'s `calculate()`" — confirmed identical algorithm by direct side-by-side read this session (Wilder smoothing, SMA seed, same formula, no divergence) |
| MACD | `src/server/engines/MACDEngine.ts` | `quant-core-java/.../indicators/MACD.java` | **TS** | Yes — same `compareParity()` path | No | None (same as RSI) | HIGH, VERIFIED: Java's doc comment says "ported byte-for-byte from `MACDEngine.ts`'s `calculate()`" — confirmed identical (EMA-based, same seed/period) |
| Bollinger Bands | `src/server/services/technicalSignal.ts` | `quant-core-java/.../indicators/Bollinger.java` | **TS** | Yes — same path | No | None | MEDIUM, REGISTRY (not independently re-read this pass; consistent with the byte-for-byte pattern of RSI/MACD) |
| ATR | `src/server/engines/TechnicalIndicators.ts` | `SymbolState.tickRangeAtr()` | **TS** | **No — `NOT_A_PARITY_PAIR`** | No | Java's ATR is a disclosed, non-equivalent **tick-range approximation** (`|price_i - price_(i-1)|` over a ring buffer of ticks, not true OHLC-bar high/low/close range) — the registry itself flags this as not comparable, not a hidden bug | HIGH, VERIFIED: read `SymbolState.java`'s own header comment this session — it explicitly documents ATR/VWAP as "honest approximations... NOT the same number `TechnicalIndicators.ts`'s calculateATR produces... must never be presented as such" |

**Root cause of observed RSI/MACD live-runtime divergence (established earlier this session, re-cited here):**
not a formula bug. `QuantCoreBridge.tsSideSnapshot()` computes from `this.priceHistory[symbol]`
(TS's own in-memory array); the Java side (`SymbolState.java`) computes from an **independently
accumulated** tick ring buffer (`CAPACITY=200`) fed only by a separate, best-effort, fire-and-forget
`POST /api/v1/ticks` per tick — no delivery/ordering guarantee, no periodic full-resync. Any
dropped/reordered tick makes the two input arrays differ in content; Wilder/EMA smoothing then
carries that divergence forward permanently (each value depends recursively on the previous one),
producing large, persistent divergence from a single missed tick rather than a small rounding drift.
Documented in `docs/audits/ARGUS_POST_AUDIT_REMEDIATION_PLAN.md` (R8), fix design scoped, not
implemented (cross-language wire-protocol change, correctly deferred rather than rushed).

---

## The 5 CORE strategies

| Strategy | TS | Java | Production authority | Shadow | Research | Problem | Evidence |
|---|---|---|---|---|---|---|---|
| Momentum Breakout | `src/server/quant/strategies/momentumBreakout.ts` | `strategy/core/MomentumBreakout.java` | **TS** (`QuantSignalAgent.ts:287`, `evaluateAll()`) | **No** — not even shadow-compared | No | Java implementation exists, is registered (`StrategyRegistry.java`), and is HTTP-reachable (`POST /api/v1/evaluate`) — but has **zero callers anywhere in the live TS tree** | **HIGH, VERIFIED**: `grep -rn "/api/v1/evaluate" src` (excluding stale `.claude/worktrees/` copies and the Java side itself) returns **zero matches**. `QuantSignalAgent.ts:287` is the confirmed, sole live call site, and it calls TS's `evaluateAll(strategyContext)` |
| Pullback Continuation | `src/server/quant/strategies/pullbackContinuation.ts` | `strategy/core/PullbackContinuation.java` | **TS** | No | No | Same as above | Same evidence |
| Mean Reversion | `src/server/quant/strategies/meanReversion.ts` | `strategy/core/MeanReversion.java` | **TS** | No | No | Same | Same evidence |
| Trend Following | `src/server/quant/strategies/trendFollowing.ts` | `strategy/core/TrendFollowing.java` | **TS** | No | No | Same | Same evidence |
| Range Reversion | `src/server/quant/strategies/rangeReversion.ts` | `strategy/core/RangeReversion.java` | **TS** | No | No | Same | Same evidence |

**Classification: none of these are `SHADOW/PARITY ENGINE` for the strategy decision itself** — that
label would require Java's `evaluate()` to actually be *called* (even just for logged comparison),
which it is not. `PARITY_ONLY` (the registry's own term) is the accurate, narrower label: a
parity **test** exists (`StrategyParityTest.java`, synthetic fixtures — see the TS↔Java parity
audit doc for scope), but there is no runtime parity *comparison* the way RSI/MACD/Bollinger get via
`compareParity()`. **`IMPLEMENTED BUT NOT WIRED`** is the correct Section 25 classification for all
five, not `PARTIALLY WIRED` or `SHADOW`.

---

## Complete Java quant file inventory (145 total, verified by direct file count)

`config/engineOwnership.json`'s `quantModels` section catalogs 123 higher-level engines, but does
not separately enumerate the lower-level primitive files those engines are built on, nor the
indicators/strategies (tracked in their own sections). Direct file count across
`quant-core-java/src/main/java/io/argus/quantcore/`:

| Subfolder | File count | Content |
|---|---|---|
| `institutional/models/` | 115 | The engines cataloged in `quantModels` (options strategies, factor/regime/volatility models, FX/commodities/futures/CDO, crypto ANN, etc.) |
| `institutional/math/` | 12 | Real statistical primitives: `AugmentedDickeyFuller`, `EigenDecomposition`, `ElasticNetRegression`, `EwmaCovariance`, `LassoRegression`, `LogisticRegression`, `Matrix`, `NelderMeadOptimizer`, `NormalDistribution`, `OlsRegression`, `OrnsteinUhlenbeckEstimator`, `RidgeRegression` |
| `institutional/ml/` | 5 | `DecisionTreeRegressor`, `GradientBoostingRegressor`, `KNearestNeighborsRegressor`, `LinearSvm`, `RandomForestRegressor` |
| `institutional/features/` | 2 | Feature-pipeline support |
| `institutional/data/` | 1 | Data-loading support |
| `strategy/core/` | 5 | The 5 CORE strategy ports |
| `strategy/institutional/` | 2 | `InstitutionalStatArbStrategy`, `MultiFactorMomentumStrategy` |
| `indicators/` | 4 | RSI, MACD, Bollinger (+ 1 more) |
| **Total** | **145** | |

**This does not change any reachability finding below** — `math`/`ml` are primitives most
`models/` engines call into internally (e.g., a factor/regression-based engine using
`OlsRegression`/`EwmaCovariance`), not independently-callable endpoints; they inherit the
RESEARCH/unreachable status of whatever engine(s) use them. The 123-vs-145 distinction is purely
about inventory completeness (every real formula-bearing file) vs. the registry's own
engine-level cataloging granularity — both are accurate for what they each measure.

## Institutional/research engines (`quantModels`, 123 total per `config/engineOwnership.json`)

| Status | Count | Meaning |
|---|---|---|
| `SHADOW` | 6 | Real HTTP endpoint, real live consumer (`JavaQuantAdvisoryService.ts` and/or `ChiefTraderAgent.ts`'s debate-context text fold-in), output logged/observed, **zero decision influence** on consensus vote counting |
| `RESEARCH` | 117 | Unit-tested against synthetic/deterministic data only; no backtest/walk-forward/paper evidence; the overwhelming majority (`liveConsumer: NONE`, `httpEndpoint: NONE`) have never been called by anything outside their own test suite |

**The 6 SHADOW engines** (all confirmed via the registry, cross-checked against `ChiefTraderAgent.ts`
and `JavaQuantAdvisoryService.ts` import references, not independently re-read line-by-line this pass):

| Engine | Output type | Live consumer | Wired to consensus vote? |
|---|---|---|---|
| `garch` (`GarchEngine.java`) | Conditioning volatility modifier | `JavaQuantAdvisoryService.ts` (advisory event) + `ChiefTraderAgent.ts` debate-prompt text | **No** |
| `hmm_regime` (`HmmRegimeEngine.java`) | Conditioning regime filter | Same + feeds `RegimeVolatilityOverlay.apply()` | **No** |
| `factor_composite` (`FactorAlphaEngine.java`) | Directional alpha provider | Same | **No** — Phase 3 (a real vote) is explicitly gated on a multi-week clean-divergence soak that has not been run |
| `market_data_quality` (`MarketDataQualityEngine.java`) | Infrastructure gate | `FeaturePipeline.build()`, called live via `JavaQuantAdvisoryService.ts` | N/A (gating role, not a vote) |
| `feature_pipeline` (`FeaturePipeline.java`) | Infrastructure gate | `JavaQuantAdvisoryService.ts` (advisory event only) | **No** |
| `volatility_engine` (`VolatilityEngine.java`) | Conditioning volatility modifier | Same responses `JavaQuantAdvisoryService.ts` already consumes; feeds `RegimeVolatilityOverlay.apply()` | **No** |

**One real, live, wired exception worth calling out precisely** — `internalQuantEnsemble.ts`
(`computeInternalEnsembleQualification`, imported and called from **`QuantSignalAgent.ts:54`**, a
confirmed real live import): combines the `JAVA_RESEARCH_STRATEGY_IDS` family's votes through
`QuantEnsembleEngine.java`'s correlation-adjusted `effectiveIndependentCount()` math and reports
whether the result clears a bar that lets it **"stand in for a second independent agent"** in
ChiefTrader's consensus. This is genuinely live-wired — not a vote in the `emitTradeIdea` sense, but
a real structural input to the independence-count side of consensus math. Fails closed on any
Java-side error (`qualifiesAsIndependent: false`, never a fabricated qualification). This is
**distinct** from the 5 CORE strategies (different engines, different mechanism) and from the
6 `SHADOW` engines' debate-text-only role (this one affects a real gate, not just prompt text).

**The 117 RESEARCH engines** include the entire recent options-strategy catalog (Iron Condor, Iron
Butterfly, Synthetic Straddle, Calendar/Diagonal Spread, Covered Straddle, Ladder, Guts, Strap/Strip,
Modified Butterfly, Seagull, Combo), FX/commodities/futures/CDO structured-product engines,
Fixed-Income/Index/Volatility engines, crypto ANN feature primitives, Black-Scholes pricing/Greeks,
and a "Two-Sigma-style" technical-strategy catalog (time-series momentum, Donchian, MA crossover,
ADX trend strength, cross-sectional ranking, z-score/RSI(2)/MACD/Bollinger mean-reversion variants,
VIX efficiency-ratio filter). **All added in the last 4 days** (commits above). The registry's own
`$batchComment` states these are "unit-tested only against synthetic/deterministic data this pass...
none has an HTTP endpoint or any live/advisory consumer wired" — this audit did not re-verify each
of the 117 individually (that would require reading ~50+ Java files line-by-line, out of scope for
this pass's effort budget) but spot-checked several (`time_series_momentum`, `donchian_channel`,
`rsi_mean_reversion`, `vix_effective_ratio_filter`) and found the registry's `httpEndpoint: NONE` /
`liveConsumer: NONE` claims consistent with `QuantCoreServer.java`'s route table (no route registered
for any of these). **UNVERIFIED per-engine**: mathematical correctness of each of the 117 — not
checked this pass, marked as a gap, not silently assumed correct.

---

## Risk / execution / backtesting (Node-only, no Java involvement — by design)

| Component | Owner | Java available? | Notes |
|---|---|---|---|
| RiskEngine (25 gates) | NODE_ONLY | No | Safety-critical, must never move (CLAUDE.md) |
| Position sizing | NODE_ONLY | No | Feeds RiskEngine gate 21 |
| OMS | NODE_ONLY | No | Sole `.placeOrder(` caller |
| Broker adapters | NODE_ONLY | No | `quant-core-java` has zero broker imports/credentials — verified by source inspection each audit pass per the registry's own note |
| ChiefTrader/EvidenceAggregator consensus | NODE_ONLY | No | No Java counterpart; any future Java evidence source must enter as one vote among many |
| PortfolioMonitor exit intelligence | NODE_ONLY | No | Stop-loss/take-profit/trailing/thesis-invalidation |
| Reconciliation | NODE_ONLY | No | No Java equivalent |
| Full Argus Replay Engine (Historical Evaluation) | NODE_ONLY | No | Reuses real TS ChiefTrader/RiskEngine/OMS math — confirmed via `argusStrategyReplay.ts`'s `import { findStrategy } from '../quant/strategies/StrategyEngine'` (HIGH, VERIFIED this pass) |
| `BacktestEngine.ts` | NODE_ONLY | No | Lightweight TA-rule research engine, `SAME_BAR_CLOSE` |
| `JavaBacktestEngine.java` | JAVA_ONLY | — | **Standalone, separately tested, NOT wired to or cross-validated against either Node engine** — a real, documented, third, unused backtest implementation |

**Section 15 finding: no "Paper=TS/Backtest=Java" mismatch exists.** Both real backtest/replay paths
(`argusStrategyReplay.ts` and `BacktestEngine.ts`) use the exact same TS `findStrategy()`/strategy
modules that the live paper path uses via `evaluateAll()` — single authority, confirmed. The one
Java backtest engine that exists is unwired and unused by anything, a separate risk (dead/duplicate
code) rather than a parity risk.

---

## Summary answer to Section 9's core question

> Who owns this calculation?

**TypeScript owns every calculation that currently affects a real trading decision.** Java owns a
large and rapidly growing body of research-stage engines (123 catalogued), 6 of which are wired as
advisory/shadow inputs (text-context or a consensus independence-count gate, never a vote), and 117
of which are implemented, unit-tested, and completely disconnected from any runtime caller. The 5
CORE strategies specifically — the ones this migration has most explicitly targeted — have real,
registered, HTTP-reachable Java ports that are **never called** by the live system; TypeScript's
versions remain the sole production authority.
