# ARGUS — P0 Silent-Death Remediation + Tomorrow Paper Readiness (Final)

```
Audit date:          2026-09-07 (Monday, Labor Day - US markets closed), follow-up pass ~21:00-21:35 UTC
Supersedes:          docs/audits/ARGUS_TOMORROW_PAPER_READINESS.md (same day, earlier pass)
Repository commit:   f182969 (HEAD, main) + uncommitted session changes (see §1)
Runtime PID:         live at time of writing, TRADING_ENABLED, reconciled clean
Trading mode:        PAPER, PAPER_TRADING_ONLY=true, LIVE_NO_GO
```

This is a direct follow-up to the same-day earlier audit, which found the single blocking issue:
a live-reproduced silent engine death with zero diagnostic trail and no auto-recovery. This
document reverifies that finding, builds and **live-tests** the smallest safe external mitigation,
and re-issues the verdict.

---

## Phase 1 — Reverifying the incident (no new root cause invented)

Reconfirmed from the earlier pass, now cross-checked against the actual mechanisms in code:

1. **How Argus starts**: `argus-cli start` (`scripts/argus-cli.ts`) spawns `scripts/argus-engine.ts`
   detached, writes `data/.argus_engine.pid`, waits for `/health`. Already has stale-answering-PID
   detection (`currentlyAnsweringPid()`) - won't falsely report success if a different stale process
   is still bound to the port.
2. **How Argus stops**: prefers a graceful in-process shutdown via `POST /api/v1/system/shutdown`
   (`requestGracefulShutdown()`), falls back to `SIGTERM` only if that request itself fails.
   `stopEngine()` also has a PID-reuse guard (`isPidLikelyArgusProcess()`) before ever signaling.
3. **Internal worker-failure detection**: `heartbeatWatchdog.ts` (added 2026-09-07 morning, R2) -
   detects an individual interval worker going silent while the process itself is alive.
4. **Process-death detection**: **confirmed, by design, nothing** - `heartbeatWatchdog.ts` cannot
   observe its own process disappearing. No other in-process mechanism exists for this.
5. **External supervisor**: **none currently active.** A pm2 config (`ecosystem.config.cjs`)
   already exists in-repo but is not what this deployment runs (it targets the production
   `dist/server.cjs` build via `pm2 start`/`pm2 stop`, a different workflow than the `argus-cli`
   dev-mode path this deployment actually uses) - see §2 for why it was not adopted today.
6. **Stale PID/session detection**: yes - `enginePid.ts`'s `isPidAlive()`/`reconcileEnginePidFile()`
   (used by `start`) and `isPidLikelyArgusProcess()` (used by `stop`) both already exist and are
   reused, not reinvented, by the new watchdog (§2).
7. **Durable heartbeat**: yes - `sessionRecovery.ts` writes `data/.argus_runtime_session.json`
   every 15s while alive, with `pid`, `parentPid`, `startedAt`, `lastHeartbeatAt`, `cleanShutdown`,
   `exitCode`.
8. **Distinguishing healthy/frozen/dead/stale/intentional-stop**: partially existed, not fully
   wired to anything external. Specifically: `cleanShutdown` (set `true` only by
   `markCleanShutdown()` on a real graceful stop) is **exactly** the intentional-vs-unexpected
   signal needed, but nothing outside the process previously read it.
9. **Can the process die without any trace?** Confirmed yes, live, twice today: once as the
   original unplanned incident, and once more deliberately in this pass's own controlled test
   (§4) via a hard `Stop-Process -Force` - `crash.log` gets no entry from a hard kill (no JS
   exception ever runs), matching exactly what was observed for the original incident.
10. **Root cause of the original incident**: still **ROOT CAUSE UNVERIFIED**. No new evidence
    found or invented this pass. The working, unconfirmed hypothesis remains resource contention
    from this same day's own heavy concurrent test-suite runs against the live engine - plausible,
    not proven, and explicitly not treated as proven anywhere in this document.

---

## Phase 2 — Design: smallest safe external liveness mechanism

