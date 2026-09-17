# ARGUS — Remediation Closure Report (2026-09-15)

Follow-up to `ARGUS_COMPLETE_IMPLEMENTATION_AUDIT_2026-09-14.md`, closing the two critical findings
from that audit's cross-examination plus the timer sweep, calibration provenance, and a real Test B
scenario-quality fix. All work verified by direct code inspection, real regression tests, and a live
full-suite run — nothing below is asserted without evidence.

## Formal disposition (operator acceptance, 2026-09-15)

**PASS — safety/remediation scope.** Accepted by the operator with the following characterization,
preserved verbatim as the authoritative closing note for this pass: *"The important result is not
that Argus now trades. It is that the system has become substantially harder to fool, crash, or
accidentally bypass."* The remaining Test B failure is intentionally left unresolved — it is
evidence that the current contemporaneous-consensus architecture may not match the temporal behavior
of the underlying strategy families, not a defect to engineer around. Given no validated alpha has
been demonstrated, changing consensus to manufacture convergence would be premature and potentially
dangerous, and was not attempted.

**What Argus is, as of this pass**: a hardened autonomous quantitative research and paper-trading
platform with a real event-driven trading pipeline, strong safety controls, deterministic synthetic
certification infrastructure, and extensive forensic instrumentation — but without demonstrated
alpha or validated portfolio/capital-allocation capability. A meaningful milestone, not a finished
system.

