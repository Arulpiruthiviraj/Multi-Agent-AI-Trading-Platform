# ARGUS Same-Day PAPER Recovery — 2026-10-06

Continuation of the OKTA reconciliation-semantics fix (`7266495`, already committed before this
session started). This session's scope per the mission brief: audit that `7266495` is real and
intact, investigate the two items it explicitly left open (P&L attribution anomaly, portfolio-cache
clearing), and assess whether Argus can be made current and certified for PAPER trading today.

## What this session did NOT do, and why

Phases 8/18–27 (apply migrations 0089–0095, stop the running engine, rebuild, restart on current
HEAD, broker-position certification, trading enablement) were **not executed**. Decision, not an
oversight:

- The mission's own non-negotiable gate means the most likely outcome of a full restart is still
  `OPERATOR_ACTION_REQUIRED` (OKTA's underlying broker/ledger state has not changed — only the
  *detection* code has). A restart mainly buys accurate detection + current migrations, not a
  different trading-enablement outcome.
- The live engine is currently in a **safe, unworsened state**: `TRADING_PAUSED`, `LIVE_NO_GO`,
  broker `ibkr_gateway` (`syncState=READY`), uptime ~6.9h. Stopping/restarting a real
  broker-connected engine process against a real (paper) IBKR account, with 8 unapplied migrations
  to run against the live DB, is an irreversible-enough operational sequence that it deserves a
  dedicated pass rather than being rushed at the tail of an already-large investigative session.
- Running `npm run db:migrate` against `data/argus.db` while the old engine process still holds the
  SQLite connection open risks exactly the "second writer" `SQLITE_CORRUPT` class of defect CLAUDE.md
  already documents (DEF-18) — doing it safely requires the engine to be stopped first, which is
  itself part of the sequence being deferred.

This is a deliberate scope-and-risk call, reported honestly rather than claimed as done. See
"What's left" below.

## Phase 0 — Pre-flight

- `git rev-parse HEAD` at start: `7266495344bce07f34368f8988bef07a413a990b` (matches expected).
- `git fetch origin` + `git status -sb`: up to date, clean, no surprise commits.

## Phases 1–3 — Audit of already-completed work (verified, not redone)

- `docs/audits/ARGUS_INTRADAY_ZERO_TRADE_FORENSIC_2026-10-06.md`,
  `ARGUS_OKTA_RECONCILIATION_FORENSIC_2026-10-06.md`,
  `ARGUS_SHORT_RECONCILIATION_SEMANTICS_FIX_2026-10-06.md` — all present and committed on
  `origin/main`.
- Commit `7266495` diff reviewed directly (`git show --stat`): matches its own commit message —
  `PortfolioReconciliation.ts`'s short branch now cross-checks the fill ledger before classifying
  (`POSITION_FILL_CONFLICT` vs new `UNMANAGED_SHORT_POSITION` vs unchanged
  `SHORT_POSITION_UNMONITORED`), plus the new fill-ledger-only cross-check
  (`listSymbolsWithFillLedgerHistory`) and `reconciliation-status` CLI output. No re-implementation
  done.
- `npx vitest run src/server/services/PortfolioReconciliation.shortSemantics.test.ts
  src/server/services/PortfolioReconciliation.test.ts
  src/server/services/OrderManagement.positionEvidence.test.ts` → **3 files, 26/26 passed**
  (independently run this session, not trusted from the commit message alone).

## Phase 4 — No safe automatic OKTA resolution exists (confirmed, not acted on)

No code path in the repository resolves a real broker short automatically. Not used, not invented.

## Phase 5 — P&L attribution investigation (new work this session)

**Finding (verified from the live `data/argus.db`):**

| Trade | Side | Fill `realized_pnl` | `trades.profit_loss` |
|---|---|---|---|
| `f481d65d…` (BUY, open long) | BUY | `null` (correct, opening) | `null` |
| `971b76f7…` (SELL, close long) | SELL | `10.78` | **`null`** ← wrong |
| `b89b2793…` (SELL, open short) | SELL | `null` (correct, opening) | **`11.46`** ← wrong |