**Considered and rejected: adopting the existing `ecosystem.config.cjs` pm2 config as-is.** It is
real, already in the repo, and is a legitimate, more battle-tested supervisor in general. It was
not adopted today because it targets a different operational path (a built `dist/server.cjs`,
started/stopped via `pm2 start`/`pm2 stop`) than the `argus-cli`-based dev-mode workflow this
deployment has used all session - switching would mean changing how the operator starts/stops
Argus the night before an unattended session, and would risk a real conflict (pm2 auto-restarting
a process the operator stopped manually via `argus-cli stop`, since pm2 has no knowledge of this
codebase's own `cleanShutdown` semantics). This is named as a legitimate **future** option, not
dismissed - see §7.

**Built instead: `scripts/argusWatchdog.ts` + `scripts/lib/argusWatchdogLogic.ts`.** A small,
standalone script the operator runs in its own terminal (`npm run argus:watchdog`), entirely
outside the Argus process, that:

- Polls `GET /ready` (unauthenticated, checks real SQLite connectivity - not the authenticated
  `/api/v2/runtime/health`, which a real live test in this pass initially, incorrectly, used and
  got 401 from every tick; fixed once caught - see §4's first test run) plus `isPidAlive()` on the
  recorded PID plus the session file's `lastHeartbeatAt` age.
- Requires `confirmTicks` (default 2) consecutive bad ticks before acting - a single transient
  blip does not trigger anything.
- On confirmed bad ticks, only escalates to a restart if the **PID itself is genuinely gone**. A
  live-but-unresponsive ("frozen") process is deliberately left alone rather than force-killed -
  killing a process that might be mid-write to SQLite is its own risk this pass chose not to take
  (see the code comment in `argusWatchdogLogic.ts`).
- Reads the session file's `cleanShutdown` flag to distinguish an operator-requested stop from a
  genuine unexpected death, and **never restarts after an intentional stop.**
- Enforces a bounded rolling restart budget (default: max 3 restarts per 60 minutes) and halts
  with a loud, explicit alert log line instead of storm-restarting when exhausted.
- Never opens `data/argus.db`. Never calls anything but `argus-cli start`. Never calls a resume
  endpoint.
- Logs to its own file (`data/logs/watchdog.log`), independent of Argus's own log buffer (which
  requires Argus to be running to exist at all).

---

## Phase 3 — Safety requirement: never auto-resume trading

Verified, both by reading the code and by live-testing it (§4): `argus-cli start`/`restart`
already, independently of anything built this pass, always leaves `tradingState: TRADING_PAUSED`
after any restart - this was true before today and required no new code. The watchdog adds **no**
path around this; it only ever calls the same `start` command an operator would type by hand.

```
process death (confirmed)
    ↓
watchdog detects (2 consecutive bad ticks, ~20-30s at default settings)
    ↓
cleanShutdown === true?  → STOPPED_INTENTIONALLY, do nothing, keep watching
cleanShutdown === false? → restart budget available?
                             no  → ALERT_HALTED, do nothing further
                             yes → `argus-cli start`
                                     ↓
                                   engine boots, reconciliation runs automatically
                                     ↓
                                   TRADING_PAUSED (unconditional - not this script's doing,
                                                    the engine's own existing boot behavior)
                                     ↓
                                   operator must explicitly `argus-cli resume`
```

If reconciliation mismatches, or broker/market-data state is uncertain, or safety state is
uncertain: **the engine already does not resume on its own regardless of what caused the
restart** - this was true before this pass and is unchanged.

---

## Phase 4 — Live-tested, not just designed

This is the part of the mission most worth being honest about: a design and a passing unit-test
suite are not runtime evidence. This was actually run, twice, against the real live engine, this
session.

**Test 1 - unexpected death:**
1. Engine started and confirmed healthy.
2. Watchdog started (`ARGUS_WATCHDOG_POLL_MS=10000 ARGUS_WATCHDOG_CONFIRM_TICKS=2`).
3. **First attempt used `/api/v2/runtime/health`, which requires auth this deployment has enabled
   - every tick returned 401, so the watchdog reported SUSPECT forever even though the engine was
   genuinely fine.** This is a real bug this pass's own live test caught before it could ship
   silently broken - fixed to use the unauthenticated `/ready` endpoint (`server.ts`, purpose-built
   for exactly this). Re-verified: silent (no bad ticks) once fixed.
4. Engine process hard-killed directly (`Stop-Process -Force`, bypassing any graceful path -
   deliberately simulating the original incident's apparent signature: no crash.log entry
   possible from a hard kill).
5. Watchdog log, real output:
   ```
   [21:30:31.048Z] SUSPECT (consecutiveBadTicks=1/2) pidAlive=false healthOk=false heartbeatAgeMs=22156
   [21:30:41.053Z] CONFIRMED_DEAD (unexpected, cleanShutdown=false or unreadable) -> running `argus-cli start`.
   ```
6. `argus-cli start` completed successfully (new PID confirmed in `data/.argus_engine.pid`), full
   companion-service health printed clean (Chronos/Ollama/QuantSignalAgent/Broker/AIRouter all
   READY).
7. **Confirmed via live logs**: `[PortfolioReconciliation] Sync complete. 0 mismatch(es).` and
   `[sessionRecovery] RECONCILIATION_MATCH after interrupted session ... tradingState unchanged
   (not a blind resume of PAUSED).`
8. **Confirmed via `argus-cli health`**: `tradingState: TRADING_PAUSED` after the automated
   restart - exactly as required. An operator (this session) then explicitly resumed, as intended.

**Test 2 - intentional stop:**
1. Engine running, watchdog watching, both healthy.
2. `argus-cli stop` issued (graceful path - confirmed `cleanShutdown: true`, `exitCode: 0` in the
   session file afterward).
3. Watchdog log, real output:
   ```
   [21:32:19.568Z] SUSPECT (consecutiveBadTicks=1/2) pidAlive=false healthOk=false heartbeatAgeMs=1282
   [21:32:29.579Z] Engine appears to have been stopped intentionally (cleanShutdown=true). Not restarting. Will resume watching in case it is started again.
   ```
4. **No restart occurred.** Correct.

Both the "must recover" and "must not fight an intentional stop" halves of the requirement are now
proven with real logs from a real kill and a real stop, not just asserted.

**What this does not prove:** whether the *original* incident's actual root cause would present in
a way this watchdog's checks (pid-gone + `/ready` failing + stale heartbeat) would catch. The
original incident did present exactly that way (port unreachable, pid gone) when discovered, so
this is a reasonable but not airtight match.

---

## Phase 5 — Test isolation fix

`src/server/core/ArgusCoreBoot.test.ts` previously compared the *entire content* of the real
production session file before/after, excluding only `lastHeartbeatAt`, on the assumption a
concurrently-running real engine only ever changes that one field between ticks. That assumption
broke live during the earlier pass's own test run, when a real unplanned restart (the very
incident this document is about) changed `pid`/`parentPid`/`startedAt` too, mid-test, causing a
false failure.