**What the simulator is and is not** (operator's own qualification, preserved): the synthetic
market-open framework (synthetic clock, deterministic seeded market data, synthetic scenarios,
synthetic news, decision-timeline provenance, synthetic certification, production-DB isolation, a
real no-live-order safety boundary, and the real Argus event-driven pipeline for the portions
currently wired) is genuinely usable today to run repeatable "what does Argus do when a synthetic
market opens" experiments — change code → run a deterministic synthetic open → inspect behavior →
run certification → run full tests — without waiting for a real market open. It is **not** yet the
complete exchange-grade, multi-phase, full-microstructure simulator the original mandate described:
only a subset of the planned scenarios exists, the detailed multi-phase market day was not fully
implemented, some agents/data sources are not represented in the synthetic environment, and the
synthetic broker is not yet equivalent to a complete market microstructure simulator. A successful
synthetic trade would not by itself prove alpha — synthetic data can prove the engineering pipeline
behaves correctly under a designed scenario; only real historical/OOS evidence can establish whether
a strategy has genuine edge.

**Recommended next phase** (strategic direction, not started this pass): canonical data/PIT
correctness → eventization/signal independence → research factory → forecast validation → alpha
discovery → portfolio construction → capital allocation → execution attribution → model
governance/drift detection. The central open question is whether Argus can discover an economically
meaningful, statistically defensible edge that survives effective-N correction, multiple-testing
controls, OOS validation, transaction costs, and realistic execution — until that answer is yes,
zero organic trades remains an acceptable, expected outcome, and **LIVE_NO_GO stays in force**.

## Continuation pass (same day) — autonomous execution mandate

Three more items closed under the operator's explicit autonomous-execution authorization, in the
operator's own specified dependency order (critical defects → safety → simulator correctness →
certification), before touching anything further out (portfolio construction, etc. remain correctly
deferred per the operator's own "do not rush" instruction):

- **Restart safety, fully composed end-to-end** (closing the exact gap the audit flagged — the
  pause half and the entry-idea-hold half were previously proven correct only in separate test
  files). `ArgusCoreBoot.restartSafety.test.ts` now proves, on the SAME real `bootArgusCore()` call:
  unclean-shutdown detection → `TRADING_PAUSED` (existing) → `allowsNewEntryIdeas()===false`
  (new) → a real `RECONCILIATION_MATCH` event fired through the real EventBus → the entry hold
  releases (new) → `tradingState` remains `TRADING_PAUSED` throughout (new — proves the entry-hold
  release never accidentally resumes trading).
- **`MarketDataWorker.subscribe()`'s IBKR-bridge-failure rollback, previously untested.** This is
  real production logic (not simulator-only) — live-relevant whenever IB Gateway is unreachable
  (the same real scenario DEF-28's reconnect-with-backoff already addresses). 3 new tests confirm
  the rollback is correct, intentional, fail-closed behavior: a failed symbol is never left
  "subscribed" with no real quote source, a later successful retry for the same symbol isn't
  permanently poisoned, and one symbol's failure doesn't affect others.
- **One more principled Test B investigation**, given the scenario volatility fix's own evidence.
  Directly checked whether `TechnicalAgent`'s real early-momentum BUY signal (RSI 65-70, genuinely
  healthy) ever lands in the same `ChiefTrader` debate window as a second independent agent on the
  SAME symbol. Confirmed, with a full timeline trace: it does not, on either seed tried — no
  `CHIEF_CONSENSUS_STARTED` event exists at any of `TechnicalAgent`'s own genuine BUY-crossover
  timestamps for AAPL. The AAPL consensus attempts that DO occur all correspond to LATER, more-
  extended "Overbought" moments (34-43% confidence, single-agent only). This refines, with direct
  evidence rather than speculation, the earlier finding: the blocking issue is not scenario realism
  (now fixed) but a genuine temporal-alignment gap between independently-designed strategy families
  — see `ARGUS_SYNTHETIC_CERTIFICATION_2026-09-15.md` for the full certification run this produced.

Full suite after this continuation: **507 files / 3751 tests passing** (+3 from the items above).
Production DB and live `trading_state` (`TRADING_PAUSED`) re-verified unchanged.

**Single-flight guard, re-audited at the primitive level** (operator-requested re-check): 2 new
tests directly on `createSingleFlightGuard` (not just its `startSingleFlightInterval` wrapper) prove
a thrown `fn()` releases the guard immediately — no permanently stuck in-flight state — and that
concurrent calls during a throwing run still coalesce correctly, with the guard fully recovered for
the next, non-overlapping call. This is the primitive every new intrinsic guard this pass added
(`MarketDataCrossChecker`, `AIProviderHealthCheck`, `CalibrationValidationWorker`) is built on, so
this closes the "no deadlock" property for all of them at once, not per-worker.

**Final tally, typecheck clean, full suite: 507 files / 3753 tests passing.**

## What was fixed this pass, with evidence

### 1. Reconciliation: unknown/failed broker state now pauses trading (was: blind retry)

**Root cause** (`src/server/services/PortfolioReconciliation.ts`): `broker.portfolio()` throwing
(network error, auth failure, outage) was caught, logged, and swallowed - `BrokerManager.syncState`
unconditionally returned to `READY` in `finally`, so the next attempt was an ordinary, un-escalated
5-minute-tick retry. Only a *confirmed, measured* position mismatch ever paused trading.

**Fix**: reuses the exact same consecutive-cycle debounce (`confirmConsecutiveFault`,
`PAUSE_CONSECUTIVE_CYCLES=2`) FD-7 already established for symbol-level mismatches - a sync failure
is treated as at least as serious as any single symbol fault, never less. On the 2nd consecutive
failure: `tradingState -> TRADING_PAUSED` (verified to actually block new orders at RiskEngine's
`emergency_stop` gate), a new `RECONCILIATION_SYNC_FAILED` event (added to `config/eventNames.json`,
both the flat catalog and the `persist` list), and a `reconciliationEvents` audit row
(`actionTaken: 'SYNC_FAILURE_TRADING_PAUSED'`). A single transient failure does not pause (matches
the existing "never pause on a one-off blip" philosophy); a real success clears the fault streak.

**Tests**: `PortfolioReconciliation.syncFailure.test.ts` (3 tests, real isolated DB, real
`RiskEngine.evaluateRisk()` call) - proves: (a) one-off failure deferred, not paused; (b) two
consecutive failures escalate to a real `TRADING_PAUSED` that actually rejects a new BUY at
`emergency_stop`, with a real persisted kill-switch row; (c) a real success clears the streak so a
later, unrelated single failure doesn't inherit it.

### 2. RiskEngine: unbounded `trades` table scan on the live per-evaluation path

**Root cause**: gates 3/4/5 (`same_symbol_cooldown`/`post_loss_cooldown`/`daily_trade_limit`) fetched
the entire `trades` table, unfiltered, on **every single live risk evaluation** - the code's own
prior comment admitted this was deliberately left unfixed when the *replay* branch was bounded.

**Fix, semantics-preserving (not a naive `LIMIT`)**: added `getTradingDayStartMs()`
(`TradingCalendar.ts`, DST-correct via binary search against the already-proven
`getTradingDateStr()`) and bounded the query to `[start of the current real trading day - max(
sameSymbolCooldownMs, postLossCooldownMs), now]` - the true outer bound all three gates need
(`daily_trade_limit`'s "today" is the widest window; the two cooldowns are always inside it except
at the exact exchange-midnight edge, covered by the extra lookback subtraction). The WHERE clause
mirrors `eventMs()`'s own `filledAt`-else-`timestamp` preference exactly (`OR(filledAt IS NOT NULL
AND filledAt >= start, filledAt IS NULL AND timestamp >= start)`) so a trade with an old submission
timestamp but a recent fill is never incorrectly excluded.

**Tests**: `TradingCalendar.test.ts` (+5 tests: EST/EDT boundary correctness, always-at-or-before
input) and `RiskEngine.overtradingQueryBound.test.ts` (5 tests, real isolated DB, real
`RiskEngine.evaluateRisk()`) - proves recent trades still trip each gate, old trades (10 days / 20
hours outside the window) are genuinely excluded by the query (not merely too old to matter -
asserted via `lastFillMs`/`lastLossMs === null`), and the late-fill edge case is handled correctly.

### 3. Three unguarded periodic timers audited; all three genuinely needed a guard

Per-timer analysis (overlap risk / dataset size / CPU work / real consequence of overlap) before
touching anything, per the explicit "don't mechanically add guards" instruction:

| Timer | Real overlap consequence | Guard added |
|---|---|---|
| `MarketDataCrossChecker.runCheck` (60s) | Doubles outbound Questrade REST calls per active symbol on a slow cycle | Yes - intrinsic (`runCheck()` itself, not just the timer, so a future manual trigger is also protected) |
| `AIProviderHealthCheck.tick` (180s) | Doubles a REAL PAID auth+chat-completion API call to every configured provider; races two concurrent read-modify-writes of the same tracker Map entry | Yes - timer only (the separate operator "Test Provider" button, `runAIProviderHealthCheckNow`, is deliberately left un-coalesced - it must run on-demand, not silently skip if a periodic tick happens to be in flight) |
| `CalibrationValidationWorker.runOnce` (900s) | Could create two concurrent shadow versions for the same `versionType` in `learning_versions` | Yes - cheap, defensive, consistent (this worker never touches live-decision-affecting state either way) |

All three use the same reusable, already-proven `createSingleFlightGuard` primitive. New/updated
tests: `MarketDataCrossChecker.test.ts` (+1 coalescing test), `AIProviderHealthCheck.test.ts` (+1,
using `vi.useFakeTimers()` to force a real overlapping timer fire), `CalibrationValidationWorker.test.ts`
(new file, 3 tests).

### 4. Stale heap-snapshot config comment corrected

`config/observability.json`'s `_heapSnapshotComment` claimed baseline-only capture "remains enabled
as a narrowly-scoped exception" - false as of the current code: `scheduleBaselineHeapSnapshot()` is
gated by the exact same `heapSnapshotEnabled=false` flag as elevated capture. Both are currently
disabled, not just the WARNING/CRITICAL path. Comment corrected in place; no code change (the code
was already safe - only the documentation was wrong, in the safer direction).

### 5. Calibration seeding provenance made explicit (operator-requested fields)

`CertificationResult.calibrationProvenance` now reports exactly the requested shape: `seeded`,
`seededObservationCount`, `affectedAgents`, `affectedBuckets`, `productionCalibrationModified`
(hard-coded `false`, true by construction - `CalibrationHistorySeeder.ts` has exactly one caller,
`SyntheticSessionEngine.ts`, itself only reachable from the isolated simulator, re-verified this
pass). The text certification report prints all four fields under the existing seeded-evidence
banner. `CalibrationHistorySeeder.test.ts` extended to assert `seededObservationCount`.

### 6. VALIDATED_CONVERGENCE_CONTROL scenario: a real, previously-undiagnosed structural bug fixed

**Root cause, found by direct evidence, not guessed**: the scenario's trending segment used a
`volatilityMultiplier` (0.65) too low relative to its `driftPerBarMean` - the resulting drift/
volatility ratio made the great majority of bars genuine up-bars, producing a near-monotonic ramp
that pinned RSI at 85-97 ("extreme overbought") for the whole session on **two independently-tried
seeds**. This was not a random fluke - it is a systematic property of the price-path math. Real
agents (`TechnicalAgent`'s own overbought/mean-reversion rule, `JavaCoreEnsemble`'s real
`MEAN_REVERSION_FAMILY` CORE strategies) correctly read an over-extended, monotonic move as more
likely to reverse than continue - exactly the behavior these rules are supposed to produce. This is
why the original certification run converged on a SELL (not a bug in the agents; a bug in the
scenario's own price-path realism).

**Fix**: raised `volatilityMultiplier` to 1.3 for the trending segment (documented in the scenario's
own comment, with the before/after evidence). Confirmed via re-run: `TechnicalAgent` now genuinely
fires real "Strong upward trend detected, MACD bullish crossover" BUY ideas with RSI oscillating in
the healthy 65-70 band (AAPL, QQQ) before later transitioning to overbought - a materially more
realistic session, and the correct general-purpose fix for any future scenario reusing a sustained
trending regime.

**What this fix did NOT achieve**: genuine same-symbol, same-side, 2-independent-agent convergence,
across three configurations tried (original 3-symbol/seed 12345 pre-fix; 3-symbol/seed 12345
post-fix; 1-symbol SPY-only/seed 12345 post-fix). The deeper, now well-evidenced reason: SPY's own
base volatility (0.0006, the lowest in the universe, chosen to be realistic for a broad index ETF)
resists the same fix - even at the raised multiplier, SPY alone still pins RSI 86-92. AAPL/QQQ
(higher base volatility) do NOT exhibit this problem post-fix and produce genuine, healthy BUY
signals - but those signals arrive from `TechnicalAgent` EARLY in the move (RSI 65-70), while
`JavaCoreEnsemble`/`KronosEngine`'s own CORE-strategy and forecast logic tend to fire LATER, once the
same move is more extended - a real, substantive finding about how three independently-designed
strategy families naturally disagree in TIME even when a move is genuinely tradeable, not a scenario
defect to keep patching. **Per the operator's own explicit instruction, no threshold, consensus
requirement, or gate was touched to force these to align.**

## Verification

- `npx tsc --noEmit -p .` clean after every change (checked incrementally, not just once at the end).
- Full suite: **507 files / 3748 tests passing** (up from 503/3727 at the start of this pass - 21 net
  new tests, zero regressions, zero skipped/weakened tests).
- Production `data/argus.db` re-verified untouched after every simulator run this pass (`settings`
  row count = 1, zero `source='synthetic_simulation'` rows).
- Live engine's `trading_state` re-confirmed unchanged (`TRADING_PAUSED`, exactly as the operator
  left it after the earlier P1-B incident - not touched by any of this work).
- Final certification re-run (seed 12345, the scenario's canonical seed, default `--certify` settings):

```
TEST A (no-trade safety):     PASS  (tradeObserved=false, zeroTradeReason=NO_CONSENSUS)
TEST B (tradeable scenario):  FAIL  (firstBlockingStage=CONSENSUS, calibrationSeeded=true,
                                      37 ideas generated, 0 consensus approvals)
