# ARGUS Current-State Forensic Audit + Monday Paper-Readiness Determination

```
Audit date:          2026-09-06 (Sunday), ~22:20-22:55 UTC (18:20-18:55 ET)
Repository commit:   bafa98b (HEAD, main) — note: a real, undocumented fix
                      (DEF-27 graceful-shutdown worker ordering) exists ONLY in the
                      working tree, not in this or any commit — see §23.
Runtime PID:         42088
Runtime start:       2026-09-06T22:19:53.502Z
Runtime uptime:      ~35 min at audit time (this is a freshly-restarted instance)
Database:            data/argus.db, 5.06 GiB, WAL 4.45 MiB (not runaway)
Broker:               IBKR Gateway (Socket), ibkr_gateway, port 4002
Trading mode:        PAPER, TRADING_ENABLED, PAPER_TRADING_ONLY=true

FINAL PAPER READINESS: CONDITIONAL GO

P0 blockers:   0
P1 risks:      6 (enumerated in §26)
P2 issues:     4

Current architecture maturity:     engineering-strong, evidence-weak (see §33)
Quant maturity:                    indicators/strategies real; Java/TS parity NOT
                                    proven in production despite synthetic tests passing
Discovery maturity:                real, multi-source, working; ~1% broad-universe
                                    admission rate, ETF anchors structurally dominate
Reliability maturity:              real gaps: uncommitted crash fix, no supervisor,
                                    frequent historical unclean restarts
Self-improvement maturity:         Level 2 (real, DB-proven, code-verified as live vote
                                    input); Level 3 plausible, not independently proven

Key finding #1: RiskEngine has not evaluated a single order since 2026-09-01 (5+ days) —
  not because it's broken, but because ChiefTrader has approved zero ideas since
  2026-08-25 (100% rejection rate across 2,149 consensus rounds in the audit window).
  This is the system correctly refusing to trade on unproven signals (0/38
  agent/confidence-bucket combinations clear real statistical edge), not a malfunction.

Key finding #2: TRADE_IDEA_REJECTED has been 100% MISSING_PRICE, every single day, for
  the entire 7-day window with zero other reasons ever appearing. The 2026-09-03
  "NewsEngine missing-price fix" is real but narrow — it moved the failure from
  NewsAgent to FundamentalAgent/MacroAgent without reducing total daily volume.

Key finding #3: Real production Java/TypeScript indicator parity divergence (RSI/MACD),
  never previously measured against live data, shows 80% of 14,207 shadow-comparison
  events diverging >5% and 56% diverging >20% on identical inputs — contradicting the
  "PARITY_VERIFIED" status claimed from synthetic-fixture tests alone.

Required before Monday:
1. Decide what to do with the uncommitted DEF-27 graceful-shutdown fix (§23) — it only
   protects this specific running process; nothing else in the repo has it.
2. Re-check IBKR Gateway market-data authentication at/after Monday open — right now
   gatewaySocket.status is CONNECTED but marketDataConnected is false and
   activeMarketDataLines is 0; cause UNKNOWN, could be weekend-normal or a real problem.
3. Re-check AI provider health at Monday open — 0 of 10 providers were healthy at audit
   time (quota/rate-limit exhaustion), directly degrading MacroAgent/FundamentalAgent.

Safe to monitor tomorrow:
1. Whether IBKR error 354 (market-data-line-not-subscribed) recurs once real subscriptions
   resume — it was still occurring as recently as Saturday evening, unresolved.
2. Whether gate 25 (extended-hours) and TradePlanBuilder's live-idea emission actually
   fire for the first time under real Monday premarket conditions — both are
   code-sound and confirmed loaded in the live process, but have never executed.
3. MISSING_PRICE rejection rate and which agent causes it.

Do NOT change tomorrow:
1. ChiefTrader threshold (0.75) / min independent agents (2) — the 100% recent
   rejection rate is proven, evidence-based correct behavior given zero proven edge,
   not a bug to route around by loosening the gate.
2. Any RiskEngine gate, OMS logic, or capital-allocation limit.
3. Java quant formulas or the JMIG-001 feature pipeline — the parity divergence found
   in §17 needs root-causing, not silent threshold-widening to make it "pass."
```

---

## 1. Executive Summary

This audit was commissioned as a forensic, evidence-classified assessment of ARGUS's actual current state, not a code review based on assumptions or prior documentation. It was executed via direct code review, live HTTP queries against the running engine (PID 42088), and read-only SQL against `data/argus.db` — never a write operation, never a flag toggle, never an order placement, never a production-code change (the one hygiene fix mentioned in the accompanying summary — see the calling conversation — was a CLI-script correctness fix unrelated to trading behavior, made before this audit's own scope began, not during it).

