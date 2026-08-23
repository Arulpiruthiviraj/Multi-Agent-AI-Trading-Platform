# Java 26 Quant Core Migration Blueprint

**Status: PROPOSAL ONLY. Not started, not approved, not scheduled.** This document is a
read-only discovery audit and speculative design produced on request. It does not change any
readiness score, does not modify code, and is not an instruction to begin migration work.
Per `CLAUDE.md`'s architecture-protection rule, nothing here authorizes bypassing, replacing,
or duplicating `ChiefTraderAgent`, `RiskEngine`, `OrderManagementService`, or `BrokerManager`.
The design below is deliberately constrained so that IF ever built, the Java service would be a
new **advisory-only** calculation engine that feeds candidate signals into the existing
`TRADE_IDEA_GENERATED` → ChiefTrader → RiskEngine → OMS pipeline exactly like any other idea
agent (`src/server/services/TechnicalAgent.ts` is the closest existing analog) — never a second
order path, never a broker credential holder, never a `.placeOrder(` caller.

Repo state audited: 2026-08-20/21, `main` branch, Node `24.18.0`, TypeScript `~5.8.2`,
`npm test` 323 files / 2075 tests green, `npm run lint` (tsc --noEmit) clean.

---

## 1. Executive Architecture Diagram

```
                         ┌─────────────────────────────────────────────────────────────┐
                         │   TYPESCRIPT CONTROL PLANE  (unchanged, still system of record)│
                         │                                                               │
  Alpaca WebSocket ─────▶│  MarketDataWorker.emitMarketData()                            │
                         │        │                                                     │
                         │        ├──▶ TechnicalAgent (existing, unchanged)              │
                         │        ├──▶ NewsEngine / FundamentalAgent / MacroAgent         │
                         │        ├──▶ KronosForecastAgent                               │
                         │        │                                                     │
                         │        └──▶ [NEW] QuantCoreBridge ───────┐                    │
                         │                                          │ ticks/bars (async, │
                         │                                          │ fire-and-forget)   │
                         │                                          ▼                    │
                         │                              ┌───────────────────────────┐    │
                         │                              │  JAVA 26 QUANT CORE        │    │
                         │                              │  (new, ADVISORY ONLY,       │    │
                         │                              │   localhost-only, no        │    │
                         │                              │   broker credentials,       │    │
                         │                              │   no placeOrder equivalent) │    │
                         │                              │                             │    │
                         │                              │  - tick/bar ring buffers    │    │
                         │                              │  - indicator math (RSI/     │    │
                         │                              │    MACD/BB/ATR/VWAP/...)    │    │
                         │                              │  - CORE strategy evaluation │    │
                         │                              │  - portfolio/risk math      │    │
                         │                              │    (Sharpe/Sortino/Beta/    │    │
                         │                              │    drawdown/correlation)    │    │
                         │                              │  - backtest execution       │    │
                         │                              └──────────┬──────────────────┘    │
                         │                                         │ StrategySignal      │
                         │                                         │ payload (JSON/gRPC) │
                         │                                         ▼                     │
                         │                              [NEW] QuantCoreBridge.onSignal() │
                         │                                         │                     │
                         │                                         ▼                     │
                         │                       eventBus.emitTradeIdea({..., agent:      │
                         │                         'QuantCoreJava', currentPrice, ...})   │
                         │                                         │                     │
                         │                                         ▼                     │
                         │                              ChiefTraderAgent (unchanged)      │
                         │                                         │                     │
                         │                                         ▼                     │
                         │                              RiskEngine 24 gates (unchanged)   │
                         │                                         │                     │
                         │                                         ▼                     │
                         │                              OMS → BrokerManager (unchanged)   │
                         │                                         │                     │
                         │                                         ▼                     │
                         │                                    Alpaca / IBKR / Coinbase    │
                         └─────────────────────────────────────────────────────────────┘

  SHADOW PARITY PATH (validation only, no live effect):
  MarketDataWorker ──▶ existing TS quant strategies (src/server/quant/strategies/*) ──▶ ParityComparator
                   └─▶ Java Quant Core (same tick)                                  ──▶ ParityComparator
                                                                                          │
                                                                                          ▼
                                                                        divergence log (>0.01%) →
                                                                        observability_events, never
                                                                        an order-path input
```