OVERALL: FAIL
```

## Final status answers (operator-requested format)

1. **Did you complete every realistically completable item from the two P0/P1 findings?** YES - both
   the reconciliation gap and the RiskEngine unbounded query are fixed, tested, and verified.
2. **Did you discover new defects?** YES - three unguarded timers (fixed), a stale safety-relevant
   config comment (fixed), and the VALIDATED_CONVERGENCE_CONTROL RSI-pinning scenario bug (fixed).
   All listed above with evidence.
3. **Are any safety-critical defects unresolved?** No known unresolved safety-critical defects were
   identified within the audited scope. This is not a claim of absence of undiscovered defects.
   LIVE_NO_GO remains mandatory.
4. **Does the simulator safely exercise the real pipeline?** The simulator's isolation boundaries
   and the portions of the real pipeline exercised by certification were verified. Components not
   exercised by the current certification scenarios are not claimed to be fully validated.
5. **Does Test A pass?** YES.
6. **Does Test B complete the full entry -> fill -> position -> exit -> fill -> P&L lifecycle?** NO -
   still blocked at CONSENSUS for the reason documented above (a real, now well-diagnosed
   cross-agent temporal-disagreement finding, not a pipeline defect and not something forced).
7. **Is validated alpha demonstrated?** NO - unchanged; the effective-sample-size evidence in the
   prior audit still holds and was not re-litigated this pass.
8. **Is portfolio construction implemented?** NO - correctly out of scope for this pass, per the
   operator's own explicit prioritization (safety/correctness first).
9. **Is capital allocation implemented?** PARTIAL - unchanged from the prior audit (flat ceiling,
   not risk-weighted).
10. **Is research/trading isolation complete?** PARTIAL - unchanged (HTTP-route-level, not
    OS-process-level; correctly deferred, a multi-week architecture change).
11. **Is Argus safe for real-money trading?** NO - **LIVE_NO_GO**, unchanged, and this pass did not
    and was not asked to change that.

## Explicitly deferred (per the operator's own "do not rush" instruction), not started this pass

Portfolio construction, capital-allocation risk-weighting, execution algorithms, the remaining
scenario library beyond `VALIDATED_CONVERGENCE_CONTROL`, discrete synthetic market phases,
microstructure, model governance/drift detection, OS-process-level trading/research isolation, the
full machine-readable certification contract (commit hash, per-idea/per-forecast/per-gate detail).
Each remains real, worthwhile, separately-scoped follow-on work - not declared done, not stubbed.
