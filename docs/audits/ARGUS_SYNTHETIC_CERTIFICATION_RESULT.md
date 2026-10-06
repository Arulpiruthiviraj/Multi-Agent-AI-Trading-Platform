# Argus Synthetic Certification — Run Result (2026-10-06)

**Git HEAD at run time:** `d7e481e` (+ this pass's two fixes: `SyntheticSessionEngine.ts`,
`SystemBootstrap.ts`, `package.json` — see
`docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md` §3 for the diff rationale).
**Isolation:** every run below used the existing harness's own isolated temp-dir SQLite DB
(`argus_synthetic_sim_sim_<SCENARIO>_<SEED>_<ts>.db` under the OS temp dir — never
`data/argus.db`), `ARGUS_ACTIVE_BROKER=internal_paper`, `PAPER_TRADING_ONLY`/`LIVE_NO_GO` unchanged.
No real broker adapter was instantiated (checked: zero Alpaca/IBKR adapter construction log lines
in any run). Seed used throughout: **20261006**. Speed multiplier: **400x** (real-time-accelerated
`SyntheticMarketClock`, not a backtest replay).

**This is an honest, partial result, not a clean certification.** The real, most important finding
is in §3 below and it is a limitation, not a pass.

## 1. Runs executed

| # | Command | Scenario | Duration | Wall-clock | Result |
|---|---|---|---|---|---|
| 1 | `sim:market-open --certify` (Test A) | `QUIET_OPEN` | 90 min (default) | 42.0s | PASS (no trade, correctly `NO_CONSENSUS`) |
| 2 | `sim:market-open --certify` (Test B) | `VALIDATED_CONVERGENCE_CONTROL` | 240 min | 40.1s | FAIL — opened a position (BUY AAPL, 2 fills), never closed (scenario has no reversal phase) |
| 3 | `--scenario=QUIET_OPEN` | QUIET_OPEN | 90 min | 31.7–42s | 0 fills (37 ideas, 24 `DESK_NO_TRADE`) |
| 4 | `--scenario=EXTREME_NOISE` | EXTREME_NOISE | 90 min | ~40s | 0 fills (37 ideas, 24 `DESK_NO_TRADE`) |
| 5 | `--scenario=SIDEWAYS` | SIDEWAYS | 90 min | ~40s | 0 fills (43 ideas, 24 `DESK_NO_TRADE`) |
| 6 | `--scenario=TRENDING_BULL_GAP_AND_GO` | TRENDING_BULL_GAP_AND_GO | 90 min | ~40s | 0 fills (37 ideas, 27 `DESK_NO_TRADE`) |
| 7 | `--scenario=TRENDING_BEAR` | TRENDING_BEAR | 90 min | ~40s | 0 fills (43 ideas, 21 `DESK_NO_TRADE`) |
| 8 | `--scenario=CERTIFIED_BULLISH_ENTRY_EXIT` | CERTIFIED_BULLISH_ENTRY_EXIT | 90 min (duration flag omitted — my own setup error, not a harness defect) | 43.7s | 0 fills (session ended before the scenario's own engineered entry point, ~min 239) |
| 9 | `--scenario=CERTIFIED_BULLISH_ENTRY_EXIT --duration=400 --seed-calibration` | CERTIFIED_BULLISH_ENTRY_EXIT | 400 min (full scenario) | 60.0s | **1 real BUY fill (QQQ, 17:29 sim-time)** via TechnicalAgent+KronosEngine consensus → RiskEngine approval → `ORDER_SUBMITTED` → `ORDER_FILLED` → `ORDER_EXECUTED`. Position never closed before session end (~20:09). |

Run 8's zero-fill result is not evidence against the scenario — I omitted `--duration=400` on the
first attempt, so the session ended at minute 90, before the scenario's own documented entry point
(~minute 239). Run 9, with the correct duration and calibration seeding the scenario's own header
comments say it needs, is the real result for this scenario.

## 2. Strategy Certification Matrix (Section 14)

| STRATEGY | POSITIVE FIXTURE | EXPECTED TRIGGER | ACTUAL TRIGGER | IDEA GENERATED | CONSENSUS | RISK | ORDER | FILL | EXIT | PASS/FAIL |
|---|---|---|---|---|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | TRENDING_BULL_GAP_AND_GO / VALIDATED_CONVERGENCE_CONTROL (gap+volume-pop, designed for it) | true | **NOT EVALUATED** | n/a (QuantEngine) | n/a | n/a | n/a | n/a | n/a | **NOT_CERTIFIED** — see §3 |
| PULLBACK_CONTINUATION | CERTIFIED_BULLISH_ENTRY_EXIT Phase C1 (engineered pullback-in-uptrend) | true | **NOT EVALUATED** | n/a | n/a | n/a | n/a | n/a | n/a | **NOT_CERTIFIED** — see §3 |
| MEAN_REVERSION | SIDEWAYS / CERTIFIED_BULLISH_ENTRY_EXIT (RSI extremes observed: 8.47–94.47 across runs) | true | **NOT EVALUATED** | n/a | n/a | n/a | n/a | n/a | n/a | **NOT_CERTIFIED** — see §3 |
| TREND_FOLLOWING | CERTIFIED_BULLISH_ENTRY_EXIT Phase E (long, volume-confirmed uptrend) | true | **NOT EVALUATED** | n/a | n/a | n/a | n/a | n/a | n/a | **NOT_CERTIFIED** — see §3 |
| RANGE_REVERSION | SIDEWAYS (oscillating boundary touches) | true | **NOT EVALUATED** | n/a | n/a | n/a | n/a | n/a | n/a | **NOT_CERTIFIED** — see §3 |
| (negative control) | QUIET_OPEN | false | false | 37 | 0 approved | n/a | 0 | 0 | n/a | **PASS** (correct no-trade) |
| (negative control) | EXTREME_NOISE | false | false | 37 | 0 approved | n/a | 0 | 0 | n/a | **PASS** (correct no-trade) |

**Every "NOT_EVALUATED" row has the identical, verified root cause** (not five separate failures):
`QuantSignalAgent` — the only real production code path that calls `StrategyEngine.evaluateAll()`,
which is what actually runs the 5 CORE strategies — fails closed on every symbol, every scenario,
every run this pass tried, with:

```
[QuantSignalAgent] Failed to evaluate <SYMBOL> HistoricalDataGateway refuses a real network fetch
for <SYMBOL> (1Day) during a synthetic simulation session (SYNTHETIC_SIMULATION=true) - no real
Alpaca/IBKR historical-bar call is made.
```

Counted directly from the logs: **86 occurrences** in each 90-minute run, **211** in the Test A/B
certify pair, **317** in the 400-minute run — i.e. it is the agent's steady-state behavior for
this harness, not an intermittent flake. Zero `QuantSignalAgent` idea or `QUANT_ASSESSMENT_COMPLETED`
success was observed in any run. Every idea/fill actually observed this pass came from
`TechnicalAgent` (deterministic RSI/MACD/Bollinger) or `KronosEngine` (Chronos forecast) — never
from `QuantEngine`.

This is a real, verified, structural gap in the harness (no synthetic daily-bar provider exists
for `QuantSignalAgent` to use instead of a real network call), not a RiskEngine/consensus rejection
and not a scenario-design problem. **I did not lower any threshold, remove the
`HistoricalDataGateway` network guard, or fabricate a daily bar to force a trigger** — doing any of
those would have violated the task's own Section 6 ("do not cheat") and Section 44 constraints.
See the design doc §4 for the full mechanism and why this pass did not attempt the fix live.

## 3. What this does and does not certify

**Certified (real, demonstrated this pass):**
- The harness boots real `ChiefTraderAgent`, real `RiskEngine` (all 25 gates recorded), real OMS,
  real `InternalPaperBroker`/`HistoricalReplayBroker`, real fill ledger, against synthetic market
  data delivered through the normal ingestion path — no decision injection anywhere in the path
  (verified by reading the code, not inferred).
- A genuine BUY idea (TechnicalAgent + KronosEngine, 2 independent agents, 75% confidence) legitimately
  cleared consensus, cleared RiskEngine, was submitted, and filled (run #9, QQQ). This proves the
  non-QuantEngine portion of the live decision spine is operationally capable end-to-end in this
  harness, consistent with the many prior audits already on file.
- Test A's negative control (QUIET_OPEN) correctly produced zero trades, with a real, legible
  `NO_CONSENSUS` reason — not silence, and not a fabricated pass.
- A real defect (§3.1 of the design doc): a real-network call leaking into the offline harness from
  `postMarketAnalysisWorker` — found, root-caused, and fixed this pass, with before/after evidence
  (3 real HTTP attempts per run → 0).

**NOT certified by this pass:**
- **None of the 5 CORE quant strategies were exercised at all.** The Strategy Certification Matrix
  this task required cannot currently be completed — not because the strategies were tried and
  rejected, but because the harness cannot reach them (see §2). This is the task's central ask and
  it is the piece that is NOT done.
- No complete round trip (BUY → held → exit → realized P&L) was observed this pass. Run #2's
  position never closed (scenario has no reversal phase, a known, already-documented limitation).
  Run #9's position never closed either (a new finding — `CERTIFIED_BULLISH_ENTRY_EXIT`'s own
  Phase F reversal did not produce an exit within the remaining session time on this seed). The
  task's §22-23 minimum (20 orders / 10 round trips) was not attempted at scale given the §3.1/§2
  findings above take priority as the real blocking issues to report honestly rather than running
  many more seeds against a harness known not to reach the CORE strategies.
- Consensus negative control with multiple correlated copies of the same factor (§18-19's second
  half) was not separately constructed this pass; the existing `DESK_NO_TRADE`
  "`structurally-correlated producers... count once`" message observed organically in run #9
  (QuantEngine + JavaCoreEnsemble correlation-collapse) is suggestive real evidence this already
  works, but it was not isolated into its own dedicated fixture this pass.

## 4. Why this pass did not attempt to force a cleaner result

Per the task's own Section 6 and the engineering standard in `CLAUDE.md` ("fail closed... a
correct NO TRADE is a valid result"), the only acceptable responses to §2's finding were: (a) build
a real synthetic daily-bar provider (scoped, nontrivial, judged too large to improvise safely in
this same pass — see design doc §4), or (b) report the gap honestly. Fabricating a daily bar,
disabling the `HistoricalDataGateway` guard, or claiming a strategy "triggered" by calling
`strategy.evaluate()` directly (explicitly forbidden by Section 6) were all rejected.

## 5. Final verdict

```
SYNTHETIC_PIPELINE_CERTIFICATION = FAIL
FULL_PIPELINE_TRADE_CAPABILITY = NOT_CERTIFIED
```

**Scoped honestly:** the non-QuantEngine decision spine (TechnicalAgent/KronosEngine →
ChiefTrader → RiskEngine → OMS → broker → fill) is demonstrably operationally capable in this
harness (run #9). The specific, required proof — that the 5 CORE quant strategies can be
discovered, evaluated, triggered, and traded through this same real pipeline — is **not
established**, because the harness cannot currently reach `StrategyEngine.evaluateAll()` with
real data during a synthetic session. That gap, not a strategy failure and not a consensus/risk
rejection, is why the overall verdict is FAIL/NOT_CERTIFIED rather than a qualified PASS.