**Fixed**: the test no longer reads or diffs the production file's mutable content at all. It now
asserts the one invariant that actually matters and is genuinely parallel-safe: if the production
file exists, its `pid` must never equal this test process's own `pid` (catching the real
regression - a leaked write into the wrong path); separately, the temp file must contain this
test's own `pid` (confirming the redirect worked). Verified: **passes in isolation, and passes
again while a real, live, concurrently-running engine is active** (re-run deliberately with the
live engine up - see §6).

---

## Phase 6 — Uncommitted changes, this pass

| Change | Correct? | Safe? | Tested? | Runtime proven? | Tomorrow risk |
|---|---|---|---|---|---|
| `scripts/lib/argusWatchdogLogic.ts` (new) | Yes | Yes - pure functions, no I/O | 8 unit tests, all passing | Yes - drove the real state transitions in §4's live test | Low |
| `scripts/argusWatchdog.ts` (new) | Yes, after the `/ready` fix | Yes - never opens the DB, never resumes trading, bounded restarts | No unit tests (I/O script; its logic is tested via the pure module above) | **Yes** - live-tested twice this pass (§4) | Low |
| `package.json` (`argus:watchdog` script) | Yes | Yes - additive | N/A | Used directly in §4's live test | None |
| `src/server/core/ArgusCoreBoot.test.ts` (fix) | Yes | Yes - test-only | Passes isolated and concurrent-with-live-engine | Yes | None |