**Bottom line:** ARGUS is a genuinely well-instrumented paper-trading system that is currently and correctly declining to trade because none of its agents have demonstrated statistically distinguishable edge. That is safe, disciplined, working-as-designed behavior — the audit found no evidence that any safety invariant (0.75 consensus threshold, 2-independent-agent floor, 25 RiskEngine gates, `PAPER_TRADING_ONLY`, `LIVE_NO_GO`) has been weakened, bypassed, or drifted. However, the audit also found several real, unresolved operational risks — an uncommitted crash fix, no active process supervisor, a persistent MISSING_PRICE rejection pattern, an unresolved IBKR market-data entitlement problem, and a materially diverging Java/TypeScript indicator-parity result that undercuts confidence in the ongoing Java migration's "parity verified" claims. None of these rise to a P0 (must-fix-before-Monday) blocker on their own, but together they justify **CONDITIONAL GO**, not an unqualified GO, and argue against leaving the system fully unattended through Monday's session.

---

## 2. Audit Methodology

Four evidence agents ran in parallel, each read-only, each required to tag every claim `VERIFIED_CODE` / `VERIFIED_RUNTIME` / `VERIFIED_DATABASE` / `INFERENCE` / `UNKNOWN` and to re-verify (not assume) every historical claim it was asked to check. All SQL access used a read-only-mode SQLite connection (`better-sqlite3` `{readonly:true}` or the `sqlite3` CLI's `-readonly`/`mode=ro`), never importing `src/server/db/index.ts` directly — that module runs migrations on import and this repo's own rule is "SQLite has one writer"; a second writer against the live engine's DB was avoided throughout. All HTTP access used the existing operator session cookie against the already-running engine; nothing was started, stopped, or restarted for this audit. The orchestrating session (this document's author) additionally verified core safety config directly from disk/live status before delegating, and cross-checked several agent findings against each other rather than accepting either in isolation.

**A note on the calendar, because it matters more than anything else in this audit:** the audit ran on **Sunday, 2026-09-06**. The last real trading day in the data is **Friday, 2026-09-04**; Saturday 09-05 and Sunday 09-06 are non-trading days by `SessionLifecycle`'s own live classification (`isTradingDay:false`, confirmed via `GET /api/v2/runtime/session-lifecycle`). A large fraction of "zero activity" findings below are fully and correctly explained by this, not by any defect — each is labeled accordingly rather than left ambiguous.

---

## 3. Current Architecture (summary — see `docs/architecture/ARGUS_ARCHITECTURE.md` for the full living reference)

Per the standing rule added to `CLAUDE.md` earlier this same day ("There is exactly one living architecture reference: `docs/architecture/ARGUS_ARCHITECTURE.md`"), this audit does **not** create a second, competing `ARGUS_CURRENT_ARCHITECTURE.md` file as the original mission brief requested — doing so would immediately violate the consolidation just performed. Instead: any finding below that reveals the *living* architecture doc is stale gets named explicitly as a required follow-up edit to that one file, not a new document.

The live decision spine, confirmed still exactly as documented, no drift found:

```
Alpaca/IBKR market data → MarketDataWorker
  → Discovery (curated 122-symbol list + broad-universe/movers screening, two PARALLEL
    mechanisms, not sequential — see §6)
  → Candidate ranking (ComposableRanking, real, code-verified to influence hot-swap
    subscription allocation)
  → Subscription (90-line IBKR cap, not the Alpaca-default 12)
  → Java Quant Core (indicators/regime, shadow-only) + TS quant (strategies, agents)
  → TRADE_IDEA_GENERATED → gateTradeIdea
  → ChiefTrader (weighted consensus, 0.75 threshold, 2-agent floor — VERIFIED intact)
  → RiskEngine (25 gates, fail-closed, serialized mutex — VERIFIED intact, but not
    reached by any idea since 2026-09-01)
  → OMS → BrokerManager → IBKR Gateway
  → Fill → Reconciliation → ReflectionEngine → agent_performance_stats
```

No side-channel to `emitTradeIdea`/`CHIEF_APPROVED_IDEA`/`.placeOrder(` was found outside this spine in any of the four agents' code reads (LangGraph, TradePlanBuilder, discovery, Java Quant Core all independently confirmed clean).

---

## 4. Process Topology

Single Node.js process, PID 42088, launched directly via `node --require tsx/preflight --import tsx scripts/argus-engine.ts` (confirmed via `Win32_Process` inspection — no wrapper, no child process, matching the earlier tsx-topology fix). Headless (`webUiEnabled:false`), API-only, `engineDaemon:true`. Sidecars: Chronos/FinBERT on :8008 (healthy, thread count flat at 44 across 3 checks), LangGraph research on :8090 (healthy, boundary-tested clean), Java Quant Core on :8085 (healthy). **No process supervisor is active** — see §23.

