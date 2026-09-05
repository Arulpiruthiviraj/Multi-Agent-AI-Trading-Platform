# Argus — Session-Aware Trading Architecture: Current-State Forensic Audit

**Phase 0 deliverable.** Read-only forensic audit of the actual repository as of 2026-09-05. No trading behavior was changed to produce this document. Every claim below is grounded in a direct source read (file:line) — nothing is inferred from file or function names alone, and every "not found" is a real negative search result, not an assumption. This document supersedes any prior doc's characterization of premarket work as "not yet built" where the evidence below contradicts it (see §7).

---

## 1. Executive summary

Argus already has **two independent, non-integrated systems** that each implement a meaningful slice of "premarket intelligence," built at different times, in different directories, with different governance headers, unaware of each other's existence:

| System | Location | What it does | Status |
|---|---|---|---|
| **A. `SessionLifecycle`** | `src/server/premarket/` | Tracks a market-session phase + an application-state phase, persists it, emits events on transition | Stage 1 only, explicitly observability-only — never scans, ranks, plans, or emits an idea |
| **B. The "Phase 4" continuous-intelligence series** | `src/server/continuous/` | Real candidate ranking (`ComposableRanking`), a persisted trade-plan object with thesis/entry-zone/invalidation (`TradePlanBuilder`), automatic revalidation at the open, and missed-opportunity classification (`MissedOpportunityDetector`) | Functional, running in production today, but structurally barred from the live idea-emission pipeline by its own governance rule, and never reads System A's session state — it re-derives session with its own inline `classifyMarketSession()` calls |

Neither system currently has any path to `TRADE_IDEA_GENERATED`, `ChiefTraderAgent`, `RiskEngine`, `OMS`, or `BrokerManager`. Both are correctly isolated by test-enforced architecture boundaries. The gap is not "premarket intelligence doesn't exist" — it's that a real, working implementation exists in two disconnected pieces, and neither is wired to the protected execution spine.

Separately, and independent of the above: **the live order-authorization path has no extended-hours concept at all.** Gate 12 (`market_hours`) is a binary Alpaca-clock check that is RTH-only on the live path; a working extended-hours session classifier (`classifyMarketSession`) exists in this codebase but is wired only into the replay/backtest engine. No broker adapter that could plausibly place a real order implements genuine extended-hours order semantics (Alpaca's `extended_hours` flag, IBKR's `outsideRth` flag) except one adapter, accidentally, via a generic warning-auto-confirm path.

---

## 2. Market session representation — current state

### 2.1 The base session enum

`classifyMarketSession()` (`src/server/replay/marketSession.ts:22-31`) is the one function most other session logic in the codebase either wraps or reimplements:

```ts
export type MarketSession = 'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';

export function classifyMarketSession(ms: number, timeZone: string, extendedHours: boolean): MarketSession {
  const wd = weekdayInTimezone(ms, timeZone);
  if (wd === 'Sat' || wd === 'Sun') return 'CLOSED';
  const mins = minutesInTimezone(ms, timeZone);
  const { regularSessionStartMinutes, regularSessionEndMinutes, preMarketStartMinutes, afterHoursEndMinutes } = replaySafety;
  if (mins >= regularSessionStartMinutes && mins < regularSessionEndMinutes) return 'REGULAR';
  if (extendedHours && mins >= preMarketStartMinutes && mins < regularSessionStartMinutes) return 'PRE_MARKET';
  if (extendedHours && mins >= regularSessionEndMinutes && mins < afterHoursEndMinutes) return 'AFTER_HOURS';
  return 'CLOSED';
}
```

Thresholds (`config/replaySafety.json:34-37`): premarket starts 04:00 ET, RTH 09:30–16:00 ET, after-hours ends 20:00 ET. **No holiday or half-day awareness** — this function has no calendar input; Christmas Day classifies as a normal Thursday.

### 2.2 Nine independent representations of "what phase of the trading day is it"

This is a real architectural finding, not a stylistic nitpick: at least nine distinct places in the codebase each independently answer "what session is it," several reimplementing the same weekday/minute-of-day logic rather than calling a shared function.

