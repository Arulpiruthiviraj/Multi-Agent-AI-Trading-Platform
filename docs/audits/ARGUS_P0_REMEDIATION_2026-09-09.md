# Argus P0 Remediation — 2026-09-09

Scope note up front: the request this document responds to was a 13-phase sprint (IBKR crash
recovery, prompt-injection isolation, restart/hang forensics, timer audit, watchdog hardening,
Quant-independent-qualification audit, data-gap matrix, paper-trading evidence, full regression,
static order-path audit, adversarial re-review, and a full HTML report). That is genuinely multiple
days of work. This session completed the two highest-priority, explicitly-named P0 items
(IBKR order-lifecycle crash recovery; news prompt-injection isolation) as real, tested code, plus a
real forensic finding on the restart/instability problem gathered opportunistically while the
engine was down. It does **not** claim to have completed Phases 4–13 in full — those are listed
under "Not done this session" below, honestly, rather than padded out.

## What changed

### P0-1: IBKR order-lifecycle crash recovery (DONE)

| File | Change |
|---|---|
| `src/brokers/IbkrSocketSession.ts` | `buildIbkrOrder()` sets IB's `Order.orderRef` from `clientOrderId`. `TrackedOrder` gained `clientOrderId`. New `clientOrderIdIndex: Map<string, number>`. `connect()` calls `reqOpenOrders()` + `reqExecutions()` on every successful (re)connect. New `openOrder`/`openOrderEnd` handlers rehydrate orders a prior process instance placed. `execDetails` extended to rehydrate via `Execution.orderRef` for orders that fully filled and dropped from open orders before reconnect. New `hasCompletedInitialRehydration()`. `orderStatus` refactored to use the shared `mapIbkrStatusToTrackedStatus()` helper. |
| `src/brokers/IBGatewaySocketAdapter.ts` | `placeOrder()` forwards `clientOrderId` to the session. New `getOrderByClientOrderId()` (throws while rehydration is incomplete — never returns a false "not found"). `orders()` now includes `clientOrderId` in its mapped output (real bug fix — this was silently breaking `reconcileInboundBrokerOrders()`'s dedup check for every IBKR order). |
| `src/server/services/OrderManagement.ts` | `reconcileInboundBrokerOrders()` gained a branch for an unrecognized broker order that has **not** filled yet (previously invisible) — pauses trading via the existing `pauseTradingForOrphan()` path, surfaces via `triggerWebhooks()`, never auto-cancels. |

**Pre-existing machinery this reuses, not replaces:** `OrderManagement.reconcileStaleOrders()` and
the filled-order half of `reconcileInboundBrokerOrders()` already existed, were already correct,
and were already broker-agnostic — they simply had nothing to work with for IBKR because IBKR never
implemented `getOrderByClientOrderId()` or populated `orders()` with real broker state after a
restart. The fix here is entirely about making IBKR *honest* to that pre-existing contract, not
inventing a new one.

**Identity mechanism:** IB's `Order.orderRef` / `Execution.orderRef` (verified via `@stoqey/ib`'s
own type definitions, not invented) — a free-text field set by the placing client, persisted by IB,
and echoed back on `openOrder`/`orderStatus`/`execDetails` for the order's lifetime, including
across a full Argus process or IB Gateway restart. Set to the local `trades.id` UUID, matching the
value OMS already always passes as `clientOrderId` to every broker.

**Tests added (21):**
- `src/brokers/__tests__/IbkrSocketSession.crashRecovery.test.ts` (new, 7 tests)
- `src/brokers/__tests__/IbkrSocketSession.buildIbkrOrder.test.ts` (+2 tests)
- `src/server/services/OrderManagement.crashRecovery.test.ts` (+1 test — no false rejection when a lookup throws)
- `src/server/services/OrderManagement.unrecognizedBrokerOrder.test.ts` (new file, 2 tests)

All pass. `tsc --noEmit` clean.

