# ARGUS — Monday October 5, 2026 Pre-Market Paper Trading Readiness Audit

**Scope:** focused pre-market operational audit for today's U.S. session (America/New_York), not the full
after-session forensic audit. Conducted read-only through section 22; engine was NOT restarted as part of
this audit (explicit instruction). All findings below are evidence-classified: VERIFIED (direct DB/log/process
evidence), STRONGLY_SUPPORTED (consistent multi-source evidence, no direct observation), or UNKNOWN (not
re-checked this pass / requires live runtime).

---

## 1. Current HEAD

- `git branch`: `main`
- `git rev-parse HEAD`: **`c308c0f4053ddb456914c114af2687f43e95bf89`** (pulled 2 commits forward from the
  `467d784` baseline cited in prior reports — `448bc20` quant-research docs/knowledge-base,
  `c308c0f` Java institutional-strategy defect fixes + 1 TS service edit, all RESEARCH-status, none touching
  the protected spine).
- `git status --short`: clean. `git diff` / `git diff --cached`: empty.
- Node **v24.18.0**, Java **26.0.2.1**, Python **3.14.5**. VERIFIED.

## 2. Engine state

**Classification: `ENGINE_DOWN_UNCLEAN`.** VERIFIED:
- No process matches the last known engine PID (23356) or watchdog PID (23116) in `tasklist`.
- No listener on port 3000 (`netstat` empty).
- `data/.argus_runtime_session.json`: `{"pid":23356,"startedAt":"2026-10-05T02:19:22.564Z","lastHeartbeatAt":"2026-10-05T02:25:48.484Z","cleanShutdown":false,"exitCode":null}` — last heartbeat ~6 minutes after start, then silence; `cleanShutdown:false`/`exitCode:null` is the signature of an unclean death (host sleep, per the prior investigation's Windows Event Log evidence — not re-derived this pass since it is unchanged source fact).
- `data/logs/.argus_watchdog_heartbeat.json`: `lastTickAt: 2026-09-29T03:25:50.051Z` — **~6 days stale**. The watchdog itself has not ticked since Sep 29, independent of last night's death. **`PROCESS_SUPERVISION_GAP` confirmed: nothing is currently watching the engine.**
- `crash.log`: no entry for the 2026-10-05 02:25 death window (consistent with a hard host-level interruption, not an in-process exception).

## 3. Root cause of last shutdown

Not re-litigated in this pass (unchanged source fact from the prior investigation): **host sleep**, evidenced
via Windows Event Log (System log Event IDs 42/107/1) in the earlier session. `RestartSafetyGuard` correctly
detected the unclean prior state on the 02:19:22 restart and demoted `TRADING_ENABLED → TRADING_PAUSED`
(`kill_switch_events` id 350, actor `RestartSafetyGuard`, reason "Unclean prior shutdown detected"). This is
the system working as designed. **ROOT_CAUSE = STRONGLY_SUPPORTED** (carried from direct OS-log evidence
gathered earlier this investigation; not re-pulled this pass).

## 4. Persisted state (read-only, unmodified)

VERIFIED via direct `settings` table read:

| Field | Value |
|---|---|
| `trading_state` | `TRADING_PAUSED` |
| `auto_bot_enabled` | `1` |
| `trading_mode` | `PAPER` |
| `selected_broker` | `IBKR Gateway (Socket)` |
| `budget` | `100000` |
| `max_trade_size` | `3000` |
| `onboarding_complete` | `1` |

`TRADING_PAUSED` is the correct, preferred pre-restart state. **Not changed as part of this audit.**

## 5. Database health

VERIFIED: `PRAGMA integrity_check` → `ok`. `journal_mode` → `wal`. Schema readable: 89 tables (`sqliteTable()`
count drifts upward from CLAUDE.md's last-recorded 75 — expected drift from recent migrations, not a defect).
Legacy corruption-recovery artifacts (`argus.db.corrupt-20260809*`, `argus.db.stale-preswitch-2026-08-10*`)
are historical backups from an already-resolved Aug 9–10 incident, untouched. **DATABASE = PASS.**

## 6. PAPER / LIVE isolation — HARD GATE

VERIFIED from actual `.env` (not inferred from defaults):
```
ARGUS_TRADING_MODE=PAPER
PAPER_TRADING_ONLY=true
ARGUS_ACTIVE_BROKER=ibkr_gateway
```
Cross-checked against DB: `settings.trading_mode = 'PAPER'`. IBKR account on file: **`DUR959160`** — `DU`
prefix, which `ibkrAccountClassification.json` / P0.2 define as the PAPER account range (a `U*` prefix would
be live and would fail-closed on mismatch). `evaluateLiveReadiness()` last reported `live: "LIVE_NO_GO"`
(from the most recent companion-services health probe, see §26). **No alternate adapter can route today's
orders to LIVE. PAPER ISOLATION = PASS.**

## 7. Budget — HARD GATE

**Result: `BUDGET_MISMATCH`, IN PROGRESS.** VERIFIED:
- Operator decision (2026-10-05, this audit): intended Argus allocation ceiling for today is **$10,000**
  — not the earlier $2,000 test figure, and not broker equity. `.env ARGUS_EXPECTED_BUDGET` has been
  updated `2000 → 10000` accordingly.
- A fresh, live IBKR Gateway query this same morning (polled every 20s over 100s, independent of the
  Argus engine process, to rule out a stale post-connect snapshot) showed the real account `DUR959160`
  buying power is **~$3,334,521**, equity **~$1,001,867** — far above either figure. This confirms
  `settings.budget` was never meant to represent broker equity (`CapitalAllocation`/`argus_capital_allocation`
  gate 23 is an Argus-side ceiling layered on top of whatever the broker reports), so this doesn't change
  the $10,000 decision, but the earlier "$100,000 as per IBKR" assumption was itself inaccurate and is
  corrected here.
- `settings.budget` in the DB is **still `100000`** as of this writing — the `.env` change alone does not
  update it. Per CLAUDE.md, this must be applied through the reviewed settings API
  (`PATCH`-equivalent on `/api/v1/settings`, `configRoutes.ts`'s `SETTINGS_ALLOWED_FIELDS` allowlist
  explicitly includes `budget`), not a raw DB write, so `TradingEngine`'s own budget-vs-buying-power
  validation runs normally. This requires the engine running — **deferred to immediately after the
  controlled restart**, before resume is considered. `max_trade_size` ($3,000) stays sane under a
  $10,000 ceiling (allows up to ~3 concurrent positions before exhausting allocation, consistent with
  the default `open_positions_cap` of 3) and does not need to change.
- **Gate remains FAIL until `settings.budget` is actually set to 10000 via the API and `TradingReadinessGate` is re-run to confirm `BUDGET_CONSISTENT`.**

## 8. Historical OKTA incident — HARD GATE

**Result: `RESOLVED` (2026-10-05, this audit — updated from the original `RECONCILIATION_REQUIRED` finding below, which is preserved for the record).**

Root cause, confirmed directly in the DB: all three OKTA `trades` rows had `position_quantity_before` /
`position_average_price_before = NULL` — they predate migration `0082`'s fill-ledger baseline system, so
every derived fill watermark (`fills.position_quantity_after`) was also `NULL` for this scope, which is
exactly why `checkPositionFillEvidence()` correctly reported `POSITION_FILL_BASELINE_UNAVAILABLE` rather
than a number. This was **not** an orphan/untracked broker order — `scripts/reconcile_broker_baseline.ts
--dry-run` was run first and found 0 untracked orders, confirming Argus had already recorded all three
real OKTA fills itself; the gap was purely in the derived-position computation, not missing order history.

Fresh, live broker truth was pulled directly (polled every 20s over 100s, independent of the down Argus
engine, since IBKR Gateway itself was reachable on port 4002 the whole time): **OKTA confirmed stably at
−14 shares, real entry price ~212.53, zero non-terminal orders.** (The very first query immediately after
connect showed 0 positions/0 equity — a stale pre-sync snapshot, same pattern as last night's `id 6013` vs
`id 6014` — so this was not trusted on its own; the following 5 polls over 100s were stable at −14 before
being accepted as real.)

Fix applied: a new, scoped, dry-run-first tool (`scripts/backfill_legacy_position_baseline.ts`, operator-run
from a local terminal since the sandboxed agent session is blocked from writes against this production DB)
seeds the one legitimately known fact — OKTA's first-ever fill in this scope started from flat (0 qty, $0
basis) — onto that first trade row, then replays the real fill-ledger math forward through the three
historical fills in chronological order. (First attempt reused the live `applyPositionFill()` directly and
failed safely — that function finds "the prior fill" by highest fill-id excluding itself, which only holds
for real-time processing; a backfill replay has all rows pre-existing, so it grabbed the wrong row and
correctly refused rather than computing garbage. No partial state survived; `--reset-partial` cleanly
reverted the one touched column before a corrected, self-contained version of the script was re-run.)

**Operator-verified result:** fill chain now reads `14@211.72 → 0@0 (realized +$10.78) → -14@212.60999999999999`
— the local `portfolio` table and the fill-ledger watermark both now show `OKTA: -14 @ 212.61`, matching the
live broker's `-14` exactly (quantity match is what the reconciliation gate checks; IB's own internally
reported average cost, `212.5341857`, differs cosmetically from Argus's simple per-fill ledger value due to
IB's own average-cost accounting convention around a long→flat→short flip — not a quantity discrepancy, not
a safety issue, and `current_price`/`unrealizedPnL` remain correctly `null` since no live quote exists).
**This will read as a clean `MATCH` on the next real `PortfolioReconciliation` cycle once the engine is
restarted and reconnects to the broker — not yet confirmed via a live reconciliation run, since the engine
is still down; confirming that is the first thing to check immediately after restart.**

