# Argus Current Defect Status and Remediation — 2026-10-04

**Scope:** Current-source verification of every issue (A–P) raised by the Thursday/Friday
forensic program, cross-checked against the 2026-10-01/10-02 forensic audit, the 2026-10-03
architecture remediation, and this session's own test runs against current HEAD. This report does
not re-derive the Thursday/Friday narrative — see
`ARGUS_THURSDAY_FRIDAY_REINVESTIGATION_2026-10-01_2026-10-02.md` for that. Its job is one thing:
for each issue, state the current-source verdict with evidence, not an assumption.

**Baseline:** branch `main`, HEAD at session start `5576bd07…`, 2 pre-existing uncommitted files
left untouched (`src/server/routes/v2System.quantCore.test.ts`, `src/server/routes/v2System.ts` —
not created or modified by this session). PAPER_TRADING_ONLY / LIVE_NO_GO unchanged throughout. No
PAPER trade was placed to test any of this; no runtime engine was restarted or resumed into trading.

Evidence classes used below: **HISTORICAL_RUNTIME_FACT**, **CURRENT_SOURCE_FACT**,
**CURRENT_TEST_FACT**, **INFERENCE**, **UNKNOWN**. Confidence: **VERIFIED**,
**STRONGLY_SUPPORTED**, **PLAUSIBLE**, **UNPROVEN**, **REFUTED**.

---

## A — OKTA double-SELL / unintended short

- **Historical severity:** P0. Confirmed stale broker snapshot resurrected a closed long after a
  correct exit fill, and an unrestricted second SELL opened −14. [HISTORICAL_RUNTIME_FACT, VERIFIED
  — `ARGUS_THURSDAY_FRIDAY_TRADING_FORENSIC_2026-10-01_2026-10-02.md`, millisecond reconstruction T1–T14]
- **Current source still vulnerable?** No. Migration `0082_position_fill_evidence` +
  `src/server/services/positionFillEvidence.ts` tie SELL approval to the fill-ledger watermark, not
  the broker's eventually-consistent snapshot. [CURRENT_SOURCE_FACT, VERIFIED — confirmed wired into
  the real call path: `OrderManagement.ts:560` calls `prepareOrderPosition()` synchronously before
  `placeOrder()`; `fillLedger.ts:67` calls `applyPositionFill()` inside the same IMMEDIATE transaction
  that persists the fill]
- **Fix proof, not assumption:** `OrderManagement.positionEvidence.test.ts`'s first scenario replays
  the exact historical sequence (BUY 14 @ 211.72 → SELL 14 @ 212.49 → stale broker snapshot reports
  +14 again → second SELL attempted) and asserts the second SELL is rejected
  (`POSITION_FILL_CONFLICT`), reconciliation refuses to resurrect the stale position, `broker.placeOrder`
  is never called a second time, and exactly 2 fills exist (not 3). Re-ran this session against current
  HEAD: **8/8 passing**. This session additionally added
  `positionFillEvidence.property.test.ts`, exercising the same production functions
  (`prepareOrderPosition`/`applyPositionFill`/`insertIncrementalFill`) under 300+200 randomly
  generated adversarial sequences with fresh/stale-prior/stale-zero/garbage simulated broker reads;
  the no-oversell / no-negative-position invariant held in every run. [CURRENT_TEST_FACT, VERIFIED —
  ran this session, exit code 0]
- **Regression test reproduces the ORIGINAL failure, not just a plausible one:** Yes — same share
  count (14), same prices ($211.72/$212.49), same mechanism (stale-positive resurrection after a
  confirmed close).
- **Classification:** CONFIRMED_DEFECT, **already fixed before this session began** (fix dated
  2026-10-03, this session independently re-verified it rather than re-implementing it).
- **Action required:** None in code. One operational action remains — see Issue B's note on the
  live broker-side −14 itself.

## B — Stale broker position resurrection

- Same root mechanism as A. `checkPositionFillEvidence()`/`latestPositionFill()` now source
  "current position" from the fill ledger's own last `position_quantity_after` watermark, never from
  a raw, potentially-stale `broker.positions()`/`broker.portfolio()` read. [CURRENT_SOURCE_FACT, VERIFIED]
