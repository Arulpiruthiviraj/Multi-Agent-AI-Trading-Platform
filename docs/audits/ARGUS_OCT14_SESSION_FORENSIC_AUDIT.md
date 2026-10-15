# Argus October 14, 2026 — Session Forensic Audit

Status vocabulary: **CONFIRMED DEFECT** · **CONFIRMED EXPECTED BEHAVIOR** · **PROBABLE CAUSE** · **NOT_PROVEN** · ZERO (instrumented, count is zero) · NOT INSTRUMENTED · UNKNOWN.
Read-only audit. No production code, configuration, database, thresholds or authorization was changed. Nothing in this document contains credentials.

## 0. Provenance

| Item | Value |
|---|---|
| Production release during the whole session | `3a5eacdce865024fdae5973fb29c829879b740d4` (`git rev-parse HEAD` in the production checkout, verified after close; no deployment happened — a deploy attempt of the repair candidate was refused by the permission classifier and not attempted again) |
| Evidence source | Online-backup snapshot (SQLite backup API, read-only source) of `data/argus.db`, taken 2026-10-14 20:07:16Z–20:13:32Z (16:07–16:13 ET), 24,852,389,888 bytes, after the close. File: `J/db_backup/argus_oct14_postclose_*.db` (not committed — 24.8 GB) |
| Earlier snapshot | 15:07 ET backup (pre-change), same method |
| Session window analysed | 2026-10-14T13:30:00Z–20:00:00Z (09:30–16:00 America/New_York; Toronto is the same offset in October) |
| Observability events in window | 2,021,503 (`observability_events`), first 13:30:00.032Z, last 19:59:59.999Z |
| Extraction scripts | `docs/audits/oct14_evidence/*.js` (read-only, bounded, run offline against the snapshot); outputs `oct14_*.json` in the same folder |
| Independent market data | IBKR connector read-only price history (15-minute bars, SMART, "Last") for 5 symbols; Alpha Vantage daily series (latest row available 2026-10-13 — Oct 14 not yet published, **not usable for Oct 14**) |
| Production load during analysis | none: all queries ran in separate processes against the snapshot; the live engine was not queried by any report command after the 12:48 incident |

Evidence-handling incident (disclosed): to recover disk space (the system drive had 4.3 GB free, see §9) I deleted ~18,000 stale test-artifact files (`argus_*`, `argus-*` older than 90 minutes) from the Windows temp folder. That included the **SQLite databases of earlier synthetic certification sessions** (3a5eacdc exact-SHA sessions and candidate 5e36e191 sessions). Their JSON result artifacts and the pre-open evidence bundle remain; oracle re-evaluation of those specific sessions is no longer possible. No production data or audit evidence of Oct 14 was touched.

## 1. Authoritative timeline (ET = UTC−4)

| Time (ET) | Event | Source |
|---|---|---|
| 07:10:14 | Engine core booted (pid 19784), headless daemon, PAPER, IBKR Gateway socket | `argus-cli status` (`coreBootedAt 11:10:14Z`) |
| 07:44–09:14 | Pre-open verification: reconciliation MATCH, flat, 90/90 market-data lines | pre-open bundle |
| 09:30:04 | `SESSION_LIFECYCLE_STATE_CHANGED` | `observability_events` |
| 09:30–12:48 | Normal operation: discovery cycles ≈ every 30–60 s, 731 `OPPORTUNITY_SCAN_COMPLETED` all session | events |
| 12:48:17–12:48:40 | Operator read-only report burst (`trading-funnel`, `quant-readiness`, `strategy-readiness`, `missed-opportunities`, `discovery-challengers`, then `rescue-outcomes` …) issued from this analysis session | CLI outputs; the first four completed |
| ~12:48:35 | Last engine heartbeat; `/health` stops answering | watchdog log (`heartbeatAgeMs 58,332` at 16:49:33Z) |
| 12:49:00–12:54:30 | **Zero observability events for 5.5 minutes** (the only gap ≥ 2 minutes in the session) | `quietGaps` query |
| 12:49:33–12:53:59 | Watchdog `SUSPECT` ticks 2/10 … 9/10 | `data/logs/watchdog.log` |
| 12:54:37 | `FROZEN_CONFIRMED` → watchdog ran `argus-cli start` (no `--enable-trading`) | watchdog log |
| 12:54:50 | `UNCLEAN_SHUTDOWN_DETECTED` (successor boot) | events |
| 12:55:16 / 12:56:01 | `TRADING_STATE_CHANGED` ×2 (boot pause, then operator resume through the normal path) | events; `argus-cli resume` |
| 12:56→16:00 | Trading enabled, reconciliation MATCH every ≈5 min (76 `RECONCILIATION_MATCH` in window) | events |
| 16:00 | Session end. No position, no order, no fill. | trades table |

