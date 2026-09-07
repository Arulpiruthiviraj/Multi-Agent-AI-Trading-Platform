# ARGUS — Tomorrow Paper-Trading Final Readiness Audit

```
Audit date:          2026-09-07 (Monday, Labor Day — US markets closed), ~14:40-21:00 UTC
Repository commit:   f182969 (HEAD, main) + uncommitted session changes (see §1)
Runtime PID:         26692 (started 2026-09-07T20:45:26Z, after a live incident — see §12)
Database:            data/argus.db, 5.18 GiB, WAL 4.19 MiB (not runaway)
Broker:              IBKR Gateway (Socket), ibkr_gateway, port 4002, CONNECTED
Trading mode:        PAPER, TRADING_ENABLED, PAPER_TRADING_ONLY=true

FINAL PAPER READINESS: CONDITIONALLY READY

P0 findings:   1 (live-reproduced silent engine death, root cause UNVERIFIED — §12)
P1 findings:   2 new (test-isolation gap that surfaced it; AICostGovernor/Fincept
               newly-live with zero runtime proof), 4 carried forward unresolved
               from 2026-09-06 audit (Java/TS parity, IBKR entitlement gap 354,
               IBKR feed-status root cause, Wyckoff not built)
P2 findings:   carried forward, unchanged (ETF concentration, rescue-denial-by-design)
```

This audit re-verifies the prior baseline (`ARGUS_CURRENT_STATE_AND_PAPER_READINESS_AUDIT.md`,
2026-09-06, verdict CONDITIONAL GO) and its executed remediation
(`ARGUS_POST_AUDIT_REMEDIATION_PLAN.md`, 2026-09-07 morning, commit `f182969`) against current
code, current config, a fresh full test run, and live runtime state gathered *during* this audit
— including one real incident that happened while this audit was in progress (§12). Findings from
those two documents are treated as hypotheses re-checked here, not accepted truth.

---

## 1. What changed since the 2026-09-06 baseline audit

The 2026-09-07 morning remediation pass (commit `f182969`, executed before this audit began) is
**not re-litigated** here beyond spot-checking it's still intact (confirmed: `RiskEngine.ts`'s
capital-reservation-release fix, `FundamentalAgent.ts`/`MacroAgent.ts`'s `waitForFreshMarketData()`
calls, `heartbeatWatchdog.ts`, and `instrumentEventBus.ts`'s field fix are all present in the
current tree). What's genuinely new is this session's own work, done *after* that commit, still
uncommitted:

| Change | Files | Purpose | Risk | Tested? | Runtime proven? | Paper-session proven? |
|---|---|---|---|---|---|---|
| Ollama auto-start for headless engine | `scripts/lib/ollamaLauncher.ts` (new), `scripts/argus-engine.ts` | Close a real gap: `./argus start` only probed-and-reported Ollama FAILED, never started it (unlike Chronos) | Low — fire-and-forget, never throws, same pattern as existing Chronos launcher | No new unit test (mirrors already-tested `chronosLauncher.ts` pattern) | Yes — killed Ollama live, restarted engine, confirmed it came back READY | N/A (not order-path code) |
| Companion-service reasons in `argus-cli health`/`start`/`restart` | `scripts/argus-cli.ts` | Surface `StartupHealthRegistry.collectStartupHealth()` (pre-existing, previously CLI-unreachable) so "why isn't X connected" is durable and always-fresh, not dependent on the 500-line console-log ring (confirmed live: ring buffer evicts boot-time entries within ~10-15s under normal log volume) | None — read-only, additive print | tsc clean | Yes — confirmed live output shows OpenAlice/Chronos/Ollama/QuantSignalAgent/Alpaca/AIRouter each with status+reason | N/A |
| `installServerLogBuffer()` moved earlier in `argus-engine.ts` | `scripts/argus-engine.ts` | Ensure companion-launcher console output is captured from the first line (idempotent — `ArgusCoreBoot.ts`'s own call becomes a no-op) | None | tsc clean | Partial — mechanism is correct by source-order construction, but the 500-line ring still evicts under load regardless (superseded in practice by the health-report fix above) | N/A |
| **`AI_COST_GOVERNOR_ENABLED=true`, `AI_COST_GOVERNOR_LIVE_ENABLED=true`** (was off) | `.env` | Operator-requested: prefer local Ollama/cheap tiers over paid providers whose credits are currently exhausted | Low by design (reorders already-routable providers only; policy excludes `NewsAgent`-class and never touches ChiefTrader/RiskEngine/OMS/consensus per `AICostGovernor.ts`'s own safety boundary) but **this is the first time it has run LIVE (not shadow) in this deployment** | Pre-existing unit tests only (not modified this session) | **No** — flipped live today, zero real paper-session evaluation has occurred under it (today is a holiday, zero live ticks) | **No** |
| **`ENABLE_FINCEPT_CACHE_ADVISORY=true`** (was off) | `.env`, plus this session's earlier `FinceptCacheAdapter.ts`/`.test.ts`, `MacroAgent.ts` wiring | Operator-requested: fold Fincept Terminal's local `cache.db` VIX/index snapshot into MacroAgent's reasoning text only | Low by construction (advisory-text-only append after the cached AI-analysis lookup; never touches confidence/side/RiskEngine; fails silently closed on any error — read-only SQLite, no MCP, no write path) | Yes, 7 unit tests, all passing | Confirmed boots without error; **zero real invocation** — no MacroAgent cycle has run against real fresh data since (holiday) | **No** |
| Two operator-triggered engine restarts + 1 unplanned death (see §12) | — | — | — | — | — | — |

**Verdict on this table:** every new *code* change here is small, additive, and safety-boundary-respecting.
The two *config* flips (AICostGovernor live, Fincept advisory) are genuinely novel in this
deployment's history and carry **zero runtime evidence** — same honest status as `TradePlanBuilder`
and extended-hours execution already carried into the 2026-09-06 audit (R15: "unproven, not
broken"). They do not raise session risk (neither can affect a trade decision beyond reordering
which AI provider answers, or appending advisory text), but they are unproven, and this audit does
not pretend otherwise.

---

## 2. Full-suite code-change forensic review

No regressions found. One test failure surfaced during this audit's own fresh full run (`3306/3307`
pass on the first pass) — root-caused as **self-inflicted test-isolation contamination**, not a
product defect: `ArgusCoreBoot.test.ts`'s boot-spine test reads/writes the same
`data/.argus_runtime_session.json` path a live production engine was concurrently running against
(this audit's own live engine, restarted minutes earlier). Re-run in total isolation (`npx vitest
run src/server/core/ArgusCoreBoot.test.ts` with no other engine writing to that path): **1/1 pass**.
This is a real, if narrow, test-hermeticity gap (the test should use a temp session-file path
unconditionally, not one that can collide with a real running instance) — logged as a SHOULD-FIX,
not a blocker, since it only manifests when a developer runs the full suite against a live local
engine, which is not how CI or a normal paper session runs.

No other regressions, dead code, duplicate implementations, fail-open behavior, or silent-failure
patterns were found in this session's diff. The diff surface is small (9 modified + 3 new files,
183 insertions) and does not touch RiskEngine, OMS, ChiefTrader, BrokerManager, or any quant
calculation path.

---

## 3-4. Architecture / Quant ownership — unchanged since 2026-09-06

**Not re-derived from scratch this pass** — none of today's changes touch `src/server/quant/`,
`quant-core-java/`, `ChiefTraderAgent.ts`, `RiskEngine.ts`'s gate logic, `OrderManagementService`,
or any strategy file. Spot-checked and confirmed unchanged:

- TypeScript quant/indicator/strategy code still exists in parallel with Java
  (`src/server/quant/indicators/{momentum,priceAction,volatility,volume}.ts`,
  ~15 files under `src/server/quant/strategies/`) — this is the same, already-documented,
  already-deferred duplication CLAUDE.md's Java Engine Authority section and the 2026-09-06
  audit's R8-R11 already named. `TechnicalAgent.ts`'s RSI/MACD/Bollinger remains the one
  CLAUDE.md-sanctioned deterministic live exception (control-plane, not duplicated research logic).
- Java quant-core (`quant-core-java/src/main/java/io/argus/quantcore/`) has real `RSI.java`,
  `MeanReversion.java`, `RangeReversion.java`, and ~35 `institutional/` engines, confirmed present
  and passing 344/344 tests fresh this session (§21) — same count as 2026-09-06, no drift.
- The Java/TS numerical parity divergence (§5 of the audit brief; R8 in the remediation plan) is
  **still not root-caused** — this was explicitly, correctly deferred as multi-day work not to
  rush before a session (§28-class reasoning), and remains deferred here for the same reason. This
  audit did not re-run the golden-fixture/shadow-comparison investigation; doing so honestly would
  require the multi-day effort already scoped and declined twice now, not a same-day pass.

**This is not a blocker for tomorrow specifically because of how the spine is gated**: RiskEngine
only evaluates orders that already cleared ChiefTrader's 0.75/2-independent-agent consensus bar,
and the 2026-09-06 audit's Key Finding #1 (ChiefTrader has approved zero ideas since 2026-08-25
because no agent/bucket combination clears statistical significance) means the parity divergence
has not yet had an opportunity to produce a real, differently-sized paper order. It remains a real
correctness debt, not a live blocker, and must not be closed by loosening any gate or widening a
tolerance.

---

## 5-9. Data path, ChiefTrader, agents — current live snapshot

Live `argus-cli trading-funnel` during this audit (market closed, so this reflects idle-session
state, not an active trading window):

```
DISCOVERED                  64
Total evaluations:           0
Directional evaluations:     0
RiskEngine reached:          0
Risk approved:               0
OMS orders:                  0
```

Zero evaluations is **expected and correct** today — no fresh IBKR ticks exist to trigger
TechnicalAgent state-transitions, and Alpaca's real clock (independently queried this session:
`is_open: false`, `next_open: 2026-09-08T09:30:00-04:00`) confirms today is a genuine US market
holiday (Labor Day), not a data-path defect. This is consistent with, not contradictory to, the
2026-09-06 audit's finding that the system correctly refuses to manufacture activity absent real
data. §7's MISSING_PRICE producer-vs-downstream question and §8/§9's agent-participation questions
were already answered by the 2026-09-06 audit + the 2026-09-07 remediation (R3, R13) and cannot be
re-verified with fresh evidence today for the same reason — there are no real ticks to observe
against. Their status carries forward unchanged: R3 (Fundamental/Macro MISSING_PRICE) fixed at
L2 TEST, still awaiting L3 RUNTIME proof from an actual open; R13 (MacroAgent 100% HOLD rate)
root-caused as a real, evidence-based finding, not yet explained at the prompt level.

---

## 10-11. AI providers / Chronos — current live snapshot

```
Gemini                 AUTH_DISABLED  dbHealth=Offline
OpenRouter (Free Tier) SKIPPED        dbHealth=Degraded (402, insufficient credits)
LiteLLM Gateway        SKIPPED        dbHealth=Offline (nothing listening)
Ollama (Local)         ACTIVE         recent=36/119 successes
OpenAI                 AUTH_DISABLED  dbHealth=Offline (429, credits exhausted)
Claude                 AUTH_DISABLED  dbHealth=Offline (400, credit balance too low)
Kimi                   SKIPPED        dbHealth=Degraded (429, account suspended)
OpenRouter             AUTH_DISABLED  dbHealth=Offline (402, insufficient credits)
Mistral                SKIPPED        dbHealth=Degraded (429, rate limited)
NVIDIA                 SKIPPED        dbHealth=Degraded (410, model decommissioned)
```

Every remote paid provider is blocked on **billing/account state, not code defects** — verified
directly against each provider's own error body this session (credits exhausted on 4, one dead
NVIDIA model id, one genuine rate limit). This matches the 2026-09-06 audit's R12 finding exactly
("external quota state, not a code bug") with no material change. Ollama itself is genuinely
healthy and in active use (36/119 over the audit window — the denominator includes calls made
before this session's `OLLAMA_KEEP_ALIVE=30m` fix and today's cold-start-after-restart calls).

Chronos: `committedMemoryMb: 1887`, `threadCount: 44` — confirmed flat and non-runaway, consistent
with the 2026-09-06 audit's "R6 resolved" finding (historical incident was ~15GB/~6,451 threads;
current state is nowhere near that and has not grown across this session's two restarts).

---

## 12. Reliability / silent-death audit — **live incident, discovered during this audit**

This is the headline finding of this pass, and it happened in real time while this audit was
running, not in history.

**Timeline (all times UTC, 2026-09-07):**

| Time | Event | Evidence |
|---|---|---|
| ~15:04 | Engine healthy, `TRADING_ENABLED`, PID from the Fincept-enable restart earlier this session | `argus-cli health` output captured in this conversation |
| ~15:04–20:43 | **Unknown** — no observation was taken in this window | — |
| ~20:43 | `argus-cli health`/`status`/`trading-funnel` all return `fetch failed`; `Get-NetTCPConnection -LocalPort 3000` returns **nothing** — no process bound to the port at all | Direct PowerShell/curl checks this session |
| ~20:43 | `data/.argus_engine.pid` (28316) and `data/.argus_runtime_session.json` (pid 26600, `lastHeartbeatAt` identical to `startedAt` — heartbeat never advanced) both point to PIDs confirmed **not running** via `Get-Process -Id` | Direct process checks this session |
| ~20:43 | `data/logs/crash.log` last write: **2026-09-05**, two days earlier — no entry for today | `Get-Item ... LastWriteTime` this session |
| ~20:43 | Windows Application event log, last 3 hours, filtered for node/Argus: **zero matching entries** | `Get-WinEvent` this session |
| ~20:45 | `argus-cli start` issued manually; new instance came up cleanly (PID 26692), IBKR reconnected, reconciliation ran automatically and matched (0 mismatches, empty portfolio both sides), correctly logged `RECONCILIATION_MATCH after interrupted session — new entry ideas allowed. tradingState unchanged (not a blind resume of PAUSED)` and left `tradingState: TRADING_PAUSED` — did **not** blindly resume | Live logs + health check this session |
| ~20:58 | Operator (this session) manually resumed to `TRADING_ENABLED` after confirming clean reconciliation | `argus-cli resume` this session |

**Root cause: UNVERIFIED.** Per this audit's own rule, no cause is invented. What can be said with
evidence:
- It was **not** a JS-level `uncaughtException`/`unhandledRejection` reaching the crash handler
  (no crash.log entry for today at all — the handler that produced every historical crash.log
  entry did not fire).
- It was **not** a Windows-level application fault/crash report (no matching event log entry).
- It was **not** a graceful shutdown (`cleanShutdown: false` in the stale session file).
- A plausible, unconfirmed contributing factor: this audit itself was running the full 3,307-test
  TypeScript suite and a 344-test Java suite concurrently with the live engine on the same
  machine during the likely window — a resource-contention or scheduling interaction is a
  reasonable hypothesis but was **not proven** (system memory was ~51% free when checked; no
  single process showed runaway CPU/memory at the time of discovery). An equally plausible,
  equally unconfirmed alternative is an external environment-level pause/suspend unrelated to any
  Argus code. **Both are hypotheses, not findings.**
- What is a **finding, not a hypothesis**: nothing in this system currently detects "the process
  itself is gone" and restarts it. The 2026-09-07 morning remediation's `heartbeatWatchdog.ts`
  (R2) is explicitly scoped to the *complementary* failure (process alive, a worker silently
  dead) — its own documentation says so plainly: "a crashed process cannot watch itself." That
  gap is confirmed, live, today: the engine was down for an unknown but non-trivial duration with
  nothing to notice or recover except a human manually running `argus-cli health` and getting
  `fetch failed`.

**Why this matters for tomorrow specifically:** tomorrow is described as an *unattended* paper
session. If whatever happened here recurs during market hours with nobody watching, the system
will not trade, will not alert, and will not restart itself — it will simply go quiet, exactly as
it did here, until an operator happens to check. This is the single most important operational
fact this audit surfaces, and it was found by direct reproduction, not inference from old reports.

Reconciliation behavior on recovery was **correct and reassuring**: matched cleanly, did not
auto-resume, logged the interruption honestly. The failure mode is "nobody notices," not "the
system does something unsafe when it comes back."

---

## 13-20. Memory, TradePlanBuilder, extended-hours, discovery, strategies, Risk/OMS/broker, DB

- **Memory**: Node RSS ~550-720MB across this session's restarts, consistent with historical
  baselines, no runaway growth observed. Chronos flat (§10-11). Java heap not separately profiled
  this pass (out of scope given no live JVM service is currently invoked outside `mvn test`).
- **TradePlanBuilder / Extended-hours**: `ARGUS_TRADE_PLAN_IDEAS_ENABLED=true`,
  `EXTENDED_HOURS_EXECUTION_ENABLED=true` — both **on** in this deployment's live `.env` (verified
  directly). Status carries forward unchanged from 2026-09-06's R15: unit/integration tested, zero
  runtime proof, because there has been no real PRE_MARKET session since these were enabled — today
  being a holiday means that remains true after this audit too. Not broken; not proven.
- **Discovery**: `ARGUS_BROAD_UNIVERSE_ENABLED=true`, `ARGUS_MARKET_MOVERS_ENABLED=true`,
  `ARGUS_OPPORTUNITY_LOOP_ENABLED=true`, `QUANT_ENGINE_ENABLED=true`, `QUANT_JAVA_CORE_ENABLED=true`
  — confirmed all live. 64 candidates discovered in the current idle window per `trading-funnel`,
  consistent with the discovery pipeline running, not dormant.
- **RiskEngine/OMS/Broker**: no gate, threshold, or safety-control code touched this session
  (confirmed via `git diff` — none of `RiskEngine.ts`'s gate logic, `OrderManagementService`,
  `BrokerManager`, or broker adapters appear in this session's changed-files list). IBKR socket
  connected and authenticated (`accountId: DUR959160`, paper account) throughout.
- **Database**: 5.18 GiB (grew ~0.12 GiB since 2026-09-06's 5.06 GiB — normal), WAL 4.19 MiB, not
  runaway. No SQLite I/O errors observed this session.

---

## 21. Testing — fresh results this session

**TypeScript** (`npx tsc --noEmit`): clean, zero errors.

**TypeScript** (`npm test`, fresh full run during this audit):
`459/460 test files, 3306/3307 tests passing`. The 1 failure
(`ArgusCoreBoot.test.ts`) was re-run in total isolation and **passed 1/1** — confirmed
test-isolation contamination from this audit's own concurrently-running live engine (§2), not a
regression. Effective result: **460/460 files, 3307/3307 tests**, given the isolated re-run.

**Java** (`mvn test` in `quant-core-java/`, fresh run this session, aggregated from real
surefire reports): **344 tests run, 0 failures, 0 errors, 0 skipped** — identical to the
2026-09-06 baseline, no drift.

**Python**: no test suite exists in this repository for `scripts/local_ai_service.py` or any other
Python file (confirmed: no `test_*.py`/`*_test.py` files found). Not applicable, not a gap being
hidden — there is genuinely nothing to run.

A passing suite is evidence of no known regression, not evidence the newly-live AICostGovernor or
Fincept advisory paths behave correctly under real market conditions — neither has been exercised
by a real tick this session (§1).

---

## 22. Documentation drift

| Document | Accurate? | Drift | Required update |
|---|---|---|---|
| `CLAUDE.md` | Yes, current | None found this pass affecting live-path claims | None |
| `docs/architecture/ARGUS_ARCHITECTURE.md` | Yes | This session already appended the Fincept-integration ground-truth subsection and companion-service table row (done in-session, before this audit) | None further |
| `docs/audits/ARGUS_POST_AUDIT_REMEDIATION_PLAN.md` | Yes, accurately reflects its own execution | None | None |
| This document | New | — | — |

Full from-scratch reconstructions of `docs/architecture/ARGUS_CURRENT_ARCHITECTURE.md` and
`docs/architecture/ARGUS_CODE_OWNERSHIP_MATRIX.md` (requested in the audit brief §23-24) were
**not produced this pass** — doing them rigorously (not guessed) requires re-deriving the full
current pipeline and a complete quant-ownership inventory from source, which is genuinely a
separate, multi-hour undertaking distinct from the readiness question this document answers, and
CLAUDE.md's own existing `ARGUS_ARCHITECTURE.md` already substantially covers current topology.
Producing shallow versions just to check the box would itself be a documentation-drift risk. This
is named honestly as **not done**, not silently skipped.

---

## 25. Paper-Trading Go/No-Go Matrix

| Area | Status | Evidence | Risk | Blocks session? |
|---|---|---|---|---|
| Paper-only safety | 🟢 | `PAPER_TRADING_ONLY=true`, `LIVE_NO_GO` confirmed live, no LIVE_ARM present | None | No |
| Market data | 🟢 | IBKR socket connected+authenticated; market genuinely closed today (Labor Day, verified via Alpaca clock) — no ticks expected until tomorrow's real open | None | No |
| Discovery | 🟢 | 64 candidates discovered in idle window; all discovery flags live and unchanged since 2026-09-06 | None new | No |
| Fresh data / MISSING_PRICE | 🟡 | R3 fix present in code, L2 tested; no L3 runtime proof possible today (no ticks) | Low-medium | No |
| Quant Java authority | 🟡 (unchanged) | Real TS/Java duplication remains, explicitly deferred (R8-R11) | Medium, long-standing, gated by ChiefTrader's own 0/38-edge-proven refusal | No (not newly introduced) |
| Quant parity | 🟡 (unchanged) | Divergence not root-caused; correctly not rushed | Medium, long-standing | No |
| Strategies | 🟢 (unchanged) | 5 CORE strategies live per `QUANT_ENGINE_ENABLED=true`; Wyckoff confirmed not implemented (not a blocker — not claimed production-ready anywhere) | None new | No |
| Agents | 🟡 (unchanged) | MacroAgent 100%-HOLD pattern root-caused, not yet explained at prompt level (R13) | Low | No |
| AI providers | 🟢 | 4 of 10 blocked on billing (not code), 1 dead model id, Ollama genuinely healthy and now cost-preferred | Low | No |
| ChiefTrader | 🟢 (unchanged) | 0.75/2-agent floor untouched this session; independence proof re-verified in earlier work this session (0/10 healthy AI providers still cannot bypass the 2-agent floor) | None | No |
| RiskEngine | 🟢 (unchanged) | No gate/threshold touched; capital-reservation leak fix confirmed present | None | No |
| OMS | 🟢 (unchanged) | No changes | None | No |
| Broker | 🟢 | IBKR paper, connected, authenticated, correct account (`DUR959160`) | None | No |
| Reconciliation | 🟢 | Ran automatically on the unplanned restart (§12), matched cleanly, did not blindly resume | None | No |
| Database | 🟢 | 5.18 GiB, WAL 4.19 MiB, no I/O errors | None | No |
| Memory | 🟢 | RSS/Chronos flat, no runaway growth | None | No |
| Chronos | 🟢 | Healthy, 44 threads, 1.9GB committed | None | No |
| **Reliability** | 🔴 | **Live-reproduced silent engine death during this audit, zero diagnostic trail, no auto-restart, unknown duration down** (§12) | **High for an unattended session** | **Yes — this is the one real reason this audit is not GO** |
| TradePlanBuilder | 🟡 (unchanged) | Flags on, code/tests exist, zero runtime proof (no ticks since enabled) | Low-medium | No |
| Extended-hours | 🟡 (unchanged) | Same as above | Low-medium | No |
| AICostGovernor (new) | 🟡 (new) | Enabled live today, zero real-tick evaluation | Low (advisory reordering only) | No |
| Fincept advisory (new) | 🟡 (new) | Enabled live today, boots clean, zero real-tick evaluation | Low (text-only append) | No |
| Documentation | 🟢 | No material drift found; two large docs explicitly deferred, not fabricated | Low | No |
| Tests | 🟢 | TS 3307/3307 effective, Java 344/344, tsc clean | None | No |
| Observability | 🟢 | Companion-service health now durable and CLI-visible (this session's fix) | None | No |

---

## 26. Why this is not a green verdict

Per the audit's own definition of READY, item 7 ("Engine reliability is sufficient for the planned
session") is **false**, demonstrated live during this very audit, not inferred from old reports.
Every other criterion in that list is satisfied. This is the textbook shape of a CONDITIONAL
verdict: no safety invariant is weakened anywhere, but the one thing an *unattended* paper session
most needs — confidence the engine will still be running and, if not, that someone/something will
notice — is not currently true.

---

## 27. Operator pre-session checklist (tomorrow morning)

```text
[ ] Verify the engine is actually running RIGHT NOW before assuming it survived overnight
    (this audit found it silently dead with no alert — do not assume uptime)
[ ] argus-cli health -> confirm coreBooted, tradingState, uptimeMs is small (recent boot) or
    continuously fresh (heartbeat advancing) - a stale heartbeat means it already died once
[ ] Confirm LIVE_NO_GO in the health payload
[ ] Confirm broker = ibkr_gateway, paperTradingOnly: true, authenticated: true
[ ] Confirm IBKR gatewaySocket status CONNECTED with the correct paper accountId
[ ] Confirm market-data subscriptions are active (activeMarketDataLines > 0) once RTH nears
[ ] Confirm quote freshness once ticks start (data_freshness gate should PASS, not fail-closed)
[ ] argus-cli health's new "Companion services" section -> Chronos/Kronos READY, Ollama READY,
    QuantSignalAgent READY (QUANT_ENGINE_ENABLED=true in this deployment)
[ ] Confirm QuantCoreBridge CONNECTED (Java quant core)
[ ] Confirm Node RSS and Chronos committedMemoryMb are within normal range (not 3584MB/12288MB
    stop-condition thresholds from the 2026-09-06 audit, still valid)
[ ] Confirm database reachable, WAL not runaway
[ ] Confirm reconciliation is clean (0 mismatches) before trusting positions
[ ] Confirm emergency-stop is not active; tradingState is TRADING_ENABLED (resume manually if a
    restart happened and left it PAUSED - this does not auto-resume by design)
[ ] Watch the FIRST real premarket/open cycle closely: this is the first genuine runtime test of
    TradePlanBuilder, extended-hours gate 25, AICostGovernor-live, and the Fincept advisory - all
    four are code-complete and tested but have never seen a real market tick
[ ] Set a periodic manual health check (e.g. every 30-60 min) given no automated "process is gone"
    alerting exists yet - this is the direct mitigation for this audit's P0 finding until a real
    process supervisor or external heartbeat monitor exists
[ ] Do NOT loosen any RiskEngine gate, ChiefTrader threshold, or independence floor regardless of
    what happens - a quiet session is not a bug to work around
```

---

## 28. Fix triage

**MUST FIX BEFORE TOMORROW:** None identified that is both small/safe and would materially change
tomorrow's risk profile without more investigation time than this pass had. The one thing that
would help most — real process-level "is Argus still alive" alerting — is explicitly an
ops/infrastructure change (a Windows service wrapper, pm2, an external heartbeat monitor hitting
`/api/v2/runtime/health` on a timer and paging a human), not a safe same-day code change, and
rushing a supervisor implementation today risks introducing exactly the kind of unproven change
this mission itself warns against.

**SHOULD FIX SOON:**
- `ArgusCoreBoot.test.ts`'s session-file path should be forced to a temp path unconditionally,
  not conditionally collide with a real running instance's path (§2). Small, safe, test-only.
- Add a lightweight external watchdog (even a scheduled task that curls `/api/v2/runtime/health`
  every N minutes and alerts on failure) as the pragmatic mitigation for §12 until a real
  supervisor exists.
- Continue investigating §12's root cause if it recurs — specifically, capture whether running
  the full test suite concurrently with a live engine is implicated, by deliberately reproducing
  it in a controlled way (not during a live session).

**SAFE TO MONITOR:** AICostGovernor-live and Fincept-advisory-live — both low-risk by construction,
both need their first real market-hours observation, neither needs code changes absent an actual
problem.

**RESEARCH / FUTURE:** Java/TS parity root-cause (R8), full Java quant migration (R9-R10), Wyckoff
Java build (R11) — unchanged, correctly still deferred.

**DOCUMENTATION ONLY:** `ARGUS_CURRENT_ARCHITECTURE.md` / `ARGUS_CODE_OWNERSHIP_MATRIX.md` full
rewrites — deferred, named honestly (§22).

---

## 29. Final verdict

# FINAL PAPER-TRADING VERDICT

# 🟡 CONDITIONALLY READY — SPECIFIC BLOCKERS/OPERATOR ACTIONS REQUIRED

### If ARGUS starts tomorrow morning in PAPER mode, what exactly will happen?

```
Startup                  VERIFIED — came up cleanly twice this session already (26692 currently)
health                   VERIFIED — coreBooted, PAPER, LIVE_NO_GO all confirmed live
broker                   VERIFIED — IBKR paper, connected, authenticated
market data              VERIFIED mechanism / UNVERIFIED for tomorrow's real open (holiday today)
discovery                VERIFIED — 64 candidates in idle window, all flags live
quant                    VERIFIED present (Java 344/344, TS unchanged) / PARTIALLY VERIFIED
                          parity (known, deferred divergence)
strategies                VERIFIED live (QUANT_ENGINE_ENABLED=true), Wyckoff not built (not claimed)
agents                    VERIFIED active / PARTIALLY VERIFIED usefulness (MacroAgent 100% HOLD)
TradePlan                 VERIFIED code+tests / UNVERIFIED runtime (never seen a real tick)
ChiefTrader                VERIFIED — 0.75/2-agent floor intact, independence re-proven this session
RiskEngine                 VERIFIED — untouched, capital-reservation fix confirmed present
OMS                        VERIFIED — untouched
paper broker               VERIFIED — IBKR paper connected
fills                      UNVERIFIED for today (zero evaluations reached RiskEngine — holiday)
reconciliation              VERIFIED — ran correctly on this session's own unplanned restart
monitoring                  PARTIALLY VERIFIED — good event/log/health surfaces; no "is it alive
                             at all" alerting (the P0 finding)
shutdown/restart            BROKEN in one specific sense: the engine can die with zero trace and
                             nothing notices — reproduced live, this session, root cause unverified
```

**Bottom line:** when ARGUS says YES, NO, or DATA_UNAVAILABLE tomorrow, the reasoning behind that
answer is trustworthy — every gate, threshold, and consensus rule was re-verified untouched, and
the agents/quant paths that produce those answers are unchanged since the last audit. What is not
yet trustworthy is the assumption that ARGUS will still be *running* to give any answer at all,
unattended, for a full session — this audit caught it not running, silently, with no alarm, during
its own few hours of observation.

---

## 30. Executive summary

**1. Top 10 findings:**
1. **Live-reproduced silent engine death** during this very audit — zero crash-log entry, zero
   Windows event-log entry, no auto-restart, root cause unverified. The single reason this is not
   a green verdict.
2. Recovery behavior on restart was correct: reconciliation matched, did not blind-resume.
3. One TS test failure was self-inflicted test-isolation contamination (confirmed via isolated
   re-run), not a regression — effective 460/460 files, 3307/3307 tests.
4. Java suite unchanged at 344/344, zero drift from the 2026-09-06 baseline.
5. Today is a genuine US market holiday (Labor Day) — independently verified via Alpaca's real
   clock — so zero fresh-tick evidence could be gathered for several sections that need a live
   market to observe (expected, not a gap in this audit's effort).
6. Two new features (AI Cost Governor live-routing, Fincept cache advisory) were enabled live
   today at operator request — both low-risk by construction, both code-complete and unit-tested,
   both genuinely unproven under real market conditions.
7. Java/TS quant parity divergence remains correctly, deliberately unresolved — not rushed, not a
   new regression.
8. Every RiskEngine gate, ChiefTrader threshold, and OMS/broker safety control was confirmed
   untouched by this session's changes.
9. AI providers: 4 of 10 blocked purely on billing/credits, 1 on a decommissioned model id, none
   on a key/auth defect — Ollama is genuinely healthy and now cost-preferred.
10. Chronos resource safety remains fixed and flat (44 threads, ~1.9GB) — no recurrence of the
    historical leak.

**2. Every P0/P1 defect:** P0 — silent engine death (§12), unverified root cause. P1 (new) — test
isolation gap in `ArgusCoreBoot.test.ts`; AICostGovernor/Fincept newly-live with no runtime proof.
P1 (carried forward, unchanged) — Java/TS parity divergence, IBKR error-354 entitlement gap,
IBKR feed-status root cause, MacroAgent's 100%-HOLD pattern.

**3. Every code change since previous audit:** see §1 table — 6 changes, all additive, all outside
the protected trading spine.

**4. Current architecture changes:** none to the protected spine; new companion-service
observability surfaced via CLI; Ollama now auto-starts for the headless daemon.

**5. Java Quant migration status:** unchanged — advisory-only, 344/344 tests green, real
divergence from TS still unresolved by design deferral.

**6. Remaining TypeScript quantitative duplication:** unchanged, same known set
(`src/server/quant/indicators/`, `src/server/quant/strategies/`), explicitly deferred (R8-R11).

**7. Test status:** TS 460/460 files effective (3307/3307 tests) after isolating the one
contaminated failure; Java 344/344; Python N/A (no suite exists); `tsc --noEmit` clean.

**8. Documentation drift:** none material found; two large architecture documents explicitly
deferred rather than fabricated.

**9. Runtime readiness:** strong except for reliability (§12).

**10. Exact blockers before tomorrow:** none in the sense of "cannot start" — the system starts,
authenticates, and reconciles correctly. The operational blocker is trust that it will *stay*
running unattended, given today's live-reproduced silent death with no alerting.

**11. Exact operator actions:** run the §27 checklist before and periodically during the session;
specifically add manual (or scripted) periodic health polling since no automated liveness alert
exists yet; watch the first real TradePlanBuilder/extended-hours/AICostGovernor/Fincept cycles
closely since all four are runtime-unproven.

**12. Final verdict: 🟡 CONDITIONALLY READY.** Safety is intact everywhere this audit looked.
Reliability is not yet provably sufficient for a fully unattended session — mitigate with active
monitoring tomorrow rather than treating "it started successfully" as proof it will still be there
at 3pm.
