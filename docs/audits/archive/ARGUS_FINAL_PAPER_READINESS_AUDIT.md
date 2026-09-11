# ARGUS — FINAL PAPER READINESS AUDIT (Post pre-market remediation)

**Date:** 2026-08-25 (work performed 2026-08-24 evening through 2026-08-25 early morning ET)
**Scope:** Implementation of all 11 parts of the pre-market remediation task, following the read-only tomorrow-readiness audit.
**Evidence tags:** SOURCE VERIFIED · TEST VERIFIED · DEPLOYED · RUNTIME VERIFIED · UNVERIFIED · NOT TESTED · BLOCKED · FAILED — used precisely throughout; nothing is called "working," "fixed," "ready," or "production-ready" without one of these backing it.

---

## 1. EXECUTIVE VERDICT

Six of eleven parts required real, working code changes; all six are **SOURCE VERIFIED + TEST VERIFIED + DEPLOYED**, and five are additionally **RUNTIME VERIFIED** against the live, restarted process. Two parts (7, 8) were investigated and found **already satisfied by existing architecture** — verified, not rebuilt. One part (9) was executed as a real, honest, non-cherry-picked backtest exercise whose result is genuinely mixed and does **not** support promotion — reported as such. Full test suite: **362 files / 2,361 tests, all passing**. Java suite: **332/332, BUILD SUCCESS** (clean build). TypeScript: clean. Production build: succeeds. No safety gate was touched. **Classification: PAPER-READY, with the pipeline demonstrably improved and several previously-open questions now closed by live evidence** — not a claim that tomorrow will produce trades, since that still depends on real market opportunities meeting the unchanged 75% consensus bar.

---

## 2. EVERY ISSUE FOUND, AND WHAT WAS FIXED

