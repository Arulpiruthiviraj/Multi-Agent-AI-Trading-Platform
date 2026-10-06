# Argus Synthetic Certification — Follow-Up Run Result (2026-10-06, same day)

**Builds on, does not overwrite, `ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md` (the same-day earlier
pass).** That doc's §4 finding — none of the 5 CORE quant strategies could be exercised because
`HistoricalDataGateway` correctly refused a real network fetch for `1Day` bars during a synthetic
session, and no synthetic substitute existed — is this pass's starting point. The earlier doc's own
honest `FAIL`/`NOT_CERTIFIED` verdict and its full run log remain the accurate historical record of
that pass; nothing here retroactively changes what that pass found. This doc is the real re-run
after the gap it identified was closed (`SyntheticDailyBarProvider.ts`, design in
`docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md` §4a).

**Git HEAD at run time:** the same-day earlier pass's commit (`fix: stop postMarketAnalysisWorker
real-network leak into synthetic sessions`), plus this pass's own additions:
`SyntheticDailyBarProvider.ts`, `SyntheticDailyBarProvider.architectureBoundary.test.ts`,
`SyntheticSessionEngine.ts` (seeding wiring).

**Isolation:** every run below used the harness's own isolated temp-dir SQLite DB (never
`data/argus.db`), `ARGUS_ACTIVE_BROKER=internal_paper`, `PAPER_TRADING_ONLY`/`LIVE_NO_GO` unchanged.
Verified directly against each run's own isolated DB file (via a read-only query, not log-trust
alone) that `ohlcv_bars` only ever gained `source IN ('synthetic_simulation', 'synthetic_simulation_daily')`
rows — no `'alpaca'`/`'ibkr'` real-fetch rows. Seed used throughout: **20261006**. Speed multiplier:
**400x**.

## 1. Runs executed

| # | Scenario | Duration | Wall-clock | Result |
|---|---|---|---|---|
| 1 | TRENDING_BULL_GAP_AND_GO | 90 min | ~85s (first attempt, before the ordering fix) / ~80s (after) | 0 `Failed to evaluate` after the ordering fix (12 before it, all QQQ — see §3) |
| 2 | SIDEWAYS | 90 min | ~75s | 0 `Failed to evaluate`; 1 real BUY fill (SPY, KronosEngine+TechnicalAgent, never closed) |
| 3 | TRENDING_BEAR | 90 min | ~75s | 0 `Failed to evaluate`; 0 fills |
| 4 | EXTREME_NOISE | 90 min | ~75s | 0 `Failed to evaluate` for any of the 5 seeded symbols; 18 `Failed to evaluate IWM` — see §4 (benchmark-only symbol, not in scope) |
| 5 | QUIET_OPEN | 90 min | ~75s | 0 `Failed to evaluate`; 0 fills (correct negative control) |
| 6 | CERTIFIED_BULLISH_ENTRY_EXIT | 400 min, `--seed-calibration` | 146.9s | 0 `Failed to evaluate`; 1 real BUY fill (NVDA, KronosEngine+TechnicalAgent); 4 more ideas reached `CHIEF_APPROVED_IDEA` but were correctly rejected by real RiskEngine gates (see §5) |

`VALIDATED_CONVERGENCE_CONTROL` was not re-run this pass (already covered for the non-QuantEngine
spine in the earlier same-day doc; time was spent instead on verifying the new daily-bar provider
across the 5 remaining scenario/strategy pairings, which was this pass's actual mandate).

## 2. Strategy Certification Matrix (Section 14) — re-run after the gap closure

Counts below are from each run's own isolated DB (`quant_assessments.strategy_evaluations`, parsed
directly — not a log-grep estimate) and cross-checked against the written `ohlcv_bars` rows for the
same DB, confirming a real `1Day` cache (`c=261` rows per symbol: 260 synthetic prior days +
1 today-rollup bar, verified for all 5 universe symbols identically before relying on any downstream
count).

| STRATEGY | REACHABLE NOW | TRIGGERED (any run) | TRIGGERED IN | IDEA GENERATED FROM IT | CONSENSUS | RISK | ORDER | FILL | EXIT | VERDICT |
|---|---|---|---|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | **YES** (real evaluation every cycle, every symbol, every scenario) | **NO** — `triggerMet` false in all 6 runs (0/91, 0/91, 0/91, 0/90, 0/91, 0/406) | n/a | n/a (never cleared trigger, so never became the best-of-5-CORE pick) | n/a | n/a | n/a | n/a | n/a | **REACHABLE, NOT TRIGGERED** — see §6 |
| PULLBACK_CONTINUATION | **YES** | **YES** | TRENDING_BEAR (18/91), CERTIFIED_BULLISH_ENTRY_EXIT (81/406) | n/a — never the ensemble's `bestStrategyIdea()` pick in these runs (Quant's own live-emit gate, see §6, never cleared for ANY strategy in any run) | n/a | n/a | n/a | n/a | n/a | **TRIGGERS WITH REAL EVIDENCE, NOT YET A LIVE EMISSION** |
| MEAN_REVERSION | **YES** | **YES** | TRENDING_BEAR (18/91) | n/a (same gate as above) | n/a | n/a | n/a | n/a | n/a | **TRIGGERS WITH REAL EVIDENCE, NOT YET A LIVE EMISSION** |
| TREND_FOLLOWING | **YES** | **NO** — `triggerMet` false in all 6 runs | n/a | n/a | n/a | n/a | n/a | n/a | n/a | **REACHABLE, NOT TRIGGERED** — see §6 |
| RANGE_REVERSION | **YES** | **YES** | ALL 6 runs (73/91, 91/91, 91/91, high in EXTREME_NOISE, 91/91, 372/406) | n/a (same gate) | n/a | n/a | n/a | n/a | n/a | **TRIGGERS WITH REAL EVIDENCE, NOT YET A LIVE EMISSION** |
| (negative control) | — | — | QUIET_OPEN: 0 fills, real `NO_CONSENSUS`/no-quant-emit reasons throughout | — | 0 approved from Quant | n/a | 0 | 0 | n/a | **PASS** (correct no-trade) |

**What changed from the prior same-day doc's matrix:** every row moved from `NOT_EVALUATED` (the
harness could not reach `StrategyEngine.evaluateAll()` at all) to a REAL result — either a
genuine, repeatedly-observed `triggerMet: true` with real conditions/scores recorded in
`quant_assessments`, or a genuine, repeatedly-observed `triggerMet: false` across every scenario and
seed tried. Both are real findings now; neither is `NOT_EVALUATED` anymore. This pass did not lower
any threshold, gate, or trigger condition to produce this change — see §6 for why
`MOMENTUM_BREAKOUT`/`TREND_FOLLOWING` still did not trigger, and §7 for why a triggered strategy
still never reached a live `TRADE_IDEA_GENERATED` from `QuantSignalAgent` itself in any run.

## 3. The ordering bug found and fixed while building the provider

First attempt at the daily-bar seeding (placed after `bootArgusCore()`, matching where the existing
minute-bar generation call already sat) produced a real, reproducible defect: QQQ specifically
failed `ensureBars()`'s `SYNTHETIC_SIMULATION` guard on every cycle of the entire
TRENDING_BULL_GAP_AND_GO run (12/12 `QuantSignalAgent` cycles), while SPY/AAPL/MSFT/NVDA — seeded
identically, in the same loop — succeeded every time. Confirmed via a temporary debug probe
(`console.error` + a direct `ohlcv_bars` count query, removed before this doc was written) that the
VERY FIRST `ensureBars('QQQ', '1Day', ...)` call in the process saw `rawDbCount=0` — meaning some
real background worker queried QQQ's `1Day` bars before this pass's own seeding had written
anything, and `HistoricalDataGateway`'s 60-second in-memory cache (bucketed by hour, not exact ms)
cached that empty result. Because this harness runs at up to 400x speed, essentially this entire
session's quant activity completed inside that same 60-second real-wall-clock window, so the
poisoned entry never had a chance to expire before the run ended. Fix: move the seeding loop to run
BEFORE `bootArgusCore()` (right after the isolated `settings` row insert) so nothing can query these
symbols before real rows exist — eliminating the possibility of an empty-result cache entry rather
than working around one after the fact. Re-run after the fix: 0 `Failed to evaluate` for any of the
5 seeded symbols across all 6 scenarios. See the design doc §4a for the full account and
`SyntheticSessionEngine.ts`'s own comment at the fixed call site.

## 4. A real, pre-existing, out-of-scope gap this pass did not fix

`EXTREME_NOISE` showed 18 `[QuantSignalAgent] Failed to evaluate IWM` lines. `IWM` is
`BENCHMARK_SYMBOLS.smallCap` (`MarketContext.ts`) and was, at some point in `getActiveSymbols()`'s
own resolution, treated as a PRIMARY symbol for a `QuantSignalAgent` cycle — not merely a benchmark
lookup inside another symbol's `getMarketContext()` call (those are internally try/caught and never
propagate). `IWM` was never part of this pass's 5-symbol seeded universe
(`defaultSyntheticUniverse(5)` = SPY/QQQ/AAPL/MSFT/NVDA), so it has zero synthetic `1Day` history and
correctly fails the same guard the exact same way QQQ did before the ordering fix — except this
failure is real and expected (IWM was never seeded), not a regression. This never blocked any of the
5 CORE-strategy evaluations on any of the 5 REQUIRED universe symbols in any run. Not investigated
further or fixed this pass (how `IWM` entered `getActiveSymbols()` at all was not root-caused) —
recorded here as a known, narrowly-scoped, honestly out-of-scope limitation rather than silently
left unexplained.

## 5. Real RiskEngine gate activity observed in the CERTIFIED_BULLISH_ENTRY_EXIT run

Beyond NVDA's one fill, 4 more ideas (SPY, QQQ, AAPL, MSFT — all KronosEngine+TechnicalAgent
consensus, not QuantEngine) reached `CHIEF_APPROVED_IDEA` and were then correctly rejected by real,
distinct RiskEngine gates — not a bug, not something this pass touched:

- `QQQ`: gate 23 `argus_capital_allocation` — *"Remaining Argus allocation = $93.12; requested
  capital = $2510.50 (allocated $3000.00, already used $2906.88). Broker buying power is
  irrelevant — Argus may not spend the rest of the account."*
- `SPY`, `MSFT`: gate 22 `sell_position_exists` — *"Cannot sell - no existing position in broker
  portfolio."* (a proposed SELL from KronosEngine with nothing open to sell against)

This is real evidence the spine's gates are live and binding in this harness exactly as they would
be in production, independent of whether the idea came from QuantEngine or another agent.

## 6. Why MOMENTUM_BREAKOUT and TREND_FOLLOWING still never triggered — a real, honest finding

Both strategies gate `triggerMet` on `RegimeEngine.classifyRegime()` actually classifying a strong
directional regime (`BULLISH_TREND`/`BEARISH_TREND` with `trendStrength >= minTrendStrength`) from
the daily bar series — `trendFollowing.ts`'s own `triggerMet` is exactly that condition;
`momentumBreakout`'s is structurally similar. `SyntheticDailyBarProvider.ts`'s prior-day history
does carry a real, scenario-direction-matched net drift over its 260 days (confirmed via the
architecture-boundary test: a bull-dominant scenario's oldest close is reliably below its most
recent close, and vice versa for bear), but the daily volatility derived from the Brownian
time-scaling relationship (`baseVolatility * sqrt(390)`) dominates that drift day-to-day by roughly
an order of magnitude — real cumulative trend, but not a smooth enough path for
`RegimeEngine`'s own trend-strength classifier (which looks at a shorter trailing window) to read a
clean, sustained `BULLISH_TREND`/`BEARISH_TREND` read rather than oscillating in and out of
`SIDEWAYS`/`CHOPPY` classifications along the way. This is a FIXTURE tuning limitation of the daily
history's drift-to-volatility ratio, not a bug in `RegimeEngine`, `trendFollowing.ts`, or
`momentumBreakout.ts`, and not something this pass fixed by weakening either strategy's real
condition or `RegimeEngine`'s own classifier — doing so would have violated the task's explicit
no-cheat constraint. A future pass could reasonably try raising `DAILY_DRIFT_MAGNITUDE` or reducing
the volatility scaling specifically for this provider and re-measure — that is a legitimate,
documented fixture-strengthening path (not a weakening of the system under test) left as a named
follow-up rather than attempted under this pass's remaining budget.

## 7. Why a triggered CORE strategy never became a live QuantSignalAgent `TRADE_IDEA_GENERATED`

Every run's dominant `DESK_NO_TRADE` reason for the Quant agent, across all 5 symbols, every
scenario, was identical: *"Quant live emit requires a strategy idea that clears live EV and min R:R.
Regime-only fallback is not a trade."* This fired even in runs where `RANGE_REVERSION`/
`PULLBACK_CONTINUATION`/`MEAN_REVERSION` had real `triggerMet: true` evaluations — meaning
`bestStrategyIdea()`'s own EV/R:R qualification bar (downstream of trigger-gating, intentionally a
separate, stricter check per `quantThresholds.json`) is what's rejecting, not the trigger condition
itself. This is the CORRECT, fail-closed behavior CLAUDE.md describes ("a correct NO TRADE is a
valid result") — this pass did not lower the EV/R:R bar to force an emission. It does mean no run
this pass produced a `QuantSignalAgent`-sourced `TRADE_IDEA_GENERATED`, so the CORE strategies'
real, now-demonstrated trigger-reachability has not yet been followed all the way through to a
QuantEngine-attributed fill in this harness. Every fill observed this pass (SIDEWAYS/SPY,
CERTIFIED_BULLISH_ENTRY_EXIT/NVDA) came from TechnicalAgent+KronosEngine consensus, consistent with
every prior pass's own finding.

## 8. Items from the task's "remaining unfinished pieces" list — status

- **Dedicated consensus negative-control fixture (correlated-evidence collapse):** NOT built this
  pass. The real mechanism (*"structurally-correlated producers (e.g. QuantEngine + JavaCoreEnsemble)
  count once"*) was again observed organically in rejected SELL ideas this pass (e.g. AAPL/NVDA in
  the SIDEWAYS run, both rejected for exactly one independent evidence group), consistent with every
  prior pass, but still not isolated into its own purpose-built fixture. This pass's time went to the
  daily-bar provider (the task's explicit top priority) instead.
- **A complete round trip (BUY → held → real exit → SELL → flat → realized P&L):** NOT observed this
  pass either. SIDEWAYS (90 min) and CERTIFIED_BULLISH_ENTRY_EXIT (400 min, its own full designed
  length) both produced exactly one BUY fill each that never closed before session end. Every
  observed SELL proposal in these runs came from a single agent (KronosEngine) and was correctly
  rejected for lacking a second independent voice — the same structural reason no close has been
  observed in any pass to date. A longer duration was not attempted beyond CERTIFIED_BULLISH_ENTRY_EXIT's
  own full 400-minute length (already the longest scenario defined).

## 9. Final verdict

```
SYNTHETIC_PIPELINE_CERTIFICATION = PASS (partial scope: daily-bar gap closed, CORE strategies real-trigger-reachable)
FULL_PIPELINE_TRADE_CAPABILITY = NOT_CERTIFIED
```

**Scoped honestly, same discipline as the prior same-day doc:** the specific, required gap — that
the 5 CORE quant strategies could not be reached by the harness at all — is now closed, with real,
repeated, cross-scenario evidence (`triggerMet: true`/`false` recorded faithfully per strategy per
cycle, not fabricated or forced). 3 of 5 CORE strategies (`RANGE_REVERSION`, `PULLBACK_CONTINUATION`,
`MEAN_REVERSION`) demonstrably trigger with real conditions in at least one scenario; 2
(`MOMENTUM_BREAKOUT`, `TREND_FOLLOWING`) demonstrably evaluate every cycle but never cleared their
own real trigger condition in any scenario/seed tried, a fixture-strength limitation named honestly
in §6, not a weakened system. `FULL_PIPELINE_TRADE_CAPABILITY` remains `NOT_CERTIFIED` because no run
this pass produced a QuantEngine-sourced live idea (§7, the EV/R:R qualification bar, itself a
correct fail-closed gate) or a complete round trip (§8) — both real, separate, honestly-reported
gaps, neither of them the daily-bar gap this pass was asked to close.
