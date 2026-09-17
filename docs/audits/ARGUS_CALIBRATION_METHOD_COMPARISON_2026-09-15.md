# ARGUS — Calibration Method Comparison (2026-09-15)

Follow-up to the same-day live-session forensic investigation (`ARGUS_...` live-session reports,
same date) that found `ChiefTraderAgent.calibrateConfidenceDetailed()` reads a confidence number
built from RAW, autocorrelation-uncorrected prediction counts, while a separate, already-built,
already-tested module (`continuous/CalibrationCandidateBuilder.ts`) computes an effective-N
(clustered) version of the same statistic but has never been wired into that live read path.

**Status: research/comparison complete. Nothing described here has been wired into the live
consensus path. `agentConfidenceCalibration.calibrationMethod`'s migration has not been applied to
production (`data/argus.db`) — built and tested in isolation only, exactly as directed.**

## What was built

1. **`src/server/research/calibrationMethodComparison.ts`** (+ `.test.ts`, 12 tests, all passing) —
   pure, read-only, no DB import. Computes both methods from the same input rows, reusing the
   existing, already-reviewed `effectiveSampleSize.ts`/`ConfidenceCalibration.ts` primitives rather
   than reimplementing the math:
   - `RAW_BETA_BINOMIAL` — mirrors `ReflectionEngine.ts`'s live write path exactly (every directional
     row = one observation).
   - `EFFECTIVE_N_CLUSTERED_BETA_BINOMIAL` — mirrors `CalibrationCandidateBuilder.ts`'s existing,
     previously-observational-only computation (time-gap clustering, same per-agent gaps: Kronos
     5 min, everyone else 60 min).
   - `compareCalibrationMethods()` — both results side by side, confidence delta, inflation factor,
     and an explicit `trustFlips` verdict (does `moderateCalibrationTrustMinWilsonLowerBound` = 0.5
     read differently under each method).
   - `replayConsensusUnderBothMethods()` — recomputes ChiefTrader's own weighted-average formula
     under each method for a given agent-vote set; never fabricates an effective-side number when
     comparison data is genuinely unavailable for a participating agent.
