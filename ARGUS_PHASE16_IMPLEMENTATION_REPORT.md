# ARGUS_PHASE16_IMPLEMENTATION_REPORT.md

Running before/after log for Phase 16 (post-`ARGUS_REAL_MONEY_READINESS.md`). One section per
sub-phase, appended as each completes, per this phase's own "work incrementally, document as you
go" rule. Final scorecard lives in `ARGUS_PHASE16_READINESS_REPORT.md`, written last.

---

## Phase 16A — Forensics on the 135/141 stuck consensus approvals

**Problem.** `ARGUS_PAPER_TRADING_VALIDATION.md` (Phase 10) found 135 real, consensus-approved
transactions permanently stuck in `status: 'OPEN'` with no confirmed root cause. By the time this
phase started, the real count had grown to 141 (more dev sessions ran in between).

**Investigation (real DB queries against `data/argus.db`, no synthetic data).** Joined
`transactions` against `event_traces` and `risk_assessments` for every stuck row. Found:
- All 141 real `CHIEF_APPROVED_IDEA` and `RISK_ASSESSMENT_COMPLETED` event-trace rows exist -
  RiskEngine's gate ladder DID run for every one of them.
- 101 have a real, persisted `risk_assessments` row with `approved: 0` (a genuine rejection) but
  `transactions.status` was never updated away from `OPEN`.
- 37 have no `risk_assessments` row at all (risk was never evaluated - mostly `DIAGTEST*`
  diagnostic-script artifacts plus a handful of real symbols).
- 3 (`DIAGPIPE*`/`DIAGORDER*`/`DIAGCHAIN*`) are known diagnostic-script artifacts, already
  documented as such in `ARGUS_PAPER_TRADING_VALIDATION.md`.

**Root cause, confirmed not guessed.** Every one of the 141 stuck transactions was minted between
2026-08-10 13:36:33 and 2026-08-10 18:07:49. Every transaction minted from 2026-08-10 18:11:41
onward (142 real `RISK_REJECTED` transitions, clean through 2026-08-13) transitioned correctly.
`TransactionRegistry.ts`/`TransactionLifecycleTracker.ts` (the code that performs this status
update) were written to disk at 2026-08-10 13:54-13:55 that same day - **before** the 18:07-18:11
gap (a real process restart). `npm run dev` runs `tsx server.ts` with no watch/hot-reload flag, so
a dev server already running before 13:55 kept executing its stale in-memory module graph -
missing the status-update wiring - until the next restart. This is a stale-process artifact, not
a live logic defect in current code.

**Fix.**
1. New regression test, `src/server/services/RiskAgent.transactionLifecycle.test.ts` - drives the
   *full* real production listener chain (`EventStore` → `RiskAgent` → `RiskEngine` →
   `TransactionLifecycleTracker`, the same set `SystemBootstrap.ts` wires) through a real
   `CHIEF_APPROVED_IDEA` emission and asserts `transactions.status` reaches `RISK_REJECTED`. This
   is stronger than the existing `TransactionLifecycleTracker.test.ts` (which drives the tracker
   in isolation via a synthetic direct emit) - it would catch a real future regression of the
   exact failure class investigated here: `EventBus.emit()` is Node's plain synchronous
   `EventEmitter`, which has no per-listener isolation - if any listener registered ahead of
   `TransactionLifecycleTracker` in this chain ever throws synchronously, every listener
   registered after it (including this one) silently never runs for that event. **Flagged as a
   real, currently-unfixed structural fragility below - not fixed this phase**, since fixing it
   means changing `EventBus.emit()`'s dispatch semantics platform-wide (every event in the
   system), which the "STOP and document before changing anything that could alter live trading
   behavior" rule requires surfacing for an explicit decision rather than unilaterally changing.
2. One-time data reconciliation (user-approved, DB backed up first to
   `data/backups/argus.db.pre-phase16a-backfill-*`): backfilled the 101 real, already-rejected
   rows to `RISK_REJECTED` using the exact same `updateTransactionStatus()` function production
   code already calls, sourced entirely from already-persisted `risk_assessments` ground truth -
   no fabrication, zero effect on trading behavior (bookkeeping/observability only). The 37
   no-risk-row and 3 diagnostic-artifact rows were deliberately left untouched - their real
   resolution is unknowable (37) or already-documented as non-trades (3).