Key invariants preserved from `CLAUDE.md`:
- The Java process never receives broker credentials and never calls anything broker-adjacent.
- It cannot emit `CHIEF_APPROVED_IDEA` or touch `risk_assessments`/`trades`/`fills` directly —
  it only ever produces the same `TRADE_IDEA_GENERATED` shape every other agent produces, which
  still passes through `gateTradeIdea()` / `looksLikeListedTicker()` / ChiefTrader / all 24 risk
  gates unchanged.
- If the Java process is down, degraded, or slow, the existing TypeScript quant path
  (`src/server/quant/strategies/*`, gated by `QUANT_ENGINE_ENABLED`) continues to function
  exactly as it does today — Java is additive, not a replacement, and its absence must fail
  closed (no ideas from that source), never fail open (never fabricate a signal).
- `QUANT_ENGINE_ENABLED` / `QUANT_SMC_STRATEGY_ENABLED` and a new
  `QUANT_JAVA_CORE_ENABLED` (proposed) all default off, same as every other experimental flag in
  this codebase.

---

## 2. Component Inventory & Migration Matrix

### 2.1 Tier classification (per the requested 3-tier model)

| Tier | Definition | Stays where |
|---|---|---|
| **TIER 1** | UI/React, control-plane HTTP/WS routes, LLM/agent orchestration, EventBus, ChiefTrader consensus/debate, RiskEngine gate ladder, OMS, BrokerManager + adapters, config loading, desk settings | **TypeScript — unchanged, protected** |
| **TIER 2** | Pure numeric indicator math, CORE quant strategy evaluation, portfolio/risk statistics, high-throughput backtest loops | **Candidate for Java 26** |
| **TIER 3** | Bridge schemas, shadow-parity comparator, tick/bar serialization | **New, split across both sides** |

### 2.2 Migration matrix — indicators (Tier 2)

All current implementations are plain, allocation-heavy TS functions operating on `number[]`
slices (no SIMD, no typed arrays, `Array.prototype.slice`/`reduce` per call).

| Current TS location | Function(s) | Java 26 package (proposed) |
|---|---|---|
| `src/server/services/technicalSignal.ts` | `calcSMA`, `calcBollingerBands` | `io.argus.quantcore.indicators.MovingAverages`, `.Bollinger` |
| `src/server/engines/RSIEngine.ts` | `RSIEngine` (class, period-based) | `io.argus.quantcore.indicators.RSI` |
| `src/server/engines/MACDEngine.ts` | `MACDEngine` (class) | `io.argus.quantcore.indicators.MACD` |
| `src/server/engines/TechnicalIndicators.ts` | shared indicator helpers | `io.argus.quantcore.indicators.Shared` |
| `src/server/quant/indicators/trend.ts` | trend/ADX/DMI-family | `io.argus.quantcore.indicators.Trend` |
| `src/server/quant/indicators/momentum.ts` | momentum oscillators | `io.argus.quantcore.indicators.Momentum` |
| `src/server/quant/indicators/volatility.ts` | ATR/volatility bands | `io.argus.quantcore.indicators.Volatility` |
| `src/server/quant/indicators/volume.ts` | `computeVolumeFeatures`, VWAP-family | `io.argus.quantcore.indicators.Volume` |
| `src/server/quant/indicators/priceAction.ts` | candle/price-action primitives | `io.argus.quantcore.indicators.PriceAction` |
| `src/server/quant/indicators/supportResistance.ts` | S/R levels | `io.argus.quantcore.indicators.SupportResistance` |
| `src/server/quant/indicators/smc.ts` | Smart-Money-Concepts primitives | `io.argus.quantcore.indicators.Smc` |
| `src/server/quant/statistics.ts` | `rollingMean`, `rollingStdDev`, `zScore`, `percentileRank`, `correlation`, `covariance`, `beta`, `skewness`, `kurtosis`, `autocorrelation` | `io.argus.quantcore.stats.RollingStatistics`, `.Correlation` |
| `src/server/quant/RegimeEngine.ts` | `classifyRegime`, `MIN_BARS` | `io.argus.quantcore.regime.RegimeClassifier` |
| `src/server/research/lightweightRegimeClassifier.ts` | `classifyLightweightRegime` (added 2026-08-20, single-parameter, no-look-ahead by construction) | `io.argus.quantcore.regime.LightweightRegimeClassifier` |

