# Argus Quant Ownership Matrix

Read-only synthesis, verified 2026-09-04. This is a **consolidation**, not a fresh re-derivation:
the real forensic work already exists across three prior audits —
`docs/audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md` (2026-08-21),
`docs/audits/JAVA_QUANT_ENGINE_ARCHITECTURE_CORRECTION_AUDIT.md`, and
`docs/audits/JAVA_MIGRATION_COMPLETION_PLAN_SUPPLEMENT.md` — and this document's job is to be the
one canonical, current place to look, per CLAUDE.md's Java 26 Engine Authority checklist item
("Update `docs/architecture/JAVA_QUANT_CORE.md` (or the relevant architecture doc)"). Where this
restates a fact from those three, it is cited, not re-proven. Net-new verification this pass:
confirmed the Java module's growth from 39→181 source files since 2026-08-21 did **not** close the
one blocking gap those audits identified (see §3) — the growth went entirely into an isolated
`institutional/` research layer with zero live wiring, not into the feature-computation pipeline.
Also confirmed live: `QUANT_JAVA_CORE_ENABLED=true` in `.env` right now (bridge active, shadow
mode), `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` unset (defaults false) — Java has never emitted a real
trade idea in this repository's history.

**Per CLAUDE.md: adding this document does not raise readiness scores.** Ground truth is the code,
`quant-core-java`'s own tests, and `evaluateLiveReadiness()` — not this file.

---

## 1. Current architecture (unchanged since the Correction Audit)

```
Market Data (Alpaca WS / IBKR Gateway)
          |
          v
TypeScript Control Plane (EventBus, agents, ChiefTrader, RiskEngine, OMS, BrokerManager — unchanged)
          |
QuantCoreBridge.ts — HTTP client, circuit breaker, forwards ticks IF QUANT_JAVA_CORE_ENABLED=true
          |
JSON over loopback HTTP (:8085)
          |
          v
Java 26 Quant Core (quant-core-java/) — QuantCoreServer (JDK-native httpserver)
          |
onSignal() validates + clamps
          |
          v
eventBus.emitTradeIdea() — ONLY IF QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED=true (second, separate flag)
          |
          v
ChiefTraderAgent → RiskEngine → OMS → BrokerManager → Broker
```

Both flags are validated in `loadTradingSafety()` (throws if missing from config — cannot silently
vanish). `QUANT_JAVA_CORE_ENABLED=true` is live in this environment's `.env` today; the live-ideas
flag has never been observed `true` outside a unit test.

---

## 2. Capability-by-capability ownership matrix