**Verified result.** `transactions.status` distribution in the real DB, before -> after:
`OPEN: 141 -> 40`, `RISK_REJECTED: 142 -> 243`. Full suite re-run clean: 107/107 files, 721/721
tests (was 106/720 before this phase's one new test file).

**Remaining open item, explicitly not fixed this phase:** `EventBus.emit()`'s lack of
per-listener exception isolation is a real structural single point of failure - a future listener
throwing synchronously on `CHIEF_APPROVED_IDEA` or `RISK_ASSESSMENT_COMPLETED` could silently
reproduce this exact class of stuck-transaction bug. Recommended next action (not taken here,
pending an explicit scope decision per this phase's own safety rules): wrap
`EventBus.emit()`'s per-listener dispatch in a try/catch that logs and continues rather than
aborting the remaining listener chain - a platform-wide change touching every event in the
system, correctly out of scope for a same-day unilateral fix.

---

## Phase 16B — Live/backtest parity: the quant-strategy exit mismatch

**Problem** (documented, not yet closed, by `LIVE_BACKTEST_PARITY_SPEC.md` Section 4 from a prior
phase): `runStrategyBacktest()` exits a simulated position using that strategy's own real
`stop`/`target` from `evaluate()`. A real live position opened from the exact same strategy's
signal was instead exited by the generic `PortfolioMonitor.ts` settings-driven percentage
thresholds - the backtest's reported win rate/expectancy for any given strategy never described
what a live position from that strategy would actually do.

**Direction decision (user-confirmed, not unilaterally chosen)** - per the standing "STOP and
document before changing anything that could alter live trading behavior" rule, this was surfaced
as an explicit choice rather than decided in code: (a) make live exits strategy-aware, or (b) make
the backtest use the generic exit instead. User selected (a).

**Implementation** (additive, scoped only to QuantEngine-originated positions):
1. `src/server/db/schema.ts` - `trades` gains `quantStrategyId`/`quantStopPrice`/
   `quantTargetPrice` (all nullable). Migration `drizzle/0024_add_quant_exit_fields.sql`
   (hand-written after `drizzle-kit generate` produced an unrelated, oversized diff touching
   `memory_rules`/`sessions`/`settings`/`users` due to pre-existing non-deterministic
   `Date.now()`-literal schema drift unrelated to this change - discarded that output and wrote
   the 3 `ALTER TABLE ADD COLUMN` statements directly instead, which is all this change needs).
2. `RiskAgent.ts` - `assessRisk()` now forwards `approval.supportingQuantDetail.selectedStrategy`/
   `.proposedStop`/`.proposedTarget` into the request it hands to `RiskEngine`.
3. `RiskEngine.ts` - `evaluateRiskSerialized()` carries those same three fields through
   unconditionally into its `emitRiskAssessment()` call (present on both the approved and
   rejected path, though only ever consumed downstream on approval).
4. `OrderManagement.ts` - `executeOrder()` gained three new optional trailing parameters, written
   onto the `trades` row at insert time (the real decision moment), not re-derived later.
5. `PortfolioMonitor.ts` - `reviewPortfolio()` now looks up the most recent FILLED BUY trade per
   held symbol; when it carries a real stop/target, exits at that absolute price level and skips
   the generic percentage check entirely. No matching trade, or a trade with no quant fields
   (technical/news/fundamental-sourced), falls through to the unchanged generic exit.

**Tests.** `PortfolioMonitor.test.ts` gained a 4-test block: strategy stop fires despite being
inside the generic threshold, strategy target fires despite being inside the generic threshold,
no exit while price sits between the two, and a non-QuantEngine trade correctly falls back to the
generic exit. (Also fixed two unrelated real test-isolation bugs surfaced while adding these: the
file's second `describe` block needed `vi.resetModules()` - Node's module cache was returning the
first block's already-closed DB connection - and `vi.spyOn` on an already-spied
`eventBus.emitTradeIdea` was accumulating call history across tests, needing an explicit
`afterEach(() => vi.restoreAllMocks())`.)

**Verified result.** `LIVE_BACKTEST_PARITY_SPEC.md` Section 4 updated from "real, material
mismatch, not fixed" to "full parity as of Phase 16B." Full suite: 107/107 files, 725/725 tests
(was 721 before this phase's 4 new tests). `npx tsc --noEmit` clean.

**Scope boundary, explicitly preserved:** this change only ever affects a position whose most
recent opening BUY trade carries a real `quantStopPrice`/`quantTargetPrice` - i.e., a trade that
actually originated from a QuantEngine strategy signal with a proposed stop/target. Every other
live trading path (technical/news/fundamental-sourced positions, which is the entirety of live
trading activity today since `QUANT_ENGINE_ENABLED` defaults to `false`) is provably unchanged -
`openingTrade` resolves to a row with null quant fields, and the code falls through to the exact
same generic logic that ran before this phase.

---

## Phase 16M — Restricted live safety ceiling audit

**Method.** Checked each of the 12 requested hard limits against the real code (not filenames) -
whether it's enforced server-side at all, and if so, whether it's a hardcoded constant (immune to
frontend bypass by construction) or a `settings`-table value (frontend-editable, needing the
`RestrictedLiveMode.ts` treatment already built in Phase 13 to stay safe under misconfiguration).

| Limit | Enforced? | Where | Bypassable via frontend settings? |
|---|---|---|---|
| Max order value | Yes | `RestrictedLiveMode.ts` ($5,000, LIVE only) | No - hardcoded ceiling clamps the settings value down |
| Max open positions | Yes | `RestrictedLiveMode.ts` (3, LIVE only) | No - same |
| Max daily loss | Yes | `RestrictedLiveMode.ts` ($1,000, LIVE only) | No - same |
| Max position risk | Yes | `PositionSizing.ts` (`STOP_LOSS_ASSUMPTION_PCT`, flat 5%) | No - hardcoded module constant, not a settings field |
| Max sector exposure | Yes | `PositionSizing.ts` (`MAX_SECTOR_CONCENTRATION_PCT`, 40%) | No - hardcoded module constant |
| Max correlated exposure | Yes | `PositionSizing.ts` (`MAX_CORRELATED_EXPOSURE_PCT`, 50%) | No - hardcoded module constant |
| Max consecutive losses | Yes | `RiskEngine.ts` (`MAX_CONSECUTIVE_LOSSES`, 3) | No - hardcoded module constant |
| Max stale-data age | Yes | `RiskEngine.ts` (`STALE_PRICE_THRESHOLD_MS`, 5 min) | No - hardcoded module constant |
| Max order retry count | Yes | `AlpacaBroker.ts` (`ALPACA_MAX_RETRIES`, 2) | No - hardcoded module constant |
| Max broker failures | Yes | `AlpacaBroker.ts` (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`, 3) | No - hardcoded module constant |
| Max AI failures | **Was NO - now YES** | **New this phase**: `AIFailureCircuitBreaker.ts` | No - hardcoded module constant, LIVE-only |
| Max slippage | **NO - real, documented, not closable this phase** | N/A | N/A |

**Finding 1 (closed): "maximum AI failures" had no real enforcement.** `AI_PROVIDERS_EXHAUSTED`
already existed and `AlertingService` already alerted on it, but nothing ever acted on repeated
exhaustion - every affected agent call would just silently degrade to "no trade idea," indefinitely,
with no protective pause. New `AIFailureCircuitBreaker.ts`: counts `AI_PROVIDERS_EXHAUSTED` events
in a rolling 10-minute window; once 5 occur while real LIVE trading is active, calls the same
`tradingEngine.setTradingState('TRADING_PAUSED', ...)` mechanism Phase 1 already built for
reconciliation mismatches - no new parallel safety system. Deliberately time-windowed rather than a
strict consecutive-call counter: `AIRouter` has no "call succeeded" event today, only DB rows, so a
true consecutive count would need new instrumentation at every success call site across every
agent; a rolling window of failure events needs none and is honest about what it measures. No-op
for paper trading (100% of current real usage). 4 new tests, `AIFailureCircuitBreaker.test.ts`.

**Finding 2 (real gap, explicitly not closed): "maximum slippage" cannot be honestly enforced as a
pre-trade blocking gate with the data Argus actually has live.** `Slippage.ts` is backtest-only -
it simulates cost drag against historical bars, it does not (and structurally cannot) predict a
live market order's real fill price before submission, because Argus has no live bid/ask spread or
order-book data source (confirmed - same root cause as the already-documented "L2 Depth Data
Unavailable" gap in `CLAUDE.md`'s Known Broken/Non-Functional Components). A market order's real
slippage is only knowable AFTER the broker fills it. Building a genuine pre-trade cap here would
require either a new paid market-data tier (out of scope) or fabricating a slippage estimate from
data that doesn't support one - the second option is exactly what this project's "never fabricate"
rule prohibits. The honest, buildable alternative - a POST-trade realized-slippage monitor that
alerts on anomalously large fills - was considered but not built this phase to keep this phase's
diff bounded; flagged here as a real, well-scoped follow-up rather than silently dropped.

**Verified result.** Full suite (through this point in Phase 16): all new tests pass, `npx tsc
--noEmit` clean. `SystemBootstrap.ts` now starts `aiFailureCircuitBreaker` alongside
`alertingService`, same real-boot code path.