- **Residual, explicitly documented limitation (not a code defect):** legacy fills recorded before
  migration 0082 have NULL inventory watermarks and fail closed as
  `POSITION_FILL_BASELINE_UNAVAILABLE` — this is deliberate (no basis is ever inferred from an old
  BUY), but it means the **actual, currently-open Oct 1 OKTA short (−14) itself has no fill-ledger
  watermark** and requires a separately reviewed broker reconciliation and baseline recovery before
  any supervised PAPER session, independent of this fix being correct. [CURRENT_SOURCE_FACT, VERIFIED
  — `docs/architecture/ARGUS_ARCHITECTURE.md` § "2026-10-03: fill-backed inventory and forensic
  remediation", "Deployment constraint" paragraph]
- **Classification:** CONFIRMED_DEFECT, fixed for all NEW positions going forward.
  CONFIGURATION_ISSUE / pending operator action for the specific legacy OKTA short already open.

## C — Reconciliation overwriting newer fill-derived truth

- `PortfolioReconciliation.ts` now references `positionFillEvidence` (confirmed via source grep)
  and, per the architecture doc, "cannot hydrate/overwrite a fill-conflicting position and cannot
  publish a clean MATCH for that conflict." The replay test directly exercises this: after the stale
  snapshot is injected, `portfolioReconciliationWorker.reconcile()` is called and asserted to (a)
  leave the `portfolio` row for OKTA absent rather than recreated, and (b) write a
  `reconciliation_events` row with `matches: 0` and `mismatches` containing `POSITION_FILL_CONFLICT`.
  [CURRENT_TEST_FACT, VERIFIED]
- **Classification:** CONFIRMED_DEFECT, fixed and verified.

## D — Missing/unsafe pending SELL reservation

- `prepareOrderPosition()` rejects a second order for the same symbol/broker/environment with
  `POSITION_ORDER_UNRESOLVED` while any sibling trade row is non-terminal
  (`status NOT IN ('FILLED','REJECTED','CANCELED','EXTERNAL_MANUAL','ARCHIVED_DIAGNOSTIC')`). This
  reservation is a persisted DB row, not an in-memory lock, so it survives a restart.
  [CURRENT_SOURCE_FACT, VERIFIED]
- Proven under restart (`positionEvidence.test.ts` "attributes a delayed fill after restart..."),
  under partial-fill competing orders ("preserves partial-close inventory and refuses another exit
  while remainder is working" — asserts `POSITION_ORDER_UNRESOLVED`), and under genuine concurrency
  (`Promise.all` of two independent exit traces — at most one broker SELL is ever placed, position
  never goes negative). [CURRENT_TEST_FACT, VERIFIED]
- **Classification:** CONFIRMED_DEFECT, fixed and verified.

## E — CLOSE_LONG silently becoming OPEN_SHORT

- `prepareOrderPosition()` explicitly encodes "a production SELL means CLOSE_LONG": `order.quantity
  > quantity + tolerance` (requested SELL exceeds confirmed long) or `quantity <= 0` (already flat)
  both return `CLOSE_LONG_QUANTITY_EXCEEDED` before the order ever reaches the broker. There is no
  authorized OPEN_SHORT path in this module. [CURRENT_SOURCE_FACT, VERIFIED]
- This session's property test (`positionFillEvidence.property.test.ts`, 2nd case) specifically
  replays "BUY N → SELL N (flat) → stale SELL N again" for randomized N/prices and asserts the second
  SELL is always refused — 200/200 runs passed. [CURRENT_TEST_FACT, VERIFIED]
- **Classification:** CONFIRMED_DEFECT, fixed and verified.

## F — Incorrect P&L attribution on the second OKTA SELL

- Historical: the second SELL was credited $11.46 using the already-closed long's basis; the first,
  legitimate, closing SELL was left NULL. [HISTORICAL_RUNTIME_FACT, VERIFIED]
- `applyPositionFill()` now computes realized P&L only for the portion of a fill that reduces
  existing opposite exposure (`closing = before * delta < 0 ? Math.min(Math.abs(before), newQty) : 0`;
  `realized = closing > 0 ? (price - basis) * closing * Math.sign(before) : null`) — opening a short
  (no prior opposite exposure) earns `realized_pnl = null`, never a fabricated profit.
  [CURRENT_SOURCE_FACT, VERIFIED]
- Directly tested: `positionEvidence.test.ts`'s "attributes a delayed fill after restart... and
  charges no P&L to an opening short" asserts the closing SELL gets correct P&L
  (`(212.49 - entryPrice) * 14`) and a subsequent unexpected short-opening fill gets
  `profit_loss: null` with signed inventory `quantity: -14`. [CURRENT_TEST_FACT, VERIFIED]
- **Classification:** CONFIRMED_DEFECT, fixed and verified. (Historical ledger rows from Oct 1 are
  not retroactively rewritten — the architecture doc explicitly defers that to "a separately
  authorized audited accounting process," which this session did not undertake since it would mean
  mutating production financial history.)

## G — Friday zero approvals / consensus bottleneck

- Fully reconstructed and quantified in the existing audit: 23,718 consensus terminal events / 124
  symbols, 0 approvals, persisted-decision max confidence 0.70 against the unchanged 0.75 bar.
  Terminal-reason breakdown: 22,963 CONFIDENCE_BELOW_STRONG, 445 AGENT_HOLD, 269
  AGENT_DATA_UNAVAILABLE, 40 insufficient independence, 1 calibration reject.
  [HISTORICAL_RUNTIME_FACT, VERIFIED]
- **Classification:** EXPECTED_CONSERVATIVE_BEHAVIOR (the threshold and independence floor are
  working as designed) combined with SIGNAL_QUALITY_LIMIT (genuine agent disagreement/weak evidence).
  Not a defect. No threshold or gate was touched.

## H — Agent disagreement / calibration

- TechnicalAgent BUY-biased vs. KronosEngine SELL-biased on Friday is real and quantified (signal
  quality table in the existing audit). Full-history `agent_performance_stats` Wilson-interval data
  (independently pulled this session's prior turn) shows TechnicalAgent's actual win_rate (44.7%) is
  **worse** than Kronos's (47.2%) — the opposite of what a small 2–4hr sample suggested, which is the
  exact caution the user raised and which was independently confirmed, not assumed.
  [CURRENT_SOURCE_FACT / HISTORICAL_RUNTIME_FACT, VERIFIED]
- **Classification:** SIGNAL_QUALITY_LIMIT. No calibration was reset or reweighted to force
  agreement — doing so without OOS justification would violate the explicit working rule against it.

## I — Reduced quant coverage (Thursday → Friday)

- Quant assessments fell from 7,340 (Thursday RTH) to 1,138 (Friday RTH); distinct symbols 129→101.
  [HISTORICAL_RUNTIME_FACT, VERIFIED]
- Friday symbols still reached consensus (CRDO, FCX, etc., reached CONSENSUS_REJECTED, not
  NOT_DISCOVERED), so the cap alone does not explain zero approvals.
  [HISTORICAL_RUNTIME_FACT, VERIFIED]
- **Classification:** CAPACITY_LIMIT contributing to reduced evaluation depth; not independently
  shown to be the cause of zero trades.

## J — IBKR subscription/capacity pressure (90-line cap)

- Friday RTH: 326 capacity-full events / 91 symbols, 312 rescue denials / 92 symbols — material
  pressure, but discovery/subscription/ack pipeline was functioning (1,442 acknowledgements / 139
  symbols). [HISTORICAL_RUNTIME_FACT, VERIFIED]
- **Classification:** CAPACITY_LIMIT. The 90-line cap is a real entitlement constraint (see
  `project_argus_ibkr_data_gap` memory — 354/10,089 entitlement tier as of 2026-09-29); this is not
  a defective allocation policy, and this session did not raise it artificially.

## K — $2,000 experiment not activated

- Persisted settings at the time showed PAPER / IBKR Gateway / budget $100,000 / FIXED_DOLLAR /
  max order $3,000 — no trace of a $2,000 ceiling anywhere in settings, gate details, or sizing
  output. [HISTORICAL_RUNTIME_FACT, VERIFIED]
- **Classification:** CONFIGURATION_NOT_ACTIVATED, not a sizing defect. No code ignored an active
  $2,000 config because none existed.
- **Action still open:** no pre-session consistency check yet exists that would have caught this
  automatically before the session started (see Issue P and the Release Status report's remaining
  gaps).

## L — Orders-command / CLI timeout

- `./argus orders` → `GET /api/v2/runtime/orders` → `argusApplication.recentTrades` — a read-only
  alias over the trade ledger; it does not call `broker.orders()` or `placeOrder()`.
  [CURRENT_SOURCE_FACT, VERIFIED]
- No request trace, duration, or captured error exists for the specific reported timeout.
  [UNKNOWN]
- **Classification:** INSUFFICIENT_EVIDENCE to classify root cause (OBSERVABILITY_ONLY vs.
  PERFORMANCE_DEFECT vs. DB_CONTENTION). Confirmed NOT execution-path-blocking — read-only route.
  **Action required:** add request correlation/duration logging to this route (not done this
  session — no reproduction was available to validate a fix against).

## M — Restart / unclean-shutdown

- Both Thursday and Friday show `RestartSafetyGuard` pausing persisted-enabled state after an
  unclean prior shutdown, each requiring an explicit operator resume — working as designed (fail
  closed, no auto-resume). [HISTORICAL_RUNTIME_FACT, VERIFIED]
- CLAUDE.md's DEF-26/27/28/29/30 table documents this class of issue as fixed (graceful shutdown
  ordering, IBKR reconnect-with-backoff, crash recovery) as of 2026-09-05 through 2026-09-09 —
  predates these two trading days, so the *repeated* unclean-shutdown pattern on Oct 1/2 is either a
  recurrence or a different trigger than those fixes addressed. [CURRENT_SOURCE_FACT for the fixes
  existing; UNKNOWN for why they recurred on these specific two days]
- **Classification:** OBSERVABILITY_DEFECT (no durable record of *why* each shutdown was unclean) —
  not reproduced or further investigated this session.

## N — Watchdog reliability

- Watchdog running state and heartbeat age were UNKNOWN in both days' evidence; no durable heartbeat
  series was found. [UNKNOWN per the original audit]
- `watchdog-start`/`watchdog-stop`/`watchdog-restart`/`watchdog-status` CLI commands exist per
  CLAUDE.md (2026-09-08) but their actual health during Oct 1–2 was not recoverable from persisted
  evidence. [CURRENT_SOURCE_FACT: commands exist; HISTORICAL_RUNTIME_FACT: health UNKNOWN]
- **Classification:** OBSERVABILITY_DEFECT. Not fixed this session (no durable watchdog heartbeat
  table was added — doing so is a new, non-trivial observability feature, not a bug fix, and was not
  attempted without further scoping).

## O — Incomplete durable observability (position/order lineage)

- Materially improved by the Oct 3 remediation: `QUANT_QUOTE_EVIDENCE`/`ORDER_QUOTE_EVIDENCE` record
  observed source/price age; `fill_recorded`/`order_position_refused` structured-log events now carry
  the refusal reason string directly (confirmed in this session's test runs' log output — e.g.
  `order_position_refused` with `reason: POSITION_FILL_CONFLICT`). [CURRENT_SOURCE_FACT, VERIFIED]
- Still open: no single durable "position provenance" view joins broker-observation age/generation +
  latest fill watermark + reservation state + effective-sellable-quantity into one queryable record
  per the new prompt's §25 ask — the pieces exist in separate tables/log lines but are not yet
  unified into one observability surface. [CURRENT_SOURCE_FACT: not found via search this session]
- **Classification:** OBSERVABILITY_DEFECT, partially closed, not fully closed.

## P — Synthetic testing coverage gaps

See `ARGUS_SYNTHETIC_ADVERSARIAL_CERTIFICATION_V2_2026-10-04.md` for the full maturity audit. Summary
verdict here: substantially more mature than the Oct 1 audit's own "why tests missed it" section
describes — `OrderManagement.positionEvidence.test.ts` (8 scenarios, pre-existing) plus this
session's new property test directly close the exact gap that let the OKTA incident through.
Remaining gaps (capacity stress at 300–1000 synthetic symbols, a dedicated named
`OKTA_DOUBLE_SELL_2026_10_01` release-blocking scenario ID, and hand-applied mutation testing on
`positionFillEvidence.ts` specifically) are listed honestly there, including one item
(mutation testing) blocked by sandbox policy this session.

---

## Summary table

| Issue | Classification | Status | Evidence |
|---|---|---|---|
| A. OKTA double-SELL | CONFIRMED_DEFECT | Fixed & verified (pre-session) | 8+15 passing tests |
| B. Stale broker resurrection | CONFIRMED_DEFECT | Fixed (new positions); legacy short pending op action | Architecture doc §Oct-3 |
| C. Reconciliation overwrite | CONFIRMED_DEFECT | Fixed & verified | positionEvidence.test.ts |
| D. Missing SELL reservation | CONFIRMED_DEFECT | Fixed & verified | positionEvidence.test.ts |
| E. CLOSE_LONG→OPEN_SHORT | CONFIRMED_DEFECT | Fixed & verified | property test (this session) |
| F. P&L misattribution | CONFIRMED_DEFECT | Fixed & verified (historical rows not rewritten) | positionEvidence.test.ts |
| G. Friday zero approvals | EXPECTED_CONSERVATIVE_BEHAVIOR | Not a defect | existing audit |
| H. Agent disagreement | SIGNAL_QUALITY_LIMIT | Not a defect | calibration data |
| I. Reduced quant coverage | CAPACITY_LIMIT | Open, not code-fixable | existing audit |
| J. IBKR capacity pressure | CAPACITY_LIMIT | Open, entitlement-bound | existing audit |
| K. $2,000 not active | CONFIGURATION_NOT_ACTIVATED | Correctly classified; no pre-session check yet | existing audit |
| L. Orders CLI timeout | INSUFFICIENT_EVIDENCE | Open, unreproduced | existing audit |
| M. Unclean shutdowns | OBSERVABILITY_DEFECT | Open (cause of recurrence unknown) | existing audit |
| N. Watchdog reliability | OBSERVABILITY_DEFECT | Open | existing audit |
| O. Position/order lineage | OBSERVABILITY_DEFECT | Partially closed | this session |
| P. Synthetic coverage | See synthetic report | Substantially improved; some gaps remain | this session |