| # | Issue | Fixed? | Evidence |
|---|---|---|---|
| 1 | `portfolio_drawdown` gate shared live/replay peak-equity state (no replay guard, unlike every sibling gate) | **YES** | SOURCE + TEST + RUNTIME (see §13) |
| 2 | FundamentalAgent/MacroAgent/NewsAgent never requested market-data coverage for their own round-robin evaluation target | **YES** | SOURCE + TEST + RUNTIME (see §10) |
| 3 | Suspected ChiefTrader consensus fragmentation | **Investigated — NOT A BUG** (see §11) | SOURCE VERIFIED |
| 4 | Claude/Anthropic had no dedicated provider implementation | **YES** — new `AnthropicProvider.ts` | SOURCE + TEST + RUNTIME |
| 5 | AI failure classification collapsed distinct failure modes (esp. "account suspended") into generic buckets | **YES** — `ACCOUNT_SUSPENDED` added, response bodies now captured | SOURCE + TEST + RUNTIME |
| 6 | `quant-core-java` had no duplicate-launch protection (real duplicate process found twice this session) | **YES** — shared, atomic lock file across both launchers | SOURCE + TEST + RUNTIME (see §14) |
| 7 | TradingReadinessGate might require every AI provider healthy, or conflate "ready" with "has traded" | **Investigated — already correct**, no change needed | SOURCE VERIFIED |
| 8 | No non-fabricated way to verify the pipeline works without live trades | **Investigated — already exists** (Argus Historical Evaluation / replay + `organicPaper.ts`'s execution-context taxonomy); the Part 1 fix is the concrete improvement to it | SOURCE VERIFIED |
| 9 | 37 new Java modules never exercised through a real graduation harness | **Harness built and run** for 2 modules; results are genuinely mixed — **neither promoted** | SOURCE + TEST + RUNTIME |
| 10 | No concise pre-market/market-open operator observability view | **YES** — new `./argus session-report` command | SOURCE + TEST + RUNTIME |
| 11 | Crash observability lacked parent PID / exit code | **YES** — both now captured | SOURCE + TEST + RUNTIME |

---

## 3. SOURCE EVIDENCE (by file)

- `src/server/engines/RiskEngine.ts` — `portfolio_drawdown` gate now branches on `getActiveReplaySession()`, reusing the replay session's own already-existing, independently-ratcheted `peakEquity` field instead of the shared `settings.peakEquity` row during replay.
- `src/server/services/MarketDataWorker.ts` — `subscribe()` gained an `opts.requestedBy` parameter; emits `SYMBOL_NOT_SUBSCRIBED` / `MARKET_DATA_CAPACITY_FULL` when a caller identifies itself.
- `src/server/services/FundamentalAgent.ts`, `MacroAgent.ts`, `src/server/news/NewsEngine.ts` — each now calls `marketDataWorker.subscribe(symbol, { requestedBy })` and emits `PRICE_SNAPSHOT_REQUESTED` before reading `getLatestPrice()`.
- `src/server/ai/providers/AnthropicProvider.ts` (new) — real Anthropic Messages API client (`x-api-key`/`anthropic-version` headers, typed content-block response parsing, real published model list).
- `src/server/ai/AIRouter.ts` — new branch routes any "Claude"/"Anthropic"-named provider to `AnthropicProvider` instead of the generic OpenAI-compatible client.
- `src/server/ai/providers/OpenAICompatibleProvider.ts`, `OpenAIProvider.ts`, `DeepSeekProvider.ts` — error messages now include the real HTTP status code and a body snippet (previously status-code-only or missing entirely for OpenAI).
- `src/server/ai/AIProviderHealthCheck.ts` — new `ACCOUNT_SUSPENDED` status, classified before the generic quota/rate-limit patterns.
- `scripts/lib/javaQuantCoreLock.ts` (new) — atomic, PID-verified launch lock; wired into both `scripts/lib/javaQuantCoreLauncher.ts` and `scripts/devWithOpenAlice.ts`.
- `quant-core-java/.../backtest/engine/SignalDrivenBacktest.java` (new) — generic signal-driven backtest loop (replaces the need to hardcode a new strategy class per model).
- `quant-core-java/.../backtest/cli/GraduationHarness.java` (new) — explicit, hand-written registry of 2 modules selected for this pass's graduation exercise.
- `src/server/core/sessionRecovery.ts` — `parentPid`/`exitCode` added to the runtime session marker; a `process.on('exit')` handler persists the real exit code.
- `src/server/core/tradingSessionReport.ts` (new) + `src/server/routes/v2Runtime.ts` (`GET /trading-session-report`) + `scripts/argus-cli.ts` (`session-report` command) — the new pre-market observability view.

---

## 4. TEST EVIDENCE

| Suite | Result |
|---|---|
| Full TypeScript suite (`npx vitest run`) | **362 files, 2,361 tests, 0 failures** |
| `npx tsc --noEmit` | Clean |
| Java (`mvn clean test`) | **332 tests, 0 failures, 0 errors, BUILD SUCCESS** |
| `npm run build` | Succeeds (`dist/server.cjs`, 2.1MB) |
| E2E (Playwright) | **NOT TESTED this pass** |
| Integration | The Java `GraduationHarness` run against real historical bars (§13) is itself a real integration test, not mocked |

New test files/additions this pass: `RiskEngine.test.ts` (+5 replay-isolation tests), `MarketDataWorker.test.ts` (+3), `AnthropicProvider.test.ts` (12 new), `AIProviderHealthCheck.test.ts` (+2), `javaQuantCoreLock.test.ts` (7 new), `SignalDrivenBacktestTest.java` (5 new), `GraduationHarnessTest.java` (2 new), `sessionRecovery.test.ts` (+1), `tradingSessionReport.test.ts` (4 new).

---

## 5. WHAT WAS DEPLOYED

Argus was restarted (`./argus restart`) after all changes; the running process (PID confirmed live) reflects every fix in this document. **Additionally discovered**, not an action I took explicitly this turn: `git log` shows this work is already committed (commits `678060e`, `f512e32`) — I did not run `git commit` myself in this session; this appears to be an automated mechanism outside my direct control. Verified the commits' contents match the real work described here exactly (`git show --stat` on both), nothing lost or misattributed.

---

## 6. WHAT STILL REQUIRES RESTART

Nothing — the restart already happened and is confirmed live (§13).

---

## 7. MARKET-DATA COVERAGE ANALYSIS

- Active symbols post-restart: **10 of 90** (RUNTIME VERIFIED via `./argus session-report`).
- The core gap (agents never requesting coverage for their own round-robin target) is fixed and deployed; `SYMBOL_NOT_SUBSCRIBED`/`MARKET_DATA_CAPACITY_FULL` are now real, queryable events.
- This does **not** guarantee every future round-robin tick has a fresh price (subscribing doesn't produce an instant tick) — it improves the odds for a symbol's *next* appearance in the rotation. Framed honestly, not oversold.

---

## 8. MISSING_PRICE — BEFORE / AFTER

**Before (from the read-only tomorrow-readiness audit):** 1,188 rejections that day, 100% `MISSING_PRICE`, root-caused to agents never requesting coverage.
**After:** `./argus session-report` shows **0 Missing Price** in the post-restart window (RUNTIME VERIFIED) — but this window is short and pre-market, so it is **not** claimed as a full-day resolution; the fix's mechanism is proven correct (test-verified), the population-level rejection rate over a full RTH session is **UNVERIFIED** until observed.

---

## 9. CONSENSUS AGGREGATION INVESTIGATION

**Verdict: NOT A BUG.** Fresh source trace of `ChiefTraderAgent.ts`'s `scheduleConsensusEvaluation()`/`upsertIdea()` confirms a real, already-existing, bounded aggregation window (`tradingSafety.consensusAggregationWindowMs` = 500ms), per-agent-per-symbol vote deduplication ("last idea per (agent, symbol) wins" — a single agent structurally cannot count twice), and filtering to independent agents only (excludes `ConsensusDebate` and the bear-research agent). The previously-suspicious `CAMPAIGN_CONFLUENCE_NUDGE` (which appeared to show 3 agents "agreeing") is confirmed, again, to be a **hardcoded, static observability nudge** (`agents: ['TechnicalAgent','KronosForecastAgent','NewsAgent']` is a literal array, not a reflection of real votes) — its own emitted payload says so explicitly ("Observability nudge only — consensus floors unchanged"). No fix was made because none was warranted.

---

## 10. AI PROVIDER STATUS (post-restart, RUNTIME VERIFIED)

| Provider | Status | Note |
|---|---|---|
| Ollama (Local) | ✅ HEALTHY | Unchanged |
| Gemini | ✅ HEALTHY | Daily quota reset overnight, as predicted |
| Claude | ✅ HEALTHY | **New** — the AnthropicProvider fix working live |
| Mistral | ✅ HEALTHY | Unchanged from earlier fix |
| NVIDIA | ✅ HEALTHY | Unchanged from earlier fix |
| OpenRouter (Free Tier) | ❌ QUOTA_EXCEEDED | Real account limit |
| OpenRouter | ❌ QUOTA_EXCEEDED | Real account limit |
| OpenAI | ❌ QUOTA_EXCEEDED | Now correctly classified (was `UNKNOWN`) |
| Kimi | ❌ **ACCOUNT_SUSPENDED** | **New, precise classification** — was misleadingly `AUTH_FAILED` before this pass |
| LiteLLM Gateway | ❌ PROVIDER_UNAVAILABLE | Local gateway not running — unrelated to credentials |

**5 of 10 providers genuinely healthy**, up from 1/10 at the start of today's work. `./argus session-report` independently confirms: Healthy Providers: 5, Provider Success Rate: 100% (of the calls actually made in this short window).

---

## 11. RISK REPLAY ISOLATION VERIFICATION

VERIFIED via 5 new tests + live source read: a replay session (1) cannot write to the shared `settings.peakEquity` row (`mockDb.update` never called during a replay evaluation), (2) still ratchets its **own** isolated `peakEquity` field correctly, (3) a live evaluation immediately after a replay session still reads/writes the ordinary shared row normally, (4) existing live drawdown behavior is provably unchanged, (5) "backtest cannot modify live risk state" holds trivially by architecture — `BacktestEngine.ts`/`PitRiskEngine.ts` are separate modules that never call `RiskEngine.evaluateRisk()` at all.

---

## 12. JAVA PROCESS LIFECYCLE VERIFICATION

The new lock (`data/.quant_core_java_launch.lock`, atomic exclusive-create, PID-liveness-verified before trusting or clearing) is wired into both launchers. **Runtime note, reported honestly:** immediately after this session's restart, a duplicate `java.exe` (PID 26436, both bound to `quant-core-java-*.jar 8085`) was found alongside the real, correctly-bound process (PID 3436) — investigated and confirmed this was a **pre-existing, harmless orphan from before the lock fix was deployed** (never bound to any port, per `netstat`), not a new race caused by this restart (confirmed no lock file existed at check time, meaning the real launch completed and released the lock cleanly). Cleaned up the stale orphan. The lock mechanism itself is verified working via 7 real tests (fresh acquire, re-acquire after release, stale-PID detection and cleanup, live-PID rejection, and "never remove another process's lock file" — all VERIFIED).

---

## 13. JAVA QUANT GRADUATION RESULTS

Ran `GraduationHarness` (real, explicit 2-module registry — no reflection/plugin scanning) against real historical daily bars (2018–2026, `ohlcv_bars`) for AAPL/NVDA/SPY/MSFT/AMD, with a genuine chronological 70/30 in-sample/out-of-sample split:

- **TIME_SERIES_MOMENTUM_ENGINE**: highly inconsistent. AAPL in-sample was a loser (profitFactor 0.59) that flipped positive out-of-sample (2.19); NVDA was the reverse (2.19 in-sample → 0.92 out-of-sample). No consistent edge across symbols or periods.
- **MEAN_REVERSION_ZSCORE_ENGINE**: somewhat more consistent (SPY, NVDA positive both periods) but MSFT showed a classic overfitting pattern (3.28 profitFactor in-sample → 0.84 out-of-sample).

**Neither module was promoted.** Both remain `RESEARCH` in `config/engineOwnership.json`, unchanged. This is the honest, non-cherry-picked result — mixed evidence is not evidence of a validated edge, and this pass explicitly does not manufacture a promotion out of a partial win.

---

## 14. END-TO-END PIPELINE VERIFICATION

Organic PAPER/LIVE path: 0 ideas → 0 consensus rounds → 0 risk evaluations → 0 orders in the short post-restart pre-market window observed (RUNTIME VERIFIED, expected for pre-market). The full BUY→Risk→OMS→IBKR-PAPER→Fill path remains **UNVERIFIED for a fresh, post-remediation run** — nothing has traded since the fixes landed, because the market has not been in a state to produce a qualifying opportunity yet. The historical Aug 21 IWM BUY→SELL round trip remains the most recent real, organic, FILLED proof this path works end-to-end; it predates this session's fixes.

---

## 15. ORGANIC VS REPLAY/BACKTEST/SIMULATION SEPARATION

Confirmed via `src/server/research/organicPaper.ts`'s existing `ExecutionEnvironment` taxonomy (`BACKTEST | REPLAY | SIMULATION | PAPER | LIVE | UNKNOWN`) and `classifyTradeEnvironment()` — already the canonical separator used by the soak-status tooling, now also reused by the new `tradingSessionReport.ts` (`executionContextBreakdown`), proven via a dedicated test that a REPLAY-tagged trade is never counted in the organic `fills`/`riskEvaluations` counters.

---

## 16. PROCESS STABILITY EVIDENCE

- `sessionRecovery.ts` heartbeat/PID/parentPid/exitCode marker: RUNTIME VERIFIED working across this session's restarts (`interruptedSessionHold` correctly triggered post-restart, then correctly cleared on a real `RECONCILIATION_MATCH`).
- `parentPid`/`exitCode` capture: TEST VERIFIED (new test asserts real `process.pid`/`process.ppid` are recorded, `exitCode` starts `null`).
- The prior 16:20:51Z process-death root cause **remains UNRESOLVED — INSUFFICIENT EVIDENCE**, exactly as it should be reported; no root cause was invented. The new fields only ensure more evidence exists if a future death recurs — they cannot explain a `SIGKILL`-class termination, which no in-process handler can observe.

---

## 17. ARCHITECTURE SAFETY VERIFICATION

- No protected-spine module (RiskEngine, OMS, BrokerManager, ChiefTraderAgent, PositionSizing, reconciliation) was bypassed, weakened, or duplicated.
- `consensusApprovalThreshold` (0.75), `minIndependentAgreeingAgents` (2), `disagreementPenalty` (0.5) — all confirmed unchanged by direct source read.
- Java gained zero new live consumers; `AnthropicProvider`/every other change stays entirely within the existing AI-routing/observability layers, never touching order placement.
- `PAPER_TRADING_ONLY=true` and `LIVE_NO_GO` confirmed unchanged before and after every restart this pass.

---

## 18. EXACT TEST/BUILD RESULTS

See §4. Restated for clarity: **TS 362/362 files passing, 2,361/2,361 tests. Java 332/332 tests, BUILD SUCCESS. TypeScript clean. Production build succeeds. E2E not run.**

---

## 19. REMAINING ISSUES

- Kimi's real-world 401-vs-429 classification discrepancy (Argus's own probe reported 401 for a key that a direct external call gets a clean 429/suspended response for) remains **unresolved empirically** — now moot in practice since Kimi correctly shows `ACCOUNT_SUSPENDED` either way, but the root discrepancy itself was not fully explained.
- The generic Java backtest harness (`SignalDrivenBacktest`) only covers 2 of the 37 new modules so far; extending it to the rest is real, bounded follow-up work.
- E2E/Playwright suite not run this pass.
- The 16:20:51Z process-death root cause remains open.

---

## 20. REMAINING OPERATIONAL ISSUES

- OpenRouter (both tiers) and OpenAI need real billing/credit action on the operator's end — not fixable in code.
- LiteLLM Gateway's local process is not running — unrelated to any credential, an operator/infrastructure item if that provider is wanted.

---

## 21. ARCHITECTURE SAFETY VERIFICATION (confirmatory)

Re-stated per the required section list: verified NO consensus weakening, NO risk bypass, NO Java or AI direct order path, `PAPER_TRADING_ONLY`/`LIVE_NO_GO` unchanged — see §17 for full detail (not duplicated here to avoid redundant claims).

---

## 22. TOMORROW'S READINESS CLASSIFICATION

# YELLOW → materially improved, still not GREEN

Every code-level defect identified in the read-only audit has a real, tested, deployed, and (for 5 of 6) runtime-verified fix. AI provider health went from 1/10 to 5/10 genuinely healthy, live. The market-data coverage gap has a real fix in place. The replay/live risk-state leak is closed. Duplicate-process protection is real and tested. **Still not GREEN** because: (1) nothing has traded end-to-end since the fixes landed — that specific proof remains open until real market hours produce a qualifying opportunity; (2) the original process-death cause is still unexplained; (3) the Java quant graduation work honestly found no module ready for promotion this pass, which is correct behavior, not a gap to force closed.

**No threshold was changed to increase trade frequency. None should be.**

---

## ADDENDUM (2026-08-25, later same day) — MARKET-OPEN READINESS + ACTIVE OPPORTUNITY PIPELINE HARDENING

Follow-on pass, scoped to a subset of a larger 12-phase request. Rather than attempt shallow, unverified builds across all 12 phases in one pass, this addendum covers the phases where a real, evidence-based defect was found and fixed, plus the read-only investigations that closed out cleanly. Phases requiring a genuinely new subsystem (a full funnel-telemetry schema rebuild, an active-universe priority redesign, a multi-stage SHADOW/PAPER graduation pipeline) were **not** attempted this pass — see "Not undertaken this pass" below.

### A1. Real defects found and fixed this pass

| # | Issue | Root cause | Fix | Evidence |
|---|---|---|---|---|
| 1 | `TradingReadinessGate.ts` reported `tradingReady: false` and "Technical engine not running" on **every** pre-market check | `IDLE_WAITING_FOR_MARKET_DATA` (the documented, expected pre-~50-tick state) was treated as a hard failure, not distinguished from a genuine `FAILED` state | Treat `IDLE_WAITING_FOR_MARKET_DATA` the same way `QuantEngine`'s "disabled by config" was already treated: counted toward `tradingReady`, shown as `notApplicable` (➖), never silently folded into "RUNNING" | SOURCE + TEST (2 new tests) + RUNTIME VERIFIED (confirmed live: `TRADING READY` flipped ❌→✅ after the fix, with Technical/Quant correctly shown as ➖ instead of ❌) |
| 2 | Two real `ERR_HTTP_HEADERS_SENT` crashes logged today (01:59:06Z, 01:59:22Z) at `GET /api/v2/market/sentiment-trend` | Same race as an earlier-fixed route: unbounded `db.select()`/`historicalDataGateway.ensureBars()` let server.ts's global 15s backstop respond first, then the handler's late resolution tried to write a second response | Bounded both calls with the existing `withTimeout()` helper (5s) + `res.headersSent` guards on every write, mirroring the already-fixed `/orchestration/capital` route | SOURCE + TEST VERIFIED (2 new tests reproducing the exact race deterministically) + DEPLOYED |
| 3 | `argus-cli.ts`'s `restart`/`start` could report "Engine started" while a stale process silently kept serving on the port | `waitForHealth()` only checked `h.ok`, which trivially succeeds against ANY process already listening — old or new | Capture whatever pid answers `/health` *before* the start attempt; require the post-start pid to differ from that snapshot before declaring success; otherwise report the exact stale pid and tell the operator to stop it manually | SOURCE VERIFIED + reproduced live **twice** in this session (once exposing a flawed first attempt at the fix — comparing against the spawned CLI wrapper's own pid, which is architecturally wrong for the tsx dev-mode process tree — then corrected and reproduced again showing the correct behavior: a real stale-process collision was detected and honestly reported instead of silently lying about success). No automated test — this file has no existing test harness (a CLI entrypoint with no exports); adding one would be a larger refactor than this fix warrants on its own, so this is NOT TESTED in the automated-suite sense, stated honestly rather than implied. |
| 4 | `MarketDataWorker.isConnected()` for the IBKR Gateway backend could report "connected" indefinitely after the real gateway socket disconnected | `isConnected()` returned `activeStreams.size > 0 || this.authenticated` — a purely local bookkeeping check. `this.authenticated` is **never set** for the IBKR path (only the Alpaca WebSocket handlers touch it), so this silently reduced to "has anything ever been subscribed", which stays true forever once nonzero, even after the underlying socket drops | Added a real `isConnected()` passthrough on `IBGatewaySocketAdapter` → the real `IbkrSocketSession.isConnected()` → wired through a new optional field on the `IbkrQuoteBridge` interface; `MarketDataWorker.isConnected()` now defers to it when present, falling back to the old heuristic only if a bridge doesn't provide it (back-compat) | SOURCE + TEST VERIFIED (3 new tests, including one that explicitly proves stale local bookkeeping no longer masks a real disconnect) + **RUNTIME VERIFIED live**: this fix directly changed what `./argus health`/`pipeline-ready`/`session-report` report right now — see A2 |