Version continuity: **CONFIRMED** — the production checkout stayed on 3a5eacdc; the watchdog restart re-ran the same checkout.

Freeze cause: **PROBABLE CAUSE** — `GET /api/v2/observability/rescue-outcomes` issued three synchronous SQLite queries per rescue grant on the engine event loop (≈14.5k grants in the 24 h window) and was not under `guardHeavyReport`. Timing and code match; it was **not** reproduced and the exact query count/duration was not captured (NOT_PROVEN). The candidate repair batches the queries (910 → ≤ 8 in the regression) and guards both heavy routes. I caused the trigger; no position was exposed.

## 2. Actual trading outcome (independent records)

| Check | Result | Status |
|---|---|---|
| `trades` rows with timestamp ≥ 2026-10-14 | 0 | CONFIRMED |
| `risk_assessments` created on Oct 14 | 0 rows (RiskEngine never reached) | CONFIRMED |
| `CHIEF_APPROVED_IDEA`, `RISK_ASSESSMENT_STARTED`, `ORDER_SUBMITTED` event types | absent in 2.02M events | CONFIRMED ZERO |
| Broker positions / open orders (CLI, after close) | none / none; reconciliation MATCH | CONFIRMED |
| Realized/unrealized P&L, commissions | none (no trades) | CONFIRMED |
| Broker vs Argus discrepancy | none observed (MATCH ×76) | CONFIRMED |

**Argus genuinely made zero trades today.** Protective-exit execution was therefore **not exercised** today (no held position); it stays NOT validated by this session.

## 3. Decision funnel (counts are events; unique symbols given separately)

| Stage | Events | Unique symbols | Main reasons / notes |
|---|---|---|---|
| Tradeable universe | NOT INSTRUMENTED as a count | — | Alpaca tradable-asset funnel; only candidate-level events exist |
| Market snapshots observed (candidate-level) | 15,415 filtered + 6,046 admitted | ≥ 1,066 filtered, 443 admitted | `PRICE_SNAPSHOT_REQUESTED` 16,956 / 162 |
| Discovery filtered | 15,415 | 1,066 | PRICE 6,105 (241), DOLLAR_VOLUME 3,313 (128), RANK_CAP 3,219 (574), NO_SNAPSHOT_DATA 1,386 (118), SPREAD 942 (55), ADV_DATA_UNAVAILABLE 305 (219), ADV_BELOW_FLOOR 145 (34) |
| Discovery admitted | 6,046 | 443 | sources BROAD_UNIVERSE, MARKET_MOVER, NEWS |
| Subscription requested | 2,311 (`WATCHLIST_SUBSCRIBE_REQUESTED`) | 157 | |
| Promotions (won a hot-swap) | 381 | 144 | 360 broad-universe challenger, 21 momentum-universe |
| Not promoted | 10,591 | 188 | SWAP_CAP_REACHED 4,348 (157), OTHER 5,790 (151, **unexplained label**), INCUMBENT_NOT_EVICTABLE 453 (85) |
| Evictions | 452 | 149 | all "lowest-ranked non-protected dynamic symbol … to stay within cap 90" |
| Subscription outcomes | 19,287 | 165 | |
| Technical analyses completed | 86,600 | 163 | |
| Kronos forecasts completed | 37,011 | 163 | `KRONOS_UNAVAILABLE` 14 |
| Quant bridge calls (Java) | 1,072,727 | 164 | outcome fields not extractable by my keys: UNKNOWN |
| Quant assessments completed | 20,003 | 162 | |
| Quant authorization checks | 1,758 (`STRATEGY_AUTHORIZATION_CHECKED`) | 28 | ≈1,660 `NO_LIFECYCLE_RECORD` (4,980 events ÷ 3 event types per check — PROBABLE), rest `STRATEGY_RETIRED` (PULLBACK_CONTINUATION). By strategy: RANGE_REVERSION ≈ 4,380 events, MOMENTUM_BREAKOUT 516, TREND_FOLLOWING 84; 19 symbols |
| Trade ideas generated | 43,904 | 162 | `IDEA_RATE_LIMITED` 20,362 / 163 |
| Chief consensus rounds | 27,191 | 162 | see §4 |
| Consensus approvals | **0** | 0 | |
| Risk evaluations / approvals / rejections | **0 / 0 / 0** | 0 | ZERO |
| OMS submissions, broker fills | **0 / 0** | 0 | ZERO |

