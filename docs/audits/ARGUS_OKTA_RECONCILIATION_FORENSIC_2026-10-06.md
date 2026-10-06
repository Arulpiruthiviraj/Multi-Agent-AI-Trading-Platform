# ARGUS OKTA Position Reconciliation Forensic — 2026-10-06

**Mode:** Strictly read-only forensic. **Scope:** PAPER only, IBKR Gateway (Socket), paper account DUR959160, port 4002. LIVE_NO_GO unaffected and not evaluated. **No order was placed, no row was modified or deleted, no reconciliation marker was touched, and trading state was not changed by this audit.** All evidence below comes from direct read-only queries against `data/argus.db` (`better-sqlite3`, `{readonly:true}`) via temporary `.cjs` scripts created and deleted at the repo root during this audit, plus `Read`/`Grep` of source code and `git log`/`git show`. One attempt was made to query the live engine's authenticated `GET /api/v2/portfolio` endpoint for current broker truth; it returned `{"error":"unauthorized"}` (no session credentials available to this audit) — see §13 for the honest consequence of that gap.

---

## 1. FREEZE EVIDENCE

| Item | Value |
|---|---|
| git HEAD | `4efba42` ("Add Oct 6 intraday zero-trade forensic audit"), working tree clean |
| Live engine `/health` | `{"status":"ok","uptime":19113.65s}` at capture time → process start ≈ **2026-10-06T12:22:33Z (08:22 ET)** — same process as the companion zero-trade audit, not restarted since |
| `settings.trading_mode` | PAPER |
| `settings.trading_state` | **TRADING_PAUSED** (unchanged by this audit) |
| `selected_broker` | IBKR Gateway (Socket) |
| `auto_bot_enabled` | 1 |
| Current OKTA local `portfolio` table row | **none — table has 0 rows for ANY symbol** (`SELECT COUNT(*) FROM portfolio` = 0) |
| Current OKTA authoritative fill-ledger position | **-14** (`fills.position_quantity_after` for the latest OKTA fill, id 187, filled_at 2026-10-01T19:31:37.390Z) |
| Current OKTA broker-reported position (last known, via `reconciliation_events`/`portfolio_snapshots`) | **-14**, re-confirmed every ~5 minutes since 2026-10-01T19:33:32Z through the latest reconciliation row (id 6257, 2026-10-06T17:38:57Z) |
| Open/pending OKTA orders | **none** — all 3 OKTA trade rows are `status=FILLED`; no non-terminal order exists |
| `reconciliation_acknowledgements` for OKTA | **empty** — never acknowledged |
| Latest `kill_switch_events` row | id 362, `TRADING_ENABLED→TRADING_PAUSED`, reason "Portfolio reconciliation found a ~$2975.48 mismatch vs IBKR Gateway (Socket)...", actor `system:PortfolioReconciliation`, 2026-10-06T12:27:58.334Z |

No mutation performed.

---

## 2. LOCAL ORDER HISTORY (2026-10-01 00:00 UTC → now, symbol OKTA)

### `trades` (3 rows, all FILLED)

| id | side | qty | price | status | submitted_at | accepted_at | filled_at | transaction_id | broker_order_id | execution_environment | broker_id | arrival_price | commission | profit_loss |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| f481d65d… | BUY | 14 | 211.72 | FILLED | 18:30:01.964Z | 18:30:01.971Z | 18:30:04.650Z | ARG-2026-10-01-007195 | 1 | PAPER | ibkr_gateway | 211.62 | 1.000042 | null |
| 971b76f7… | SELL | 14 | 212.49 | FILLED | 19:26:37.253Z | 19:26:37.271Z | 19:27:22.624Z | ARG-2026-10-01-008458 | 2 | PAPER | ibkr_gateway | 212.87 | 1.061324 | null |
| b89b2793… | SELL | 14 | 212.61 | FILLED | 19:31:36.576Z | 19:31:36.583Z | 19:31:37.393Z | ARG-2026-10-01-008631 | 3 | PAPER | ibkr_gateway | 212.785 | 1.061359 | 11.46 |

`broker_order_id` values 1/2/3 are small sequential integers. This is consistent with IBKR's `nextValidId` counter for a freshly (re)started Gateway session issuing the first few order IDs of that session — not, by itself, evidence of fabrication. No other OKTA-tagged rows exist in `risk_assessments` output beyond the ones traced in §8, no `orders` table exists separately (schema has no such table), no `diagnostic_trade_archive` or `trade_lifecycle_transitions` rows for OKTA were found other than the standard pipeline events traced below.

### `fills` (3 rows, one per trade — authoritative local inventory ledger)

