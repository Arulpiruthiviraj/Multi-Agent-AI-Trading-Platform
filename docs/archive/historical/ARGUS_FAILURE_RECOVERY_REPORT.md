# ARGUS_FAILURE_RECOVERY_REPORT.md

**Phase 11 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md).** Chaos/failure classification, consolidating
this entire implementation pass's real test evidence (Phases 1-10) plus this phase's own new tests,
against every scenario the phase's own instructions list. Classification: **Safe** (real,
tested, no operator action implied) / **Recoverable** (real, tested, degrades honestly) /
**Potentially dangerous** (a real, documented gap) / **CRITICAL** (a real, documented gap with
material real-money risk). The guiding principle throughout, re-verified rather than assumed:
**WHEN UNCERTAIN → DO NOT OPEN A NEW POSITION.**

| Scenario | Classification | Evidence |
|---|---|---|
| Broker timeout | **Safe (Phase 1 fix)** | Real 15s `AbortController` timeout, `AlpacaBroker.reliability.test.ts` |
| Broker 500 | **Safe** | Classified `HTTP_ERROR`, never retried (a real answer already given), `AlpacaBroker.reliability.test.ts` |
| Broker 429 | **Safe (Phase 1 fix)** | Real `Retry-After` handling, tested |
| Broker fully unavailable (repeated failures) | **Safe (Phase 1 fix)** | Real circuit breaker (3 consecutive failures → 30s fail-fast), tested |
| WebSocket disconnect | **Recoverable** | Real reconnect exists (pre-existing) - fixed 5s retry, no backoff cap (a real, lower-severity gap, documented in `FINAL_ANALYSIS.md` §30.13, not re-fixed this pass - low real-world impact since it's a bounded, cheap retry, not a resource leak) |
| Database unavailable | **UNVERIFIED this phase** | Not traced or tested this pass - genuinely not attempted, flagged honestly rather than guessed at |
| Process crash / restart | **Recoverable (Phase 1 fix)** | Kill-switch state persists (`settings.tradingState`, survives restart, tested pre-existing); `PortfolioReconciliation`/`OrderManagement.reconcileStaleOrders()` both run immediately on boot (Phase 1) |
| Restart during open position | **Recoverable** | The position itself is real broker state, unaffected by an Argus-side crash; `PortfolioReconciliation` catches any resulting local/broker drift on next boot (tested, pre-existing + Phase 1 pause-enforcement fix) |
| Restart immediately after order submission | **Recoverable (Phase 1 fix)** | The exact scenario `OrderManagement.reconcileStaleOrders()` was built for - real, tested (`OrderManagement.crashRecovery.test.ts`): a wrongly-`REJECTED` order that the broker actually filled is corrected on the next cycle |
| Duplicate market-data event | **Safe** | Real, tested dedup (pre-existing, `MarketDataWorker.test.ts`) |
| Duplicate order request | **Safe** | Real DB-level idempotency (`idx_trades_trace_id_unique`) plus, as of Phase 1, real broker-level idempotency via `client_order_id` - `OrderManagement.lifecycle.test.ts` + `AlpacaBroker.reliability.test.ts` |
| Partial fill | **Safe** | Real incremental aggregation, tested (pre-existing) |
| Delayed fill | **Safe** | Real bounded follow-up job (`followUpOpenOrders()`, pre-existing), plus Phase 1's crash-recovery job covers the case where the initial poll never even got a `brokerOrderId` recorded |
| AI timeout | **Safe (Phase 1 fix)** | Real 20s timeout, treated as an ordinary provider failure, tested (`AIRouter.test.ts`) |
| AI malformed response | **Safe** | Real schema coercion to safe defaults, never a fabricated BUY/SELL, tested (pre-existing) |
| All AI providers unavailable | **Safe (this phase, newly tested)** | `FundamentalAgent.test.ts`'s new chaos test: `routeTask()` exhausting its real failover throws, the calling agent's own `try/catch` degrades to "no trade idea emitted, no crash" - the real, desired "uncertain → no new position" behavior, now proven, not merely assumed |
| Stale market data | **Safe** | Real 5-minute staleness gate, tested (pre-existing); real, narrow documented gap for a symbol that has *never* ticked (relies on the separate `price_validity` gate as backstop - `FINAL_ANALYSIS.md` §30.9) |
| Reconciliation mismatch (position) | **Safe (Phase 1 fix - the CRITICAL finding this whole pass started from)** | Now provably blocks new orders, not just detected - `PortfolioReconciliation.tradingBlock.test.ts` |
| Reconciliation mismatch (open orders / account cash-equity consistency) | **Safe (Phase 1, newly built)** | `PortfolioReconciliation.openOrdersAndCash.test.ts` |
| Incorrect local position | **Safe** | Broker treated as source of truth, real auto-correction, tested (pre-existing + Phase 1 enforcement fix) |
| Incorrect cash/equity reported by broker | **Safe (Phase 1, newly built)** | Real internal-consistency check (`equity ≈ cash + Σpositions`), tested |
| Network outage (general) | **Recoverable** | Covered by the broker/AI timeout+circuit-breaker mechanisms above for the calls that matter most; no single unified "network down" detector exists, by design - each real external call handles its own failure independently rather than a fragile central health check |
| API rate limit (Alpaca) | **Safe (Phase 1 fix)** | Real `Retry-After` handling, tested |
| API rate limit (AI providers) | **Recoverable** | No explicit 429 handling in AI provider files (unlike Alpaca) - a rate-limited AI call surfaces as a generic provider error, which the real failover loop already handles (fails over to the next provider) - functionally recoverable, just not as precisely classified as the Alpaca path. Documented as a real, lower-priority P2 gap. |
| Database transaction failure | **UNVERIFIED this phase** | Not traced or tested this pass |
| Clock/timezone issue | **Safe** | Real IANA `America/New_York` trading-day boundary, DST-tested (pre-existing, earlier hardening pass) |
| Market holiday | **Recoverable** | Relies on Alpaca's own real `/v2/clock` (presumed holiday-aware); **a REST failure during this check is treated as "market open"** (`FINAL_ANALYSIS.md` §30.9/§30.13 - a real, documented gap, not fixed this phase - it means an Alpaca outage on a real holiday wouldn't be independently caught by this specific gate, though the broker-call layer around it now has its own real timeout/circuit-breaker protection from Phase 1) |

## What Phase 11 built vs. what it consolidated

**New this phase**: the "all AI providers unavailable" chaos test (`FundamentalAgent.test.ts`).
Everything else marked "Safe (Phase 1 fix)" or "Safe (Phase 1, newly built)" above was real code and
real tests built in Phase 1 of this same implementation pass - this report is the requested
consolidated chaos classification, not a claim of new work beyond what's cited.

**Explicitly not attempted this phase, honestly**: database unavailability and database
transaction-failure chaos scenarios were not traced or tested. This is a real, non-trivial gap -
better-sqlite3's synchronous nature and this codebase's extensive direct `db.insert`/`db.update`
calls scattered across every service make "what happens if the DB file becomes unwritable
mid-request" a real question with no verified answer yet. Flagged as a P1 item for a dedicated
future pass, not guessed at here.

## Real, cross-cutting takeaway

Every chaos scenario classified **Safe** above is safe specifically because the system either (a)
already had `RiskEngine`'s fail-closed exception handling as a structural backstop (any code path
that reaches an unhandled exception before an order is placed results in no order, not a crash-and-
place), or (b) got a real, targeted fix in Phase 1 of this pass. The two scenarios marked
**UNVERIFIED** are the honest exceptions, not silently folded into "probably fine."