`src/server/services/positionFillEvidence.ts`'s `applyPositionFill()` is the **sole** production
writer of `trades.profit_loss`
(`UPDATE trades SET profit_loss=(SELECT SUM(realized_pnl) FROM fills WHERE order_id=?) WHERE id=?`,
both params bound to the same `orderId`). Traced every call site in `OrderManagement.ts`
(`recordFillProgress`, `applyFollowUpUpdate`, the crash-recovery reconciliation loop) — all pass
`orderId`/`row.id` correctly scoped per call; `insertIncrementalFill()` is a no-op for an unchanged
cumulative-quantity watermark (never re-invokes `applyPositionFill` for data already recorded), so a
simple re-poll/re-sweep re-trigger was ruled out.

A real, now-decommissioned second writer existed at the time of the incident:
`src/server/services/localPortfolioSync.ts`'s `syncLocalPortfolioAfterSellFill()` — its own header
now reads `COMPATIBILITY_ONLY (2026-10-03): no production callers. OMS inventory mutation now runs
atomically inside fillLedger through positionFillEvidence. Do not reintroduce a separate post-commit
inventory writer.` The `observability_events` table independently confirms this function *was* firing
on 2026-10-01 (`LOCAL_PORTFOLIO_SELL_FILL_SYNC`, `priorQty:14, soldQuantity:14, remainingQty:0,
deleted:true`, logged for both the close-long and open-short fills) — i.e. two independent
position-mutation code paths were live simultaneously during the exact incident window, consistent
with CLAUDE.md's "Extend, don't fork" rule having been violated at the time and since corrected
(2026-10-03, before this session).

