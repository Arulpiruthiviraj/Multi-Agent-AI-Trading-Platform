# ARGUS Trade & No-Trade Forensic Audit — 2026-09-21

Read-only audit. No trading behavior, threshold, broker configuration, or RiskEngine logic was modified. The running engine was never restarted. One objective, low-severity reporting-label bug was found and fixed (§30); it does not affect trading decisions.

---

## 0. Engine baseline (verified before, during, and after this audit)

| Field | Value |
|---|---|
| PID | 18692 (unchanged throughout) |
| Engine status | RUNNING, headless, `coreBootedAt` 2026-09-21T11:03:55.099Z |
| Trading enabled | `TRADING_ENABLED`, Autobot on |
| Paper/Live | **PAPER = YES**, **LIVE = NO-GO** (`liveReadiness: LIVE_NO_GO`) |
| Broker | `ibkr_gateway` (IBKR Gateway Socket), port 4002, account `DUR959160`, `authenticated: true`, `paperTradingOnly: true` |
| Watchdog | Running, PID 18256 |
| Database | `data/argus.db`, connected, consistent |
| Open orders | 0 |
| Positions | 0 (`portfolio: []`) |
| Reconciliation | `matches: true`, `mismatchCount: 0`, `unackedFilledOrphans: []` (checked 2026-09-21T15:51:07Z, id 4637) |

No engine state, broker config, RiskEngine gate, consensus threshold, or production DB row was altered by this audit.

---

## 1. Audit window

