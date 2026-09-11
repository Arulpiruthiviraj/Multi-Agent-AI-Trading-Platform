# ARGUS — Complete Quant Engine Forensic Audit (2026-09-09, corrected 2026-09-10)

**Single consolidated document.** Supersedes the 6 split files from this same audit pass
(`ARGUS_CURRENT_ARCHITECTURE_FORENSIC_AUDIT.md`, `ARGUS_QUANT_ENGINE_FORENSIC_AUDIT.md`,
`ARGUS_STRATEGY_INVENTORY_AND_STATUS.md`, `ARGUS_QUANT_OWNERSHIP_MATRIX_CURRENT.md`,
`ARGUS_JAVA_QUANT_WIRING_AUDIT.md`, `ARGUS_TS_JAVA_PARITY_AUDIT.md`,
`ARGUS_QUANT_REMAINING_WORK.md`) — all content below, one place. This is an AUDIT ONLY: no
production code was modified, no thresholds changed, no strategies enabled, nothing "fixed."

> **2026-09-10 correction notice:** the body of this document (§1-§10, largely written
> 2026-09-09) is accurate as of the moment it was written, but two explicit operator overrides
> landed in this same repository the same day, **after** most of this audit's investigation, and
> materially change the Executive Summary's central verdict. Both are verified directly in source
> this correction pass (not merely taken from CLAUDE.md's prose):
>
> 1. **`JavaQuantAdvisoryService.emitJavaQuantVoteIfEligible()`** (`src/server/services/
>    JavaQuantAdvisoryService.ts:218-254`) — the `factor_composite` engine (previously
>    correctly documented below as `SHADOW`, "zero decision influence") now emits a **real,
>    independent `TRADE_IDEA_GENERATED` vote** (agent `JavaFactorComposite`) into the unchanged
>    ChiefTrader consensus, gated behind `ARGUS_JAVA_QUANT_VOTE_ENABLED` (confirmed `true` in this
>    deployment's live `.env`), `isPipelineAgentEnabled('JavaFactorComposite')`,
>    `isLiveIdeaGenerationEnabled()`, Java's own advisory-level gating (`!advisory.gated`,
>    directional side only), and a minimum-confidence floor (`javaQuantVoteMinConfidence`, 0.6).
>    This is an explicit, dated, documented operator override of this codebase's own Phase 3
>    shadow-soak precondition — not a silent bypass. It still never issues a `CHIEF_APPROVED_IDEA`
>    or calls `placeOrder` directly; it is one vote among many, subject to the same 0.75 bar and
>    every RiskEngine gate as any other agent.
> 2. **`ChiefTraderAgent.ts`'s `isQuantIndependentQualificationEnabled`** (import at line 66,
>    used at lines 718-730) — when `ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED=true`
>    (confirmed `true` in this deployment's live `.env`), a single `QuantEngine` idea whose
>    `internalQuantEnsemble.ts`-computed qualification (`QuantEnsembleEngine.java`'s
>    correlation-adjusted `effectiveIndependentCount()`) clears a bar **strictly above** the
>    normal minimum (`minQuantIndependentFamilies`: 3 distinct strategy families,
>    `minQuantIndependentEffectiveCount`: 2.5 effective independent count — both
>    `config/tradingSafety.json`) can now satisfy the `minIndependentAgreeingAgents` floor **on
>    its own**, instead of requiring a second, genuinely separate agent to agree. The numeric
>    constant itself (`MIN_INDEPENDENT_AGREEING_AGENTS`) is unchanged; a second, alternate,
>    stricter-bar path to satisfy it now exists. Every other requirement (0.75 STRONG confidence,
>    hard vetoes — debate HOLD, bear-case HOLD, AI contradiction —, all 25 RiskEngine gates, OMS)
>    is confirmed unchanged.
>
> **What this means for the verdict below:** the §4 ownership-matrix claim that
> `factor_composite`/the internal-ensemble mechanism have "zero decision influence" /
> "never wired to EvidenceAggregator/consensus vote counting" is now **stale** — both statements
> were true when written and are no longer true. This does not change the 5 CORE strategies'
> finding (`momentum_breakout` etc. remain confirmed `REGISTERED_BUT_UNREACHABLE` via
> `/api/v1/evaluate` — unaffected by either override, which route through entirely different
> mechanisms: `JavaQuantAdvisoryService`'s existing SHADOW pipeline and `internalQuantEnsemble.ts`
> respectively, not `StrategyRegistry.evaluate()`). Nor does it change the "no safety invariant
> weakened" finding — both overrides are additive, explicitly gated, fail closed, and were
> presented to and knowingly authorized by the operator (matching the exact pattern already used
> for `TradePlanBuilder.emitTradePlanIdea()` on 2026-09-05). It **does** mean Java Quant Core is
> no longer accurately described as having zero live decision authority — it now has two real,
> if narrow and heavily gated, paths into a live trading decision. Treat every "SHADOW, no vote"
> and "zero decision influence" statement for `factor_composite` and the internal-ensemble
> mechanism throughout §4-§10 below as historical (accurate as of 2026-09-09's earlier hours),
> not current.

---

## EXECUTIVE SUMMARY

```text
Repository:            Multi-Agent-AI-Trading-Platform
Commit:                 3509e2550696af86ff6028dd59811d33529459a5 (main, dirty working tree)
Audit date:             2026-09-09

OVERALL QUANT STATUS:
TypeScript is the sole production authority for every strategy and indicator that currently affects
a trading decision; Java Quant Core is a large, rapidly-growing, overwhelmingly research-stage
engine collection. [SEE 2026-09-10 CORRECTION NOTICE ABOVE — as of this pass's original writing
(earlier on 2026-09-09) this line read "no vote or decision authority anywhere," which is now
STALE: two same-day, later, explicit operator overrides have since given Java two real, narrow,
heavily-gated paths into a live trading decision — a real emitTradeIdea vote
(JavaQuantAdvisoryService.emitJavaQuantVoteIfEligible(), agent JavaFactorComposite) and a
consensus-independence-floor override (ChiefTraderAgent.ts's isQuantIndependentQualificationEnabled).
Both confirmed live (both env flags true) as of 2026-09-10.]

JAVA QUANT STATUS:
PARTIALLY AUTHORITATIVE as of 2026-09-10 (corrected from this pass's original "IMPLEMENTED BUT NOT
WIRED, no vote or decision authority anywhere" — see the correction notice above). The 5 CORE
strategies specifically remain IMPLEMENTED BUT NOT WIRED (registered, HTTP-reachable via
/api/v1/evaluate, unit/parity-tested against synthetic fixtures, zero real callers found anywhere)
— that finding is unaffected. Separately, `factor_composite` (via JavaQuantAdvisoryService) and the
internal-ensemble mechanism (via internalQuantEnsemble.ts/QuantEnsembleEngine.java) now each have a
real, live, explicitly-gated path into a trading decision — a genuine vote and a consensus-
independence-floor substitute, respectively — both added 2026-09-09, both verified in source
2026-09-10.

TS QUANT STATUS:
NODE_AUTHORITATIVE — sole production path for all 5 CORE + 16 experimental strategies and all
indicators (RSI/MACD/Bollinger/ATR), confirmed via direct call-site tracing.

CORE STRATEGIES: 5
EXPERIMENTAL STRATEGIES: 16
JAVA STRATEGIES (CORE ports): 5 — all registered, none wired
JAVA QUANT FILES TOTAL (verified by direct file count, confirmed twice this pass): 145

FULLY PARITY-VERIFIED: 0 (indicator-level shadow comparison exists and runs live, but shows real,
  root-caused, unresolved divergence; strategy-level parity tests use synthetic fixtures only,
  not real-bar-derived StrategyContext)
FULLY RUNTIME-VERIFIED: 0 (this pass did not observe a live evaluateAll() invocation in logs)
BACKTEST VALIDATED: 5 (mechanism exists; no profitability claimed — CLAUDE.md's own ground truth:
  walk-forward OOS failed for checked combos)
OOS VALIDATED: 0
PROMOTION ELIGIBLE: 0

UNWIRED: 5 (the CORE Java strategy ports) + ~111 of 123 registry-cataloged quantModels entries
  with zero HTTP endpoint or consumer
DEAD/UNREACHABLE: 5 CORE Java strategies (REGISTERED_BUT_UNREACHABLE — compiles, tested,
  reachable in principle, never actually called)
NOT IMPLEMENTED: Wyckoff (grepped repo-wide, zero matches)

CRITICAL QUANT DEFECTS:
None safety-relevant. One real, root-caused, unresolved data-quality defect: RSI/MACD indicator
shadow-parity divergence caused by Java's SymbolState.java maintaining an independently-accumulated
tick buffer (fed by an unacknowledged fire-and-forget POST /api/v1/ticks) instead of comparing
against TS's actual array — not a formula bug (RSI.java/MACD.java are confirmed byte-for-byte ports
of the TS originals).

MAJOR ARCHITECTURAL GAPS:
1. Java's 5 CORE strategy ports have no live caller and no stated wiring plan — silently unwired,
   unlike most of the 123 registry entries, which are at least explicitly documented as
   deliberate RESEARCH-only.
2. The feature-computation pipeline (RegimeEngine/trend/volume/priceAction/supportResistance/
   MarketContext) that would populate a real StrategyContext from live bars does not exist in Java
   at all — StrategyContext.java's own header names this as unstarted "Phase 1.5" work.
3. JavaBacktestEngine.java is a third, standalone, unwired, uncross-validated backtest implementation.

REMAINING JAVA MIGRATION / STRATEGY / VALIDATION WORK: see §7 below (P0/P1/P2).

RECOMMENDED NEXT STEP:
Decide, explicitly, whether the 5 CORE Java strategies get wired into a real shadow-comparison
caller (mirroring the indicator-level compareParity() pattern) to start accumulating real
divergence evidence — or are documented as parity-test-only artifacts with no near-term wiring
intent. Right now they are neither: implemented, tested, and silently orphaned.

FINAL VERDICT:
Argus's Java Quant Engine is real, well-tested against synthetic fixtures, and growing fast (145
formula-bearing files as of this audit — confirmed directly matching the operator's own count), but
it is not correctly wired and not authoritative today: the 5 CORE strategies that matter most for
the "is Java migration real" question have a complete, registered, HTTP-reachable implementation
that nothing in the live system ever calls, while TypeScript's original versions remain the sole
production decision-maker for every trade idea Argus currently generates. The one place Java output
reaches a real trading-adjacent mechanism (the strategy-independence-count ensemble gate) is narrow,
fails closed, and does not itself vote. All current TypeScript strategies are correctly implemented
in the sense of being reachable and producing assessments; whether they produce *profitable*
signals remains unestablished, unchanged from this codebase's own long-standing, honestly-
documented ground truth.
```

---

## §1. Repository state

```text
Repository:   Multi-Agent-AI-Trading-Platform
Branch:       main
Commit:       3509e2550696af86ff6028dd59811d33529459a5 (2026-09-09 19:00:28 -0400)
Dirty/clean:  DIRTY
```

Uncommitted at audit time:
- `config/engineOwnership.json` (modified) — the registry this audit leans on; read as the current
  working-tree content, not the last commit's.
- `OptionIronCondorEngine.java`, `OptionStockCombinationEngine.java` (+ test) — modified.
- 5 new untracked Java option-strategy engines + tests (`OptionCalendarDiagonalSpreadEngine`,
  `OptionComboEngine`, `OptionCoveredStraddleEngine`, `OptionIronButterflyEngine`,
  `OptionSyntheticStraddleEngine`).
- 3 untracked `scripts/_tmp_*.ts` files — appear to be a separate, concurrent DB-size investigation
  by another session, unrelated to quant engines and out of scope for this audit; not opened.

Recent commits (all same-day, 2026-09-05 through 2026-09-09), every one self-labels its additions
RESEARCH — confirmed against the registry, not merely taken at the commit message's word:
```
3509e25 Add Ladder, Guts, Strap/Strip, Modified Butterfly, and Seagull options engines
e000557 Add Fixed Income, Index, and Volatility quant engines (RESEARCH, no live data feed yet)
a48229f Add crypto ANN feature primitives, 12 options-strategy engines, and Black-Scholes pricing/Greeks
8d69e8f Add FX, commodities, futures, and CDO structured-products quant engines (RESEARCH, no live data feed yet)
95206d2 Fix IBKR order-lifecycle crash recovery, isolate news prompt injection, add ~35 tested Java quant engines
```
`npx tsc --noEmit`: clean.

---

## §2. Current architecture — pipeline trace

```text
Alpaca/IBKR market data
    ↓
MarketDataWorker (tick ingestion, MARKET_DATA/MARKET_DATA_UPDATED)
    ↓
Idea agents (TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent, PortfolioMonitor,
             QuantSignalAgent, KronosForecastAgent, OpportunityDiscovery/Screener)
    ↓ TRADE_IDEA_GENERATED (gateTradeIdea)
ChiefTraderAgent (EvidenceAggregator, consensus math, optional AIRouter debate)
    ↓ CHIEF_APPROVED_IDEA
RiskAgent → RiskEngine (25 gates)
    ↓
OMS → BrokerManager → active broker (ibkr_gateway in this deployment)
```

| Component | File | Runtime status | Authoritative? | Evidence |
|---|---|---|---|---|
| MarketDataWorker | `src/server/services/MarketDataWorker.ts` | Production | Yes | Not re-read this pass; unchanged per prior sessions' verification |
| TechnicalAgent | `src/server/services/TechnicalAgent.ts` | Production | **Yes (TS)** | HIGH, VERIFIED — see §4 Indicators table |
| QuantSignalAgent | `src/server/services/QuantSignalAgent.ts` | Production (flag-gated `QUANT_ENGINE_ENABLED`) | **Yes for strategy evaluation (TS)**; Java only feeds the independence-count side-channel | HIGH, VERIFIED — `evaluateAll(strategyContext)` at line 287; `computeInternalEnsembleQualification` imported at line 54 |
| Java CORE strategies | `quant-core-java/.../strategy/core/*.java` | **Implemented, registered, unreachable** | **No** | HIGH, VERIFIED — zero callers of `/api/v1/evaluate` anywhere outside the Java side and stale `.claude/worktrees/` copies |
| ChiefTraderAgent | `src/server/services/ChiefTraderAgent.ts` | Production | Yes (Node-only); `loadJavaInstitutionalDebateContext()` folds 3 SHADOW Java engines' output into the debate prompt as **text only** | MEDIUM, REGISTRY |
| RiskEngine (25 gates) | `src/server/engines/RiskEngine.ts` | Production | Yes (Node-only, no Java equivalent) | MEDIUM, REGISTRY |
| OMS | Node | Production | Yes (Node-only, sole `.placeOrder(` caller) | MEDIUM, REGISTRY |
| BrokerManager + adapters | `src/brokers/` | Production | Yes (Node-only) — `quant-core-java` has zero broker imports/credentials, verified by source inspection per the registry's own recurring audit note | MEDIUM, REGISTRY |
| QuantCoreBridge | `src/server/services/QuantCoreBridge.ts` | Production (advisory paths only) | N/A — a bridge, not a decision-maker | HIGH, VERIFIED |
| Java Quant Core (`QuantCoreServer.java`) | `quant-core-java/.../server/QuantCoreServer.java` | Companion process | **Advisory/shadow only** | HIGH, VERIFIED — full route table read directly (§5) |
| `argusStrategyReplay.ts` (Historical Evaluation, MODE B) | `src/server/research/argusStrategyReplay.ts` | Research/replay, isolated from live broker | Yes (TS) — same strategy source as live | HIGH, VERIFIED — `import { findStrategy } from '../quant/strategies/StrategyEngine'` |
| `BacktestEngine.ts` | `src/server/quant/BacktestEngine.ts` | Research | Yes (TS) | MEDIUM, REGISTRY |
| `JavaBacktestEngine.java` | `quant-core-java/.../JavaBacktestEngine.java` | **Implemented, unwired** | No — not cross-validated against either Node engine | MEDIUM, REGISTRY: "Do not treat its output as comparable evidence until a parity test exists" |

**Not re-verified this pass** (carried forward from prior sessions, not re-audited from scratch):
MarketDataWorker internals, ChiefTraderAgent's consensus math internals, RiskEngine's 25 gates
individually, OMS, broker adapters, discovery/ranking pipeline detail.

---

## §3. Complete quant code inventory — where it lives

- `src/server/quant/` — TS strategies (21), indicators (`RSIEngine.ts`, `MACDEngine.ts`,
  `technicalSignal.ts`, `TechnicalIndicators.ts`), `RegimeEngine.ts`, scoring
  (`StrategyScoreNormalizer.ts`), risk (`ExpectedValue.ts`, `LiveStrategyPerformance.ts`).
- `src/server/strategiesEngine/` — the SECOND, isolated research subsystem (own `MarketSnapshot`,
  condition-tree DSL). Per CLAUDE.md: reuses indicator math only, never imports ChiefTrader/
  RiskEngine/OMS, never places or influences a real order. Not re-audited beyond confirming
  CLAUDE.md's description; no contradicting evidence found.
- `quant-core-java/src/main/java/io/argus/quantcore/` — see §4's file-count table.
- `config/` — `quantThresholds.json`, `quantExperimentalStrategies.json`,
  `quantForumStrategies.json`, `quantStrategyTaxonomy.json`, `smcConfluence.json`,
  `engineOwnership.json` (the authoritative registry this audit leans on heavily),
  `thesisInvalidation.json`.
- `scripts/` — `java_parity_fixtures.ts`/`_phase1.ts`/`_phase2.ts`, `write_golden_core_parity.ts`,
  `assert_core_vectorbt_parity.ts` (not opened — VectorBT-specific, orthogonal to the Java Quant
  Core question).
- `tests/parity/` — `generate_parity_golden.ts`, `test_strategy_context_parity.ts`,
  `test_strategy_evaluate_parity.ts` (names suggest partial tooling toward the StrategyContext-parity
  gap identified in §6 — **not opened this pass**; read these before assuming zero existing work
  in that direction).

---

## §4. Complete Java quant file inventory — **145 total, verified twice this pass**

`config/engineOwnership.json`'s `quantModels` section catalogs 123 higher-level engines, but does
not separately enumerate the lower-level primitive files those engines are built on, nor the
indicators/strategies (tracked in their own registry sections). Direct file count across
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
| `indicators/` | 4 | RSI, MACD, Bollinger, ATR |
| **Total** | **145** | Confirmed by direct `find` count, re-run twice this session with identical results |

The whole `quantcore/` tree has 194 `.java` files total — the extra 49 are non-formula
infrastructure (HTTP server, request/response codecs, shared types, the strategy registry itself),
not additional engines.

**This does not change any reachability finding** — `math`/`ml` are primitives most `models/`
engines call into internally (e.g., a factor/regression engine using `OlsRegression`/
`EwmaCovariance`), not independently-callable endpoints; they inherit the RESEARCH/unreachable
status of whatever engine(s) use them.

### `quantModels` (123) status breakdown

| Status | Count | Meaning |
|---|---|---|
| `SHADOW` | 6 | Real HTTP endpoint, real live consumer, output logged/observed, **zero decision influence** on consensus vote counting |
| `RESEARCH` | 117 | Unit-tested against synthetic/deterministic data only; no backtest/walk-forward/paper evidence; the overwhelming majority (`liveConsumer: NONE`, `httpEndpoint: NONE`) never called by anything outside their own test suite |

The 6 SHADOW engines:

| Engine | Output type | Live consumer | Wired to consensus vote? |
|---|---|---|---|
| `garch` (`GarchEngine.java`) | Conditioning volatility modifier | `JavaQuantAdvisoryService.ts` (advisory event) + `ChiefTraderAgent.ts` debate-prompt text | **No** |
| `hmm_regime` (`HmmRegimeEngine.java`) | Conditioning regime filter | Same + feeds `RegimeVolatilityOverlay.apply()` | **No** |
| `factor_composite` (`FactorAlphaEngine.java`) | Directional alpha provider | Same | **No** — Phase 3 (a real vote) explicitly gated on a multi-week clean-divergence soak not yet run |
| `market_data_quality` (`MarketDataQualityEngine.java`) | Infrastructure gate | `FeaturePipeline.build()`, called live via `JavaQuantAdvisoryService.ts` | N/A (gating role) |
| `feature_pipeline` (`FeaturePipeline.java`) | Infrastructure gate | `JavaQuantAdvisoryService.ts` (advisory event only) | **No** |
| `volatility_engine` (`VolatilityEngine.java`) | Conditioning volatility modifier | Same responses already consumed; feeds `RegimeVolatilityOverlay.apply()` | **No** |

**One real, live, wired exception** — `internalQuantEnsemble.ts` (`computeInternalEnsembleQualification`,
imported and called from **`QuantSignalAgent.ts:54`**, confirmed real live import): combines the
`JAVA_RESEARCH_STRATEGY_IDS` family's votes through `QuantEnsembleEngine.java`'s correlation-adjusted
`effectiveIndependentCount()` math and reports whether the result clears a bar that lets it **"stand
in for a second independent agent"** in ChiefTrader's consensus. Genuinely live-wired — a real
structural input to the independence-count side of consensus math, not a vote in the `emitTradeIdea`
sense. Fails closed on any Java-side error. Distinct from both the 5 CORE strategies and the 6
SHADOW engines' debate-text-only role.

The 117 RESEARCH engines include the entire recent options-strategy catalog, FX/commodities/futures/
CDO structured-product engines, Fixed-Income/Index/Volatility engines, crypto ANN feature primitives,
Black-Scholes pricing/Greeks, and a "Two-Sigma-style" technical-strategy catalog (time-series
momentum, Donchian, MA crossover, ADX trend strength, cross-sectional ranking, z-score/RSI(2)/MACD/
Bollinger mean-reversion variants, VIX efficiency-ratio filter) — all added in the last 4 days.
Spot-checked several against `QuantCoreServer.java`'s route table; registry claims consistent.
**UNVERIFIED per-engine**: mathematical correctness of each of the 117 — not checked line-by-line
this pass (out of effort budget for ~50+ files), marked as a real gap, not silently assumed correct.

### Indicators

| Calculation | TS (authority) | Java | Shadow? | Problem | Evidence |
|---|---|---|---|---|---|
| RSI | `src/server/engines/RSIEngine.ts` | `indicators/RSI.java` | Yes, `PARITY_SHADOW` | None — intentional, disclosed | HIGH, VERIFIED: Java's own doc says "ported byte-for-byte" — confirmed identical algorithm |
| MACD | `src/server/engines/MACDEngine.ts` | `indicators/MACD.java` | Yes | None | HIGH, VERIFIED, same as RSI |
| Bollinger | `src/server/services/technicalSignal.ts` | `indicators/Bollinger.java` | Yes | None | MEDIUM, REGISTRY |
| ATR | `src/server/engines/TechnicalIndicators.ts` | `SymbolState.tickRangeAtr()` | **No — `NOT_A_PARITY_PAIR`** | Java's ATR is a disclosed, non-equivalent tick-range approximation, not a hidden bug | HIGH, VERIFIED: `SymbolState.java`'s own header explicitly documents this |

### The 5 CORE strategies

| Strategy | TS (authority) | Java | Shadow? | Problem | Evidence |
|---|---|---|---|---|---|
| Momentum Breakout | `momentumBreakout.ts` | `strategy/core/MomentumBreakout.java` | **No** — not even shadow-compared | Registered + HTTP-reachable, zero callers | HIGH, VERIFIED |
| Pullback Continuation | `pullbackContinuation.ts` | `PullbackContinuation.java` | No | Same | Same |
| Mean Reversion | `meanReversion.ts` | `MeanReversion.java` | No | Same | Same |
| Trend Following | `trendFollowing.ts` | `TrendFollowing.java` | No | Same | Same |
| Range Reversion | `rangeReversion.ts` | `RangeReversion.java` | No | Same | Same |

**Classification: `IMPLEMENTED BUT NOT WIRED`**, not `PARTIALLY WIRED` or `SHADOW` — no runtime
comparison happens at all for these five, unlike the indicators.

### Risk / execution / backtesting (Node-only by design)

| Component | Owner | Java available? | Notes |
|---|---|---|---|
| RiskEngine (25 gates) | NODE_ONLY | No | Safety-critical, must never move |
| Position sizing | NODE_ONLY | No | Feeds RiskEngine gate 21 |
| OMS | NODE_ONLY | No | Sole `.placeOrder(` caller |
| Broker adapters | NODE_ONLY | No | Zero broker imports/credentials in Java, by design |
| ChiefTrader/EvidenceAggregator consensus | NODE_ONLY | No | No Java counterpart |
| PortfolioMonitor exit intelligence | NODE_ONLY | No | No Java equivalent |
| Reconciliation | NODE_ONLY | No | No Java equivalent |
| Full Argus Replay Engine | NODE_ONLY | No | Reuses real TS ChiefTrader/RiskEngine/OMS math |
| `BacktestEngine.ts` | NODE_ONLY | No | Lightweight TA-rule research engine, `SAME_BAR_CLOSE` |
| `JavaBacktestEngine.java` | JAVA_ONLY | — | Standalone, unwired, NOT cross-validated |

**No "Paper=TS/Backtest=Java" mismatch exists.** Both real backtest/replay paths use the exact same
TS strategy source the live paper path uses. `JavaBacktestEngine.java` is a separate, unused,
uncross-validated third implementation — a dead/duplicate-code risk, not a parity risk.

---

## §5. QuantCoreBridge end-to-end wiring trace

### `QuantCoreServer.java` — complete route table

| Route | Purpose | Confirmed TS caller |
|---|---|---|
| `GET /health` | Process health | Circuit breaker / health probes |
| `POST /api/v1/ticks` | Feeds Java's independent tick buffer | `QuantCoreBridge.sendTick()` — fire-and-forget, no delivery guarantee |
| `GET /api/v1/indicators/{symbol}` | RSI/MACD/BB/ATR/VWAP/regime snapshot | `compareParity()` — shadow-only, logs divergence |
| `POST /api/v1/evaluate` | Runs a named CORE strategy | **NONE** — zero callers anywhere in `src/` |
| `GET /api/v1/features/regime/{symbol}` | Regime classification | `compareRegimeParity()` — shadow-only |
| `POST /api/v1/institutional/factors/{symbol}` | 5-factor composite | `fetchInstitutionalFactors()` → advisory + debate-text |
| `POST /api/v1/institutional/pairs` | Stat-arb pairs | `liveConsumer: NONE` per registry |
| `POST /api/v1/institutional/volatility/{symbol}` | GARCH + realized-vol | `fetchInstitutionalVolatility()` → advisory |
| `POST /api/v1/institutional/regime/{symbol}` | HMM regime | `fetchInstitutionalRegime()` → advisory |
| `POST /api/v1/institutional/features/{symbol}` | Feature pipeline + quality gate | `fetchInstitutionalFeatures()` → advisory |
| `POST /api/v1/institutional/correlation` | EWMA covariance | Tested but unused per registry |
| `POST /api/v1/institutional/ensemble` | Correlation-adjusted vote combination | Unused directly, but `internalQuantEnsemble.ts` uses the same underlying engine via a different route |
| `POST /api/v1/institutional/advisory` | Regime/volatility overlay | Tested but unused |
| `POST /api/v1/institutional/strategy/{id}/{symbol}` | Dispatches to ~10 newly-exposed research engines | **Confirmed live caller**: `internalQuantEnsemble.ts:113` for the `JAVA_RESEARCH_STRATEGY_IDS` subset — the route's own 2026-09-09 code comment ("nothing in JavaQuantAdvisoryService.ts or QuantSignalAgent.ts calls this route yet") is accurate for those two files but incomplete, since `internalQuantEnsemble.ts` (imported by `QuantSignalAgent.ts`) does call it |

### Trace: `/api/v1/evaluate` (hypothetical — no real caller exists)

```text
TS caller:            NONE EXISTS
 ↓ (would be)
QuantCoreBridge:       no evaluate/callEvaluate method exists on QuantCoreBridge.ts today
 ↓
POST /api/v1/evaluate → StrategyRegistry.evaluate(strategyId, ctx) → MomentumBreakout.evaluate(ctx)
 ↓
StrategyEvaluation returned as JSON
 ↓
TS response handling:  NONE — nothing parses this response today
```

**Section 8 conclusion: `REGISTERED_BUT_UNREACHABLE`** — registered, HTTP-reachable in principle,
never actually connected on the TS side.

### Trace: the one real, live institutional-engine path (confirmed)

```text
QuantSignalAgent.ts (real live agent, QUANT_ENGINE_ENABLED gated)
 ↓ imports computeInternalEnsembleQualification (line 54)
internalQuantEnsemble.ts
 ↓ for each id in JAVA_RESEARCH_STRATEGY_IDS: quantCoreBridge.fetchResearchStrategy(id, symbol, bars)
 ↓ POST /api/v1/institutional/strategy/{id}/{symbol}  (real HTTP, real circuit breaker)
Java: handleInstitutionalStrategy → dispatches by id to the matching RESEARCH engine
 ↓ JSON response → combined through QuantEnsembleEngine.java's effectiveIndependentCount() math
 ↓
qualifiesAsIndependent: boolean — real, live, fails closed on any bridge error
 ↓
QuantSignalAgent.ts consumes this for independence-count eligibility in consensus
```

### Circuit breaker / fail-closed behavior

Every one of `QuantCoreBridge`'s 10 `fetch*`/`compare*` methods checks `isQuantJavaCoreEnabled()`
and `this.breaker.isOpen()` before calling, and returns `null`/skips on: flag off, breaker open,
non-2xx response, or any thrown error. **Fail-closed confirmed across all methods, never fail-open.**
Staleness (an old-but-well-formed response) is not independently checked at the bridge layer —
**UNVERIFIED** whether this is a real gap; would need each engine's response schema reviewed
individually, not done this pass.

---

## §6. TS↔Java parity forensics

### What `StrategyParityTest.java` actually tests

103 lines, 9 `@Test` methods (one per strategy plus edge cases). Runs Java strategy classes against
**synthetic, hand-built `StrategyContext` fixtures** — not real bars, not a real feature pipeline's
output. Its own file comment: the feature computation (RegimeEngine/trend/volume/etc.) that would
populate a real `StrategyContext` from live bars is **NOT ported**. Tests decision-boundary outputs
(BUY/SELL/HOLD, confidence) given identical synthetic inputs — real evidence the *decision logic*
matches, given the same inputs. Does **not** test missing-data/invalid-data-behavior parity, or
whether Java's (nonexistent) feature pipeline would ever produce the same context TS's real
`RegimeEngine.ts`/`trend.ts`/`volume.ts`/`priceAction.ts`/`supportResistance.ts`/`MarketContext.ts`
pipeline does from the same real bars.

**Classification: `PARTIAL PORT`, not `FULL JAVA MIGRATION`** — confirmed directly from
`StrategyContext.java`'s own header: "this Phase 1 pass ports the strategies' own decision logic...
not the feature computation itself... A real Phase 1.5 would need to port RegimeEngine/trend/
volume/priceAction/supportResistance/MarketContext before this context could be populated from
live bars in Java — tracked honestly... not silently assumed complete."

### Indicator-level parity — the one real runtime shadow comparison

`ParityComparator.compareSnapshots()` diffs TS-computed vs Java-computed indicator snapshots, logs
`QUANT_CORE_PARITY_DIVERGENCE` when `diffPct > thresholdPct`. Genuinely live, runs in production
paper mode. Source of the previously-established "~80% >5%, ~56% >20%" divergence figures
(`docs/audits/ARGUS_POST_AUDIT_REMEDIATION_PLAN.md`, R8 — established earlier this same
conversation, not re-derived from scratch here, but re-confirmed by independent source reading).

**Root cause (confirmed, not a formula bug):** RSI.java/MACD.java are byte-for-byte ports —
confirmed identical by direct read. The divergence is structural: `tsSideSnapshot()` reads TS's own
`this.priceHistory[symbol]`; Java's `SymbolState.java` maintains an **independently accumulated**
tick ring buffer fed by a fire-and-forget `POST /api/v1/ticks` with no delivery/ordering guarantee
and no periodic resync. A single dropped/reordered tick makes the two input arrays diverge; because
RSI/MACD use recursive smoothing, that divergence propagates forward permanently rather than
self-correcting the way a plain SMA would — explaining large, persistent divergence rather than
rounding-level drift. **Do not widen the tolerance to make this look resolved** — the real fix is a
wire-protocol change (§7, P1).

ATR is explicitly `NOT_A_PARITY_PAIR` — an honestly-labeled different calculation, not a hidden
divergence.

### Java strategy correctness — NOT independently re-derived this pass

Off-by-one, NaN handling, look-ahead leakage, timezone assumptions etc. for the 5 CORE strategies'
Java ports: **UNVERIFIED**. Given they're unreachable from any live path, a correctness defect there
has zero production impact today — it only matters once/if `/api/v1/evaluate` gets a real caller.

### Divergence quantification — carried forward, not re-measured

The "14,207 shadow comparisons" figure comes from the earlier-session remediation plan, not a fresh
count this pass. A fresh count (`SELECT COUNT(*) FROM observability_events WHERE event_type =
'QUANT_CORE_PARITY_DIVERGENCE'`) is a simple, bounded follow-up, not done here.

---

## §7. Remaining work

### P0 — correctness/safety blockers

**None found.** The Java CORE strategies being unwired is not a safety blocker — TypeScript's
versions are the sole production authority. The indicator-level divergence is confined to a shadow
log event that never reaches a trading decision. No finding here weakens RiskEngine, ChiefTrader
thresholds, OMS, or broker safety controls.

### P1 — architecture / quant-engine work (proven necessary)

1. **Root-cause fix for the RSI/MACD/Bollinger indicator parity divergence** — redesign the wire
   protocol so Java compares against the exact array TS holds (full-array payload per comparison,
   or a sequence-numbered/acknowledged tick-delivery scheme) instead of an independently-accumulated
   buffer. A genuine cross-language protocol change — design deliberately, do not rush.
2. **Decide the fate of the 5 CORE Java strategy ports.** Either wire `/api/v1/evaluate` into a
   real shadow-comparison caller (mirroring `compareParity()`'s pattern) to start accumulating real
   divergence evidence before ever considering a vote, or explicitly document them as
   parity-test-only artifacts with no near-term wiring plan. Leaving them silently unwired with no
   stated plan is the actual current gap.
3. **Port the feature-computation pipeline to Java** if full strategy migration is ever pursued —
   named as unstarted Phase 1.5 work in `StrategyContext.java`'s own header. Not started.
4. **Resolve `JavaBacktestEngine.java`'s orphan status** — wire it (with a real parity test first)
   or mark it explicitly deprecated/research-only to prevent anyone trusting its output as
   comparable evidence.
5. **Concurrency and performance audits (never done)** — not urgent given current unwired status,
   but a real precondition before any Java engine is considered for a live vote.

### P2 — research / enhancement (not blockers)

1. Wire more of the ~10 newly-HTTP-exposed research engines to a real consumer beyond the one
   confirmed live path (`internalQuantEnsemble.ts`'s narrow subset).
2. Real backtest/walk-forward/paper evidence for any of the 117 RESEARCH-status engines before
   considering promotion — none exists today beyond synthetic unit tests.
3. Decide whether/how to invoke the tested-but-unused TS callers (`fetchInstitutionalCorrelation`,
   `fetchInstitutionalEnsemble`, `fetchInstitutionalAdvisory`) — a real design decision (which
   models feed an ensemble, cross-symbol correlation needs) explicitly not yet made.
4. Read `tests/parity/test_strategy_context_parity.ts`/`test_strategy_evaluate_parity.ts` before
   assuming zero existing work toward the StrategyContext-parity gap (P1.3) — found by filename
   search, not opened this pass.
5. Fresh divergence quantification once/if P1.1's fix is designed, to measure before/after impact.

### Explicitly NOT remaining work (already correctly resolved or correctly deferred)

- Paper=TS/Backtest=Java mismatch — does not exist.
- ATR TS/Java parity — not a real gap; disclosed as `NOT_A_PARITY_PAIR`.
- Full line-by-line correctness review of the 5 CORE Java ports — real, but low-priority while
  unreachable (P1.2 resolves the priority ordering: decide wiring intent first).

---

## §8. Master strategy table

| Strategy ID | TS | Java | Registered | Enabled (live) | Runtime Caller | Backtest | Verdict |
|---|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | Yes | Yes (unwired) | Yes | Always | `evaluateAll()` via `QuantSignalAgent.ts` | Yes | **CORRECT / ACTIVE** |
| PULLBACK_CONTINUATION | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| MEAN_REVERSION | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| TREND_FOLLOWING | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| RANGE_REVERSION | Yes | Yes (unwired) | Yes | Always | Same | Yes | **CORRECT / ACTIVE** |
| SMC_LIQUIDITY_SWEEP | Yes | No | Yes | `QUANT_SMC_STRATEGY_ENABLED` | `findStrategy()`, live only if flag true | Yes | UNVERIFIED (flag not checked) |
| VWAP_VOLUME_STRUCTURE | Yes | No | Yes | `QUANT_VWAP_STRUCTURE_ENABLED` | Same pattern | Yes | UNVERIFIED |
| OPENING_RANGE_BREAKOUT | Yes | No | Yes | `QUANT_ORB_STRATEGY_ENABLED` | Same | Yes | UNVERIFIED |
| VWAP_MEAN_REVERSION | Yes | No | Yes | `QUANT_VWAP_REVERSION_ENABLED` | Same | Yes | UNVERIFIED |
| DONCHIAN_BREAKOUT | Yes | No (separate unwired research engine, not the same path) | Yes | `QUANT_DONCHIAN_STRATEGY_ENABLED` | Same | Yes | UNVERIFIED |
| MA_CROSSOVER | Yes | No (separate) | Yes | `QUANT_MA_CROSSOVER_ENABLED` | Same | Yes | UNVERIFIED |
| OSCILLATOR_MOMENTUM | Yes | No | Yes | `QUANT_OSCILLATOR_MOMENTUM_ENABLED` | Same | Yes | UNVERIFIED |
| BOLLINGER_VOLATILITY | Yes | No (separate) | Yes | `QUANT_BOLLINGER_VOLATILITY_ENABLED` | Same | Yes | UNVERIFIED |
| PREVIOUS_PERIOD_BREAKOUT | Yes | No | Yes | `QUANT_PREVIOUS_PERIOD_BREAKOUT_ENABLED` | Same | Yes | UNVERIFIED |
| CANDLESTICK_REVERSAL | Yes | No | Yes | flag (name not confirmed) | Same | Yes | UNVERIFIED |
| GAP_CONTINUATION | Yes | No | Yes | `QUANT_GAP_STRATEGY_ENABLED` | Same | Yes | UNVERIFIED |
| FIBONACCI_PULLBACK | Yes | No | Yes | `QUANT_FIBONACCI_PULLBACK_ENABLED` | Same | Yes | UNVERIFIED |
| VOLUME_CONFIRMATION | Yes | No | Yes | `QUANT_VOLUME_CONFIRMATION_ENABLED` | Same | Yes | UNVERIFIED |
| SR_BOUNCE | Yes | No | Yes | `QUANT_SR_BOUNCE_ENABLED` | Same | Yes | UNVERIFIED |
| RELATIVE_STRENGTH_ROTATION | Yes | No | Yes | `QUANT_RELATIVE_STRENGTH_ENABLED` | Same | Yes | UNVERIFIED |
| STATISTICAL_MEAN_REVERSION | Yes | No | Yes | `QUANT_STATISTICAL_REVERSION_ENABLED` | Same | Yes | UNVERIFIED |

**16 experimental strategies' "UNVERIFIED" verdicts**: the gating *mechanism* is confirmed (each
checked at call time via its own env var, per `StrategyEngine.ts`'s own header), but the current
`.env` value of all 16 flags was not individually checked this pass — a bounded, mechanical
follow-up, not done to keep this pass's effort on the CORE-strategy Java-wiring question.

**Wyckoff: NOT IMPLEMENTED** — zero matches anywhere in `src/server/quant/`, `quant-core-java/`, or
`config/*.json`. Not represented as production-ready anywhere found, so not a documentation defect
either, per the audit brief's own instruction.

### Validation status — TS CORE strategies

| Check | Status | Evidence |
|---|---|---|
| Unit tested | PASS | `momentumBreakout.test.ts` confirmed; others presumed similar |
| Integration tested | PASS | `StrategyEngine.test.ts` |
| Golden/parity tested (vs Java) | PASS, narrow scope | Synthetic fixtures only — see §6 |
| Runtime tested | UNVERIFIED | Not observed live this pass |
| Backtested | PASS (mechanism) | No profitability claimed |
| OOS/Walk-forward/Monte Carlo/Permutation/Sensitivity/Cost-stress/Multi-testing-controlled | **FAIL/UNVERIFIED** | CLAUDE.md's own ground truth: walk-forward OOS failed |
| Promotion eligible | **NO** | `LIVE_NO_GO`, organic paper edge not established |

---

## §9. Zero-signal investigation

CLAUDE.md's ground truth (re-confirmed via direct DB query earlier this same conversation): organic
closed PAPER FILLED SELL P&L is 0; only 3 real PAPER trades ever (Aug 20-21, 2026), zero since.
**Not established as a quant-engine-specific defect this pass**:

```text
Strategy evaluated:  YES (evaluateAll() runs whenever QUANT_ENGINE_ENABLED=true with a populated
                     StrategyContext)
Conditions passed:   UNVERIFIED — would require reading quant_assessments for a recent window,
                     tabulating per-strategy BUY/SELL vs HOLD counts; not done this pass
Primary blocker:     Not established from source for the quant strategies specifically. CLAUDE.md's
                     existing agent-layer finding (0/38 buckets clear statistical significance) was
                     not re-derived for quant strategies in isolation this pass.
```

Marked UNVERIFIED rather than asserting a cause, per the mission's explicit instruction against
inventing root causes.

---

## §10. What this audit did NOT do (explicitly, not silently)

- Line-by-line correctness review of the 117 RESEARCH-status Java engines (~50+ files) — out of
  effort budget this pass.
- Concurrency/thread-safety review beyond confirming `SymbolState.java`'s methods are `synchronized`
  and the server uses a virtual-thread-per-task executor.
- Performance measurement (p50/p95/p99 latency) for any Java Quant Core route.
- Individual `.env` flag-state check for the 16 experimental TS strategies.
- Reading `tests/parity/test_strategy_context_parity.ts`/`test_strategy_evaluate_parity.ts` (found,
  not opened).
- Fresh count of live `QUANT_CORE_PARITY_DIVERGENCE` events (relied on the earlier-session figure).

These are named explicitly so this document is not mistaken for more complete than it is.
