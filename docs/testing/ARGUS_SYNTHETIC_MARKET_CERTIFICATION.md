# Argus Synthetic Market Certification — Design Doc

**Status: this is an audit + hardening pass on pre-existing infrastructure, not a new harness.**
Before writing any code, this pass searched the repo for existing simulation/replay/synthetic
infrastructure per the task's own Section 1 instruction, and found a mature, already-built,
already-multiply-audited framework: the **Synthetic Market Session Simulator** (2026-09-14
mandate onward). Building a second, parallel harness would have violated CLAUDE.md's "extend,
don't fork" rule and this task's own prohibition on duplicating architecture. Everything below is
either (a) what already exists and was reused as-is, or (b) a small number of real, narrowly
scoped fixes/additions made during this pass, each called out explicitly.

## 1. What already exists (inventory, reused as-is)

| Component | Path | What it is |
|---|---|---|
| Clock abstraction | `src/server/core/Clock.ts` (`Clock` interface, `LiveClock`), `src/server/engines/backtest/ReplayClock.ts` | `Clock.now(): number`. `SyntheticMarketClock` already extends `ReplayClock`. No second clock built. |
| Real-time-accelerated clock | `src/server/replay/SyntheticMarketClock.ts` | Pull-based (`now()` computed from anchor + elapsed real time × `speedMultiplier`), not a timer — deliberately avoids scheduler jitter affecting decisions. |
| Scenario definitions | `src/server/replay/synthetic/SyntheticScenario.ts` | 10 deterministic `ScenarioProfile`s: regime segments + discrete events (gap/news/vol-spike/outage). Seeded PRNG (`SyntheticRandom.ts`), same seed replays identically. |
| Market data generator | `src/server/replay/synthetic/SyntheticMarketDataEngine.ts` | Produces quotes/1m bars/volume/spread from a scenario, fed through the **real** market-data ingestion path (`emitMarketData`), never injected past it. |
| News generator | `src/server/replay/synthetic/SyntheticNewsGenerator.ts` | Deterministic synthetic news items for `NEWS_SHOCK`-class scenarios, wired through the real `news_clusters`/gate-14 surface. |
| Session engine (the harness itself) | `src/server/replay/synthetic/SyntheticSessionEngine.ts` | Boots the **real** `bootArgusCore()` (real EventBus, real TechnicalAgent, QuantSignalAgent, KronosForecastAgent, FundamentalAgent/MacroAgent (HOLD-only), ChiefTrader, RiskEngine, OMS, `HistoricalReplayBroker`) against an isolated DB and isolated broker, feeding it synthetic ticks through the normal ingestion entry point. |
| Certification gate | `src/server/replay/synthetic/CertificationGate.ts` | Pure function reading PASS/FAIL off the real pipeline's own timeline + broker state (stage-by-stage: MARKET_DATA → AGENT_IDEA → CONSENSUS → RISK_APPROVAL → ORDER_SUBMITTED → FILL_RECEIVED → POSITION_OPENED → POSITION_CLOSED). Never injects a decision. |
| Timeline invariants | `src/server/replay/synthetic/TimelineInvariants.ts` | Causal-order checks: RISK_BYPASS, PHANTOM_FILL, CONSENSUS_BYPASS, ORDER_DURING_OUTAGE. |
| CLI launcher | `scripts/sim/marketOpen.ts` (parent, zero `src/server/` imports) + `scripts/sim/marketOpenChild.ts` (isolated child process) | `npm run sim:market-open -- --scenario=X --seed=N --speed=N --duration=N`; `--certify` runs both mandatory tests; `--seeds=N` for a multi-seed sweep. |
| Calibration seeding | `src/server/replay/synthetic/CalibrationHistorySeeder.ts` | Seeds a synthetic prior track record so the MODERATE-tier calibration-trust gate can be exercised at all; every certification artifact that uses it is labeled `SYNTHETIC_SEEDED` / `NON_ORGANIC` / `CERTIFICATION_FIXTURE_ONLY` and `productionCalibrationModified: false` is asserted, not just claimed. |
| DB/process isolation | `src/server/db/syntheticSimulationDbGuard.ts`, `src/server/replay/syntheticSimulationPaths.ts`, `src/server/replay/SyntheticSimulationSafety.ts` | Throws fatally if a synthetic run's resolved DB path ever equals the production DB path; isolated path format is `tmp`-style under the OS temp dir with the scenario/seed/timestamp embedded (equivalent in spirit to the task's requested `tmp/argus-certification-<runId>.db`). Each has its own test file. |
| Prior audits | `docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_2026-09-15.md`, `ARGUS_SYNTHETIC_COVERAGE_AND_TODAY_REVERSE_ENGINEERING_2026-09-16.md`, `ARGUS_OVERNIGHT_CERTIFICATION_2026-09-16.md`, `ARGUS_SYNTHETIC_ADVERSARIAL_CERTIFICATION_V2_2026-10-04.md`, `ARGUS_SYNTHETIC_FRAMEWORK_FORENSIC_2026-10-04.md` | Multiple independent forensic passes already exist and are the most reliable account of this framework's honest limitations. This doc does not repeat their content; see them directly. |

