# Argus Capital Allocation Forensic Audit

Read-only audit. No code, config, or database rows were modified to produce this report.

## 1. Exact gating mechanism

**Source of truth for budget:** `settings.budget` (SQLite, `src/server/db/schema.ts:61`, column default `50000`; **current live value is `$2000`**, confirmed by direct query). Loaded fresh on every risk evaluation — `RiskEngine.ts:556`: `const rawBudget = replay ? replay.config.allocationBudget : (settings[0]?.budget ?? tradingEngine.state.budget)`. Replay/backtest sessions use a separate `replay.config.allocationBudget` and never read live `settings.budget` — no cross-contamination between research and live paper capital.

**Broker equity vs. Argus budget are two different numbers, enforced separately, never conflated:**
- `accountEquity`/`buyingPower` (gate #7, `invalid_account_equity`) come from `broker.portfolio()` — the real Alpaca/broker account, currently ~$100k+ per your example.
- `argus_capital_allocation` (gate #23) is computed entirely from `settings.budget`, never from broker equity. `PositionSizing.ts` and `CapitalAllocation.ts` never read `accountEquity` to size or cap a BUY against Argus's own allocation — confirmed by reading both modules in full.

**The exact formula** (`src/server/engines/CapitalAllocation.ts:24-52`, called from `RiskEngine.ts:558-573`):

```
usedPositions      = Σ (open position quantity × averagePrice)      — COST BASIS, not current market value
reservedPendingBuys = Σ (quantity × price) for every BUY trade row whose status is
                       NOT IN ('FILLED','REJECTED','CANCELED','CANCELLED')
used                = usedPositions + reservedPendingBuys
remaining           = max(0, allocated − used)

BUY passes iff:  requestedNotional ≤ remaining + 1e-9   (epsilon only for float rounding)
SELL/exit:       always passes — "SELL frees capital and never consumes allocation" (explicit rule)
```

`requestedNotional = maxQuantity × currentPrice`, where `maxQuantity` is whatever `PositionSizing.ts` already clamped to (order-notional cap, risk-per-share, buying power, concentration, sector, correlation) — so this gate is checked *after* every other sizing constraint, on the final proposed share count.

**Cost basis, not current market value** (answering your Phase 2.1 question directly): `usedPositions` is `quantity × averagePrice` (the price paid), not `quantity × currentPrice`. A position that appreciates does **not** grow `used` — Argus's allocation is tracked as "dollars actually deployed," not "current mark-to-market exposure." This is a real, deliberate, and defensible design choice, not a bug, but it means `remaining` can understate true current exposure if unrealized gains are large. It cannot be exploited to *overspend* the budget (deployed dollars are still capped correctly), only to under-represent current paper P&L exposure in this one specific gate's arithmetic.

## 2. Hard ceiling or soft target?

**Hard, fail-closed ceiling.** `evaluateAllocationGuard()` has no discretion, no override, no "close enough" tolerance beyond a `1e-9` float epsilon. Three fail-closed properties, all confirmed by reading the code:

- Missing/non-positive `allocated` → `passed: false`, reason `INVALID_ACCOUNT_EQUITY`-style explicit rejection (`"allocated budget is missing or not positive. No phantom capital is assumed"`) — never defaults to unlimited or to broker equity.
- Missing/zero `requestedNotional` → rejected outright, not silently treated as $0-safe.
- This is gate **#23 of 24**, evaluated in the fixed catalog order (`config/riskGateOrder.json`); like every other gate it is **recorded even after an earlier gate has already failed** (Phase 2 "evaluate every gate unconditionally" design), so its pass/fail is always a real, independently-computed result, never skipped or assumed.

Price appreciation cannot push you over the limit **for what "used" tracks** (cost basis is fixed at entry), and slippage on a single fill cannot either, since `requestedNotional` is computed from `maxQuantity × currentPrice` *before* submission — a real fill at a worse price could make the *actual* dollars spent marginally exceed what was reserved (whole-share MARKET orders, no fractional sizing), but this is bounded by one share's worth of price movement per order, not an open-ended risk.

## 3. Historical compliance

**Never exceeded.** Direct query against `data/argus.db`:

- Current open positions: GLD (1 share, cost basis $387.97) + NVDA (1 share, cost basis $206.85) = **$594.82 total cost basis**, well under the $2,000 budget.
- Every historical `argus_capital_allocation` gate evaluation in `risk_gate_results` has **passed** (6 of 6, 0 failures) — there is no recorded instance of this gate ever blocking a trade for budget reasons, and no evidence total exposure ever approached the ceiling. (Small sample — consistent with the consensus-starvation finding in `ARGUS_CONSENSUS_RUNTIME_FORENSIC.md`: very few BUYs have ever been approved at all.)

## 4. Identified vulnerabilities / edge cases

**A. Real concurrency gap: the capital reservation window is narrower than the risk-evaluation mutex.** This is the one genuine structural finding of this audit, not previously documented anywhere else in this repo.

- `RiskEngine.evaluationQueue` (`RiskEngine.ts:186`) is a **single, global** promise-chain mutex — it serializes the body of `evaluateRisk()` (all 24 gates, including reading `pendingBuys` from the `trades` table) across *every* symbol, not per-symbol.
- However, the mutex's protection ends the moment `evaluateRisk()` returns — which happens right after `persistThenPublishAssessment()` persists `risk_assessments` and emits `RISK_ASSESSMENT_COMPLETED`. It does **not** extend through order submission.
- `OrderManagementService`'s listener for `RISK_ASSESSMENT_COMPLETED` (`OrderManagement.ts:106-112`) is a separate, independently-scheduled async callback. The `trades` row that `argus_capital_allocation`'s `reservedPendingBuys` query depends on is only inserted once `executeOrder()` actually runs inside that callback — which happens *after* the mutex for the evaluation that approved it has already released.
- **Concrete failure window:** if idea A (BUY, symbol X) and idea B (BUY, symbol Y) are both evaluated back-to-back (A's mutex turn ends, B's begins essentially immediately), and OMS hasn't yet inserted A's PENDING trade row by the time B's own `argus_capital_allocation` gate runs its `db.select().from(schema.trades)` query, B will not see A's dollars as reserved. Both could then pass the capital gate even though, combined, they exceed `settings.budget`.
- **Why this hasn't manifested in practice:** (a) 0/6 historical approvals ever ran concurrently close enough to trigger it — approvals are extremely rare given the consensus-starvation issue documented separately; (b) the window is small (microtask-scale, not seconds); (c) it requires two *independent* approvals landing back-to-back, not a single runaway idea storm on one symbol (a same-symbol storm is caught by `same_symbol_cooldown`, gate #3). It is nonetheless a real, structurally-present race, not a hypothetical one — the mechanics are the same class of gap already found and fixed once this session (OMS's own idempotency-lookup ordering), just at a different layer.
- **Not fixed as part of this audit** — this was explicitly read-only. A fix would mean either reserving capital synchronously inside the same mutexed `evaluateRisk()` call (e.g., inserting a placeholder PENDING trade row before the mutex releases) or widening the mutex to cover order submission — both are changes to the protected execution spine and should not be made without explicit sign-off, consistent with `ARGUS_ARCHITECTURE_PROTECTION.md`.

**B. Scale-in / averaging positions.** `usedPositions` sums cost basis across *all* holdings of a symbol correctly (it iterates every position row), so adding to an existing position is correctly reflected in `used`. No gap found here.

**C. Uncounted pending orders across sessions.** `pendingBuys` is a live DB query on every evaluation (not an in-memory cache), scoped correctly to exclude `REPLAY`/backtest trace prefixes (`RiskEngine.ts:558-565`) so research activity never phantom-reserves live paper capital, and vice versa. No gap found.

**D. WebSocket price lag.** Not applicable to this specific gate — `argus_capital_allocation` uses the already-sized `maxQuantity × currentPrice` from earlier in the same evaluation, not a separately-fetched price, so it cannot go stale independently of the rest of that evaluation.

## Summary

The allocated-budget wall is real, fail-closed, and has never been breached in this system's history. The one substantive gap found is a narrow concurrency window between risk-approval and order-persistence that could theoretically let two independently-approved BUYs jointly exceed `settings.budget` — a structural finding worth fixing deliberately, not a currently-exploited hole.