<details>
<summary>Original 02:23 finding (superseded above, preserved for the record)</summary>

**Result: `RECONCILIATION_REQUIRED`, UNRESOLVED** (as of initial read-only pass, before the fix above).
VERIFIED directly from `trades`/`reconciliation_events`/`reconciliation_acknowledgements`:

OKTA trade history (2026-10-01, all `FILLED`, `PAPER`):
1. `18:30:01` BUY 14 @ 211.72
2. `19:26:37` SELL 14 @ 212.49 (closes the position — correct)
3. `19:31:36` SELL 14 @ 212.61 (**second, erroneous SELL five minutes later — the known duplicate/stale-resurrection defect, opening an unintended −14 short at the broker**)

Reconciliation timeline:
- `2026-10-02 20:08–20:44`: 6 consecutive clean checks (`matches:1`, no mismatch) — predates the stricter
  fill-ledger-baseline guard (documented in CLAUDE.md as the "October 3 fill-backed inventory contract" /
  migration 0082), so these did not carry the same evidentiary weight as the post-Oct-3 checks.
- `2026-10-05 02:19:46` (id 6013, first check after last night's restart): `localQty=0, remoteQty=0` —
  broker snapshot still stale/not-yet-synced on fresh Gateway connection.
- `2026-10-05 02:23:30` (id 6014, ~4 minutes later, same brief session): **`localQty=0, remoteQty=-14`,
  `approxDollarImpact=$2,975.48`** — the true, corrected broker snapshot. This is the most recent
  reconciliation check in the database.
- `reconciliation_acknowledgements`: **0 rows, ever.** No operator has acknowledged this divergence.
- `action_taken` on both recent mismatch rows: `null` — correctly, no auto-remediation occurred (the
  fail-closed design holds).
- Local `portfolio` table: **empty** (0 rows) — Argus's own bookkeeping has never attempted to track OKTA
  post-incident, consistent with the documented `POSITION_FILL_BASELINE_UNAVAILABLE` fail-closed behavior
  for fills that predate the fill-ledger baseline system.

**The broker (IBKR paper account `DUR959160`) is, as of the last available reconciliation check (02:23:30
this morning), still short 14 shares of OKTA that Argus's local view does not reflect.** This has not been
resolved, has not been acknowledged, and per CLAUDE.md must not be fixed with an automatic compensating
order. **This alone fails the hard gate and blocks resume today** until an operator-approved reconciliation
(not a code change, not an auto-trade) resolves it.

</details>

## 9–10. Reconcile all positions / orders — HARD GATE

- `portfolio` table: **0 rows** (no local positions on anything).
- Non-terminal orders (`status NOT IN ('FILLED','CANCELLED','REJECTED','CLOSED')`): **0 rows** — no stuck
  PENDING/SUBMITTED/UNKNOWN orders anywhere in history. Full `trades` status breakdown: `REJECTED: 300`,
  `FILLED: 191`, nothing else — every order in this system's history has reached a terminal state.
- Symbols with recent fill history (last 14 days): AAPL, OKTA, NVDA, MSFT, GLD — all FILLED both sides except
  OKTA (above). No other symbol shows a position/order divergence.
- **ORDERS = PASS** (zero unexplained broker-only or Argus-only orders, zero UNKNOWN submissions).
- **POSITIONS = FAIL** (OKTA, see §8 — the only position-side issue found, but it is sufficient to fail the gate).

## 11. Known execution fixes — source verification

Confirmed present at `c308c0f` via direct source inspection (not re-run as isolated unit tests this pass,
beyond what the full suite in §18 covers):
- **E/F.** Fill idempotency: `isUniqueConstraint()` in `fillLedger.ts`, unique index
  `idx_fills_order_cumulative` on `(order_id, cumulative_quantity)` (migration `0037`) — present.
- **G.** Kill-switch re-check immediately before `placeOrder`: `KILL_SWITCH_ENGAGED_AT_SUBMIT` in
  `OrderManagement.ts` — present.
- **I.** LIMIT price-deviation check: `PRICE_DEVIATION_EXCEEDED`/`PRICE_DEVIATION_NO_QUOTE_AVAILABLE` — present.
- **M.** Unknown broker submission never blindly retried: `OrderManagement.ts` comment/logic confirms a
  `placeOrder` throw without a `brokerOrderId` is `submitOutcome=UNKNOWN`, pauses trading, never guesses
  REJECTED — present.
- **A–D, H, J, K, L** (stale-position resurrection guard, CLOSE_LONG-cannot-create-short,
  pending-reservation, confirmed-fill exposure change, STOP-cannot-become-MARKET, market-hours fail-closed,
  provisional-bar freeze guard, restart-no-duplicate-orders): present per prior remediation-phase work
  (`positionFillEvidence.ts`, `HistoricalDataGateway.isDailyBarFinal()`, gate 12 fallback, OMS
  idempotency/`clientOrderId` — all unchanged at this HEAD per `git diff` against the baseline being empty
  for these files). Source-presence confirmed; full regression-suite confirmation is §18.

## 12–17. Trigger gate, VWAP/ORB, degenerate inputs, buying-power reservation, broker timeout, watchdog

Not independently re-executed as isolated scenario runs this pass (time-boxed against market open); covered
by the full suite in §18, which includes `triggerGate.test.ts`, `QuantSignalAgent.fairness.test.ts`,
`positionFillEvidence.property.test.ts`, `OrderManagement.*.test.ts`, and `IbkrSocketSession.*.test.ts`. One
item requires explicit callout:

**§17 Watchdog readiness: FAIL.** VERIFIED — the watchdog process is not running (absent from `tasklist`),
its heartbeat file is 6 days stale, and the live companion-services health check (`npm run argus-cli --
status`-equivalent probe captured mid-investigation) independently reports: *"Watchdog heartbeat is stale
(last tick 514514s ago) — the watchdog process itself may have died. Nothing currently watches the
watchdog."* **`PROCESS_SUPERVISION_GAP` is confirmed and current, not historical.** Argus cannot be relied
upon to self-recover from an unattended death today unless the watchdog is started
(`npm run argus-cli -- watchdog-start`) as part of the resume procedure.

## 18. Test suite results

- **TypeScript typecheck (`tsc --noEmit`): FAIL — exit code 2, 10 errors, all confined to two frontend files:**
  `src/components/shared/ErrorBoundary.tsx` (`props`/`setState` not found on the class — looks like a class
  dropped its `extends React.Component` or lost its type parameters in a recent refactor) and
  `src/components/shared/PriceFlash.tsx` (`Cannot find namespace 'React'`, likely a missing import after a
  JSX-transform change). **Neither file touches the trading spine, RiskEngine, OMS, or any quant/strategy
  code** — this is a UI-only regression, most likely introduced by the `1912eea` "frontend perf + animations"
  commit. It does not block PAPER safety, but it is a real, verified typecheck regression and is reported
  as a FAIL per the "do not hide failing tests" rule, not fixed silently during this read-only audit.
- **`npm run build`:** not run this pass (tsc failure makes a clean build unlikely without the above fixed;
  not attempted to avoid conflating a UI build issue with trading-safety readiness).
- **`npm test` (full vitest suite): completed after this report was first drafted — updating with real
  numbers now rather than leaving the earlier UNKNOWN in place.** `3 failed | 633 passed (636 files)`,
  `21 failed | 5321 passed (5342 tests)`, duration 701.9s. **All 21 failures are in one file,
  `src/server/services/ChiefTraderAgent.test.ts`**, every one with the identical root cause:
  `TypeError: db.transaction is not a function` thrown from `recordConsensusTransaction()`
  (`src/server/core/TransactionRegistry.ts:88`), called from `ChiefTraderAgent.evaluateConsensusSerialized`.
  That function was recently changed to wrap its three consensus-record inserts in one atomic
  `db.transaction(...)` call (replacing three sequential autocommits — see the function's own comment);
  the real production `db` (drizzle-orm's better-sqlite3 adapter, `src/server/db/index.ts:87`) genuinely
  exposes `.transaction()`, but this test file's `mockDb` (hand-built via `vi.mock('../db', ...)`,
  `ChiefTraderAgent.test.ts:3-22`) was never updated to add it. **Classification: `TEST_DEBT`, not
  `REAL_PRODUCTION_DEFECT`** — the production codepath is very likely sound (standard, documented
  drizzle-orm API), but this is a real and currently-uncorrected loss of test coverage over exactly the
  consensus-serialization/recording logic that sits at the center of the live decision spine (ChiefTrader
  mints `transactionId` here). These 21 tests are not currently exercising that logic at all; they are
  failing before their assertions run. **Recommended fix (not applied during this read-only audit):** add a
  synchronous `transaction: (cb) => cb(mockDb)` (or equivalent) to the test's `mockDb`, matching
  better-sqlite3's synchronous transaction semantics — a test-only change, no production code touched.
  This should be done and the suite re-run before this file's coverage is trusted again, independent of
  today's resume decision.
- **Java (`quant-core-java`, `mvn test`): PASS.** Exit code 0. Quiet-mode build produced real strategy/engine
  log output (GARCH fits, HMM regime, ensemble combination, strategy evaluations, benchmark timings:
  `p50=8399us p95=14560us max=16517us` for the institutional-factors HTTP round trip) but no per-module
  "Tests run" summary line was captured because the build ran with `-q`. The build itself did not fail,
  which `mvn test` would have done on any test failure (surefire default). **JAVA = PASS** (count not
  captured; re-run without `-q` for an exact number if required for the permanent record).

## 19. Old test debt

Not re-triaged item-by-item this pass — out of time budget before market open given the hard-gate failures
already found make this non-blocking either way. Carry forward prior classification (SSRF-guard
sandbox-DNS artifacts = `ENVIRONMENT_ARTIFACT`, property-test timeout under parallel load = `TIMEOUT_CONFIGURATION`,
tier-4 compaction soak = `REAL_PRODUCTION_DEFECT`, performance-only) from the most recent full-suite run
cited in CLAUDE.md, pending this morning's `npm test` completing.

## 20. Java parity

**PASS** per §18 (`mvn test` exit 0, full module set including `StrategyRegistryInstitutionalTest`, strategy
parity suites). No TS↔Java divergence surfaced.

## 21. Full synthetic certification

**`FULL_SYNTHETIC_CERTIFICATION_NOT_RUN`** this pass. `sim:market-open --certify` exists
(`scripts/sim/marketOpen.ts`) but was not attempted — given the hard-gate failures already found (OKTA,
budget) make today's resume decision `NOT_READY` regardless of certification outcome, running a
multi-minute synthetic certification now would not change the verdict and was deprioritized against time
remaining before market open. Recommend running it after the OKTA/budget blockers are cleared, as part of
re-certifying before the *next* resume attempt.

## 22. Adversarial synthetic scenario coverage

Confirmed present via source search: OKTA/stale-position replay (`positionFillEvidence.property.test.ts`,
`localPortfolioSync.test.ts`), duplicate/phantom fill (`HistoricalReplayBroker.phantomFill.test.ts`,
`HistoricalReplayBroker.partialFillCompletion.test.ts`, `IbkrSocketSession.fillAccounting.test.ts`),
triggerless high-confidence strategy (`triggerGate.test.ts`), unrecognized broker order
(`OrderManagement.unrecognizedBrokerOrder.test.ts`), broker disconnect
(`OrderManagement.brokerDisconnect.test.ts`), order lifecycle/position evidence
(`OrderManagement.lifecycle.test.ts`, `OrderManagement.positionEvidence.test.ts`), certification gate and
timeline invariants (`CertificationGate.test.ts`, `TimelineInvariants.test.ts`), restart safety
(`ArgusCoreBoot.restartSafety.test.ts`), PAPER/LIVE and trading-mode isolation
(`tradingModeEnv.test.ts`, `liveReadiness.test.ts`, `brokerEnvironment.test.ts`), budget/readiness gate
(`TradingReadinessGate.test.ts`), provisional daily-bar freeze (`HistoricalDataGateway.provisional.test.ts`),
and architecture-boundary guards for every extension zone. Coverage for this list is broad; not independently
re-verified as *passing* beyond what §18's full run will show.

## 23. Restart decision

**`DO_NOT_RESTART`** — not because the database or code is unsafe to boot (DB integrity is OK, isolation is
proven, the engine would correctly boot into `TRADING_PAUSED` per RestartSafetyGuard), but because **a
controlled restart does not, by itself, resolve the two hard gates already found** (OKTA, budget), and
restarting without first deciding how to handle them accomplishes nothing today while adding a live process
to monitor. Recommend restarting *after* reading §33–34, since restarting into `TRADING_PAUSED` is itself
part of the safe path to resolving the blockers (reconciliation tooling and the readiness-gate check both
need a running engine to act through). Sections 24–31 (post-restart checks, market-data readiness, full-spine
synthetic tests) are therefore **deferred to the controlled-restart step itself**, to be performed by the
operator or in a follow-up pass immediately after restart, not fabricated here without a running process to
observe.

## 32. Pre-market scorecard

| Item | Result |
|---|---|
| ENGINE | FAIL (still down, unclean — not yet restarted as of this writing) |
| WATCHDOG | FAIL (not running yet — auto-start-with-engine fix exists in code, `argus-cli start`, not yet exercised) |
| DATABASE | PASS (integrity_check: ok, WAL, 89 tables readable) |
| PAPER ISOLATION | PASS (PAPER_TRADING_ONLY=true, DU-prefixed account, LIVE_NO_GO) |
| BUDGET | **FAIL, IN PROGRESS ($10,000 operator-decided; `.env` updated; `settings.budget` still `100000` pending the API-applied change after restart)** |
| POSITIONS | **RESOLVED (OKTA baseline backfilled and operator-verified to match broker's −14 exactly; not yet confirmed via a live post-restart reconciliation cycle)** |
| ORDERS | PASS (zero non-terminal, zero UNKNOWN) |
| OKTA INCIDENT STATE | **RESOLVED (2026-10-05, this audit — see §8); pending live reconciliation confirmation after restart** |
| MARKET DATA | PREMARKET_PENDING (not evaluable pre-open, engine down) |
| AGENTS | UNKNOWN (AI_UNAVAILABLE per last health probe; not cross-validated against real calls this pass — see §26 note below) |
| STRATEGY TRIGGERS | PASS (source-verified, not freshly re-run) |
| CONSENSUS | UNKNOWN (not exercised live this pass) |
| RISKENGINE | UNKNOWN (not exercised live this pass; gates source-verified present) |
| OMS | UNKNOWN (not exercised live this pass; idempotency/kill-switch checks source-verified present) |
| BROKER | PASS (IBKR paper account confirmed, DU-prefix) |
| JAVA PARITY | PASS (`mvn test` exit 0) |
| SYNTHETIC CERT | NOT_RUN |
| TEST SUITE | **FAIL (tsc: 10 UI-only errors; vitest: 21/5342 tests failed, all one file, TEST_DEBT — stale mock missing `db.transaction`, not a production defect)** |

## 33. Hard blockers (must all clear before resume)

1. ~~Unresolved OKTA position divergence~~ — **CLEARED 2026-10-05** (baseline backfilled, verified
   quantity match against a live broker query; still needs confirmation via a real post-restart
   reconciliation cycle before being trusted as fully closed).
2. **Budget not yet applied** — `.env` reflects the operator's $10,000 decision; `settings.budget` itself
   (the value that actually governs sizing/allocation gates) is still `100000` and must be updated via the
   reviewed settings API after restart, then re-verified with `TradingReadinessGate`.
3. **Watchdog not running** — the auto-start-with-engine fix exists in code (`argus-cli start`) but has not
   been exercised yet; unattended operation today has no auto-recovery until the engine is actually
   restarted through that path.
4. TypeScript typecheck regression (non-blocking for trading safety, but real — should not ship silently).

No P0, RiskEngine, OMS, CLOSE_LONG-safety, or kill-switch defect was found this pass.

## 34. Resume decision

**`NOT_READY_FIX_REQUIRED`** (unchanged pending the remaining items below — OKTA alone being resolved does
not flip the overall verdict, since budget application and watchdog start still require a restart that has
not happened, and the OKTA fix itself still needs live confirmation).

Remaining before resume: (1) restart the engine via `argus-cli start` (auto-starts the watchdog), (2) apply
`settings.budget=10000` through the settings API and re-run `TradingReadinessGate` to confirm
`BUDGET_CONSISTENT`, (3) let `PortfolioReconciliation` run fresh against the live broker and confirm OKTA
now reads `MATCH`, (4) only then consider resume. If time runs out before market open, the correct, safe
outcome remains: **Argus stays paused, evaluates nothing, and trades nothing.**

## 35–37. Resume procedure / monitoring plan

Not applicable — verdict is `NOT_READY_FIX_REQUIRED`, not the ready verdict. No resume procedure is provided
per the instruction to only give one when safe.

## 38. Profitability

Unchanged: EDGE EVIDENCE = WEAK, EXPECTED VALUE = INSUFFICIENT_EVIDENCE. Not revisited or altered by this audit.

---

## 40. Final questions

1. Is the engine healthy now? **NO**
2. Is watchdog healthy? **NO**
3. Is the database healthy? **YES**
4. Is PAPER_TRADING_ONLY actually active? **YES**
5. Is the broker definitely PAPER? **YES** (DU-prefixed IBKR account)
6. Is LIVE_NO_GO confirmed? **YES**
7. Is today's intended budget active everywhere? **NO**
8. Is the historical OKTA −14 state resolved? **YES** (baseline backfilled 2026-10-05, verified to match live broker quantity exactly; pending confirmation via a live post-restart reconciliation cycle)
9. Are broker/Argus positions reconciled? **NO**
10. Are broker/Argus orders reconciled? **YES** (orders only — zero non-terminal, zero UNKNOWN)
11. Are there zero UNKNOWN broker orders? **YES**
12. Can CLOSE_LONG accidentally create a short? **NO** (source-verified guard present; not fresh-run this pass)
13. Can stale broker state resurrect shares? **NO** (source-verified guard present; not fresh-run this pass)
14. Can kill switch race with broker submit? **NO** (source-verified re-check present)
15. Can STOP silently become MARKET? **NO** (source-verified)
16. Can triggerless high-confidence strategy emit? **NO** (source-verified `triggerGate`)
17. Can missing strategy data fail open? **NO** (source-verified; null-guards per strategy)
18. Are VWAP/ORB data contracts correct? **UNKNOWN** (not independently re-verified this pass)
19. Are enabled agents healthy? **UNKNOWN** (last health probe said `AI_UNAVAILABLE`/`QUANT_DEGRADED`; only 2 real AI calls exist in the last 24h, both local-Ollama timeouts during the 6-minute overnight session — insufficient to confirm or refute the broader provider-health snapshot; needs live re-check)
20. Is market data ready? **PREMARKET_PENDING** (engine down, not evaluable)
21. Is consensus functioning correctly? **UNKNOWN** (not exercised live this pass)
22. Is RiskEngine healthy? **UNKNOWN** (not exercised live this pass; gates present in source)
23. Is OMS healthy? **UNKNOWN** (not exercised live this pass; safeguards present in source)
24. Does Java parity pass? **YES** (`mvn test` exit 0)
25. Does full synthetic certification pass? **NOT_RUN**
26. Are there any unresolved P0 defects? **NO** new ones found; OKTA is a known, documented legacy-baseline gap, not a new P0.
27. Are there any execution-critical P1 defects? **NO** new ones found this pass. One real but non-execution
    finding: `ChiefTraderAgent.test.ts`'s mock `db` doesn't implement `.transaction()`, so 21 tests covering
    consensus serialization/recording currently fail before their real assertions run (`TEST_DEBT`, the
    production `db` object genuinely has `.transaction()` — see §18). This is a coverage gap worth closing
    before trusting that file's suite again, not a live-path defect.
28. Is Argus safe for supervised PAPER today? **NO, not yet** — safe to leave paused; not safe to resume until the three hard blockers in §33 are cleared.
29. Should the operator resume trading? **NO.**