| Quant capability | TS impl. | Java impl. | Currently active | Authoritative owner | Migration status |
|---|---|---|---|---|---|
| SMA / EMA | `TechnicalIndicators.ts` | `indicators/MovingAverages.java` | TS (live) | TS | PARITY_VERIFIED |
| RSI | `RSIEngine.ts` | `indicators/RSI.java` | TS (live) | TS | PARITY_VERIFIED (byte-for-byte, real TS ground truth) |
| MACD | `MACDEngine.ts` | `indicators/MACD.java` | TS (live) | TS | PARITY_VERIFIED |
| Bollinger Bands | `technicalSignal.ts` | `indicators/Bollinger.java` | TS (live) | TS | PARITY_VERIFIED |
| ATR / volatility (tick-range) | `TechnicalIndicators.ts` | `indicators/Volatility.java` | TS (live) | TS | PARITY_VERIFIED |
| Rolling statistics (mean/stddev/zscore/percentile) | `src/server/quant/statistics.ts` | `stats/RollingStatistics.java` | TS (live) | TS | PARITY_VERIFIED |
| Correlation/covariance/beta/skew/kurtosis/autocorrelation | `statistics.ts` | `stats/Correlation.java` | TS (live) | TS | PARITY_VERIFIED |
| Kelly / Expected Value | `quant/risk/ExpectedValue.ts` | `risk/ExpectedValue.java` | TS (live, idea-suppression only) | TS | PARITY_VERIFIED |
| MOMENTUM_BREAKOUT (decision logic) | `quant/strategies/momentumBreakout.ts` | `strategy/core/MomentumBreakout.java` | TS (live) | TS | PARITY_VERIFIED — decision logic only, cannot run standalone on real bars (needs §3) |
| PULLBACK_CONTINUATION | `quant/strategies/pullbackContinuation.ts` | `strategy/core/PullbackContinuation.java` | TS (live) | TS | PARITY_VERIFIED (same caveat) |
| MEAN_REVERSION | `quant/strategies/meanReversion.ts` | `strategy/core/MeanReversion.java` | TS (live) | TS | PARITY_VERIFIED (same caveat) |
| TREND_FOLLOWING | `quant/strategies/trendFollowing.ts` | `strategy/core/TrendFollowing.java` | TS (live) | TS | PARITY_VERIFIED (same caveat) |
| RANGE_REVERSION | `quant/strategies/rangeReversion.ts` | `strategy/core/RangeReversion.java` | TS (live) | TS | PARITY_VERIFIED (same caveat) |
| **Trend features** (`computeTrendFeatures`) | `quant/indicators/trend.ts` (240 lines) | **none** | TS (live) | TS | **NOT_IMPLEMENTED_IN_JAVA — blocks §3** |
| **Volatility features** (`computeVolatilityFeatures`) | `quant/indicators/volatility.ts` (135 lines) | **none** (institutional `Volatility`/GARCH is a different, unrelated model) | TS (live) | TS | **NOT_IMPLEMENTED_IN_JAVA — blocks §3** |
| **Price-action features** | `quant/indicators/priceAction.ts` (151 lines) | **none** | TS (live) | TS | **NOT_IMPLEMENTED_IN_JAVA — blocks §3** |
| **Volume features** | `quant/indicators/volume.ts` (163 lines) | **none** | TS (live) | TS | **NOT_IMPLEMENTED_IN_JAVA — blocks §3** |
| **Support/resistance features** | `quant/indicators/supportResistance.ts` (213 lines) | **none** | TS (live) | TS | **NOT_IMPLEMENTED_IN_JAVA — blocks §3** |
| **Regime classification** (`classifyRegime`) | `quant/RegimeEngine.ts` (219 lines) | **none** (`institutional/models/HmmRegimeEngine.java`/`MarketRegimeEngine.java` are unrelated 4-state HMM research models, not a port) | TS (live) | TS | **NOT_IMPLEMENTED_IN_JAVA — blocks §3** |
| **Market context** (`getMarketContext`) | `quant/MarketContext.ts` (170 lines) | **none** | TS (live) | TS | **NOT_IMPLEMENTED_IN_JAVA — blocks §3** |
| VWAP, SMC primitives | `volume.ts`, `smcConfluence.json`-driven logic | none | TS (live / flag-gated) | TS | NOT_IMPLEMENTED_IN_JAVA — no migration urgency, low-frequency |
| Experimental strategies (~15) | TS only | none | TS, env-flag-gated | TS | TS_ONLY — correctly not migrated |
| Backtesting loop | `BacktestEngine.ts` (SAME_BAR_CLOSE) | `JavaBacktestEngine.java` (configurable) | Both exist independently | Neither — separate research tools | NOT_TESTED for trade-level parity (disclosed gap) |
| Position sizing / capital allocation / drawdown / correlation exposure (RiskEngine gates) | `PositionSizing.ts`, `CapitalAllocation.ts`, `RiskEngine.ts` | none | TS (live, protected spine) | TS | **DO NOT MIGRATE** — control-plane, not quant-domain, per CLAUDE.md's own rule |
| GARCH / HMM regime / OLS / ADF / OU / EWMA covariance / StatArb / multi-factor alpha / market-data-quality / feature snapshot (institutional layer) | none | `institutional/math/*`, `institutional/models/*`, `institutional/features/*`, `institutional/data/*` | Neither — isolated, zero live wiring | Java (no TS equivalent) | JAVA_ONLY research module; **not** a port of anything above, do not conflate with §3 |

