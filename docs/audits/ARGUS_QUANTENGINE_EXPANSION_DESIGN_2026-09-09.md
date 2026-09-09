# Argus — QuantEngine Expansion & Quant-Specific Post-Market Learning: Audit & Design (2026-09-09)

**Status: design only, no code changed.** This document builds directly on
`docs/audits/ARGUS_POSTMARKET_PREMARKET_INTELLIGENCE_DESIGN_2026-09-09.md` (published earlier the
same session) — point-in-time integrity, the missed-opportunity taxonomy, the synthetic
look-ahead-bias test, database-design conventions, and the phased-rollout philosophy are **not
re-derived here**; this document cites and extends them for the quant-strategy-specific slice.
Everything below is grounded in direct code inspection this session (much of it via a dedicated
read-only research pass — see citations) or in code already read earlier this session. **NOT
VERIFIED** is used honestly wherever evidence was incomplete.

**Governing constraint, unchanged from the companion report:** this remains
`OBSERVATION → ANALYSIS → DIAGNOSIS → RESEARCH RECOMMENDATION`. No part of this design places an
order, modifies RiskEngine/OMS/BrokerManager, or auto-changes a live weight/threshold/strategy
parameter. Every "learning" output is a recommendation for a human-reviewed research process, never
a self-modification loop.

---

## §1. Current QuantEngine architecture — audit findings