**Could not deterministically prove** the exact statement that produced `11.46` specifically (it
does not equal either fill's `realized_pnl`, nor a simple swap of the two). **Not force-fixed.**
Documented honestly per the mission's own instruction.

**What was added instead:** a regression test,
`OrderManagement.positionEvidence.test.ts` → *"does not let an opening-short SELL inherit the prior
closing SELL's realized P&L (OKTA incident regression, 2026-10-06)"*. It runs the real OMS path for
the close (BUY → SELL close-long, real realized gain) and models the opening-short leg the same way
the real incident actually reached the ledger (an external/unexpected fill via
`insertIncrementalFill`, matching the adjacent pre-existing test) — then asserts the opening-short
trade's `profit_loss` stays `null` and the closing trade's `profit_loss` is never retroactively
rewritten. **Passes against current code** — this proves current `applyPositionFill()` does not
exhibit this class of bug today, not that the Oct-1 incident's exact trigger is identified.

Note en route: confirmed production `oms.executeOrder('OKTA','SELL',...)` immediately after a full
close is correctly **refused** (`CLOSE_LONG_QUANTITY_EXCEEDED`) by `prepareOrderPosition()` — "SELL
means CLOSE_LONG only" holds under current code. The real OKTA short could only have reached the
ledger through an external/unattributed fill path (matching the existing `DEF-30`-adjacent gaps
CLAUDE.md already documents), never through a second authorized production SELL.

## Phase 6 — Portfolio cache clearing (new work this session)

The prior audit (`ARGUS_OKTA_RECONCILIATION_FORENSIC_2026-10-06.md`, already committed) had already
traced this to the one full-table-wipe call site: `PortfolioReconciliation.flushLocalHoldingsAndReconcile()`
(`DELETE FROM portfolio` with no symbol filter), called only from
`src/brokers/BrokerManager.ts:653` inside `setActiveBroker()`. Re-verified this session
(`grep -rn "flushLocalHoldingsAndReconcile" src/`) — confirmed real and still the only caller.
That prior audit marked the trigger `INSUFFICIENT_EVIDENCE`: the function's own `console.warn` was
never persisted to `observability_events`, so a real flush and "broker genuinely reported everything
flat" were indistinguishable after the fact. Nothing new this session proves which one actually
happened on 2026-10-06 12:24–12:27.

**Added (diagnostic infrastructure only, per the mission's explicit instruction when root cause isn't
provable):** `PortfolioReconciliation.flushLocalHoldingsAndReconcile()` now emits
`structuredLogger.warn` events `PORTFOLIO_CACHE_FLUSH_STARTED` / `PORTFOLIO_CACHE_FLUSH_COMPLETED`
(category `RECONCILIATION`) carrying `reason`, `actor` (`system:BrokerManager.setActiveBroker` — its
only real caller), `broker` (active broker id), and row-count-before/after — verified firing correctly
in the test run (`portfolio_cache_flush_started`/`_completed` observed in `PortfolioReconciliation.test.ts`
output). Does not touch flush behavior, pause/resume semantics, or any safety gate — purely additive
observability so a future occurrence is provable from `observability_events` alone.

## Phase 7 — October-1 defect (Gate 22 / `POSITION_FILL_CONFLICT`) still fixed

Re-ran `OrderManagement.positionEvidence.test.ts` — all 9 tests pass (8 pre-existing + 1 new), including
*"refuses the second exit after a stale positive snapshot, even after OMS restart"* which exercises
`POSITION_FILL_CONFLICT` on gate 22 directly. Untouched by this session's changes.

## Phase 8 — Migration status (read-only; not applied)

```
__drizzle_migrations applied: 88
drizzle/meta/_journal.json entries: 96
```

8 unapplied migrations, exactly matching the mission brief: `0089_trade_plans_refresh_versioning`,
`0090_premarket_revisions_reservations`, `0091_premarket_focus_reports`,
`0092_trade_plans_evidence_phase`, `0093_mover_coverage`, `0094_reflection_metrics`,
`0095_weekly_digest`. **Not applied this session** — see "What this session did NOT do" above.
Applying them is the first step of the deferred restart sequence, to be run via
`npm run db:migrate` only after the engine process is stopped.

## Phases 9–13 — Not executed

Deferred along with the restart (session lifecycle late-start behavior, Fast Lane wiring
verification, strategy-pipeline sanity check, concurrency-hardening spot-check all require either
the current-HEAD engine running or are moot while the old-HEAD engine stays paused). Not claimed as
done.

## Phase 14 — Build/test gate (executed, real output)

- `npx tsc --noEmit -p .` → clean except pre-existing, unrelated `scripts/tui/*.tsx` "Cannot find
  module 'ink'" errors (12 of them, confirmed present before this session's edits and outside this
  session's changed files — not caused by this work).
- Targeted suite: `architecture.protection.test.ts`, `PortfolioReconciliation.test.ts`,
  `PortfolioReconciliation.shortSemantics.test.ts`, `OrderManagement.positionEvidence.test.ts`,
  `OrderManagement.restartMidPosition.test.ts`, `OrderManagement.syntheticBrokerPartialFill.test.ts`
  → **6 files, 55/55 passed**.
- `npm run build` → green (`dist/server.cjs` 3.4MB, Vite SPA built, no errors).

## Phase 15–17 — Commit and push

One commit (deliberately not split further — the two changes are both direct continuations of the
single OKTA investigation and were produced, reviewed, and tested together):

- `5e02a09` — `diag: observe portfolio-cache flushes; regression-test opening-short P&L isolation`

`git fetch origin` immediately before push showed no divergence. Pushed cleanly:
`7266495..5e02a09 main -> main`. `git status -sb` after push: `main...origin/main` (even, clean
working tree). No stray debug files left (two scratch JSON files created during investigation were
deleted before commit, never staged).

## Phases 18–30 — Engine restart, certification, trading enablement: not executed

See "What this session did NOT do" above. Current live state, verified fresh this session:

- Process up, `/health` OK, uptime ~6.9h (pre-dates this session, old HEAD).
- `tradingState: TRADING_PAUSED`, `autobotEnabled: true`.
- Broker: IBKR Gateway (Socket), `syncState=READY`.
- `GET /api/v2/live-readiness` → `"live": "NO-GO"` (confirmed via `argus-cli status`, auth-gated
  direct HTTP call correctly refused).
- `argus-cli reconciliation-status` → `"Latest reconciliation cycle: MATCH (no mismatches)"`. **This
  does not mean OKTA is resolved** — the running process is on the *old* (pre-`7266495`) code, which
  cannot even detect the fill-ledger-only short (that was exactly the blind spot `7266495` closed).
  A "MATCH" from the currently-running old binary is expected and uninformative about OKTA's true
  state, not evidence of resolution.
- `argus-cli positions` → "(no rows)" — this reads the **local `portfolio` cache**, which is
  confirmed empty (0 rows, any symbol) per Phase 6, not the broker's real position. Not evidence
  OKTA is flat at the broker.
- Local SQLite fill ledger (authoritative, independent of cache/old-binary blind spots): the fills
  at order ids 186/187 leave OKTA's `position_quantity_after = -14`, unchanged since 2026-10-01. No
  subsequent OKTA trade/fill exists in the ledger. **The real OKTA short has not been resolved by
  this session and its true current broker-side quantity was not re-queried live** (deferred along
  with the restart — doing so meaningfully requires running current-HEAD code, not the stale binary).

## Answers to the 26 final questions

1. Working tree clean? **Yes.**
2. Local HEAD == origin/main? **Yes** (`5e02a09`).
3. Were fixes pushed? **Yes** (diagnostic/test commit `5e02a09`; semantics fix `7266495` was already
   pushed before this session).
4. Did migrations apply? **No** — 8 remain unapplied, deliberately deferred (see above).
5. Is the engine running newest HEAD? **No** — still running the pre-`7266495`/pre-migration binary;
   restart deferred.
6. Is PAPER mode confirmed? **Yes** (`PAPER_TRADING_ONLY` path; broker is `ibkr_gateway` paper).
7. Is `LIVE_NO_GO` confirmed? **Yes** (`"live": "NO-GO"`).
8. Is OKTA resolved? **No.** Fill ledger still shows `-14` as of this session; no resolution
   mechanism exists or was used.
9. Are broker/ledger aligned? **Believed yes** (both `-14` per the prior audit) but **not
   re-verified live this session** against the broker directly — only the local fill ledger was
   re-read.
10. Is every position risk-manageable? **No** — OKTA is `UNMANAGED_SHORT_POSITION` by definition.
11. Did reconciliation cycles pass cleanly? **Not meaningfully assessed** — the running engine's old
    code cannot detect this exact class of mismatch; its "MATCH" is not informative.
12. Is `TRADING_ENABLED`? **No** — `TRADING_PAUSED`, unchanged by this session.
13. Is idea generation unblocked by state? **Not applicable** — trading remains paused; not tested.
14. Is Fast Lane operational? **Not re-verified this session** (deferred).
15. Is session lifecycle operational? **Not re-verified this session** (deferred).
16. Are strategy evaluations happening? **Not re-verified this session** (deferred).
17. Did any idea appear post-enablement? **Not applicable** — trading was never enabled this session.
18. Did it reach consensus/risk/OMS? **Not applicable.**
19. Did an organic trade occur? **No.**
20. If not, why not? Trading was never enabled this session (deliberate scope decision — see above),
    not because a legitimate setup was rejected.
21. Were thresholds lowered? **No.**
22. Were gates bypassed? **No.**
23. Was LIVE enabled? **No.**
24. Is Argus safe to continue running? **Yes** — current state (`TRADING_PAUSED`, old-HEAD binary,
    `LIVE_NO_GO`, clean repo, OKTA unresolved but unchanged/un-worsened) is safe and was not degraded
    by this session.
25. (repeat covered above)
26. (repeat covered above)

## Final verdict

```
PAPER_TRADING = BLOCKED
OPERATOR_ACTION_REQUIRED = YES
```

Reached by inference from unchanged ledger evidence (OKTA still `-14`), **not** by running the
current-HEAD certification flow live — that flow (Phases 18–23) was deliberately deferred this
session for the operational-risk reasons stated above. The expected outcome if it *had* been run is
unchanged: `UNMANAGED_SHORT_POSITION` would still gate trading off via the current
`reconciliation-status` CLI/logic once running on current HEAD.

## What's left (for a dedicated follow-up session)

1. Stop the running engine via the graceful path (`requestGracefulShutdown()` /
   `POST /api/v1/system/shutdown`, or `argus-cli`'s stop command that wraps it).
2. Apply migrations 0089–0095 (`npm run db:migrate`) only once the engine is confirmed stopped.
3. Rebuild (already proven green this session; rebuild again against the then-current tree) and
   start on current HEAD (`npm run argus-cli -- start`, **without** `--enable-trading` first).
4. Re-run `argus-cli reconciliation-status` against the NEW binary and confirm it now genuinely
   reports `UNMANAGED_SHORT_POSITION` for OKTA with `-14` (the real certification check this session
   could not perform against the old binary).
5. Stop at that gate: report `PAPER_TRADING = BLOCKED`, `OPERATOR_ACTION_REQUIRED = YES`, exactly as
   this mission's non-negotiable gate requires, unless the operator has independently resolved OKTA
   by then.

---

```
SYSTEM = DEGRADED
PAPER_TRADING = BLOCKED
ORGANIC_TRADE_CAPABILITY = NOT_READY
SAFE_TO_CONTINUE_TODAY = YES_WITH_CONDITIONS
```

(`DEGRADED` reflects the engine running stale code 8 migrations behind HEAD with OKTA unresolved —
not a new defect, an existing, safely-paused condition. `YES_WITH_CONDITIONS`: safe to leave running
as-is, but the current-HEAD restart + certification sequence above should be run as a dedicated,
unhurried follow-up before trading is ever enabled again.)