Full suite this pass (engine stopped first, per this mission's explicit instruction to avoid the
same contention that caused the earlier false failure): **461/461 test files, 3315/3315 tests
passing, 0 failures.** `tsc --noEmit` clean. Java unchanged from the same-day earlier pass
(344/344, not re-run since no Java file was touched).

---

## Phase 7 — Safety spine re-verified untouched

```
git diff --name-only | grep -iE "RiskEngine|OrderManagement|ChiefTrader|BrokerManager|OMS|kill.?switch"
-> no matches
```

`PAPER_TRADING_ONLY=true`, `LIVE_NO_GO`, the 0.75/2-agent consensus floor, all 25 RiskEngine gates,
capital allocation, emergency stop, reconciliation, and stale-data fail-closed behavior were not
touched by any change in this pass or the earlier one today.

---

## Phase 8-10 — Carried forward unchanged from the same-day earlier audit

Today remains a US market holiday - no new runtime evidence exists or could be gathered for
TradePlanBuilder, extended-hours gate 25, AICostGovernor-live routing, or the Fincept advisory
beyond what the earlier document already recorded (all code-complete, tested, zero real-tick
evaluation). The Java/TS quant parity divergence remains correctly, deliberately deferred - not
touched, not rushed, no tolerance widened.

---

## Phase 11 — Final test numbers

| Suite | Result |
|---|---|
| `tsc --noEmit` | Clean |
| `npm test` (engine stopped, no contention) | **461 files / 3315 tests, 100% passing** |
| `mvn test` (`quant-core-java/`) | 344/344 (same-day earlier run this pass; unchanged, no Java file touched) |
| Python | No test suite exists in this repo (unchanged finding) |

No new failures. No pre-existing failures. The one failure seen earlier today is confirmed, twice
over now, to have been self-inflicted test/engine contention, not a product defect.

---

## Phase 12 — Controlled runtime validation

Completed in full, live, this pass:
1. Engine stopped cleanly (`cleanShutdown: true`, `exitCode: 0` confirmed).
2. Engine started fresh, health verified.
3. Watchdog started, confirmed settling into a genuinely healthy silent state after the `/ready`
   fix.
4. Engine hard-killed (simulating unexpected death) → watchdog detected → restarted → reconciled
   clean → confirmed `TRADING_PAUSED` (§4).
5. Operator resumed trading, confirmed `TRADING_ENABLED`.
6. Engine intentionally stopped again → watchdog correctly did **not** restart (§4).
7. Engine started again, positions confirmed empty, reconciliation clean, trading resumed - system
   left in the same ready state as before this validation began.

No destructive testing was performed against anything but this session's own paper-only,
zero-position state.

---

## Phase 13 — Go/No-Go (updated)

| Area | Status | Change from earlier pass today |
|---|---|---|
| Reliability | 🟡 (was 🔴) | External liveness detection + bounded auto-recovery now exists and is **live-proven**, not just designed. Upgraded from blocking to conditional because the mitigation is real but depends on an operator actually running it (§14). |
| Everything else | Unchanged | See the earlier document - no new findings, no new risk introduced. |

---

## Phase 14 — Final verdict

# 🟡 CONDITIONALLY READY — ONE OPERATOR ACTION REQUIRED