### 2.3 Migration matrix — CORE quant strategies (Tier 2)

`CLAUDE.md` names five CORE strategies live in `evaluateAll()`; everything else is
experimental/gated. Migration priority should follow this same split — CORE first, experimental
strategies migrate only after CORE parity is proven in shadow mode for a real soak period.

| Current TS location | Strategy ID | Java 26 package (proposed) | Priority |
|---|---|---|---|
| `src/server/quant/strategies/momentumBreakout.ts` | `MOMENTUM_BREAKOUT` | `io.argus.quantcore.strategy.core.MomentumBreakout` | P0 (CORE) |
| `src/server/quant/strategies/pullbackContinuation.ts` | `PULLBACK_CONTINUATION` | `io.argus.quantcore.strategy.core.PullbackContinuation` | P0 (CORE) |
| `src/server/quant/strategies/meanReversion.ts` | `MEAN_REVERSION` | `io.argus.quantcore.strategy.core.MeanReversion` | P0 (CORE) |
| `src/server/quant/strategies/trendFollowing.ts` | `TREND_FOLLOWING` | `io.argus.quantcore.strategy.core.TrendFollowing` | P0 (CORE) |
| `src/server/quant/strategies/rangeReversion.ts` | `RANGE_REVERSION` | `io.argus.quantcore.strategy.core.RangeReversion` | P0 (CORE) |
| `src/server/quant/strategies/smcLiquiditySweep.ts` | `SMC_LIQUIDITY_SWEEP` | `io.argus.quantcore.strategy.experimental.SmcLiquiditySweep` | P2 (experimental, `QUANT_SMC_STRATEGY_ENABLED`) |
| `src/server/quant/strategies/{vwapMeanReversion,vwapVolumeStructure,donchianBreakout,maCrossover,oscillatorMomentum,bollingerVolatility,openingRangeBreakout,previousPeriodBreakout,gapContinuation,fibonacciPullback,volumeConfirmation,srBounce,relativeStrengthRotation,statisticalMeanReversion,candlestickReversal}.ts` | 15 experimental families (`config/quantExperimentalStrategies.json`) | `io.argus.quantcore.strategy.experimental.*` | P2 |
| `src/server/quant/strategies/StrategyEngine.ts` | `findStrategy(id)` dispatcher (core-then-experimental) | `io.argus.quantcore.strategy.StrategyRegistry` | P0 (needed to route to any migrated strategy) |
| `src/server/quant/QuantitativeFeatureEngine.ts` | shared feature extraction feeding strategies | `io.argus.quantcore.strategy.FeatureEngine` | P0 |
| `src/server/quant/scoring/GroupedScores.ts` | confluence weighting (`config/smcConfluence.json`) | `io.argus.quantcore.strategy.Confluence` | P1 |
| `src/server/quant/analysis/ThesisInvalidation.ts` | invalidation rule types (`config/thesisInvalidation.json`) | **Stays TypeScript** — this is consumed by live `PortfolioMonitor.ts` exit logic, part of the protected spine's decision surface, not a pure math utility | N/A |

### 2.4 Migration matrix — portfolio/risk statistics (Tier 2)