## 4. Why zero trades — numerical explanation

All 27,191 consensus rounds required **2 independent evidence groups** and a **0.75** STRONG bar (unchanged, correct).

| Fact (from `CONSENSUS_TERMINAL_REASON` payloads) | Number |
|---|---|
| Terminal reasons | CONFIDENCE_BELOW_STRONG 26,937 (162 symbols); AGENT_DATA_UNAVAILABLE 132 (56); MODERATE_REJECT_CALIBRATION 67 (6); MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE 45 (37); AGENT_HOLD 8 (7); INSUFFICIENT_AGENT_PARTICIPATION 2 (2) |
| Independent evidence groups per round | 0 → 140; **1 → 24,850 (91.4 %)**; 2 → 2,198; 3 → 3 |
| Rounds where ≥ 2 groups agreed on BUY | 1,826 (≈ 6.7 %), on SELL 411; symbols with any 2-group agreement 147 |
| Final confidence | max **0.773**; ≥ 0.75: **2 rounds**; ≥ 0.60: 114; 0.5–0.6: 16,401 |
| Agents that participated | Kronos 24,865 (SELL 20,284 / BUY 4,581), Macro 16,338 (**HOLD 16,294 = 99.7 %**), Technical 10,534 (BUY 10,513), JavaCoreEnsemble 501 (**SELL only**), ConsensusDebate 6. **QuantEngine: 0** |
| Best 2-group BUY rounds | TechnicalAgent BUY 0.71 + KronosEngine BUY 0.50 → final ≈ 0.54; best 0.625 (ISRG, `MODERATE_REJECT_CALIBRATION`) |

Reading (each statement labelled):
* **CONFIRMED EXPECTED BEHAVIOR** — the two directional agents that were available cannot produce a 0.75 consensus on real data. KronosEngine's calibrated historical reliability is **0.5016 on 1,526 samples** (a coin flip by its own record); TechnicalAgent's BUY confidence is 0.71–0.77 but has `INSUFFICIENT_CALIBRATION_DATA` (N = 1). A weighted average of 0.71 and 0.50 is ≈ 0.54. Abstaining at 0.54 is the specified behavior. Lowering 0.75 is explicitly out of scope.
* **CONFIRMED** — QuantEngine contributed **no votes**: 20 of 21 strategies have no lifecycle record (terminally `NOT_AUTHORIZED / NO_LIFECYCLE_RECORD`, by the deliberate 2026-10-07/09 design) and PULLBACK_CONTINUATION is `RETIRED`. Quant did evaluate (20,003 assessments / 162 symbols) and strategies fired on 19 symbols; those ideas were dropped before consensus.
* **PROBABLE CAUSE (capability, not a code defect)** — consensus is structurally starved of a third evidence family: Macro is a placeholder `HOLD` 99.7 % of the time (it needs a working LLM provider; 9 of 10 providers were unavailable: quota, suspended, rate-limited, timeout), News/Fundamental contributed nothing to consensus rounds, Java ensemble is SELL-only (long-only system, no position to sell). Which of these is "broken service" versus "no conviction" cannot be separated from these records alone: **NOT_PROVEN**.
* **CONFIRMED** — AGENT_DATA_UNAVAILABLE (132 rounds, 56 symbols) is real missing-data, 0.5 % of rounds; not the dominant cause.
* Not a bug: legitimate consensus rejections are not labelled as defects. What the data does show is that the **0.75 bar was reached by real agents in 2 of 27,191 rounds**, so the zero-trade outcome is mostly a conviction/evidence-availability problem, not a discovery bug.

## 5. Quant authorization (requested questions)