Nothing in the list above was rebuilt. `package.json` already had `sim:market-open`; this pass
added `npm run test:certification` (wraps `--certify`) and `npm run test:certification:unit`
(the existing 77 unit tests under `src/server/replay/synthetic`) as thin aliases, per Section 46 —
no new runner logic.

## 2. No-cheat enforcement (how it's architectural, not a promise)

- `SyntheticMarketDataEngine` output reaches the pipeline only via the same `emitMarketData()` /
  `MARKET_DATA` event path a real Alpaca WebSocket tick would use — confirmed by reading
  `SyntheticSessionEngine.ts`'s own ingestion call, not by trusting a comment.
- `CertificationGate.evaluateCertification()` takes a `SyntheticSessionResult` (the real timeline +
  real `HistoricalReplayBroker` state) and only counts real `TRADE_IDEA_GENERATED` /
  `CHIEF_APPROVED_IDEA` / `RISK_ASSESSMENT_COMPLETED` / `ORDER_SUBMITTED` / `ORDER_FILLED` events —
  it contains no code path that constructs or injects any of those events itself.
- `TimelineInvariants.ts` independently re-derives causal ordering from the same timeline (a risk
  approval must causally precede its order; an order must causally precede its fill; a feed-outage
  window must contain no orders) — this is deliberately redundant with the stage-counting above so
  a bug in one checker can't silently pass a violation the other would have caught.
- `src/server/db/syntheticSimulationDbGuard.ts` is a pure function (`assertSyntheticSimulationNotOpeningProductionDb`) with its own unit test using fake paths — the guard itself is never exercised against the real DB file, so proving it works never risks opening the real file.
- Architecture-boundary enforcement (Section 44's ask): `SyntheticSimulationSafety.test.ts` and
  `syntheticSimulationDbGuard.test.ts` already assert the isolation invariants this task's
  Section 44/45 ask for. No real/LIVE broker adapter is ever instantiated by this harness —
  `prepareIsolatedEnvironment()` forces `ARGUS_ACTIVE_BROKER=internal_paper` before any boot code
  runs, confirmed by reading the source (not inferred).

## 3. Real fixes made during this pass (not threshold changes, not trading-logic changes)

### 3.1 Real-network leak into a synthetic session — FIXED

**Found live, 2026-10-06**, running `npm run sim:market-open -- --scenario=QUIET_OPEN
--seed=20261006 --speed=400 --duration=90`: every run (verified across all 7 scenarios tried this
pass) produced a real outbound HTTP call —

```
[moverCohort] cohort build failed movers screener HTTP 401
Error: movers screener HTTP 401
    at ... withDiscoveryCircuitBreaker ...
    at ... PostMarketAnalysisWorker.runReflectionOnce ...
    at ... PostMarketAnalysisWorker.tick ...
```

**Root cause:** `SystemBootstrap.start()` — triggered inside the harness by its own seeded
`autoBotEnabled:true` settings row, exactly the same mechanism the engine's prior
`ARGUS_NEWS_ENGINE_ENABLED='false'` fix (2026-09-15, documented in `SyntheticSessionEngine.ts`'s
own comments) was written to stop for `newsEngine` — unconditionally also calls
`postMarketAnalysisWorker.start()`. That worker's `tick()` runs on the real wall clock (not the
synthetic session clock: `PostMarketAnalysis.ts`'s own `classifyMarketSession(now.getTime(), ...)`
defaults `now` to `new Date()`), and once it sees real time is outside RTH (true whenever a
certification run happens outside 9:30–16:00 ET, which is most of the time) it calls
`runDailyReflection() → buildMoverCohort() → fetchRawMovers()` — a real call to the live movers
screener endpoint. It failed with 401 and was caught by the worker's own try/catch (no corruption
resulted), but this is a real, verified violation of this task's isolation requirement (no real
network from an offline harness) — the same bug class the 2026-10-04 forensic audit's own §6 had
already flagged as "Real-network leak into synthetic? Partial."