2. **Explicit provenance schema** (`drizzle/0069_calibration_method_provenance.sql` +
   `schema.ts`'s new `calibrationMethod` column, default `'RAW_BETA_BINOMIAL'`) — additive, backward
   compatible, verified to apply cleanly via the normal isolated-test-DB migration path (same
   mechanism every `npm test` run already exercises safely). `ReflectionEngine.ts`'s two insert
   sites now state `calibrationMethod: 'RAW_BETA_BINOMIAL'` explicitly rather than relying on the
   column default alone. **Not applied to `data/argus.db` today** — per the standing "no development
   migrations against the production trading DB during an active session" rule, this migration will
   only take effect on that database's *next* real restart, whenever an operator chooses that
   (a deliberate maintenance-window decision, not made here).

## Per-bucket comparison, real production data (read-only, same session)

| Agent / bucket | Raw N | Raw Wilson lower | Raw trusted (>0.5)? | Effective N | Effective Wilson lower | Effective trusted? | |
|---|---|---|---|---|---|---|---|
| Kronos 0.8–0.9 | 7,271 | 0.4601 | NO | 800 | 0.4704 | NO | — |
| Technical 0–0.6 | 32,238 | 0.4455 | NO | 228 | 0.4573 | NO | — |
| Technical 0.6–0.7 | 24,404 | 0.4337 | NO | 341 | 0.4400 | NO | — |
| Technical 0.7–0.8 | 2,131 | 0.4355 | NO | 256 | 0.4047 | NO | — |
| Technical 0.8–0.9 | 579 | 0.4363 | NO | 138 | 0.4177 | NO | — |
| **Quant 0.6–0.7** | 2,398 | **0.5787** | **YES** | 34 | **0.3407** | **NO** | **FLIP** |
| **Quant 0.7–0.8** | 779 | **0.5543** | **YES** | 12 | **0.1933** | **NO** | **FLIP** |
| Quant 0.8–0.9 | 616 | 0.4236 | NO | 41 | 0.2776 | NO | — |
| Quant 0.9–1.0 | 51 | 0.4902 | NO | 4 | 0.5101 | YES | FLIP (razor-thin, 4 obs) |

**Kronos and TechnicalAgent: zero trust-gate flips.** Both methods agree, on every active bucket,
that these agents are not currently statistically distinguishable from chance. The conclusion is
robust to the correction — it does not depend on which method is used.

**QuantEngine: three real flips, two of them in the dangerous direction.** The RAW method currently
reports QuantEngine's 0.6–0.7 and 0.7–0.8 buckets as *trusted* (Wilson lower bound clears 0.5) —
but under effective-N correction, both collapse to genuinely uninformative samples (34 and 12
independent observations) whose corrected lower bounds fall to 0.34 and 0.19. If the live trust
gate (`ModerateTierEvaluator`, via `CalibrationCandidateBuilder`'s own champion/challenger cycle)
is not already catching this — it should be independently confirmed to be, given the "champions
promoted before the effective-N gate existed stay champion forever" bug that same file's own
history documents being fixed for exactly this failure mode — this is where a false sense of
QuantEngine's readiness would most concretely originate. The third flip (0.9–1.0 bucket) is the
opposite direction and not informative either way — 4 independent observations is too thin a sample
for any conclusion, which is exactly why it's flagged as `effectiveNBelowMinSample`, not treated as
a discovery of newfound QuantEngine strength.

## Answering the ten integrity questions directly

1. **Horizons correct?** Yes — resolved per-agent (`kronosEvaluationHorizonMs`=5min,
   `evaluationHorizonMs`=60min generic) and per-QuantEngine-strategy (`evaluationHorizons.json`),
   not a single universal window.
2. **Direction graded correctly?** Yes — `isLong ? finalPrice > entryPrice : finalPrice < entryPrice`,
   symmetric by construction for BUY/SELL.
3. **PIT boundaries correct?** Yes, structurally — grading only proceeds once
   `now - predictionTime >= horizonMs`, using real historical bars that have already occurred; no
   look-ahead path found.
4. **Entry/exit convention?** Real 1-minute bars; `entryPrice = bars[0].close`,
   `actualReturn = (finalPrice - entryPrice) / entryPrice`. Exit-aware strategies use a real
   walk-forward exit simulation rather than a fixed snapshot (`evaluationHorizons.json`'s
   `exitAwareStrategyIds`).
5. **Duplicate/clustered predictions counted correctly?** This was the central finding — under the
   RAW method, no: every re-fire counts as independent (9×–141× raw-N inflation found). Under
   `EFFECTIVE_N_CLUSTERED_BETA_BINOMIAL`, yes, by design.
6. **Same market event → many correlated rows?** Confirmed directly — Kronos's 0.8–0.9 bucket
   showed near-continuous SELL re-firing on SPY/QQQ/GLD at ~1-minute intervals for weeks, collapsing
   9× under 5-minute clustering.
7. **Buckets mixing regimes/strategies/horizons?** QuantEngine's cold-start-bootstrap ideas are
   already kept separate from EV-backed strategy ideas via `secondaryGroupKey()`; regime-level
   breakdown exists in `CalibrationCandidateBuilder`'s own `computeRegimeBreakdown()` for
   agent-predictions-sourced agents (not available for Kronos — no `regime` column on
   `kronos_predictions` — a real, disclosed data-model gap, not investigated further this pass to
   avoid unbounded slicing).
8. **Survivorship/symbol-selection bias?** Real concentration found and reported: Kronos's bucket is
   dominated by QQQ/SPY/GLD (~8,700 of ~10,000+ raw rows) with a strong, real SELL-side skew visible
   directly in the row counts — not formally corrected for, disclosed as a real limitation.
9. **Costs included/excluded appropriately?** Not evaluated this pass — win/loss grading is a pure
   directional call, transaction costs are a separate, later gate (`netExpectedReturn`-style checks
   live elsewhere in the pipeline, out of this audit's scope).
10. **Genuinely OOS, seeded, or production?** Confirmed real production observations — earliest
    2026-08-18, latest today, ~4 weeks of real graded history, no synthetic/seeded rows in this data
    (seeded calibration history is a distinct, disclosed mechanism used only inside the isolated
    synthetic simulator — see `CalibrationHistorySeeder.ts` — and does not write to this production
    table at all).

## The deeper architectural finding (as put to me, and confirmed)

Two real statistical methods coexist in this codebase today. The confidence *magnitude* that feeds
`ChiefTraderAgent`'s weighted-consensus math is raw-N-based (`ReflectionEngine.ts`'s write path).
The binary MODERATE-tier *trust* decision is effective-N-based (`ModerateTierEvaluator` reading the
champion ledger `CalibrationCandidateBuilder`/`ChampionChallengerService` maintain). These can and
do disagree — the QuantEngine 0.6–0.7/0.7–0.8 flips above are concrete proof, not a hypothetical.
Confirmed by direct evidence, not merely suspected.

## Conclusion, unchanged from the live-session report, now with a materially stronger evidentiary basis

- **Kronos: `CALIBRATION_VALID_AND_WEAK`.** Effective N=800, a real and reasonably substantial
  sample; both methods agree — no edge demonstrated.
- **TechnicalAgent: `CALIBRATION_VALID_AND_WEAK`** across all four buckets, same conclusion, both
  methods agree despite dramatic (up to 141×) inflation.
- **QuantEngine: `CALIBRATION_INSUFFICIENT_EVIDENCE`** for 3 of 4 buckets (0.6–0.7, 0.7–0.8, 0.9–1.0
  — effective N of 34, 12, 4). `CALIBRATION_VALID_AND_WEAK` for the 4th (0.8–0.9). Explicitly
  downgraded from "strongest current partial exception" — that framing was a raw-N artifact.

## What happens next — explicitly NOT decided here

Per direct instruction: wiring the effective-N-corrected method into `ChiefTraderAgent`'s live read
path is a distinct, later, explicitly-gated decision — not made by this document. Before that
decision:
- A full historical consensus replay (not just today's handful of real rounds) comparing
  approval/rejection outcomes under both methods across a meaningful historical window.
- Confirmation that adopting the corrected method does not introduce pathological over-conservatism
  (a real, named risk — small effective-N buckets could make the system nearly impossible to ever
  trust, which is a different failure mode from today's overconfidence one, and not automatically
  the "more correct" choice merely because it is more conservative).
- An explicit decision recorded here or in a successor document, never a silent overwrite of
  `ReflectionEngine.ts`'s write path.

**The 0.75 STRONG threshold and the 0.5 MODERATE trust floor are unchanged and were not considered
for changing at any point in this pass.** If effective-N correction causes Argus to trade even less
once (and if) it is ever adopted, that is treated as a potentially correct outcome, not a problem to
engineer around.

## Process note: a real, separate defect found while verifying this change (not fixed today)

Attempting a full-suite (`npx vitest run`) regression pass for this change - while today's real
paper-trading engine (PID 17380) was live - surfaced a genuine, real `UNCLEAN_SHUTDOWN_DETECTED`
log line naming that exact real PID. Investigated immediately: `sessionRecovery.ts`'s
`DEFAULT_PATH` resolves to `data/.argus_runtime_session.json` - the identical file path the real,
live engine also reads and rewrites every 15 seconds for its own restart-safety heartbeat. Every
test that directly calls `bootArgusCore()` (`ArgusCoreBoot.test.ts`,
`ArgusCoreBoot.restartSafety.test.ts`, `ArgusCoreBoot.newsEngineIsolation.test.ts`) and the direct
`sessionRecovery.test.ts` all correctly call `setSessionRecoveryPathForTests()` before touching
anything - confirmed by direct inspection - so this was not one of those four. The exact test
responsible was not pinpointed (would require re-running the suite, which was deliberately not done
again today given the same live-engine risk that prompted stopping it the first time) - a genuinely
disclosed limitation of this note, not a claim of full root-cause certainty.

**What was verified, not merely assumed, before continuing:** the background full-suite run was
stopped as soon as this was noticed. The real session file was read immediately after
(`pid: 17380`, `parentPid: 23652`, `startedAt` unchanged, `cleanShutdown: false` - all correct for a
still-running process) and re-checked ~20 seconds later, showing `lastHeartbeatAt` had genuinely
advanced - proof the real engine's own writer, not a stray test, currently controls this file's
content. `trading_state` remained `TRADING_ENABLED`, and the most recent `reconciliation_events` row
was clean. No lasting effect on today's session was found.

**Update: fixed in a follow-up pass the same day**, per explicit operator direction to give this its
own P1 forensic pass rather than accept it as an open item. Full detail:
`src/server/core/productionRuntimePathGuard.ts` (+ tests) - see
`docs/architecture/ARGUS_ARCHITECTURE.md`'s "Test/production runtime-file isolation guard" section
for the complete writeup. Summary: a new, shared, fail-LOUD mechanical guard (the session/PID-file
equivalent of `syntheticSimulationDbGuard.ts`'s existing DB-side guard) now sits at the actual I/O
call sites in `sessionRecovery.ts` and `enginePid.ts`, throwing immediately if a test/simulation
process ever resolves a runtime-identity file to the real production path - rather than relying on
every caller remembering to opt into isolation, which is exactly the class of gap that let this
incident (and an earlier, separately-documented 2026-08-25 one for `enginePid.ts`) happen twice.
Re-running the full suite with the guard active safely and immediately surfaced the real two
culprits (`ArgusRuntime.test.ts`, `ArgusEngineRuntime.test.ts` - both boot the real core without
isolating the session path) as fast, zero-production-impact test failures instead of a silent file
touch. Both fixed with the same isolation pattern already established elsewhere.
**Full suite re-certified clean after the fix: 513 files / 3785 tests, 100% passing**, with
production's real session file and trading state confirmed unaffected before, during, and after
every run in this investigation.