---

## 5. Trading Decision Spine — Traced

Traced via real DB rows, not assumption. A representative trace (`trace_AAPL_1788563374_66e3`) showed `event_traces` (5 rows: TRADE_IDEA_GENERATED → CHIEF_CONSENSUS_STARTED → CHIEF_CONSENSUS_COMPLETED → DESK_NO_TRADE → TRADE_LIFECYCLE) as a strict subset of `observability_events` (16 rows for the same trace, including AI_CALL×6, UI_UPDATE×4) — exactly the documented "narrow decision-lifecycle ledger vs. broad structured-log stream" relationship, no disagreement found. `transaction_traces.lifecycleStatus` was independently found to be a **poor** funnel-reconstruction signal (it's a mutable upsert keyed by traceId, not append-only) — the append-only `transactions`/`consensus_decisions` tables were used instead for all consensus-stage counts in this report, cross-checked and internally consistent.

---

## 6. Discovery

Two **parallel**, not sequential, discovery mechanisms:
- **Curated-list ranking**: fixed 122-symbol universe (`momentumScanUniverseSymbols`), continuously re-ranked — 213,610 ranking-cycle rows in the 5-day window (09-02 to 09-06).
- **Broad-universe/movers screening**: 797 admitted / 75,980 filtered in the same window — **~1.0% admission rate**. Filter reasons: `PRICE` 29,311, `DOLLAR_VOLUME` 12,198, `ADV` 5,598, `NO_SNAPSHOT_DATA` 822, `SPREAD` 611.
- The 2026-09-05 `broadUniverseAssetsFetchTimeoutMs` fix (15s→45s) is **RESOLVED** — live and historical data both show `error:null` and full ~8,464-asset fetches succeeding, zero `"This operation was aborted"` recurrences.
- `blendedHotSwapScore` (`ComposableRanking` → `OpportunityDiscovery.ts:174-182`) is **code-confirmed** to be the actual `scoreOf` callback driving `planSnapshotHotSwap()`'s eviction/promotion decisions — not merely computed and ignored.
- Rescue allocator: in the last 24h, new-acquisition demand (`NEW_DATA_ACQUISITION`) was denied 71.4% of the time vs. 0% for `RENEWAL` — matching the shape of the previously-documented 74.7% finding almost exactly. **Classification: UNCHANGED** — the 2026-09-05 capacity raise (3→6, reserved 1→2) mitigated but did not eliminate new-acquisition starvation; this is disclosed, expected residual behavior per `CLAUDE.md`'s own framing, not a new regression.

---

## 7. Market Data

Active broker `ibkr_gateway`, confirmed live. **A genuine, currently-open inconsistency**: `gatewaySocket.status:"CONNECTED"` but `marketDataConnected:false`, `authenticated:false`, `activeMarketDataLines:0` — all 10 currently-subscribed slots show `tickCount:0`. Cause `UNKNOWN` — could be normal weekend dormancy (IBKR paper accounts commonly don't stream off-hours) or a real bridge problem; not resolvable from static evidence, needs a Monday-open re-check. **IBKR error 354** (market-data-line-not-subscribed) is confirmed **UNCHANGED**, not resolved — 191 occurrences in the last 24h alone across nearly every actively-tracked individual equity, most recently Saturday evening (i.e., the pipeline attempts real subscriptions and gets rejected even on non-trading days). This will very likely recur the moment Monday's real subscription cycle begins.

---

## 8. Java Quant Core

Java module: 111 main source files, 81 test files, 344/344 tests passing, `BUILD SUCCESS` (re-verified this session). `QUANT_JAVA_CORE_ENABLED=true` live; `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` absent (defaults false) — confirmed no Java-sourced signal has ever reached `emitTradeIdea`. See §17 for the parity-divergence finding, which is the single most important correction this audit makes to the existing Java-migration narrative.

---

## 9. TypeScript Quant Duplication

No new duplication found beyond what `docs/architecture/ARGUS_ARCHITECTURE.md` § Java Quant Core already discloses (RSI/MACD/Bollinger/ATR/rolling-stats all exist in both languages as an intentional, shadow-compared parity pair — not an accidental fork). The five CORE strategies (Momentum Breakout, Pullback Continuation, Mean Reversion, Trend Following, Range Reversion) remain TS-authoritative in production; their Java ports exist and pass synthetic-fixture parity tests but are not live-wired. No change to this status found.

## 10. Strategies — status table

| Strategy | TS impl | Java impl | Production caller | Duplicate? | Status |
|---|---|---|---|---|---|
| Momentum Breakout | `quant/strategies/momentumBreakout.ts` | `strategy/core/MomentumBreakout.java` | TS | Parity pair (intentional) | TS live, Java shadow-tested only |
| Pullback Continuation | `pullbackContinuation.ts` | `PullbackContinuation.java` | TS | Parity pair | Same |
| Mean Reversion | `meanReversion.ts` | `MeanReversion.java` | TS | Parity pair | Same |
| Trend Following | `trendFollowing.ts` | `TrendFollowing.java` | TS | Parity pair | Same |
| Range Reversion | `rangeReversion.ts` | `RangeReversion.java` | TS | Parity pair | Same |
| Wyckoff | none | none | — | N/A | **Not started** — confirmed zero code anywhere in either language (re-verified this session, unchanged from this morning's Phase 0 inventory) |

## 11. Wyckoff Status

**Not started.** Re-confirmed via a fresh repo-wide case-insensitive grep for `wyckoff` across `quant-core-java/src/main` and `src/server` — zero hits. No regression from this morning's dedicated Phase 0 inventory.

---

## 12. Agents

| Agent | Enabled | Live state (audit time) | `currentWeight` | Edge status |
|---|---|---|---|---|
| TechnicalAgent | true | IDLE, no ticks this boot | 0.949 | `CALIBRATION_FAILED` |
| NewsAgent | true | RUNNING (healthy at query time) | 0.946 | `CALIBRATION_FAILED` |
| FundamentalAgent | true | RUNNING | 0.2 (`INSUFFICIENT_EVIDENCE`) | insufficient sample |
| MacroAgent | true | **FAILED** (Mistral 429, live) | 0.1 floor, stale since 2026-08-10 | insufficient sample |
| KronosEngine | true | IDLE, no ticks | 1.031 | `CALIBRATION_FAILED` |
| QuantEngine | true | RUNNING | 0.897 | `CALIBRATION_FAILED` |
| TradePlanBuilder | true | IDLE (once-daily, PRE_MARKET only) | n/a | never emitted (see §18) |

**0 of 38** agent/confidence-bucket combinations clear real statistical edge (Wilson lower bound never exceeds 0.5 anywhere) — matches `CLAUDE.md`'s own "8/100 trading-edge score" framing exactly. `agent_performance_stats.currentWeight` values are confirmed (`ChiefTraderAgent.ts` code trace) to be the actual live vote weights, not a display-only stat — real, differentiated, non-default. **MacroAgent and DiagAgent's calibration stats are frozen since 2026-08-10** (~4 weeks) while every other agent updates continuously — flagged as an open, unexplained gap, not diagnosed.

**Live AI provider health at audit time: 0 of 10 healthy** (`QUOTA_EXCEEDED` ×5, `PROVIDER_UNAVAILABLE` ×2, `ACCOUNT_SUSPENDED` ×1, `RATE_LIMITED` ×1, `MODEL_UNAVAILABLE` ×1). This is a present-tense, live condition, directly causing MacroAgent's current FAILED state.

---

## 13. ChiefTrader

Config confirmed unchanged: `consensusApprovalThreshold: 0.75`, `minIndependentAgreeingAgents: 2` (`VERIFIED_CODE`, `config/tradingSafety.json`). Real consensus-approval math verified internally consistent by direct query: zero rows exist where `consensus_score >= consensus_threshold AND lifecycle_status='NO_CONSENSUS'` — the approval boundary has no bypass or off-by-one bug.

**2,149 consensus rounds across the three real trading days in the audit window (09-02/03/04). Zero approved. 100% rejection rate.** Breakdown:
- 57.7% — fewer than 2 independent agreeing agents (structural, cannot pass by construction)
- 24.2% — best side was HOLD (no directional agreement reached at all)
- 18.1% — multiple agents agreed but weighted confidence never cleared 0.75
- Within the confidence-clearing failures: **17 rounds had weighted confidence ≥ 0.75 but only 1 independent agent** — the exact historically-cited pattern, confirmed **UNCHANGED**, still occurring in the most recent window (all-time: 74 such rows, 100% of all high-confidence rejections have exactly 1 agreeing agent, never more).

This is the single largest attrition point in the entire funnel (§16), and it is expected, evidence-consistent behavior given zero agents have proven statistical edge — not a configuration issue, not a data issue, not a consensus-math bug.

---

## 14. RiskEngine

25 gates confirmed (`config/riskGateOrder.json`, `RiskEngine.ts` calls `recordGate()` for all 25 unconditionally in evaluation order). Fail-closed behavior verified in code for the highest-risk gates (`invalid_account_equity`, `market_hours`, `data_freshness`, `price_validity`) — real branches, not comment claims. Gate-ordering invariant validated against real production data: `same_symbol_cooldown` failed 53/53 times as the reported rejection reason with zero pre-emption by an earlier gate in the same window; `sufficient_size` failed 120 times but never once appears as the reported reason, fully explained by an earlier gate (`order_notional_cap`) already failing first in every case. **RiskEngine has not been invoked — organically or via replay — since 2026-09-01T12:35:06Z**, a direct, mechanical consequence of §13's 100% ChiefTrader rejection rate, not a defect in RiskEngine itself.

---

## 15. OMS / 16. Broker

No code path found where OMS or any broker adapter can be reached other than through RiskEngine approval (unchanged from prior audits this session). Zero orders submitted since 2026-09-01 (0 `trades`, 0 `fills` — direct consequence of §13/§14, not evidence of an OMS defect).

---

## 17. Premarket / Extended Hours — including the Java/TS parity finding

**Premarket/TradePlan persistence**: real, working daily cadence (3 PRIMARY/5 BACKUP/15 WATCHLIST) through 2026-09-04, with 7,173 real revalidation rows (739 REVALIDATED/152 INVALIDATED/6,282 DOWNGRADED) confirming the revalidation loop genuinely runs repeatedly through the session, not once. Only one plan has ever reached `VALID` status in this DB's history (QQQ, 2026-09-03) — the shadow-tracking mechanism postdates that transition (added 2026-09-05) and is therefore correctly unproven, not broken.

**TradePlanBuilder live emission**: confirmed loaded in the live process (`tradePlanIdeasEnabled:true`, `tradePlanBuilderAgentEnabled:true`, both via direct runtime echo, not `.env` inference). **Zero real emissions, ever.** Root-caused, not guessed: the flag went live Saturday 2026-09-05, and both calendar days since (Sat/Sun) are non-trading days — `emitTradePlanIdea()` (which only runs once per day, inside the `PRE_MARKET` branch) has had **zero opportunities to execute** under the enabled flag. Monday's premarket cycle is the first real test.

**Extended-hours gate 25**: confirmed loaded live (`extendedHoursExecutionEnabled:true` via direct runtime echo). Code reviewed sound (fail-closed on stale quote/wide spread/missing liquidity/over-notional). **Zero real executions of this gate exist in the database, in either direction** — it was added 2026-09-05 and no risk evaluation of any kind has run since 2026-09-01 (predating the gate). Sound but entirely unproven at runtime; Monday is the first real test.

**Java/TypeScript quant parity — the most important correction this audit makes.** A real, previously-unmeasured-against-production-data check: 14,207 `QUANT_CORE_PARITY_DIVERGENCE` shadow-comparison events exist (2026-08-24 → 09-04). Of these, **80% (11,398) show at least one indicator field (RSI/MACD/MACD-signal) diverging by more than 5% between the TS and Java implementations on identical inputs, and 56% (7,920) diverge by more than 20%.** This is not floating-point noise — it is a real, frequent, large computational disagreement between the two supposedly-parity-verified engines, occurring continuously in real production shadow traffic, most heavily on QQQ/SPY/GLD (the anchor symbols with the most tick volume). Separately, the *regime*-feature-pipeline parity check added yesterday (`compareRegimeParity`, `QUANT_CORE_REGIME_PARITY_DIVERGENCE`) has never fired at all (0 events) — it hasn't run long enough in live conditions yet to have an opinion either way. **This means: the "PARITY_VERIFIED" status this session's own `ARGUS_ARCHITECTURE.md` currently claims for RSI/MACD/Bollinger is proven true only against synthetic fixtures — real production data shows it does not hold.** This is exactly the kind of false-confidence gap §32 of the original mission asked to be surfaced, not minimized, and it materially affects how much trust should be placed in any future Java-authoritative cutover for these indicators specifically.

---

## 18. AI/ML

Chronos: `threadCount` flat at 44 across 3 checks 75s apart; `committedMemoryMb` drifted ~1.3MB/150s (noise, not the historical leak pattern) — `RESOLVED`, with the honest caveat that only a few low-traffic hours have been observed since restart, not a sustained high-volume trading day. `ThreadPoolExecutor(max_workers=1)` confirmed still 1 in the code actually present on disk. LangGraph: healthy, boundary-tested clean (zero RiskEngine/OMS/BrokerManager/ChiefTrader/`.placeOrder(`/`emitTradeIdea(` references anywhere in its Node or Python files, confirmed by the existing `langGraphArchitectureBoundary.test.ts`, which asserts non-vacuous — `toBeGreaterThan(0)` guards, not an empty pattern list).

## 19. LangGraph

See §18 — remains advisory/research-only, structurally incapable of reaching the trading spine.

## 20. Database

5.06 GiB file, 4.45 MiB WAL (healthy, not runaway). Real row counts: `observability_events` 969,442; `event_traces` 561,459; `agent_reasoning_logs` 120,872; `quant_assessments` 40,155; `transaction_traces` 86,746; `candidate_rankings` 585,998. Zero recurrence of the previously-observed `SqliteError: disk I/O error`/`SQLITE_CORRUPT` class found in current logs.

## 21. Observability

`TRADE_IDEA_REJECTED` persists real, populated payloads (`symbol`, `agent`). **`AI_PROVIDERS_EXHAUSTED` persists with an empty payload (`{}`)** — the event fires correctly but carries no diagnostic detail, a real (minor) gap relative to the richer sibling event. `event_traces` vs `observability_events`: no disagreement found on the one trace spot-checked (per the audit brief's own "spot-check, not exhaustive" scope) — `observability_events` consistently the broader superset, exactly as documented.

## 22. Reliability

See headline in §0. Additionally: 78 total `UNCLEAN_SHUTDOWN_DETECTED` events all-time, 3-9 per day across the audit window, tracking roughly 1:1 with restart frequency (7-11 distinct process sessions per day in the window). Given DEF-26's own documented root cause (`SIGTERM` never invoking this app's handler on this host) and zero positive "clean shutdown" log evidence anywhere in the window, the honest read is **most or all recent restarts were hard kills or crashes, not the graceful path** — marked `UNKNOWN, leaning unclean`, not asserted as fixed. This is a real, concerning operational pattern independent of the specific DEF-27 fix discussed next.

## 23. The uncommitted DEF-27 fix (flagged separately — this is the single most actionable finding in the audit)

`src/server/core/gracefulShutdown.ts` and its test file are modified in the working tree (`git status`: `M`), containing the fix for a crash reproduced live on 2026-09-05 (interval-driven workers writing to SQLite after `sqliteDb.close()`, cascading into `globalErrorHandlers.ts`'s storm-detection exit). **This fix has never been committed** — `git log` on the file shows the last real commit is unrelated, older work. It **is** live in the currently-running process, because this instance runs `tsx` interpreting the working-tree `.ts` source directly rather than a compiled build. **It would not survive** a `git reset`/`checkout`/`clean`, a fresh clone, or any other checkout of this exact repository state. This needs an explicit operator decision before Monday — commit it, or knowingly accept that only this specific running process is protected.

## 24. Memory

Node RSS 577.2MB (vs. 2048MB warning / 3584MB critical — well within NORMAL, 28% of warning). Chronos committed ~1817MB (vs. 6144MB warning / 12288MB critical — 30% of warning). No memory concern found.

## 25. Recent Paper Sessions — table

| Metric | 09-02 (Wed) | 09-03 (Thu) | 09-04 (Fri) | 09-05 (Sat) | 09-06 (Sun, partial) |
|---|---|---|---|---|---|
| Ranking cycles | 50,508 | 69,174 | 77,924 | 15,272 | 732 |
| Trade ideas emitted | 1,393 | 2,478 | 1,947 | 0 | 0 |
| TRADE_IDEA_REJECTED (100% MISSING_PRICE) | 344 | 366 | 100 | 741 | 54+ |
| ChiefTrader rounds | 551 | 919 | 679 | 0 | 0 |
| — approved | 0 | 0 | 0 | 0 | 0 |
| Risk assessments | 0 | 0 | 0 | 0 | 0 |
| Trades / fills | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| Unclean-shutdown detections logged | 3 | 9 | 5 | 9 | 1 |

## 26. Failure Funnel — real counts, 5-day window (09-02 → 09-06)

```
Broad-universe screened:        76,777    →  admitted: 797 (1.0%)
Subscription requests:          16,768
Rescue granted / denied:        1,664 / 365
Quant evaluated:                10,757    →  strategy signal: 769 (7.1%)
Agent predictions:               7,742
Trade idea emitted:              5,818    (09-02/03/04 only; 0 on the weekend)
  ↓ rejected pre-ChiefTrader:    1,605     (100% MISSING_PRICE, every day, no exceptions)
ChiefTrader consensus rounds:    2,149
  ↓ APPROVED:                       0     ← largest single attrition point, by far
Risk assessments:                   0
OMS orders / fills:               0 / 0
```

**The single largest attrition stage is trade-idea-emitted → ChiefTrader-approved** (100% loss, 2,149 of 2,149), not the ~1% broad-universe admission rate — the curated 122-symbol list alone produced 5,818 real trade ideas, all of which died at the same one stage.

## 27. Self-Improvement

Level 2, confirmed with real DB evidence and code-traced consumption (`currentWeight` values are real, differentiated across agents, and are the literal weights `ChiefTraderAgent.resolveWeight()` uses on every live consensus cycle — not a display-only stat). Level 3 ("a weight change measurably flipped a later decision") is plausible given the mechanism is structurally live, but was not independently proven by tracing one specific `traceId` — classified `INFERENCE`, not `VERIFIED`.

## 28. Safety Audit

All required invariants confirmed intact, `VERIFIED_CODE`/`VERIFIED_RUNTIME`:
```
PAPER_TRADING_ONLY=true                 ✓ (.env, live)
LIVE_NO_GO                              ✓ (live /api/v2/runtime/status)
ChiefTrader threshold = 0.75            ✓ (config/tradingSafety.json)
min independent agents = 2              ✓ (same file)
25 RiskEngine gates, all fail-closed    ✓ (config/riskGateOrder.json + code read)
QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED      absent (defaults false) ✓
Stale-data / duplicate-signal / capital-allocation / emergency-stop / broker safety
                                         no drift found in any of the four agents' reads
```
No safety discrepancy found anywhere in this audit.

---

## 29. Tomorrow (Monday 2026-09-07) Paper Readiness

## GATE TABLE

| Gate | Status | Evidence | Severity |
|---|---|---|---|
| Paper-only | PASS | `.env`, live status | — |
| LIVE_NO_GO | PASS | live status | — |
| IBKR paper connection | **CONDITIONAL** | socket CONNECTED, marketDataConnected FALSE, cause unknown | P1 |
| Market data | **CONDITIONAL** | 0 live ticks at audit time; IBKR 354 recurring | P1 |
| Discovery | PASS | multi-source, working, ~1% broad admission (expected) | — |
| Ranking | PASS | code-confirmed to influence allocation | — |
| Subscription allocator | PASS | 90-line cap live, rescue split working as documented | — |
| Fresh data | **CONDITIONAL** | tied to Market data above | P1 |
| Java Quant Core | PASS (shadow-only) | 344/344 tests, but see parity finding | P1 (parity) |
| Strategies | PASS | TS-authoritative, unchanged | — |
| Agents | **CONDITIONAL** | 0/10 AI providers healthy at audit time | P1 |
| ChiefTrader | PASS | thresholds intact, math internally consistent | — |
| RiskEngine | PASS (untested recently) | 25 gates sound; not exercised since 09-01 | — |
| OMS | PASS | no bypass found | — |
| Reconciliation | Not directly audited this pass | — | UNKNOWN |
| Database | PASS | healthy size/WAL, no I/O errors | — |
| Node memory | PASS | 577MB / 2048MB warning | — |
| Java memory | PASS | no concern found | — |
| Python memory | PASS | Chronos 1817MB / 6144MB warning | — |
| Chronos threads | PASS | flat at 44 | — |
| AI providers | **FAIL (live, transient)** | 0/10 healthy at audit time | P1 |
| Heartbeat | PASS | advancing normally | — |
| Crash recovery | **CONDITIONAL** | DEF-27 fix real but uncommitted | P1 |
| Shutdown detection | PASS (detection works) | but underlying shutdowns are mostly unclean | P2 |
| Extended-hours | PASS (code), UNPROVEN (runtime) | never executed yet | — |
| Premarket | PASS | real, working daily cadence through 09-04 | — |
| TradePlanBuilder | PASS (code), UNPROVEN (runtime) | zero opportunities yet, not a bug | — |
| Observability | PASS (minor gap) | `AI_PROVIDERS_EXHAUSTED` empty payload | P2 |
| Emergency stop | PASS | no drift found | — |

## 30. P0/P1/P2/P3 Findings

**P0 (blocks Monday): none found.**

**P1 (high risk, may run with monitoring):**
1. Uncommitted DEF-27 graceful-shutdown fix — real, live in this process only, not durable (§23).
2. No active process supervisor — a crash requires manual operator restart (§22).
3. IBKR market-data inconsistency (`gatewaySocket CONNECTED` / `marketDataConnected false`) — cause unknown, needs Monday-open check (§7).
4. IBKR error 354 unresolved — will likely recur once Monday's real subscriptions begin (§7).
5. 0/10 AI providers healthy at audit time — degrades MacroAgent/FundamentalAgent quality; may partially self-resolve as rate limits/quotas reset overnight, but unconfirmed (§12).
6. Java/TypeScript indicator-parity divergence (80% >5%, 56% >20%) — undermines confidence in Java-migration "parity verified" claims; does not currently affect live trading since Java remains shadow-only (§17).

**P2 (should fix soon, not blocking):**
1. `AI_PROVIDERS_EXHAUSTED` events persist with empty payload — minor observability gap (§21).
2. MacroAgent/DiagAgent calibration stats frozen since 2026-08-10 (~4 weeks) — unexplained, not diagnosed (§12).
3. `MISSING_PRICE` remains 100% of all pre-ChiefTrader rejections, having moved from NewsAgent to FundamentalAgent/MacroAgent rather than reducing (§26).
4. Historical unclean-shutdown pattern (78 all-time, 3-9/day in-window) suggests real, ongoing operational instability beyond the one DEF-27 fix (§22).

**P3:** documentation drift already corrected in the same edit as this audit (see the calling conversation's earlier work today); no new P3 items found beyond what's already tracked.

## 31. Required Actions Before Tomorrow

1. Decide on the uncommitted DEF-27 fix (§23) — commit it, or explicitly accept the risk.
2. None of the remaining P1s are actionable "before Monday" fixes in the sense of code changes — they are monitoring/verification items (see §32).

## 32. Monitoring Plan (Monday)

Before open: verify PID/uptime, `LIVE_NO_GO`, `TRADING_ENABLED`, IBKR Gateway auth state, Chronos/Java/LangGraph health, DB reachability, memory levels, heartbeat freshness.
At open: watch for the first real market-data ticks landing (resolves the §7 ambiguity), watch for IBKR 354 recurrence, watch AI-provider health recovery, watch for TradePlanBuilder's first real PRE_MARKET emission attempt and extended-hours gate 25's first real evaluation (both currently unproven, not currently broken).
Every 15 minutes: Node RSS, Chronos committed memory/threads, stale-data rate, rescue denial rate, AI-provider health, engine restart count, MISSING_PRICE rate and which agent causes it.

## 33. Stop Conditions

Use the existing configured thresholds (`config/observability.json`): Node RSS >3584MB, Chronos committed >12288MB. Additional: any reconciliation mismatch, any live-configuration drift (`PAPER_TRADING_ONLY` flipping, `LIVE_ARM` appearing), any RiskEngine failure/exception, more than 2 unexpected engine restarts in a session, any broker-mode mismatch.

## 34. Do NOT Touch Tomorrow

ChiefTrader threshold/independence floor, all 25 RiskEngine gates, OMS, capital allocation, broker safety config, strategy parameters, Java quant formulas (the parity divergence in §17 needs root-causing, not threshold-widening), discovery safety filters, stale-data gates. The 100% recent rejection rate is proven correct behavior, not evidence the gate is miscalibrated.

## 35. Architecture Quality Assessment

| Dimension | Score | Evidence for scores below 4 |
|---|---|---|
| Architecture | 4 | Clean spine, no bypass found anywhere audited |
| Quantitative correctness | 2 | Real production parity divergence (§17) undermines confidence in claimed correctness |
| Data quality | 3 | Real IBKR entitlement gap (§7), MISSING_PRICE unresolved (§26) |
| Discovery | 4 | Multi-source, working, real evidence of allocation influence |
| Agent architecture | 3 | Real, but 0/38 buckets show proven edge; AI-provider dependency is fragile |
| Consensus | 4 | Math internally consistent, no bypass, thresholds intact |
| Risk | 4 | 25 gates sound, fail-closed, unbypassed — untested recently only because nothing clears consensus |
| OMS | 4 | No bypass found |
| Reliability | 2 | Uncommitted crash fix, no supervisor, frequent historical unclean restarts |
| Observability | 3 | One empty-payload event type; otherwise strong |
| Persistence | 4 | Healthy DB, no I/O errors, real WAL discipline |
| AI/ML | 3 | Chronos fix holds; LangGraph clean; but 0/10 providers healthy at audit time |
| Self-improvement | 3 | Real Level 2, Level 3 plausible but unproven |
| Testing | 4 | 456/456 TS, 344/344 Java — but synthetic-fixture parity ≠ production parity (§17) |
| Operational readiness | 3 | CONDITIONAL GO, not GO, per this audit |

## 36. Final Verdict

```
FINAL VERDICT: CONDITIONAL GO

No safety invariant is violated, weakened, or bypassed anywhere this audit looked. The
system's zero-trade streak since 2026-09-01 is proven, evidence-based correct behavior —
ChiefTrader is refusing to approve ideas because no agent has statistically distinguishable
edge (0/38 buckets), not because of a bug. That is exactly the behavior a disciplined paper
system should exhibit and should NOT be "fixed" by loosening any gate.

The CONDITIONAL qualifier exists because of six real, currently-open P1 risks (§30) — most
importantly an uncommitted crash-recovery fix that only protects this specific running
process, no active process supervisor, an unresolved IBKR market-data entitlement problem,
and a material, previously-unmeasured Java/TypeScript parity divergence that should reset
confidence in this migration's "verified" claims back to "verified against synthetic
fixtures only." None of these block a supervised Monday session. All of them argue against
running the system fully unattended.
```