* Strategies today: 21 (5 CORE + 16 experimental), all implemented/enabled/reachable (`strategy-readiness`). Lifecycle rows: **1** (`PULLBACK_CONTINUATION`, RETIRED, 2026-08-31, effective N ≈ 22). `quant-readiness`: AUTHORIZED 0, NOT_ELIGIBLE 1, NOT_AUTHORIZED 20.
* Evaluations blocked: ≈ 1,660 authorization checks on 19 symbols (PROBABLE; see §3) — **valid signals were discarded before consensus by design**.
* Defect or evidence gap? **CONFIRMED EXPECTED BEHAVIOR with an operational gap**: the resolver works as specified; the gap is that no operator decision was ever recorded (the system documents an `UNTESTED` baseline as the minimum). An `UNTESTED` row grants **no authority**; it only returns the idea to the normal consensus path (still 0.75 / 2 groups).
* Can a strategy legitimately enter controlled PAPER before 30 closed trades? **Not via authority.** The bridge ladder (`certificationBridge.ts`) targets `ACTIVE_EXPLORATION` only when quarantine + backtest + OOS + walk-forward + robustness evidence all pass (paper evidence may still be accumulating); `VALIDATED` additionally needs the full organic paper floor (30 trades, 10 sessions, 30 days, PF ≥ 1.2). The repo records walk-forward/OOS for checked combos as failed and CORE strategies as untested on real next-bar data. So: **no CORE strategy qualifies today (NOT_PROVEN that none ever could — the research evidence was not produced)**. Not a deadlock: the missing input is research evidence, not a missing code path.
* Authorization for the owner-approved baseline (CORE 5, `UNTESTED`) exists only in the unmerged candidate branch and was **not applied**.

## 6. Discovery, capacity, rescue (full-session evolution)

* Subscription state during the session: 90/90 lines occupied, 87 dynamic + 3 core; the snapshot at 08:17 ET showed 84 rescue holders.
* **Rescue grants on Oct 14: 14,538, of which 14,536 are `ROUTINE_RECOVERY` / `RENEWAL` of an already-subscribed symbol (159 symbols), 2 `NEWS_CATALYST`.** Zero grants were new data acquisitions. 1,737 further renewals were denied by the 12-extension cap; 46 routine and 5 news-catalyst acquisition requests were denied `AT_CAPACITY_NO_SAFE_EVICTION` (all after 14:00 ET). **CONFIRMED** — rescue state in production was almost entirely routine renewals of symbols that were already streaming (FundamentalAgent/MacroAgent reads), which the repair candidate turns into no-ops.
* How much did that block promotions? Not-promoted events: SWAP_CAP_REACHED 4,348 (the one-swap-per-cycle budget), OTHER 5,790, **INCUMBENT_NOT_EVICTABLE 453 (4.3 % of 10,591)**. So the rescue pinning is **a real but minor direct blocker today (≈ 4 %)**; the dominant direct limiter is the swap budget; the largest bucket (`OTHER`, 55 %) has an unexplained label (**NOT_PROVEN** — needs the scorer/edge/truncation branch breakdown). I earlier hypothesized pinning as the main constraint; this evidence does not support that.
* Quick evictions (CCI pattern): 381 promotions, 26 evicted < 60 s later (6.8 %); `isWithinDynamicDwell()` released protection once 10 ticks arrived. **CONFIRMED DEFECT** (root cause read from code and matched to events). Promotion → first technical analysis: p50 1.4 s, p90 98 s, p99 36 min; **4 delays > 10 min (CIEN 72 min, TXN 38.5, CVNA 36.5, TXN 36.4), all four had an eviction between promotion and analysis**. Impact small today (4 of 381 promotions) but it is the same mechanism that delayed NVAX/CCI on Oct 9.
* Candidate ranking: see Report 2 (traps on this day were penny/low-price names filtered by PRICE, not ranked).

## 7. Market data, scheduler, protection, services

* Market data: 90 allocated/90 receiving; 3 premarket-stale at 09:14, all fresh afterwards; one contract error (`BRK.B`, IBKR code 200) cleared during the session — **NOT_PROVEN** whether the resolution path is fixed. No `MARKET_DATA_DISCONNECTED` events.
* Quant bridge (Java): CONNECTED the whole session per `health`; 1.07 M bridge calls / 164 symbols; the call-outcome payload fields could not be summarized (UNKNOWN).
* AI: `AI_DEGRADED`, 1 of 10 providers healthy at several samples (5 `QUOTA_EXCEEDED`, 1 `ACCOUNT_SUSPENDED`, rate-limited, timeout); no `AI_CALL_FAILED` events (type absent). Whether degraded AI caused retry storms: **NOT_PROVEN**; engine memory/heap and RSS were stable (RSS ≈ 1.3 GB, heap cycling 150–520 MB).
* Protection: monitor heartbeat cannot be evaluated (`PORTFOLIO_DECISION_RECORDED` zero: flat all day). **Live protective execution NOT exercised today.**
* Freeze impact on opportunities: 5.5 minutes of zero activity plus ~1.5 minutes of restart; promotions resumed immediately. Whether any specific candidate was lost in that window is **UNKNOWN** (not enumerated); with 0 trades all day and 381 promotions in 6.5 hours, the expected loss is small but not quantified.

