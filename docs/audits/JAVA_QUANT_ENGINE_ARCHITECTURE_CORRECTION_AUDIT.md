# Java 26 Quant Engine Migration Status + Architecture Correction Audit

**Read-only inventory/audit.** No LIVE, no order placement, no Autobot enable, no threshold change.
This audit builds directly on `docs/audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md` (2026-08-21,
already real and current-code-based) rather than re-deriving its facts from zero — where this audit
repeats a fact from that one, it is cited, not re-proven. Net-new in this pass: a granular
per-capability ownership/parity matrix (Phase 2/3 below), a per-arrow runtime-wiring proof (Phase 4),
and the explicit safety PASS/FAIL checklist. The CLAUDE.md/README.md corrections this request's Phase
6/7 asks for were **already completed earlier in this same session** (the "Java 26 Engine Authority"
/ "Architecture Direction" sections) — not redone here; see §8/§9 for what's actually there.

---

## 1. Executive Verdict

**JAVA 26 MIGRATION STATUS: PARTIAL.** Java has real, tested, parity-verified implementations of a
narrow set of indicator/statistics/strategy-decision-logic capabilities. It is **not** wired into the
live runtime pipeline at all today — `QUANT_JAVA_CORE_ENABLED` defaults `false`, and even when true,
a second flag (`QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED`) must also be true before any Java-derived signal
can reach `TRADE_IDEA_GENERATED`. No evidence this pass of that second flag ever having been set `true`
outside a unit test. Java is currently **advisory/shadow-capable, not active, not authoritative** for
anything real.

---

## 2. Current Architecture (as it actually exists)

```
                    Market Data (Alpaca WS)
                              |
                              v
                    TypeScript Control Plane
              (EventBus, agents, ChiefTrader, RiskEngine,
               OMS, BrokerManager — all unchanged, all TS)
                              |
              QuantCoreBridge.ts (TS) — HTTP client, circuit breaker,
              forwards ticks to Java IF QUANT_JAVA_CORE_ENABLED=true
                              |
                    protocol: JSON over loopback HTTP (:8085)
                              |
                              v
                    Java 26 Quant Core (quant-core-java/)
              QuantCoreServer (com.sun.net.httpserver, JDK-native,
              no new dependency) — indicators, RollingStatistics/
              Correlation, 5 CORE strategies' decision logic, the
              new institutional math/models layer (this session)
                              |
                    onSignal() validates + clamps
                              |
                              v
                    eventBus.emitTradeIdea() — ONLY IF
              QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED=true (second, separate flag)
                              |
                              v
                    ChiefTraderAgent → RiskEngine → OMS → BrokerManager → Broker
```

Both gating flags default `false` in `.env`/`.env.example` (**CODE VERIFIED**, `config/tradingSafety.json`'s
`loadTradingSafety()` throws if either key is missing from config, so they cannot silently vanish).

---

## 3. Capability-by-Capability Ownership Matrix