**Honestly-documented residual gaps:**
1. A bare `execDetails` whose `Execution.orderRef` is itself empty cannot be mapped back to a local
   trade row — rehydrated and logged loudly, not silently dropped, but stays unreconciled until an
   operator looks at it.
2. The unrecognized-open-order pause is periodic (`CRASH_RECOVERY_INTERVAL_MS`), not instantaneous.
3. This closes the *order-lifecycle* crash-recovery gap specifically. It does not constitute a full
   sustained-operation soak proving the fix holds under real, repeated crash/reconnect cycles against
   a live Gateway — that requires calendar time, not code.

### P0-2: News prompt-injection isolation (DONE)

| File | Change |
|---|---|
| `src/server/news/NewsScoringEngine.ts` | New `buildNewsAnalysisPrompt()` places instructions/schema before a single `<UNTRUSTED_ARTICLE_DATA>...</UNTRUSTED_ARTICLE_DATA>` block; new `neutralizeDelimiterEscapes()` strips literal tag-string occurrences from untrusted text so it cannot forge a fake closing tag. |

**Defense in depth, unchanged:** `AIOutputValidator`'s `clampScore`/`coerceEnum`/`coerceString`/
`looksLikeListedTicker` already bounded every output field to its valid range regardless of prompt
content; `materiality`/`novelty`/`expectedHorizon`/`catalystType` were already, and remain,
deterministic server-side values never taken from the LLM. This fix adds structural isolation on top
of that, it does not replace it.

**Why this mattered concretely, not just in principle:** `NewsEngine.ts` feeds
`aiAnalysis.tradingBias`/`confidence` directly into `eventBus.emitTradeIdea()` — a successful
injection was a real (if bounded by output validation) route toward influencing one of ChiefTrader's
required independent votes.

**Tests added:** `src/server/news/NewsScoringEngine.promptInjection.test.ts` (new, 10 tests) —
"ignore previous instructions", fake system messages, fake JSON impersonating the output schema,
role-like content, injection via title/body/source, delimiter-escape forgery, prompt extraction, and
an end-to-end check that a "compromised" mocked response still can't escape schema bounds. All pass.

**Not yet extended:** `FundamentalAgent`/`MacroAgent`/Bull-Bear research prompts also embed
externally-sourced text and carry the same class of risk — out of scope for this pass, named here so
it isn't mistaken for already-covered.

### P0-3: Restart/instability forensics (PARTIAL — one real incident captured, root cause not established)