| Current TS location | Function(s) | Java 26 package (proposed) | Note |
|---|---|---|---|
| `src/server/quant/statistics.ts` | `beta`, `correlation`, `skewness`, `kurtosis` | `io.argus.quantcore.stats.*` | Pure math, safe to migrate |
| `src/server/quant/risk/ExpectedValue.ts` | Kelly fraction / EV suppression | `io.argus.quantcore.risk.ExpectedValue` | **Advisory only** — per `CLAUDE.md`, Kelly/EV already only suppresses Quant *ideas*; RiskEngine never sizes from it. Migration must preserve that boundary exactly — Java's EV output feeds the idea payload's confidence/EV field, never a position-size number RiskEngine trusts. |
| `src/server/engines/PositionSizing.ts` | `snapshotCapital`-adjacent sizing math | **Stays TypeScript** | This is called live by `RiskEngine.ts` inside the gate ladder (gates 16, 21, 23). Moving it to a separate process means every `evaluateRisk()` call needs a synchronous cross-process round trip on the hot risk path — a new failure mode and latency source on the one path `CLAUDE.md` says must never be bypassed or duplicated. Recommend **NOT** migrating this even after Java Core exists; keep sizing math where RiskEngine already trusts it. |
| `src/server/engines/CapitalAllocation.ts` | `snapshotCapital`, `evaluateAllocationGuard` | **Stays TypeScript** | Same reasoning — gate 23 (`argus_capital_allocation`) input, in-process only. |
| `src/server/engines/backtest/BacktestEngine.ts` | `run()` (SAME_BAR_CLOSE, non-promotable) | `io.argus.quantcore.backtest.SameBarCloseEngine` | P1 — highest-value migration target for raw throughput (many symbols × many bars, no live-safety coupling) |
| `src/server/engines/backtest/PitRiskEngine.ts` / `PitLedgerRecorder.ts` | point-in-time replay risk/ledger simulation | `io.argus.quantcore.backtest.PitEngine` | P1 |
| `src/server/replay/FullArgusReplayEngine.ts`, `canonicalNextBarEngine` (NEXT_BAR_OPEN) | promotion-adjacent replay fill model | **Stays TypeScript initially** — reuses real ChiefTrader vote-math/RiskEngine/OMS against `HistoricalReplayBroker` per `CLAUDE.md`; migrating this means either duplicating ChiefTrader/RiskEngine in Java (explicitly disallowed) or a cross-process call per bar per symbol into the still-TS decision path, which defeats most of the throughput benefit. Revisit only after CORE strategy + backtest math is proven in Java. | 
| `src/server/strategiesEngine/` (isolated research subsystem, modes OFF/SHADOW/ANALYSIS_ONLY) | condition-tree DSL evaluation, variant generation | `io.argus.quantcore.research.*` (optional, later phase) | P3 — already explicitly isolated from the live path per `CLAUDE.md`; lowest migration urgency since it doesn't touch production latency at all today. |

### 2.5 Real performance characteristics found in this codebase (ground truth, not assumed)

- `technicalHistoryBars`-sized `priceHistory: Record<string, number[]>` in
  `src/server/services/TechnicalAgent.ts` is a plain JS array capped via `.shift()`/`.slice()` —
  **not** a ring buffer. `.shift()` is O(n) per tick; on a small `technicalHistoryBars` window
  (tens of bars) this is not currently a measured bottleneck, but it is the first concrete thing
  a Java ring-buffer (`double[]` + write cursor, no shifting) would fix if migrated.
- **Current production concurrency is deliberately serialized, not CPU-bound-and-struggling**:
  `tradingSafety.json`'s `quantMaxConcurrentSymbols: 1` and `quantCycleIntervalMs: 300000` (5
  minutes) mean the live Quant cycle evaluates one symbol at a time on a 5-minute cadence today
  — this is a rate-limit/API-politeness choice (Alpaca/AlphaVantage budgets), not evidence that
  the TypeScript math itself is too slow for 100+ tickers. **Do not present this migration as
  fixing a proven current bottleneck** — there is no measured production evidence of
  event-loop blocking under load in this repo's logs or tests. The honest justification for
  Java is *future* scale-out (concurrent multi-symbol evaluation, higher-frequency backtesting,
  larger `quantLookbackDays`/`backtestLookbackBars` windows) and cheaper backtest iteration
  speed, not an emergency fix.
- `RiskEngine.evaluateRisk()` is fully serialized today via an in-process Promise-chain mutex
  (`evaluationQueue`) specifically so all 24 gates stay deterministic and race-free — this is a
  correctness mechanism, not a perf bottleneck, and per §2.4 above should **not** move to Java.

---

## 3. API Data Transfer Schemas

Transport: **gRPC over a loopback-only Unix domain socket / localhost TCP port** (proposed
`127.0.0.1:7626`, never exposed beyond localhost, no auth token needed at this trust boundary
since it never leaves the host — matching this repo's existing Chronos `:8008` local-only
convention). JSON-over-HTTP is the fallback transport for the first scaffolding milestone
(simpler to shadow-test against curl/existing observability tooling) before committing to
protobuf.

### 3.1 Tick / bar ingestion (TypeScript → Java)