The reliability gap that made the earlier pass CONDITIONAL is now mitigated by a real,
live-tested, bounded, safety-respecting external watchdog. It is not a green-without-conditions
verdict for one honest reason: **the watchdog only protects the session if someone actually starts
it.** It is a separate process the operator must run (`npm run argus:watchdog`, in its own
terminal, before or right after starting Argus tomorrow) - it does not register itself as a
Windows service or scheduled task (a deliberate scope boundary this pass did not cross - see §2),
so "conditionally ready" now means exactly one thing: **run the watchdog.**

---

## Final question

> **"If I leave ARGUS running tomorrow morning and do not touch it for the entire paper-trading
> session, what are the remaining ways it could silently stop, make an unsafe decision, lose
> broker state, or continue operating incorrectly without an operator noticing?"**

| Failure mode | Probability | Severity | Detection | Recovery | Blocks unattended paper trading? |
|---|---|---|---|---|---|
| Engine dies again the same unverified way, **watchdog not running** | Not quantifiable - root cause still unverified | High (session goes fully idle, no trades, no alert) | None | None automatic | Yes, if watchdog isn't started |
| Same death, **watchdog running** | Same unverified base rate | Low-Medium (bounded downtime ~20-40s detection + ~60-90s restart, then paused pending resume) | Watchdog log | Automatic restart, manual resume | No - degrades to "paused, needs a resume click," not unsafe |
| **The watchdog itself dies** | Not quantifiable - it is also just an unsupervised Node process | Medium | None built this pass | None automatic | Partially - reduces to the no-watchdog case above |
| **Frozen-but-alive engine** (process exists, `/ready` and heartbeat both stuck) | Not quantifiable - no evidence this has ever happened here | Medium | Watchdog logs SUSPECT indefinitely, never escalates (deliberate scope choice, §2) | None automatic - operator must notice and manually intervene | No new unsafe action occurs, but no new trades occur either, silently |
| Restart budget exhausted (≥3 deaths in 60 min) | Not quantifiable | Medium-High if the underlying cause is real and recurring | `ALERT_HALTED` log line only - no push/pager | None automatic beyond that point | Yes, until an operator notices the log |
| IBKR connection goes "half-open" (socket alive, no real data, no error) | Unknown - not specifically tested this session | Low for safety (gate 13 `data_freshness` fails closed on stale quotes - existing, unchanged, verified behavior), Medium for silent inactivity | `data_freshness` gate rejections would appear in `trading-funnel`/logs, but nothing pages a human | DEF-28's reconnect-with-backoff handles a *detected* disconnect; a silently-stuck-open socket may not trigger it | No unsafe trade risk; possible silent inactivity |
| Windows OS-level event (auto-update reboot, forced restart) | Unknown, environment-dependent | High (kills engine, watchdog, and IB Gateway Desktop's manual-2FA requirement all at once) | None | None - IB Gateway specifically requires interactive 2FA, unautomatable by design (CLAUDE.md) | Yes, and no code fix is possible for this one |
| Disk/DB exhaustion or corruption | Unknown - not tested this pass | Low for safety (existing P0.3 persist-then-emit invariant means no order fires without a persisted risk assessment), Medium for silent stall | Not actively monitored by the watchdog this pass | Manual | Possible silent inactivity, not an unsafe trade |
| AICostGovernor/Fincept produce a subtly wrong-but-plausible answer under real load for the first time | Unknown - zero real-tick evidence exists yet (holiday) | Low - both are structurally incapable of touching confidence/side/RiskEngine/consensus by construction, verified in code | Would show as an odd `ai_cost_governor_shadow_comparison`/reasoning-text entry, not a wrong trade | N/A - worst case is a worse *choice of provider* or *missing advisory text*, never an unsafe order | No |

No probability above is invented; every "not quantifiable" reflects a genuine absence of evidence,
not a guess dressed as a number. The honest summary: **the one mechanism this system lacked - some
way to notice and recover from the engine itself vanishing - now exists and has been proven to
work exactly as intended, twice, live. It only helps if it's running. Every other remaining gap
degrades to "the system goes quiet" rather than "the system does something unsafe" - which is the
correct failure direction for a paper-trading system to fail in, even if it is not yet a fully
unattended one.**