**Fix:** same pattern as the existing `newsEngine` guard.
`SyntheticSessionEngine.prepareIsolatedEnvironment()` now also sets
`process.env.ARGUS_POST_MARKET_ANALYSIS_ENABLED = 'false'`, and `SystemBootstrap.ts`'s
`postMarketAnalysisWorker.start()` call is now guarded by
`if (process.env.ARGUS_POST_MARKET_ANALYSIS_ENABLED !== 'false')`. Verified before/after on the
same seed: 3 real `movers screener HTTP 401` attempts per run before the fix, 0 after, across 7
independent re-runs. All 77 pre-existing unit tests under `src/server/replay/synthetic` still pass
unchanged. No threshold, gate, or production trading behavior touched — `postMarketAnalysisWorker`
still starts normally in a real engine boot (the guard only fires when the synthetic harness has
explicitly set the flag to `'false'`).

### 3.2 `npm run test:certification` / `test:certification:unit` — ADDED

Thin `package.json` aliases (Section 46). No new runner code: `test:certification` runs
`scripts/sim/marketOpen.ts --certify --speed=400` (the existing accelerated certification path);
`test:certification:unit` runs the existing 77 vitest cases under `src/server/replay/synthetic`.

## 4. The headline finding this pass could NOT fix (reported, not papered over)

**The 5 CORE quant strategies (`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`,
`TREND_FOLLOWING`, `RANGE_REVERSION`) never evaluate in this harness at all, in any scenario, on
any seed tried this pass.** This is the single most important result of this pass and the reason
the Strategy Certification Matrix (§14 of the task, reproduced in the result doc) cannot be
completed as asked.

**Verified mechanism:** `QuantSignalAgent` (the real production agent that calls
`StrategyEngine.evaluateAll()`, which is what actually runs the 5 CORE strategies) is correctly
enabled in this deployment (`QUANT_ENGINE_ENABLED=true` in `.env`) and does start inside the
harness (`[QuantSignalAgent] Starting - real regime/market-context evaluation every 300s...`). But
every single evaluation attempt, for every symbol, in every one of the 7 scenarios run this pass,
failed identically:

```
[QuantSignalAgent] Failed to evaluate SPY HistoricalDataGateway refuses a real network fetch for
SPY (1Day) during a synthetic simulation session (SYNTHETIC_SIMULATION=true) - no real
Alpaca/IBKR historical-bar call is made. The synthetic session must provide its own bars for any
timeframe a caller needs, or that caller must not run during synthetic sessions.
```

`HistoricalDataGateway` is correctly refusing a real network call during an isolated synthetic
session (that refusal is itself correct and desired — it is the same isolation discipline this doc
praises elsewhere). The actual gap is upstream: **no synthetic 1-Day-bar provider is registered
for `QuantSignalAgent` to fall back to.** `SyntheticMarketDataEngine` only produces this session's
own 1-minute bars; `QuantSignalAgent`'s CORE strategies need a `1Day` timeframe history (and, per
`CERTIFIED_BULLISH_ENTRY_EXIT`'s own design comments, likely multiple days of it for SMA200/ADX-
class conditions), which a single synthetic session's intraday-only data cannot honestly
synthesize without a separate, deliberate daily-bar generator.

**Why this pass did not attempt the fix:** this is a real, structural gap requiring a new synthetic
daily-bar history provider wired through `HistoricalDataGateway`'s registry (plausibly multiple
synthetic trading days' worth, consistent with how `CERTIFIED_BULLISH_ENTRY_EXIT`'s own authors
already found SMA200 needs the session's own bars to be long enough to be non-null) — a
scoped, nontrivial piece of new test infrastructure in its own right, not a one-line fix, and not
safe to improvise quickly against a mature, multiply-audited framework in the same pass as
everything else above. It is recorded here, not patched around, and not hidden behind a scenario
that happens to get a fill some other way (every fill this pass observed came from TechnicalAgent
and KronosEngine — never from `QuantEngine` — see the result doc).

