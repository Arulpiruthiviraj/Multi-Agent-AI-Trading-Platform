# ARGUS Short-Position Reconciliation Semantics Fix — 2026-10-06

**Scope:** PAPER only. Diagnosis/classification fix only — no execution, no OPEN_SHORT support,
no change to trading state, no acknowledgement, no resume. Follow-up to
`docs/audits/ARGUS_OKTA_RECONCILIATION_FORENSIC_2026-10-06.md` (unmodified by this task).

## 1. Root cause (already found by the forensic audit, reused here)

`PortfolioReconciliation.ts`'s short-position branch converted "broker reports a negative
quantity" directly into a hardcoded `localQty: 0` sentinel under the type
`SHORT_POSITION_UNMONITORED`, regardless of what the authoritative fill ledger
(`fills.position_quantity_after`, `positionFillEvidence.ts`) actually knew. For OKTA, the fill
ledger and the broker have agreed on -14 continuously since 2026-10-01T19:33:32Z. The reported
"mismatch" (broker -14 vs local 0) was never a real disagreement between authoritative sources —
it was the `portfolio` cache table (which, by a deliberate 2026-10-05 fix, never hydrates shorts)
losing its row and the reconciliation code reading that absence as a literal zero.

A second, related gap existed: the two position-compare loops in `reconcile()` only ever visit
symbols present in the broker's response or in the local `portfolio` cache. A symbol missing from
**both** (e.g. a short the cache refuses to hydrate, with the broker now also reporting it as
closed) was invisible to every existing check — a genuine broker/ledger disagreement in that
specific shape would never have surfaced at all.

## 2. Position-authority map (verified by reading the code, not re-derived)

| Source | File | Authoritative for |
|---|---|---|
| Broker (`broker.portfolio()`) | `BrokerManager` + adapter | Current broker-side truth (right now) |
| Fill ledger (`fills.position_quantity_after`) | `positionFillEvidence.ts` | Historical execution truth — immutable, append-only watermark |
| Portfolio cache (`portfolio` table) | `PortfolioReconciliation.ts` | Risk-managed position state **today** — the gap this task addresses; never hydrates shorts since 2026-10-05 |
| `PortfolioMonitor` | — | Reviews only `quantity > 0` cache rows — has no short-monitoring path (unchanged, out of scope) |
| RiskEngine gate 22 (`sell_position_exists`) | `RiskEngine.ts` + `checkPositionFillEvidence()` | Already cross-checks the fill ledger before approving a SELL (fixed 2026-10-04, untouched here) |
| OMS (`prepareOrderPosition()`) | `positionFillEvidence.ts` | `position_quantity_before` baseline for the next order on a symbol (untouched here) |

## 3. What changed

- `src/server/services/positionFillEvidence.ts`: added `listSymbolsWithFillLedgerHistory(brokerId, environment)` — a read-only query over `fills`/`trades` used only to find symbols with ledger history that neither the broker response nor the local cache currently surfaces.
- `src/server/services/PortfolioReconciliation.ts`:
  - Added `UNMANAGED_SHORT_POSITION` to the `MismatchDetail` type union (alongside the existing `SHORT_POSITION_UNMONITORED`, which is kept for the no-ledger-evidence case).
  - Short-position branch now calls `checkPositionFillEvidence()` before deciding how to classify:
    - Ledger **disagrees** with the broker → real mismatch, reported as `POSITION_FILL_CONFLICT`/`POSITION_FILL_BASELINE_UNAVAILABLE` (never softened).
    - Ledger **agrees** with the broker → `UNMANAGED_SHORT_POSITION`, with `localQty` set to the **true** fill-ledger quantity (never a fabricated 0).
    - **No** ledger evidence exists at all → unchanged `SHORT_POSITION_UNMONITORED` / `localQty: 0` (conservative, because agreement cannot be confirmed either way).
  - Added a bounded, additive fill-ledger-only cross-check after the existing local-holdings loop: for any symbol with fill-ledger history that is absent from both the broker response and the local cache, run the same `checkPositionFillEvidence()` comparison. This can only **add** a mismatch, never suppress one already found — it closes the "both sides silent" gap (case E).