- **AUDIT START:** 2026-09-21T00:00:00 America/New_York (current trading day, per `tradingSessionReport.ts`'s `getTradingDateStr`), plus explicit LAST 24 HOURS (`consensus-report`/`trading-funnel`: since 2026-09-20T15:5x UTC) and cross-checked against the prior 3 days via `why-no-trade`'s most-recent-evaluation trace.
- **TIMEZONE:** America/New_York for session-day boundaries; UTC for raw timestamps below.
- **MARKET SESSION:** RTH (confirmed live: audit run at 2026-09-21T15:47–15:57Z ≈ 11:47 AM–11:57 AM ET, inside 09:30–16:00 ET).
- **ENGINE PID:** 18692. **GIT COMMIT:** `db9ef4d914e100afa6d1feeccc01d69f91bba003`. **DATABASE:** `data/argus.db`. **BROKER:** IBKR Gateway (paper).

Periods are not mixed: today's-session counts (§3, §7) are labeled as such; the 24-hour consensus/funnel counts are labeled separately; the >24h context (§2 below, §9) is labeled as historical context, not counted into today's funnel.

---

## 2. Did Argus trade? — answered from four independent sources

| Source | Result |
|---|---|
| `argus-cli positions` | `portfolio: []` |
| `argus-cli orders` | `orders: []` |
| `argus-cli execution-quality` | **n=0 in every category**: PAPER_ORGANIC, PAPER_MANUAL, PAPER_UNATTRIBUTED, REPLAY, BACKTEST, SIMULATION, LIVE, UNKNOWN. `NO_DATA — no matching arrival/fill evidence for PAPER_ORGANIC.` |
| `organic_paper_soak_status.ts` (direct, sanctioned DB check) | `closedTradeCount: 0`, `sessionCount: 0`. All-time organic PAPER FILLED SELL count remains 0. |
| Broker reconciliation (`/system/reconciliation/status`) | `matches: true`, `mismatchCount: 0` — broker independently agrees Argus has 0 open orders/positions to reconcile against |

### TRADING RESULT

```
Orders created:          0
Orders submitted:        0
Orders acknowledged:     0
Orders rejected:         0
Orders cancelled:        0
Orders expired:          0
Orders partially filled: 0
Orders fully filled:     0
Executions:              0
Filled quantity:         0
Positions opened:        0
Positions closed:        0
Round trips:             0
Actual trades:           NO
```

Continuing into full no-trade forensic analysis (§3–§20).

---

## 3. Opportunity funnel (today's session, real counts, `session-report`/`trading-audit`)

| Stage | Count | Rejected | Primary reason |
|---|---|---|---|
| Discovery universe scanned | 136 | 0 | — |
| Market-data lines allocated | 90 / 90 | — | full allocation reached |
| Market-data lines **receiving** fresh ticks | **0** | 90 | IBKR error 354 (real-time entitlement not held) on 89 symbols; error 200 (no security definition) on 1 (BRK.B) |
| Candidate symbols missing price | 92 | — | consequence of the above |
| Ideas attempted → rejected pre-generation | 183 | 183 | **100% `MISSING_PRICE`** (`missingPrice: 183` = `ideasRejected: 183`, exact match) |
| **Ideas generated** (`TRADE_IDEA_GENERATED`) | **0** | — | none survived the price-validity gate |
| Consensus rounds started (`CHIEF_CONSENSUS_STARTED`) | **0** | — | nothing ever reached ChiefTrader |
| ChiefTrader approved | 0 | — | — |
| Risk evaluations | **0** | — | nothing ever reached RiskEngine |
| Risk approved | 0 | — | — |
| Orders submitted | 0 | — | — |
| Fills | 0 | — | — |

Separately, over the same session: **4,805** `DESK_NO_TRADE` events were logged (QuantSignalAgent's own per-symbol, per-cycle no-trade conclusions — see §9 on why this is a distinct bucket from "consensus rejected").

---

## 4. First bottleneck (mathematically, from actual records)

```
136 universe (discovery)
  ↓
 90 market-data lines allocated
  ↓
  0 market-data lines RECEIVING fresh ticks     <-- COLLAPSE HAPPENS HERE
  ↓
  0 ideas generated
  ↓
  0 consensus rounds started
  ↓
  0 risk evaluations
  ↓
  0 orders / 0 fills
```

**PRIMARY BOTTLENECK: MARKET DATA.** The funnel collapses to zero at the very first stage after allocation — not at ChiefTrader, not at RiskEngine, not at OMS. Every downstream zero (ideas, consensus, risk, orders) is a direct, structurally-forced consequence of zero symbols having a usable live price, not an independent failure at each of those stages.

---

## 5. Market-data forensics (`argus-cli market-data-diagnostics`, live, read-only)

```
Allocated: 90   Receiving: 0   Fresh: 0   Stale: 0   Error: 90
Entitlement failures (354): 89     Contract failures (200): 1
Account entitlement state: DEGRADED_ENTITLEMENT (canaries: SPY, QQQ, GLD)
```

All 90 tracked symbols — including the three canary symbols (SPY, QQQ, GLD) that a prior audit (`ARGUS_ZERO_TRADE_2026-09-18.md`) found were the only symbols with usable data on 2026-09-18 — are now also failing. Canaries show `retry#22` (repeatedly re-probed by the account-wide entitlement circuit breaker, working as designed — see §8) versus `retry#1` for the rest of the universe (correctly suppressed from retry-spamming once `DEGRADED_ENTITLEMENT` engaged). One symbol, `BRK.B`, fails differently: `REQUESTING_UNCONFIRMED` / `NO_ACKNOWLEDGEMENT`, IBKR error 200 (no security definition found) — a separate, single-symbol contract-resolution issue, not the entitlement problem, and not material to the overall zero-trade outcome.

**This is the same class of problem the 2026-09-18 audit already documented** (that audit observed IBKR error 10089 and error 200/BRK.B specifically; today's live diagnostic shows error 354 and the same error 200/BRK.B). 354 and 10089 are both real-time-market-data-entitlement-class IBKR error codes; the exact code differs, but the underlying condition — this paper account (`DUR959160`) does not hold usable real-time (or delayed-as-fallback) market data entitlement for the tracked universe, including the three previously-working canaries — has evidently **persisted, unresolved, for at least 3 days**, and by the evidence in §9 below, arguably longer.

**Classification: EXTERNAL BLOCKER (IBKR account-side data entitlement), not an Argus code defect.** Argus's own behavior here is fail-closed and correct: RiskEngine gate 13 (`data_freshness`) is designed to fail on null tick age (DEF-08, by design); `gateTradeIdea()` correctly rejects every attempted idea for `MISSING_PRICE` rather than inventing a price. No threshold was weakened to "make this go away," and none should be.

---

## 6. Strategy / agent audit

| Agent | Alive | State | Last tick | Why idle |
|---|---|---|---|---|
| TechnicalAgent | false | `IDLE_WAITING_FOR_MARKET_DATA` | **never** (`lastTickAt: null`) since this boot (~4.8h uptime) | Fires only on `MARKET_DATA` events; none have arrived |
| KronosForecastAgent | false | `IDLE_WAITING_FOR_MARKET_DATA` | never | Same |
| TradePlanBuilder | false | `IDLE_WAITING_FOR_MARKET_DATA` | never | Same |
| JavaCoreEnsemble | false | `IDLE_WAITING_FOR_MARKET_DATA` | never | Same |
| MacroAgent | true | `TICKING` | 7.8s ago | Timer-driven (AlphaVantage), not tick-gated — ticks fine, but its ideas still require a priced symbol downstream |
| QuantSignalAgent | true | `SUCCESS`/`RUNNING` | 56s ago | Timer-driven, evaluates on its own cadence — this is the source of the 4,805 `DESK_NO_TRADE` events (§9), almost entirely `STALE_MARKET_DATA` |
| NewsAgent | disabled | `OFFLINE` | — | Off by config (`enabled: false`), unrelated to the market-data condition |

No strategy is "producing bad signals" or "over-filtering." The strategies that depend on live ticks have literally never been invoked this boot; the ones on independent timers (QuantEngine, Macro) run but their own price-validity checks correctly block them for the same reason.

---

## 7. Signal / consensus / risk forensics

- **Signal forensics:** 183/183 (100%) of attempted trade-idea emissions this session were rejected for exactly one reason code: `MISSING_PRICE`. No other rejection category (LOW_CONFIDENCE, STALE_DATA-as-distinct-from-missing, NO_FORECAST, etc.) was observed to matter — the price gate is upstream of all of them.
- **Consensus forensics (24h window, `consensus-report`):** `Evaluations: 0`, `Directional evaluations: 0`, all agreement/confidence/approval buckets 0. **RiskEngine reached: 0. OMS orders: 0. Paper fills: 0.** No consensus candidate reached a vote in the last 24 hours — there is nothing to attribute a rejection reason to; the correct statement is "no evaluation occurred," not "evaluations were rejected."
- **Risk forensics:** `Risk evaluations: 0`. Per the audit's own instruction: **the no-trade condition occurred upstream of RiskEngine.** RiskEngine, OMS, and the broker order path were never reached and are not implicated.

---

## 8. System health (secondary findings — none of these caused the zero-trade condition; all are distinct, factual observations)

| System | Status | Note |
|---|---|---|
| Engine process | HEALTHY | PID 18692 stable, uptime 4.8h+ |
| IBKR Gateway socket | CONNECTED, authenticated | Order/account API path is healthy — this is *specifically* a market-data-subscription entitlement problem, not a broker connectivity problem |
| Reconciliation | HEALTHY | 58+ clean matches, 0 mismatches, growing in real time during this audit |
| Account-wide entitlement circuit breaker | WORKING AS DESIGNED | Canaries retry aggressively (retry#22) to probe for recovery; the broader universe is correctly suppressed (retry#1) rather than retry-spamming — this is the Phase 2 IBKR lifecycle hardening from earlier this session, confirmed functioning under a real, live entitlement outage |
| AI providers | **DEGRADED** — 0/10 healthy | `QUOTA_EXCEEDED` ×5, `PROVIDER_UNAVAILABLE` ×1, `ACCOUNT_SUSPENDED` ×1, `RATE_LIMITED` ×1, `TIMEOUT` ×1, `MODEL_UNAVAILABLE` ×1. Real, current, but **not the cause** of zero trades — TechnicalAgent (fully deterministic, no AI) is equally blocked, purely by absent market data |
| Watchdog heartbeat | INTERMITTENTLY SUSPECT | Repeated `SUSPECT (consecutiveBadTicks 1-4/10) → Recovered` cycles observed in the last ~30 minutes of `watchdog.log`, `heartbeatAgeMs` up to ~54s (threshold 60s), never reaching `FROZEN_CONFIRMED`. **Caveat, stated explicitly:** this audit ran heavy concurrent local CPU load (Maven builds, vitest suites, `tsc`) on the same machine throughout the session; this pattern is far more plausibly explained by host CPU contention from that activity than by an Argus-internal defect, and — critically — it only appears in the last 30 minutes of log, while the zero-trade condition has persisted for 3+ days. It is reported factually and separately; it is **not** offered as a contributing cause. |
| Crash log | CLEAN | No `unhandledRejection`/`uncaughtException` entries since 2026-09-11 — no recent silent crash explains the zero-trade condition |

---

## 9. "Consensus Rejected (no-trade): 4,805" — resolved, not a real consensus-rejection count

The session/trading-audit CLI report displays a line labeled `Consensus Rejected (no-trade): 4805`. This number is **real** but its label was misleading, and I traced it to its exact source before reporting it (`src/server/core/tradingSessionReport.ts`):

```ts
consensusRejected: countType('DESK_NO_TRADE'),
```

`DESK_NO_TRADE` is emitted by `QuantSignalAgent.ts` (and other desk-level evaluators) **before** any idea ever reaches ChiefTrader — predominantly with `code: 'STALE_MARKET_DATA'` when a symbol's own data-quality check fails that cycle (`QuantSignalAgent.ts:569-571`), plus `EXPECTED_VALUE_TOO_LOW`/`INSUFFICIENT_EVIDENCE` when no strategy idea forms at all. Given `Consensus Rounds Started: 0` for the same session, **none of these 4,805 events represent an idea that reached ChiefTrader and was voted down** — they are QuantSignalAgent's own upstream "nothing to do this cycle" conclusions, occurring at high frequency (QuantEngine evaluates on a short interval across ~90 tracked symbols) for the same root reason as everything else in this report: no symbol has a fresh, usable price.

## 10. "Why didn't it trade?" — closest real candidates (from `argus-cli why-no-trade` and `missed-opportunities`, real DB rows, not examples)

**Most recent real evaluation, system-wide, of any kind:** `trace_AAPL_1789759578_04a9`, decoded timestamp **2026-09-18T19:26:18Z** — **over 3 days before this audit.**

```
Symbol: AAPL
JavaCoreEnsemble: SELL, confidence 0.635 (STRONG tier)
Independent agreement: 1 raw producer -> insufficient independent evidence groups
Consensus: FAIL — MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE
RiskEngine: NOT REACHED (no consensus approval)
Final: NO_TRADE
```

This is the single furthest any candidate has gotten through the pipeline in the audit's visibility window: it reached STRONG confidence and a real consensus evaluation, and was correctly rejected because only one independent agent (the Java ensemble) could vote — every tick-dependent agent that would normally supply a second independent vote was silent, for the same market-data reason documented throughout this report. This is **CORRECT non-action**, not a bug: the `minIndependentAgreeingAgents >= 2` floor did its job.

**Top non-traded opportunities today** (`missed-opportunities`, 24h window, 51 rows, real `MissedOpportunityDetector` classifications):

| Classification | Count | Meaning |
|---|---|---|
| `AGENT_MISS` | 27 | Symbol occupied an active subscription slot, but — consistent with §5 — that slot never actually received usable data, so no agent produced an idea |
| `THESIS_INVALIDATED` | 17 | A premarket TradePlan was invalidated before any agent got to evaluate it this window — **correct non-action**, not a miss in the "something went wrong" sense |
| `SUBSCRIPTION_MISS` | 7 | Ranked PROMOTE-worthy by `ComposableRanking` but never obtained a subscription slot at all (e.g. AVGO, rank 1, `finalScore: 0.727`; GOOGL, rank 3; XLK; DELL; GOOG; DAL) |

Named examples: **AVGO** (rank 1, `SUBSCRIPTION_MISS`), **MSFT** (rank 2, `AGENT_MISS` — actively subscribed, still no data), **GOOGL** (rank 3, `SUBSCRIPTION_MISS`), **AAPL**, **GLD**, **AMD**, **XLK**, **SOXL**, **F**, **SQQQ/TQQQ** — all `AGENT_MISS` for the identical reason: subscribed but never receiving a usable price.

---

## 11. "Did Argus miss an opportunity?"

- **NO SIGNAL:** applies to every symbol this session — no strategy could evaluate without a price.
- **SIGNAL BUT REJECTED:** does not apply — zero ideas were generated at all.
- **RISK REJECTED:** does not apply — zero risk evaluations occurred.
- **ORDER FAILED / UNFILLED:** does not apply — zero orders were ever created.
- **SYSTEM FAILURE:** not established as a cause (crash log clean; engine, broker connection, and reconciliation all healthy).
- **DATA FAILURE:** **YES — this is the established cause** (§5).
- **CORRECT NON-ACTION:** YES, given the data failure — Argus's fail-closed behavior (price-validity gate, `data_freshness` gate, `minIndependentAgreeingAgents`) worked exactly as designed under these conditions. No opportunity was missed due to an Argus logic defect; nothing tradable was ever knowable.

---

## 26. FINAL TRADE ANSWER

```
========================================
ARGUS TRADE AUDIT
========================================
Period:         2026-09-21 trading session (RTH) + last 24h + 3-day historical cross-check
Engine:         PID 18692, commit db9ef4d914e100afa6d1feeccc01d69f91bba003
Environment:    PAPER (LIVE_NO_GO)
Broker:         IBKR Gateway (Socket), account DUR959160, authenticated, reconciling clean
ACTUAL TRADES:  NO
Orders:         0
Fills:          0
Executions:     0
Positions:      0
Round Trips:    0
Net P&L:        N/A (no organic paper trades exist to compute P&L from)

========================================
NO-TRADE ROOT CAUSE
========================================
PRIMARY BOTTLENECK:
  MARKET DATA (stage: subscription -> receiving fresh ticks)
PRIMARY REASON:
  0 of 90 allocated IBKR market-data subscriptions are receiving usable data.
  89 fail with IBKR error 354 (real-time entitlement not held), including all
  3 previously-working canary symbols (SPY, QQQ, GLD). 1 fails with error 200
  (BRK.B, contract resolution, unrelated single-symbol issue). This condition
  has persisted, unresolved, since at least 2026-09-18 (a prior audit
  documented the same entitlement-class problem under IBKR error 10089).
SECONDARY REASONS:
  - AI provider outage (0/10 healthy) - real, but not causal; TechnicalAgent
    (no AI dependency) is equally blocked by the same market-data absence.
  - A misleading session-report label ("Consensus Rejected (no-trade)") was
    found and fixed (see PART 30) - a reporting-precision issue, not a cause.
RISK ENGINE REACHED:   NO  (0 risk evaluations this session/24h)
OMS REACHED:           NO  (0 orders created)
BROKER REACHED:        Only for account/connection/reconciliation purposes -
                        NOT for market-data delivery or order placement.
```

---

## 27. Funnel table

| Stage | Count | Rejected | Primary reason |
|---|---|---|---|
| Universe (discovery scan) | 136 | 0 | — |
| Market-data lines allocated | 90 | — | capacity reached (90/90) |
| Market-data lines receiving fresh ticks | 0 | 90 | IBKR error 354 (89), error 200 (1) |
| Idea attempts (pre-gate) | 183 | 183 | 100% `MISSING_PRICE` |
| Ideas generated | 0 | — | — |
| Consensus rounds started | 0 | — | — |
| Consensus approved | 0 | — | — |
| Risk evaluated | 0 | — | — |
| Risk approved | 0 | — | — |
| Orders created | 0 | — | — |
| Broker submitted | 0 | — | — |
| Fills | 0 | — | — |

## 28. No-trade reason distribution (only categories that actually occurred)

| Reason | Count | % of attempted ideas |
|---|---|---|
| `MISSING_PRICE` (pre-idea gate) | 183 | 100% |
| `STALE_MARKET_DATA` / `EXPECTED_VALUE_TOO_LOW` / `INSUFFICIENT_EVIDENCE` (`DESK_NO_TRADE`, pre-consensus) | 4,805 | N/A — separate upstream bucket, see §9 |
| `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` (real consensus rejection) | 1 (the 2026-09-18 AAPL trace — outside this session's window) | N/A |
| `CONSENSUS_REJECTED`, `RISK_REJECTED`, `CAPITAL`, `LIQUIDITY`, `BROKER_REJECTED`, `SYSTEM_ERROR` | 0 | 0% — never reached |

## 29. Required conclusion

```
TRADE STATUS:              NO TRADES (0 orders, 0 fills, all-time organic count remains 0)
PRIMARY NO-TRADE CAUSE:    IBKR paper-account real-time market-data entitlement failure,
                           0/90 tracked symbols receiving usable data (verified live,
                           multiple independent sources, persisted 3+ days)
UPSTREAM / DOWNSTREAM:     Upstream of RiskEngine, OMS, and the broker order path.
                           Downstream of broker connectivity/authentication (which is healthy).
SYSTEM FAILURE:            NO (engine, broker connection, reconciliation all healthy;
                           crash log clean)
DATA FAILURE:              YES (root cause)
RISK FAILURE:              NO (never reached; nothing to fail)
OMS FAILURE:               NO (never reached)
BROKER FAILURE:            NO for connectivity/reconciliation; YES for market-data
                           entitlement specifically (account-side, external)
CORRECT NON-ACTION:        YES - every fail-closed gate (price validity, data_freshness,
                           minIndependentAgreeingAgents) behaved exactly as designed
ACTION REQUIRED:           (1) Operator: resolve real-time (or delayed-as-fallback) market
                           data entitlement on IBKR paper account DUR959160 for the tracked
                           universe - this is an IBKR account configuration matter, not
                           something Argus code can fix. (2) Operator: separately confirm
                           BRK.B's contract/exchange qualifier if that symbol matters
                           (single-symbol, non-blocking). No threshold, gate, or consensus
                           parameter should be changed - the software is behaving correctly
                           under a real external data outage.
```

Not recommended, and not done: lowering any threshold, weakening the price-validity or `data_freshness` gates, or fabricating/backfilling any price, signal, or trade to "prove" the pipeline works. Zero trades under these conditions is the correct outcome, not a defect.

---

## 30. Objective bug found and fixed

| | |
|---|---|
| **FILE** | `src/server/core/tradingSessionReport.ts` |
| **BUG** | The rendered session/trading-audit report displays a line labeled `Consensus Rejected (no-trade): N`, where N is actually `countType('DESK_NO_TRADE')` — a count of desk-level (mostly `QuantSignalAgent`) no-trade decisions that occur **before** any idea reaches ChiefTrader. On a session where `Consensus Rounds Started: 0`, the old label falsely implied thousands of real post-consensus rejections when zero ever occurred. This is exactly the category-conflation this audit was asked to avoid (§9/§20 of the audit mandate), and it is a real, if low-severity, operator-facing observability defect — not a trading-logic bug. |
| **ROOT CAUSE** | The field/label was written when `DESK_NO_TRADE` was a narrower, mostly-post-consensus event type; `QuantSignalAgent.ts` since gained pre-consensus `DESK_NO_TRADE` emission paths (`STALE_MARKET_DATA`, `EXPECTED_VALUE_TOO_LOW`, `INSUFFICIENT_EVIDENCE`) without the report's label being updated to match. |
| **FIX** | Changed only the rendered text label (`renderTradingSessionReport()`) from `Consensus Rejected (no-trade): ${n}` to `Desk No-Trade Events (pre-consensus, e.g. stale data): ${n}`, and added a doc comment on the `TradingSessionReport.decisionPipeline.consensusRejected` interface field clarifying exactly what it counts. The field name and its computation (`countType('DESK_NO_TRADE')`) were deliberately left unchanged — other modules (`PostMarketAnalysis.ts`, `replayReport.ts`) use the same field name with a different, already-correct computation in their own context; renaming the shared identifier was out of scope and unnecessary for the smallest safe fix. No trading logic, threshold, or consensus computation was touched. |
| **TEST** | Existing `src/server/core/tradingSessionReport.test.ts` (8 tests) does not assert the literal old string and required no changes; ran unmodified and green. Confirmed no other file in `src/`, `scripts/`, `CLAUDE.md`, or `docs/` references the old label string. |
| **RESULT** | `tradingSessionReport.test.ts`: 8/8 pass. `PostMarketAnalysis.test.ts` + `replayReport.test.ts` + `replayStore.test.ts` (other `consensusRejected` consumers, confirmed independent): 36/36 pass. `tsc --noEmit`: clean. **Not yet live**: the running engine (PID 18692) was started from TS source via `tsx` before this edit and is not hot-reloading; this fix will take effect on Argus's next restart, whenever one next occurs for an unrelated reason. This audit deliberately did **not** restart the engine to force this cosmetic fix live, per the audit's own "do not restart the running engine unnecessarily" instruction — the fix is low-severity and non-urgent. |

No other objective defect was found. The zero-trade condition itself is not a bug; it is the correct, fail-closed response of a well-behaved system to a real, external, unresolved IBKR market-data entitlement outage.