### 1.1 QuantSignalAgent already votes like every other agent — this is not a new integration
`src/server/services/QuantSignalAgent.ts` (607 lines) is a real, timer-driven (5-min cycle, not
tick-driven — deliberate, since daily bars don't update per-tick), fully gated
(`QUANT_ENGINE_ENABLED`, off by default) agent that already emits through the exact same
`eventBus.emitTradeIdea()` → `gateTradeIdea()` path as `TechnicalAgent`, already has a reserved
weight in `config/agentWeights.json` (`"QuantEngine": 0.15`), and already requires the same
`minIndependentAgreeingAgents` floor as everyone else. **There is no separate "QuantEngine
integration" to design — it's live-path-ready today, just off by default and, per the operator's
own paper-trading floor, unproven.**

Its real pipeline: `HistoricalDataGateway` (1Day bars, 400-day lookback) → `classifyRegime()`
(`RegimeEngine.ts`) → builds one `StrategyContext` reusing regime's already-computed
trend/volatility/price-action fields (§3) → `evaluateAll(ctx)` → regime-adaptive hard filter
(`selectEvaluationsForAdaptiveRegime()`, `strategyFocus.ts`) → quarantine filter → regime ranking →
bounded-exploration reordering → `bestStrategyIdea()` → a **live-measured** EV/R:R gate
(`ExpectedValue.ts`, real win-rate sample, refuses under `MIN_SAMPLE_SIZE_FOR_KELLY`) before
emission. This EV gate is itself a real anti-overfitting control already in production code — a
strategy with too few real observed outcomes cannot emit a normal idea at all; it can only reach an
explicitly operator-gated `COLD_START_BOOTSTRAP` path with no EV/stop/target.

### 1.2 Five CORE strategies + 16 experimental — real, regime-scoped, not RSI variations
`src/server/quant/strategies/StrategyEngine.ts`. CORE = `momentumBreakout`, `pullbackContinuation`,
`meanReversion`, `trendFollowing`, `rangeReversion` — each genuinely regime-scoped
(`applicableRegimes`), each using structurally different evidence (BOS/CHoCH structure breaks +
RVOL/ATR for momentum; SMA20 pullback + reversal candle for pullback-continuation; Keltner +
Stochastic-RSI extremes for mean-reversion; MA-stack + DMI/ADX + MACD + CMF for trend-following;
S/R-boundary fade for range-reversion). `findStrategy(id)` searches CORE then
`EXPERIMENTAL_STRATEGIES` (16 more: SMC, VWAP structure/reversion, ORB, Donchian, MA crossover,
oscillator momentum, Bollinger volatility, previous-period breakout, candlestick reversal, gap
continuation, Fibonacci pullback, volume confirmation, S/R bounce, relative-strength rotation,
statistical mean reversion — `config/quantExperimentalStrategies.json`, all explicitly marked
`UNVALIDATED`), confirming CLAUDE.md's claim that backtests reach experimental strategies without
the live flag.
`regimeMismatchConfidenceMultiplier` = 0.5 (discount, never zero) when a strategy fires outside its
own declared regime.

### 1.3 A real, working TypeScript regime classifier already gates strategy activation
`RegimeEngine.ts`'s `classifyRegime()` produces `BULLISH_TREND | BEARISH_TREND | SIDEWAYS_RANGE`
plus volatility/structure labels, each confidence-scored (min 2 real independent signals required
before calling a trend). **`strategyFocus.ts`'s `selectEvaluationsForAdaptiveRegime()` already does
real regime-gated strategy activation in the live path today** — a hard filter to
regime-preferred CORE strategies under the default "Adaptive" focus, confidence-boosted, with a
documented `@deprecated` soft-boost fallback. This is a second, harder mechanism layered on top of
`evaluateAll()`'s softer 0.5× discount — the request's Phase M ("regime-aware strategies... ACTIVE/
INACTIVE/LOW_CONFIDENCE") is **already substantially built**, not new work.

### 1.4 Java side: 43 registered quant models, 6 SHADOW, 37 RESEARCH — activation gap, not a code gap
`config/engineOwnership.json`'s `quantModels` section has **43 real entries** (not "~35" —
CLAUDE.md's own count is an approximation). 6 are `SHADOW` (garch, hmm_regime, factor_composite,
market_data_quality, feature_pipeline, volatility_engine — the three headline models plus three
infrastructure/conditioning engines exercised by the same live advisory calls). **37 are `RESEARCH`**
— real, unit-tested Java classes with `httpEndpoint: "NONE"`, `liveConsumer: "NONE"`. This includes
exactly the strategy families the request asks to build: `time_series_momentum`,
`donchian_channel`, `moving_average_crossover` (Golden/Death Cross — already exists, confirmed this
session), `trend_strength_adx`, `cross_sectional_ranking`, `mean_reversion_zscore`,
`intraday_gap_reversal`, `stochastic_oscillator`, `volume_signal`, plus this session's own new
additions (`rsi_mean_reversion`, `macd_crossover`, `bollinger_mean_reversion`). **The overwhelming
majority of the "large diversified strategy library" the request asks for already exists in Java,
unwired.** The actual gap is registration, feature-computation input (most of these engines need
real intraday/multi-bar features this environment doesn't fully have — §1.6), and validation — not
missing strategy code.

### 1.5 `QuantEnsembleEngine.java` already implements the exact anti-vote-inflation math this request asks for
`institutional/models/QuantEnsembleEngine.java` computes `effectiveIndependentCount()` via the
Kish design-effect / Grinold-Kahn breadth formula:
`N_eff = (Σw)² / ΣΣ(w_i·w_j·ρ_ij)` — precisely the "10 correlated momentum variants should not
count as 10 independent confirmations" mechanism §3 and §9/§20 of the request ask for. **This is
real, tested, working code, not a proposal.** Its one honest, stated limitation: no real historical
per-model correlation store exists yet, so `defaultFamilyCorrelationMatrix()` supplies a **reviewed
assumption** (same-family ρ=0.75, cross-family ρ=0.15), not a measured value. `RegimeVolatilityOverlay.java`
provides the companion regime/volatility-based scaling-and-gating layer (its own declared
assumptions, also not yet backed by per-regime measured evidence). Both are `RESEARCH`,
`liveConsumer: "NONE"`.
**Design implication: do not build a new ensemble engine. Validate and wire this one.**

### 1.6 The single biggest real constraint: intraday multi-timeframe data barely exists
Live query this session, `ohlcv_bars`: `1Day` = 599 symbols / 171,525 bars (broad, real, 2018-2026).
`1Min` = 224 symbols / 61,085 bars (~273 bars/symbol — a few weeks, not months). `5Min` = **1
symbol**, 177 bars. **`15Min`/`30Min`/`1Hour` do not exist in the table at all — zero rows.** Any
part of this request assuming genuine 5m/15m/1h multi-timeframe confirmation is currently
unbuildable without a real new intraday bar-acquisition effort (§1.13). This is not a "narrow"
gap to work around cheaply — it's absent data, and the honest recommendation is to design the
strategy library primarily around daily bars (broad, real) plus the 224-symbol 1-minute set where
genuinely needed, not to promise multi-timeframe breadth the data can't support yet.

### 1.7 No `TradeIdea` type exists — it's `any`, with two guaranteed fields
`EventBus.emitTradeIdea(idea: any)`. `gateTradeIdea()`'s `GatedTradeIdea.idea` type is
`Record<string, unknown> & { symbol: string; currentPrice: number }` — only `symbol` and
`currentPrice` are contractually guaranteed; `side`, `confidence`, `reasoning`, `agent`, `strategy`,
`timeframe`, `evidence` are all convention, not enforced. **A `QuantTradeDecision` schema (§4) is
new type discipline, not an extension of an existing strict contract.**

### 1.8 No SELL/exit-side quant strategy exists, and none is planned to
`PortfolioMonitor.ts` imports zero `QuantCoreBridge`/Java symbols. `engineOwnership.json`'s own
`portfolio_monitor_exit_intelligence` entry: `"javaAvailable": false, "notes": "Stop-loss/
take-profit/trailing/thesis-invalidation - no Java equivalent."` — a source-confirmed, intentional
design boundary, not an oversight. `ThesisInvalidation.ts` (TS-only) is the real quant-derived exit
trigger, feeding PortfolioMonitor's SELL *ideas* through the normal pipeline (never a raw flatten).
The 5 CORE/16 experimental strategies are direction-symmetric entry generators, not a distinct exit
model. **Recommendation: keep this boundary. Do not build a Java exit engine as part of this
initiative — it would duplicate `ThesisInvalidation.ts`'s role without a demonstrated need.**

### 1.9 Look-ahead bias, costs, survivorship — mixed, mostly good news
- `canonicalNextBarEngine.ts`: genuinely look-ahead-safe — entries fill at `bars[i+1].open`, never
  the signal bar's own close. Real commissions + spread/slippage-in-bps, config-driven
  (`researchSafety.commissionPerShare`/`slippageBps`), with an explicit, disclosed
  `THEORETICAL_ZERO_COST` escape hatch (opt-in, not a silent default).
- `BacktestEngine.ts`: real dynamic (volatility/size-scaled) slippage + commissions on every fill —
  **not** zero-cost. Self-discloses its own `SAME_BAR_CLOSE` limitation in its header and is marked
  non-promotable by its own code.
- Survivorship bias: **NOT VERIFIED** — not checked this session (does `ohlcv_bars` retroactively
  exclude delisted symbols, or was it populated only from currently-listed tickers?). Flag as an
  open question before any cross-sectional-ranking strategy (§1.4's `cross_sectional_ranking`) is
  ever validated — survivorship bias specifically corrupts exactly that kind of strategy.

### 1.10 No Wilson-lower-bound or equivalent statistical-confidence methodology exists in Java
Confirmed by direct grep: zero matches for `Wilson`/`wilsonLowerBound` anywhere in `quant-core-java/`.
All of it — `ChampionChallengerService.ts`, `CalibrationCandidateBuilder.ts`, the MODERATE-tier
calibration-trust gate this session already investigated in depth (currently trusting **zero**
agent/bucket pairs, by design, pending real evidence) — is TypeScript-only today. **This is the
single largest missing piece for §6/§7's certification-tier math**: Java has the correlation-adjusted
ensemble math (§1.5) but not the statistical-significance floor. Either port the TS methodology to
Java, or keep the statistical-significance check in TypeScript and have the Java ensemble result
flow back through it — the latter is less new code and matches the "reuse, don't fork" principle
already governing this codebase (see §4 for the recommended split).

### 1.11 Feature reuse already happens, just intra-cycle, not persisted
`QuantSignalAgent.evaluateSymbol()` computes trend/volatility/price-action **once** via
`classifyRegime()`, builds one `StrategyContext`, and every strategy in `evaluateAll()` reads
already-computed fields off it — genuinely no per-strategy RSI/MACD/SMA recomputation. There is no
cross-cycle persistent cache, and no shared feature layer between TypeScript and Java (Java's
`FeaturePipeline.java` is a separate, Java-only feature-gating mechanism for the institutional
advisory endpoints). **The "shared FeatureEngine" the request asks for (§3 below) already exists at
the TS layer in miniature — the real gap is a Java-side equivalent and cross-language reuse, not
inventing the concept from scratch.**

### 1.12 The `historicalBarProvider.ts` registry is a single-slot IBKR override point, not a pub/sub
One real registrant (`BrokerManager.ts`, only when IBKR is active), three consumers
(`HistoricalDataGateway.ts`, replay's `HistoricalDataProviderRegistry.ts`, `QuantSignalAgent.ts`'s
429-abort check). It decouples `HistoricalDataGateway` from importing `BrokerManager` directly — not
a multi-backend broker-data bus. Not directly relevant to a new strategy library beyond "this is how
you'd plug in a new historical-bar source if one were ever added."

### 1.13 `QuantCoreBridge.ts` / Java service — real circuit breaker, real startup path
7 fetch methods confirmed (`fetchInstitutionalVolatility/Factors/Features/Correlation/Ensemble/
Advisory/Regime`), a real `CircuitBreaker` (opens after `quantJavaCoreCircuitBreakerFailureThreshold`
= 3 consecutive failures, auto-closes after 30s), fails closed (`null`) on any error/disabled-flag/
open-breaker. The Java HTTP service (`:8085`) is started by `scripts/lib/javaQuantCoreLauncher.ts`
(both the full dev ecosystem and the lean headless daemon), gated on `QUANT_JAVA_CORE_ENABLED`, with
a file lock to avoid double-spawn and a `mvn package` fallback if the jar is missing. This is a
mature, production-shaped integration boundary already — no new infrastructure needed for more
Java strategies to reach TypeScript, they just need HTTP endpoints wired (most currently have none).

---

## §2-§3. Strategy taxonomy & shared feature engine — design

**Do not build a new taxonomy from scratch — catalog what already exists (§1.2, §1.4) against the
request's family list, and only design NEW work for genuine gaps.**

| Family | TS (live-eligible) | Java (RESEARCH, unwired) | Genuine gap |
|---|---|---|---|
| Trend | trendFollowing, MA-crossover(exp) | moving_average_crossover, trend_strength_adx, time_series_momentum, donchian_channel | none — activation only |
| Momentum | momentumBreakout, oscillatorMomentum(exp) | time_series_momentum, cross_sectional_ranking | multi-timeframe momentum (blocked by §1.6) |
| Mean reversion | meanReversion, VWAP-reversion(exp), Bollinger-volatility(exp), statistical-reversion(exp) | mean_reversion_zscore, rsi_mean_reversion (new, this session), bollinger_mean_reversion (new), stochastic_oscillator | none — activation only |
| Breakout | momentumBreakout, ORB(exp), Donchian(exp), previous-period-breakout(exp) | donchian_channel, intraday_gap_reversal | ORB/opening-range needs intraday bars (§1.6) |
| Volatility | (regime volatility label only) | volatility_engine (SHADOW), volatility_mean_reversion, volatility_targeting, value_at_risk | genuine new work if Bollinger-bandwidth/vol-percentile strategy wanted beyond what exists |
| Volume | volume-confirmation(exp) | volume_signal | genuine new work for OBV/accumulation-distribution specifically |
| VWAP | VWAP-structure(exp), VWAP-reversion(exp) | none found | genuine new Java work if VWAP-reclaim/rejection wanted as a Java engine |
| Market structure | BOS/CHoCH already inside momentumBreakout/pullbackContinuation | none found | already covered inside existing strategies, not a separate family needed |
| Relative strength | relative-strength-rotation(exp) | cross_sectional_ranking | needs sector/index daily bars — available (§1.6, daily is broad) |
| Cross-sectional | none TS | cross_sectional_ranking | needs survivorship-bias check first (§1.9) |
| Multi-timeframe | none | none | **blocked** — no 15m/30m/1h data exists (§1.6); do not build until data does |
| Regime-aware | RegimeEngine + strategyFocus.ts (§1.3) | market_regime_engine, regime_volatility_overlay | already substantially built |

**FeatureEngine**: extend the existing pattern (§1.11), don't replace it. TypeScript side: formalize
`QuantSignalAgent`'s inline `StrategyContext`-building into a named, testable
`buildSharedFeatureContext(bars)` function (pure refactor, zero behavior change) so future strategies
— TS or a Java-ensemble consumer — read one already-computed context. Java side: `FeaturePipeline.java`
already exists for the institutional endpoints; extend it to serve the new RESEARCH strategy engines
their required inputs (most currently take raw `double[]` arrays directly, per §1's file reads —
already efficient, O(n) per indicator, no redundant recomputation within a single evaluate() call).

## §4. Strategy interface & QuantTradeDecision schema

New, since none exists (§1.7). Recommended shape (TypeScript, since this is where `emitTradeIdea`
lives):

```ts
interface QuantStrategySignal {
  strategyId: string;       // e.g. "rsi_mean_reversion" — matches engineOwnership.json key
  strategyVersion: string;  // e.g. "1.0.0" — see §18 lifecycle, immutable per version
  family: string;           // "TREND" | "MOMENTUM" | "MEAN_REVERSION" | ... (§2 table)
  symbol: string;
  timeframe: string;        // "1Day" | "1Min" — honest about what's actually available (§1.6)
  timestamp: string;
  signal: 'BUY' | 'SELL' | 'HOLD' | 'NO_SIGNAL' | 'INSUFFICIENT_DATA';
  strength: number;         // 0-1, raw signal magnitude before any weighting
  confidence: number;       // 0-1, post-regime-discount (mirrors evaluateAll()'s existing 0.5x pattern)
  featuresUsed: string[];
  regime: string;
  dataQuality: number;      // 0-1
  explanation: string;      // deterministic, template-built — never AI-authored (§14/§26)
}
```

`QuantTradeDecision` (the ensemble's own output, distinct from a single strategy signal):
`{ direction, ensembleScore, confidence, supportingStrategies, opposingStrategies,
supportingFamilies, effectiveIndependentCount (from QuantEnsembleEngine.java, §1.5), regime,
diversityScore, dataQuality, tier (§6) }`. This feeds `emitTradeIdea()` exactly as `QuantSignalAgent`
already does today (§1.1) — same entry point, richer payload in the existing `evidence`/`quantDetail`
bag fields, no new emission path.

## §5. Ensemble voting mathematics

**Do not invent new math — validate and wire `QuantEnsembleEngine.java` (§1.5).** Its
`effectiveIndependentCount()` formula already solves the exact "10 momentum variants ≠ 10
independent votes" problem. What's missing, concretely:
1. A **measured** correlation matrix (real historical signal-correlation, per §9/§20 of the request)
   to replace the current reviewed-assumption 0.75/0.15 values — this requires the strategy
   performance ledger (§7) to exist first; it cannot be built before real signal history accumulates.
2. A statistical-significance floor on top of the correlation-adjusted score — reuse the TS-side
   Wilson-lower-bound methodology (§1.10) rather than porting it to Java; the ensemble computation
   can stay Java-side and hand its `effectiveIndependentCount`/`ensembleScore` back to a TypeScript
   caller that applies the SAME calibration-trust check `ModerateTierEvaluator.ts` already uses.

## §6. Quant decision tiers (certification model)

Derived from what already exists, not invented thresholds:

| Tier | Requirement |
|---|---|
| `QUANT_NO_SIGNAL` | No strategy cleared `minStrategyConfidenceToTrade` (0.6, existing config) |
| `QUANT_WEAK` | 1 strategy family, confidence 0.6-0.75 |
| `QUANT_MODERATE` | ≥2 families, `effectiveIndependentCount` ≥ 2 (real, not raw count), confidence ≥ `moderateMinConfidence` (0.6, existing config, reused not duplicated) |
| `QUANT_STRONG` | ≥3 families, `effectiveIndependentCount` ≥ 2.5, confidence ≥ `consensusApprovalThreshold` (0.75, existing config) |
| `QUANT_CERTIFIED` | `QUANT_STRONG` **plus** every contributing strategy has cleared real out-of-sample validation (§18 CERTIFIED lifecycle stage) **and** a Wilson-lower-bound-above-chance calibration champion exists for its bucket (§1.10, §5) |

No strategy reaches `QUANT_CERTIFIED` today — none has any historical ledger yet (§7 doesn't exist).
This tier is aspirational by construction, matching the existing MODERATE-tier's own honest
"expected to approve zero ideas until real evidence changes that" posture.

## §7-§9. Post-market quant learning: ledger, scorecard, correlation

**Extend the companion report's `opportunity_outcomes`/`agent_performance_daily` design (already
proposed), don't duplicate it.** New quant-specific tables, following that report's
`data_timestamp`/`observation_timestamp`/`decision_timestamp` convention:

- `quant_strategy_signals` — every strategy evaluation (not just emitted ideas), immutable, keyed by
  `(strategy_id, strategy_version, symbol, signal_timestamp)`.
- `quant_signal_outcomes` — forward returns (5m/15m/30m/60m/EOD — 5m/15m/30m/60m require intraday
  data that doesn't exist at scale yet, §1.6; EOD is fully supportable today off daily bars), MFE/MAE,
  computed via the exact `PredictionOutcomeEvaluator.ts`/`MissedOpportunityEvaluator.ts` real-bars
  pattern already proven this session — **not a new evaluation mechanism, the third consumer of the
  same one.**
- `quant_strategy_daily_metrics` — the date-partitioned scorecard (hit rate, expectancy, MFE/MAE,
  precision/recall/calibration, by regime/timeframe/symbol/time-of-day) — this is the
  `agent_performance_daily` table from the companion report, scoped/joined to quant strategies
  specifically rather than a wholly separate table.
- `quant_strategy_correlation` — pairwise signal/return/error correlation, computed periodically once
  enough signal history exists (needs real sample size — do not compute from <20 co-occurring
  signals, matching Kelly's existing 20-trade floor convention in this codebase).
- **Strategy versioning is mandatory and enforced at the schema level**: `strategy_id` +
  `strategy_version` is a compound key everywhere; a parameter change is a new version row, never an
  overwrite — directly matches this codebase's existing `ChampionChallengerService.ts` versioning
  discipline (`CalibrationCandidateBuilder.ts`'s `calibrationVersionType(agent, bucket)` pattern).

## §11-§13. Missed quant opportunities, false signals, strategy interaction

**Reuse `MissedOpportunityDetector.ts`'s classification pattern, add strategy-specific
sub-reasons.** The companion report already proposes `CORRECT_NON_ACTION`/`UNIVERSE_GAP` categories;
for quant specifically, extend `classifyMiss()`'s reasoning to distinguish, when a candidate was
`AGENT_MISS`-classified and QuantEngine specifically had no signal: `THRESHOLD_MISS` (real evidence
present, config threshold too strict — checkable by re-running the strategy's `evaluate()` with a
research-only looser threshold against the SAME point-in-time bars, never live), `FEATURE_MISS`
(the underlying feature genuinely wasn't computable — e.g. an intraday feature blocked by §1.6),
`REGIME_MISS` (strategy was regime-filtered out by `selectEvaluationsForAdaptiveRegime()`, §1.3),
`UNPREDICTABLE` (re-running the strategy against T0 evidence still produces no signal — honest
absence, not a bug). **False-signal learning (§13) and strategy-interaction learning (§14) are the
SAME real-bars evaluation mechanism (§7-9) applied to signals that fired but lost, and to
co-occurring signal combinations — no new evaluation engine, just new groupings of the same
outcome data.** Do not build three separate pipelines for "missed," "wrong," and "combinations" —
they're one ledger, sliced three ways.

## §16. The two-agent question — verdict

**Recommendation: B — add QuantEngine internal ensemble voting, but do not let it independently
qualify a TradeIdea yet. Keep the two-agent requirement.**

Reasoning, directly from evidence gathered this session, not policy reflex:
1. The infrastructure to do this rigorously (`QuantEnsembleEngine.java`'s correlation-adjusted
   effective-independent-count math, §1.5) **already exists** — but its correlation matrix is an
   unmeasured, reviewed assumption, and there is zero historical strategy-performance ledger (§7)
   to prove that "strong internal consensus" actually predicts better outcomes than weak consensus.
   Allowing an independent-qualification exception on top of unvalidated math is exactly the
   "hindsight looks like foresight" risk the operator's own post-market design brief warned against.
2. This mirrors, precisely, the MODERATE tier's own current honest state (currently trusting zero
   agent/bucket pairs, by design, pending real evidence) and the `factor_composite` vote's original
   documented precondition (a real multi-week shadow-soak) — **both of which this same session
   already saw explicitly overridden by direct operator instruction** (TradePlanBuilder 2026-09-05,
   JavaFactorComposite 2026-09-09). That's worth naming directly: the pattern this session has been
   in is "override the wait-for-evidence gate when asked to." My recommendation here is the
   opposite — hold this one — because unlike those two prior overrides (each a single, bounded new
   vote source), granting QuantEngine's *internal* ensemble independent-qualification authority
   changes what "two independent agents agree" *means* system-wide, and does so with a correlation
   matrix that is admittedly a guess, not measured data. If the operator wants to override this one
   too, that's their call to make explicitly — this recommendation is not a refusal, it's the
   evidence-based answer to "should this," separate from "can I be told to anyway."
3. Real intraday multi-timeframe data doesn't exist yet (§1.6) — so even a validated ensemble
   would be drawing "independent" evidence largely from daily-bar variations of the same underlying
   price series, not genuinely different information sources.

**Path to reconsidering (Model B → D, hybrid) — concrete, evidence-gated:** once (a) `quant_strategy_
correlation` has ≥90 days of real signal history across ≥5 strategy families, (b) `QuantEnsembleEngine`'s
correlation matrix is rebuilt from that measured data, (c) the Model-A-vs-Model-B replay experiment
(§22 of the request) is actually run on real historical/replay data and shows QUANT_STRONG-tier
consensus outperforming QUANT_WEAK-tier on out-of-sample precision/expectancy, only then propose a
hybrid exception — and even then, scope it to `QUANT_CERTIFIED` tier only (§6), BUY and SELL
evaluated separately (a SELL exception is lower-risk than a BUY exception, since it can only exit
capital already at risk, not commit new capital), and require the SAME `isLiveIdeaGenerationEnabled()`/
data-quality/Autobot gates every other path already has.

## §17-19. AI provider failure, exit logic, database

**AI provider failure**: already proven safe this session — `ChiefTraderAgent.ts:455-473`'s
"skip the debate when no routable provider exists" path means QuantEngine's fully-deterministic
signals (§1.1-§1.5, zero AI dependency anywhere in the strategy math) already function with 0/10 AI
providers healthy. Nothing to build here — it's an existing, already-correct property, confirmed by
code, not policy.

**Exit logic**: keep the existing TS-only boundary (§1.8). No new work recommended.

**Database**: new tables (§7-9) reuse the companion report's column conventions
(`data_timestamp`/`observation_timestamp`/`decision_timestamp`, retention policy from day one).
`quant_experiments`/`quant_promotion_history` (§18/§28 below) are the two genuinely new tables beyond
what §7-9 already covers.

## §18. Strategy lifecycle & certification

`EXPERIMENTAL → BACKTESTING → OUT_OF_SAMPLE → WALK_FORWARD → PAPER_VALIDATION → CERTIFIED →
DEGRADED → RETIRED`, mirroring `ChampionChallengerService.ts`'s existing CANDIDATE→CHAMPION pattern
(§1.10) rather than inventing a parallel lifecycle concept. Promotion/demotion criteria: identical
sample-size and Wilson-lower-bound-above-chance requirements already enforced for calibration
champions today (§1.10) — reuse the exact numbers (`moderateCalibrationTrustMinWilsonLowerBound` =
0.5, `championChallengerMinSampleSize` = 20) rather than deriving new ones. A strategy version is
`DEGRADED`, not silently re-evaluated, if a CHAMPION's Wilson lower bound is later re-checked and
falls below the floor — directly reusing the exact stale-champion re-validation fix already shipped
in `ModerateTierEvaluator.ts` (§1.10) for this new context.

## §22. Quant daily report

Extend the companion report's `postmarket_reports` structure (already designed) with a
quant-specific section — do not create a second, separate daily-report mechanism. Top/worst
strategies, family performance, ensemble-tier outcome comparison (§16's own evidence-gathering),
missed/false-signal counts by classification (§11-13) — all sourced from §7-9's ledger, rendered
through the SAME immutable-report persistence pattern.

## §25-§30. Backtesting, anti-overfitting, testing, Java architecture, performance

- **Backtesting**: use `canonicalNextBarEngine.ts` for anything claiming promotability (§1.9's
  look-ahead-safety already verified); `BacktestEngine.ts` only for non-promotable exploratory runs,
  matching its own self-disclosed limitation.
- **Anti-overfitting**: the lifecycle (§18) plus mandatory versioning (§7) plus the existing
  sample-size floors (§1.10) already cover parameter-mining/data-snooping/multiple-testing risk at
  the mechanism level — the real remaining discipline is procedural (a human reviews every
  EXPERIMENTAL→BACKTESTING promotion, per the companion report's own "research recommendation,
  never auto-applied" rule).
- **Testing**: mirror this session's own proven patterns exactly — `StrategyParityTest.java`-style
  fixture tests for every new Java engine (already the convention, §1.6 confirms 78 Java test files
  exist), fake-timer worker tests, real-SQLite persistence tests, and the companion report's own
  point-in-time synthetic test (10:00/10:30/+15%) extended with a quant-specific variant: a
  strategy's own signal-emission logic re-run against frozen T0 bars must never see a later bar.
- **Java architecture**: no new infrastructure — `QuantCoreBridge.ts` + the existing HTTP service
  (§1.13) is already a mature, working boundary. New strategies need HTTP endpoints added to
  `QuantCoreServer`/`Main.java` (most RESEARCH engines currently have none) — additive, not a new
  communication mechanism.
- **Performance**: `QuantSignalAgent`'s existing bounded-concurrency cap
  (`quantMaxConcurrentSymbols`, capped 32) plus intra-cycle feature reuse (§1.11) already scale
  reasonably; the real cost driver for "1000 strategies × 1000 symbols" is intraday data acquisition
  (§1.6), not compute — indicator math itself is O(n) per symbol per strategy and already shared
  where possible.

## §33-§34. Safety boundary, final architecture

Unchanged from the companion report's own boundary (§18 there): `OBSERVE → MEASURE → LEARN →
GENERATE HYPOTHESES → TEST → RECOMMEND`, enforced by the same architecture-boundary-test mechanism.

```
MARKET DATA → StrategyContext (already built, §1.11) → evaluateAll() [TS] / RESEARCH engines [Java, unwired]
            → QuantEnsembleEngine.java (§1.5, already built, unwired) → QuantTradeDecision (§4, new)
            → existing eventBus.emitTradeIdea() [UNCHANGED entry point, §1.1]
            → ChiefTrader (still requires a second independent agent, §16 verdict)
            → RiskEngine → OMS → IBKR

[separately, post-market:]
Signal Ledger (§7) → Outcome Engine (reuses PredictionOutcomeEvaluator's pattern, §7)
                   → Strategy/Ensemble Scorecards (§8-9) → Missed/False-signal classification (§11-13)
                   → Research findings → Controlled experiments (§28, new quant_experiments table)
                   → NO automatic production change (§17 hard requirement, unchanged from companion report)
```

## §35. Final recommendation

**B — add QuantEngine internal ensemble voting (wiring the already-built `QuantEnsembleEngine.java`),
keep the two-agent approval requirement.** See §16 for the full reasoning and the concrete, numeric
path to revisit this as C/D once real evidence exists. Do not adopt A (keep current architecture
unchanged) — that would leave 37 real, tested Java strategies and a working correlation-adjusted
ensemble engine sitting unused, which is itself a missed-opportunity in the literal sense this whole
investigation is about. Do not adopt C (full replacement) or an unconditional D — neither is
supported by the evidence gathered (§1.5's unmeasured correlation matrix, §1.10's total absence of
Java-side statistical-significance checking, zero historical ledger).

## §36. Files/classes likely to change (Phase 1-2 scope only)

**New**: `quant_strategy_signals`/`quant_signal_outcomes`/`quant_strategy_daily_metrics`/
`quant_strategy_correlation`/`quant_experiments`/`quant_promotion_history` tables + migration;
`buildSharedFeatureContext()` extraction from `QuantSignalAgent.ts` (pure refactor); HTTP endpoints
for a first small batch of RESEARCH engines (recommend starting with the 3 this session already
added — `rsi_mean_reversion`, `macd_crossover`, `bollinger_mean_reversion` — plus
`moving_average_crossover`, `donchian_channel`, `trend_strength_adx` — 6 total, not all 37 at once).
**Modified (additive)**: `MissedOpportunityDetector.classifyMiss()` (quant-specific sub-reasons,
§11); `config/engineOwnership.json` (`httpEndpoint`/`liveConsumer` updates as engines get wired,
never silently); `CLAUDE.md`/`ARGUS_ARCHITECTURE.md` once anything here actually ships (per this
repo's own same-change-update rule).

**Not recommended for this phase**: a Java exit-signal engine (§1.8), a new FeatureEngine class
(extend the existing pattern, §1.11/§3), multi-timeframe strategies (blocked on data, §1.6), any
change to `minIndependentAgreeingAgents`/`consensusApprovalThreshold` (§16 verdict).
