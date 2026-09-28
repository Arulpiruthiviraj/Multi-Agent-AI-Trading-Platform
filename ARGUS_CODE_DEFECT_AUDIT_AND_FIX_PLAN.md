# Argus — Repository Coding Defect Audit and Fix Plan

Audit date: September 27, 2026. Source HEAD: `9ed245e1a48776ea29c787ea6d65d22a41157a57`.

**Analysis only. No application code, configuration, database, runtime flag or order was changed.** This dated audit supplements the master redesign proposal; it does not replace the living architecture reference or authorize implementation. Protected-component fixes require a separately authorized change that preserves ChiefTrader → RiskEngine → PositionSizing → OMS → BrokerManager and all paper/live controls. New quantitative calculations and applicable calculation fixes belong in Java under the repository ownership rules.

## Implementation follow-up — September 27, 2026

The owner subsequently authorized fixing the findings one after another. The original audit below remains a record of the pre-fix source; its analysis-only statement describes that audit, not the later authorized implementation.

Implemented with regression coverage: **F01–F03, F05–F07, F09–F25, F27–F28, F30 and F35**. This is a source/test status, not deployment, trading readiness or evidence of edge. Broader validation is still in progress at this checkpoint.

- **F04 (2026-09-27 follow-up, reopened then completed):** the fill ledger's own rejection of missing/non-finite quantities/prices (`fillLedger.ts`) was already correct, but `OrderManagement.ts`'s `recordFillProgress()` returned a bare `number`, so all three callers (`executeOrder()`'s initial poll, the crash-recovery loop in `reconcileStaleOrders()`, and `applyFollowUpUpdate()`) never observed a rejection and unconditionally re-stamped the broker-reported status (e.g. `FILLED`) over the `RECONCILIATION_REQUIRED` the helper had just written, then broadcast a false `ORDER_EXECUTED`/`ORDER_FILLED`-shaped event. Fixed by changing the return type to `{ newQty, reconciliationRequired }` and having every caller fold `reconciliationRequired` into its own subsequent status write/event instead of ignoring it. A second, related defect surfaced by the new crash-recovery regression test: that same loop wrote `price: realOrder.averageFillPrice ?? row.price`, and `??` does not catch `NaN` (only `null`/`undefined`), so a NaN fill price crashed the entire reconciliation loop on a SQLite NOT NULL constraint instead of degrading to `RECONCILIATION_REQUIRED` — fixed with an explicit `Number.isFinite` check. Regression coverage: `OrderManagement.lifecycle.test.ts` (new test exercising the initial-poll call site directly via a controllable `placeOrderResponseOverride`, plus the pre-existing follow-up-path F04 test, now also verified robust against a same-cycle repeat-rejection edge case the old CAS-guard-only protection did not cover), `OrderManagement.crashRecovery.test.ts` (new test exercising the crash-recovery call site, asserting both the persisted `trades.status` and the `ORDER_EXECUTED` event payload never read FILLED on rejected fill evidence). 27/27 tests pass across the three affected files; `tsc --noEmit` clean.
- **F08:** winter/summer regular-session expiry now uses America/New_York wall time. Exchange holidays and early-close session schedules remain unresolved; the current helper is a timezone conversion, not a complete exchange calendar. **Status remains PARTIAL, not closed** — an uncertainty label on the assumption is not equivalent to implementing an exchange calendar, and this entry must not be read as F08 being resolved.

Still open: **F26** (unknown Coinbase valuation/cost basis), **F29** (outbound redirect/DNS binding), **F31–F32** (webhook validation and bounded delivery), **F33–F34** (UI asynchronous request lifecycle), and **F36–F37** (Java/Python request/admission bounds).

Next sequence: complete F04 reconciliation semantics; complete F26 without representing unknown economics as zero; fix F29/F31/F32 together around one bounded outbound transport; then UI and inference admission defects. F08 needs an authoritative exchange-session source. Retain the existing trading spine and all safety thresholds throughout.

Limitations: no production restart, historical ledger rewrite, external account change or real order was performed. Existing corrupt historical fill rows are not automatically repaired. Coinbase balances now include held quantities and all paginated wallets, but USDC still follows the adapter's pre-existing dollar-equivalent treatment; price/cost-basis honesty remains F26. Rejecting unsupported Coinbase STOP orders is deliberate—STOP execution support was not introduced.

Coinbase pagination fields were checked against the official [accounts](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/accounts/list-accounts) and [orders](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-orders) API references. External brokerage operation remains unverified.

## Main conclusion

Fix accounting and data integrity before increasing trading activity. The most consequential findings are in the common fill ledger, broker attribution, backup correctness, crypto order validation, discovery metrics and freshness handling. A successful typecheck does not detect these logical failures.

This report records **37 actionable coding findings**, followed by integration limitations and unresolved review questions. Severity is based on potential impact under the stated trigger, not a claim that a production incident occurred. There is no demonstrated P0 incident in this audit. Several P1 findings warrant repair before relying on affected execution or research results.

The strongest new reproductions are:

- A broker cumulative fill of two units at average price $11 becomes $21 of ledger value instead of $22.
- Two concurrent cumulative-fill observations of one and two units can produce three ledger units.
- A crypto PAPER buy/sell round trip with $2 total fees reports only $1 loss.
- Concurrent crypto PAPER SELL orders can report 1.5 units sold from one unit of inventory.
- Modifying a pending crypto PAPER BUY to quantity −1 creates a negative position and increases cash from $1,000 to $1,101 in the isolated fixture.
- A stopped crypto ingestion worker still writes results from requests already in flight.
- An IPv4-mapped IPv6 loopback result in hexadecimal form passes the outbound URL guard.

These are isolated diagnostic results, not real trades, market outcomes or an operational certification.

## Scope and evidence limits

The repository-wide inventory covered `src`, `scripts`, `quant-core-java/src/main`, `database`, root server/build/test configuration and the previously identified trading paths. The four main inventoried roots contain 1,664 files: 1,348 under `src`, 92 under `scripts`, 223 Java main-source files and one database entrypoint. Within these roots there are 583 `.test.ts`-style test files and 1,074 non-test files with TS/TSX/Java/Python/MJS/shell extensions. Images and other assets account for the remainder. Additional root files and configuration were inspected separately.

**Coverage is repository-wide inventory, cross-cutting searches, targeted source tracing and isolated reproductions—not a line-by-line certification of all 1,074 source files.** No finite audit can honestly guarantee that this is every defect. Java numerical routines beyond the named findings, every API branch, browser interaction and live broker behavior remain incompletely verified. Third-party dependencies, generated output and sibling/vendor systems were not represented as fully audited first-party code.

Review concentrated on execution, fills, portfolio/risk interfaces, crypto adapters, market data/discovery, calendars, research economics, backups, outbound URL security, server boundaries, Python inference and representative frontend polling/state. Known old issues marked fixed in repository instructions were not reopened merely from their historical descriptions.

### Checks performed

1. `node node_modules/typescript/bin/tsc --noEmit --incremental false`: **PASS**, exit 0. No output files generated. The repository configuration uses `skipLibCheck` and does not enable the full strictness suite; this is its configured check, not proof of runtime validation.
2. AST parsing of all 10 Python files under `scripts`, using `python -B`: **PASS**, no syntax errors; no model/service imports and no bytecode writes.
3. Actual TypeScript source was transpiled in memory and evaluated with an explicit dependency allowlist for CryptoPaperBroker, fillLedger, CryptoMarketDataIngestion and urlSafety. Fake dependencies replaced configuration, persistence, timers, logging and DNS. Unrecognized imports were blocked. No database, broker, network or application bootstrap was opened by these harnesses.
4. The winter expiry expression was evaluated with the real `America/New_York` formatter.
5. Source/test inspection and primary provider documentation checks supported findings that were not executed.

No full Vitest/Maven/browser suite was run. The standard Vitest setup and several tests initialize and migrate temporary databases; this analysis-only pass avoided those effects and any accidental application startup. Existing test source is evidence of coverage intent, not a new passing test result. Production databases, credentials and `.env` were not inspected in this pass.

### Evidence and severity

- **SOURCE_VERIFIED:** the current implementation establishes the behavior under the specified inputs.
- **ISOLATED_REPRODUCED:** executed the current source in an isolated harness; limitations are stated. This is not production/integration verification.
- **CONTRACT_VERIFIED:** source conflicts with the linked provider/standard contract.
- **INTEGRATION_RISK / UNVERIFIED:** a plausible or source-visible gap whose full runtime consequence has not been established.
- **P1:** execution/accounting/security/data-loss impact or material corruption of evidence.
- **P2:** incorrect results, availability or observability under specific conditions.

Source locators below are relative to `C:\WorkProjects\Multi-Agent-AI-Trading-Platform`; line numbers refer to the audited revision. Proposed fixes include regression specifications, not completed implementation.

## A. Common execution, accounting and backup defects

### F01 — P1: Cumulative average fill price is written as incremental fill price

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `src/server/services/fillLedger.ts:34–56`; `OrderManagement.ts:279–290`; `localPortfolioSync.ts`, `syncLocalPortfolioAfterBuyFill`.

The ledger correctly subtracts prior quantity but assigns the broker's cumulative average price to the new quantity. With one unit at $10 followed by a cumulative two units at average $11, the second unit actually cost $12. Current rows become 1×$10 and 1×$11, totaling $21 rather than $22. OMS also feeds the cumulative average into incremental local basis updates. Distorts fill economics, cost attribution and transient portfolio basis.

**Fix:** preferably consume individual broker executions with stable execution IDs. If only cumulative quantity/VWAP is available, derive incremental notional from cumulative notional minus prior accounted notional, then derive the delta price. Handle corrections explicitly; do not invent a price when notional is unavailable. Return the verified delta price/notional to OMS and local portfolio synchronization.

**Verification:** 1@$10 then cumulative 2@$11 must produce a $12 second fill, $22 total notional and $11 position basis. Cover more partials, repeated reports, corrected VWAP, missing prices and SELL attribution. Existing `fillLedger.test.ts` checks sequential quantities but not notional conservation.

### F02 — P1: Different cumulative fill watermarks can race and overcount

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED with an asynchronous in-memory database substitute. `fillLedger.ts:32–56` reads prior fills and inserts later without one serialized transaction. Unique cumulative-watermark identity blocks equal duplicates, not different concurrent watermarks.

Two calls can both read zero prior quantity, then insert quantities one and two under distinct watermark keys. The executed harness produced three units for a broker cumulative total of two. This establishes the algorithmic interleaving; it is not a reproduced production SQLite incident.

**Fix:** perform watermark comparison and delta insertion atomically through the existing single-writer database boundary, with a monotonic order-level watermark and notional state. Serialize per order or use a transactional compare-and-set that remains correct across all entry paths. Preserve broker execution-ID deduplication. Do not merely add another unique key to the already distinct rows.

**Verification:** real isolated SQLite integration tests with concurrent 1/2/3, repeated equal watermarks and out-of-order reports must preserve quantity/notional. Include restart and correction behavior. Fix together with F01 before changing downstream accounting.

### F03 — P1: Follow-up BUY fills can be attributed to the wrong broker

**Evidence:** SOURCE_VERIFIED. `OrderManagement.ts:284–290` resolves `getActiveBroker()` while synchronizing a BUY fill. Follow-up polling elsewhere deliberately routes using the order's recorded broker.

If an order was placed with broker A and broker B becomes active before its delayed fill, the local holding can be stamped with B. The SELL route uses holding broker source, making this more than a display issue. Runtime occurrence was not measured.

**Fix:** pass immutable resolved broker/account identity from the trade/order into `recordFillProgress` and portfolio synchronization. Never infer historical execution ownership from current selection. Reject unresolved attribution or reconcile it explicitly.

**Verification:** submit with A, switch active selection to B, process a late A BUY fill, then verify holding attribution and a future SELL resolve to A. Include overlapping symbols across accounts; do not bypass OMS to test routing.

### F04 — P1: Missing or invalid fill economics can become a recorded zero-price fill

**Evidence:** SOURCE_VERIFIED. `fillLedger.ts:27–44` accepts positive numeric quantities without a finite check and uses `averageFillPrice || 0`. Undefined/NaN price becomes zero; Infinity quantity is also not excluded. FILLED with missing quantity falls back to requested quantity for historical mock compatibility.

**Fix:** establish a broker-report contract that distinguishes missing execution information from an actual fill. Require finite positive quantity/price and reconcile impossible cumulative quantities. Preserve an explicit incomplete execution observation without recording fabricated economic facts. Update test mocks rather than embedding unsupported broker facts to satisfy them. If a broker's FILLED status legitimately proves quantity, document and validate that adapter-specific contract.

**Verification:** undefined, NaN, Infinity, zero/negative prices, overfills, and FILLED-with-missing-fields must not create zero-cost inventory or false economic completeness. Unknown order state must remain visible for reconciliation.

**2026-09-27 reopening and completion.** The fix above (`fillLedger.ts` rejecting invalid evidence) was already correct and unchanged. The gap the owner identified was one level up: `OrderManagement.ts`'s private `recordFillProgress(...)` — the single helper all three fill-recording call sites share — caught that rejection, marked the `trades` row `RECONCILIATION_REQUIRED`, and returned a **bare `number`** with no signal distinguishing "0 new quantity, nothing to record" from "fill evidence was rejected." None of its three callers ever inspected the return value:

- `executeOrder()`'s own initial post-placement poll (around what was line 554) called it, then a few lines later unconditionally wrote `db.update(trades).set({ status, ... })` using its own locally-tracked broker status (e.g. `FILLED`), clobbering the `RECONCILIATION_REQUIRED` the helper had just persisted, and emitted `ORDER_EXECUTED` with that same false status.
- The crash-recovery loop inside `reconcileStaleOrders()` (around what was line 950) did the identical thing with `realStatus`.
- `applyFollowUpUpdate()` (the async background follow-up path, around what was line 981) did the same with `match.status`, though it happened to be partly shielded in the common case by a pre-existing, unrelated CAS concurrency guard (`.where(eq(trades.status, row.status))`) — which does **not** protect a row that was already `RECONCILIATION_REQUIRED` going into the same cycle (a repeat-rejection retry), since the guard would see no status change and let the overwrite through.

**Fix implemented:** `recordFillProgress()` now returns `{ newQty: number; reconciliationRequired: boolean }`. All three callers check `reconciliationRequired` and, when true, use `RECONCILIATION_REQUIRED` (not the broker-reported status) for their own subsequent `trades` write and `ORDER_EXECUTED`/`emitOrderExecution` event. The crash-recovery path's transaction-registry update (`updateTransactionStatus(..., 'RECONCILED', { closed: true })`) is now skipped on a rejected fill rather than falsely closing the transaction as resolved.

**Second defect found via the new regression test:** the crash-recovery loop's status/event write also used `price: realOrder.averageFillPrice ?? row.price`. Nullish-coalescing does not catch `NaN` (only `null`/`undefined` are "nullish"), so a NaN fill price — exactly the invalid-economics case this fix exists for — passed straight through to a NOT-NULL SQLite column and crashed the entire reconciliation loop with `SqliteError: NOT NULL constraint failed: trades.price` (better-sqlite3 binds `NaN` as SQL `NULL`) instead of degrading to `RECONCILIATION_REQUIRED`. The other two call sites already avoided this via truthy/`||` checks (`NaN` is falsy in JS); only the crash-recovery site used `??`. Fixed with an explicit `Number.isFinite(...)` check.

**Verification (2026-09-27):** three new/extended regression tests exercise the real execution and recovery paths end-to-end, not just the helper in isolation — `OrderManagement.lifecycle.test.ts` (initial-poll call site, via a new controllable `placeOrderResponseOverride` on the stub broker returning `FILLED`/NaN directly from `placeOrder()`) and `OrderManagement.crashRecovery.test.ts` (crash-recovery call site, asserting both the persisted `trades.status` and the captured `ORDER_EXECUTED` event payload never read `FILLED`). The pre-existing follow-up-path test in `OrderManagement.lifecycle.test.ts` continues to pass and was confirmed to exercise the same-cycle repeat-rejection edge case correctly under the new explicit check. 27/27 tests green across the three files; `tsc --noEmit` clean. **F04 status: implemented and tested**, not deployed and not evidence of trading readiness.

### F05 — P1: Backup copies a live SQLite main file without a consistent snapshot boundary

**Evidence:** SOURCE_VERIFIED, CONTRACT_VERIFIED. `src/server/services/DbBackupService.ts:74–78` runs `wal_checkpoint(TRUNCATE)` then asynchronously copies only the main file. It ignores checkpoint results and does not hold a database snapshot while the copy proceeds.

A busy checkpoint may leave committed data in WAL. Later writes/checkpoints can overlap the file copy. A raw copy is therefore not guaranteed to be a consistent, complete recoverable snapshot. No existing backup was declared corrupt and no destructive restore was attempted.

**Fix:** use the supported SQLite online backup mechanism through the installed driver, with bounded progress and explicit result handling. Validate the destination before publishing it. Do not solve this with unsafe raw copying of DB/WAL files independently. [SQLite's backup documentation](https://www.sqlite.org/backup.html) describes a database-aware snapshot mechanism and the locking requirements of file-copy approaches.

**Verification:** concurrent writes/checkpoints, held readers, busy conditions, large databases and interruption; reopen the completed destination and check integrity plus expected transactional consistency. Run only on isolated fixture databases in a future authorized change.

### F06 — P1: Backup publication and completion reporting can hide failure

**Evidence:** SOURCE_VERIFIED. `DbBackupService.ts:76–85` writes directly to a date-only destination, overwriting the same day's backup, and catches failures without returning failure. `scripts/run_db_backup.ts:7–8` does not await `runBackup()` and immediately prints completion.

A same-day interrupted replacement can lose the previous good backup. The command can announce success before copying finishes and cannot reliably signal failure to its caller. Not awaiting alone does not prove Node exits during active file I/O; the proven problem is premature/incorrect completion semantics.

**Fix:** await a structured success/failure result; propagate a nonzero exit on failure. Create a uniquely named temporary snapshot, validate it, publish atomically under a unique final name, and prune only after success. Keep the prior good backup until replacement is verified.

**Verification:** injected permission/disk-full/copy/validation failures never print success, overwrite the last good artifact or prune it. Test multiple same-day backups and interrupted publication.

## B. Discovery, calendar and diagnosis defects

### F07 — P1: Sorted scores are joined to unsorted symbols by array index

**Evidence:** SOURCE_VERIFIED. `src/server/continuous/SnapshotScanner.ts:266,297–310` sorts `scored`, then maps `scoredInputs` while reading `scored[i]`.

When rank order differs from input order, one symbol receives another symbol's momentum, relative volume and range expansion. Downstream persisted ranking and plan evidence can be wrong even though every field is a valid number.

**Fix:** join by stable instrument/observation identity or sort a single combined structure. Preserve an explicit one-to-one relationship through persistence. This association repair is control-plane work; new scoring calculations remain Java-owned.

**Verification:** reversed ranks, ties, missing candidates and normalization aliases must retain each input's own raw metrics. Assert persisted symbol-level values, not only the final rank order.

### F08 — P2: TradePlan expiry is one hour early in winter

**Evidence:** SOURCE_VERIFIED; expression ISOLATED_REPRODUCED. `TradePlanBuilder.ts:146–148` hardcodes `T16:00:00-04:00` for “16:00 ET.” On December 15, 2026 it yields 20:00Z, which is **15:00 New York**, not 16:00.

**Fix:** derive session close with the canonical timezone/calendar contract. Include early closes and non-trading days rather than replacing one fixed offset with another. Keep persisted timestamps UTC.

**Verification:** summer/winter, DST transition weeks, holiday and early-close fixtures. A regular winter session expires at 21:00Z; the actual calendar determines exceptional closes.

### F09 — P1: ADV request does not retrieve the configured completed-day history

**Evidence:** SOURCE_VERIFIED, CONTRACT_VERIFIED. `MarketUniverseScanner.ts:328–352` sends `limit=days` across a multi-symbol request without explicit start/end or pagination.

The provider defaults the start to the current day; its limit applies across the response, not separately per symbol, and results are symbol-ordered. This cannot reliably produce the configured historical average for every symbol. Missing/partial results distort liquidity screening. [Alpaca historical bars contract](https://docs.alpaca.markets/us/reference/stockbars).

**Fix:** request an explicit completed-session range, page to bounded completion, group by instrument/session, exclude developing/current/future bars and enforce minimum coverage. Return sample count and missingness. Require the fallback to meet the same semantic contract; never lower the liquidity threshold to compensate.

**Verification:** premarket empty current-day response, first-symbol page exhaustion, partial last page, failed later page, duplicate bars, shortened sessions and fallback with insufficient history.

### F10 — P2: Missed-opportunity diagnosis claims risk approval without risk evidence

**Evidence:** SOURCE_VERIFIED. `MissedOpportunityDetector.ts:85–104` rejects an explicitly failed risk assessment, then falls through to “Approved by both” when `hadRiskAssessment=false` or approval remains unknown.

**Fix:** represent risk-not-reached, risk-pending/unknown, risk-rejected, approved-but-not-submitted and submitted-but-not-filled separately. Require affirmative risk approval before classifying an execution-stage miss. Preserve the earlier fix that requires real Chief approval; this is a remaining different branch.

**Verification:** a truth-table test across missing/null/false/true risk states, Chief state and fill state. No absent record should be reinterpreted as approval.

## C. Crypto data and lifecycle defects

### F11 — P1: Invalid quote time is replaced by the current time

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `CryptoMarketDataIngestion.ts:85–90` replaces an unparseable provider timestamp with `Date.now()`.

**Fix:** retain receipt time separately, reject/quarantine quotes with unknown observation time, and surface a data-quality reason. Do not allow an unknown timestamp to satisfy freshness.

**Verification:** missing, malformed and invalid dates do not update the executable observed-quote cache; valid source time is preserved. The harness confirmed current source writes a finite current timestamp for the malformed value.

### F12 — P1: Future quote ages pass the crypto freshness predicate

**Evidence:** SOURCE_VERIFIED. `CryptoVenueAvailability.ts:54–55` accepts any non-null age less than the stale threshold, including negative ages and negative infinity.

**Fix:** validate finite age and threshold, with an explicit bounded clock-skew policy if needed. Distinguish a small allowed clock skew from a far-future observation. Do not clamp arbitrary future evidence into fresh status.

**Verification:** null, NaN, ±Infinity, negative age, threshold boundary and legitimate clock-skew cases; verify the broker-availability gate cannot hide invalid time.

### F13 — P1: Positive midpoint is accepted from an invalid bid/ask quote

**Evidence:** SOURCE_VERIFIED. `AlpacaCryptoMarketData.ts:73–85` converts provider fields without runtime validation; ingestion checks only finite positive midpoint.

A negative bid with a large positive ask, or a crossed quote, can yield a valid-looking positive midpoint. Quote sizes and timestamps are also not validated at this boundary.

**Fix:** validate quote schema and finite positive uncrossed bid/ask, relevant sizes and time before constructing canonical evidence. Explicitly classify missing sides instead of computing an executable midpoint from them.

**Verification:** crossed, negative, string-valued, missing and non-finite fields; valid locked markets according to the selected policy; exact midpoint preservation for valid inputs.

### F14 — P1: Crypto polling overlaps and can publish after stop

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `CryptoMarketDataIngestion.ts:44–52,69–93` starts interval calls without a single-flight guard, request cancellation or generation check. `stop()` clears only future timers.

The harness held two requests unresolved, stopped the worker, then released both: `running=false` but two cache writes occurred. Slow or out-of-order responses can overwrite newer evidence; shutdown does not prevent late publication. The client fetches also lack explicit request deadlines.

**Fix:** reuse existing single-flight infrastructure, add bounded abortable requests, and reject responses from an old generation after stop/restart. Make stop/drain semantics explicit. Preserve newer source timestamps in the canonical cache.

**Verification:** slow requests longer than the interval, out-of-order results, stop during fetch, restart before old resolution, timeout and provider failure. No old generation may publish.

### F15 — P2: Crypto history pagination is unbounded and accepts duplicate/invalid bars

**Evidence:** SOURCE_VERIFIED. `AlpacaCryptoMarketData.ts:97–133` loops while a token is returned, appends bars without deduplication/schema checks and has no page/token-cycle/deadline bound.

**Fix:** impose total deadline/page/row budgets and repeated-token detection; deduplicate by canonical instrument/interval/time; validate finite OHLCV and interval bounds. Distinguish partial history from complete history, and require a policy for developing bars.

**Verification:** repeated token, duplicate pages, invalid dates/OHLCV, wrong symbol, empty nonterminal page, failed later page and current unfinished bar. Never label a truncated dataset complete.

## D. Crypto PAPER broker defects

These findings concern a local simulator. No real venue was contacted. Fixture parameters were intentionally controlled: zero spread/slippage, 1% per-side fee where noted, and explicit liquidity caps. They prove accounting/state behavior, not default-configuration profit or live exploitability.

### F16 — P1: Entry fees disappear from realized P&L

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `CryptoPaperBroker.ts:226–245,269`. Cash pays entry fees, but position basis excludes them; realized P&L subtracts only exit fees.

At unchanged $100 price, one unit with 1% entry and exit fees changes cash by −$2 but reports realized P&L −$1.

**Fix:** retain fee-inclusive economic basis or a separate allocated entry-fee ledger; amortize correctly across partial exits. Report price P&L and net P&L distinctly if both are useful. Reconcile cash, fees, realized/unrealized P&L and remaining inventory.

**Verification:** unchanged-price round trip, multiple entries, partial exits, complete closure/reopen and varying fees. Total net P&L must reconcile to equity change after cash flows.

### F17 — P1: Concurrent SELL fills exceed reported inventory and charge excess fees

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `CryptoPaperBroker.ts:226,259–279`. Actual disposed quantity is capped to holdings, but fee and `filledQuantity` use the larger pre-cap fill quantity.

Two pending .75-unit SELLs against one unit report 1.5 units filled. The 1%-fee fixture ends with $997.50 instead of the $998 consistent with buying/selling one unit at $100.

**Fix:** reserve sellable inventory for outstanding orders or explicitly reject excess outstanding quantity; derive notional, fee, fill accumulation and status from the actual executed delta. Do not silently label unexecuted remainder FILLED.

**Verification:** overlapping SELLs, partial liquidity, cancel/release races, a fully consumed holding and fees proportional only to actual fills.

### F18 — P1: Order modification accepts arbitrary protected fields and negative quantity

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `CryptoPaperBroker.ts:164–170` uses `Object.assign(order, updates)` without an allowlist or revalidation.

Besides negative quantity, callers can alter identity, symbol, side, status, client ID or filled quantity without updating indices or reservations. The executed −1 BUY modification resulted in $1,101 cash and quantity −1 from a $1,000 start.

**Fix:** allow only documented amendable fields; validate the amended order as a complete candidate before committing. Identity, executed quantities and status are immutable through this API. Quantity cannot be below already-filled quantity; enforce instrument precision, price and long-only constraints.

**Verification:** all forbidden field changes, zero/negative/non-finite quantity, amendment below fills and failed amendments leaving original state untouched. Fix the broker boundary, not only UI validation.

### F19 — P2: New orders do not validate side/type/required prices

**Evidence:** SOURCE_VERIFIED; invalid side acceptance ISOLATED_REPRODUCED. `CryptoPaperBroker.ts:116–160` validates quantity/instrument but trusts side and defaults type. INVALID side was accepted as PENDING. Missing LIMIT/STOP price can leave an order indefinitely pending.

**Fix:** validate side/type enums, required finite positive price fields and supported combinations before indexing the order. Return a precise rejection; use the same validation for modifications. Do not accept unsupported behavior on the assumption every caller is typed correctly.

**Verification:** malformed side/type, missing/NaN limit or stop price, unsupported time-in-force and valid MARKET/LIMIT/STOP cases.

### F20 — P1: Invalid prices can corrupt position valuation

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `CryptoPaperBroker.ts:287–294` marks positions on `if (currentPrice)`, unlike the stricter earlier fill-price check.

A negative price or Infinity is truthy. The fixture marked one unit at −$10, yielding negative market value.

**Fix:** apply one canonical finite-positive price validation to fills and marks. Retain the last valid mark with age/quality, or report valuation unavailable, rather than accepting invalid data.

**Verification:** negative, zero, NaN and Infinity ticks cannot alter last valid economic state or make account risk appear lower.

### F21 — P2: A partially filled STOP loses its triggered state on rebound

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED. `CryptoPaperBroker.ts:213–220` reevaluates the original stop threshold every tick without latching activation.

A two-unit SELL STOP at $90, triggered at $80 under a $50 tick cap, fills .625 units. On rebound to $100, the remaining triggered order no longer progresses. If STOP means stop-market—as its distinct type implies—the trigger should activate the remaining market order, not reset each tick.

**Fix:** explicitly define STOP semantics and persist triggered state. Once activated, apply the market execution model to the remainder until filled/canceled. If the desired type is stop-limit, implement and name that separately.

**Verification:** trigger, partial fill, rebound, repeated ticks, restart and cancellation. Assert no premature pre-trigger fill and no post-trigger rearming.

## E. Coinbase adapter and cost-classification defects

Coinbase remains subject to PAPER refusal and LIVE arming controls. These findings are conditional defects in the adapter, not permission to enable it or claims of observed live losses.

### F22 — P1: Caller idempotency key is discarded

**Evidence:** SOURCE_VERIFIED. `CoinbaseBroker.ts:242–249` generates a new UUID for every submission instead of preserving `order.clientOrderId`.

**Fix:** require/preserve the OMS stable intent key and return/map the provider's client ID. Reconcile ambiguous submissions using that key before retry. Do not generate a fresh intent merely because the response was lost.

**Verification:** repeat the same intent after a lost response and confirm one provider-side order in a mocked contract fixture; distinct intents remain distinct. No live order is needed.

### F23 — P1: Unsupported STOP submissions become MARKET orders

**Evidence:** SOURCE_VERIFIED. `CoinbaseBroker.ts:244–247` constructs LIMIT for one type and MARKET for every other type, then returns MARKET. A requested protective STOP is therefore not preserved.

**Fix:** reject unsupported types explicitly at adapter/capability validation, or implement the provider's correct type through a separately reviewed contract. Never silently change order meaning.

**Verification:** STOP and unknown types make zero submission calls unless specifically supported; valid MARKET/LIMIT fields survive unchanged.

### F24 — P1: Accounts and orders are treated as complete after one page

**Evidence:** SOURCE_VERIFIED, CONTRACT_VERIFIED. `CoinbaseBroker.ts:150–152,209–223` does not consume pagination cursors. The provider exposes paginated [accounts](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/accounts/list-accounts) and [orders](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/list-orders).

Missing later-page holdings/orders can produce false absence during valuation or reconciliation.

**Fix:** fetch bounded complete snapshots with cursor-cycle protection and explicit incomplete status on failure. Do not prune local state or declare “not found” from a truncated list.

**Verification:** multiple pages, later-page target order, failure after page one, repeated cursor and duplicate records. Reconciliation must distinguish incomplete snapshot from genuine absence.

### F25 — P1: Held balances disappear and portfolio cash uses only the first matching wallet

**Evidence:** SOURCE_VERIFIED. `CoinbaseBroker.ts:161–186` selects the first USD/USDC account and uses only `available_balance` for assets. Assets entirely on hold can vanish; aggregate equity can omit held value and additional eligible cash wallets.

**Fix:** construct a coherent account snapshot with total/available/held balances distinguished. Define the supported cash numeraire and conversion policy; do not assume every dollar-denominated token is automatically interchangeable. Buying power differs from equity. Avoid separate inconsistent account reads within one portfolio snapshot.

**Verification:** fully held crypto, partial holds, multiple USD wallets, USD plus USDC, restricted balances and changing balances between fetches. Account totals and reservations must reconcile.

### F26 — P1: Unknown prices/basis/P&L are encoded as numerical zero

**Evidence:** SOURCE_VERIFIED. `CoinbaseBroker.ts:188–202` initializes price to zero after product-pricing failure and reports zero basis/unrealized P&L despite comments calling them unknown.

**Fix:** add explicit unknown/incomplete valuation semantics through the existing portfolio contract. Preserve quantities; fail closed for decisions requiring complete valuation. Do not fabricate basis. Display unavailable economics instead of numerical zero.

**Verification:** price lookup failure and missing basis cannot lower portfolio exposure or appear as a known zero return. Recovery with valid data restores valued status with provenance.

### F27 — P1: Malformed success responses receive a fabricated broker order ID

**Evidence:** SOURCE_VERIFIED. `CoinbaseBroker.ts:255–261` rejects only `success === false`; otherwise missing `success_response.order_id` falls back to the generated client UUID as the order ID.

**Fix:** validate the provider response schema and distinguish broker order ID from client intent ID. Missing acceptance evidence means UNKNOWN_SUBMISSION requiring lookup, not confirmed PENDING with an invented provider identifier.

**Verification:** `{}`, `success:true` without ID, malformed response, explicit rejection and valid success. Ambiguous responses must preserve the client key and trigger reconciliation without blind resubmission.

### F28 — P1: Canonical hyphenated crypto symbols qualify for a zero-equity-commission exception

**Evidence:** SOURCE_VERIFIED. `src/server/research/canonicalCostModel.ts:65–68` identifies crypto only with `symbol.includes('/')`. Canonical instruments use BTC-USD/ETH-USD. A hyphenated symbol attributed to Alpaca with unknown commission can therefore become MEASURED zero.

Current Alpaca order capability restricts the directly reachable trading path, so the finding does not assert a present crypto fill. The classifier itself violates the instrument/economic contract and can affect imported or future records.

**Fix:** use the canonical instrument registry/asset class, not delimiter heuristics. Unknown commission remains unavailable unless an explicit broker/instrument fee rule supports it; distinguish base commission from total fees.

**Verification:** BTC-USD, BTC/USD, ETH variants, valid equity tickers with punctuation and unresolved instruments. Unknown identity must not earn a favorable fee exception.

## F. Security and notification defects

### F29 — P1: Webhook URL validation is disconnected from the actual connection

**Evidence:** SOURCE_VERIFIED. `webhooks.ts:108,128` validates URLs when stored; dispatch at line 88 later performs ordinary fetch. Test dispatch also uses ordinary redirect-following fetch. `urlSafety.ts:95` resolves DNS separately from the connection.

An initially allowed URL can redirect to an internal target, or resolve differently at dispatch time. Therefore the existing guard does not guarantee that the connection destination satisfies its policy. Authenticated configuration is required for the stored URL path; no attack against a real service was performed.

**Fix:** use one vetted outbound transport that rejects redirects or validates every hop and binds each connection to approved resolved addresses. Recheck at connection time, not only at configuration time. Preserve TLS hostname validation. Apply bounded timeouts and restricted destinations where practical. [OWASP's SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) addresses redirect and DNS validation pitfalls.

**Verification:** local mock transport/DNS fixtures for allowed-to-blocked redirect, changing DNS and mixed address results; confirm no connection to a blocked destination. Do not send requests to metadata services or private production endpoints to test this.

### F30 — P1: IPv6 private-address handling misses hexadecimal IPv4-mapped loopback

**Evidence:** SOURCE_VERIFIED, ISOLATED_REPRODUCED with mocked DNS. `urlSafety.ts:52–59` unwraps only dotted `::ffff:a.b.c.d`; `::ffff:7f00:1` is recognized as IPv6 but falls through unblocked. The actual guard returned `safe:true` for that mocked resolution. Link-local handling also checks only the textual `fe80:` prefix rather than the whole relevant prefix range.

**Fix:** normalize and parse addresses to bytes, then apply complete CIDR policy including mapped forms. Avoid textual-prefix approximations and hand-maintained spelling variants. Do not assume URL hostname and DNS output use identical formatting.

**Verification:** compressed/expanded/mapped IPv6, full link-local range, loopback, unique-local, permitted public addresses and mixed DNS answers. Retain F29 connection-time enforcement.

### F31 — P2: Invalid webhook event configuration breaks dispatch

**Evidence:** SOURCE_VERIFIED. `webhooks.ts:134` accepts arbitrary `events`; dispatch at line 59 calls `.includes` before its fetch try/catch. An object/number stored as events throws; a string also has unintended substring semantics.

**Fix:** validate create/update payloads against the supported event enum array, URL/name/types and boolean enabled state. Reject invalid partial updates atomically. Contain one malformed webhook so it cannot prevent other notifications.

**Verification:** object/string/null/numeric event values, unsupported names and valid arrays. One invalid legacy configuration must not crash the dispatch batch.

### F32 — P2: Event webhook dispatch has no timeout/backpressure or HTTP failure handling

**Evidence:** SOURCE_VERIFIED. `webhooks.ts:88–89` fires unbounded fetches without an abort signal and only catches promise rejection. HTTP 4xx/5xx resolves normally and is not reported as a dispatch failure. The separately bounded test route does not protect ordinary event delivery.

**Fix:** bounded queue/concurrency and request timeout through the same vetted transport as F29; inspect status codes, record bounded retries and dropped/failed delivery. Protect the trading event path from slow receivers. Persist delivery requirements only if the product needs durable alerts; do not add a second general event system.

**Verification:** hung receiver, repeated critical events, 429/500, shutdown, retry budget and healthy alternate receiver. Memory/concurrency must remain bounded and failures visible.

## G. Frontend defects

### F33 — P2: Replay polling can starve itself when responses take longer than 750 ms

**Evidence:** SOURCE_VERIFIED. `HistoricalReplayLab.tsx:343–357,393–416` aborts the previous refresh whenever a new interval starts. If each status response needs longer than 750 ms, every request may be canceled before a successful update.

**Fix:** use a single-flight poll or schedule the next refresh after completion, with a bounded timeout and backoff. Generation changes/unmount should cancel obsolete work; ordinary timer ticks should not continuously cancel the only useful request. Guard secondary report fetches with the same generation.

**Verification:** status latency of 1–2 seconds must still update the UI; switching runs/unmount must prevent stale updates; terminal reports stop polling. This was source-reviewed, not browser-reproduced.

### F34 — P2: Trade replay state can mix two selected trades

**Evidence:** SOURCE_VERIFIED. `TradeReplayModal.tsx:49–81` fetches whenever `trade` changes but does not cancel prior requests or clear explainability/timeline state at the start. Late A responses can overwrite B; B with no report can retain A's report. A prior timeline index may exceed the new trace length.

**Fix:** key request state by stable trade/trace identity; reset loading, report, playback and index; abort or ignore old generation responses. Alternatively remount by stable trade ID while still handling request cleanup.

**Verification:** rapidly change A→B with delayed A response, B with no trace/report, shorter B timeline and unmount. Displayed symbol, report and trace must always share the same identity.

## H. Java and Python boundary defects

### F35 — P2: Crypto expected-edge calculation can label zero evidence calibrated

**Evidence:** SOURCE_VERIFIED. Java `institutional/models/CryptoExpectedEdgeEngine.java:49–71` tests only `sampleSize >= minimumSampleSize`. `(0,0)` becomes calibrated; negative costs/loss magnitudes are unchecked; out-of-range probabilities are silently clamped, and NaN becomes zero.

For example, zero sample size, zero required minimum, a positive hypothetical win and negative supplied cost can produce a favorable calibrated estimate. No production consumer or realized trade from this engine was established.

**Fix:** validate finite probability in [0,1], nonnegative magnitudes/costs, strictly positive minimum and sufficient positive sample size. Reject invalid calibration with an explicit invalid/unknown result; do not silently repair probability inputs. Keep economic support separate from mathematical evaluation.

**Verification:** zero/negative counts, NaN/Infinity, negative costs/loss magnitude, invalid probability and ordinary supported inputs. Tests belong in Java; do not create a parallel TS edge formula.

### F36 — P2: Java HTTP service has no application-level body/admission bounds

**Evidence:** SOURCE_VERIFIED. `quant-core-java/.../server/QuantCoreServer.java:105,1641` uses a virtual-thread-per-task executor and `readAllBytes()` without a body limit. The service binds loopback, reducing exposure; it still accepts input from local callers.

Large or concurrent compute requests can consume unbounded memory/work despite inexpensive virtual threads. No resource exhaustion was attempted.

**Fix:** impose body, array/history, deadline and concurrent-work budgets; return explicit overload/invalid-input responses; preserve computation isolation and existing HTTP boundary. Measure limits from realistic workloads rather than changing languages/frameworks.

**Verification:** oversized body, chunked body beyond limit, excessive bars, concurrent work and slow input. Verify bounded resources and healthy request recovery; no broker access is added.

### F37 — P2: Python inference accepts unbounded payload/work and can pin its only worker

**Evidence:** SOURCE_VERIFIED. `scripts/local_ai_service.py:238–247,268–280` reads Content-Length without a maximum, checks price list minimum but no maximum/numeric-finite contract, and accepts unbounded integer horizon. `scripts/lib/inference_worker.py:71–72` waits on `future.result()` without a task deadline.

The bounded HTTP server limits connection threads and socket waiting; it does not bound model computation. A pathological or stuck inference can occupy the sole worker while subsequent handlers wait. No heavy model or denial-of-service test was run.

**Fix:** validate bounded body/context/horizon and finite positive input values before queueing. Enforce bounded admission and queue deadlines. A timeout must not imply native computation was canceled: define safe worker/process recovery if inference cannot be interrupted, preserving single-thread model confinement. Do not revive the already-fixed native thread-pool leak or rewrite the HTTP framework without a demonstrated need.

**Verification:** malformed Content-Length, oversized text/prices, invalid numbers, out-of-range horizon, queued request timeout, simulated stuck worker and controlled recovery. Use lightweight stub inference; never stress the running service for this test.

## Integration limitations and unresolved questions — not counted as confirmed coding defects

### R01 — Crypto broker selection is not end-to-end routing

BrokerManager has a separate crypto broker resolver, while OMS BUY resolution and risk/portfolio reconciliation use common active-broker paths. Crypto ingestion caches midpoint prices without proving a complete MARKET_DATA→idea→risk→fill chain. This is a source-visible integration gap already documented in the master plan. Define a single instrument/account/environment route contract inside protected services; do not invent a second execution path. Verify a full isolated PAPER lifecycle before claiming capability.

### R02 — Late SELL fills lack persisted pre-trade basis for realized P&L

`OrderManagement.ts:951–970` explicitly leaves late-fill P&L unknown because the initial basis snapshot existed only in `executeOrder`'s stack. That is honest abstention from fabrication, but incomplete accounting. Persist attributable lots/basis before execution, then calculate realized economics from actual fills and fees. Do not infer basis from a later potentially changed position. Treat this as missing capability, not a reason to fill nulls with zero.

### R03 — Crypto cross-asset features assume synchronized arrays

`CryptoFeatureEngine.computeRelative` uses the shorter length and equal indices without timestamps; a longer series can be truncated at the wrong end. The documented method requires synchronized inputs and no production caller was found. Therefore this is an input-contract/integration risk rather than demonstrated active mispricing. Require upstream timestamp joins and explicit equality/coverage checks; test shifted/missing bars before adding a consumer.

### R04 — Java feature sufficiency checks length more than data quality

`CryptoFeatureEngine.compute` can return `sufficientData=true` from array lengths despite non-finite/invalid prices. Numerical engines often rely on validated caller contracts; enforcement across all call paths was not proven. Define where validation lives and verify no HTTP/research path can supply invalid bars as healthy evidence. Avoid asserting all 223 Java files share this bug.

### R05 — Backtest paths are not interchangeable

Legacy same-bar paths and canonical NEXT_BAR_OPEN research serve different contracts. Do not call all same-bar output a new implementation defect without its intended contract, but never certify it as equivalent executable OOS evidence. Audit stop/target ordering, costs, corporate actions, delisted history and warmup per engine. Entry-fee omission in generic legacy P&L is a latent risk if nonzero BUY commission is introduced; inspected current calls default it to zero, so it is not listed as a currently reproduced fee loss there.

### R06 — Crypto PAPER state is in memory

This is disclosed design, not a hidden persistence implementation. Restart cannot recover account/order state from this adapter alone. Choose durable recovery or explicitly non-resumable isolated simulation semantics before operational use. Do not present `health() === Healthy` as restored-account readiness.

### R07 — WebSocket authentication and lifecycle need a dedicated threat-model pass

Upgrade authentication exists; prior missing-auth claims must not be repeated. The inspected handler does not establish periodic session-expiry enforcement or an Origin policy, and unknown upgrade paths return without destroying the socket, potentially to allow another upgrade handler. Cookie/SameSite behavior and Vite coexistence need complete tracing before declaring an exploitable vulnerability. Test with a local harness, not the user's authenticated service.

### R08 — Learned weights, confidence and strategy independence are model-risk questions

Heuristic confidence, assumed correlations and overlapping labels can produce poor decisions without being coding defects. Preserve unknown cost and insufficient-evidence rejection. Statistical redesign belongs in the master plan and must not be disguised as a bugfix that lowers gates.

## Reproduction record

All values below came from the isolated harnesses described above. No harness file was saved; application modules were transpiled in memory with dependencies replaced. These fixtures are suitable specifications for future committed tests, not substitutes for those tests.

| Check | Input/condition | Observed result | Required invariant |
|---|---|---|---|
| Fill value | cumulative 1@$10, then 2@$11 | ledger $21 | broker cumulative value $22 |
| Fill race | concurrent cumulative 1 and 2; both read zero | ledger quantity 3 | cumulative quantity 2 |
| Crypto round trip | 1 unit, unchanged $100, 1% each-side fee | cash −$2, realized −$1 | both net −$2 |
| Crypto two SELLs | .75 + .75 pending, one held | reported sold 1.5 | at most one actual unit |
| Crypto amendment | pending BUY amended to −1 | cash $1,101, position −1 | reject amendment; cash unchanged |
| Crypto valuation | held unit, tick −$10 | market value −$10 | reject invalid mark |
| Crypto side | side INVALID | accepted PENDING | reject invalid enum |
| Crypto STOP | 2 units, stop90, tick80/cap50 then tick100 | .625 then still .625 filled | triggered remainder follows defined stop-market semantics |
| Ingestion overlap | start plus unresolved second tick | two requests in flight | one flight or explicit bounded concurrency |
| Ingestion stop | resolve both after stop | two writes while stopped | no old-generation publication |
| Bad quote time | timestamp invalid | replaced with finite current time | unknown source time is rejected |
| URL guard | mocked DNS `::ffff:7f00:1` | safe true | loopback blocked |
| Winter expiry | December 15, fixed −04:00 | 15:00 New York | 16:00 regular-session close |

The fill-race harness deliberately modeled asynchronous interleaving and unique constraints on equal watermarks. Real SQLite concurrency/integration regression remains required. The URL fixture used mocked DNS and made no outbound fetch.

## Prioritized fix program

### Batch 1 — Execution and recovery correctness

Address F01–F06, then F16–F18/F20 and the relevant crypto routing contract R01. F01/F02 should be one coherent ledger change: atomic quantity and notional conservation, followed by correct downstream basis and broker attribution. Backups can be repaired independently but require restore verification before being called reliable.

**Acceptance:** isolated integration tests reconcile order reports, fill ledger, positions, cash and fees across duplicates, out-of-order events, partials, restart and broker switches. Backup restoration yields a consistent snapshot while preserving the previous good backup on failure. All existing safety tests remain intact.

**Rollback:** stop promotion of the new code version and use existing pause/reconciliation controls if state is uncertain. Never roll back economic truth by deleting fills or recreating balances. A ledger migration/correction needs a separately reviewed evidence-preserving plan; historical rows cannot simply be recomputed from insufficient data.

### Batch 2 — Trustworthy discovery and market data

Address F07–F15. Identity association, completed-session ADV and freshness are prerequisites to meaningful candidate research. Keep liquidity, confidence and independent-evidence thresholds unchanged. Fixing a missing input is different from weakening the requirement for that input.

**Acceptance:** recorded-response fixtures and old/new shadow comparisons show correct symbol association, timestamps, history coverage and session expiry. Stop/restart and late responses preserve generation safety. Missing data remains explicitly missing.

### Batch 3 — Broker contract and economic classification

Address F19/F21–F28 plus R02/R06. Refuse unsupported behavior until capability, account and accounting contracts are complete. Coinbase fixes remain mock/contract/PAPER-isolated work; no real-money validation is authorized by this audit.

**Acceptance:** stable client IDs, complete-or-explicitly-incomplete account/order snapshots, no fabricated broker IDs or zero unknown values, exact supported-order semantics and canonical instrument fee classification.

### Batch 4 — Outbound security and bounded services

Address F29–F32 and F36–F37. Use a single safe outbound transport; retain loopback service binding and single-thread inference confinement. Fixing limits must not create new uncontrolled retries or worker pools.

**Acceptance:** local mock security tests prove blocked destination policy across redirects/DNS/address forms. Timeout/overload fixtures remain bounded, visible and recoverable. Never run exploitation/resource stress against active trading services.

### Batch 5 — UI correctness and research boundaries

Address F33–F35 and investigate R03–R05/R07. Add frontend race tests with deferred requests and Java invalid-input tests. Expand research validation only after data/ledger correctness, not in parallel with tuning strategies against corrupted evidence.

**Acceptance:** slow polling completes, old UI requests cannot overwrite a new selection, invalid research inputs remain invalid, and every resulting metric identifies its data/engine/version provenance.

## How each future fix should be delivered

For each finding: freeze a minimal failing regression, identify the authoritative owner, make the smallest coherent correction, run targeted and related tests, then typecheck/build/full suite as the repository requires. A protected-component change must be reviewed under the architecture contract; no shortcut trading path or relaxed threshold is an acceptable fix.

Fixtures may control data, clocks, transport and broker responses. They must not force strategy signals, Chief approvals or risk passes and then claim end-to-end success. Keep synthetic and replay results separate from organic PAPER evidence. Java numerical changes need parity/contract tests when they affect existing TS/Java boundaries.

Update the living architecture reference only when an authorized implementation changes architectural truth; update operational documentation when its contract changes. This audit itself changes neither. Do not stage or commit existing unrelated files as part of a later fix.

## Coverage ledger and remaining assurance work

- **Common execution/accounting:** traced fill ledger, OMS submission/follow-up, broker identity, local portfolio synchronization, reservations and reconciliation interfaces; F01–F04/R02 are the main findings. Full broker race suite not run.
- **Data/discovery:** traced snapshot ranking, ADV request, plan expiry, miss classifier, crypto quote/bar ingestion; F07–F15. Full historical opportunity replay not run.
- **Brokers:** detailed CryptoPaper/Coinbase boundary review and routing inspection; existing Alpaca/IBKR controls sampled through call sites. No claim that every Alpaca/IBKR method is defect-free.
- **Persistence/operations:** database bootstrap, test isolation, backup worker and backup CLI inspected; F05–F06. Migrations were not run and every historical migration was not semantically certified.
- **Security/API:** authentication configuration, server middleware/upgrade paths, webhook validation/dispatch and URL guard inspected; F29–F32/R07. This is not a full penetration test, dependency-CVE audit or deployment assessment.
- **Frontend:** 126 TSX files inventoried; cross-cutting polling/state searches and targeted replay components reviewed; F33–F34. Every screen was not browser-tested.
- **Java research/runtime:** 223 main-source files inventoried; registry and selected strategies/features/contracts reviewed across this and the master audit; F35–F36/R03–R05. Mathematical verification of every model remains outstanding.
- **Python/scripts:** all 10 script Python files syntax-parsed; inference/server lifecycle and key CLI/backup entrypoints inspected; F37. No model load, daemon restart or full script execution.
- **Tests/build:** configured TypeScript check passed; selected test assertions inspected for coverage gaps. Full integration, Java compilation, browser and live runtime suites remain unexecuted in this pass.

**Completion statement:** the identified coding defects and proposed fixes are documented. No defect is marked fixed, no readiness score is raised and no profitability claim follows from this audit. The remaining assurance work is explicitly bounded above rather than hidden behind a claim that the entire repository is now proven correct.