```typescript
// TypeScript side (existing shape, MarketDataWorker.emitMarketData() payload — no change needed
// to the live shape; QuantCoreBridge adapts it before sending)
interface QuantCoreTickEnvelope {
  schemaVersion: 1;
  symbol: string;
  timestampMs: number;      // epoch ms, matches acceptTickTimestamp's clock
  price: number;
  volume?: number;
  bidPrice?: number;
  askPrice?: number;
}
```

```java
// Java 26 side — implicit record patterns, no boilerplate constructors
public record TickEnvelope(
    int schemaVersion,
    String symbol,
    long timestampMs,
    double price,
    Double volume,      // boxed: legitimately optional, avoid a sentinel
    Double bidPrice,
    Double askPrice
) {}
```

### 3.2 Indicator snapshot (Java → TypeScript, on demand or streamed)

```typescript
interface QuantCoreIndicatorSnapshot {
  schemaVersion: 1;
  symbol: string;
  asOfTimestampMs: number;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  atr: number | null;
  vwap: number | null;
  regime: string | null;      // e.g. "BULLISH_TREND/NORMAL" — matches encodeRegime() format
  insufficientHistory: boolean; // true when Java's window hasn't filled yet — never fabricate a value
}
```

```java
public record IndicatorSnapshot(
    int schemaVersion,
    String symbol,
    long asOfTimestampMs,
    Double rsi,
    Double macd,
    Double macdSignal,
    Double bbUpper,
    Double bbLower,
    Double atr,
    Double vwap,
    String regime,
    boolean insufficientHistory
) {}
```

### 3.3 Strategy signal (Java → TypeScript, feeds `emitTradeIdea` unchanged)

This must map 1:1 onto the existing `TRADE_IDEA_GENERATED` contract in `CLAUDE.md` §1 — no new
fields the live spine doesn't already understand.

```typescript
interface QuantCoreStrategySignal {
  schemaVersion: 1;
  traceId: string;          // still minted TS-side by generateTraceId(symbol); Java never mints
  symbol: string;
  side: 'BUY' | 'SELL';
  confidence: number;        // [0,1], clamped Java-side too — never trust an out-of-range value
  strategyId: string;        // one of the CORE ids, or an experimental id gated by its own env flag
  reasoning: string;
  currentPrice: number;
  regimeMismatchDiscounted: boolean;
  evSuppressed: boolean;      // true if Kelly/EV gate suppressed this idea Java-side
}
```

```java
public record StrategySignal(
    int schemaVersion,
    String traceId,
    String symbol,
    Side side,           // enum BUY, SELL
    double confidence,
    String strategyId,
    String reasoning,
    double currentPrice,
    boolean regimeMismatchDiscounted,
    boolean evSuppressed
) {
    public enum Side { BUY, SELL }
}
```

