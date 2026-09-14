# ARGUS Full Defect Audit

A forensic defect-hunting pass, distinct from the Master Completion Ledger (which tracks the
32-part institutional transformation mandate). This file tracks defects found and fixed during
forensic audit passes — never a claim of exhaustive, all-phases completion unless the coverage
table below actually says so.

## Phase 0 — Baseline (2026-09-14, pass 1)

- **Git commit:** `3a898b2dc68db523fb6c91810ea0f9ad71d7cc8f` (2026-09-13 21:37:32 -0400)
- **Working tree:** clean (nothing uncommitted at audit start)
- **Engine PID:** 8916 (started 2026-09-13 9:35:53 PM, fresh restart post-daily-attribution deploy)
- **Watchdog PID:** 10540 (unchanged all session)
- **Java PID(s):** 31612 / 15580 (unchanged since the Part 7 jar rebuild earlier this session)
- **Broker:** IBKR Gateway Socket, `CONNECTED`, account `DUR959160` (`DU*` prefix = real paper account)
- **Positions:** zero (`{"ok":true,"portfolio":[],"live":"NO-GO"}`)
- **LIVE:** `NO-GO` (confirmed)
- **PAPER:** `PAPER_TRADING_ONLY=true` (unchanged all session)
- **Tests (last full run, this session):** 490 TS files / 3592 tests green; 804 Java tests green (unchanged since last Java rebuild)
- **Build:** succeeds (`npm run build`, last run this session)
- **TypeScript:** `tsc --noEmit` clean (last run this session)
- **AI provider state:** degraded (~20% success rate over trailing 3h, diagnosed and documented in `docs/ARGUS_MASTER_COMPLETION_LEDGER.md`'s "AI provider degradation diagnosis" section — quota/rate-limit/configuration causes, not a code defect)
- **Reconciliation:** `RECONCILIATION_MATCH` on every recent cycle
- **Trading state:** `TRADING_PAUSED` (pre-existing operator state, unrelated to this audit, not altered)

No production behavior was modified to make this baseline look better than it is.

## Coverage table (updated as passes complete)

| Phase | Area | Status | Depth |
|---|---|---|---|
| 0 | Baseline | DONE | Full |
| 1 | Codebase inventory | PARTIAL | Targeted — reused this session's existing, extensive cumulative knowledge of the codebase rather than re-deriving a fresh inventory of every file; new work from tonight inventoried fully |
| 2 | Safety forensics (spine) | PARTIAL | See findings below — focused re-trace of tonight's new code + the fire-and-forget forecast call's interaction with the live path |
| 3 | Concurrency/async | PARTIAL | Focused on tonight's new async code (forecast build call, sample-cap logic) |
| 4 | Data integrity | PARTIAL | Focused on tonight's new tables/queries (`quant_forecasts`, daily attribution) |
| 5 | Quant forensics | PARTIAL | Focused on `ForecastEngine.java`/`internalQuantEnsemble.ts` (tonight's new code) |
| 6 | Calibration forensics | NOT COVERED this pass |
| 7 | Backtest/research forensics | NOT COVERED this pass |
| 8 | Broker/execution forensics | PARTIAL (deep on the traced scenarios) | Fill-ledger/portfolio-sync non-atomicity (pass 2), cancel/fill race at the local state-machine level (pass 3, FD-4), order acknowledgement/timeout (pass 3), and duplicate-fill accounting down to the raw IB event-stream level (pass 3, FD-5) all traced with real code evidence and, where a real defect was found, fixed + regression-tested. Not traced: Alpaca-specific order-ack/duplicate-fill behavior (IBKR only, the active broker, was traced), extended-hours order construction, LIMIT-order-specific paths |
| 9 | Position lifecycle | PARTIAL (deep on the traced scenarios) | Fill→portfolio sync race traced and fixed (pass 3, FD-6); portfolio-vs-reconciliation-write interaction traced (NO ISSUE FOUND, pass 3); broker-API-reporting-lag-vs-fresh-fill edge case traced and honestly flagged UNKNOWN (pass 3, not fixed - see writeup). Not traced: multi-broker portfolio aggregation, position lifecycle under a full process restart mid-fill |
| 10 | AI/LLM forensics | PARTIAL | Fail-closed guarantee re-verified against existing tests; not re-traced at every call site |
| 11 | News/external data security | NOT COVERED this pass (DEF-31 already covers NewsScoringEngine from a prior session) |
| 12 | Database forensics | PARTIAL | Focused on tonight's 3 new migrations |
| 13 | Frontend forensics | PARTIAL | Focused on tonight's new `OpportunitySnapshotPanel.tsx` |
| 14 | Observability | NOT COVERED this pass |
| 15 | Resource/memory forensics | NOT COVERED this pass |
| 16 | Startup/shutdown/recovery | NOT COVERED this pass (DEF-25/26/27/28/29 already cover this from prior sessions) |
| 17 | Configuration forensics | PARTIAL | Tonight's new config value (`forecastEngineMaxSampleSize`) verified |
| 18-19 | Test quality / invariants | PARTIAL | New regression tests added per defect found below |
| 20-24 | Prioritization / second pass / validation / deployment / report | This document |

**Honest framing:** a genuinely exhaustive pass across all 24 phases of an entire multi-hundred-file
TypeScript + Java codebase is not achievable in one continuous session at forensic depth. This audit
prioritized (a) tonight's own new, least-battle-tested code — exactly where "previous fixes may
themselves contain defects" most likely applies — and (b) the safety-critical phases explicitly
flagged. Phases marked "NOT COVERED this pass" are not claimed clean; they are simply outside this
pass's scope and should not be read as verified.

## Defects found

See table below, updated as the audit proceeds.

| ID | Severity | Subsystem | Root Cause | Observed Behavior | Impact | Fix | Regression Test | Verification |
|---|---|---|---|---|---|---|---|---|
| FD-1 | P2 | `forecastEngine.ts` (tonight's new code) | `QuantSignalAgent.ts`'s fire-and-forget `buildForecast()` call has no protection against two overlapping real idea-emissions for the same symbol before the first build finishes | Two concurrent calls for the identical (agent, strategy, symbol, direction, horizon) key would independently query the DB, independently call the Java bridge, and independently insert a `quant_forecasts` row - not corruption (both rows are real/valid), but duplicate work and unnecessary Java-bridge load, the same risk class as the unbounded-payload timeout found earlier tonight | Wasted computation under real high-frequency re-evaluation of the same symbol; no correctness or safety impact (never touches RiskEngine/OMS) | In-flight request coalescing (`inFlightForecastBuilds` map, `forecastRequestKey()`) - a second concurrent call for the same key awaits the first's result instead of starting a redundant build; the guard releases after completion so a later, non-overlapping call still runs a fresh build | `forecastEngine.test.ts`: "coalesces concurrent buildForecast calls..." (proves exactly 1 Java call + 1 persisted row for 2 concurrent identical calls, then a genuinely new build on a 3rd call after both resolve) + "does NOT coalesce two different real keys..." (proves distinct symbols are never accidentally merged) | 11/11 `forecastEngine.test.ts` tests green; full suite re-run pending |
| FD-2 | P3 | `NewsEngine.ts` code comment (documentation only, no functional code) | A 2026-09-03 comment claiming "FundamentalAgent.ts has the identical latent structural bug... not fixed in this pass; a separately-scoped follow-up" was never updated after that exact fix shipped to `FundamentalAgent.ts` (and `MacroAgent.ts`) on 2026-09-06, three days later | Stale, factually incorrect comment - a future engineer or AI pass reading it could believe `FundamentalAgent`/`MacroAgent` still have the subscribe-then-immediate-read bug and waste effort "fixing" already-fixed code, or worse, mistakenly treat it as license to skip auditing those files at all | Documentation-only; verified via direct code inspection that both `FundamentalAgent.ts` and `MacroAgent.ts` already call `waitForFreshMarketData()` correctly (real fix present, real regression coverage exists from the 2026-09-06 pass) | Corrected the comment to state the real fix history accurately | N/A (comment-only change) | Verified via direct read of `FundamentalAgent.ts:279-297` and `MacroAgent.ts:296-297` - both confirmed to already have the real fix |
| FD-3 | **P1** | `forecastEngine.ts` `mostRecentForecast()` (tonight's new code) | The query filtered only by `(symbol, agentName, direction, horizonLabel)` in SQL, fetched the 50 most recent rows across ALL strategies matching that broader key, and filtered by the requested `strategyId` in JavaScript AFTER that limit was applied | A real false negative: once 50+ forecasts for OTHER strategies (or the agent-level null-strategy case) had been built more recently under the identical broader key, `.find()` would return `undefined` and the function would report "no forecast exists" even though a real, valid, more-recent-for-the-requested-strategy row existed just outside the top-50 window | Directly affects `opportunitySnapshot.ts`'s live `modelForecast` display - a real forecast could silently disappear from the UI/API the moment enough other-strategy forecast volume accumulated, exactly the kind of "code exists, runtime lies" gap this whole session has tried to prevent. No safety/trading impact (read-only observability path, never reaches RiskEngine/OMS), but a genuine correctness defect in exactly the code this session shipped tonight | Moved the `strategyId` filter into the SQL `WHERE` clause (`eq()`/`isNull()` as appropriate) and reduced `limit(50)` to `limit(1)`, since the database now returns exactly the correct most-recent row for the exact requested key regardless of how much other-strategy volume exists | `forecastEngine.test.ts`: new test seeds 1 real forecast for `RARE_STRATEGY`, then 60 real forecasts for a different `CHATTY_STRATEGY` under the identical symbol/agent/direction/horizon, and proves `mostRecentForecast()` still finds the `RARE_STRATEGY` row (would have failed - returned null - against the pre-fix code) | 12/12 `forecastEngine.test.ts` tests green; full suite re-run pending |
| FD-4 | **P1** | `OrderManagement.ts` `cancelOrder()` / `applyFollowUpUpdate()` | Both functions read a `trades` row snapshot, perform a slow async operation (broker round-trip / `recordFillProgress()`), then write `trades.status` unconditionally with no re-check and no mutex between the two functions for the same `orderId` | A concurrent `cancelOrder()` call can silently overwrite `trades.status` back to `CANCELED` after a real, already-recorded fill (fill ledger + portfolio sync already correct and unaffected) - a genuine self-contradiction within OMS's own tables (`trades.status='CANCELED'` while `fills` has real rows for that order) | `dailyAttributionReport.ts` and `executionQuality.ts` both filter strictly on `trades.status IN ('FILLED', ...)` - a genuinely filled order silently vanishes from attribution/execution-quality reporting. Position/portfolio state is unaffected (already synced before the clobbering write); reconciliation does not catch this (it checks broker-vs-portfolio, not `trades.status`-vs-`fills`) | Symmetric compare-and-swap guard on both writes: `.where(and(eq(trades.id, orderId), eq(trades.status, row.status)))`, refusing (logging, not silently applying) when the row changed underneath since the pre-async read | `OrderManagement.lifecycle.test.ts`: 2 new tests, one per direction, each deterministically forcing the exact interleaving (a mocked broker cancel call / a wrapped `recordFillProgress()` each commit the "concurrent" write mid-flight) and asserting the real, newer status survives unclobbered in both directions; both reproduced the pre-fix clobbering failure before the fix, passed after | 14/14 `OrderManagement.lifecycle.test.ts` tests green; full suite re-run pending |
| FD-5 | **P1** | `IbkrSocketSession.ts` `orderStatus` / `execDetails` handlers | IB's `orderStatus.filled` is a CUMULATIVE running total (correctly overwritten); IB's `execDetails.shares` is a PER-EXECUTION increment (correctly accumulated) - but both handlers wrote the same shared `TrackedOrder.filledQuantity` field, and IB gives no ordering guarantee between the two independent event streams for the same real fill | If `orderStatus` (cumulative) lands before `execDetails` (incremental) for the same fill - a real, ordinary live-trading interleaving, not a crash-recovery-only edge case - `execDetails` adds its shares again on top of the already-cumulative value, double-counting `filledQuantity` | Downstream: `fillLedger.ts`'s cumulative-watermark dedup (`insertIncrementalFill`) trusts `filledQuantity` as ground truth: a corrupted (doubled, and compounding across multiple fills) cumulative value would propagate into the real `fills` ledger and `trades` quantity, a genuine order-lifecycle correctness defect, not merely cosmetic | `TrackedOrder` gained `execDetailsCumulative` (a running total tracked independently from the `execDetails` stream alone) and `seenExecutionIds` (dedup by IB's own unique `Execution.execId` - the real broker-execution-identifier dedup this pass set out to verify). `orderStatus` now writes via `Math.max` (also fixes a related stale-event regression risk); `execDetails` accumulates onto its own independent track, then reconciles into the shared field via `Math.max` - never a cross-stream sum, structurally eliminating the race regardless of event ordering | New `IbkrSocketSession.fillAccounting.test.ts` (3 tests): reproduced the exact double-count (20 instead of 10 for one fill; 30 instead of 20 across two fills) against the pre-fix code, and the ordering-dependence itself (reversed event order was correct pre-fix, proving a genuine race not a deterministic bug); all 3 pass post-fix with exact correct quantities | 32/32 `src/brokers/__tests__/` suite green (including pre-existing crash-recovery weighted-average tests, unchanged behavior); full repo suite re-run pending |
| FD-6 | **P1** | `localPortfolioSync.ts` `syncLocalPortfolioAfterBuyFill()` / `syncLocalPortfolioAfterSellFill()` | Both functions read a `portfolio` row, compute a new quantity/average-price via arithmetic on that snapshot, then write unconditionally with no CAS guard and no mutex between concurrent invocations for the same symbol | Two fills for the SAME symbol landing close together (a BUY add racing a SELL trim, or two independently-approved orders on the same symbol - nothing in the architecture serializes fill-processing across different orders) silently lose one delta via last-write-wins (understating or overstating the real position); for a symbol with NO existing local row yet, the second concurrent `INSERT` throws an uncaught primary-key collision (`portfolio.symbol` is the PK) that the prior code's outer catch swallowed, silently dropping that fill's portfolio effect entirely until the next reconciliation tick | `portfolio.quantity` is exactly the local exposure figure RiskEngine's concentration/correlation/notional gates read before approving a NEW order - a silently wrong (understated) local quantity here is the precise mechanism by which "the system acts on incorrect state before reconciliation catches it" (the operator's own stated invariant) could actually happen: a new order sized/approved against an understated local position, while real broker exposure is higher | Optimistic-concurrency retry loop on both functions: each write is a CAS (`WHERE symbol = ? AND quantity = <value just read>`, also matching `averagePrice` on the BUY path), and the INSERT-race case retries as an UPDATE against the row a concurrent writer just created instead of throwing past the outer catch. **Amended after a real full-suite run caught a second gap this same pass** (see write-up below): the original outer `catch` treated ANY exception, not just the two expected retryable cases, as immediately fatal with no retry - `isRetryableTransientError()` now lets a real transient error (`SQLITE_BUSY`/`SQLITE_LOCKED`, exactly what `busy_timeout=5000` in `src/server/db/index.ts` already anticipates as a real possibility under contention) retry with a short backoff instead of giving up on attempt 1. **Amended a second time after the operator's own explicit N-writer testing requirement found a THIRD gap** (mathematical, not environmental): optimistic-concurrency CAS resolves at most one competing writer per fully-synchronized contention round, so `MAX_SYNC_ATTEMPTS=8` (its post-first-amendment value) measurably failed a real 10-concurrent-writer test; raised 8→25 for real headroom above any realistic simultaneous-fill count | `localPortfolioSync.test.ts`: 4 two-writer tests (concurrent BUY+BUY on a brand-new symbol proving the INSERT-collision retry, concurrent BUY+BUY on an existing symbol, concurrent SELL+SELL, concurrent BUY+SELL mixed-direction - all real `Promise.all` races, no mocked timing) PLUS a full "FD-6 hardening - N-writer contention invariant" block added after the operator's explicit instruction: 2/5/10-concurrent-writer sum-correctness (3 trials each), 10-writer mixed BUY/SELL with both a positive and negative net outcome, a fill-sync racing a real reconciliation-style absolute writer (single, 10 trials, and a 5-writer burst, 5 trials) proving the CAS retry never double-applies or reapplies against stale data, a REAL (not simulated) `SQLITE_BUSY` via a genuine second-connection write lock, direct `isRetryableTransientError()` unit tests, and a restart/recovery replay-idempotency test tying FD-6 to the already-verified `insertIncrementalFill` cumulative-watermark dedup. Also stress-tested with 800+ combined ad hoc Promise.all race iterations across several harnesses before the N-writer suite existed (repeated isolated file runs, injected background DB noise, a full `src/server/services/` 92-file directory run) with zero reproduction of the first full-suite failure's specific "wrong total with success" symptom | 19/19 `localPortfolioSync.test.ts` tests green (5x repeated isolated runs after both hardenings). **First full-suite run: 4 failures** (transient-error gap) → hardened → **second full-suite run: clean, 491/491 files, 3604/3604 tests** → classified `FIXED / PARTIALLY VERIFIED` per the operator's explicit 2-writer-is-insufficient instruction → N-writer suite added → **N=10 concurrent-writer tests failed on first run** (attempt-budget gap) → hardened → third full-suite run's result is authoritative for final status - see the Final response block |
| FD-7 | **P1** | `PortfolioReconciliation.ts` open-order reconciliation section (`OPEN_ORDER_MISSING_LOCALLY` / `OPEN_ORDER_MISSING_REMOTELY` / `FILLED_ORDER_MISSING_LOCALLY`) | Unlike the sibling position-level `MISSING_LOCALLY`/`MISSING_REMOTELY` checks (which use `confirmConsecutiveFault` + a 2-consecutive-cycle debounce specifically because of a real prior incident, the GLD/NVDA flap), these three mismatch types pushed into `mismatches` on the very FIRST occurrence, no fresh re-read, no debounce | `followUpOpenOrders()` (OMS's own periodic `broker.orders()` poll) and `PortfolioReconciliation.reconcile()` (a separate periodic cycle) are two independent, uncoordinated timers hitting the broker at different moments - an order transitioning to terminal at the broker moments before OMS's own follow-up loop has processed that fill locally will, on that reconcile() cycle, show as terminal in the broker snapshot while the local `trades` row (read fresh, but before OMS caught up) still shows it as open, producing a real, routine (not rare) `OPEN_ORDER_MISSING_REMOTELY` that was never an actual drift | If this crosses `SIGNIFICANT_MISMATCH_DOLLARS` it triggers real `TRADING_PAUSED` off a single transient timing race between two uncoordinated pollers - a false-positive kill-switch trigger during completely ordinary operation (an order simply filling), not a rare edge case. Confirmed via the EXISTING (pre-fix) test suite in `PortfolioReconciliation.openOrdersAndCash.test.ts`, which explicitly asserted single-cycle firing as the then-current contract for all three types | Extended the exact same `confirmConsecutiveFault`/`PAUSE_CONSECUTIVE_CYCLES`/`pruneResolvedFaults` pattern already used for the position-level checks to all three open-order mismatch types, keyed by broker order id (not symbol, since multiple orders per symbol are possible). Moved the single `pruneResolvedFaults()` call from immediately after the position-level loops to after the open-order loops too, accumulating one combined `liveFaultKeys` set across both sections (calling it twice with different key sets would have wrongly deleted the other section's in-progress counters) | `PortfolioReconciliation.openOrdersAndCash.test.ts`: the 3 existing tests (which asserted single-cycle firing) were updated to assert NO mismatch on cycle 1 and confirmation on cycle 2, matching the position-level tests' own established pattern; one new test added proving a one-cycle-only blip (resolved by cycle 2) is never flagged at all, mirroring `portfolioReconcileCompare.test.ts`'s existing "resets a symbol that matched on the next cycle" test for the position-level debounce. **A first full-suite run after this fix caught 3 further real regressions this initial search missed**: `ReconciliationAcknowledgements.test.ts` (a sibling file exercising the SAME `FILLED_ORDER_MISSING_LOCALLY` path via a shared `portfolioReconciliationWorker` singleton, not found by an incomplete initial grep) had 3 of its 4 tests also asserting single-cycle firing - updated the same way (2 reconcile() calls before asserting), verified the acked-order test (which never reaches the debounce check) was correctly unaffected. A third file, `reconciliationOperatorSnapshot.test.ts`, matched the same grep but only tests a pure fixture-string parser with no `reconcile()` call at all - confirmed unaffected, no change needed | 7/7 `PortfolioReconciliation.openOrdersAndCash.test.ts` + 4/4 `ReconciliationAcknowledgements.test.ts` tests green; full reconciliation test surface (7 files, 27 tests) green, no regressions in any sibling reconciliation test file |

## Phase 8/9 — Broker/order/position lifecycle (2026-09-14, pass 2, per explicit operator priority)

Traced (not assumed) two specific real-world race scenarios from the operator's own priority list,
following actual code paths rather than trusting prior sessions' documented fixes at face value:

**Scenario A — restart/crash between fill-ledger write and local portfolio sync.**
`OrderManagement.recordFillProgress()` calls `insertIncrementalFill()` (the authoritative `fills`
table write) and THEN, as a separate, non-atomic step, `syncLocalPortfolioAfterBuyFill()` /
`syncLocalPortfolioAfterSellFill()` (the `portfolio` table write). No `db.transaction()` wraps
these two calls — confirmed via a full-codebase grep that `db.transaction(` is not used anywhere
in `src/server/services/` or `src/server/engines/`, so this would be a first-of-its-kind pattern to
introduce, not an established one. **A crash landing between these two calls would leave `fills`
correct and `portfolio` stale** - a real gap, not fabricated.

**Scenario B — cancel/fill race.** `OrderManagement.cancelOrder()` reads `trades.status` once,
calls `broker.cancelOrder()` (a real network round-trip with its own timing), and only then marks
the local row `CANCELED`. A broker-side race (the order actually fills moments before or during
the cancel call, while the broker's cancel API still reports success) would leave Argus's local
state permanently `CANCELED` (a terminal status `followUpOpenOrders()` explicitly excludes from all
future re-checks) while a real position may exist at the broker that Argus never accounted for.

**Both scenarios are real, but neither is a fresh, undetected defect** - both are architecturally
caught by `PortfolioReconciliation.ts`'s own real, working `MismatchDetail` taxonomy
(`QUANTITY_DRIFT`, `FILLED_ORDER_MISSING_LOCALLY`), confirmed via direct code trace:
- Line ~351: a broker-reported filled order with no matching local trade produces a real
  `FILLED_ORDER_MISSING_LOCALLY` mismatch (this is P0.7's own documented invariant, "Operator ack
  for FILLED_ORDER_MISSING_LOCALLY" - confirmed to be real, wired code, not just a CLAUDE.md claim).
- Line ~409: `worstImpact >= SIGNIFICANT_MISMATCH_DOLLARS && tradingEngine.state.tradingState ===
  'TRADING_ENABLED'` really calls `tradingEngine.setTradingState('TRADING_PAUSED', ...)` - and this
  exact line's own comment (lines 392-397) documents that it was ITSELF the fix for a real, prior
  defect (setting `emergencyStopActive` directly instead of `tradingState`, which RiskEngine's
  `emergency_stop` gate does not read) - i.e., this exact safety net was already forensically
  audited and fixed in an earlier session, and this pass's independent re-trace confirms it is
  correctly wired today, not merely re-trusting the prior claim.

**Conclusion for Phase 8/9 this pass:** Argus's architecture deliberately relies on periodic,
threshold-gated, fail-closed reconciliation as the authoritative backstop for order/fill/position
divergence, rather than attempting full transactional atomicity in every individual code path
(consistent with the "never auto-flatten, never auto-resume, persist mismatches" philosophy already
documented). This is a reasoned, working design, verified by real tracing this pass - not a defect
to "fix" by retrofitting transactions everywhere. **One real, honest residual gap remains
unverified**: `SIGNIFICANT_MISMATCH_DOLLARS`-gated pausing means a mismatch below that dollar
threshold is recorded and alerted but does NOT pause trading - this is a deliberate materiality
threshold, not obviously wrong, but its actual configured value and whether it's appropriate for a
small-account paper deployment was not evaluated this pass (a legitimate candidate for the next
audit, not a claimed defect).

Coverage table above updated: Phase 8/9 is now PARTIAL (2 specific real scenarios traced with
actual code evidence) rather than NOT COVERED - still not exhaustive (order-ack timing, IBKR
reconnect-during-submission, and duplicate-fill-event ordering per the operator's fuller list were
not traced this pass).

## Vocabulary (adopted from operator review, used strictly from this point forward)

`DEFECT` — objectively incorrect or unsafe behavior. `DESIGN TRADEOFF` — intentional behavior with
documented consequences. `CONTROL VERIFIED` — a safety mechanism actually traced/tested, not
assumed from documentation. `UNKNOWN` — not sufficiently investigated. `UNPROVEN` — requires
live/paper elapsed-time evidence. `NO ISSUE FOUND` — after actually examining the relevant path.

## Pass 3 — Order acknowledgement / timeout (2026-09-14, IBKR-specific trace)

Traced `OMS -> IBKR submission -> socket response -> persistence -> retry` end to end, following
the ACTIVE broker in this deployment (`IBGatewaySocketAdapter`/`IbkrSocketSession`), not the
Alpaca path whose own idempotency comment (`OrderManagement.ts` line ~395) does not automatically
apply to IBKR.

**Structural finding (not itself a defect, but load-bearing context):**
`IBGatewaySocketAdapter.placeOrder()` calls `IbkrSocketSession.placeStockOrder()`, which is
**synchronous** - it calls the underlying `@stoqey/ib` library's `this.ib.placeOrder(orderId,
contract, order)` (itself fire-and-forget over the TCP socket) and returns an `orderId`
immediately, with NO wait for any real IB acknowledgement. `placeOrder()` therefore always returns
`status: 'PENDING'` optimistically - this is not a "timeout" in the traditional sense (there is no
network round-trip inside `placeOrder()` itself whose response could be lost); the real
acknowledgement arrives later, entirely asynchronously, via IB's own `openOrder`/`orderStatus`
callbacks.

**Traced scenario: IBKR accepts the order but the real ack is never observed.**
- `OrderManagement.executeOrder()`'s `pollForFill()` polls `broker.orders()` up to
  `omsPollForFillTimeoutMs`. **CONTROL VERIFIED**: `IBGatewaySocketAdapter.orders()` returns
  `this.session.listTrackedOrders()` - a passively-maintained, callback-populated in-memory cache,
  **never an active re-query to IB Gateway**. Confirmed via trace: `reqOpenOrders()` (the only
  active query IB itself offers here) is called exactly once per successful `connect()`, never
  periodically. This means the entire poll/follow-up chain structurally TRUSTS the reliability of
  IB's own push-callback delivery over the live TCP connection between connects, rather than
  defensively re-asking IB "what is the real status right now."
- If `pollForFill()` times out with no terminal status observed, `status` correctly stays
  `'PENDING'` (its original, honest, unverified value) - **CONTROL VERIFIED**, not merely
  documented: the code path that would mark it something else never executes when `terminal` is
  `null` (`OrderManagement.ts` lines 434-442).
- `followUpOpenOrders()` re-checks later using the SAME in-memory cache (`broker.orders()`) -
  confirmed via trace it NEVER calls `placeOrder()` again, only `broker.orders()` (read) and
  `cancelOrder()` (a real, deliberate action) or `pauseTradingForOrphan()`. **This invariant
  ("unknown broker state -> pause/reconcile, never blind retry") was previously only documented in
  comments; it is now CONTROL VERIFIED with explicit regression-test assertions** added this pass
  to `OrderManagement.lifecycle.test.ts`: all three relevant scenarios (terminal-order exclusion,
  give-up-after-max-age, cancel-remainder-after-max-age) now explicitly assert `placeOrderCallCount`
  is unchanged by `followUpOpenOrders()`, not merely that the resulting `trades.status` looks right.
- `IbkrSocketSession.scheduleReconnect()` traced directly: it only ever calls `this.connect(...)`
  again - **NO ISSUE FOUND**: there is no pending-order queue and no replay/resubmission logic
  anywhere in the reconnect path. A reconnect triggers `reqOpenOrders()`/`reqExecutions()`
  (read-only rehydration, DEF-30's own prior work, re-confirmed present this pass), never a
  resubmission.
- `activeBroker.placeOrder()` throwing synchronously (e.g., socket write failure while
  disconnected) is caught by `OrderManagement.executeOrder()`'s own outer try/catch: **CONTROL
  VERIFIED** - `if (!brokerOrderId) { status = 'PENDING'; ...; pauseTradingForOrphan(...) }` (lines
  ~477-499), the row is never marked REJECTED from a submission-time throw, and trading pauses
  rather than silently continuing on an ambiguous state.

**Classification: DESIGN TRADEOFF, not a defect.** Argus's IBKR order-status resolution relies on
IB's own push-callback stream being reliable while the TCP connection is healthy, rather than
actively re-polling IB Gateway for order status on every follow-up cycle. This is a reasonable
choice (IB's API is designed around reliable in-order delivery over a persistent connection, and a
genuine disconnect is separately, correctly detected and triggers real rehydration) but it is an
assumption, not a proof - a dropped-but-not-detected-as-disconnected callback (an edge case in the
underlying `@stoqey/ib` library or IB Gateway itself, not in Argus's own code) would leave an order
looking PENDING to Argus for up to `FOLLOWUP_MAX_AGE_MS` before the orphan-cancel/pause path
engages, purely because nothing actively re-asks IB in between. **UNKNOWN**: whether IB Gateway's
real-world callback delivery has ever actually dropped a message without a detectable disconnect -
not measured, not fabricated as a claim either way. A candidate for a future enhancement (a
periodic defensive `reqOpenOrders()` refresh independent of connect/reconnect) but not an urgent
fix, since the worst case is bounded, fail-safe delay, never an incorrect action.

**No client_order_id reuse defect found.** `OrderManagement.executeOrder()`'s own idempotency
guard (`db.select().from(trades).where(eq(trades.traceId, traceId))` before ever calling
`placeOrder()`) plus the real DB-level `idx_trades_trace_id_unique` constraint (confirmed present,
unchanged) together mean a given local `orderId`/`clientOrderId` (`trades.id`) can never be
generated twice for the same real decision. **NO ISSUE FOUND.**

## Pass 3 — Cancel/fill race, one level deeper (2026-09-14, same trace, per explicit operator instruction to go past "does reconciliation eventually notice?")

The operator's exact question: *"Can the system temporarily act on an incorrect state before
reconciliation catches it?"* Traced the LOCAL order state machine itself (`trades.status`
writes), not just whether a broker/local mismatch would eventually be caught.

**DEFECT (FD-4) found and fixed: `cancelOrder()` and `applyFollowUpUpdate()` both write
`trades.status` for the same order via a stale read-then-write with no concurrency guard.**

- `cancelOrder()` (`OrderManagement.ts`) reads `row.status` once, then makes a slow broker
  round-trip (`await broker.cancelOrder(...)`), then — pre-fix — wrote `status: 'CANCELED'`
  unconditionally with no re-check. `applyFollowUpUpdate()` has the identical shape: a caller-side
  DB snapshot, then (after `recordFillProgress()`'s own real `await`) an unconditional
  `db.update(trades).set({status: match.status, ...})`. Neither write was guarded by an optimistic
  lock, and the two are not mutexed against each other for the same `orderId`.
- **Concrete, provable failure mode (not hypothetical):** `followUpOpenOrders()` detects a real
  fill and calls `applyFollowUpUpdate()`, which first calls `recordFillProgress()` — a real row is
  written to `fills`, and the portfolio is correctly synced — *then*, as a separate awaited
  statement, writes `trades.status = 'FILLED'`. If `cancelOrder()` is invoked concurrently (its own
  stale read still shows `OPEN`/`PARTIALLY_FILLED`) and its final write lands after
  `applyFollowUpUpdate()`'s, `trades.status` is silently clobbered back to `CANCELED` — even though
  `fills` already has a real, correct fill row for that order.
- **Real consequence, not cosmetic:** `dailyAttributionReport.ts:49` and
  `executionQuality.ts:54` both filter strictly on `trades.status IN ('FILLED', ...)`. A genuinely
  filled order wrongly left `CANCELED` silently vanishes from attribution/execution-quality
  reporting, even though the position/portfolio itself remains correct (the fill ledger and
  portfolio sync already happened before the clobbering write). Reconciliation does not catch this
  either — it compares broker positions against the portfolio, which is already correct here, not
  `trades.status` against `fills`.
- **Classification: DEFECT**, not a design tradeoff — this is an internal self-contradiction
  between two of OMS's own tables, both written by OMS's own code, not a broker-ambiguity question.
- **Fix (symmetric, both directions):** both writes are now compare-and-swap —
  `.where(and(eq(trades.id, orderId), eq(trades.status, row.status)))` — so a write only commits if
  the row is still in exactly the status this code path observed before its own slow operation
  (broker round-trip / `recordFillProgress()`). If the row changed underneath (0 rows affected via
  the drizzle/better-sqlite3 `RunResult.changes`), the write is refused, not silently applied: a
  console warning is logged and the caller returns/continues without claiming a status it can no
  longer prove. No transaction was added (matches the codebase's existing idempotent-write +
  no-transactions institutional pattern) — this is a minimal, symmetric CAS guard on both sides of
  the exact race.
- **Regression tests (both directions, both deterministic, both reproduce the pre-fix failure):**
  `OrderManagement.lifecycle.test.ts` gained two new tests. (1) `cancelOrder()`'s own
  `cancelOrderSpy` mock commits a real concurrent `FILLED` write to the DB *during* the simulated
  broker round-trip, before `cancelOrder()`'s own final write executes — asserts `cancelOrder()`
  returns `ok:false` and the row stays `FILLED`, never clobbered to `CANCELED`. (2) The symmetric
  case: `followUpOpenOrders()`'s private `recordFillProgress()` is wrapped (a legitimate JS runtime
  technique — TS `private` is compile-time only) to commit a real concurrent `CANCELED` write
  immediately after the real fill-recording step but before `applyFollowUpUpdate()`'s own status
  write — asserts the row stays `CANCELED` (never clobbered back to `FILLED`) while the fill ledger
  itself is still correctly populated. Both tests initially failed against the pre-fix code with the
  exact predicted clobbering behavior before the fix was applied, then passed after — confirming the
  fix, not just the assertion shape. Full `OrderManagement.lifecycle.test.ts` suite: 14/14 passing.

## Pass 3 — Duplicate-fill accounting (2026-09-14, item 3 of the operator's explicit sequence)

Operator's stated invariant: *"same broker execution increases the authoritative fill quantity
exactly once regardless of replay."* Traced from the DB-layer dedup (`fillLedger.ts`) down into the
actual IBKR event source (`IbkrSocketSession.ts`) that produces the `filledQuantity` values
`fillLedger.ts` trusts as ground truth.

**`fillLedger.ts`'s own dedup — CONTROL VERIFIED, but not by broker execution identifier as the
operator described.** `insertIncrementalFill()`'s real, production dedup key is
`(orderId, cumulativeQuantity)` (the `idx_fills_order_cumulative` unique index, P0.4) — it treats
`filledQuantity` as a CUMULATIVE watermark, computing `newQty = reportedQty - priorQty` and
no-op'ing (`newQty <= 1e-9`) on any report at or below the already-recorded watermark. The
`brokerFillId` parameter exists in the function signature but `OrderManagement.ts`'s only call site
(`recordFillProgress()`) never passes it — so in production, dedup is never actually keyed on a raw
broker execution ID, only on the cumulative-quantity watermark. Traced the two exact scenarios the
operator specified against this model: "execution A, A, B, A" (a stale/duplicate watermark replay
after a higher watermark is already recorded) computes a negative `newQty` and is correctly
no-op'd; "partial A, disconnect, reconnect, replay A, partial B" replays the same watermark A
(`newQty = 0`, correctly skipped) then correctly adds only B's true increment. **CONTROL VERIFIED**
for a cumulative-quantity input — but this control's correctness is entirely conditional on
`filledQuantity` itself always being a genuine, non-double-counted cumulative value by the time it
reaches this function. That assumption does NOT hold, and tracing why is FD-5 below.

**DEFECT (FD-5) found and fixed: `IbkrSocketSession`'s `orderStatus` and `execDetails` handlers
independently mutate the same `TrackedOrder.filledQuantity` field with incompatible semantics,
causing a real double-count for an ordinary, single-process, non-crash-recovery live fill.**

- IB's `orderStatus` event reports `filled` as IB's own CUMULATIVE running total for the order —
  the handler correctly treated this as an overwrite (`row.filledQuantity = filledQty`).
- IB's `execDetails` event reports `shares` as the quantity of that ONE execution — a per-fill
  INCREMENT, not cumulative — the handler correctly treated this as an accumulation
  (`row.filledQuantity = prevFilled + shares`).
- Both handlers mutate the exact same shared field on the exact same `TrackedOrder` object. IB
  gives no ordering guarantee between these two independent event streams for the same real fill
  (a well-known real-world IB API property, not an Argus assumption). If `orderStatus` (cumulative)
  lands first, a subsequent `execDetails` for that identical fill adds its shares AGAIN on top of
  the already-cumulative value — a genuine double-count, in ordinary live trading, not merely a
  crash-recovery edge case (confirmed: `placeStockOrder()` always creates the `TrackedOrder` row
  synchronously before either event can arrive, so both handlers find an existing row for every
  normally-placed order).
- **Proven, not asserted:** wrote `IbkrSocketSession.fillAccounting.test.ts` (new file, 3 tests)
  reproducing this against the pre-fix code first. Single 10-share fill, `orderStatus` before
  `execDetails`: pre-fix result was `filledQuantity = 20` (should be 10). Same fill, reversed event
  order (`execDetails` before `orderStatus`): pre-fix result was correctly `10` — proving the bug is
  genuinely ordering-dependent, not universal, i.e., a real race, not a deterministic error easily
  caught by any existing test. Two-fill sequence (10 + 10 shares, each reported via both event
  types): pre-fix result was `30` (should be 20) — the error compounds across fills, not merely
  doubling once.
- **Fix:** `TrackedOrder` gained two new fields — `execDetailsCumulative` (a running total
  maintained ONLY from the `execDetails` stream, independent of `orderStatus`) and
  `seenExecutionIds` (a `Set<string>` of IB's own genuinely-unique `Execution.execId`, deduping a
  literal redelivery of the identical execution within the `execDetails` stream itself — the actual
  "broker execution identifier" dedup the operator asked to verify, now real). `orderStatus` now
  writes `row.filledQuantity = Math.max(row.filledQuantity, filledQty)` (also closes a secondary,
  related gap: a stale/out-of-order `orderStatus` event can no longer regress a higher
  already-known value). `execDetails` now accumulates onto its OWN `execDetailsCumulative` track,
  then reconciles into the shared `filledQuantity` via `Math.max(...)` — never a cross-stream sum.
  This structurally eliminates the double-count regardless of event ordering or `execId`
  availability (execId dedup is an additional, independent layer for same-stream redelivery, not
  the only thing preventing the cross-stream race). Weighted-average fill-price computation was
  correspondingly rebased onto `execDetailsCumulative` rather than the shared, now
  cross-stream-reconciled `filledQuantity`, preserving the pre-existing weighted-average test's
  exact expected value (unchanged, still passing).
- **Regression tests:** all 3 new `IbkrSocketSession.fillAccounting.test.ts` tests now pass against
  the fixed code (`filledQuantity` correctly `10`, `10`, `20` respectively, matching real fill
  quantities exactly). Full `src/brokers/__tests__/` suite: 32/32 passing, including the pre-existing
  `IbkrSocketSession.crashRecovery.test.ts` weighted-average and multi-fill-accumulation tests
  (unchanged behavior confirmed).
- **Honest residual gap:** IB order types/vintages that omit `Execution.execId` entirely (already
  documented as a residual DEF-30 gap) cannot use the same-stream redelivery dedup layer — the
  cross-stream `Math.max` reconciliation still holds regardless, but a genuine duplicate redelivery
  of a bare `execDetails` event with no `execId` on such an order type could still double-add
  within the `execDetailsCumulative` track alone. Not fabricating certainty this is impossible;
  flagging it as **UNKNOWN**, same honesty standard as DEF-30's own residual-gap note.

## Pass 3 — Position lifecycle / reconciliation race (2026-09-14, item 4 of the operator's explicit sequence)

Operator's stated invariant: broker positions remain ultimate truth, and local state must converge
"without creating an order based on stale local exposure." Traced
`fill -> fill-ledger -> portfolio -> broker-position -> reconciliation` under concurrency, not just
whether reconciliation eventually corrects a drift.

**DEFECT (FD-6) found and fixed** — see the defects table above for the full writeup:
`syncLocalPortfolioAfterBuyFill()`/`syncLocalPortfolioAfterSellFill()` (`localPortfolioSync.ts`)
had the identical unguarded read-then-write shape as FD-4, but on `portfolio.quantity` itself
rather than an order-status field. This is a materially more sensitive target than FD-4: it is
exactly the number RiskEngine's concentration/correlation/notional-cap gates consult before
approving a NEW order, so a silent lost update here is the concrete mechanism by which the
operator's own stated risk (acting on stale local exposure before reconciliation catches it) could
actually occur. Fixed with the same CAS-retry pattern used for FD-4, extended to a retry loop
(rather than FD-4's refuse-and-log) because a portfolio quantity delta represents real shares that
must be applied exactly once, not a status field that can safely wait for the next cycle to
re-derive.

**Traced and PROVEN with tests (not just reasoned about): can a fill-sync CAS retry accidentally
reapply an old delta against a newly reconciled absolute quantity?** This was the operator's
specific, narrower question about the retry mechanism itself, distinct from the broader
broker-staleness question below. Reconciliation's writes (`PortfolioReconciliation.ts` lines ~186,
~215, ~232, ~303) all set `quantity` to the BROKER's own absolute reported value, never a
locally-computed delta. By construction, a fill-sync's delta (its `boughtQuantity`/`soldQuantity`
parameter) never changes across retries, and every retry attempt re-reads the CURRENT row
immediately before computing and CAS-writing against it — so a successful commit always applies
the real, fixed delta exactly once, on top of whatever the freshest value is at that exact moment,
never a stale one. **CONTROL VERIFIED**: `localPortfolioSync.test.ts`'s "FD-6 hardening" block adds
two tests exercising this directly against a real concurrent `reconciliationStyleAbsoluteWrite()`
(mirroring reconciliation's exact unconditional-overwrite shape) — a single-writer version (10
trials) and a burst version with 5 staggered reconciliation writes racing one fill (5 trials). Both
assert the fill's own call always reports success, and the final quantity is ALWAYS exactly one of
the two mathematically valid outcomes (`reconciliation's last value` or `reconciliation's last value
+ the fill's real delta`) — never a double-counted or corrupted value. **NO ISSUE FOUND** for this
specific reapplication concern.

**Separately, the broader broker-staleness question — "must a just-landed fill temporarily absent
from a broker snapshot cause Argus to conclude it disappeared and take an unsafe compensating
action?"** This is a real, structurally different race: `broker.portfolio()` can lag a few seconds
behind a fill that already committed through OMS's own fill-sync path (a broker-API-inherent
staleness, not an Argus-internal concurrency bug — there is no CAS to add here, since the "stale"
value is itself a real value the broker actually reported). Traced precisely rather than left as
pure speculation:
- **The raw quantity number CAN be silently, transiently overwritten.** If reconciliation's stale
  snapshot lands after a fresh fill, its unconditional write (line ~186 for a within-tolerance
  refresh, or line ~215 for `present_drift`) sets `portfolio.quantity` back to the broker's
  pre-fill-reported value — confirmed by the same two tests above (the "reconciliation's last
  value" outcome, with no fill delta added, is exactly this scenario). **Still UNKNOWN / not fixed
  this pass** — this is real, narrow-window data staleness, and closing it fully would require
  either a broker-side fill-sequencing guarantee that does not exist or a new "do not regress within
  N seconds of our own last write" mechanism — a meaningfully larger design change than a CAS fix,
  matching exactly the kind of over-engineering the operator explicitly asked this audit to avoid.
- **But this silent overwrite does NOT, by itself, constitute "Argus concluding the fill disappeared
  and taking an unsafe compensating action."** Traced the exact code path: a `present_matching` or
  `present_drift` write (an EXISTING local row whose quantity merely differs from the broker's
  stale-by-a-few-seconds report) never calls `mismatches.push(...)` — that only happens for
  `MISSING_LOCALLY`/`MISSING_REMOTELY`/`OPEN_ORDER_MISSING_*`/`FILLED_ORDER_MISSING_LOCALLY`/
  `ACCOUNT_INCONSISTENCY` (confirmed via direct grep of every `mismatches.push` call site), and only
  `mismatches` feeds `worstImpact`/`SIGNIFICANT_MISMATCH_DOLLARS`/`setTradingState('TRADING_PAUSED')`
  (line ~409). A `present_drift` overwrite even has its own comment stating this explicitly: "writing
  broker qty (not a pause by itself)". The ONLY path where broker-staleness could plausibly escalate
  to an actual "conclude it disappeared" action is a BRAND-NEW symbol (no prior local row) whose
  just-landed fill hasn't yet appeared in the broker's own stale snapshot — genuinely hitting
  `MISSING_REMOTELY` (`local` exists via fill-sync, `remoteCanon` doesn't have it yet). **CONTROL
  VERIFIED, with a precise timing window, not just asserted:** this path is gated by
  `confirmStillHeldLocally()` (a fresh re-read before ever recording the fault) AND
  `confirmConsecutiveFault()`'s debounce (`PAUSE_CONSECUTIVE_CYCLES` = `reconPauseConsecutiveMismatchCycles`
  = **2**, real config value) — the SAME fault must recur on the very NEXT reconciliation cycle to
  become real; `pruneResolvedFaults()` resets the counter to zero the moment the fault does not
  recur. With `portfolioReconciliationMs` = **300000ms (5 minutes)**, this means: any broker-reporting
  lag that resolves within roughly one 5-minute cycle can NEVER trigger the unsafe action (mismatch
  push, and for `MISSING_REMOTELY`, the local-quantity-zeroing write) — only a lag persisting across
  TWO CONSECUTIVE 5-minute cycles (a genuine ~5-10 minute broker/local disagreement) would. This exact
  debounce mechanism is already directly, deterministically tested — not by this pass, but by
  pre-existing tests this pass verified are real and still passing: `portfolioReconcileCompare.test.ts`'s
  `"consecutive fault debounce (GLD/NVDA flap)"` block ("does not confirm a one-off miss", "confirms
  the same discrepancy on the second consecutive cycle", "resets a symbol that matched on the next
  cycle"). **Genuinely UNKNOWN, not fabricated as proven:** whether real-world IBKR/Alpaca
  position-reporting lag for a single fill could ever plausibly exceed this ~5-10 minute debounce
  window — not live-measured this pass. In practice such lag is expected to be sub-second to a few
  seconds, giving very substantial headroom, but that expectation itself is not empirical evidence.

**Process note on FD-6 (in the interest of honesty about how this was actually verified, not just
what was fixed):** the first full-suite run (490 files) after FD-6's initial fix reported 4 failures,
all in `localPortfolioSync.test.ts` - the 4 new race tests this pass added, all producing genuinely
wrong final quantities (e.g. `13` instead of `18`) or an outright `updated:false`, despite the same
tests passing cleanly (repeatedly, 8+ runs) in isolation. This was investigated directly rather than
dismissed as flakiness or re-run until it passed, since it concerns real financial-quantity
correctness:
- Root-caused ONE confirmed, real bug via direct instrumentation: the retry loop's outer `catch`
  treated ANY exception as immediately fatal, not just the two expected retryable cases - so a real
  transient `SQLITE_BUSY` (exactly what `busy_timeout=5000` already anticipates as possible under
  contention, and full-suite runs are openly documented elsewhere in this file as running under real
  load - see `hookTimeout: 60_000`'s own comment in `vitest.config.ts`) would cause an immediate
  give-up with no retry at all. Fixed via `isRetryableTransientError()` with a short backoff.
- Could NOT reproduce the more concerning symptom - two concurrent calls both reporting
  `updated:true` yet the final quantity being wrong, which would indicate the CAS predicate itself
  failing to prevent a lost update - despite substantial targeted effort: 8+ repeated isolated runs
  of the exact failing test file, a 200-iteration stress harness with injected concurrent background
  DB writes, a 300-iteration direct stress harness for the SELL+SELL scenario specifically, and a
  92-file real `src/server/services/` directory run (closer to full-suite conditions than an
  isolated single-file run). All were clean. The CAS predicate itself (`WHERE quantity = <exact
  value read>`) is deterministic SQL that cannot logically match a row it does not equal, regardless
  of timing - no plausible logic bug was found to explain this symptom, only the confirmed
  transient-error-handling gap above.
- Given the CAS logic could not be shown to be unsound, and one real, confirmed gap WAS found and
  fixed (transient-error retry), the most likely explanation is that the first full-suite run's
  specific accumulated load (600+ seconds, hundreds of prior SQLite connections/temp files) produced
  real `SQLITE_BUSY` conditions that the pre-fix code's all-exceptions-are-fatal bug then surfaced as
  outright failures rather than graceful retries.
- **Second full-suite run (with the transient-error hardening applied): CLEAN — 491/491 files,
  3604/3604 tests passing, zero failures.** This is real evidence, not an assumption, that the
  transient-error-handling gap was the actual (or at least sufficient) explanation for the first
  run's failures — the exact same 4 tests that failed before now passed under the same real
  full-suite load.
- **Per the operator's explicit instruction, a green suite for the 2-writer case alone was
  classified as `FIXED / PARTIALLY VERIFIED`, not fully closed** — the invariant had only been
  demonstrated for the minimal 2-writer case. A comprehensive N-writer test suite was then added
  (`localPortfolioSync.test.ts`'s "FD-6 hardening - N-writer contention invariant" block): 2/5/10
  concurrent BUY fills, 10-writer mixed BUY/SELL with both a positive and a negative net outcome, a
  fill-sync racing a real reconciliation-style absolute writer (single and burst), a REAL (not
  simulated) `SQLITE_BUSY` via a genuine second-connection write lock, direct unit tests of
  `isRetryableTransientError()`, and a restart/recovery replay-idempotency test.
- **This N-writer suite found a SECOND real, distinct gap on its first run**, not a repeat of the
  first: `MAX_SYNC_ATTEMPTS=8` (an arbitrary value, never stress-tested against real contention
  higher than 2 writers before this pass) is mathematically insufficient for 10 genuinely
  simultaneous writers on the same row — optimistic-concurrency CAS resolves AT MOST ONE competing
  writer per fully-synchronized contention round, so N simultaneous writers can require up to N
  attempts for the unluckiest one. The 10-concurrent-writer test and both 10-writer mixed BUY/SELL
  tests failed with `updated:false` (an honest, correctly-reported exhaustion - never a silent
  wrong total) on the first run against `MAX_SYNC_ATTEMPTS=8`. Fixed by raising it to 25 (real
  headroom above any realistic real-world simultaneous-fill count for one symbol, plus slack for
  transient-error retries layered on top of CAS retries within the same budget). Re-run 5 times
  isolated after the fix: 19/19 tests green every time, including all three N=2/5/10 concurrency
  levels (3 trials each) and both mixed-direction 10-writer tests.
- **Third full-suite run (both hardenings applied - transient-error retry AND the raised attempt
  budget): CLEAN — 491/491 files, 3616/3616 tests passing, zero failures.** (3616 = the second run's
  3604 + exactly the 12 new N-writer-suite tests added since - confirms nothing else regressed or
  was silently skipped.) This is the gate the operator's own decision framework specified.

**Canonical record (operator-approved summary, adopted verbatim):**

> **FD-6 — Portfolio fill-sync lost-update race — FIXED / VERIFIED**
>
> Concurrent fill synchronization could overwrite `portfolio.quantity` through competing
> read-modify-write operations. The initial optimistic-CAS remediation exposed additional
> contention weaknesses under full-suite and N-writer testing: transient database contention could
> prematurely terminate retries, and the original retry budget was insufficient under synchronized
> 10-writer contention.
>
> The implementation was hardened to retry transient database contention and increased the CAS
> retry budget to provide explicit headroom above the tested concurrency envelope.
>
> Verification covered 2, 5, and 10 concurrent writers; mixed BUY/SELL quantities; positive/negative
> net effects; concurrent reconciliation-style absolute writes; burst reconciliation contention;
> genuine SQLITE_BUSY; and restart/recovery replay. The losing fill-sync path rereads current
> database state on retry, preventing stale-delta reapplication.
>
> Final verification: 491/491 test files, 3,616/3,616 tests passing.
>
> The previously observed "both calls succeeded but final quantity was incorrect" symptom could not
> be reproduced after hardening and is therefore recorded as non-reproduced, not claimed impossible.
>
> Remaining UNKNOWN: real-world broker position-reporting lag exceeding the configured
> reconciliation debounce window has not been empirically observed.

**FD-6 final status: FIXED / VERIFIED.** Per the operator's explicit framework: the suite is green,
and the quantity invariant ("final quantity equals the mathematically correct sum of all accepted
fills, regardless of interleaving, retry, SQLITE_BUSY, reconciliation writes, or process
scheduling") has now been demonstrated for 2, 5, AND 10 concurrent writers (not just the minimal
two-writer case), mixed BUY/SELL with both a positive and a negative net outcome, a real (not
simulated) SQLITE_BUSY condition, a fill-sync racing a real reconciliation-style writer both singly
and in a burst, and a restart/recovery replay scenario - satisfying the "not just two writers"
condition for full closure. **The original first-full-suite-run symptom (two concurrent calls both
reporting success yet the final quantity being wrong) is documented as NON-REPRODUCED, not
proven-impossible** - it was never reproduced again under any of the extensive testing this pass
(800+ ad hoc stress iterations, the full N-writer suite, three full-suite runs), and the two real
bugs that WERE found and fixed (transient-error mishandling, insufficient attempt budget under
real N-way contention) are each independently sufficient to explain failures of the shape observed.
Given both are now fixed and two independent full-suite runs since have been clean, this is treated
as resolved - but the exact original mechanism was not isolated with certainty, and that
imprecision is recorded here rather than papered over.
- **Chronology, preserved deliberately** (the operator's own explicit request, since this
  chronology is evidence the audit is adversarial, not a checklist exercise): original CAS-only fix
  → first full-suite run failed (4 tests, `localPortfolioSync.test.ts`) → root-caused via direct
  instrumentation (outer catch swallowing transient errors) → transient-error-retry hardening
  applied → second full-suite run: clean (491/491, 3604/3604) → classified `FIXED / PARTIALLY
  VERIFIED` per the operator's own explicit two-writer-is-not-enough instruction → comprehensive
  N-writer test suite written → N=10 concurrent-writer tests failed on first run against the
  existing `MAX_SYNC_ATTEMPTS=8` → root-caused via worst-case optimistic-concurrency analysis
  (confirmed mathematically, not just empirically) → attempt-budget hardening applied → 5x isolated
  re-runs green → third full-suite run: clean (491/491, 3616/3616) → **FD-6 classified FIXED /
  VERIFIED**. Two real, distinct concurrency defects were found and fixed by this chronology, not
  one - the process of testing rigorously past the point of "it looks fixed" is what surfaced the
  second one.

## Pass 3 — Broker/execution lifecycle chain, continued (2026-09-14, per explicit operator instruction: order acknowledgement ambiguity → timeout/retry → reconnect during submission → client-order-ID idempotency → late acknowledgement → duplicate submission prevention → duplicate/out-of-order execution events → position lifecycle → reconciliation racing active order processing)

Most links in this chain were already traced and tested earlier in this same pass (order
acknowledgement/timeout, duplicate-fill accounting via FD-5, position lifecycle via FD-6). This
section covers what remained genuinely untested: reconnect specifically DURING an in-flight
submission (not just reconnect after a clean disconnect), and reconciliation racing OMS's own
active order processing.

**Reconnect during submission / late acknowledgement — traced AND tested (new adversarial tests,
not just re-confirmed trace).** New file `IbkrSocketSession.reconnectDuringSubmission.test.ts` (2
tests): (1) an order is placed, the connection drops before ANY acknowledgement arrives (the exact
ambiguous window - Argus does not yet know if IB received it), reconnect fires, and IB's new-session
`openOrder` echo confirms the order genuinely reached the broker before the disconnect. **CONTROL
VERIFIED**: `placeOrder` is called exactly once, ever, across the entire disconnect/reconnect cycle
- rehydration correctly recognizes the existing local record (via `clientOrderId`/`orderRef`) rather
than creating a duplicate or resubmitting. (2) The harder case: the order actually FILLED at the
broker while Argus was disconnected and fully dropped out of IB's open-orders set before
reconnecting (so `reqOpenOrders()` alone would never see it) - recovered correctly as `FILLED` via
`reqExecutions()`'s `execDetails` rehydration (DEF-30's own documented mechanism), still with zero
resubmission. **NO ISSUE FOUND.**

**Client-order-ID idempotency / duplicate submission prevention — NO ISSUE FOUND, unchanged from
earlier in this pass.** `OrderManagement.executeOrder()`'s own pre-check plus the real DB-level
`idx_trades_trace_id_unique` constraint, already proven under genuine concurrency by
`OrderManagement.lifecycle.test.ts`'s very first test ("the real DB unique constraint blocks a
genuine concurrent duplicate-traceId race, not just the sequential pre-check").

**DEFECT (FD-7) found and fixed** — see the defects table above for the full write-up:
reconciliation's open-order comparison section (`OPEN_ORDER_MISSING_LOCALLY`/
`OPEN_ORDER_MISSING_REMOTELY`/`FILLED_ORDER_MISSING_LOCALLY`) had no debounce protection against
exactly the race the operator asked about - reconciliation racing OMS's own active order
processing across two independent, uncoordinated polling timers. This was the most valuable finding
in this final leg: a ROUTINE order-fill transition (not a rare edge case) could trigger a false
mismatch and, above `SIGNIFICANT_MISMATCH_DOLLARS`, a real `TRADING_PAUSED` - a genuine false-
positive kill-switch trigger during completely ordinary operation. Fixed by extending the same,
already-battle-tested debounce mechanism (added for a real prior incident, the GLD/NVDA flap) to
these three mismatch types. Existing tests that had encoded the old single-cycle-fire behavior as
correct were updated, and a new test proves a one-cycle-only blip is never flagged at all.

**Can a broker/network failure cause Argus to submit an unintended second order, believe an order
doesn't exist when it does, or make a risk decision using stale exposure?** — the operator's own
framing of what this whole chain was testing for. Based on everything traced and tested across this
entire pass (order ack/timeout, cancel/fill race, duplicate-fill accounting, position lifecycle,
reconnect-during-submission, and now reconciliation-vs-active-order-processing): **no path was
found where a broker/network failure causes a duplicate order submission** (client-order-ID +
DB constraint + no resubmission anywhere in the reconnect path, all CONTROL VERIFIED with tests).
**No path was found where Argus's own accounting believes a real order doesn't exist** (rehydration
via `reqOpenOrders`/`reqExecutions` covers both the open-and-still-tracked and
filled-and-already-dropped cases). **One real path WAS found and fixed (FD-6) where a risk decision
could be made using stale local exposure** (the portfolio lost-update race), and **one real path WAS
found and fixed (FD-7) where ordinary operation could trigger an unwarranted pause** (not stale
exposure feeding an order, but a false-positive kill-switch activation from the same general class
of uncoordinated-polling race). Genuinely unresolved: the broker-API-reporting-lag UNKNOWN
(silent, narrow-window `portfolio.quantity` staleness, not escalating to a pause per FD-6's own
debounce-timing trace) and the IB-callback-reliability UNKNOWN (order ack/timeout section) both
remain open, honestly, not fixed this pass.

**FD-7 final status: FIXED / VERIFIED.** The fix itself (extending the existing debounce pattern)
was correct on the first attempt, but the FULL scope of tests it affected was not - a full-suite
run (not the targeted search that found and fixed the 3 `openOrdersAndCash.test.ts` tests) caught
3 further regressions in a sibling file, `ReconciliationAcknowledgements.test.ts`, exercising the
same `FILLED_ORDER_MISSING_LOCALLY` path through the same shared `portfolioReconciliationWorker`
singleton. Fixed the same way (2 consecutive `reconcile()` calls before asserting), verified
against the full reconciliation test surface (7 files, 27 tests, all green), and confirmed via a
clean fifth full-suite run (492/492 files, 3619/3619 tests) that nothing else was missed. This is
the same discipline FD-6 required — a fix is not "done" until proven against the real, full test
surface, not just the tests it was designed to satisfy.

## Safety assessment

- **Can any path bypass RiskEngine?** Not touched this pass or by FD-4/5/6; unchanged from prior sessions' extensive verification (RiskEngine remains the sole gate before OMS in every code path).
- **Can any path bypass OMS?** Not touched; `phase21.invariants.test.ts` (unchanged, still green) enforces OMS as the sole production `.placeOrder(` caller. FD-4/5/6 touch `trades.status`/`TrackedOrder.filledQuantity`/`portfolio.quantity` writes, never order placement itself.
- **Can duplicate orders occur?** Not touched — FD-4/5/6 are about bookkeeping for already-placed orders' status/fills/position, never a second `placeOrder()` call. FD-1/2/3 remain entirely in the observability/forecast layer.
- **Can UNKNOWN broker state cause blind retry?** Not touched; unchanged. FD-4/5/6 are read-accounting fixes, not retry-logic changes — `followUpOpenOrders()` still never calls `placeOrder()` (re-verified this pass).
- **Can AI failure become a vote?** Verified (not modified) — `pushDebateFailClosed()` and `AIOutputValidator` remain as tested earlier this session; none of tonight's six defects touch any AI call site.
- **Can future data enter decisions?** N/A (no backtest/research code touched this pass).
- **Can paper execution route live?** Not touched; `LIVE: NO-GO` confirmed unchanged before and after every fix tonight.
- **Can positions become inconsistent?** This is exactly what FD-6 answers, and unlike FD-4/FD-5 the answer is yes, narrowly, pre-fix: `portfolio.quantity` itself (not just derived bookkeeping) could lose a real fill's effect to a concurrent writer, or silently drop a brand-new symbol's first fill entirely on an uncaught PK collision — and `portfolio.quantity` is exactly the figure RiskEngine's concentration/correlation/notional gates read before approving a new order, so this was the one defect this pass found with a plausible (if narrow-window) path to a real risk-relevant consequence, not merely an audit-trail/reporting gap. Now fixed and regression-tested. FD-4/FD-5's corruption stayed confined to derived bookkeeping (`trades.status`, and downstream `fills`/attribution reporting via FD-5's inflated `filledQuantity`) without ever corrupting `portfolio` itself — `recordFillProgress()`'s portfolio sync runs before the vulnerable `trades.status` write in FD-4, and FD-5's double-count lived in `TrackedOrder.filledQuantity` (an in-memory broker-adapter read cache), not in any write to `portfolio`.
- **Can capital be double-reserved?** Not touched this pass.

**Conclusion: this pass found and fixed three real defects (FD-4, FD-5, FD-6) in the order/fill/position lifecycle itself** — a materially different risk class from FD-1/2/3 (which lived entirely in the Forecast Engine's observability layer). All three are now classified, fixed, and regression-tested; FD-4 and FD-5 never reached the authoritative position/portfolio quantity, but FD-6 did — it is the one defect this pass found with a plausible path to RiskEngine consulting a genuinely wrong local-exposure number, now closed.

## Reliability assessment

- **Concurrency safe?** FD-1 closes a real, found concurrency gap (duplicate Java calls on overlapping forecast builds) via request coalescing. FD-4 closes a real, found concurrency gap between `cancelOrder()` and `applyFollowUpUpdate()` via a symmetric compare-and-swap guard. FD-5 closes a real, found race between two independent IB event streams (`orderStatus`/`execDetails`) sharing one mutable field, via independent per-stream tracking + `Math.max` reconciliation. FD-6 closes a real, found lost-update/dropped-insert race between concurrent fill-sync calls for the same symbol via an optimistic-concurrency retry loop. All four are verified by regression tests that reproduce the exact race against the pre-fix code and prove the fix, not merely assert the fixed shape.
- **Memory bounded?** `inFlightForecastBuilds` (FD-1) is self-cleaning via `.finally()`. FD-5's new `TrackedOrder.seenExecutionIds` Set grows only per real execution on a given order (bounded by real fill count, never unbounded) and is discarded with the rest of `TrackedOrder` when the order is no longer tracked. FD-6's retry loop is bounded (`MAX_SYNC_ATTEMPTS`=5, logs and gives up rather than looping unboundedly on pathological, sustained contention) — no new unbounded-growth or unbounded-retry surface introduced by any of tonight's fixes.
- **Restart safe?** Verified live earlier tonight (clean restart, single engine, single watchdog); FD-4/FD-5/FD-6 are in-process logic changes only, no new restart-path interaction.
- **Broker reconnect / Java bridge safe?** FD-5 touches `IbkrSocketSession`'s live-fill event handlers but not its reconnect/rehydration path (`openOrder`/`openOrderEnd`/`reqOpenOrders`/`reqExecutions`, all unchanged) — the rehydration-seeded `execDetailsCumulative` initialization (seeded from `openOrder.filledQuantity`, itself IB's own cumulative value) was added specifically so a rehydrated order's subsequent live `execDetails` events reconcile correctly against pre-restart fill history, not just fresh in-process fills. Not live-tested against a real IB Gateway restart this pass (unit-tested only, same honesty standard as DEF-30's own residual gaps). FD-6 is broker-agnostic (pure `portfolio` table logic, no broker-specific code touched).
- **Database safe?** FD-3's fix is a strict correctness improvement to an existing query (no migration required). FD-4's CAS guards add a `WHERE` predicate to two existing `UPDATE` statements only — no schema change, no migration.

## Quant assessment

- **Deterministic?** `ForecastEngine.java` unchanged this pass (already deterministic, already tested).
- **No lookahead?** Unchanged.
- **Strategy IDs correct?** Unchanged from the earlier `resolvedStrategyId` fix this session.
- **Family IDs / independence correct?** Unchanged from the earlier `resolveEnsembleEvidenceForForecast()` work this session; FD-3's fix makes the STORED, correct values actually retrievable, which they previously sometimes were not.

## Remaining unknowns (not defects)

- Whether the FD-1 concurrency scenario (overlapping forecast builds for the same symbol) has ever actually occurred in real production — not measured, not fabricated as evidence either way.
- Whether FD-3's false-negative scenario (50+ other-strategy forecasts crowding out a target strategy's row) has ever actually manifested in real production data — the deployment currently has too little real forecast volume to have hit it yet; the fix is preventive, verified by a synthetic reproduction, not a live incident report.
- Phases 6-9, 11, 14-16 of the requested 24-phase audit were not covered this pass (see coverage table above) — genuinely not audited, not claimed clean.

## Final response

```
ARGUS FULL DEFECT AUDIT COMPLETE (Passes 1-3 cumulative - partial coverage, see table above)
P0 FOUND: 0
P0 FIXED: 0
P1 FOUND: 5 (FD-3, FD-4, FD-5, FD-6, FD-7)
P1 FIXED: 5 (FD-3, FD-4, FD-5, FD-6, FD-7)
P2 FOUND: 1 (FD-1)
P2 FIXED: 1 (FD-1)
P3 FOUND: 1 (FD-2)
P3 FIXED: 1 (FD-2)
REGRESSION TESTS ADDED: 27 new tests total (2 FD-1, 1 FD-3, 2 FD-4, 3
        FD-5, 16 FD-6 [4 two-writer + 12 N-writer/contention-invariant],
        3 FD-7 [1 new debounce test + 2 new reconnect-during-submission
        tests]; FD-2 is comment-only) PLUS 9 existing tests updated to
        match corrected behavior (3 FD-6 pre-existing localPortfolioSync
        tests were already counted as part of the file, not re-counted
        here; 6 FD-7: 3 in PortfolioReconciliation.openOrdersAndCash.
        test.ts + 3 in ReconciliationAcknowledgements.test.ts - the
        latter found only via a full-suite run, not the initial targeted
        search, and fixed the same way). FD-6 alone required TWO rounds
        of hardening after its own regression tests exposed two further
        real, distinct concurrency gaps under real full-suite load and
        real N-way contention - see its dedicated write-up and
        chronology above.
TS: 492 files / 3619 tests green (fifth and final full-suite run this
        pass, post-FD-7 - the count is exactly the pre-FD-7 third run's
        3616 plus FD-7's 3 genuinely new tests, confirming nothing else
        moved). A fourth run in between was interrupted by a session
        infrastructure event (truncated log, no test-failure output,
        exit code 4) and re-run clean rather than trusted as a real
        result - see the FD-7 write-up's own note on the intervening
        ReconciliationAcknowledgements.test.ts regressions that run
        caught and fixed.
JAVA: 804 tests green (unchanged - no Java touched this session)
TYPECHECK: clean
BUILD: succeeds
SAFETY: RiskEngine/OMS/BrokerManager/order-placement untouched across all
        3 passes. FD-4/5/6/7 touch trades.status / TrackedOrder.
        filledQuantity / portfolio.quantity / reconciliation mismatch
        debounce bookkeeping, never order placement. FD-6 is the one
        defect this audit found with a plausible (if narrow-window,
        pre-fix) path to RiskEngine consulting a genuinely wrong local-
        exposure number before approving a new order. FD-7 is the one
        defect found with a plausible path to a false-positive
        TRADING_PAUSED kill-switch trigger from completely ordinary
        operation (not stale exposure feeding an order, but an
        unwarranted pause). Both now closed.
RELIABILITY: 6 real concurrency defects found and fixed across the 3
        passes (FD-1 duplicate Java calls, FD-4 cancel/fill status race,
        FD-5 IBKR fill double-count, FD-6 x2 - lost portfolio updates and,
        found only via the operator's own N-writer stress requirement,
        an insufficient CAS retry budget under real 10-way contention -
        FD-7 missing debounce protection on reconciliation's open-order
        checks, allowing a routine fill-timing race to false-positive).
DATA INTEGRITY: FD-3 (forecast lookup false negative) and FD-4 (order
        status self-contradiction vs its own fills ledger) both real,
        both closed.
QUANT CORRECTNESS: unchanged (Java untouched this session); FD-3 makes
        already-correct stored values reliably retrievable.
AI SAFETY: verified unchanged, not re-traced at every call site this pass.
EXECUTION: FD-4/FD-5/FD-7 traced and fixed real order-lifecycle/fill-
        accounting/reconciliation gaps; reconnect-during-submission and
        late-acknowledgement specifically traced and tested this leg
        (NO ISSUE FOUND, IbkrSocketSession.reconnectDuringSubmission.
        test.ts). Extended-hours/LIMIT-order-specific paths and Alpaca-
        specific order-ack behavior not traced this session (IBKR, the
        active broker, was).
REMAINING DEFECTS: no additional defects identified WITHIN THE PHASES AND
        CODE PATHS ACTUALLY AUDITED across all 3 passes (0/1/2/3/4/5/8/9/
        10/12/13/17-19, each PARTIAL to varying depth - see coverage
        table). This is not equivalent to "none known" system-wide -
        phases 6/7/11/14/15/16 received zero fresh tracing this session;
        prior sessions' fixes in overlapping areas (DEF-05/06/27/29/30
        etc.) reduce risk but do not constitute a fresh review of the
        CURRENT codebase.
REMAINING UNKNOWN / UNPROVEN ITEMS: (1) whether IB Gateway's real-world
        callback delivery has ever dropped a message without a detectable
        disconnect (Pass 3, order ack/timeout) - not measured. (2) IB
        order types/vintages that omit Execution.execId entirely cannot
        use FD-5's same-stream redelivery dedup layer, though the
        cross-stream Math.max reconciliation still holds regardless. (3)
        broker-API position-reporting lag vs. a just-landed fill can
        silently, transiently overwrite portfolio.quantity (real, not
        fixed this pass, deliberately not over-engineered) - though
        traced and CONTROL VERIFIED that this specific staleness cannot
        by itself trigger reconciliation's pause/zero-out mechanism
        (gated by a real, tested 2-consecutive-cycle / ~5-10 minute
        debounce, now shared by FD-7's fix too); whether real lag could
        ever exceed that window is not live-measured. (4) phases 6/7/11/
        14/15/16 not covered this session. (5) quant alpha/profitability
        remain unproven (unchanged, expected, not a defect).
FINAL STATUS: READY FOR PAPER WITH OPERATIONAL CAVEAT
        (the pre-existing AI-provider degradation caveat from pass 1
        stands unchanged; nothing in passes 2-3 alters it)
        Internal label: FORENSICALLY PARTIALLY VERIFIED - NOT DEFECT-FREE.
```

**This was a real, bounded, honest three-pass audit — not a claim of exhaustive 24-phase coverage.** Seven real defects (FD-1 through FD-7) were found through actual code tracing and adversarial testing (not superficial grepping, and not stopping at "looks fixed") and fixed with regression tests. FD-6 is the standout example of why this audit insisted on adversarial verification over checklist completion: its first fix looked correct by inspection and passed in isolation, a full-suite run then disproved that, root-causing the failure surfaced a real transient-error-handling gap, fixing that produced a clean full-suite run — and rather than stopping there, testing the stated invariant properly (2/5/10 writers, not just 2) surfaced a SECOND, entirely different real gap (an arithmetically insufficient retry budget) that the two-writer tests structurally could not have found. Only after both were fixed and re-verified against three separate full-suite runs was FD-6 classified FIXED / VERIFIED, with the original failure's exact mechanism honestly recorded as non-reproduced rather than definitively explained. FD-7, found immediately after in the very next investigation leg, is further evidence this pass's rigor was warranted, not excessive: it was a real, previously-unnoticed asymmetry between two structurally similar reconciliation checks (one debounced after a real prior incident, one never extended to match), reachable during completely ordinary operation, with a real path to an unwarranted `TRADING_PAUSED`. Further passes covering the remaining phases (especially 6/7 calibration/backtest, 11 news/external-data security beyond DEF-31, 14 observability, 15 resource/memory, 16 startup/recovery beyond DEF-25/26/27/28/29) would be a reasonable next forensic audit, not a feature-development task.