| Quant capability | TS impl. | Java impl. | Currently active | Authoritative owner | Duplicate risk | Migration status |
|---|---|---|---|---|---|---|
| SMA / EMA | `TechnicalIndicators.ts` | `indicators/MovingAverages.java` | TS (live) | TS | LOW — Java exists but unwired | PARITY_VERIFIED (`MovingAveragesTest`) |
| RSI | `RSIEngine.ts` | `indicators/RSI.java` | TS (live) | TS | LOW | PARITY_VERIFIED (byte-for-byte, real TS ground-truth values) |
| MACD | `MACDEngine.ts` | `indicators/MACD.java` | TS (live) | TS | LOW | PARITY_VERIFIED |
| Bollinger Bands | `technicalSignal.ts`'s `calcBollingerBands` | `indicators/Bollinger.java` | TS (live) | TS | LOW | PARITY_VERIFIED |
| ATR / volatility | `TechnicalIndicators.ts`'s `calculateATR` | `indicators/Volatility.java` | TS (live) | TS | LOW | PARITY_VERIFIED |
| VWAP | `volume.ts` (feature pipeline) | **none** | TS (live) | TS | NONE | NOT_IMPLEMENTED_IN_JAVA |
| Momentum / trend (feature pipeline) | `trend.ts` | **none** | TS (live) | TS | NONE | NOT_IMPLEMENTED_IN_JAVA |
| Volume features | `volume.ts` | **none** | TS (live) | TS | NONE | NOT_IMPLEMENTED_IN_JAVA |
| Price action | `priceAction.ts` | **none** | TS (live) | TS | NONE | NOT_IMPLEMENTED_IN_JAVA |
| Support/resistance | `supportResistance.ts` | **none** | TS (live) | TS | NONE | NOT_IMPLEMENTED_IN_JAVA |
| SMC primitives | `smcConfluence.json`-driven TS logic | **none** | TS (when `QUANT_SMC_STRATEGY_ENABLED=true`) | TS | NONE | NOT_IMPLEMENTED_IN_JAVA |
| Rolling statistics (mean/stddev/zscore/percentile) | `src/server/quant/statistics.ts` | `stats/RollingStatistics.java` | TS (live) | TS | LOW | PARITY_VERIFIED |
| Correlation / covariance / beta / skew / kurtosis / autocorrelation | `statistics.ts` | `stats/Correlation.java` | TS (live) | TS | LOW | PARITY_VERIFIED |
| Regime classification (live, `"RANGING"`/`"BULLISH_TREND"`-style) | `RegimeEngine.ts`'s `classifyRegime()` | **none** — `institutional/models/HmmRegimeEngine.java` is a *different*, unrelated 4-state HMM built this session for the isolated institutional layer, not a port of `classifyRegime()` | TS (live) | TS | NONE (not the same concept — do not conflate) | NOT_IMPLEMENTED_IN_JAVA |
| MOMENTUM_BREAKOUT (decision logic) | `quant/strategies/momentumBreakout.ts` | `strategy/core/MomentumBreakout.java` | TS (live) | TS | MEDIUM — Java version exists, parity-tested, but unwired; feature pipeline (regime/trend/volume/priceAction/supportResistance) that feeds it is TS-only, so Java's version cannot run standalone against real bars yet | PARITY_VERIFIED (synthetic contexts, `StrategyParityTest.java`) |
| PULLBACK_CONTINUATION | `quant/strategies/pullbackContinuation.ts` | `strategy/core/PullbackContinuation.java` | TS (live) | TS | MEDIUM (same caveat) | PARITY_VERIFIED |
| MEAN_REVERSION | `quant/strategies/meanReversion.ts` | `strategy/core/MeanReversion.java` | TS (live) | TS | MEDIUM (same caveat) | PARITY_VERIFIED |
| TREND_FOLLOWING | `quant/strategies/trendFollowing.ts` | `strategy/core/TrendFollowing.java` | TS (live) | TS | MEDIUM (same caveat) | PARITY_VERIFIED |
| RANGE_REVERSION | `quant/strategies/rangeReversion.ts` | `strategy/core/RangeReversion.java` | TS (live) | TS | MEDIUM (same caveat) | PARITY_VERIFIED |
| Experimental strategies (~15, per `quantExperimentalStrategies.json`) | TS only | **none** | TS, gated by env flags | TS | NONE | TS_ONLY — correctly not migrated; still gated, not silently promoted to CORE |
| Backtesting loop | `BacktestEngine.ts` (SAME_BAR_CLOSE) | `JavaBacktestEngine.java` (configurable) | Both exist independently; neither calls the other | Neither — two genuinely separate research tools | LOW (both explicitly labeled non-authoritative research paths, never a live order source) | NOT_TESTED for trade-level parity against each other (disclosed gap, `JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md` §2 point 3) |
| Portfolio mathematics (Kelly/EV) | `quant/risk/ExpectedValue.ts` | `risk/ExpectedValue.java` | TS (live, suppresses Quant ideas only, never sizes) | TS | LOW | PARITY_VERIFIED |
| Portfolio mathematics (position sizing, capital allocation, drawdown, correlation exposure) | `PositionSizing.ts`, `CapitalAllocation.ts`, `RiskEngine.ts` gates | **none** | TS (live, inside RiskEngine — protected spine) | TS | NONE | NOT_IMPLEMENTED_IN_JAVA — and this should **not** move to Java per Phase 7's own rule (RiskEngine is explicitly TS-owned, not quant-domain) |
| GARCH / HMM regime / OLS / ADF / OU / EWMA covariance / StatArb / multi-factor alpha (institutional layer) | **none** | `institutional/math/*`, `institutional/models/*` (built this session) | Neither — isolated research module, zero live wiring | Java (by construction — no TS equivalent exists) | NONE | JAVA_ONLY, explicitly not wired to any live/replay decision path |