**Consequence for the matrix:** the result doc's Strategy Certification Matrix (§14) necessarily
shows all 5 CORE strategies as `NOT_EVALUATED`, not `PASS` or a fabricated `FAIL` — the honest
state is "the harness cannot currently reach this code path," which is a different, more specific
claim than "the strategy was tried and rejected."

## 4a. Follow-up pass (2026-10-06, same day): the synthetic daily-bar provider that closes §4's gap

**Status: this is the fix for the exact gap §4 reported.** The prior pass in this document correctly
declined to improvise a daily-bar provider inside an already-large pass. This follow-up pass builds
it, as a new, narrowly-scoped, explicitly-synthetic addition to the SAME harness — not a second
simulator, not a bypass of `HistoricalDataGateway`'s real guard.

### What was built

`src/server/replay/synthetic/SyntheticDailyBarProvider.ts` — two pure functions, both derived from
the session's own real seed/scenario, never a second disconnected data source:

- **`generateSyntheticPriorDayHistory(config, scenario, seed, sessionStartMs, priorTradingDays=260)`**
  — a deterministic daily OHLCV series for the `priorTradingDays` trading days (weekday-only,
  documented approximation) immediately before the session's own `sessionStartMs`. Uses a
  SEPARATE, symbol-specific RNG stream (`deriveDailySeed()`, an FNV-1a hash of the session seed +
  symbol) so it never perturbs `SyntheticMarketDataEngine`'s own already-certified minute-bar draw
  sequence — two independently-deterministic streams from one seed, not two sources of randomness.
  Daily volatility is `config.baseVolatility * sqrt(390)` — the standard Brownian time-scaling
  relationship from the session's own per-minute sigma, not an invented number. Daily drift
  direction (not magnitude) is read off the scenario's own regime segments
  (`regimeDriftSign()`, duration-weighted sign of `driftPerBarMean`) — a bull-dominant scenario
  produces a real net-positive 260-day history, a bear-dominant one a real net-negative one,
  matching this file's own doc comment for why magnitude is a fixed, realistic ~0.15%/day rather
  than a literal per-minute-to-per-day extrapolation (which would compound into an absurd price
  path). The series is built BACKWARDS from an anchor so the most recent (closest-to-session)
  day's close exactly equals `config.startPrice` — the live session's own first minute bar
  continues smoothly from this history rather than gapping to an unrelated price.
- **`rollupTodaysDailyBar(revealedBars, dayTimestamp)`** — a real OHLCV rollup (first open, running
  high/low, latest close, summed volume) of the CURRENT session's own already-revealed minute bars.
  `SyntheticSessionEngine.ts` calls this once per minute bar, immediately after that bar is
  revealed to the rest of the pipeline — never fed a later bar before its own timestamp has been
  reached, so today's own daily bar can never leak a future high/low/close into an earlier
  QuantSignalAgent cycle.

Both exported bar-producing functions call `assertSyntheticDailyBarProviderOnlyInSyntheticSession()`
first, which throws unless `process.env.SYNTHETIC_SIMULATION === 'true'` — the exact same flag
`HistoricalDataGateway.ts`'s own real-network-refusal guard checks. This module cannot produce a
bar at all outside an isolated synthetic session, even if something imported it by mistake.

### Integration point (verified against the real code, not guessed)

§5 below (unchanged from the prior pass) correctly named `HistoricalDataProviderRegistry.ts` as a
registry pattern worth reusing for a FUTURE historical-replay-lab provider — but reading
`QuantSignalAgent.ts`'s actual call path (`historicalDataGateway.ensureBars()` /
`historicalDataGateway.getBars()` directly, `TIMEFRAME = '1Day'`) showed that registry is not on
this path at all; `QuantSignalAgent` never goes through it. The real integration point is
`HistoricalDataGateway.ts`'s own cache-first check inside `ensureBars()`: `existing.length > 0`
already short-circuits before the `SYNTHETIC_SIMULATION` guard. So the correct, minimal integration
is: write real synthetic rows into `ohlcv_bars` (the same table `ensureBars()`'s cache-first check
already reads) BEFORE anything queries them — not registering a new provider class, and not
touching the guard itself. `SyntheticSessionEngine.ts`'s `persistDailyBar()` does this with a direct
upsert into `ohlcv_bars`, `source='synthetic_simulation_daily'` (distinct from the `'synthetic_simulation'`
tag minute bars already use), `timeframe='1Day'`.

### A real root-cause ordering bug found and fixed during this pass