---

## 3. JMIG-001 — CLOSED at the calculation layer (2026-09-04, this session)

**Update:** the feature-computation pipeline described below is now ported to Java
(`io.argus.quantcore.features.*`: `TrendFeatures`, `VolatilityFeatures`, `PriceActionFeatures`,
`VolumeFeatures`, `SupportResistanceFeatures`, `RegimeEngine`, `MarketContext`, plus supporting
`TechnicalIndicatorsCompat`/`StatisticsMath`/`FeatureThresholds`), verified byte-for-byte against
real captured TypeScript ground truth (`Phase2FeatureParityTest`, 9/9 passing, tolerance 1e-6,
independently re-run against the full `mvn test` suite — 341/341 total, `BUILD SUCCESS`). Spot-checked
by the orchestrating session (not just the porting agent) on the two highest-risk files —
`RegimeEngine.java`'s dead-zone/vote-counting logic and `MarketContext.java`'s `minOverlap`
correlation/beta semantics — both confirmed faithful.

**Update (2026-09-05): shadow wiring deployed live, soak clock started.** `QuantSignalAgent.ts`'s
`evaluateSymbol()` now calls `QuantCoreBridge.compareRegimeParity(symbol, bars, regime)` immediately
after its own real `classifyRegime(bars)` call — fire-and-forget, double-wrapped (async `.catch()`
plus a synchronous try/catch, after a real test caught that the first layer alone didn't cover a
synchronous throw), gated solely by the existing `QUANT_JAVA_CORE_ENABLED` flag. Deployed to the
live engine (PID 37108, 2026-09-05T13:02 UTC) after: full suite verification (TS 62/62 targeted +
tsc clean on every file this work touches; Java 344/344 `mvn test`, `BUILD SUCCESS`), reconciliation
confirmed clean (0 mismatches), single clean process topology confirmed. **This is the first moment
any real divergence data can exist** — before this, "shadow-verified" meant synthetic fixtures only.
Check `observability_events` for `QUANT_CORE_REGIME_PARITY_DIVERGENCE` rows to see real accumulated
soak data; there were zero as of deployment. Do not shortcut the "real multi-week window, no
shortcuts on calendar time" precondition (`JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md`) no matter how
clean early samples look — a few hours or days is not the soak period.

**What is still NOT done:** `QuantSignalAgent.ts` still uses ONLY its own TS `classifyRegime`/
`getMarketContext` output for every real decision — the Java comparison is observation-only.
`FullArgusReplayEngine.ts` does not call the Java pipeline at all. `MarketContext`/full feature-set
comparison was deliberately not wired (regime-only, by design — see the wiring agent's own scope
note). No TS file has been touched, deprecated, or deleted. `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED`
remains unchanged and must not be set true until the real soak period above is complete.