### A2. What the fix in #4 revealed (real, current, operationally significant)

With the fix deployed and a freshly restarted engine (PID 29484), `marketDataConnected` now honestly reports **`false`**, and `session-report` shows `Market Data: DEGRADED` — because the real IB Gateway desktop application is **not currently running/authenticated on this machine**. `./argus health` confirms directly: `ibkrPaths.gatewaySocket.status: OFFLINE`, `activeBroker.connection.authenticated: false`, `activeMarketDataLines: 0`.

This was previously **hidden**: before this fix, Argus's own local bookkeeping (`activeStreams.size > 0`, populated once at some earlier point) kept reporting "Market Data: READY"/`connected: true` indefinitely, regardless of the real socket state. The growing `MISSING_PRICE` count observed this session (36 → 83 → 128 across the pass) is consistent with this: last session's subscribe()-based fix (agents requesting coverage) is working correctly, but **subscribing cannot produce a tick when the underlying broker socket is not actually connected** — no code fix addresses that; it requires the operator to launch and authenticate IB Gateway Desktop (paper mode, socket port 4002, per the warning `IBGatewaySocketAdapter`/`IbkrSocketSession` already logs: "IB Gateway not detected... Launch IB Gateway Desktop in Paper mode").

**This is the single most actionable finding of this pass.** No further code change will move `MISSING_PRICE` or `Active Symbols` meaningfully until IB Gateway is actually running and authenticated on this machine (or the active broker is switched to Alpaca, which CLAUDE.md notes is "the only fully unattended broker").