The first attempt seeded the daily history AFTER `bootArgusCore()` (matching where the minute-bar
generation call already sat). That produced an intermittent, symbol-specific failure: one symbol
(QQQ, in the first reproduction) failed `ensureBars()`'s `SYNTHETIC_SIMULATION` guard on every cycle
for the practical duration of the whole session, while every other seeded symbol succeeded. Root
cause, confirmed via a temporary debug probe logging the gateway's own in-memory cache state: a real
background worker started by `bootArgusCore()` queried that symbol's `1Day` bars with zero rows
present (seeding had not run yet), and `HistoricalDataGateway`'s 60-second in-memory cache
(`memoryKey()` buckets by symbol/timeframe/hour, `getBars()`'s own `cacheSet()`) cached that EMPTY
result for 60 real seconds. Because this harness runs at up to 400x speed, an entire session's worth
of `QuantSignalAgent` cycles completed inside that same 60-second real-wall-clock window, so a cache
entry poisoned even once near boot stayed poisoned for the practical duration of the session. The
fix is ordering, not a cache workaround: the daily-bar seeding loop now runs BEFORE `bootArgusCore()`
(right after the isolated `settings` row insert), so nothing can query these symbols before real
synthetic rows already exist — no empty result is ever cached in the first place. See
`SyntheticSessionEngine.ts`'s own comment at the seeding call site for the full account.

### Architecture protection

`src/server/replay/synthetic/SyntheticDailyBarProvider.architectureBoundary.test.ts` (7 tests, same
grep-based pattern as `architecture.protection.test.ts`): no file outside
`src/server/replay/synthetic/` (including `scripts/`) imports this module; both exported functions
throw when `SYNTHETIC_SIMULATION !== 'true'`; determinism (same seed → byte-identical history);
regime-direction correctness (bull-dominant scenario → net-positive prior history, bear-dominant →
net-negative).

### Residual, honestly-disclosed limitations of the provider itself

- **Weekday-only, not NYSE-holiday-aware.** Documented in the module header; irrelevant to the gating
  this module exists to satisfy (the gateway's `SYNTHETIC_SIMULATION` branch only checks
  `existing.length > 0`, never a specific calendar shape), but a real simplification worth naming.
- **Benchmark-only symbols (`IWM`, sector ETFs like `XLK`) are not seeded.** `MarketContext.ts`'s
  `getMarketContext()` always queries `BENCHMARK_SYMBOLS.smallCap` (`IWM`) and a sector ETF for every
  symbol's evaluation, regardless of whether that benchmark symbol is itself in the session's traded
  universe. Those calls are internally try/caught (`benchmarkTrend()`) and degrade to `regime: null`
  — they never propagate into `evaluateSymbol()`'s own uncaught path the way the primary-symbol fetch
  does, so they do not block a CORE strategy from evaluating. But they do still log a real (harmless)
  `HistoricalDataGateway refuses...` line for `IWM`/`XLK` each cycle. Not fixed this pass (out of
  scope for the required 5-symbol Strategy Certification Matrix); a real candidate for a future pass
  if benchmark-trend fidelity ever matters for a specific finding.
- **Daily drift magnitude is a fixed constant tuned for a visible SMA stack over ~260 days, not a
  scenario-specific tuning target.** This produced a real, usable trending history for
  `PULLBACK_CONTINUATION`/`MEAN_REVERSION`/`RANGE_REVERSION` (see the re-run result doc) but was not
  strong enough, relative to the daily volatility the Brownian scaling implies, for
  `RegimeEngine.classifyRegime()`'s own trend-strength bar to register `MOMENTUM_BREAKOUT` or
  `TREND_FOLLOWING`'s `triggerMet` in any scenario/seed tried this pass. See the result doc's own
  honest accounting of this — it is a fixture-strength limitation, not a strategy bug, and it was
  not forced by weakening `RegimeEngine` or either strategy's real trigger condition.

## 5. Future replay-lab integration note

The task explicitly scopes the historical point-in-time replay lab out of this pass. One real
integration point was noticed while reading this code and is worth recording for whoever picks
that project up: `src/server/replay/HistoricalDataProviderRegistry.ts` already implements the
provider-registry pattern `HistoricalDataGateway` needs a synthetic counterpart for (§4 above) —
when a future daily-bar synthetic provider is built, registering it through that same registry
(rather than a new ad hoc lookup) would keep a single authoritative provider-selection path for
both the historical-replay lab and this synthetic harness.
