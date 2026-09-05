# Argus September 4, 2026 — Opportunity Capture Remediation

**Investigation window:** ~19:45–20:10 UTC (≈15:45–16:10 ET), live, running engine (PID 53104, booted
2026-09-04T18:05:03Z after Mission 2's fixes were deployed), read-only DB/HTTP/CLI throughout except for the
code changes listed below. No test suite was run against the live process. Chronos sidecar (`:8008`) was
**not** restarted by me — it was already running with Mission 2's `inference_worker.py` fix, restarted by the
orchestrating session before this investigation began. This report is Mission 3, building directly on
`ARGUS_SEPTEMBER_4_MISSED_OPPORTUNITY_FORENSIC_AUDIT.md` (Mission 2), which is ground truth for everything
before ~18:10 UTC.

---

## Exact Trades Today

```
trades:            0
fills:              0
risk_assessments:   0   (freshest row in the DB is still 2026-09-01, REPLAY — not today, not organic)
```
Reconfirmed fresh at ~20:03 UTC. Unchanged from Mission 2.

## Current Runtime State (reconfirmed ~19:52–20:06 UTC)

| Item | Value |
|---|---|
| Engine PID | 53104, booted 2026-09-04T18:05:03.442Z, uptime ≈1.9h at check time |
| `runtime.phase` | RUNNING |
| `autobot.tradingState` | **TRADING_ENABLED** (Mission 2's Chronos fix + restart cleared the memory-critical auto-pause) |
| `liveReadiness` | `LIVE_NO_GO` (unchanged) |
| Selected broker | **IBKR Gateway (Socket)** (`settings.selectedBroker`) |
| Active MarketDataWorker subscriptions | 17 |
| **Effective streaming cap** | **90** (`ibkrConnection.maxMarketDataLines`, confirmed live via `GET /api/v2/continuous-intelligence/capacity`: `effectiveCap:90, activeCount:17, emptySlots:73`) — see Correction below |
| Anchor symbols (permanent) | GLD (31,466+ ticks), QQQ (180,099+ ticks), SPY (133,559+ ticks) |
| Distinct symbols in `candidate_rankings` today | 122 |
| Distinct symbols with a `CHIEF_CONSENSUS_COMPLETED` round today | 10: QQQ 374, GLD 351, SPY 286, TSLA 16, AAPL 6, NVDA 5, MSFT 3, META 3, IWM 1, AMD 1 (anchors = 96.7% of rounds — unchanged from Mission 2) |

### Correction to Mission 2's capacity framing

Mission 2 reported "17 active vs `maxActiveSubscriptions: 12` cap" and framed this as scarcity. That 12 is
Alpaca's constant; this deployment's active broker is **IBKR Gateway**, and `MarketDataWorker.
getEffectiveStreamingCap()` already correctly returns `ibkrConnection.maxMarketDataLines` (90) via
`hardCapOverride` for this broker (`BrokerManager.ts`'s `applyMarketDataBinding()`, itself a real fix from an
earlier session — boot-time binding, not just mid-session switch). Verified live: `effectiveCap:90,
activeCount:17, emptySlots:73`. **There is no subscription-slot scarcity today.** The real constraint,
confirmed below, is that most of those 17 "active" slots were not receiving real data at all — a data-delivery
failure, not a capacity failure. This reframes and supersedes the P1 finding in Mission 2's report.

---

## Root Cause 4 (P0, CONFIRMED + FIXED, live-observed): silent IBKR market-data rejections

**Observed live** via `/api/v2/continuous-intelligence/capacity`: NVDA, AAPL, MSFT, META, TSLA, AMD, IWM all
sat in the active-subscription list with **`tickCount: 0`** for 5–7+ minutes of continuous dwell time during
regular trading hours, while GLD/QQQ/SPY (subscribed earlier) accumulated tens of thousands of ticks in the
same window. This is the mechanical explanation for Mission 2's NVDA finding (462 subscribe requests, 2
TechnicalAgent evals): NVDA *was* being admitted into an active slot — it just never received a real tick
once there.

**Code root cause** (`src/brokers/IbkrSocketSession.ts`): `subscribeMarketData()` calls `ib.reqMktData()` and
immediately marks the symbol "active" in local bookkeeping — it never confirms IB actually granted the
market-data line. IB reports a rejected/unsubscribed request (e.g. error 354 "Requested market data is not
subscribed", a common IBKR account-entitlement error for individual equities without the necessary
market-data-line subscription) via an `error` event carrying that request's `reqId`. The existing handler:
```ts
ib.on(EventName.error, (err, code, reqId) => {
  if (!settled && code === ErrorCode.CONNECT_FAIL) { ...disconnect/retry... }
  else if (!settled) { console.warn(...); }
});
```
only ever acted while `settled` was still `false` (i.e., during the initial `connect()` handshake). A
per-symbol `reqMktData` rejection structurally cannot arrive until *after* the connection is already up —
so every such error was silently dropped: no log line, no observability event, nothing. The symbol stayed
"active" forever with zero data and zero diagnostic trail.

**Fix implemented** (additive, observability-only — never touches OMS/RiskEngine/BrokerManager order paths,
never changes what gets subscribed or evicted):
- `src/brokers/IbkrSocketSession.ts`: the `error` handler now also (regardless of `settled`) resolves
  `reqId → symbol` via the existing `activeMktData` map and records `{code, message, atMs}` plus invokes an
  optional `marketDataErrorHandler` callback. New `setMarketDataErrorHandler()`/`getMarketDataError()`. Cleared
  on a fresh `subscribeMarketData()` or `cancelMarketData()` for that symbol.
- `src/brokers/IBGatewaySocketAdapter.ts`: thin pass-through (`setMarketDataErrorHandler`/`getMarketDataError`),
  mirroring the existing `setQuoteSink` pattern.
- `src/brokers/BrokerManager.ts` (`applyMarketDataBinding()`, ibkr_gateway branch): wires the handler to
  `marketDataWorker.recordMarketDataError()` + a structured log (`category: MARKET_DATA`, `eventType:
  IBKR_MARKET_DATA_ERROR`) so it lands in `observability_events`, queryable. Cleared on quote-context teardown.
- `src/server/services/MarketDataWorker.ts`: new `recordMarketDataError()`/`getMarketDataError()`; the
  existing `getActiveSlots()` (used by `/api/v2/continuous-intelligence/capacity`) now includes a
  `marketDataError` field per slot; cleared on `unsubscribe()`.
- `src/server/observability/discoveryLineageReport.ts` (**extended, not duplicated** — this is Argus's
  existing per-symbol forensic tool): now joins the live `MarketDataWorker` snapshot
  (`currentlySubscribed`/`currentTickCount`/`currentDwellAgeMs`/`marketDataError`) into the report and its
  `terminalSummary`. A symbol like today's NVDA now renders as *"Currently subscribed but IB rejected the
  market-data line (code 354: ...) — it will never tick until this is resolved..."* instead of a generic
  "subscribed but never reached a recorded QuantEngine evaluation" stall.

**What this fix does and does not prove:** it makes the failure *visible* going forward — no prior code path
ever persisted these errors, so the exact IB error code/message for NVDA/AAPL/etc. today is **not
retroactively recoverable**. Whether the underlying cause is a missing IBKR market-data-line entitlement for
individual US equities on this paper account (most likely, given ETFs/anchors work and individual equities
don't), a per-account market-data-line cap distinct from `maxMarketDataLines`, or something else, will only be
knowable after a restart with this fix deployed and a fresh IB error is captured and logged. This is flagged
honestly as **not yet operator-confirmed**, only code-confirmed.

---

## Root Cause 5 (P0, CONFIRMED + FIXED, live-observed): broad-universe discovery channel dead all session

`GET /api/v2/continuous-intelligence/status` (live):
```json
"broadUniverse": {
  "enabled": true,
  "lastRefresh": { "ran": true, "assetsFetched": 0, "screened": 0, "candidates": 0,
                    "error": "This operation was aborted", "at": "2026-09-04T18:04:21.906Z" },
  "cachedCandidateCount": 0
}
```
`lastRefresh.at` is still the engine's own **boot** timestamp at every check between 19:52 and 20:06 UTC (≈2
hours later) — the one refresh attempt at boot failed (a fetch-timeout abort on Alpaca's full tradable-assets
list) and **it was never retried**. The real, liquidity-screened broad-universe funnel — the one mechanism
specifically built to catch a name like AMC or NTAP that isn't on any curated seed/watch list — produced zero
candidates for the entire session.

**Code root cause** (`src/server/continuous/MarketUniverseScanner.ts`, `MarketUniverseScannerWorker.start()`):
```ts
this.intervalId = setInterval(() => { void refreshBroadUniverseCache(); },
  continuousIntelligence.broadUniverseAssetsCacheTtlMs);   // 86,400,000 ms = 24h
```
`broadUniverseAssetsCacheTtlMs` (24h) is correctly used *inside* `fetchTradableAssets()` as the cache TTL for
the raw Alpaca tradable-asset list (which barely changes intraday — that part is fine). But the **worker's own
rescheduling interval** was wired to that same 24h constant, instead of the already-existing
`broadUniverseSnapshotCacheTtlMs` (900,000 ms = 15 min) — the constant specifically defined for the
intraday-relevant part of this same refresh (the price/volume/spread screen). Nothing else calls
`refreshBroadUniverseCache()` after boot. Net effect: one failed attempt at boot → silent 24-hour outage of
the entire broad-universe channel, with no retry and no alert (only visible via this one status endpoint).

**Fix implemented** (`src/server/continuous/MarketUniverseScanner.ts`): reschedule on
`broadUniverseSnapshotCacheTtlMs` instead of `broadUniverseAssetsCacheTtlMs`. `fetchTradableAssets()`'s own
internal 24h cache check is unchanged, so this does **not** add extra full-asset-list Alpaca calls — only the
screen/ADV work (already batched, already behind the existing discovery circuit breaker) now retries on the
~15-minute cadence the snapshot cache was always meant to be kept warm on. A transient failure now self-heals
in minutes instead of producing a silent day-long outage.

**Relationship to AMC/NTAP:** neither symbol is in any curated seed/watch list
(`grep` of `config/continuousIntelligence.json` confirms). AMC has **zero** `observability_events` rows of any
kind, ever, in this database. NTAP has real activity — but all of it timestamped **2026-09-03** (yesterday):
discovered via the independent `NEWS_CATALYST` path (not the broad-universe scanner), admitted, quant-assessed
16 times, briefly rescue-granted, then `SYMBOL_NOT_SUBSCRIBED` and `TRADE_IDEA_REJECTED`. Zero NTAP activity
today. The movers funnel (`/v1beta1/screener/stocks/movers`) was healthy and refreshing normally throughout
today's session (50 gainers + 50 losers fetched, 99 screened, 2 admitted as of the last refresh) — AMC/NTAP's
absence from movers-sourced discovery today is most likely an honest fact (they were not in today's actual
top-50 gainers/losers), not a bug. The broad-universe channel is the one that was completely non-functional,
and it is the one whose entire purpose is catching names outside curated lists and outside the day's top-50
movers. **This is assessed as the confirmed root cause for why AMC/NTAP (and any other non-curated,
non-top-50-mover name) could not have been discovered today**, though — same honesty caveat as Root Cause 4 —
whether AMC/NTAP specifically would have passed the liquidity screen if the channel had been alive cannot be
retroactively verified; the fix ensures the channel runs and is checkable going forward.

---

## Chronos Validation (continuing Mission 2 / the orchestrator's work)

Confirmed the fix (`scripts/lib/inference_worker.py`) is the code currently loaded and serving real inferences
(`lastInferenceMs` present and varying on every sample — not idle). Ran a background sampler against the live
`:8008/health` every 90s for the duration of this investigation (I did **not** restart Chronos — it was already
running with the fix from the orchestrator's earlier restart):

| Time (UTC) | threadCount | committedMemoryMb |
|---|---|---|
| 19:48:28 | 44 | 2148.7 |
| 19:51:28 | 44 | 2118.1 |
| 19:54:29 | 44 | 2066.5 |
| 19:57:29 | 45 | 2128.0 |
| 20:00:30 | 44 | 2130.8 |
| 20:03:31 | 44 | 2132.2 |
| 20:06:31 | 44 | 2130.2 |

Over this ≈18-minute observed window, `threadCount` is flat (44, one transient 45), and `committedMemoryMb`
oscillates in a narrow ~2066–2149MB band with **no growth trend** — a stark contrast to the pre-fix pattern
(1913→1953 threads / +214MB after just 8 forecast calls; 16.8–17.2GB committed). `MEMORY_TELEMETRY_SAMPLE`
CRITICAL events and `TRADING_STATE_CHANGED` auto-pauses have not recurred since the restart (0 today after
the fix deployed, per the orchestrator's earlier DB check, reconfirmed by `tradingState: TRADING_ENABLED`
holding steady throughout this entire investigation with no further pause events observed).

**Honest limit:** 18 minutes (plus the orchestrator's earlier 45-minute check — ~1 hour of cumulative observed
flat behavior) is not a multi-hour soak. The background sampler (PID-independent `curl` loop, 90s interval,
~5h runtime cap) was left running past the end of this investigation in the scratchpad directory
(`chronos_watch.log`) for anyone continuing to observe it, but its results after this report was written are
not included here. **Verdict: PASS for the observed window; not yet a full-session guarantee.**

---

## Calibration / Consensus (reconfirmed, unchanged from Mission 2 — not touched)

`argus-cli trading-funnel` (live, this session):
```
0-agent: 67   1-agent: 727   2-agent: 234   3-agent: 16   4+: 0
Confidence >= 0.60: 2   Confidence >= 0.75: 0   Moderate/Strong approved: 0
RiskEngine reached: 0   Risk approved: 0   OMS orders: 0   Paper fills: 0
TOP NO-TRADE REASONS: CONFIDENCE_BELOW_STRONG 975, AGENT_DATA_UNAVAILABLE 42, AGENT_HOLD 25
```
`argus-cli agent-edge`: every agent bucket with sufficient effective sample size (TechnicalAgent,
QuantEngine, KronosEngine, JavaFactorComposite, OpportunityScreener) is `CALIBRATION_FAILED` — real Wilson
lower bound does not exceed 0.5 in any bucket. **Reconfirmed correct, working-as-designed behavior — not a
bug, not touched.** Separately noted: `NewsAgent` shows `PROVIDER_UNAVAILABLE` in every confidence bucket
(`provider-health` shows every AI provider `SKIPPED`/`Degraded`/`Offline` right now) — this is a genuine,
observed AI-provider-availability condition, consistent with CLAUDE.md's fail-closed design (HOLD/confidence 0
on malformed/unavailable AI, never a forced vote). Not deeply investigated further given time budget; flagged
as a real but separate condition worth operator attention, not remediated today.

---

## Fixes Implemented Today (files changed)

| File | Change |
|---|---|
| `src/brokers/IbkrSocketSession.ts` | Surfaces post-connect IB market-data errors (previously silently dropped) via new `setMarketDataErrorHandler`/`getMarketDataError`/`handleMarketDataError` |
| `src/brokers/IBGatewaySocketAdapter.ts` | Pass-through wiring for the above |
| `src/brokers/BrokerManager.ts` | Wires the handler to `MarketDataWorker.recordMarketDataError()` + a structured `IBKR_MARKET_DATA_ERROR` log |
| `src/server/services/MarketDataWorker.ts` | `recordMarketDataError()`/`getMarketDataError()`; `getActiveSlots()` now includes `marketDataError`; cleared on `unsubscribe()` |
| `src/server/observability/discoveryLineageReport.ts` | Extended (not duplicated) with live `currentlySubscribed`/`currentTickCount`/`currentDwellAgeMs`/`marketDataError`, folded into `terminalSummary` |
| `src/server/continuous/MarketUniverseScanner.ts` | `MarketUniverseScannerWorker.start()` reschedules broad-universe refresh on `broadUniverseSnapshotCacheTtlMs` (15min) instead of `broadUniverseAssetsCacheTtlMs` (24h) |

No safety threshold, RiskEngine gate, consensus threshold, config numeric value, or env var was modified.
Both fixes are purely additive/observability/scheduling — neither changes what gets subscribed, evicted,
voted on, or traded.

## Tests (written, NOT run — exact commands for you to run after stopping the live engine)

New/changed test files:
- `src/brokers/__tests__/IbkrSocketSession.marketDataError.test.ts` (**new**, 7 tests): handler wiring,
  case-insensitive lookup, fail-open on a throwing handler, clearing on resubscribe/cancel, no-op for an
  unknown reqId.
- `src/brokers/__tests__/IBGatewaySocketAdapter.test.ts` (+1 test): pass-through wiring.
- `src/server/services/MarketDataWorker.test.ts` (+5 tests, new `describe`): record/get, surfacing on
  `getActiveSlots()`, null for a healthy symbol, clearing on `unsubscribe()`.
- `src/server/observability/discoveryLineageReport.test.ts` (+2 tests): a live-subscribed symbol with a
  recorded IB error renders the specific terminal reason; one with no error renders the distinct "hasn't
  ticked yet" reason.
- `src/server/continuous/MarketUniverseScanner.test.ts` (+1 `describe`, 2 tests): the worker's `setInterval`
  call uses `broadUniverseSnapshotCacheTtlMs`, never `broadUniverseAssetsCacheTtlMs`; sanity check that the
  snapshot TTL is minutes-scale, not day-scale.

Not separately added: a `BrokerManager`-level integration test for the new wiring (the existing test suite
has no `instanceof IBGatewaySocketAdapter` mock scenario for `applyMarketDataBinding()`'s ibkr_gateway branch
at all — `setQuoteSink` itself isn't covered that way either — and building one just for this would be a
fragile, low-value addition given the logic itself is fully covered on both sides of the wiring).

Exact commands to run (I did not run these — do not run tests against the live engine):
```
npx tsc --noEmit
npx vitest run src/brokers/__tests__/IbkrSocketSession.marketDataError.test.ts
npx vitest run src/brokers/__tests__/IBGatewaySocketAdapter.test.ts
npx vitest run src/server/services/MarketDataWorker.test.ts
npx vitest run src/server/observability/discoveryLineageReport.test.ts
npx vitest run src/server/continuous/MarketUniverseScanner.test.ts
npm test
```

---

## Resource Allocation (sections 7–10): investigated, deliberately NOT built

Given the corrected capacity picture (90 cap / 17 active / 73 empty slots, confirmed live), **there is
currently no subscription-slot scarcity** — the ETF/anchor dominance of consensus rounds (96.7%) is fully
explained by Root Cause 4 (dynamic equities admitted into slots but starved of real ticks), not by contention
for a scarce pool. Building a bounded opportunity-reservation/decay mechanism today, against a diagnosis the
evidence doesn't support, would be exactly the kind of speculative machinery the mission asked me not to
ship. **Design-and-defer, explicitly:** if Root Cause 4's underlying IB entitlement issue turns out to be
unresolvable at the code layer (i.e., individual-equity market data genuinely requires an IBKR account
upgrade), *then* a reservation/decay layer on top of a cap that's actually being contended would become
relevant — but that is not today's evidence. Recommend re-assessing after a restart with today's fixes shows
whether NVDA-class symbols start ticking.

## Root Causes — Ranked

| Rank | Cause | Evidence | Status |
|---|---|---|---|
| P0 | Silent IBKR market-data rejection (Root Cause 4) | Live: NVDA/AAPL/MSFT/META/TSLA/AMD/IWM tickCount=0 for 5–7+ min during RTH while anchors accumulate ticks normally; code confirmed swallowing errors post-connect | **Fixed** (observability only; underlying IB-side cause not yet confirmed post-restart) |
| P0 | Broad-universe scheduler bug (Root Cause 5) | Live: `lastRefresh.at` stuck at boot time ~2h later, `cachedCandidateCount:0`; code confirmed wrong interval constant | **Fixed** |
| — | Mission 2's "12-cap scarcity" framing | Live: `effectiveCap:90`, `emptySlots:73` | **Corrected**, not a bug |
| — | ChiefTrader calibration rejecting nearly everything | `agent-edge`: no bucket exceeds Wilson 0.5 lower bound | Reconfirmed correct, not touched |
| P2 | NewsAgent / all AI providers degraded-or-offline right now | `provider-health`: all SKIPPED | Observed, not investigated further, not remediated |

---

## Final Answer

```
TODAY'S PAPER TRADES: 0
ENGINE RELIABILITY: PASS — TRADING_ENABLED held steady throughout this investigation, no auto-pause recurred
CHRONOS: PASS (for the ~18min + ~1h cumulative observed window) — THREADS: flat at 44 (one transient 45)
  MEMORY: committedMemoryMb flat in a ~2066-2149MB band, no growth trend; not yet a multi-hour soak
DISCOVERY: 122 symbols scored in candidate_rankings today; AMC/NTAP never discovered today (root-caused:
  broad-universe channel dead all session, now fixed; movers funnel was healthy and found neither today)
MARKET DATA: 17 active subscriptions on a 90 cap (73 empty, not scarce); NVDA/AAPL/MSFT/META/TSLA/AMD/IWM
  confirmed live at tickCount=0 despite active subscription (silent IBKR rejection, now surfaced/fixed)
STRATEGY: Quant evaluated NVDA/TSLA/AAPL/MSFT/META/AMD ~193-202x each today (works independent of live ticks);
  TechnicalAgent only 3-11x each (tick-driven, starved by Root Cause 4) vs QQQ/SPY 537/372
MULTI-AGENT: 234 symbol-rounds reached >=2 independent agents today (unchanged from Mission 2)
CHIEFTRADER: ~1046 consensus rounds across 10 symbols; 0 reached >=0.75; 0 approved (reconfirmed correct
  calibration behavior, not touched)
RISK: 0 reached, 0 approved
OMS: 0 orders
STRONGEST MISSED OPPORTUNITY: NVDA / first detectable via candidate_rankings continuously all day (avg rank
  2.9, top-10 in all 625 cycles) / DISCOVERY: correctly ranked #1 repeatedly / DATA: subscribed into an active
  slot 527x but received 0 real ticks / STRATEGY: Quant evaluated it 194x (works without ticks), Technical
  only 5x (tick-starved) / AGENTS: 5 consensus rounds, never reached 2-agent+0.75 together / CHIEFTRADER:
  reached but never approved / FINAL ROOT CAUSE: silent IBKR reqMktData rejection (Root Cause 4) — confirmed
  and fixed at the code/observability layer; underlying IB-side cause requires a post-restart check
P0 FIXES: (1) IBKR silent market-data-error surfacing (5 files) (2) broad-universe scheduler 24h->15min fix
  (1 file, MarketUniverseScanner.ts)
P1 FIXES: discoveryLineageReport.ts extended with live subscription/tick/error state
TESTS: 6 files changed/added, 17 new test cases total; commands listed above — not run by me
RUNTIME PROOF: Chronos flat over ~18min this session (~1h cumulative with orchestrator's earlier check); IBKR
  and broad-universe fixes require an engine restart to validate live (not done today, per instruction)
CURRENT STATUS: CONDITIONAL — PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS per CLAUDE.md, unchanged. Restart
  the engine with today's two fixes deployed and re-check discovery-lineage/capacity for NVDA-class symbols
  and the broadUniverse status block before relying on either being resolved end-to-end.
```