### A3. Investigations closed without a code change (evidence-based, no fabrication)

- **Phase 8 (SELL/exit path):** Source-verified via `PortfolioMonitor.ts`'s `emitRiskExit()` — confirmed it emits SELL via the standard `eventBus.emitTradeIdea()` into the protected spine (ChiefTrader → RiskEngine → OMS), with gate 22 `sell_position_exists` correctly conditional on SELL only. No fake positions were created to test this, per the explicit constraint. **No fix needed — architecture already correct.**
- **Phase 7 (AI-provider-layer readiness):** Re-confirmed by source read that `aiProviderLayerNode()` already requires only `healthyCount > 0` (any healthy provider), not all — this part of Phase 7 was already correct before this pass; only the Technical/Quant Engine conflation (A1 #1) was a real defect.

### A4. Not undertaken this pass (honest scope statement)

The original 12-phase request also asked for: a full active-universe subscription priority redesign (Phase 3's "open positions > pending SELL > active ChiefTrader evaluation > high-confidence signals > core universe" tiering); a dedicated end-to-end funnel-telemetry schema distinct from the existing `tradingSessionReport.ts` counters; a formal multi-stage Java graduation pipeline (RESEARCH → BACKTEST → WALK_FORWARD → SHADOW → PAPER → LIVE_ELIGIBLE, vs. the existing two-stage RESEARCH/BACKTEST `GraduationHarness`); and new `PROCESS_HEARTBEAT`/`JAVA_PROCESS_STARTED` observability event types beyond what `sessionRecovery.ts` already captures. None of these were built this pass. Each is a real, bounded, multi-hour-or-more effort in its own right; attempting all of them in this single pass would have produced the kind of shallow, unverified work this codebase's own history explicitly warns against. They remain legitimate follow-up work, not silently dropped.

### A5. Validation for this addendum

- TypeScript: 363 test files, 2,368 tests, all passing (up from 2,365 after the MarketDataWorker fix's 3 new tests).
- `npx tsc --noEmit`: clean.
- `npm run build`: succeeds (`dist/server.cjs`, 2.1MB).
- Java: 332/332 tests, BUILD SUCCESS (re-run this pass, unchanged from the base report — no Java files touched in this addendum).
- Live restart performed multiple times during this pass; process-lifecycle issues encountered (stale/duplicate engine processes accumulating across repeated restart attempts) were caused by the *pre-existing* pid-file/port-collision gap that fix #3 above targets — not by anything newly broken. All stray processes were identified by command line before being stopped, and the final state is a single clean engine (PID 29484, confirmed via `tasklist`).

### A6. Updated tomorrow's readiness classification

Still **YELLOW**, but for a materially different reason than before this addendum. The pipeline-side defects (readiness false-negatives, a live crash bug, a silent-restart-failure bug, a stale-connection false-positive) are now fixed and verified. The dominant open item is no longer "unknown pipeline defects" — it is now a single, concrete, named operator action: **IB Gateway Desktop is not running/authenticated on this machine right now**, and Argus (correctly, honestly, as of this pass) reports that instead of masking it. Once IB Gateway is running and authenticated (or Alpaca is selected as the active broker), the pipeline fixes from both this session and the base report are in a position to be tested against real, organic ticks for the first time.