## 8. Where things disappear (summary)

1. Universe/price screens remove the penny/micro-cap/warrant movers (correct: PRICE 6,105, DOLLAR_VOLUME 3,313, SPREAD 942).
2. Ranking/swap budget removes ≈ 4.3 k promotion attempts (SWAP_CAP_REACHED) and an unexplained 5.8 k (`OTHER`).
3. Quick eviction/dwell defect removes a few promotions before analysis.
4. Quant lifecycle removes every Quant idea (≈ 1,660 checks).
5. Consensus (0.75, 2 groups) removes everything else; max real final confidence 0.773.
6. Risk, OMS, broker: never reached.

## 9. Operational risks found (not trading logic)

* **Disk**: system drive had **4.3 GB free** while the production DB is 24.8 GB (2.0 M observability events per session, 14-day retention configured) and test suites left ~40 GB of temp databases. A full disk would break SQLite writes for the production engine. Cleared to 44 GB free; root cause (no test-artifact cleanup, large retained DB) remains. Severity P1.
* `rescue-outcomes`-class reports are unbounded on the engine loop (P0 tooling, repaired in candidate; 36 other observability routes remain un-audited).

## 10. Required final answers

1. **Zero trades genuinely?** Yes — trades, risk_assessments, fills, positions, orders all empty/none; CONFIRMED.
2. **Meaningful opportunities in the supported universe?** NOT_PROVEN as a complete count (no independent full-universe intraday dataset). Argus-observed admitted movers with |move vs open| ≥ 6.2 %: 60 (5 up, 55 down). Independently verified: 5 (Report 2).
3. **Discovered?** Of the 5 verified positive movers, 5 were seen by discovery; 4 were promoted/subscribed/analyzed.
4. **Never observed?** None of the 5. Overall: UNKNOWN.
5. **Discovered but never subscribed?** IBRX (admitted 18:11Z only; before that RANK_CAP).
6. **Subscribed but never evaluated by Quant?** 0 of the 4 (all had first assessment within ≈ 1–2 min of promotion); 4 of 381 promotions had >10-minute delays (eviction in between).
7. **Blocked by Quant lifecycle?** ≈ 1,660 authorization checks on 19 symbols; none of the 5 verified movers was among them.
8. **Failed consensus legitimately?** Essentially all others (26,937 CONFIDENCE_BELOW_STRONG): legitimate per rules.
9. **Affected by unavailable data/agents?** 132 rounds / 56 symbols AGENT_DATA_UNAVAILABLE; Macro placeholder-HOLD 16,294 rounds; Quant removed entirely.
10. **Blocked by Risk?** 0 (never reached).
11. **Missed because of proven software defects?** Directly: a handful (quick-eviction delays ≤ 4 delayed promotions; rescue pinning ≈ 4 % of non-promotions). No opportunity is proven lost solely to a defect.
12. **Specific stocks / first blocking stage:** Report 2.
13. **Rescue pinning and capacity contribution:** ≈ 4.3 % of non-promotion events (INCUMBENT_NOT_EVICTABLE); swap budget 41 %; OTHER 55 % (unexplained).
14. **Did the freeze cause missed opportunities?** UNKNOWN; 5.5 min of inactivity; no position was exposed.
15. **Would the repair candidate behave differently?** Yes in three measurable ways (14,536 routine renewals become no-ops; dwell lasts 60 s; held positions are never evicted); the *outcome* difference (recall, latency) is NOT_PROVEN — no controlled replay comparison has been run.
16. **Why synthetic certification stayed green:** Report 3.
17. **Top defects to fix before the next session:** Report 4 (P0/P1 list).
18. **New synthetic tests:** Report 3/4.
19. **Proven about discover → BUY → monitor → SELL:** mechanics proven synthetically (restart 14/14, oracles, soak) but with uncalibrated agents and discovery disabled; **not proven on real data**.
20. **NOT_PROVEN:** real-agent ability to reach 0.75; any real BUY→SELL; independent complete opportunity benchmark; NVAX admission-to-analysis gap root cause; the `OTHER` non-promotion bucket; AI-degradation side effects; freeze reproduction.