**Unrelated but important discovery made while verifying this work:** the repo's root `.gitignore`
had a bare `models/` pattern (meant only for the top-level `models/` ML-artifact directory) that was
also silently matching `quant-core-java/src/{main,test}/java/io/argus/quantcore/institutional/models/`
at any depth — a real, currently-active bug that meant the entire "institutional layer" Java package
(36 files: `GarchEngine`, `HmmRegimeEngine`, `FactorAlphaEngine`, `StatArbEngine`, and others cited
in this matrix's §2) had **never once been committed to git**, despite being real, on-disk, and
referenced as built/tested in three prior audit documents. Fixed by anchoring the pattern to
`/models/` (repo-root only). Verified: `mvn test` now reports 332/332 (pre-existing suite) → 341/341
(with JMIG-001's 9 new tests), `BUILD SUCCESS`, in the actual working tree — the previously-reported
"pre-existing compile defect" a delegated agent hit was an artifact of its isolated git-worktree
checkout lacking these never-tracked files, not a real defect in the repository's working state.

## 3a. The gap as originally documented (superseded by §3 above, kept for the historical record)

The 5 CORE strategies' **decision logic** is ported and parity-tested. What is missing is the
**feature-computation pipeline** that turns real `Bar[]` history into the `StrategyContext` those
strategies need — without it, Java's CORE strategies can only be exercised against synthetic
fixtures, never real market bars. Every other gap in §2 is either correctly TS-only (control plane,
experimental strategies) or low-priority (VWAP/SMC). This is the **single** piece of work that
determines whether Java can ever become live-authoritative for anything.

```
ID: JMIG-001
FILES: src/server/quant/RegimeEngine.ts (219 ln), src/server/quant/MarketContext.ts (170 ln),
       src/server/quant/indicators/trend.ts (240 ln), volatility.ts (135 ln), volume.ts (163 ln),
       priceAction.ts (151 ln), supportResistance.ts (213 ln)  [1,291 lines total]
FUNCTIONS: classifyRegime(), classifyDeskSession(), getMarketContext(), computeTrendFeatures(),
       computeVolatilityFeatures(), computePriceActionFeatures(), computeVolumeFeatures(),
       computeSupportResistanceFeatures()
JAVA TARGET: new io.argus.quantcore.features package (StrategyContext itself already exists as a
       ported Java data-shape record — only the computation that fills it is missing)
INPUT:  Bar[] (already a shared type both sides use)
OUTPUT: StrategyContext (already ported; port must produce byte-for-byte-parity field values)
CALLERS THAT WOULD NEED TO SWITCH: QuantSignalAgent.ts (live), FullArgusReplayEngine.ts (replay) —
       both stay TS-authoritative until parity is proven AND a real shadow-soak period has run
PARITY REQUIREMENT: byte-for-byte against real historical bars from data/argus.db, same rigor as
       the existing StrategyParityTest.java / scripts/java_parity_fixtures_phase1.ts pattern
ROLLBACK: trivial — TS remains the only wired path; Java stays shadow-only
LEGACY TS REMOVAL CONDITION: never, until Java parity is proven AND a documented shadow-soak period
       has run — this is the user's own explicit gate for this migration, not just this document's
PRIORITY: P2 — nothing is broken; this is the one dependency blocking further live-authoritative
       migration, not a safety defect
```

---

## 4. Safety verification (reconfirmed unchanged)

| Check | Result |
|---|---|
| No second order path | PASS — zero `placeOrder`/broker-adapter imports anywhere under `quant-core-java/` |
| Java bypasses ChiefTrader/RiskEngine/OMS | PASS (does not) |
| Java holds broker credentials | PASS (does not) |
| Double-gated live emission | PASS — `QUANT_JAVA_CORE_ENABLED` AND `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` both required |
| Live-ideas flag ever observed true outside a test | NO evidence found |

## 5. Verdict

```
HAS ALL ELIGIBLE TS ENGINE LOGIC MIGRATED TO JAVA?  PARTIAL — JMIG-001's calculation layer is now
                                                     ported and parity-verified (§3); wiring/shadow-
                                                     soak/cutover have not happened.
IS JAVA AUTHORITATIVE FOR ANYTHING LIVE TODAY?      NO — still zero live callers of the new pipeline.
CAN NEW QUANT LOGIC BE ADDED IN TYPESCRIPT?         NO, per CLAUDE.md's Java 26 Engine Authority.
IS DELETION OF ANY TS QUANT FILE AUTHORIZED YET?    NO — not until the Java port is wired, soaked in
                                                     shadow mode, and confirmed working, per explicit
                                                     operator instruction. Nothing so far meets that bar.
NEXT STEP:                                          Wire QuantSignalAgent.ts to call the new Java
                                                     feature pipeline through QuantCoreBridge in
                                                     SHADOW MODE ONLY (log parity divergence, never
                                                     emit from it), then begin the real shadow-soak
                                                     period before any live-ideas consideration.
```