---

## 4. Runtime Wiring — Per-Arrow Proof

| Arrow | Evidence |
|---|---|
| `MARKET_DATA → QuantCoreBridge` | **CODE VERIFIED**: `QuantCoreBridge.ts` subscribes to tick events and forwards fire-and-forget when `isQuantJavaCoreEnabled()` is true. **NOT RUN VERIFIED** this pass (would require a live server + `QUANT_JAVA_CORE_ENABLED=true` + a real market tick — not exercised). |
| `QuantCoreBridge → Java Quant Core` | **CODE + TEST VERIFIED**: `QuantCoreBridge.test.ts` (18 tests, real HTTP against a real `QuantCoreServer` instance per `QuantCoreServerTest.java`'s own pattern) proves the circuit breaker, forwarding, and failure isolation. **NOT RUN VERIFIED** against a real, separately-launched `java -jar` process this pass. |
| `Java Quant Core → StrategySignal` | **TEST VERIFIED**: `QuantCoreServerTest.java`'s `evaluateRunsARealCoreStrategyAgainstAFullContext` — a real end-to-end HTTP call producing a real signal. |
| `StrategySignal → validation → onSignal()` | **CODE + TEST VERIFIED**: `QuantCoreBridge.test.ts` proves malformed inputs (bad symbol/side/confidence/price) are dropped before ever reaching `emitTradeIdea()`. |
| `onSignal() → TRADE_IDEA_GENERATED` | **CODE VERIFIED, gated**: calls the real `eventBus.emitTradeIdea()` only when `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED=true`. **NOT RUN VERIFIED** — no evidence this flag has ever been `true` outside a unit test in this repository's history. |
| `TRADE_IDEA_GENERATED → ChiefTrader → RiskEngine → OMS` | **CODE VERIFIED, unchanged**: this is the same, single, protected spine every other agent uses — zero Java-specific branching exists inside `ChiefTraderAgent.ts`/`RiskEngine.ts`/`OrderManagement.ts`. |

**Current participation level: D (shadow-capable) at best, defaulting to A (not running) in the
shipped configuration.** Never observed at E/F/G/H (advisory-active, signal-producing-enabled, or
authoritative) in this repository's real history.

---

## 5. Parity Status Summary

**PARITY_VERIFIED** (real TS ground-truth values, not hand-derived): SMA/EMA, RSI, MACD, Bollinger,
ATR, rolling statistics, correlation/covariance/beta/skew/kurtosis/autocorrelation, Kelly/EV, all 5
CORE strategies' decision logic (on synthetic contexts — the upstream feature pipeline that would feed
them real bar-derived contexts is not itself ported, so this is decision-logic parity, not full
strategy-on-real-bars parity).

**NOT_IMPLEMENTED_IN_JAVA**: VWAP, trend/momentum/volume/price-action/support-resistance feature
computation, SMC, live regime classification, RiskEngine's own gates (position sizing, capital
allocation, drawdown, correlation exposure, concentration).

**PARITY_FAILED**: none found.

---

## 6. Duplication / Split-Brain Risk

No live duplicate-signal risk exists today because Java cannot reach `TRADE_IDEA_GENERATED` without
both gating flags true, and no evidence either has ever been set true outside tests. The one
medium-risk item worth tracking going forward: the 5 CORE strategies' decision logic is now
parity-tested in both languages, so if the feature pipeline is ever ported and both bridges turned on
simultaneously without an explicit "TS is authoritative, Java is shadow-only until X" gate, that would
become a real split-brain risk. **Recommendation: when the feature pipeline is ported, the very next
step must be a shadow-mode parity-logging period before any live-ideas flag is ever considered** — this
is already the migration blueprint's own stated design, not a new recommendation.