- `src/server/routes/systemRoutes.ts`: `GET /api/v1/system/reconciliation/status` now returns the full per-symbol `mismatches` array (symbol/type/localQty/remoteQty/approxDollarImpact), not just a count — so an operator reading this endpoint is never told `local=0` when the fill ledger disagrees.
- `scripts/argus-cli.ts`: added `argus reconciliation-status`, a human-readable formatter of the same endpoint, explicitly labeling `UNMANAGED_SHORT_POSITION` with `Broker:` / `Fill ledger:` / `Portfolio monitor: SHORT_NOT_SUPPORTED` lines (matching the task's requested output shape) instead of ever printing a bare "local=0".

Nothing in `RiskEngine.ts`, `OrderManagement`-adjacent gate logic, the kill-switch mechanism, or the
`autoFlattenOnReconciliationMismatch`/pause-on-significant-mismatch code path was touched. The
pause trigger (`worstImpact >= SIGNIFICANT_MISMATCH_DOLLARS` while `TRADING_ENABLED`) is
unchanged — `UNMANAGED_SHORT_POSITION` mismatches flow through the exact same `dollarImpact()` →
`mismatches.push()` → pause logic as the classification they replace.

## 4. No short-execution paths added

Confirmed by inspection: no new code in this change opens, closes, stops, or targets a short.
`applyPositionFill()`, `prepareOrderPosition()`, and RiskEngine's gate 22 are untouched. This is
purely a reconciliation-classification change — the short, if any, is already open at the OMS/
fill-ledger level before `reconcile()` ever runs.

## 5. Tests

New file: `src/server/services/PortfolioReconciliation.shortSemantics.test.ts` (6 tests, one per
required scenario), run alongside the existing suite:

```
npx vitest run src/server/services/PortfolioReconciliation.shortSemantics.test.ts \
  src/server/services/PortfolioReconciliation.test.ts \
  src/server/services/OrderManagement.positionEvidence.test.ts
```

Result: **3 test files passed, 26 tests passed** (verified by running the command above — not
asserted from memory). This includes the pre-existing `SHORTX` test ("broker-side SHORT position
is flagged SHORT_POSITION_UNMONITORED and never hydrated") passing unchanged, confirming the
no-ledger-evidence case is byte-for-byte preserved, and the pre-existing OKTA stale-snapshot
regression test (`OrderManagement.positionEvidence.test.ts`) still passing unchanged, confirming
gate 22's 2026-10-04 fix is untouched.

`npm run lint` (`tsc --noEmit`): clean for every file touched by this change (`PortfolioReconciliation.ts`,
`positionFillEvidence.ts`, `systemRoutes.ts`, `scripts/argus-cli.ts`). The run reports 12 pre-existing,
unrelated errors from `scripts/tui/**` (`Cannot find module 'ink'`) — confirmed unrelated by grepping
the output for this change's filenames (zero matches); not introduced by this change.

## 6. FINAL VERDICT

```
POSITION_TRUTH = BROKER_LEDGER_AGREE   (for OKTA specifically — broker -14, fill ledger -14, continuously since 2026-10-01T19:33:32Z)
PORTFOLIO_CACHE = UNSUPPORTED_SHORT    (by design, unchanged — PortfolioMonitor still has no short-monitoring path)
RECONCILIATION_CLASSIFICATION = FIXED  (OKTA now classifies as UNMANAGED_SHORT_POSITION with the TRUE ledger quantity, not a fabricated local=0/SHORT_POSITION_UNMONITORED mismatch)
SAFE_TO_RESUME_PAPER = NO              (unchanged by this task — resuming requires a separate, explicit operator decision per the forensic audit's §18 options; this task only fixed how the situation is DIAGNOSED, not whether it is resolved)
```

This task does not and must not change `SAFE_TO_RESUME_PAPER`. The real OKTA short is still open,
still real, still un-risk-managed by `PortfolioMonitor`, and still requires an explicit operator
decision (acknowledge-and-hold or close) per the forensic audit. Trading remains paused.