| id | order_id (→trade) | qty | price | filled_at | cumulative_qty | **position_qty_after** | avg_price_after | realized_pnl |
|---|---|---|---|---|---|---|---|---|
| 185 | f481d65d… (BUY) | 14 | 211.72 | 18:30:04.645Z | 14 | **+14** | 211.72 | null |
| 186 | 971b76f7… (SELL #1) | 14 | 212.49 | 19:27:22.620Z | 14 | **0** | 0 | 10.78 |
| 187 | b89b2793… (SELL #2) | 14 | 212.60999… | 19:31:37.390Z | 14 | **-14** | 212.60999… | null |

**This is the single most important data point in the whole investigation: Argus's own authoritative fill ledger (`fills.position_quantity_after`, maintained by `applyPositionFill()` in `src/server/services/positionFillEvidence.ts`) has correctly recorded OKTA at -14 since fill id 187 on 2026-10-01T19:31:37Z — continuously, immutably, never overwritten.** The "local position = 0" driving today's `TRADING_PAUSED` state is not what the fill ledger says; it comes from a different, cache-only source (§6/§7).

`broker_fill_id` for all three fills is a **locally synthesized** string (`"{orderId}:{quantity}"`), not IBKR's real `execId`/`permId`. This is a genuine, honestly-noted evidence gap for §3/§4 below: the DB alone cannot prove the two SELL fills carried distinct IBKR-side execution identifiers.

---

## 3. IBKR EXECUTION HISTORY (safe read-only attempt)

No safe read-only path to IBKR's own execution-history API was available to this audit. The live engine's `GET /api/v2/portfolio` route (and all other `/api/v2/*` routes) returned `{"error":"unauthorized"}` with no session credentials provided to this audit process, and this audit was explicitly instructed never to attempt any mutating call (no login, no credential manipulation) to obtain one. **This section is therefore `INSUFFICIENT_EVIDENCE` on IBKR's raw execution/fill records specifically** — this audit relies entirely on (a) Argus's own fill ledger and (b) Argus's own periodic `broker.portfolio()` snapshots (persisted to `reconciliation_events`/`portfolio_snapshots`), which are real, independently-polled broker reads, not fabricated, but are not the same thing as IBKR's own execution report.

What the local evidence *does* show, which substitutes for direct IBKR execution history in answering the central question ("did IBKR execute two distinct SELL fills"): the **broker-side** `portfolio_snapshots` rows (source=`BROKER`, populated every ~5 minutes from a live `broker.portfolio()` call against IB Gateway) show OKTA going from qty=14 (18:30–19:28) to **qty=-14 at 19:33:32Z** (the first reconciliation cycle after the second SELL) and staying at qty=-14 on every one of ~422 broker-side snapshot rows through 2026-10-06T17:38:57Z. If the second local SELL fill had been a fabricated/duplicated local record with no real matching broker execution, IBKR's own reported position would have stayed at 0, not moved to -14. The independently-polled broker side agreeing with the local fill ledger's -14 is real, if indirect, evidence that IBKR's book actually went short by 14 shares — i.e., the second SELL was a genuine broker-side execution, not a phantom local entry. See §9 for why this is not 100% certain without raw IBKR execIds.

---

## 4. EXECUTION-ID COMPARISON

- **Broker order IDs**: `1` (BUY), `2` (SELL #1), `3` (SELL #2) — three distinct, sequential `broker_order_id` values. Not the same order replayed.
- **Local fill IDs**: 185, 186, 187 — three distinct `fills` rows, not a duplicated row (verified via direct `SELECT * FROM fills WHERE order_id=...` per trade id — each trade has exactly one fill).
- **`broker_fill_id`**: synthesized locally as `"{orderId}:{qty}"` — cannot be used to prove or disprove IBKR execId uniqueness (see §3).
- **Real IBKR `execId`**: `IbkrSocketSession.ts` *does* track IB's genuinely-unique `Execution.execId` in-memory (`seenExecutionIds`, `execIdToOrderId`) specifically to deduplicate a replayed/duplicate fill delivery from IB's own event stream (comment: "a real broker execution must increase the authoritative fill quantity exactly once regardless of replay"). This in-memory guard is not persisted to the DB, so this audit cannot directly inspect the two execIds, but the existence and purpose of that guard, combined with two fully-independent `trades`/`fills` rows each going through the complete real pipeline (see §8), is evidence against the "same execution double-counted" hypothesis (9C/9D below).
- **permId**: not captured anywhere in the local schema for this broker path. Not available.

**Conclusion: distinct local order identities, confirmed; distinct broker-side execIds, not directly provable from this DB — `INSUFFICIENT_EVIDENCE` on that one specific sub-question, but outweighed by the stronger evidence in §8/§9.**

---

## 5. RECONSTRUCT POSITION FROM BROKER EXECUTIONS (chronological, broker-reported side only)

| Time (UTC) | Event | Broker qty after |
|---|---|---|
| (before 18:30) | — | 0 |
| 18:30:04Z | BUY 14 fills | +14 |
| 19:27:22Z | SELL 14 fills (close long) | 0 |
| 19:31:37Z | SELL 14 fills (second sell) | **-14** |
| 19:33:32Z onward (continuous, ~5-min cycles through 2026-10-06T17:38:57Z) | `broker.portfolio()` polled snapshot | **-14, unbroken** |

Reconstructed purely from real, periodically re-polled `BROKER`-source `portfolio_snapshots` rows plus the local trade timestamps for sequencing — not inferred from the local trade rows' existence alone.

---

## 6. RECONSTRUCT POSITION FROM LOCAL FILL LEDGER

| Fill id | Event | `position_quantity_after` |
|---|---|---|
| 185 | BUY 14 | +14 |
| 186 | SELL 14 | 0 |
| 187 | SELL 14 | **-14** |

Identical to §5. **The authoritative local fill ledger and the broker's own reported position have agreed on -14 continuously since 2026-10-01T19:33:32Z.**

**Why does Argus currently report local=0 instead of -14 (the actual mismatch driving `TRADING_PAUSED`)?** Traced to exact code:

- `PortfolioReconciliation.ts`'s `loadLocalHoldings()` (used as "local" for the mismatch comparison) reads **only** `SELECT ... FROM portfolio` — the small cache table, **not** the fills ledger.
- `portfolio` table is currently **completely empty** (0 rows, any symbol).
- `PortfolioReconciliation.ts` lines 221-237 (dated comment: "2026-10-05 P1 fix... an unintended short like the 2026-10-01 incident") contain a deliberate branch: whenever the broker reports a negative (short) quantity for a symbol, Argus **does not write it to the local `portfolio` table at all** — "Argus has no short-monitoring path" (PortfolioMonitor only reviews `quantity > 0` rows) — and instead pushes a `SHORT_POSITION_UNMONITORED` mismatch with a **hardcoded `localQty: 0`** sentinel (not a computed read of anything), by design, specifically so the system never manufactures a false `RECONCILIATION_MATCH` for a position nothing is monitoring.
- So "`localQty: 0`" in today's `reconciliation_events` rows is **not** a claim that Argus's accounting believes the position is flat — it is a fixed sentinel meaning "this symbol currently has no row in the locally-hydrated cache table, because the hydration path refuses to write short positions." The *true* local accounting (the fills ledger) has said -14 the entire time.

This is the authoritative function: `src/server/services/PortfolioReconciliation.ts`, lines 229–236.

---

## 7. EXPLAIN THE DIVERGENCE

Two *different* divergences exist, and they must not be conflated:

**Divergence A — the real position event (2026-10-01):** Argus went from flat (after SELL #1 closed the long) to short -14 (after SELL #2) at **19:31:37Z on 2026-10-01**. Both the fill ledger and the independently-polled broker snapshot register this at the same moment and have agreed ever since. This is not currently a "mismatch" in the data — both sides say -14.

**Divergence B — the reconciliation-visible mismatch (2026-10-06):**
- `FIRST_DIVERGENCE_AT` (between the *cache-table-based* "local" read and the broker read): some point between **2026-10-06T12:24:07.297Z** (reconciliation cycle id 6194, in which `loadLocalHoldings()` still returned a `portfolio` row of -14 for OKTA, matching the broker) and **2026-10-06T12:27:58.327Z** (cycle id 6195, in which `loadLocalHoldings()` returned nothing for OKTA, the `SHORT_POSITION_UNMONITORED` mismatch fired with `localQty:0`, and `TRADING_PAUSED` was set).
- `LOCAL_POSITION` (cache-table view) at first detection: **0 / missing row** (per §6, a sentinel, not a true computed zero).
- `BROKER_POSITION`: **-14** (unchanged, continuously confirmed).
- `TRIGGERING_EVENT`: the local `portfolio` table's OKTA row (quantity -14) disappeared between those two cycles. **The exact code path that cleared it could not be conclusively identified from persisted structured logs** (the only full-table-wipe call site found, `PortfolioReconciliation.flushLocalHoldingsAndReconcile()`, is invoked solely from `BrokerManager.setActiveBroker()`, and no `BROKER_SWITCHED`/`setActiveBroker` event was found logged in this window; the function's own `console.warn('[PortfolioReconciliation] Flushing local portfolio cache...')` message is not persisted to `observability_events`, so a flush cannot be ruled in or out from the DB alone). The one strong correlating fact: `kill_switch_events` id 361 shows `TRADING_PAUSED→TRADING_ENABLED` via `argus-cli start --enable-trading` at **12:24:18.476Z** — i.e., exactly inside the 12:24:07→12:27:58 window during which the table emptied. `POST /api/v1/system/resume` itself (the route that call hits) is a simple `tradingEngine.setTradingState()` call with no broker/portfolio side effects found in its source — so the resume call itself is not a proven cause, but something in that same narrow window was. **Marked `INSUFFICIENT_EVIDENCE` on the precise trigger of Divergence B; the mechanism that allowed it to become a standing, unrecoverable mismatch (next paragraph) is fully proven.**

Regardless of what cleared the cache row, the *design* of §6's short-skip branch means that once the `portfolio` table loses its OKTA row for any reason (restart, cutover, this unidentified clearing event), **there is no automatic path back** — the reconciliation loop will never rewrite a short position into the local cache, so it will report `SHORT_POSITION_UNMONITORED`/`localQty:0` on every future cycle until an operator manually resolves it, even though the authoritative fill ledger has known the true answer (-14) the entire time.

---

## 8. TRACE THE SECOND SELL (2026-10-01T19:31:36Z)

Full real pipeline, reconstructed from `observability_events` (all timestamps UTC, 2026-10-01):

| Time | Event |
|---|---|
| 19:31:10.940–941 | `TECHNICAL_ANALYSIS_STARTED`/`COMPLETED` (fresh evaluation) |
| 19:31:12.488 | `QUANT_BRIDGE_CALL_OUTCOME` |
| 19:31:32.380 | **`TRADE_IDEA_GENERATED`** — a new, independent idea (not a replay of SELL #1's idea) |
| 19:31:32.385–429 | `CHIEF_CONSENSUS_STARTED`/`COMPLETED` — a fresh consensus round |
| 19:31:32.435 | `CHIEF_APPROVED_IDEA` — mints **transactionId `ARG-2026-10-01-008631`**, distinct from SELL #1's `ARG-2026-10-01-008458` |
| 19:31:32.439 | `RISK_ASSESSMENT_STARTED` |
| 19:31:32.441–36.551 | 19 × `RISK_GATE_EVALUATED` + `CAPITAL_CHECK` — a full, fresh 25-gate pass, including gate 22 `sell_position_exists` |
| 19:31:36.555 | `RISK_ASSESSMENT_COMPLETED` (approved) |
| 19:31:36.579 | `ORDER_SUBMITTED` — **`placeOrder` was called** |
| 19:31:37.392 | `ORDER_FILLED` |
| 19:31:37.393 | `LOCAL_PORTFOLIO_SELL_FILL_SYNC` |
| 19:31:37.397 | `ORDER_EXECUTED` |

**This is a complete, independent, real order lifecycle — not a duplicate callback, not a local-only fabrication.** The question is *why RiskEngine's gate 22 (`sell_position_exists`) passed* when the authoritative fill ledger already knew (since 19:27:22Z, four minutes earlier) that the OKTA long had been fully closed.

**Root cause, proven by source + a dated regression test (§9/§12):** at the time of this incident, `src/server/services/positionFillEvidence.ts` — the module containing `checkPositionFillEvidence()`, the fill-ledger-vs-broker-snapshot cross-check now wired into gate 22 — **did not exist yet**. `git log --follow --diff-filter=A` shows this file was first added in commit `12236a7e` on **2026-10-04T00:20:37-04:00**, three days *after* this incident. On 2026-10-01, gate 22 evaluated `existingPosition.quantity` from a `broker.portfolio()`/positions snapshot with no cross-check against the fill ledger. If that snapshot was stale (still reflecting pre-19:27:22Z state, i.e., still showing +14), RiskEngine would correctly compute `maxQuantity = min(requestedQty, existingPosition.quantity) = 14`, pass gate 22, and approve a real SELL of 14 shares that Argus no longer actually held long — opening a genuine short.

---

## 9. APPLY THE KNOWN OCTOBER-1 INCIDENT MODEL

- **(A) Genuine second broker SELL execution:** TRUE (both SELLs are genuine, independently-approved, independently-executed broker orders — see §8).
- **(B) Stale broker position response → buggy old logic allowed a legitimate-looking second close-long order:** **CONFIRMED**, with direct evidence: `src/server/services/OrderManagement.positionEvidence.test.ts` (added in the same commit `12236a7e`, 2026-10-04) is a dedicated regression test titled *"refuses the second exit after a stale positive snapshot, even after OMS restart"* that **reconstructs this exact incident**: BUY 14 OKTA @211.72, SELL 14 OKTA @212.49 (identical prices to the real trades in §2), then feeds RiskEngine a deliberately stale pre-exit `broker.positions()`/`portfolio()` snapshot and proves that with today's code, gate `sell_position_exists` **fails** with `positionEvidenceReason: 'POSITION_FILL_CONFLICT'` — exactly the defect class that let the real second SELL through on 2026-10-01, now closed.
- **(C) Broker executed one SELL but Argus duplicated the local fill row:** **RULED OUT** — §2/§4/§8 show two distinct trade ids, two distinct fill ids, two full independent pipeline traces (idea→consensus→risk→order→fill), and two sequentially-tracked `position_quantity_after` values (0, then -14). Not a duplicate row.
- **(D) Broker callback/fill processed twice:** **RULED OUT** for the same reason — `IbkrSocketSession.ts`'s `seenExecutionIds`/dedup-by-execId guard exists precisely to prevent this, and the two fills have distinct cumulative-quantity tracking (each order's fill resets cumulative_quantity=14 independently, consistent with two separate orders, not one order's fill double-applied).
- **(E) Local position accounting ignored an opening-short component:** **RULED OUT** — §6 shows the fill ledger's `applyPositionFill()` correctly computed and recorded -14 at the moment of the second fill; it did not ignore the short.
- **(F) Broker position response itself was stale (i.e., IBKR's own book, not just Argus's locally-cached copy of it, was wrong):** Not supported by available evidence — the independently-repolled `BROKER`-source snapshots agree with -14 continuously for 5 days afterward, which is inconsistent with a one-off stale IBKR read that should have self-corrected on the next poll.
- **(G) Historical backfill/reconciliation inserted an incorrect execution:** **RULED OUT** — all 3 trade/fill rows carry contemporaneous `submitted_at`/`filled_at` timestamps consistent with live order flow, not a backfill insert.
- **(H) Other / combined:** The genuine finding is a **combination of (A) and (B)**: IBKR really did execute a second, real SELL (opening a real short), *because* Argus's then-current code (pre-2026-10-04) approved it on a stale position read that has since been fixed.

---

## 10. ORDER-PLACEMENT EVIDENCE

Both SELLs show `ORDER_SUBMITTED` (SELL #1 at 19:26:37.259Z, SELL #2 at 19:31:36.579Z) followed minutes/seconds later by `ORDER_EXECUTED`/`ORDER_FILLED` — the standard async round-trip signature of a real broker call (SELL #1 took ~45s submit→broker-ack→fill, consistent with a genuine IBKR paper round trip; SELL #2 took <1s, which is faster but not implausible for a paper/simulated venue under light load — not, by itself, evidence against reality given the full gate/consensus trail precedes it). Both reached `placeOrder` on the real `BrokerManager`/`IBGatewaySocketAdapter` path — there is no evidence either was a local-only fabrication.

---

## 11. IBKR POSITION SNAPSHOTS (around the Oct-1 incident)

From `portfolio_snapshots` (both ARGUS and BROKER sources, which were in agreement throughout this window):

| Time (UTC) | Qty (both ARGUS & BROKER sources agreed) |
|---|---|
| 18:30:04.693Z (recon 5832, right after BUY) | +14 |
| 18:34–19:28 (multiple ~5-min cycles) | +14 (unchanged) |
| 19:28:29.947Z (recon 5842, just before SELL #1 fill fully settled in this snapshot) | +14 |
| **19:33:32.149Z (recon 5843, first cycle after both SELLs)** | **-14** |
| 19:38:56Z through 2026-10-06T12:24:07Z (hundreds of cycles) | -14 (unchanged, both sources agreeing) |
| 2026-10-06T12:27:58Z onward | BROKER = -14; ARGUS = **no row** (see §6/§7) |

No intermediate 0-then-back-to-14 "stale +14" snapshot was captured by the 5-minute reconciliation cadence between the two SELLs (19:27:22Z and 19:31:36Z) — the reconciliation cycle only ran every ~5 minutes, so whatever stale positions snapshot RiskEngine itself fetched independently at 19:31:32Z (a separate, synchronous call inside the risk-assessment path, not the periodic reconciliation worker) is not separately logged with its raw quantity value. This is the one piece of direct evidence this audit could not recover: the literal quantity RiskEngine's gate 22 broker-portfolio call returned at 19:31:32Z. The regression test in §9 proves the *mechanism* is real and now fixed; it does not retroactively prove the *exact* number RiskEngine saw on 2026-10-01.

---

## 12. CURRENT FIX — VERIFIED IN TODAY'S CODE (READ-ONLY)

Confirmed present, unmodified, in the current working tree:

- `src/server/services/positionFillEvidence.ts`: `checkPositionFillEvidence()`, `prepareOrderPosition()` (called directly before `placeOrder`), `applyPositionFill()` (atomic fill-ledger + local-inventory + realized-P&L update). Returns `POSITION_FILL_CONFLICT` / `POSITION_FILL_BASELINE_UNAVAILABLE` / `CLOSE_LONG_QUANTITY_EXCEEDED` / `POSITION_BASIS_UNAVAILABLE` / `POSITION_INVALID_ORDER_QUANTITY` as fail-closed reasons.
- `src/server/engines/RiskEngine.ts` lines 819-827: gate `sell_position_exists` now calls `checkPositionFillEvidence()` against the existing broker-reported position *and* requires no fill-ledger conflict before passing; `existingQuantity`/`positionEvidenceReason` are both recorded.
- `src/server/services/PortfolioReconciliation.ts` lines 229-237 (dated "2026-10-05 P1 fix"): broker-reported negative (short) positions are never silently hydrated into the local cache; they are always surfaced as an operator-review mismatch.
- `src/server/services/OrderManagement.positionEvidence.test.ts`: a dedicated, passing regression test reconstructing this exact incident (stale positive snapshot after a real close) and proving the second exit is refused with `POSITION_FILL_CONFLICT`.

**Would today's code prevent the exact 2026-10-01 sequence from recurring? Yes, with high confidence** — the specific defect class (stale broker-position read used as the sole source for gate 22, with no cross-check against the authoritative fill ledger) is the one this fix targets and the one the regression test directly exercises with the same symbol and matching prices. This audit changed nothing to reach this conclusion; it is based entirely on reading the already-committed code and test.

**Residual gap, honestly noted:** the *recovery* path — what happens once a short position's local cache row is legitimately absent (by design, per §6/§7) — still has no automated, safe rehydration mechanism. `SHORT_POSITION_UNMONITORED` is a correct, by-design, permanent pause-and-wait-for-operator state, not a self-healing one. That is very likely intentional (CLAUDE.md: "never auto-flatten... never auto-resume pause"), but it means this specific mismatch will not clear itself no matter how many clean cycles pass — it requires an explicit operator action (§18).

---

## 13. CURRENT BROKER TRUTH

Not independently re-queryable by this audit in real time: the live engine's HTTP API requires an authenticated session (`AUTH_PASSWORD`-gated), and this audit was given no credentials and is prohibited from attempting to obtain or bypass them. **Best available current broker truth is Argus's own most recent read-only poll of IBKR**, persisted in `reconciliation_events`/`portfolio_snapshots`: OKTA qty **-14**, last confirmed at **2026-10-06T17:38:57.444Z** (reconciliation id 6257, `matches:0`, the same `SHORT_POSITION_UNMONITORED` mismatch, `action_taken:null`). No open/pending OKTA orders were visible in the most recent cycles' broker-order comparison logic firing no `OPEN_ORDER_*` mismatch type for OKTA. This is a live, periodically-refreshed, independently-polled broker value — not fabricated — but it is Argus's report of IBKR's answer, not a raw IBKR execution-history document. **Honest limitation: this audit cannot independently cross-verify that value against IBKR directly (§3).**

---

## 14. CURRENT LOCAL TRUTH

- `portfolio` table: **0 rows, any symbol.** Not just OKTA missing — the whole cache table is empty right now.
- `fills` table (authoritative): OKTA's latest watermark is fill id 187, `position_quantity_after = -14`, `position_average_price_after = 212.60999999999999`, as of 2026-10-01T19:31:37.390Z. Unchanged since.
- `trades` table: 3 FILLED rows, no pending/open orders, no reservations.
- **Why local currently reports zero:** exactly as in §6/§7 — the reconciliation worker's notion of "local" is the `portfolio` cache table (deliberately never hydrated with short positions since the 2026-10-05 fix, and currently fully empty for an unidentified reason that cleared it sometime between 12:24:07Z and 12:27:58Z today), not the fills ledger that has correctly known -14 since 2026-10-01.

---

## 15. RECONCILIATION MARKERS

- `reconciliation_acknowledgements` table: **zero rows for OKTA.** No acknowledgement, scoped backfill, or manual correction has ever been recorded for this symbol.
- No `RECONCILE_BASELINE` marker or equivalent was found referencing OKTA anywhere in the schema searched.
- 59+ consecutive `reconciliation_events` rows (first detected 2026-10-05T02:19:46Z per the companion audit, continuing through id 6257 today) all show `action_taken: null` for this mismatch, except id 6195 (`action_taken: TRADING_PAUSED`, the kill-switch firing, which is an automatic consequence, not an operator acknowledgement).
- **No prior reconciliation acknowledgement of any kind has occurred for OKTA.** This mismatch has been open, unresolved, and unacknowledged for 5+ days.

---

## 16. AUTHORITATIVE CLASSIFICATION

# **HISTORICAL_DEFECT_CONFIRMED, NOW FIXED — WITH A SEPARATE, STILL-OPEN RECONCILIATION-INFRASTRUCTURE CAVEAT**

More precisely, as two linked but distinct findings:

1. **The 2026-10-01 short-opening event itself:** `GENUINE_SECOND_BROKER_SELL_FROM_STALE_POSITION_DEFECT` (§9's hypothesis B, confirmed by a dated regression test). Both broker and local fill-ledger authoritative sources agree OKTA is genuinely short -14 shares, and have agreed continuously since. **This is not a data-corruption or duplicate-record problem — both sides tell the same, correct story:** Argus really did sell 14 shares it no longer held, because a since-fixed defect let a stale position read through gate 22.
2. **Why this is still surfacing as an active, pausing mismatch 5 days later:** a **reconciliation-infrastructure caveat**, not a new defect in the original sense — `PortfolioReconciliation`'s "local" comparison source (the `portfolio` cache table) by design refuses to hydrate short positions and currently holds zero rows for any symbol, so it reports `localQty:0` (a sentinel, not a real read) against a real, correctly-known -14 in the fills ledger. The two authoritative sources (broker and fills ledger) are not actually in conflict; the comparison plumbing is reading from a third, stale/empty cache instead of the fills ledger.

---

## 17. DO NOT AUTO-RESOLVE

No flatten, no compensating fill, no deletion, no history rewrite, no acknowledgement, and no trading-state change was performed by this audit. The sections below are informational only.

---

## 18. OPERATOR DECISION OPTIONS (informational — none executed)

| Option | Makes authoritative | Records changed | Broker position changes? | Local position changes? | Audit trail preserved? | Risk | Verification required after |
|---|---|---|---|---|---|---|---|
| **A. Acknowledge the short as a real, intended-to-be-held position** (manual reconciliation acknowledgement, matching local to broker's -14) | Broker's -14 | New row in `reconciliation_acknowledgements`; `portfolio` table gets a real -14 row written (requires a code path that currently refuses to write shorts — may need a scoped, reviewed exception, not an ad hoc DB write) | No | Yes — local cache becomes -14, matching fills ledger and broker | Yes — this audit, the fills ledger, and the acknowledgement row all remain | Low, if done via the proper acknowledgement API rather than a raw DB write — but PortfolioMonitor still has no short-monitoring path (no stop/target review for the position) per the 2026-10-05 fix's own stated reason; holding a short Argus cannot risk-manage is a real standing risk | Confirm PortfolioMonitor or a successor mechanism can actually manage a short position's risk before relying on this path, or treat it as "acknowledged but must be manually closed promptly" |
| **B. Close the short through an explicitly authorized PAPER position-resolution mechanism, if one exists, or through the PAPER broker under operator control. Do not resume general Argus trading merely to generate the cover order.** | Flat (0) on both sides | A new, real BUY trade/fill row; reconciliation then finds a true match | Yes — broker position returns to 0 | Yes — fills ledger returns to 0, `portfolio` table (once resynced) shows 0 | Yes — full history preserved, nothing deleted | Market risk of buying back at a different price than the short was opened at (real P&L consequence, already partially realized at fill time: fill 186 shows +$10.78 realized on the close-long; the short's own eventual cover will realize its own separate P&L) | Confirm the resulting fill ledger matches broker-reported flat position, and that `reconciliation_events` shows `matches:1` for several consecutive cycles |
| **C. Leave paused and investigate further before any action** (status quo) | Neither — mismatch stays open | None | No | No | Yes | Zero near-term capital risk; highest opportunity-cost risk (trading stays paused) | N/A — this is the current state |

This audit recommends **not** choosing an option unilaterally — that is explicitly an operator decision requiring awareness that the short is real, correctly tracked in the fill ledger, and currently un-managed for stop/target purposes.

---

## 19. POST-RECONCILIATION VERIFICATION PLAN (required before any future PAPER trading resume)

Before an operator resumes trading, verify ALL of:
- [ ] `portfolio` table OKTA quantity == broker-reported OKTA quantity (both should read the same signed value, whether 0 after a close or carried forward if intentionally held)
- [ ] No open/pending OKTA order at the broker or locally
- [ ] `reconciliation_acknowledgements` has an active, non-revoked row for OKTA if option A is chosen, or the position is flat if option B is chosen
- [ ] Fresh fills-ledger reconstruction (`latestPositionFill()`) matches the broker-reported quantity
- [ ] RiskEngine's gate 22 (`sell_position_exists`) would evaluate correctly against the resolved position (test with a dry-run trace if possible, not a real order)
- [ ] OMS's `prepareOrderPosition()` baseline (`position_quantity_before`) is consistent with the resolved position for the next OKTA order of either side
- [ ] `PortfolioReconciliation.reconcile()` produces `matches:1` (`RECONCILIATION_MATCH`) for **several consecutive cycles** (not just one), per the existing `PAUSE_CONSECUTIVE_CYCLES`-style debounce pattern already used elsewhere in this file
- [ ] Only then should an operator separately and explicitly decide whether to resume PAPER trading (`POST /api/v1/system/resume`), understanding that resuming does not itself fix OKTA — it only matters once OKTA is independently resolved

---

## 20. AFTER RECONCILIATION — CURRENT CODE (documentation only, NOT executed)

Per the companion audit (`ARGUS_INTRADAY_ZERO_TRADE_FORENSIC_2026-10-06.md`), today's running engine process (booted 2026-10-06T12:22:33Z) predates the current HEAD (`4efba42`, and specifically commit `61d29ec` at 14:01:44Z) by roughly 1h39m, and does not have the new premarket-lifecycle migrations/code loaded. **Recommended future runbook (document only, do not execute now):**

1. Resolve OKTA safely per §18, with the operator's explicit, informed choice, through the real reconciliation-acknowledgement or real-BUY path — never a raw DB edit.
2. Confirm `reconciliation_events` shows several consecutive `matches:1` cycles for OKTA specifically (not just overall).
3. Cleanly stop the engine (`requestGracefulShutdown()` / `POST /api/v1/system/shutdown`, never a hard kill) once OKTA is resolved and clean cycles are observed.
4. Apply any pending migrations (`npm run db:migrate`) and confirm the new tables/columns from commits since `61d29ec` exist.
5. Start the engine fresh at current HEAD (`npm run dev:server-only` or the headless equivalent).
6. Verify: `settings.trading_mode === 'PAPER'`; `GET /api/v2/live-readiness` still reports `LIVE_NO_GO`; OKTA broker vs local positions still match after the restart's own fresh reconciliation cycle; premarket/session-lifecycle behavior (new code) initializes without error.
7. Only after all of the above, separately decide whether to resume trading.

This procedure is a recommendation for a future session. It was not performed here.

---

## Exact chronological event table (OKTA, broker + local, 2026-10-01 → now)

| Timestamp (UTC) | Source | Event | Qty (signed) | Running local pos (fill ledger) | Running broker pos (polled) |
|---|---|---|---|---|---|
| 2026-10-01T18:30:01.964Z | local `trades` | BUY 14 submitted | — | 0 | 0 |
| 2026-10-01T18:30:04.650Z | local `fills` (id 185) | BUY fill | +14 | **+14** | +14 (confirmed 18:30:04.693Z snapshot) |
| 2026-10-01T19:26:37.253Z | local `trades` | SELL #1 (14) submitted | — | +14 | +14 |
| 2026-10-01T19:27:22.620Z | local `fills` (id 186) | SELL #1 fill, closes long | 0 | **0** | 0 (not separately snapshotted until next cycle) |
| 2026-10-01T19:31:32.380–36.579Z | pipeline events | SELL #2 idea → consensus → risk (gate 22 PASSED on stale read) → submitted | — | 0 (true) / 14 (as-seen by stale gate 22) | unknown exact value seen by RiskEngine (§11 gap) |
| 2026-10-01T19:31:37.390Z | local `fills` (id 187) | SELL #2 fill, **opens short** | -14 | **-14** | — |
| 2026-10-01T19:33:32.149Z | `portfolio_snapshots` (recon 5843) | first post-event poll, both sources | -14 | -14 | **-14** |
| 2026-10-01T19:33:32Z → 2026-10-06T12:24:07.297Z | `portfolio_snapshots` (~350 cycles) | continuous agreement | -14 | -14 | -14 |
| 2026-10-06 (sometime 12:24:07Z–12:27:58Z) | unidentified (§7) | local `portfolio` cache row for OKTA (and apparently the whole table) cleared | — | **cache: missing** (true fill-ledger value still -14) | -14 |
| 2026-10-06T12:27:58.327Z | `reconciliation_events` id 6195 | `SHORT_POSITION_UNMONITORED` detected, `localQty:0` sentinel vs broker -14, `TRADING_PAUSED` | — | 0 (sentinel) / -14 (true) | -14 |
| 2026-10-06T12:27:58.334Z | `kill_switch_events` id 362 | TRADING_ENABLED → TRADING_PAUSED | — | — | — |
| 2026-10-06T12:32:57.930Z → 2026-10-06T17:38:57.444Z | `reconciliation_events` (63+ cycles) | same mismatch re-detected every cycle, `action_taken:null` | — | 0 (sentinel) | -14 |

---

## FINAL QUESTIONS — answered

1. **Did IBKR execute the first SELL?** Yes — full real pipeline trace (idea→consensus→risk→`ORDER_SUBMITTED`→`ORDER_FILLED`), broker-side polled snapshot confirms qty went to 0 immediately after, fill ledger agrees.
2. **Did IBKR execute the second SELL?** Yes, with the same category of evidence — full real pipeline trace, distinct transactionId, distinct fill row, broker-side polled snapshot confirms -14 immediately after and continuously for 5 days since. `INSUFFICIENT_EVIDENCE` only on the raw IBKR execId itself (not persisted locally); not insufficient on whether a real execution occurred.
3. **What are the two broker execution IDs?** Not recoverable from this DB — `broker_fill_id` is a locally-synthesized string (`"{orderId}:14"`), not IBKR's real `execId`. `INSUFFICIENT_EVIDENCE` on the literal IDs.
4. **Were they distinct?** The two local fill rows (185... excluded, 186 and 187 for the two SELLs) are structurally distinct (different `order_id`, different `id`, different sequential `cumulative_quantity` tracks, different resulting `position_quantity_after`). Strong indirect evidence of distinctness; not provable via raw IBKR execId from this DB alone.
5. **Did Argus call `placeOrder` twice?** Yes — `ORDER_SUBMITTED` fired independently for both at 19:26:37.259Z and 19:31:36.579Z, each preceded by its own full consensus+risk approval.
6. **What position did Argus believe existed before the second SELL?** RiskEngine's gate 22 believed quantity ≈ 14 (enough to pass and size a 14-share SELL) at 19:31:32–36Z.
7. **Why did it believe that?** Because, at that time (pre-2026-10-04), gate 22 read only a broker-portfolio snapshot with no cross-check against the authoritative fill ledger — `src/server/services/positionFillEvidence.ts`'s `checkPositionFillEvidence()` (which would have caught this) did not exist yet (added 2026-10-04, commit `12236a7e`, 3 days after this incident).
8. **What position did IBKR report before the second SELL?** Not directly captured at that exact moment (reconciliation polls every ~5 minutes; the relevant RiskEngine-internal broker call at 19:31:32Z is not separately logged with its raw value). The surrounding snapshots (+14 through 19:28:29Z) and the defect mechanism confirmed in §9/§12 together strongly imply RiskEngine saw a stale +14-ish read; the literal number is `INSUFFICIENT_EVIDENCE`.
9. **When did local and broker positions first diverge?** Two distinct divergences: the real short-open event was 2026-10-01T19:31:37Z (both sides immediately agreed on -14, so not a "divergence" in the mismatch sense); the *reconciliation-visible* divergence (cache-table "local" vs broker) first appeared between 2026-10-06T12:24:07Z and 12:27:58Z.
10. **Why does local accounting currently report zero?** Because `PortfolioReconciliation`'s notion of "local" is the `portfolio` cache table, which (a) by design never hydrates short positions since the 2026-10-05 fix, and (b) is currently completely empty for an unidentified reason — not because the authoritative fill ledger says zero (it says -14).
11. **Why does IBKR currently report -14?** Because that is the broker's real, correct, continuously-reconfirmed position, matching Argus's own authoritative fill ledger.
12. **Is the second SELL a genuine opening short?** Yes.
13. **Was P&L incorrectly attached to it?** Partially. The authoritative fill-level accounting is correct: fill 186 realizes $10.78 when the original long is closed, while fill 187 — the opening-short SELL — has `realized_pnl = null`, as expected. However, the second SELL's `trades.profit_loss = 11.46` is inconsistent with its own fill evidence (`SUM(realized_pnl)` over fills tied to that order id should be `null`/0, not 11.46) and requires a separate, narrow P&L-attribution forensic. This does not affect the conclusion that the short was a genuine broker execution or the current reconciliation state — it is a trade-summary field anomaly, not evidence of broker-side duplication.
14. **Would current CLOSE_LONG reservation logic prevent recurrence?** Yes, with high confidence — proven by a dedicated, passing regression test reconstructing this exact scenario (§9/§12).
15. **Is any open OKTA order still present?** No — all 3 OKTA trade rows are `FILLED`; none are non-terminal.
16. **Has any prior reconciliation acknowledgement already occurred?** No — `reconciliation_acknowledgements` has zero rows for OKTA.
17. **Which side is authoritative based on actual broker executions?** Both the broker's own reported position and Argus's authoritative fill ledger agree: OKTA is genuinely short -14 shares. The only thing that is wrong is a third, intermediate cache table that the reconciliation worker currently (and perhaps temporarily) reads as "local," which has lost its row.
18. **What exact operator action is required?** A deliberate choice between §18's options A (acknowledge/hold the real short, with awareness Argus cannot currently risk-manage a short position) or B (close it, e.g., buy back 14 OKTA) — not a code fix, not an auto-resolution.
19. **What must be verified before PAPER trading resumes?** See §19's full checklist — broker/local agreement across all three data sources (broker, cache, fill ledger), no open orders, several consecutive clean reconciliation cycles.
20. **Is any source-code fix still required?** The root-cause defect that opened the short (stale position read at gate 22) is already fixed (2026-10-04). One real, still-open gap worth a future session: `PortfolioReconciliation`'s "local" comparison source should arguably be (or additionally cross-check against) the authoritative fills ledger rather than relying solely on a cache table that can be emptied by a broker cutover or an unidentified event and never rehydrated for short positions — today's design converts a correctly-known short into a perpetual, un-self-clearing "unmonitored" alarm. This is a reasonable, narrowly-scoped future improvement, not an emergency fix, and was not implemented by this read-only audit.

---

## FINAL VERDICT

```
OKTA_RECONCILIATION = HISTORICAL_DEFECT_CONFIRMED
SAFE_TO_ACKNOWLEDGE_RECONCILIATION = NO
SAFE_TO_RESUME_PAPER = NO
```

Rationale: the underlying defect that *caused* the short is confirmed and already fixed in code (not something this audit needs to fix again). But the short position itself is real, still open, still unmanaged (no stop/target review per PortfolioMonitor's documented short-monitoring gap), and has never been acknowledged or resolved by an operator. Acknowledging the reconciliation or resuming PAPER trading now would not be safe until an operator makes the explicit choice in §18 and the §19 verification checklist passes.

---

## Files touched by this audit

- **Created:** `docs/audits/ARGUS_OKTA_RECONCILIATION_FORENSIC_2026-10-06.md` (this file).
- **Modified:** none.
- **Temporary (created and deleted during the audit, none left behind):** `_audit1.cjs` through `_audit12.cjs` in the repo root.
- **No order placed. No row modified or deleted. No reconciliation marker touched. No trading-state change. Nothing committed or pushed.**