---

## 7. Safety Verification

| Check | Result |
|---|---|
| NO SECOND ORDER PATH | **PASS** — grep-verified: zero `placeOrder`/broker-adapter imports anywhere under `quant-core-java/` |
| JAVA BYPASSES CHIEFTRADER | **PASS** (does not bypass) — `onSignal()` only calls `emitTradeIdea()`, the same entry every agent uses |
| JAVA BYPASSES RISKENGINE | **PASS** (does not bypass) |
| JAVA BYPASSES OMS | **PASS** (does not bypass) |
| JAVA HOLDS BROKER CREDENTIALS | **PASS** (does not) |
| PAPER SAFETY PRESERVED | **PASS** |
| LIVE SAFETY PRESERVED | **PASS** — `QUANT_JAVA_CORE_ENABLED=false` in both `.env`/`.env.example`; double-gated live emission unchanged |

---

## 8. CLAUDE.md — Already Corrected This Session

The "Java 26 Engine Authority" section (12 numbered rules + AI development checklist) was added
earlier in this same session, immediately before this audit was requested — not redone here. It
already states the exact governance model this request asks for: Java is the preferred target for
*new* quant-domain work (indicators, statistics, strategy calculations/evaluation, regime
classification, portfolio-adjacent numerical work), TypeScript remains authoritative for the control
plane (ChiefTrader/RiskEngine/OMS/BrokerManager/reconciliation/persistence/UI/CLI), and Java may never
bypass the protected spine. See `CLAUDE.md`'s "Java 26 Engine Authority" section directly — this audit
does not duplicate its text a second time.

## 9. README.md — Already Corrected This Session

Same as above: "Architecture Direction" + "Engine Authority Rule" sections were added this session,
documenting the hybrid architecture and the protected decision path unchanged. Not redone here.

---

## 10. Recommended Next Step

**P1 — Port the upstream feature-computation pipeline** (`RegimeEngine.ts`, `trend.ts`, `volume.ts`,
`priceAction.ts`, `supportResistance.ts`, `MarketContext.ts`) to Java before doing anything else with
the 5 CORE strategies. Every remaining gap in this matrix traces back to this one piece of work — the
CORE strategies' decision logic is already ported and parity-tested, but cannot run against real bars
in Java until this pipeline exists there too.

**DO NOT MIGRATE NEXT:** RiskEngine's gates, OMS, BrokerManager, ChiefTrader consensus math, or
anything on the protected spine — these are explicitly TypeScript-owned control-plane concerns per
this session's own new CLAUDE.md rule, not quant-domain numerical computation.

**Blocking issues:** none safety-critical. The only structural blocker to activating Java for
anything real is the missing feature pipeline (P1 above) plus the migration blueprint's own
shadow-soak requirement before any live-ideas flag is considered.

---

## 11. Final Status

```
JAVA QUANT CORE:            PARTIAL (indicators/statistics/CORE-strategy-decision-logic only)
ARCHITECTURE:               Documented and corrected this session (CLAUDE.md + README.md)
PARITY:                     VERIFIED for everything implemented; NOT_IMPLEMENTED_IN_JAVA for the
                             feature pipeline, VWAP, SMC, live regime classification, RiskEngine math
RUNTIME:                     NOT ACTIVE (both gating flags default false; no evidence either has
                             ever been true outside a unit test)
TESTS:                       Java 128/128 (mvn test, this session); TypeScript 348 files/2217 tests
                             (npx vitest run, this session)
TYPECHECK:                   npx tsc --noEmit clean
BUILD:                       npm run build clean
SAFE FOR FURTHER MIGRATION:  YES, for quant-domain-only work (indicators/statistics/strategy
                             evaluation/regime); NOT for RiskEngine/OMS/BrokerManager/ChiefTrader
```