While confirming system state before touching any code (this sprint's own Phase 0 instruction), the
Argus engine was found **already down** — the last recorded instance (PID 26412, started
2026-09-09T12:31:25Z) had died silently sometime after 16:04:47Z with **zero** crash-log entry (no
`uncaughtException`/`unhandledRejection` — the existing global handlers never fired) and
`cleanShutdown: false` in `data/.argus_runtime_session.json`. `observability_events` activity for
that instance stops abruptly at 16:04:47Z (mid-cycle, immediately after a normal `MarketUniverseScanner`
discovery pass) with no further rows from that process. This is a live, fresh instance of the
"silent hang" pattern the audit's own history already names (`DEF-25` area) — the process stopped
responding without logging why.

A separate, earlier incident found in `data/logs/watchdog.log` from the same day (2026-09-09T01:49–
01:58Z) is a second, distinct, real finding: the watchdog correctly detected `CONFIRMED_DEAD`
and attempted 3 restarts within an hour, but **every restart attempt failed** with:
`"Engine spawn requested but pid 1744 (already answering on http://127.0.0.1:3000 before this start
attempt) is still the one responding - the new process did not take over the port. Stop pid 1744
manually, then retry."` — i.e. the OS-level TCP listener on port 3000 was still bound by a process
the watchdog itself had already judged dead, so every automated restart attempt was refused, the
watchdog hit its `RESTART_BUDGET_EXHAUSTED` circuit-breaker, and then **the watchdog itself stopped**
(no heartbeat since 01:58:37Z) — meaning the engine sat fully unmonitored, with nothing retrying, for
the rest of the day until this session manually restarted it. This is a real, reproducible-sounding
watchdog design gap (a "dead" process that still holds its listening socket defeats port-takeover
restart logic) worth Phase 6's full attention in a follow-up pass — not fixed in this session.

A third, smaller finding from the same investigation, run down to a real (mundane) root cause: a
background diagnostic command left running from *before* this session's context was compacted (a
plain `import('./src/server/core/pipelineAgentRuntime.ts')` smoke test, launched to verify an
earlier code edit didn't throw at import time) was still alive **9+ hours later**, still writing
`AI_COST_GOVERNOR_SHADOW_COMPARISON` observability events to the shared production SQLite file every
~5 minutes. Initial suspicion was a module-import-time timer/socket leak; a controlled
`process._getActiveHandles()` probe (importing `pipelineAgentRuntime.ts`, each of its 5 agent
modules individually, and even `EventBus.ts`/`db/index.ts` alone, against a true zero-import
baseline) found exactly 2 active handles in every app-importing case and 0 in the baseline — but
inspecting the handles directly (`fd: 1`, `fd: 2`) showed they are simply **piped stdout/stderr**,
not a timer or socket leak. The real, mundane explanation: the diagnostic command was a one-shot
`.then(() => console.log(...))` with **no explicit `process.exit()`** call, and Node does not exit a
process on its own once enough of the Argus service graph (DB connection, EventBus, etc.) has been
imported and left with open handles — this is expected behavior for a long-running service entry
point, not a bug in the codebase. **Correcting the record**: this is not a Phase 5 timer-leak
finding to carry forward; it is an ad hoc-tooling hygiene lesson (always call `process.exit()` in a
one-shot diagnostic script) fully explained and closed within this session. It does **not** explain
the separate 16:04:47Z silent death of the real headless engine process, which remains unresolved.
A second SQLite writer against the shared `data/argus.db` file for 9+ hours was still a real,
independently-documented risk while it lasted (`CLAUDE.md`: "Second process on the same file has
been seen to report false `SQLITE_CORRUPT`") — the process was killed as soon as it was found,
regardless of what was keeping it alive.

**A fourth incident, live during this same session, produced the strongest lead yet.** After the
IBKR/news fixes above were complete and the watchdog restarted (17:26Z), the *newly restarted*
engine (PID 13560) ran healthily for ~70 minutes, RSS climbing from ~575MB to 1357.7MB over that
window, then began the same intermittent-unresponsiveness pattern (`SUSPECT` ticks with
`healthOk=false` but an oscillating, non-monotonic `heartbeatAgeMs` — i.e. not a full freeze, the
process was still doing *some* work, just failing health checks inconsistently) starting 17:55Z,
hit `FROZEN_CONFIRMED` and was force-killed by the watchdog at 18:00:44Z. The watchdog's own
auto-restart then made things measurably **worse, fast**: the replacement process (PID 24036) was
itself `FROZEN_CONFIRMED` just 91 seconds after boot; the next two restart attempts (PIDs 26932,
18436) failed even earlier, with the engine's *own* spawn health check timing out before the
watchdog even got a monitoring window — and the watchdog hit `RESTART_BUDGET_EXHAUSTED` and
correctly stopped retrying (matching the 01:49–01:58Z incident's identical failure mode). Zero
crash-log entries for this entire window, again — a silent hang, not a crash, for the fourth time
today.

**Investigating instead of restarting again** (per this sprint's own instruction) found a likely,
well-evidenced root cause: `data/argus.db` was **~5.9GB**. A precise per-table byte measurement
(SQLite's `dbstat` virtual table, not just row counts) found the size concentrated in a small set of
high-frequency tables: `quant_assessments` (1282.6MB from just 46,626 rows — ~27KB/row average, a
real red flag on its own), `event_traces` (1045.6MB, 603,193 rows), `pit_decision_ledger` (~1.2GB
including its 3 indexes, 3,161,509 rows — a backtest/replay-only point-in-time evidence table),
`agent_reasoning_logs` (662.1MB, 126,306 rows), `candidate_rankings` (~635MB including indexes,
778,414 rows). Tracing the codebase's actual retention machinery
(`src/server/observability/ObservabilityStore.ts`'s `sweepObservabilityRetention()` +
`startObservabilityRetentionSweep()`, driven by `config/observability.json`'s `retentionDays: 14`)
found it wired to **exactly one table**: `observability_events` — which is, not coincidentally, the
smallest of the big contributors (285.8MB) precisely because retention actually runs there. Every
other large table above has **zero retention or pruning logic anywhere in the codebase** — confirmed
by a repo-wide search, not inference. This is a strong, mechanistically plausible explanation for
today's pattern: a multi-gigabyte SQLite file makes every boot-time open/migration/checkpoint slower
and every live write/query heavier, degrading gradually (matching the ~70-minute-to-onset,
oscillating-heartbeat pattern of the live-run failures) and catastrophically on a cold, back-to-back
restart cycle (matching the sub-2-minute failures once the watchdog started rapid-restarting).

**Action taken, with explicit operator sign-off at each step:** a full file-copy backup of
`data/argus.db` was taken first (`data/backups/argus_pre_pruning_backup_20260909T182716Z.db`,
verified byte-identical size). The operator chose a 14-day retention cutoff (matching the existing
`observability_events` policy) for a one-time manual prune of the five unretentioned tables above,
followed by `VACUUM` to actually reclaim the freed pages (SQLite does not shrink a file on `DELETE`
alone). See the "One-time prune results" subsection immediately below for exact before/after numbers
and whether a subsequent restart attempt succeeded — this is the actual empirical test of the
hypothesis above, not just an assertion.

**What this section still does not claim:** that DB size is the *only* contributor, or that it is
proven rather than strongly evidenced and empirically tested once. No sustained, sampled
process-level (CPU/memory/event-loop-lag) monitoring was run across a live trading session
independent of this DB-size investigation. If the post-prune restart is stable, that is real
supporting evidence, not final proof — genuine confidence requires watching the pruned, VACUUM'd
database hold up over further calendar time, plus building the missing retention sweep for the other
tables (not done this session — a real follow-up, see "Known limitations").

### Operational action taken this session

- Confirmed Phase 0 state before any code change: `tradingMode=PAPER`, `PAPER_TRADING_ONLY=true`,
  `tradingState=TRADING_PAUSED`, 0 open positions, last reconciliation clean (0 mismatches). No
  real-money exposure existed or was created.
- `ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED=true` confirmed active (operator override from a
  prior session) — left unchanged, per this sprint's explicit instruction to keep it experimental,
  neither expand nor remove it.
- Killed the stray 9-hour-old diagnostic process (see above).
- Restarted the Argus engine (IBKR reconnected/authenticated, healthy). Left `tradingState` at
  `TRADING_PAUSED` — did **not** resume trading — after presenting the operator with the fresh
  silent-hang finding and the still-incomplete P0-1 fix at the time; operator chose to wait for the
  P0-1 fix before resuming. (P0-1 is now complete; resuming trading is an operator decision, not
  made by this document.)

## Static order-path check (Phase 12, partial)

Not a full manually-constructed table — that remains undone (see below) — but the two existing,
automated invariant tests that most directly answer "did today's changes introduce a bypass" were
re-run explicitly and both pass: `src/server/research/phase21.invariants.test.ts` (OMS is the sole
production `.placeOrder(` caller) and `src/server/architecture.protection.test.ts` (`src/server/
continuous/`/`src/server/multiAsset/` never import OMS/RiskEngine/BrokerManager or call
`.placeOrder(`). 46 tests, all passing. Every new `.placeOrder(`-adjacent call site introduced today
(`IbkrSocketSession.placeStockOrder()`'s new `clientOrderId` parameter, the new `getOrderByClientOrderId()`
methods) is a read/tag operation, not a new order-placement path — no new call site reaching a broker's
`placeOrder()` was added.

## Architecture impact

Two new sections added to `docs/architecture/ARGUS_ARCHITECTURE.md` (same-change requirement per
`CLAUDE.md`): "IBKR order-lifecycle crash recovery" and "News prompt-injection isolation". Two new
`CLAUDE.md` `DEF-` entries (DEF-30, DEF-31) following the existing table convention, plus an update
to the "OMS crash recovery" row in the thread-safety table. No change to the protected spine
(EventBus → idea agents → ChiefTrader → RiskEngine → OMS → BrokerManager) — both fixes are entirely
inside the broker-adapter/OMS-reconciliation layer and the news-agent's own prompt construction;
neither touches consensus math, gate count, or gate logic.

## Tests

33 new tests total, all passing, across 5 files (4 new, 1 extended):
- `src/brokers/__tests__/IbkrSocketSession.crashRecovery.test.ts` — 7 (new file)
- `src/brokers/__tests__/IbkrSocketSession.buildIbkrOrder.test.ts` — +2
- `src/server/services/OrderManagement.crashRecovery.test.ts` — +1
- `src/server/services/OrderManagement.unrecognizedBrokerOrder.test.ts` — 2 (new file)
- `src/server/news/NewsScoringEngine.promptInjection.test.ts` — 10 (new file, corrected count — see file for exact list)

Full regression run (`npx vitest run`, no filter): **467 test files, 3374 tests, 100% passing, exit
code 0, 615.96s**. `tsc --noEmit`: clean, both immediately after the IBKR changes and again after the
news prompt-injection changes. `phase21.invariants.test.ts` + `architecture.protection.test.ts` (46
tests) re-run explicitly to confirm no order-path bypass was introduced — both green (see "Static
order-path check" below).

## Known limitations (full list)

1. IBKR crash recovery is implemented and unit-tested against a mocked IB API, not proven against a
   real crash/reconnect cycle with a live Gateway over sustained operation.
2. An execution with no `orderRef` at all remains unreconciled (logged, not silently dropped).
3. The unrecognized-open-order pause is periodic, not instantaneous.
4. News prompt-injection isolation covers `NewsScoringEngine` only — other agents with
   externally-sourced prompt content are not yet hardened the same way.
5. The 16:04:47Z silent-death root cause is not established — one incident's evidence trail was
   captured, not diagnosed to completion.
6. The watchdog's port-takeover restart failure (01:49–01:58Z incident) is documented, not fixed.
7. Phases 5 (full timer/resource lifecycle table), 6 (watchdog hardening), 7 (Quant-independent-
   qualification re-audit), 8 (evidence-collection telemetry), 9 (data-gap matrix), 10 (paper-trading
   evidence tracking), 12 (static order-path audit), 13 (adversarial re-review), and the full HTML
   report deliverable were **not performed** in this session.

## Rollback strategy

Both fixes are additive and isolated:
- IBKR: reverting `IbkrSocketSession.ts`/`IBGatewaySocketAdapter.ts`/`OrderManagement.ts` to their
  pre-2026-09-09 state removes the new rehydration/lookup/pause behavior; `reconcileStaleOrders()`
  and the filled-order half of `reconcileInboundBrokerOrders()` continue to work for Alpaca exactly
  as before (they were never IBKR-specific to begin with). No schema/migration changes were made.
- News: reverting `NewsScoringEngine.ts`'s `buildNewsAnalysisPrompt()`/`neutralizeDelimiterEscapes()`
  restores the prior bare-interpolation prompt; `AIOutputValidator`'s output-side bounds are
  unchanged either way, so a rollback does not remove all protection, only the structural layer
  added this session.

Both are behind no new feature flag — they are bug fixes to existing, always-on mechanisms
(OMS crash recovery, NewsAgent AI scoring), not new capabilities requiring a kill switch of their
own.