| # | Representation | Location | Values | Relationship to §2.1 |
|---|---|---|---|---|
| 1 | `MarketSession` | `replay/marketSession.ts:3` | `PRE_MARKET \| REGULAR \| AFTER_HOURS \| CLOSED` | Base |
| 2 | `ApplicationSessionState` | `premarket/SessionLifecycle.ts:25-32` | `IDLE \| RESEARCHING \| PLAN_BUILDING \| PLAN_READY \| OPEN_REVALIDATION \| INTRADAY \| CLOSE_REVIEW` | 1:1 derived from #1 — but only 4 of 7 values are ever reachable (see §3.2) |
| 3 | researchRoutes remap | `routes/researchRoutes.ts:544-553` | `MARKET_OPEN \| PRE_MARKET \| AFTER_HOURS \| WEEKEND_CLOSED \| CLOSED` | Derives from #1 but re-implements its own weekday check rather than trusting #1's `CLOSED` |
| 4 | `tradingSessionReport` | `core/tradingSessionReport.ts:23` | `PRE_MARKET \| RTH \| AFTER_HOURS \| CLOSED \| UNKNOWN` | Derives from #1, different rename (`RTH` vs #3's `MARKET_OPEN`) |
| 5 | `RegimeEngine.classifyDeskSession()` | `quant/RegimeEngine.ts:179-198` | `PREMARKET \| OPEN \| MORNING \| MIDDAY \| AFTERNOON \| CLOSE \| UNKNOWN` | **Fully independent** — own minute-of-day math against `tradingSafety.usEquityRthOpenMinute/CloseMinute` (duplicate constants of `replaySafety.json`'s), no weekend/holiday check at all |
| 6 | `SnapshotScanner.isSnapshotScannerRth()` | `continuous/SnapshotScanner.ts:104-111` | boolean RTH | **Fully independent** boolean implementation, coexisting in the *same file* that also calls `classifyMarketSession()` directly (line 320) for its own PRE_MARKET/REGULAR branching |
| 7 | Mobile UI chip mappers | `mobile/mobileUtils.ts:19-27`, `MobileAppChrome.tsx:14-20` | Consumes #3, plus dead lowercase variants never produced server-side | Consumer |
| 8 | `isUsEquityRegularSession()` | `news/newsSessionCadence.ts:9-11` | boolean | Thin, correct wrapper around #1 (not a duplicate) |
| 9 | `MarketOpenNewsConfluence` internal state | `news/MarketOpenNewsConfluence.ts:30-31` | ad hoc `lastSession`/`sessionOpenMs` | Own session-transition tracking, inside the live idea-emission path (this class calls `emitTradeIdea`) |

`SnapshotScanner.isSnapshotScannerRth()`'s own comment (`SnapshotScanner.ts:104-111`) is self-aware about the gap: *"Weekday 09:30–16:00 America/New_York (ignores exchange holidays — fail-open for scan cadence)."*

### 2.3 No holiday-aware calendar exists anywhere in Argus's own code

The only holiday/half-day-aware signal in the entire system is Alpaca's `GET /v2/clock` endpoint (holidays handled server-side by Alpaca), and Argus only reads its boolean `is_open` field (`RiskEngine.ts:140`) — no `next_open`/`next_close` fields are consumed anywhere. Every other session determination in the codebase (`classifyMarketSession` and all nine representations in §2.2) is pure weekday + minute-of-day arithmetic with zero calendar awareness.

### 2.4 `SessionLifecycle.ts` — what actually exists today

- `MarketSession` (§2.1) plus `ApplicationSessionState` (§2.2 #2), combined into `SessionLifecycleSnapshot = { marketSession, appState, tradingDate, evaluatedAt }` (`SessionLifecycle.ts:34-39`).
- **This is much narrower than a `SessionContext` with `sessionId`, `isTradingDay`, `isExtendedHours`, `minutesToOpen/SinceOpen/ToClose`** — none of those fields exist anywhere in the codebase as named fields on any object. The closest things are scattered: `getTradingDateStr()`/`getTradingTimeHHMM()` (`core/TradingCalendar.ts:35-52`) and `SnapshotScanner.ts`'s private `minutesSinceRthOpen()` (`SnapshotScanner.ts:114-121`) — not part of any shared context object.
- Persisted to `session_lifecycle_snapshots` (`db/schema.ts:1576-1586`): `id, tradingDate, marketSession, appState, premarketFiredForDate, evaluatedAt, createdAt`. Restored only for the *same* trading day on restart; a prior-day row is deliberately discarded.
- Exposed via `GET /api/v2/runtime/session-lifecycle` (`routes/v2Runtime.ts:174-188`).
- Runs on a 60s interval (`runtimeIntervals.json`: `sessionLifecycleEvalMs: 60000`) plus once at boot, wired from `ArgusCoreBoot.ts:224-225`.
- The `appState` map (`SessionLifecycle.ts:49-54`) is a straight 1:1 with `MarketSession`: `PRE_MARKET→RESEARCHING`, `REGULAR→INTRADAY`, `AFTER_HOURS→CLOSE_REVIEW`, `CLOSED→IDLE`. **`PLAN_BUILDING`, `PLAN_READY`, `OPEN_REVALIDATION` are declared in the type but never assigned anywhere in the codebase.**
- Governance-enforced isolation: `premarketArchitectureBoundary.test.ts` bars this directory from importing OMS/RiskEngine/BrokerManager/ChiefTraderAgent.

---

## 3. Market data behavior outside RTH

- `MarketDataWorker.ts` (1168 lines, full-text searched for every session term) has **zero session awareness**. `start()` connects the Alpaca IEX WebSocket unconditionally whenever keys are present; incoming quote/trade messages (`"q"`/`"t"`) are processed through the exact same code path (`MarketDataWorker.ts:1112-1139`) regardless of time of day — no flag, tag, or branch marks a tick as premarket/RTH/after-hours.
- It naturally receives fewer ticks overnight because Alpaca's IEX feed itself only produces data when IEX is trading — that's an artifact of the upstream feed, not Argus-side gating.
- `ArgusCoreBoot.ts` starts `MarketDataWorker` and `SessionLifecycle` as two independent workers (lines 135-143 and 223-232) that never reference each other.

---

## 4. IBKR paper extended-hours capability — current state

- `IBGatewaySocketAdapter.ts` → `IbkrSocketSession.ts:379-428` constructs an IB `Order` object with `tif: 'DAY'` and **never sets `outsideRth`** (IB TWS API's real extended-hours flag; defaults to `false` when omitted). No market-hours check exists in the adapter itself — behavior outside RTH is entirely IB Gateway's own default handling of an RTH-only order, untested and unverified by Argus.
- `InteractiveBrokersWebApiAdapter.ts:277-334` also sets `tif: 'DAY'` with no explicit extended-hours field, **but** its order-confirmation-reply loop (lines 320-329) auto-confirms any non-duplicate IBKR warning — and this includes IBKR's literal *"This order will be submitted outside regular trading hours"* confirmation. This is proven by a real, passing test (`InteractiveBrokersAdapter.sessionIsolation.test.ts:51-61`), which mocks exactly that warning and confirms the adapter pushes the order through. **This is the one place in the codebase with a demonstrated, tested path to completing an extended-hours order — and it is accidental** (a side effect of generic warning auto-confirmation, not a deliberate extended-hours feature).
- Per `CLAUDE.md`, **`ibkr_gateway` (not `ibkr_web`) is the currently-active broker in this deployment** — the adapter with no extended-hours capability, not the one with the accidental path.

---

## 5. Alpaca integration — current state

- `AlpacaBroker.ts:318-324` sends `{ symbol, qty, side, type, time_in_force: 'day' }` — **`extended_hours` is never set.** Alpaca's real API requires `extended_hours: true` together with `type: 'limit'` and `time_in_force: 'day'` for an extended-hours order to be accepted; since OMS always calls with `type: 'MARKET'` (see §6), Alpaca could never legally accept an extended-hours order through this path even if the flag were added without also changing the order type.
- No market-open check exists inside `AlpacaBroker` itself — it defers entirely to Alpaca's own API to accept or reject.

---

## 6. Order validation / RTH assumptions in OMS

- `OrderManagement.ts` has **no time-of-day check and no RTH-calibrated staleness threshold** anywhere in the file (grepped for `getHours`/`getDay`/market-open patterns — none found).
- Orders are hardcoded to `type: 'MARKET'` (`OrderManagement.ts:390-396`) with no price/limit/extended-hours field — this is a structural blocker for extended-hours execution independent of broker capability, since exchanges generally require limit orders outside RTH and Argus's OMS does not currently construct one.
- `authorizeProductionOrder()` (`core/liveOrderAuthorization.ts`) gates on environment/live-arm/live-readiness — no session logic.

---

## 7. RiskEngine session assumptions

### 7.1 Gate 12 (`market_hours`) — partially session-aware, live-path is not

`RiskEngine.ts:521-536`:
```ts
const marketClock = replay
    ? (isDailyFrequency ? 'open' : (sessionAllowsFills(classifyMarketSession(nowMs, replay.config.timezone, replay.config.extendedHours), replay.config.extendedHours) ? 'open' : 'closed'))
    : await readMarketClock();
const marketHoursPassed = marketClock === 'open' || marketClock === 'unconfigured';
```

- **Replay path**: genuinely session-aware, via `classifyMarketSession`/`sessionAllowsFills`, honoring a per-run `extendedHours` config flag.
- **Live path**: `readMarketClock()` (`RiskEngine.ts:116-146`) is a **binary** Alpaca `/v2/clock` `is_open` check. There is no "closed-but-premarket" state distinct from weekend/holiday/overnight closure live — premarket and 3am Sunday fail this gate identically. `TradingReadinessGate.ts:123-131` confirms this is the documented, intentional behavior today (*"`market_hours` is expected to fail pre-open"*).
- **A real gap, not by design**: gate 12 is `skip/pass` when `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` are unconfigured (blank by default in `.env.example`) — and this check is Alpaca-specific **regardless of which broker is actually active**. A deployment running IBKR (the documented default) without Alpaca keys configured has **zero live session check on this gate, at any hour** — this is worth flagging as a genuine, currently-live gap independent of any premarket feature work, since it means gate 12 could already be silently skip-passing today outside RTH if Alpaca keys happen to be unset.

### 7.2 Gate 13 (`data_freshness`) — zero session-awareness

`evaluateQuoteFreshness()` (`core/marketDataQuality.ts:17-50`) uses a single fixed `stalePriceThresholdMs` (`config/tradingSafety.json`: `300000`ms / 5min) with no session parameter anywhere in the function signature or its callers. The same 5-minute staleness bar applies at 9:31am and 3:59am. In practice this gate is largely moot outside RTH today because gate 12 already fail-closes non-RTH live attempts first — but the code itself has no session logic, so if gate 12 were ever made extended-hours-aware, gate 13's flat threshold would need its own explicit review (premarket ticks are naturally sparser).

### 7.3 Gates 3/4/6 (cooldowns, duplicate signal) — pure elapsed-time, no day concept at all

`same_symbol_cooldown`, `post_loss_cooldown` (`OvertradingGuards.ts:35-90`), and `duplicate_signal` (`RiskEngine.ts:318-339`) are all rolling elapsed-milliseconds windows against `nowMs`. None has any calendar-day or RTH-boundary concept — they behave identically at 4:01am or 3:59pm.

### 7.4 Gate 8 (`daily_loss`) — day boundary already correctly includes premarket

`RiskEngine.ts:446-451` resets the daily-loss baseline (`dayStartEquity`, `currentDailyLoss`) on a `getTradingDateStr()` change — the real **America/New_York calendar date** (`TradingCalendar.ts:22-37`, DST-correct, via `Intl.DateTimeFormat`), not a 9:30am-anchored window. **This means gate 8 already works correctly if Argus starts evaluating risk at 4:00am** — that becomes the day's `dayStartEquity` exactly as a 9:30am first-read would today. No change needed here for premarket support.

---

## 8. Discovery and agent behavior outside RTH

(Full evidence in the accompanying audit; summarized here.)

| Component | Runs premarket? | Evidence |
|---|---|---|
| `MarketUniverseScanner.ts` | Yes, unconditionally | No session term anywhere in the file; two plain `setInterval`s (15min broad-universe, 5min movers) fire regardless of time |
| `OpportunityDiscovery.ts` | Yes, at a slower cadence | Self-reschedules via `isSnapshotScannerRth() ? snapshotScanRthMs : snapshotScanOffHoursMs` (30s RTH vs 300s off-hours) — always runs, never off |
| `TechnicalAgent.ts` | Yes, tick-driven | No session check in `analyzeTick()`; gated only by Autobot/pipeline-enable flags, not time |
| `QuantSignalAgent`/`evaluateAll()` | Yes | No session branch anywhere in the class; daily-bar-driven by design, architecturally session-agnostic |
| `FundamentalAgent.ts` / `MacroAgent.ts` | Yes, fixed ~60s/~75s intervals | No RTH gate in either file |
| `NewsEngine.ts` | Yes, ingests/analyzes premarket at a slower cadence (10s RTH → 300s off-hours), but idea-relevant output is deliberately deferred | `resolveNewsEnginePollMs()` / `NewsCatalystStore.recordNewsCatalyst()`: a HIGH/MODERATE-strength, non-neutral catalyst analyzed outside RTH is recorded `status: 'STAGED_FOR_OPEN'`, not acted on |
| `MarketOpenNewsConfluence` | Deliberately RTH-gated | `if (!isUsEquityRegularSession(now) \|\| this.sessionOpenMs == null) return;` — staged catalysts are only matched against real opening ticks and can only escalate to `emitTradeIdea` after 9:30am |
| `MarketDataWorker` subscription allocator (`maxActiveSubscriptions=12`, `maxConcurrentTemporaryDataRescues=3`) | Yes, with **zero session awareness** | Full-file search: no session term anywhere. Same static caps serve premarket discovery and RTH discovery — real, code-level support for a premarket bottleneck if discovery surfaces more candidates than the pool can hold |
| `ComposableRanking.ts` | Yes, no session-awareness in scoring | Explicitly documents `premarketActivitySeparateFromMinuteBar` as **not implemented**: *"Alpaca IEX snapshot minuteBar is the latest available bar regardless of session — there is no separate premarket-only bar distinguishable from a regular-session minute bar in the feed this deployment uses."* |
| `ChiefTraderAgent.ts` | Yes, purely confidence/timing-based | No session term anywhere; debounce/consensus machinery (`debateTriggerConfidence`, cooldowns, TTL sweep) is entirely elapsed-time-based |

**NewsEngine is the one subsystem deliberately shaped by session** — both in poll cadence and in the `STAGED_FOR_OPEN` deferral mechanism. Everything else either runs identically at any hour, or runs at a slower off-hours cadence with no hard gate.

---

## 9. Reconciliation and emergency stop outside RTH

- **Reconciliation** (`PortfolioReconciliation.ts`): fixed 5-minute wall-clock interval (`portfolioReconciliationMs`), no market-hours dependency anywhere in `reconcile()`. Works identically premarket.
- **Emergency stop** (gate 1, `RiskEngine.ts:272-283`): reads only `tradingEngine.state.tradingState`, zero time-of-day input, always evaluated first. `setTradingState()` has no session dependency. Works identically at any hour.
- **`AutoTradeScheduler`**: default window `09:30`–`16:00` ET, but the underlying HH:MM comparator (`AutoTradeSchedule.ts:13-38`) has no hardcoded RTH restriction — a premarket window (e.g. `04:00`–`09:30`) is already expressible today by changing two settings fields. However, the scheduler's own header comment is explicit that this **only toggles Autobot on/off** — it never widens gate 12, so a premarket schedule window would be a no-op for actual order placement while gate 12 stays RTH-only.
- **No hidden "market must be open" shortcut exists outside RiskEngine's own gate 12** — broad grep found no code path that refuses to attempt/evaluate an order before it reaches the gate ladder. `TradingReadinessGate.ts` is explicitly pure observability (header comment: "never places or blocks an order by itself") and was specifically hardened so premarket "waiting for data" states aren't misreported as failures.

---

## 10. The "Phase 4" continuous-intelligence series — what already exists

This is the most important finding in this audit and directly determines the correct architecture decision (see the companion gap-analysis document).

### 10.1 `ComposableRanking.ts` (Phase 4C, 2026-08-26)

Real, currently-running candidate ranking with **7 named, independently-scored components**: `momentum | relativeVolume | rangeExpansion | gap | liquidity | newsCatalyst | agentConfidence`. Each is `{ score: 0-1 | null, available: boolean, reason?: string }` — a component with no real data source is excluded from the weighted sum, never silently zeroed. `gap` is computed from real `open` vs `prevClose`; `relativeVolume`, `rangeExpansion`, `liquidity` are computed from the same snapshot fields `SnapshotScanner` already fetches.

Explicitly documented as **not implemented, honestly**: `sectorRelativeStrength`, `marketRegimeCompatibility`, `volatilitySuitability`, `historicalSetupQuality`, and — most relevant here — `premarketActivitySeparateFromMinuteBar` (§8 above).

**Critical gap versus the mission's stated requirement (§4/§5 of the mission brief): none of the 7 components call into `quant-core-java`.** This is pure TypeScript arithmetic on snapshot fields. The Java quant engine currently has no path into ranking/discovery scoring at all.

### 10.2 `TradePlanBuilder.ts` (Phase 4E, 2026-08-27)

A real, persisted trade-plan object, built from a `ComposableRanking` cycle:

```ts
export type TradePlanStatus = 'DRAFT' | 'READY' | 'REVALIDATING' | 'VALID' | 'INVALIDATED' | 'EXPIRED' | 'EXECUTED' | 'CLOSED';

export interface TradePlanDraft {
  id, symbol, planDate, setupType /* PRIMARY|BACKUP|WATCHLIST */, direction /* BUY|SELL */,
  thesis /* templated text from component scores */, catalysts: string[],
  entryZoneLow, entryZoneHigh /* from minute bar range, or ±0.5% fallback */,
  invalidationLevel /* minute low/high, or ±2% of prevClose fallback */,
  targetConcept /* free text, not a numeric zone */,
  confidence /* = candidate.finalScore */, evidenceQuality /* fraction of 7 components with real data */,
  rankAtCreation, componentScoresJson, status, createdAt, validUntil /* end of planDate, 16:00 ET */,
}
```

`revalidateTradePlan()` (`TradePlanBuilder.ts:183-213`) implements exactly the mission's requested premarket→RTH revalidation concept: checks expiry, checks for missing current data (→ `INVALIDATED`, never silently kept valid), checks the invalidation level against live price, then re-checks the current ranking cycle's recommendation (`PROMOTE`→`REVALIDATED`, `HOLD`→`DOWNGRADED`, `REJECT`→`INVALIDATED`). Per the discovery-agent audit, this is invoked from `SnapshotScanner.ts:332-343` **only when `marketSession === 'REGULAR'`** — i.e. the open-transition revalidation the mission asks for (§12 of the brief) is **already built and already runs**.

Governance header (`TradePlanBuilder.ts:5-13`), verbatim: *"Discovery/preparation only. Never imports OMS/RiskEngine/ChiefTraderAgent/the order-placement broker layer. Never emits TRADE_IDEA_GENERATED... Whether/how a VALID plan ever re-enters the live pipeline... is a SEPARATE, deliberately NOT-yet-made decision."*

**Real gaps versus the mission's exact requested shape, found by direct field-for-field comparison:**
1. `confidence` and what the mission calls "confluence score" are the **same field** (`candidate.finalScore`) — the mission's brief explicitly says (§15) *"Do not mix these concepts into one opaque number."* This file currently does exactly that.
2. No structured `catalystType`/`catalystStrength`/`sourceReliability` — `catalysts` is free-text strings built from component-score descriptions, not the structured evidence the mission's `PremarketOpportunity` object asks for.
3. `targetConcept` is free text ("Momentum continuation toward the session high"), not a numeric `expectedTargetZone`.
4. No `executionEligibility` field distinct from lifecycle `status` — nothing here yet represents "the evidence is fine but the spread is too wide to execute."
5. Confirmed via the field mapping: there is **no premarket-specific instantiation** of this system — it appears to run from whatever `SnapshotScanner` cycles produce, any session, not a dedicated premarket-only pipeline.

### 10.3 `MissedOpportunityDetector.ts` (Phase 4F, 2026-08-27)

Real, working classification of where a `PROMOTE`-ranked candidate died in the funnel, first-failure-in-order (mirroring RiskEngine's own convention):

```ts
export type MissClassification =
  | 'RANKING_MISS' | 'SUBSCRIPTION_MISS' | 'AGENT_MISS'
  | 'CONSENSUS_REJECTION' | 'RISK_REJECTION' | 'EXECUTION_MISS' | 'NOT_ACTUALLY_MISS';
```

Correctly derives `hadChiefApproval` from `transaction_traces.lifecycleStatus` membership in a real terminal-status set (`CONSENSUS_REACHED`/`RISK_APPROVED`/`RISK_REJECTED`/`ORDER_SUBMITTED`/`FILLED`/`CANCELLED`) — a real bug (row-existence instead of lifecycle-status check) was found and fixed here on 2026-09-04, documented in the file's own header. A `PROMOTE`-recommended candidate that was actually filled is explicitly `NOT_ACTUALLY_MISS`, not a miss.

Same governance discipline: discovery/diagnostics only, never imports OMS/RiskEngine/broker, never emits `TRADE_IDEA_GENERATED`.

### 10.4 The two systems are not integrated

`SnapshotScanner.ts` (which drives `ComposableRanking`/`TradePlanBuilder`/`MissedOpportunityDetector`) calls `classifyMarketSession()` **directly** (`SnapshotScanner.ts:320`) rather than reading `sessionLifecycleWorker.getSnapshot()` from System A. The two systems have never shared state. `SessionLifecycle.ts`'s `ApplicationSessionState` values `PLAN_BUILDING`/`PLAN_READY`/`OPEN_REVALIDATION` — which read as if they were designed specifically to describe what `TradePlanBuilder` does — are declared but never actually set by any code that calls into `TradePlanBuilder`.

Both `CLAUDE.md` and `docs/architecture/SYSTEM_OVERVIEW.md` currently describe "broad-universe candidate ranking, a persisted TradePlan, market-open revalidation" as **"designed but not yet built."** This audit found that framing to be **stale relative to the actual code** for three of those four items — they exist and run in production, just in a different, unrelated module tree, under an unrelated "Phase 4" naming series, dated the day after the doc's own reference point. Only the fourth ("after-close review") genuinely does not exist as described — `MissedOpportunityDetector` classifies funnel drop-off, not a true close-of-day review, and runs unconditionally rather than gated to `AFTER_HOURS`.

---

## 11. Summary answers to the Phase 0 audit questions

| Question | Answer |
|---|---|
| How are market sessions represented today? | Nine independent representations (§2.2); the most complete is `classifyMarketSession()`/`MarketSession`, with no calendar/holiday awareness anywhere |
| How does market data behave outside RTH? | Identically to RTH — `MarketDataWorker` is fully session-blind (§3) |
| Does IBKR paper support required extended-hours order types/routes? | No — `ibkr_gateway` (the active broker) never sets `outsideRth`; only `ibkr_web` accidentally supports it via generic warning auto-confirm (§4) |
| How does Alpaca integration behave? | `extended_hours` flag never set; `MARKET` order type used exclusively, which is incompatible with Alpaca's real extended-hours requirements anyway (§5) |
| Can the current broker adapter submit extended-hours orders? | Not reliably for any broker actually in active use today (§4/§5) |
| Does order validation assume RTH? | No explicit RTH check in OMS, but hardcoded `MARKET` order type is a structural blocker (§6) |
| Does RiskEngine assume RTH liquidity/price behavior? | Gate 12 is RTH-binary live (with a real Alpaca-unconfigured skip-pass gap); gate 13 has a flat, non-session-aware threshold; gates 3/4/6 are pure elapsed-time; gate 8's day boundary already correctly includes premarket (§7) |
| Do stale-data gates understand premarket? | No (§7.2) |
| Does discovery run outside RTH? | Yes, MarketUniverseScanner and OpportunityDiscovery both run premarket (§8) |
| Does MarketUniverseScanner run premarket? | Yes, unconditionally (§8) |
| Does NewsEngine run premarket? | Yes, ingests/scores at a slower cadence; defers idea-eligible output via `STAGED_FOR_OPEN` (§8) |
| Does TechnicalAgent run premarket? | Yes, tick-driven, no session gate (§8) |
| Does QuantEngine run premarket? | Yes, no session gate (§8) |
| Can Fundamental/Macro contribute premarket? | Yes, fixed intervals, no RTH gate (§8) |
| How does subscription allocation behave outside RTH? | Identically to RTH — zero session awareness (§8) |
| Does the 12-stream/rescue architecture bottleneck premarket? | Real, code-confirmed risk — same static caps serve both (§8) |
| How does candidate ranking behave outside RTH? | Identically — `ComposableRanking` has no session term, and explicitly documents premarket-vs-RTH bar distinction as not implementable with the current data feed (§10.1) |
| How does ChiefTrader debounce/consensus behave outside RTH? | Identically — purely confidence/timing-based (§8) |
| Is duplicate-signal protection session-aware? | No — pure elapsed-time window (§7.3) |
| Is position reconciliation session-aware? | No — fixed 5-min interval, works identically (§9) |
| Does the emergency stop work outside RTH? | Yes, unconditionally — reads only `tradingState`, no session dependency (§9) |
| Any "market is open" assumption before order processing? | Only RiskEngine's own gate 12, no hidden pre-gate shortcut found (§9) |

---

*Companion document: `docs/architecture/ARGUS_PREMARKET_GAP_ANALYSIS.md` (gap analysis, architectural decision, and phased plan).*