`QuantCoreBridge.onSignal()` (new, TypeScript) is the only code allowed to turn a
`StrategySignal` into an `eventBus.emitTradeIdea(...)` call — it re-validates `confidence` is
finite and in `[0,1]`, re-validates `symbol` through the existing `looksLikeListedTicker()`
gate (never trust Java's own validation as sufficient — same "trust nothing from an external
process" posture the codebase already applies to AI provider output via `AIOutputValidator.ts`),
and sets `agent: 'QuantCoreJava'` so it is visible and attributable in every downstream trace,
weight-learning, and effective-N calculation exactly like any other named agent.

---

## 4. Phased Step-by-Step Implementation Roadmap

This is a proposal for *if* the repository owner chooses to proceed — no phase here is
authorized by this document alone.

### Phase 0 — Scaffolding (no live wiring)
- New top-level `quant-core-java/` Maven/Gradle project, Java 26, zero dependency on the Node
  process at build time.
- Implement Tier-2 indicator math (§2.2) as pure functions over `double[]`, each with a
  property-based/golden-value test asserting **byte-for-byte parity** against the existing
  TypeScript function's output on the same fixture data (reuse the existing TS test fixtures —
  e.g. `technicalSignal.test.ts`'s `risingTrendPrices()` generator — as the parity oracle).
- No network layer yet. No wiring into `server.ts`. Fully inert with respect to the live app.

### Phase 1 — Math parity validation
- Port CORE strategy evaluation (§2.3, P0 rows) and portfolio statistics (§2.4).
- Build an offline parity harness: feed both engines the same historical bar set (reuse
  `src/server/engines/backtest/HistoricalDataGateway.ts`'s existing warehouse data) and diff
  every indicator/strategy output. Target **zero** divergence for deterministic math (indicators,
  regime classification) and document any acceptable floating-point epsilon.
  `WalkForwardValidator.ts`'s existing methodology (no optimization, out-of-sample only) should
  gate parity claims the same way it already gates strategy validity claims.
- Still zero live wiring. This phase can run entirely in CI as a scheduled job.

### Phase 2 — Bridge + shadow deployment
- Stand up the gRPC/JSON service (§3) behind `QUANT_JAVA_CORE_ENABLED` (default `false`, same
  convention as every other experimental flag in `config/tradingSafety.json`).
- `QuantCoreBridge` subscribes to `MARKET_DATA` the same way `TechnicalAgent` does, forwards
  ticks to Java, but in this phase **discards** Java's `StrategySignal` output rather than
  emitting it — it only logs it to `observability_events` for comparison against what the
  existing TS quant path actually produced for the same tick, tagged distinctly (never
  co-mingled with real `TRADE_IDEA_GENERATED` events, matching how `REPLAY`/`DIAGNOSTIC` events
  are already kept out of organic accounting per `CLAUDE.md`).
- Run this shadow mode for a real multi-week window (mirroring the existing
  `researchSafety.json` soak-floor philosophy — no shortcuts on calendar time) and produce a
  divergence report (>0.01% flagged) before considering Phase 3.

### Phase 3 — Gated live emission (still fully reversible)
- Only after Phase 2's divergence report is clean: allow `QuantCoreBridge.onSignal()` to call
  `eventBus.emitTradeIdea(...)` for real, but **only** for CORE strategies, still behind
  `QUANT_JAVA_CORE_ENABLED`, and initially in **paper only** — no special LIVE carve-out; the
  existing 5-layer LIVE arming and `LIVE_NO_GO` gate apply to orders sourced from this agent
  exactly like any other.
- ChiefTrader/RiskEngine/OMS/BrokerManager receive **zero** code changes in this phase. If this
  phase requires touching any of those four, stop and treat it as a protected-architecture
  conflict per `CLAUDE.md`, not a migration detail to route around.

### Phase 4 — Backtest throughput migration (independent of Phases 1–3)
- Migrate `BacktestEngine.run()` / `PitRiskEngine`/`PitLedgerRecorder` (§2.4) to Java
  independently — this path has no live-safety coupling (research-only, explicitly
  non-promotable per `CLAUDE.md`'s SAME_BAR_CLOSE description), so it can proceed on its own
  timeline and deliver value (faster iteration for strategy research) even if Phases 1–3 stall
  or are rejected.

### Explicitly out of scope for any phase
- `RiskEngine.ts`, `PositionSizing.ts`, `CapitalAllocation.ts`, `OrderManagementService`,
  `BrokerManager` + adapters, `ChiefTraderAgent`'s consensus/debate logic, the kill-switch
  system, reconciliation — per §2.4's reasoning, moving any of these breaks the
  single-process-serialized-mutex guarantees `CLAUDE.md` documents as load-bearing
  (`RiskEngine.evaluationQueue`, `SystemBootstrap.isRunning`, WAL single-writer SQLite access).
  A cross-process hop on any of these turns a correctness guarantee into a network race.

---

## 5. Summary judgment

The mathematically pure, allocation-heavy, no-look-ahead surface (indicators, CORE strategy
scoring, portfolio statistics, SAME_BAR_CLOSE backtesting) is a clean, low-risk Java migration
candidate with a real payoff (throughput, GC pressure, true ring buffers). The safety-coupled
surface (RiskEngine's gate ladder, PositionSizing, CapitalAllocation, OMS, BrokerManager) should
**not** move, both because `CLAUDE.md` protects it structurally and because its current
correctness guarantees (serialized mutex, single SQLite writer, in-process EventBus ordering)
are cheaper to keep than to re-derive across a process boundary. There is no current, measured
production evidence of a TypeScript performance emergency — `quantMaxConcurrentSymbols: 1` and
the 5-minute Quant cycle are deliberate rate-limiting choices, not symptoms of an overloaded
event loop — so this should be scoped and communicated as a **future scale-out and
research-velocity investment**, not an urgent fix.
