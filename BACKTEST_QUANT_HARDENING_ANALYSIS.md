# Backtest/Quant Hardening — Architecture Findings & Implementation Plan

Source-code audit of the 18-phase remediation request against the actual current repository
state (not the audit document's own claims, which are treated as a starting hypothesis and
verified/corrected against real files below). No production code has been modified as part of
producing this document, per the explicit instruction to present findings and wait for approval
first.

---

## A. Architecture Findings

### A.1 Audit claims verified true, with exact locations

| Audit claim | Verified at | Status |
|---|---|---|
| Live `PortfolioMonitor` exits use hardcoded +5%/-3% | [`PortfolioMonitor.ts:73,84`](src/server/services/PortfolioMonitor.ts#L73) (`PnL > 5.0` / `PnL < -3.0`, both literals) | **Confirmed real bug** |
| Backtest assumes +15%/-5% | [`BacktestEngine.ts:256-257`](src/server/engines/backtest/BacktestEngine.ts#L256) (`changePct <= -0.05` / `>= 0.15`, both literals) | **Confirmed real bug** |
| Position sizing capped at fixed $3,000 | [`RiskEngine.ts:190`](src/server/engines/RiskEngine.ts#L190) `settings[0]?.maxTradeSize \|\| 3000` | **Confirmed**, but see A.2 — it is not the only cap |
| AAPL/NVDA/TSLA multi-year backtests blocked by corporate-action handling | [`HistoricalDataGateway.ts:118`](src/server/engines/backtest/HistoricalDataGateway.ts#L118) `checkForUnadjustedCorporateActions()`, called from `BacktestEngine.ts:147` and `:411` | **True, but this is a working safety refusal already built (see A.3), not a missing feature** |
| QuantEngine strategies have never been backtested | N/A | **False as of this session** — `BacktestEngine.runStrategyBacktest()` already does exactly this (see A.3) |
| No risk/reward or EV | N/A | **False as of this session** — `quant/risk/ExpectedValue.ts` already does exactly this (see A.3) |
| Indicators treated as independent votes | N/A | **False as of this session** — `quant/scoring/GroupedScores.ts` already blends correlated oscillators (see A.3) |
| Fractional shares unsupported | [`AlpacaBroker.ts`](src/brokers/AlpacaBroker.ts) places orders via `qty` (whole-share), never `notional` | **Confirmed** — no broker adapter in this codebase supports fractional/notional order sizing |
| SMA/Bollinger calculated in multiple places | `quant/indicators/{trend,volatility}.ts`, `TechnicalIndicators.ts`, `AdvancedQuantEngines.ts` (the last is pre-existing, documented dead code — its output is never consumed by anything) | **Confirmed, but lower priority** — the live decision path (`BacktestEngine.ts`'s own inline SMA/RSI/MACD/Bollinger at lines 225-233) is a 4th independent implementation, separate again from `TechnicalIndicators`/`quant/indicators` |
| No point-in-time AI/news replay | `event_traces`, `transactions`, `consensus_decisions`, `consensus_evidence`, `risk_assessments`, `risk_gate_results` tables already exist (Transaction Observatory work, commits `b25c39d`..`5da34dc`) and already capture most of Phase 9's requested fields for **live** decisions | **Partially true** — live replay infrastructure already exists; what's missing is specifically *backtest-time* decision-trace logging at this same granularity (see E, Phase 9) |
| No walk-forward validation | No walk-forward/rolling-window split logic exists anywhere in `BacktestEngine.ts` or `quant/` | **Confirmed** — the audit's own -0.01% OOS figure was computed externally, not by any code in this repo |
| No Monte Carlo | No Monte Carlo code exists anywhere in the repo | **Confirmed** |

### A.2 Correction: position sizing is not a single flat $3,000 cap today

`PositionSizing.calculatePositionSizing()` (already shared by live `RiskEngine` and
`BacktestEngine.run()`) computes **three independent caps simultaneously** and takes the
minimum:

```
maxSharesByRisk     = floor((accountEquity × maxPortfolioRiskPct) / (price × 5% stop assumption))
maxSharesByCapital  = floor(maxTradeSizeDollar / price)      ← the "$3,000" the audit means
maxSharesByBuyingPower = floor(buyingPower / price)
```

`maxPortfolioRiskPct` is itself derived from `settings.riskLevel` (Conservative/Balanced/
Aggressive → 1%/2%/3% of equity, `RiskEngine.ts:191`) — so a real risk-based-% cap **already
exists** and already runs on every order. What's actually missing, precisely, is:

1. `maxTradeSizeDollar` itself is a flat number (`settings.maxTradeSize`, default 3000) that
   does not scale with account equity — so on a $100k backtest it never grows past $3k/trade
   (3% and shrinking as equity grows), and on a $500 account it's not "$3,000 cap doesn't
   matter," it's `maxSharesByBuyingPower` that binds instead. Neither is what the audit calls
   "percent-of-equity mode."
2. There is no user-selectable sizing **mode** — you cannot ask "always size at 2% of current
   equity" as a first-class choice; you get whichever of the three fixed caps happens to bind.

### A.3 Major finding: several requested phases are already built (this session, prior to this request)

The `tasks.txt` "quant decision layer" work completed earlier in this engagement already
satisfies a substantial fraction of Phases 3, 5, 6, 7, and 8 verbatim:

| Audit phase | Already exists at | Notes |
|---|---|---|
| Phase 3 (QuantEngine↔BacktestEngine adapter, same clock/costs/sizing) | `BacktestEngine.runStrategyBacktest()` (`BacktestEngine.ts`) | Long-only (matches the real no-short-selling broker capability), uses the same `Commissions.ts`/`Slippage.ts`/`ReplayClock`/`PositionSizing` as `run()`. Verified live against real AAPL history this session. |
| Phase 4 (per-strategy, per-regime evaluation) | `computeRegimeBreakdown()` in `BacktestEngine.ts` | Segments closed trades by `RegimeEngine.classifyRegime()` at entry |
| Phase 5 (feature categories, no vote-counting) | `quant/scoring/GroupedScores.ts` | RSI/StochRSI/CCI/Williams %R blended into one oscillator reading; MACD/ROC blended separately; the two blended 50/50 — never 4 independent votes |
| Phase 6 (regime-aware strategy selection) | `quant/RegimeEngine.ts` + `StrategyEngine.evaluateAll()`'s `applicableRegimes` discount | Deterministic, multi-signal, never a single indicator or LLM guess |
| Phase 7 (EV/Kelly from real backtest-derived probabilities, not invented) | `quant/risk/ExpectedValue.ts`, wired into `runStrategyBacktest()`'s own real win-rate output | Refuses Kelly below 20 closed trades; hard 10%-of-capital ceiling |
| Phase 8 (structured decision package to Chief Trader) | `ChiefTraderAgent.buildSupportingQuantDetail()` | Regime, strategy, setup scores, contradictions, invalidation conditions, entry/stop/target, holding period, AI review — RiskEngine never bypassed |

**This changes the shape of the remaining work substantially** — the "before vs after"
comparison the audit's Phase 18 asks for should be scoped against what's actually new, not
re-litigate work already shipped. See Section E for the re-scoped phase list.

### A.4 Correction: Phase 2C (corporate actions) is already a real, tested safety gate, not a gap

`HistoricalDataGateway.checkForUnadjustedCorporateActions()` fetches `adjustment=split` bars
alongside the cached `adjustment=raw` bars and flags any bar where the two disagree by more
than a threshold — exactly the "detect corporate actions... refuse to continue when integrity
cannot be established" behavior Phase 2C asks for. It is called from both `run()` (line 147)
and `runStrategyBacktest()` (line 411), and has its own test file
(`HistoricalDataGateway.test.ts`, 6 tests covering split detection, clean data, tiny-diff
tolerance, fetch failure, and pagination). **AAPL/NVDA/TSLA being "blocked" is this safety
check correctly doing its job** on a `adjustment=raw`-fetched range that contains a real
uncompensated split — not a missing capability. The only real gap here is UX: the refusal
currently surfaces as a thrown error with no caller-facing guidance on how to proceed (e.g. no
"fetch split-adjusted bars instead" fallback path is offered anywhere).

---

## B. Dependency Map

```
settings (DB table)
  ├─ maxTradeSize, riskLevel, takeProfitPct, trailingStopPct  ← PortfolioMonitor should read
  │                                                              these and currently doesn't
  └─ read by: RiskEngine.evaluateRisk(), BacktestEngine.run()/runStrategyBacktest()

PositionSizing.ts (calculatePositionSizing)
  ├─ called by: RiskEngine.evaluateRisk()  [live]
  ├─ called by: BacktestEngine.run()       [Phase 2A/2B target — extend, don't replace]
  └─ called by: BacktestEngine.runStrategyBacktest() [same]

HistoricalDataGateway.ts
  ├─ ensureBars()/getBars()                — raw OHLCV cache (ohlcv_bars table)
  ├─ checkForUnadjustedCorporateActions()  — already-built safety gate (A.4)
  └─ used by: BacktestEngine.{run, runStrategyBacktest}, MarketContext.ts, QuantSignalAgent.ts

BacktestEngine.ts
  ├─ run()                    — original baseline strategy (inline SMA/RSI/MACD/BB, +15/-5 exits)
  ├─ runStrategyBacktest()    — quant-layer adapter (Phase 3, already built)
  ├─ computeMetrics()/computeRMetrics()/computeRegimeBreakdown() — shared by both entry points
  └─ depends on: Commissions.ts, Slippage.ts, ReplayClock.ts, PositionSizing.ts,
                 RegimeEngine.ts, MarketContext.ts, StrategyEngine.ts, ExpectedValue.ts

quant/ (RegimeEngine, MarketContext, strategies/, scoring/GroupedScores,
        risk/ExpectedValue, ai/QuantContradictionAnalyzer)
  └─ consumed by: QuantSignalAgent.ts (live), BacktestEngine.runStrategyBacktest() (backtest)
     — same math, two callers. This is the "live/backtest parity" the audit's Phase 3 asks for,
     and it already holds for everything in quant/.

PortfolioMonitor.ts
  └─ 60s timer, DB-read holdings, hardcoded ±5%/-3% — Phase 2A target, currently reads nothing
     from `settings`

ChiefTraderAgent.ts
  └─ buildSupportingQuantDetail() (Phase 8, already built) — consumes QuantSignalAgent's
     TRADE_IDEA_GENERATED payload, never bypasses RiskEngine

Transaction Observatory tables (event_traces, transactions, consensus_decisions,
consensus_evidence, risk_assessments, risk_gate_results)
  └─ live-only today. Phase 9's "decision replay" ask needs a comparable structured record
     captured *inside* runStrategyBacktest()'s trade loop — new tables, not a reuse of these
     (the live tables are keyed to a real broker order lifecycle that doesn't exist in a backtest)

AlpacaBroker.ts / BrokerManager.ts
  └─ Phase 15 (small-account/fractional reporting) is read-only reporting on top of existing
     qty-only order placement — no broker code needs to change
```

---

## C. Files That Would Need Modification

Grouped by the re-scoped phases in Section E (E1–E7 below):

- **E1 (baseline run)** — none (uses existing `runStrategyBacktest()`/`run()` unmodified via a
  new script, not new backtest logic)
- **E2A (exit parity)** — `PortfolioMonitor.ts` (read `settings.takeProfitPct`/
  `trailingStopPct` instead of hardcoded 5/-3), `BacktestEngine.ts` (`run()`'s inline -0.05/0.15
  → also settings-driven), `src/server/db/schema.ts` (no new columns — both fields already
  exist), new regression test file
- **E2B (sizing modes)** — `src/server/db/schema.ts` (new `settings.positionSizingMode` column
  + migration), `PositionSizing.ts` (add `PERCENT_OF_EQUITY` mode, additive, `FIXED_DOLLAR`
  stays default/unchanged), `RiskEngine.ts` + `BacktestEngine.ts` (pass the new mode through),
  `configRoutes.ts` (expose the setting), a frontend control (`App.tsx` or
  `BrokerManagement.tsx`'s sibling settings panel — smallest-blast-radius option to be confirmed
  with user before touching `App.tsx`)
- **E3 (decision-trace logging in backtests)** — `src/server/db/schema.ts` (new
  `quant_backtest_decision_log` table), `BacktestEngine.ts` (`runStrategyBacktest()` gains an
  optional verbose-logging path — additive, off by default to avoid ballooning existing test
  run times/DB size)
- **E4 (failure classification)** — new `src/server/quant/analysis/FailureClassification.ts`,
  consumed by `runStrategyBacktest()`'s post-trade step, new observability route
- **E5 (walk-forward)** — new `src/server/engines/backtest/WalkForward.ts` (wraps
  `runStrategyBacktest()` with a rolling train/test window splitter — does not modify
  `runStrategyBacktest()` itself)
- **E6 (Monte Carlo)** — new `src/server/quant/analysis/MonteCarlo.ts` (pure function over an
  existing trade log — no engine changes)
- **E7 (benchmarks + small-account reporting)** — `BacktestEngine.ts` (add a buy-and-hold
  comparison using the benchmark bars it already fetches for regime context — additive field on
  the existing result object), new `src/server/quant/analysis/AccountSizeReport.ts`

## D. Files That Should NOT Be Touched

- `RiskEngine.ts`'s gate ladder / circuit breakers (order-rate, daily-loss, consecutive-loss,
  drawdown, concentration, correlation) — no phase requires changing what RiskEngine blocks,
  only what feeds it
- `quant/strategies/*.ts` (the 5 strategy implementations) — Phase 3/4/6 evaluate them, never
  rewrite their entry/exit logic
- `quant/scoring/GroupedScores.ts`, `quant/risk/ExpectedValue.ts`, `quant/RegimeEngine.ts` —
  already satisfy their respective phases (A.3); at most read from, never modified
- `ChiefTraderAgent.ts`'s consensus/weighting logic — Phase 8 is already done; do not touch
  `evaluateConsensus()`
- `BrokerManager.ts` / any broker adapter's order-placement code — Phase 15 is reporting-only,
  not a fractional-order feature (no broker in this codebase supports it; building a
  fractional-share *simulator* for backtesting only, if wanted, is a separate explicit ask)
- `Commissions.ts`, `Slippage.ts`, `ReplayClock.ts` — reused as-is by every new backtest phase
- `BacktestEngine.run()`'s and `.runStrategyBacktest()`'s existing signatures/return shapes —
  extend via new optional fields, never break existing callers (`v2System.ts` routes,
  `BacktestEngine.test.ts`, `BacktestEngine.strategyBacktest.test.ts`)
- `QUANT_ENGINE_ENABLED` off-by-default convention — none of this plan flips it; it stays a live
  opt-in switch, unrelated to whether the backtester can evaluate quant strategies offline

## E. Re-Scoped Implementation Phases

Given A.3/A.4, the original 18 phases collapse into 7 real work items plus a baseline run.
Recommend approving **and scheduling** these incrementally rather than as one pass — this is
genuinely 7 separate, independently testable pieces of work, several with DB migrations.

1. **E1 — Baseline run.** Execute the existing (unmodified) `run()` and `runStrategyBacktest()`
   against SPY/QQQ/MSFT/AMD, 2018-01-01→2025-12-31, $100k, save results as a machine-readable
   JSON artifact. No code changes. *(AAPL/NVDA/TSLA are expected to still refuse per A.4 unless
   E1 also adds a split-adjusted-bars fallback path — needs a decision: leave them refusing
   honestly, or add adjustment='split' as an alternate fetch mode. Flagging this as a decision
   point, not deciding it here.)*
2. **E2A — Exit parity (small, high-value, low-risk).** Wire `PortfolioMonitor.ts` and
   `BacktestEngine.run()` to both read `settings.takeProfitPct`/`trailingStopPct` (columns
   already exist, already default to 15/5, currently read by neither). Adds a regression test
   asserting both consumers see identical values for a given settings row.
3. **E2B — Selectable position-sizing mode.** Add `FIXED_DOLLAR` (default, current behavior,
   zero change) / `PERCENT_OF_EQUITY` mode to `PositionSizing.ts`, feature-flagged in settings,
   never loosening the existing risk/correlation/concentration caps — those remain hard floors
   under either mode.
4. **E3 — Backtest-time decision-trace logging.** New table + optional verbose path in
   `runStrategyBacktest()` recording per-candidate: features, regime, strategy conditions
   met/failed, risk gates, sizing, EV/Kelly, and outcome — the Phase 9/10 ask, scoped to
   backtesting only (live decision tracing already exists via Transaction Observatory).
5. **E4 — Failure classification.** Post-trade categorization
   (WRONG_DIRECTION/FALSE_BREAKOUT/LOW_VOLUME/BAD_REGIME/etc.) computed from E3's trace data —
   depends on E3 shipping first.
6. **E5 — Walk-forward validation harness.** Rolling train/test window wrapper around
   `runStrategyBacktest()`, reporting IS vs. OOS metrics per window. Independent of E3/E4.
7. **E6 — Monte Carlo (research-only, explicitly labeled scenario analysis).** Resampling over
   a completed trade log's R-multiples — pure function, no engine dependency.
8. **E7 — Benchmark comparison + small-account report.** Buy-and-hold SPY/QQQ overlay on
   existing backtest results; capital-utilization/affordable-share report for
   $100/$500/$1k/$5k/$10k/$100k runs, honestly reporting "TRADE NOT POSSIBLE — WHOLE SHARE
   CONSTRAINT" where applicable (no fractional-share simulation unless separately requested).

Explicitly deferred pending your prioritization: Phase 5's "options" and "fundamentals" score
categories (no options data source exists anywhere in this codebase — would need to be honestly
reported `available:false` like `MarketContext.ts`'s breadth field already is, not fabricated).

## F. Risk Assessment

- **E2A** — lowest risk. Both fields already exist and already default to the values currently
  hardcoded, so a correctly-wired read is a no-op for anyone who hasn't changed their settings,
  and becomes user-configurable for anyone who has. Regression test makes divergence impossible
  to reintroduce silently.
- **E2B** — moderate risk, mitigated by feature flag + default-unchanged behavior. Real risk is
  a bug in the new mode's math producing an oversized live order; mitigated by RiskEngine's
  existing hard caps remaining authoritative regardless of sizing mode (per audit's own explicit
  rule 8 — "must never bypass maximum position limits...").
- **E3** — risk is scope creep / performance: verbose per-candidate logging inside a backtest
  loop over years of daily bars can be large. Mitigated by making it opt-in (off by default) and
  capping retention, not always-on.
- **E4** — depends entirely on E3's data shape being right first; low risk in isolation.
- **E5 (walk-forward)** — moderate engineering risk (window-boundary look-ahead bugs are exactly
  the class of bug this codebase has been bitten by before — `ReplayClock`'s look-ahead-bias
  guard exists for this reason). Must reuse `ReplayClock`/point-in-time bar filtering, never
  re-implement a second clock.
- **E6 (Monte Carlo)** — lowest risk, purely additive analysis with no path into live trading
  decisions; only risk is presentation (must be labeled scenario analysis, not prediction, per
  the audit's own explicit instruction).
- **E7** — low risk, read-only reporting.
- **Cross-cutting** — none of E2A-E7 touch `RiskEngine.ts`'s gate ladder, broker adapters, or
  `ChiefTraderAgent`'s consensus math, so the blast radius for a bug is backtest-research-tooling
  and (for E2A/E2B only) live position sizing/exit behavior — not order-placement or
  consensus-approval logic.

## G. Test Plan

- E2A: parity regression test (`PortfolioMonitor` and `BacktestEngine.run()` read identical
  values from one settings row); existing `PortfolioMonitor`/`BacktestEngine` test suites must
  stay green.
- E2B: unit tests per sizing mode; a test proving `PERCENT_OF_EQUITY` mode still respects
  `MAX_SINGLE_SYMBOL_CONCENTRATION_PCT`/sector/correlation caps identically to today; a test
  proving `FIXED_DOLLAR` mode's output is byte-identical to current `calculatePositionSizing()`
  output (no behavior change for existing users).
- E3: schema/migration test; a `runStrategyBacktest()` integration test asserting the verbose
  log's trade count matches the existing trade log's trade count exactly (no silent drops).
- E4: classification unit tests, one fixture per failure category.
- E5: the standard look-ahead-bias guard test pattern already used elsewhere in this codebase
  (assert a window's decision is unaffected by mutating bars strictly after its boundary).
- E6: statistical sanity tests (e.g., resampling a known win/loss sequence reproduces its own
  empirical mean within tolerance).
- E7: a test asserting the small-account report correctly refuses (not silently rounds) when
  `capital < one share's price`.
- Full suite (`npx vitest run`, currently 88 files/629 tests) must stay green after every phase,
  run twice consecutively per this session's established discipline; `npx tsc --noEmit` and
  `npm run build` clean after every phase.

## H. Expected Impact

- **On live trading behavior**: none, until E2B's new sizing mode is explicitly selected by a
  user (default stays `FIXED_DOLLAR`, current behavior) — and even then, RiskEngine's hard caps
  are unchanged. E2A's exit-threshold wiring **will** change live `PortfolioMonitor` behavior
  for anyone who has already set non-default `takeProfitPct`/`trailingStopPct` values in their
  settings (currently silently ignored) — worth calling out explicitly before shipping, since
  "no behavior change" is not strictly true for that specific case.
- **On existing tests**: none should break; every phase above is additive (new modules/columns/
  optional params), matching this session's established "extend, don't replace" discipline.
- **On the trading-edge question**: none of E1-E7 make any strategy more profitable — they make
  the evaluation of profitability more rigorous (walk-forward OOS, regime-segmented, benchmark-
  relative, failure-classified) and make live/backtest assumptions consistent with each other.
  Per the audit's own stated principle, this work should not be expected to, and must not be
  represented as, producing a validated trading edge. The current standing verdict in
  `FINAL_ANALYSIS.md` ("no statistically validated trading edge exists," "DO NOT SHIP for live
  capital") is expected to remain unchanged by this work; E1's fresh baseline numbers and any
  E5 walk-forward results will be appended as a new dated section once available, not used to
  silently revise that verdict.

---

---

## I. Implementation Report (E1-E7 complete)

Approved as "all E1-E7 in order." All seven implemented, tested, and verified. This section
records what actually happened, including two corrections to the plan above discovered only once
real execution started.

### I.1 Corrections to the plan discovered during implementation

- **E2A's "settings already exist" claim was confirmed exactly as predicted**: `PortfolioMonitor.ts`
  now reads `settings.takeProfitPct`/`trailingStopPct` (previously-unused columns, defaults 15/5)
  instead of hardcoded +5%/-3%; `BacktestEngine.run()` now reads the same fields instead of its own
  hardcoded -5%/+15% literals. Both consumers now derive their thresholds from one shared source.
- **E5 turned out to be a much smaller task than scoped**: `WalkForwardValidator.ts` already
  existed, complete with a real rolling train/test splitter, a real `POST /api/v1/backtest/walk-forward`
  route, and IS-vs-OOS aggregation - it had simply never been given its own test file, so this
  session's earlier deep-repository read (which focused on `src/server/quant/` and
  `BacktestEngine.ts`) missed it entirely. The actual E5 work was: (1) extend
  `WalkForwardConfig`/`.run()` with an optional `strategyId`+`symbol` mode that calls
  `BacktestEngine.runStrategyBacktest()` instead of `.run()`, (2) thread the same optional fields
  through the existing route, (3) write `WalkForwardValidator.test.ts` (previously zero coverage)
  - which immediately surfaced a real, previously-undetected latent gap: **`testDays` must be at
    least as wide as the underlying backtest's own minimum-bar requirement (`LOOKBACK`=50 for
    `run()`, `REGIME_MIN_BARS`=60 for `runStrategyBacktest()`) or every period's test call throws**,
    since each window is evaluated on its own bars only. This was never caught before because no
    test had ever actually run `WalkForwardValidator` end-to-end. Documented in
    `WalkForwardConfig.testDays`'s own comment rather than silently worked around.

### I.2 Files changed

**Schema/migrations** (`src/server/db/schema.ts`, `drizzle/0021`-`0023`): `settings.positionSizingMode`/
`percentOfEquityPct` (E2B); new `quant_backtest_decision_log` table (E3); `quant_strategy_backtests.benchmarkComparison`
(E7).

**New modules**: `quant/analysis/FailureClassification.ts` (+test, E4), `quant/analysis/MonteCarlo.ts`
(+test, E6), `quant/analysis/AccountSizeReport.ts` (+test, E7).

**Modified**: `PortfolioMonitor.ts` (E2A), `BacktestEngine.ts` (E2A/E2B/E3/E4/E7 - `run()` and
`runStrategyBacktest()`), `PositionSizing.ts` (E2B mode + exported `STOP_LOSS_ASSUMPTION_PCT`, E7
reuse), `RiskEngine.ts` (E2B), `configRoutes.ts` (E2B allowlist), `WalkForwardValidator.ts` (E5),
`systemRoutes.ts` (E5 route), `v2System.ts` (E3 decision-log route, E4 failure breakdown on GET,
E6 Monte Carlo route, E7 benchmark comparison on GET).

**New tests**: `PortfolioMonitor.test.ts`, `BacktestEngine.exitThresholds.test.ts`,
`PositionSizing.test.ts` (extended), `FailureClassification.test.ts`, `MonteCarlo.test.ts`,
`AccountSizeReport.test.ts`, `WalkForwardValidator.test.ts`, plus extensions to
`BacktestEngine.strategyBacktest.test.ts` and `v2System.quantObservability.test.ts`.

**New scripts**: `scripts/runBaseline.ts` (E1, reusable - reproduces the exact baseline run on
demand), `scripts/runWalkForwardCheck.ts` (OOS sanity check on the baseline's highest-Sharpe
combinations).

### I.3 Verification

`npx tsc --noEmit`: clean. `npx vitest run`: **94 test files / 667 tests passing**, run twice
consecutively (a first full-suite run hit transient `beforeAll` hook timeouts under system load -
unrelated to any specific test, resolved on immediate re-run, matching this session's own earlier
documented `v2System.override.test.ts` timing-flake precedent). `npm run build`: clean (no new
warnings). `npm run security:scan-writes`: clean.

### I.4 E1 baseline results (real, `scripts/runBaseline.ts`, `BASELINE_RESULTS.json`)

SPY+QQQ+MSFT+AMD, 2018-01-01 to 2025-12-31, $100,000, via the **unmodified** `BacktestEngine.run()`
(the original deterministic technical strategy, portfolio-style, one combined simulation):

| Metric | Value |
|---|---|
| Final equity | $114,901.32 |
| Total return | +14.91% |
| Win rate | 50.9% |
| Profit factor | 1.98 |
| Sharpe / Sortino | 0.51 / 0.29 |
| Max drawdown | 3.54% |
| Expectancy | $90.31/trade |
| Closed trades | 165 |

This matches the audit's own cited baseline (165 trades, 50.9% win rate) almost exactly, which is
a strong cross-check that both the audit and this codebase's real backtest engine agree on the
same underlying data and math.

Per-strategy, per-symbol results via `BacktestEngine.runStrategyBacktest()` (single-symbol, not
portfolio-combined - see the full `BASELINE_RESULTS.json` for all 20 strategy×symbol
combinations). Highest-Sharpe results, **before OOS validation**:

| Strategy | Symbol | Trades | Win rate | Sharpe | Expectancy | Kelly justified? |
|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | AMD | 636 | 60.1% | 2.59 | $51.21 | Yes, 8.26% suggested |
| MOMENTUM_BREAKOUT | MSFT | 740 | 60.3% | 1.99 | $15.72 | Yes, 8.44% suggested |
| RANGE_REVERSION | QQQ | 1324 | 50.3% | 2.22 | $6.72 | Yes, 7.23% suggested |

Lowest/negative: MEAN_REVERSION/AMD (Sharpe -0.06, expectancy -$3.58, Kelly correctly refuses at
0%). AAPL/NVDA/TSLA were not included (the audit's own reason for excluding them - real corporate
actions in this window, correctly caught and refused by `checkForUnadjustedCorporateActions()`,
per A.4 above - still holds).

### I.5 Walk-forward OOS check on the two highest-Sharpe results

Run via `scripts/runWalkForwardCheck.ts` (E5's new quant-mode `WalkForwardValidator`),
`trainDays=365`/`testDays=120`, same 2018-2025 window:

| Combination | Periods | Avg in-sample return | Avg out-of-sample return | IS-OOS gap | % OOS periods positive |
|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT / MSFT | 21 | +0.37% | **+0.04%** | 0.33pp | 42.9% |
| MOMENTUM_BREAKOUT / AMD | 21 | +1.36% | **+0.28%** | 1.08pp | 66.7% |

**This is exactly the overfitting signature the audit warned about, on this session's own two
"best-looking" backtest results.** The full-period Sharpe (1.99 MSFT / 2.59 AMD) and headline
expectancy numbers in I.4 come almost entirely from in-sample performance - out-of-sample, MSFT's
average return per ~120-day window collapses to +0.04% (under half its periods were even
profitable) and AMD's collapses to +0.28% from +1.36% in-sample. Both real gaps are large relative
to the in-sample number itself (MSFT loses ~89% of its apparent edge out-of-sample; AMD loses
~79%). This is real evidence AGAINST treating either "best" result as a discovered edge, obtained
using the very oversight machinery (E5) built in this same session - not an external audit finding
this time, but this codebase checking its own new numbers before anyone could get excited about
them.

### I.6 What this does and does not change about the standing verdict

**Every real bug found and fixed here (E2A's exit-threshold mismatch, E2B's inflexible sizing) is
a correctness/consistency fix, not evidence of a trading edge.** The E1 baseline numbers above
(before OOS validation) look attractive in isolation - that is exactly the trap the audit itself
warned against ("Never optimize specifically to make historical returns look good," "Do NOT claim
a strategy is profitable without actual backtest results"). Section I.5's real out-of-sample check
is the only number in this document that should carry any weight toward a profitability claim, and
even a positive OOS result from 2 symbols over one strategy would not be a "validated edge" by any
reasonable statistical standard - it would be a single data point warranting further, wider
walk-forward testing before anyone should trust it with real capital. `FINAL_ANALYSIS.md`'s
standing verdict ("no statistically validated trading edge exists," "DO NOT SHIP for live
capital") is unchanged by this work and is reaffirmed in a new dated section there.
