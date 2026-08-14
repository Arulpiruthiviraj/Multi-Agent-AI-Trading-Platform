# FINAL_APPLICATION_STATE_ANALYSIS.md

**Analysis only. No code was modified in the production of this document.**

**Method:** Three parallel read-only research passes (AI-agent config/cost, order-lifecycle/calculation-engine edge cases, EventBus/DB-race/security), each independently verifying claims against current source with file:line citations — combined with direct knowledge of this session's own prior implementation work (13 widgets wired to real data this session; full change log in `git log`/prior turns) and the repository's own existing audit trail (`CLAUDE.md`, `FINAL_ANALYSIS.md`, `CURRENT_STATE_BASELINE.md`), cross-checked rather than assumed current. Every claim is either **[FACT]** (confirmed against current source or a command I ran), **[INFERENCE]** (a reasonable conclusion from code structure, not directly stated), or **NOT VERIFIED** (cannot be confirmed without running the live system against real market/broker conditions).

---

# Executive Summary

Argus is a real, substantially-working, event-driven multi-agent paper-trading platform. The backend pipeline (market data → agents → consensus → risk → execution → persistence) is genuinely wired end-to-end, not a mockup — confirmed via real, non-mocked integration tests this pass and prior sessions. Frontend truth-wiring work this session fixed 13 previously-fabricated widgets across 8 tabs (real backend, real tests, zero trading-logic changes).

**This pass's new findings, not previously documented anywhere in this repository:**
1. **Two genuine TOCTOU races exist in `RiskEngine.ts`** — the peak-equity drawdown baseline and the order-rate-limit counter are both check-then-act reads with no transaction/lock, and `RiskAgent.assessRisk()` invokes `RiskEngine.evaluateRisk()` fire-and-forget with no queue, so concurrent `CHIEF_APPROVED_IDEA` events (a real, possible scenario: `ChiefTraderAgent` and the manual-override route both emit this event) can race past the order-rate-limit gate.
2. **Order lifecycle has three real, unaddressed gaps**: no cancellation logic exists anywhere in `OrderManagementService`; partial fills are structurally unhandled (dead code path that would misreport fill quantity if a real broker ever returned one); and an order stuck at `PENDING` after the 4-second fill-poll window is never revisited — it sits in that state indefinitely, corrected only indirectly (and only at the position level, not the order level) by the 5-minute portfolio reconciliation cycle.
3. **The daily-loss circuit breaker resets at UTC midnight, not exchange-time midnight** — several hours off from the real NYSE trading day boundary.
4. **A real secret-leak vector**: `FundamentalAgent.ts`, `MacroAgent.ts`, and two news providers pass API keys as URL query parameters; a `fetch` failure's caught error (logged via `console.error`) can carry that full URL, including the key, into server logs.
5. **Events emitted while a WebSocket client is disconnected are lost to that client** — durable backfill endpoints exist (`/api/v2/system/events`, `/api/v2/transactions`) but nothing in the frontend calls them on reconnect.
6. **FundamentalAgent/MacroAgent's 24h cache gates only the raw AlphaVantage fetch, not the LLM call** — when upstream data gates pass, an AI call fires every single tick (up to 1440/day for FundamentalAgent, 1152/day for MacroAgent) even when re-analyzing byte-identical cached data.
7. **The per-agent AI model-override mechanism is silently broken for 3 of 4 provider types** — `GeminiProvider`, `OpenAIProvider`, and `DeepSeekProvider` all hardcode their model and ignore any `options.model` AIRouter passes; only `OpenAICompatibleProvider` honors it.

None of these are new regressions from this session's own changes (verified: this session's 13 widget-wiring changes and 8 new routes are all read-only `GET`s except none that mutate trading state) — they are pre-existing conditions surfaced by this pass's deeper research.

**No statistically validated trading edge has been demonstrated anywhere in this codebase.** This is unchanged by anything in this document.

---

# Current Architecture

**[FACT]**, unchanged from `CURRENT_STATE_BASELINE.md`'s architecture diagram, re-confirmed this pass:

```
Alpaca WS → MarketDataWorker (single source, no dedup, no gap detection on reconnect)
  → TechnicalAgent / NewsEngine / FundamentalAgent / MacroAgent / KronosForecastAgent
  → TRADE_IDEA_GENERATED → ChiefTraderAgent (weighted consensus + optional parallel AI debate)
  → CHIEF_APPROVED_IDEA → RiskAgent (fire-and-forget, unqueued) → RiskEngine (11 gates, 2 with real TOCTOU races)
  → RISK_ASSESSMENT_COMPLETED → OrderManagementService (poll-only, no cancel, no partial-fill handling)
  → BrokerManager → real broker → ORDER_EXECUTED
  → EventBus wildcard → WebSocket (no reconnect backfill) → React SPA
```

Single Node process, single SQLite file (WAL mode, synchronous native driver wrapped in Promises — see Database section for the concurrency implications this has).

---

# Application Capability Matrix

**[FACT unless noted]** — Status legend: ✅ Working · ⚠️ Partially working · ❌ Broken · 🟡 Mocked/simulated · 🔵 Planned, not implemented · 🔴 Dangerous for live trading.

| Capability | Status | Evidence |
|---|---|---|
| Alpaca market data ingestion | ✅ | `MarketDataWorker.ts` — real WS, but ⚠️ no duplicate-tick protection, no gap detection on reconnect (see Data Quality) |
| TechnicalAgent (RSI/MACD/SMA/Bollinger) | ✅ | Real math; SMA/Bollinger's length guards are dead code given the caller's fixed-50-tick gate (see Calculation Engine section) |
| NewsAgent pipeline | ✅ (core), ⚠️ (no AI-output cache) | Real local-first FinBERT gating; LLM call fires per non-decisive article, no memoized re-score protection beyond article-level dedup |
| FundamentalAgent / MacroAgent | ⚠️ | Real when AlphaVantage+Gemini keys configured; 🔴-adjacent cost waste: LLM call fires every tick even on cache-served identical data (new finding #6) |
| KronosForecastAgent | ✅ | Real local Chronos service calls; 2 of its own events (`KRONOS_REVERSAL`/`KRONOS_BREAKOUT`) are dead code (pre-existing finding, unchanged) |
| ChiefTraderAgent consensus + AI debate | ✅ | Real weighted vote; real parallel multi-provider debate fan-out when `adversarialDebateMode` (default `true`) and confidence > 0.6 |
| RiskEngine (11 gates) | ⚠️ | All 11 real and gate-recorded; 🔴 2 gates (`portfolio_drawdown`, `order_rate_limit`) have real TOCTOU races under concurrent evaluation (new finding #1) |
| OrderManagementService | ⚠️ | Real idempotent-by-traceId placement (but check-then-act, not DB-constrained — see Order Lifecycle); ❌ no cancellation logic; ❌ partial fills structurally unhandled |
| Portfolio Reconciliation | ✅ | Real, confirmed this pass: 5-minute interval, real $100 dollar-impact threshold, genuinely sets `tradingEngine.state.emergencyStopActive` which `RiskEngine`'s first gate reads — this is a real, working safety mechanism, not just a log line |
| Broker adapters (Alpaca/Internal/IBKR/Questrade/Coinbase) | ✅/🔵 | Per broker capability, unchanged from prior audits |
| EventBus / WebSocket | ⚠️ | Real, ordered (for synchronous listeners), no duplicate delivery within one connection; ❌ events lost on client disconnect, no reconnect backfill (new finding #5) |
| Database persistence | ✅ | Real 41-table schema (per `CURRENT_STATE_BASELINE.md`), WAL mode; ⚠️ two real TOCTOU races (new findings, see Database section) |
| Frontend — 13 widgets (this session) | ✅ (newly) | Real backend, real tests — see Frontend/UI section for the full before/after list |
| Frontend — Mission Control module toggles | 🔴 | Confirmed still fully local-state-only (no backend call) — explicitly not touched this session per its own HIGH-RISK classification |
| Frontend — Trading Arena risk-decomposition widget, Learning tab's Kelly/RL-pipeline sections | 🟡 | Explicitly deferred this session as too large for incremental scope; still fabricated |
| AI cost controls | ⚠️ | Real per-call cost tracking exists; 🔴 no cache prevents redundant same-data LLM calls (new finding #6); model-override broken for 3/4 provider types (new finding #7) |

---

# Functionality Freeze / Do Not Break

**[FACT]** Reproduced and extended from `CURRENT_STATE_BASELINE.md` §24, with this pass's new-finding context added where it changes the risk calculus.

| Feature | Implementation | Depends on it | Must not change without approval |
|---|---|---|---|
| RiskEngine's 11-gate, always-evaluate-everything design | `RiskEngine.ts:104-360` | Every real trade, `risk_assessments`/`risk_gate_results` audit trail | 🔴 **MUST NOT CHANGE.** Note: the 2 TOCTOU races found this pass (peak-equity, order-rate-limit) are a reason to *harden*, not to restructure the gate ladder itself. |
| OrderManagementService idempotency-by-traceId | `OrderManagement.ts:56-67` | Prevents duplicate broker orders | 🔴 **MUST NOT CHANGE**, but note it is itself a check-then-act race (new finding) — any fix must preserve the existing guarantee for the non-race case while closing the race, not weaken either. |
| Portfolio Reconciliation's $100 threshold + `emergencyStopActive` | `PortfolioReconciliation.ts:20,116-121` | Confirmed this pass to be a real, working kill mechanism | 🔴 **MUST NOT CHANGE** the threshold or the mechanism without explicit review — this is one of the system's few genuinely-verified automatic safety interventions. |
| `AuthConfig.ts`'s fail-fast startup guard | `AuthConfig.ts` | Prevents unauthenticated production boot | 🔴 **MUST NOT CHANGE** |
| Event payload shapes (`TRADE_IDEA_GENERATED`/`CHIEF_APPROVED_IDEA`/`RISK_ASSESSMENT_COMPLETED`/`ORDER_EXECUTED`) | `EventBus.ts` + emitters | `TransactionLifecycleTracker`, `EventStore`, WS wildcard broadcast, frontend `subscribe()` calls | 🔴 **MUST NOT CHANGE** |
| The 13 real routes added this session (`/api/v2/agents/efficiency`, `/ai/token-consumption`, `/opportunities`, `/portfolio/risk-attribution`, `/portfolio/stress-test`, `/portfolio/pnl-by-symbol`, `/agents/learning-summary`) | `v2System.ts` | This session's rewired frontend components | 🟡 CHANGE ONLY WITH APPROVAL — additive, low interdependency, but frontend now depends on their exact response shape (`{ok, available, data, reason?}`). |
| `resolveDbDir.ts`'s Windows-never-considers-`/data` logic | `resolveDbDir.ts` | Correct DB file location on this machine | 🔴 **MUST NOT CHANGE** |

---

# Complete Trading Pipeline

**[FACT]**, stage-by-stage, incorporating this pass's new findings:

| Stage | Real or mocked | Deterministic? | Async? | Can fail? | Failure handling | Retry? | Duplicate-exec possible? | Stale-data possible? |
|---|---|---|---|---|---|---|---|---|
| Market data (Alpaca WS) | Real | N/A | Yes | Yes (disconnect) | Reconnect after fixed 5s delay | Yes (reconnect loop), but **no gap-fill/sequence tracking** — a missed tick during reconnect is silently lost, not detected | **No duplicate-tick protection at all** (new finding) | Yes — `RiskEngine`'s `data_freshness` gate is the only staleness check, and it's post-hoc (after signal generation) |
| TechnicalAgent | Real math | Yes | Sync per tick | No (guarded) | N/A | N/A | Would double-count a duplicate tick if one arrived (no protection) | No local staleness check; relies entirely on upstream ticks arriving |
| NewsAgent | Real (local-first + LLM escalation) | No (LLM output) | Yes | Yes (LLM call failure) | Caught, logged, `aiAnalysis = null`, no trade idea emitted for that article | No retry within `routeTask` for that provider; failover to next provider only | Article-level dedup only, not AI-response caching | N/A (not price-based) |
| Fundamental/MacroAgent | Real (when configured) | No (LLM output) | Yes | Yes | Caught, logged, tick ends silently | No retry, no fallback value | LLM call fires every tick when gates pass, **even on identical cached data** (new finding) | N/A |
| ChiefTraderAgent consensus | Real weighted vote + optional real parallel AI debate | Partially (LLM debate is not) | Yes, fire-and-forget for the debate | Yes | Debate failure logged, falls through to consensus without the extra evidence | No retry of the whole debate | N/A | N/A |
| RiskAgent → RiskEngine | Real | Mostly (2 gates have real races) | **Fire-and-forget, no queue** (new finding) | Yes (any gate) | All 11 gates always evaluated and recorded | No retry — a crashed evaluation is caught and recorded as rejected | **Two gates have real TOCTOU races under concurrent invocation** (new finding #1) | `data_freshness` gate exists but only catches symbols with a prior tick — a symbol with zero ticks ever passes silently |
| OrderManagementService | Real | No (broker response) | Yes | Yes | REJECTED status set on any broker-call exception, conflating "broker rejected" with "call failed" | **No cancellation, no partial-fill handling, no retry after the 4s poll window gives up** (new finding #2) | Idempotency check exists but is check-then-act (new finding) | N/A |
| Broker | Real (Alpaca/paper) or partial (IBKR/Questrade read-only/Coinbase) | No | Yes | Yes | Per-adapter | Only `OpenAICompatibleProvider`-style retry exists for AI calls, not broker calls | N/A | Buying power/equity is fetched fresh on every `RiskEngine` evaluation — **not stale/cached** (confirmed this pass) |
| Portfolio Reconciliation | Real | Yes | Yes, 5-min interval | Yes | Logged, persisted; **real emergency-stop trip confirmed** past $100 impact | Runs again next cycle | Re-entrancy: **no guard against a slow reconcile() overlapping the next scheduled tick** (new finding) | By design — up to 5 minutes of possible local/broker divergence is intrinsic to the architecture |
| EventStore / WebSocket | Real | Yes (sync dispatch) | Yes | Yes (disconnect) | Client-side exponential backoff reconnect (1s→30s cap) | Yes, client-driven | No duplicate delivery within one connection | **Events during disconnect are lost, no backfill on reconnect** (new finding #5) |

**AI hallucination → invalid trade risk:** **[FACT]** Confidence values from FundamentalAgent/MacroAgent/NewsAgent's escalated path are taken directly from the LLM's own JSON output with no independent verification (confirmed in prior session's research, re-confirmed this pass's prompt-structure findings — none of the three prompts include any confidence-calibration instruction). The real, independent backstop is `RiskEngine`'s gate ladder, which does not look at *how* a confidence value was derived — an overconfident hallucination can still pass consensus and reach RiskEngine, where it is sized/gated like any other proposal. `ConfidenceCalibration.ts`'s Beta-Binomial correction (built in a prior session) mitigates this for agents with real evaluated history, but a brand-new hallucination pattern with no track record yet passes uncorrected.

**Kill switch / circuit breaker inventory, real and confirmed:** emergency stop (manual + auto via reconciliation), daily-loss (UTC-midnight-boundary bug, new finding #3), consecutive-loss, portfolio-drawdown (has the TOCTOU race, new finding #1), order-rate-limit (has the TOCTOU race, new finding #1).

---

# AI Agent Analysis

**[FACT]**, from this pass's dedicated research (file:line citations preserved in full in the underlying research; summarized here).

| Agent | Model selection | Config (temp/etc.) | Output validation | Malformed-response handling | Cost-relevant real gates |
|---|---|---|---|---|---|
| NewsAgent (`NewsScoringEngine.ts`) | AIRouter failover pick; `jsonMode:true` | None (no temperature anywhere in the codebase) | None beyond `JSON.parse` | Catch → log → return `null` → no trade idea, `NEWS_ANALYZED` still fires with `aiAnalysis:null` | Only escalates when FinBERT is unavailable or non-decisive (`|sentiment| < 0.6`) — the only agent with real local-first cost gating |
| FundamentalAgent | AIRouter failover pick; no jsonMode | None | None | Catch → log → tick ends silently | **LLM call fires every 60s tick when data gates pass, regardless of whether the underlying AlphaVantage data is fresh or 24h-cached** (new finding) |
| MacroAgent | AIRouter failover pick; no jsonMode | None | None | Same as Fundamental | Same caching gap, every 75s tick |
| ChiefTraderAgent debate | Every enabled, live provider, in parallel | None | Per-provider JSON parse failure falls back to keyword-sniffing (`"BUY"`/`"SELL"` substring match), not a hard failure | Whole-debate failure (e.g., zero providers) is caught, logged, falls through without the debate's evidence | Fires per qualifying `TRADE_IDEA_GENERATED` (confidence > 0.6, `adversarialDebateMode` true, default true) — **cost multiplies by live-provider count per debate**, no cache |

**Consensus mechanism, confirmed [FACT]:**
- `EvidenceAggregator` already excludes `HOLD`/confidence-0 ideas from both vote arms (prior session, re-verified via regression test).
- `ChiefTraderAgent.calibrateConfidence()` applies real Beta-Binomial correction per agent per confidence bucket before voting (prior session).
- **One agent cannot unilaterally dominate by design** — weighted vote requires `weightedConfidence > 0.75` threshold, and the debate (when triggered) is a separate parallel fan-out folded in as one more evidence source, not an override.
- **The Chief Trader cannot override RiskEngine** — `CHIEF_APPROVED_IDEA` only reaches `RiskAgent`, which always calls the full 11-gate `RiskEngine.evaluateRisk()`; there is no path from ChiefTraderAgent directly to `OrderManagementService`. **[FACT, confirmed by tracing every real emitter of `CHIEF_APPROVED_IDEA`: `ChiefTraderAgent.ts` and the manual-override route in `v2System.ts` — both go through `RiskAgent`.]**

**System behavior when an AI agent is unavailable:** **[FACT]** FundamentalAgent/MacroAgent degrade to `HOLD`/confidence:0 (`DATA_UNAVAILABLE`), which `EvidenceAggregator` already excludes from voting — the system is safe (doesn't crash, doesn't fabricate a signal) but silently loses that agent's input to consensus. NewsAgent's local-first path means a FinBERT-only signal still reaches consensus even if every paid/local LLM provider is down — genuinely resilient for that one path.

---

# Calculation Engine Analysis

**[FACT]**, from this pass's dedicated research.

| Engine | Insufficient-data guard | Timezone handling | Duplicate-tick protection | Stale-data check | Market-hours check |
|---|---|---|---|---|---|
| RSIEngine | Explicit — returns neutral 50 | N/A (tick-based) | None | None | None |
| MACDEngine | Explicit — returns zeros | N/A | None | None | None |
| TechnicalAgent SMA | Explicit guard exists but is **dead code** — the caller only ever invokes it once `history.length === 50`, exactly matching both period requirements | N/A | **None** — a duplicate tick would double-count in the rolling window | None | None |
| TechnicalAgent Bollinger Bands | **No internal guard** at all (relies on the same dead-code-protected call site) | N/A | Same as SMA | None | None |
| PositionSizing correlation math | Explicit — returns `null` on insufficient overlap or zero variance | N/A | N/A | N/A | N/A |
| PositionSizing sizing math | **No internal zero/negative-price guard** — relies entirely on `RiskEngine`'s upstream `price_validity` gate | N/A | N/A | N/A | N/A |

**New finding, MACD EMA seeding:** `MACDEngine.calcEMA()` seeds the first EMA value as the raw first price rather than an SMA-seeded average — a real, minor deviation from textbook EMA math that skews early-window values (this is an existing, not newly-introduced, deviation — flagged as **NOT previously documented**).

**Timezone handling, real finding:** **[FACT]** `RiskEngine.ts`'s daily-loss "start of day" boundary uses `new Date().toISOString().split('T')[0]` — **UTC**, not exchange time. The daily-loss baseline resets at 00:00 UTC (roughly 8-9pm US Eastern the prior evening depending on DST), hours before the actual NYSE session begins or the prior session even fully closes. **No exchange-timezone-aware code exists anywhere in the calculation engines** — confirmed via repo-wide search, zero matches for `America/New_York` or equivalent.

**Duplicate-candle protection:** real for historical/backtest bars (`onConflictDoNothing()` on a composite `symbol:timeframe:timestamp` id) — **absent entirely for the live tick path** feeding `TechnicalAgent`.

**Market-hours / staleness:** both checks exist only at `RiskEngine`'s gate level, post-hoc, after signal generation has already happened. With no Alpaca credentials configured, the market-hours gate is skipped entirely (returns `null`, which the gate logic treats as "pass").

---

# Broker Integration Analysis

**[FACT]**, from this pass's dedicated research, superseding the shallower treatment in prior documents.

**Market data:** real Alpaca WS, single source, no gap detection on reconnect (see Data Quality).

**Order creation:** real per-broker `placeOrder()`. **REJECTED status conflates two distinct real conditions** — a genuine broker rejection and an HTTP/network failure calling the broker both land as the same `"REJECTED"` string, with no field distinguishing them.

**Order tracking / status retrieval:** **polling only, no webhook, no broker push.** `pollForFill()` polls every 400ms for up to 4 seconds total, then gives up. If the order is still `PENDING` at that point, **it is never revisited** — the trade row stays `PENDING` forever unless a human or an unrelated process notices. This is a real, previously-undocumented gap.

**Partial fills:** the `Order` type and DB schema both model `PARTIALLY_FILLED`, but `OrderManagementService` has no branch for it — a real partial fill from Alpaca would fall through the same path as a still-pending order (no `filledAt`, no `fills` row, no `ORDER_FILLED` event) while still being persisted with a materially wrong `quantity` in the theoretical fills-insert path. **Currently unreachable in practice** (the paper broker never produces `PARTIALLY_FILLED`), but this is live code that would misbehave the first time a real Alpaca partial fill occurs.

**Order cancellation:** **no cancellation logic exists anywhere in the reviewed order-lifecycle code.** `cancelOrder()` exists on the broker adapter interface and is implemented per-broker, but `OrderManagementService` never calls it, under any condition (no timeout-triggered cancel, no manual-cancel route wired to it in this flow).

**Duplicate-order prevention:** a real check exists (`SELECT` by `traceId` before insert) but is **application-level check-then-act, not a database constraint** — `trades.traceId` has no unique index. Two near-simultaneous `executeOrder()` calls for the same `traceId` could both pass the check before either inserts. **If the guard query itself throws, the code proceeds without the check at all** — a DB error fails open, not closed.

**Buying power / account equity freshness:** **[FACT, confirmed real-time, not stale]** `RiskEngine` calls `broker.portfolio()` fresh on every single risk evaluation — for Alpaca this is two real REST calls (`/v2/account`, `/v2/positions`) every time, no caching. The only cached values in `RiskEngine` are the market clock and correlation-closes lookback (both 60s TTL) — buying power and equity are not among them.

**Can internal state diverge from broker state? Yes, by design, genuinely possible — not just theoretical:**
- Reconciliation runs every 5 minutes.
- No live push updates local state between cycles.
- An order that times out of the 4-second fill-poll stays `PENDING` locally indefinitely, even after it actually fills on the broker side — reconciliation corrects the aggregate *position* on its next cycle but **never corrects the stale `trades` row itself**.
- Any broker-side action outside Argus (manual fill, liquidation, corporate action) is invisible until the next reconcile.
- **Recommended reconciliation mechanism** (already exists and is real, confirmed working): broker is treated as source of truth, local `portfolio` rows are overwritten on divergence past a real, tested threshold — this part of the design is sound; the gap is the *order*-level (not position-level) staleness described above.

---

# Portfolio & Reconciliation Analysis

**[FACT]**, confirmed directly against `PortfolioReconciliation.ts` this pass (supersedes any prior "NOT VERIFIED" caveat on this mechanism):

- Interval: every 5 minutes, plus one immediate run on `start()`.
- Compared fields: **positions only** — per-symbol `quantity` (0.001 tolerance) and existence (missing locally/missing remotely). `averagePrice` is compared only to decide whether to overwrite, not counted as a "mismatch." **Cash, equity, and buying power are never compared** — reconciliation is positions-only.
- Broker is always authoritative; every local mismatch is overwritten.
- **The $100 dollar-impact threshold and the resulting `emergencyStopActive=true` trip are both real** — this is a genuine, working automatic safety mechanism, not a log-only feature (independently confirmed by tracing that `RiskEngine`'s first gate reads exactly this flag).
- **No accumulation logic** — each 5-minute cycle's worst impact is evaluated independently; a string of sub-$100 mismatches never trips the breaker.
- **No automatic reset** — once tripped, nothing in this file clears it; this requires manual intervention (the existing `/system/resume` endpoint).
- **Re-entrancy gap (new finding):** no guard prevents a slow `reconcile()` run from overlapping the next scheduled 5-minute tick.

---

# Risk Management Audit

**[FACT]**, ranked by severity, incorporating this pass's new findings alongside the already-known 11-gate inventory.

| Issue | Rank | Evidence | Real risk scenario |
|---|---|---|---|
| **Order-rate-limit gate TOCTOU race** | **CRITICAL** | `RiskEngine.ts` counts `risk_assessments` rows in the last 60s before its own row is inserted; `RiskAgent` invokes `evaluateRisk()` fire-and-forget, unqueued | N concurrent risk evaluations (plausible: `ChiefTraderAgent` + the manual-override route both emit `CHIEF_APPROVED_IDEA`) can all read the same count and all pass the rate limit simultaneously, collectively exceeding the configured cap |
| **Portfolio-drawdown peak-equity TOCTOU race** | **HIGH** | Same read-then-conditionally-write pattern on `settings.peakEquity`, no lock, no optimistic-concurrency check | Two concurrent evaluations computing from different equity snapshots can race to write the settings row; the later write wins regardless of which reflects more current equity |
| **Order stuck at PENDING indefinitely after 4s poll timeout** | **HIGH** | `OrderManagement.ts` gives up polling after 4s with no further follow-up | A slow-to-fill order is invisible to any further code path except the position-level (not order-level) reconciliation, up to 5 minutes later |
| **No order cancellation path** | **MEDIUM** | Confirmed absent entirely | A stuck/unwanted order cannot be canceled by any Argus code path — only manually, outside the app |
| **Partial fills structurally unhandled** | **MEDIUM** (currently dormant — only the paper broker is live, and it never partial-fills) | Dead-but-live code path | The first real Alpaca partial fill would misrecord quantity and never reach a terminal `FILLED` state cleanly |
| **Daily-loss reset boundary is UTC midnight, not exchange midnight** | **MEDIUM** | `RiskEngine.ts`'s `todayStr` computation | Daily-loss baseline resets hours before/after the real trading day, weakening the breaker's intended daily-window semantics |
| **Duplicate-order idempotency is check-then-act, fails open on DB error** | **MEDIUM** | `OrderManagement.ts:56-67` | A DB hiccup during the idempotency check silently disables the guard for that call rather than blocking |
| Existing 11-gate ladder itself | Otherwise sound | Confirmed always-evaluate, real thresholds, real DB persistence | — |

**Emergency kill switch:** real, confirmed working (manual + automatic via reconciliation). **Circuit breakers:** real for daily-loss/consecutive-loss/drawdown/order-rate (2 of these 4 have the TOCTOU races above). **Broker/API failure handling:** fails safe (doesn't crash, doesn't fabricate a fill) but with the stuck-PENDING gap above.

---

# Market/Data Quality Audit

**[FACT]**

| Data source | Real or mock | Known gaps |
|---|---|---|
| Alpaca market data | Real | No duplicate-tick protection, no gap detection/backfill on WS reconnect |
| Historical bars (backtest) | Real, cached | Real dedup via composite-key `onConflictDoNothing()` |
| News (RSS + 4 API providers) | Real | Article-level dedup only, no AI-response cache |
| AlphaVantage fundamentals/macro | Real when configured | 24h cache gates only the raw fetch, not the downstream LLM call (cost/redundancy issue, not a correctness one) |
| AI-generated confidence/reasoning | Real LLM output, unvalidated | No schema/type validation beyond `JSON.parse`; a syntactically-valid but semantically-wrong response passes through uncaught |

**Timestamps:** bar timestamps are raw epoch ms, timezone-agnostic by storage but timezone-**unaware** by the code that consumes them for day-boundary logic (see Calculation Engine section's UTC-midnight finding).

---

# EventBus/WebSocket Analysis

**[FACT]**, from this pass's dedicated research.

- **No duplicate delivery within a single connection** for a single `emit()` call — confirmed via direct read of the wildcard-forwarding mechanism.
- **`MARKET_DATA` effectively double-fires as two related event types** (`MARKET_DATA` and `MARKET_DATA_UPDATED`) per tick via `emitMarketData()` — not a bug, but worth knowing when reasoning about event volume.
- **Ordering is guaranteed for synchronous listener invocation start, not for async completion** — Node's EventEmitter dispatches listeners synchronously in registration order, but many real listeners (`OrderManagementService`, `RiskAgent`) are `async` and not awaited by the emitter, so a later event's listeners can start (and finish) before an earlier event's async listener chain completes.
- **Events during client disconnect are lost to that client** — durable backfill exists server-side (`event_traces` table, `/api/v2/system/events`, `/api/v2/transactions`) but the frontend's `WebSocketContext.tsx` does not call any backfill endpoint on reconnect; the UI only resumes from whatever arrives after reconnection completes.
- **Frontend reconnection is real**: exponential backoff (1s→30s cap), client-driven 5s heartbeat with a 15s no-pong force-close-and-reconnect.
- **No server-side re-check of WebSocket auth after the initial handshake** — a revoked session (logout) does not close an already-open socket; it remains live until the client's own heartbeat timeout or disconnect.
- **Listener-leak risk is real but bounded**: `EventBus.setMaxListeners(50)`; the only per-connection listener (the wildcard forwarder) is cleaned up on close, but more than 50 concurrent open WebSocket connections would trigger Node's `MaxListenersExceededWarning` on the wildcard channel specifically — there is no cap on total concurrent WS connections, only a rate limiter on new-connection creation.

---

# Database & Persistence Analysis

**[FACT]**

- `better-sqlite3` is a synchronous native binding; Drizzle wraps it in Promise-returning calls, but **individual statements are atomic while multi-statement read-modify-write sequences are not** — an `await`ed `select` yields the event loop, allowing another async handler's `select` to interleave before the first's `update` runs. This is the root cause of both TOCTOU races documented above (peak-equity, order-rate-limit).
- **A third read-then-write pattern exists in dead code**: `executeAutoBotTradeInSovereign` (`server.ts`) does the same unguarded read-then-conditional-write on the `portfolio` table — confirmed via repo-wide grep to be defined but never called anywhere. Not a live risk today, but the pattern would reintroduce a real race if ever wired up.
- **Can the DB answer "why did the system make this trade?"** — **[FACT] Yes, largely.** `transactions` → `consensus_decisions` → `consensus_evidence` → `risk_assessments` → `risk_gate_results` → `trades` → `fills`, all joined by `transactionId`, assembled in full by `GET /api/v2/transactions/:id`. The one real gap (documented in prior sessions, unchanged): `ai_calls` (the full prompt/response ledger) is not cross-referenced from that same transaction-assembly endpoint, so the AI reasoning behind a decision is retrievable but not pre-joined into the one-stop replay view.
- Schema: 41 tables (not 27 as `CLAUDE.md` currently states — a pre-existing documentation staleness, unchanged this pass).

---

# Frontend/UI Analysis

**[FACT — this session's own implementation work, directly verified via the diffs made]**

13 widgets fixed this session, each with a real backend route + real isolated-DB integration test:

| Widget/tab | Before | After |
|---|---|---|
| Settings — Token Consumption panel | Hardcoded `mockTokenConsumptionData`, literal `$65.42` | Real `ai_calls`-derived local/paid token split + real cost projection |
| Validation tab | `(Date.now() % 1000/1000) > 0.1` fake RNG "tests" | Real `IntegrityValidator` structural checks |
| Agent Network — ROI/comparison widget | Fixed fake sharpe/drawdown/wins, invented "SentimentAgent" | Real `agent_performance_stats` data; **also fixed a real pre-existing bug** where a snake_case/camelCase field mismatch silently zeroed every number in `AgentComparisonModal` |
| Opportunity Feed tab | 3 hardcoded NVDA/TSLA/RIVN cards, fake "LIVE SCAN ACTIVE" badge | Real high-confidence `agent_predictions`, real 24h window |
| Trading Arena — drawdown chart | Fixed 14-point fake "unprotected vs mitigated" series | Honest not-implemented state (no real counterfactual simulation exists) |
| Trading Arena — RiskAttributionTreemap | Fixed 5-entry invented per-agent risk % | Real notional exposure per symbol, real sector map |
| Holdings — Stress Testing panel | Identical output regardless of scenario clicked | Real what-if calculator against real positions + real RiskEngine drawdown-gate threshold |
| Trading Arena — StrategyProfitSunburst | Invented strategy taxonomy, `Date.now()`-jittered values | Real P&L by symbol, real horizon filter |
| Learning & Evolution — top KPIs + scorecard | Fabricated "Mistakes Corrected"/"Alpha by RL", invented strategy names | Real agent weights/win-rates + real `learned_rules` text |
| Trading Arena — agent-node sparklines/export | Fake per-symbol dominant-agent + fabricated JSON export | Removed; real fields preserved |
| Deployment tab | Real-but-generic self-assessment quiz only | Added a distinct real Argus system-integrity check alongside it |
| VEC Event Memory — VectorClusteringMap | 12 hardcoded fake historical-crisis points | Honest not-implemented state (no real embedding infra exists) |
| Trading Arena — Market Historian widget | Fully canned response behind a fake `setTimeout` | Honest not-implemented state |

**Explicitly deferred, still fabricated:** Trading Arena's ~300-line risk-decomposition widget (interactive weight sliders over `Date.now()`-seeded data); Learning & Evolution's Kelly-sizing learner, RL post-mortem pipeline, and fake backtest-comparison sections; Mission Control's Granular Module Toggles (HIGH RISK, Change Plan presented, not implemented, awaiting explicit approval).

**Precise current tab-by-tab tally: NOT VERIFIED this pass.** A fresh full re-scan of all 20 tabs was not performed in this research round (the prior session's `CURRENT_STATE_BASELINE.md` tally of 7/20 fully real predates this session's 13 fixes). Several tabs likely flipped to fully-real as a side effect (Validation, Opportunity Feed, and possibly Settings/Holdings/Memory if no other fabricated widget remains in each), but this is **inferred, not confirmed** — stating a new precise count without re-verification would violate this document's own evidence standard.

---

# Testing & Regression Analysis

**[FACT]** 50 test files / 326 tests as of this session's last full run, all passing, stable across 3 consecutive runs. 33 of those tests are new this session (8 new files, one per new backend route), all real isolated-DB integration tests (not mocked).

**Testing priority matrix, gaps identified this pass:**

| Priority | Area | Test coverage | Gap |
|---|---|---|---|
| 1 | Trading calculations | ✅ Real unit tests exist (RSI, MACD, position sizing) | No test exercises the dead-code SMA/Bollinger length guards, and no test covers the duplicate-tick scenario (because no protection exists to test) |
| 2 | Risk controls | ✅ Extensive gate tests exist | **No test exercises the two TOCTOU races found this pass** — concurrent `evaluateRisk()` calls are not simulated anywhere in the suite |
| 3 | Order creation | ⚠️ `OrderManagement.test.ts` uses `vi.mock`, not real integration | No test covers partial fills, cancellation (because no code exists), or the 4s-poll-timeout-then-abandoned scenario |
| 4 | Broker integration | ✅ Adapter contract tests exist | Real order-status-polling timeout behavior not tested |
| 5 | Portfolio reconciliation | ✅ Real test exists, confirms the $100/emergencyStop mechanism | Re-entrancy (overlapping reconcile() runs) not tested |
| 6 | Agent decision pipeline | ✅ Real integration test exists (`marketDataToRisk.test.ts`) | Does not cover the AI-debate fan-out path |
| 7 | Data integrity | ⚠️ Partial | No test for the WS-disconnect-loses-events gap |

---

# Security Analysis

**[FACT]**, from this pass's dedicated research — new findings not in any prior document.

- **Real secret-leak vector**: `FundamentalAgent.ts`, `MacroAgent.ts`, `AlphaVantageNewsProvider.ts`, `FMPNewsProvider.ts` all pass their API key as a URL query parameter (`?apikey=...`). Each wraps its fetch in a try/catch that logs the raw caught error via `console.error`. A network-failure error object's `cause`/`message` chain can carry the full request URL — **including the key** — into server logs. No broker adapter was found to have this pattern (all send credentials via headers).
- **No CORS policy configured at all** — no `cors` package, no manual `Access-Control-Allow-Origin` headers anywhere. Express's default (no CORS middleware) means cross-origin browser reads are blocked by same-origin policy by default; this is not itself a vulnerability, but it means there is no deliberate, reviewed CORS policy either way.
- **Input validation is real but inconsistent across routes** — `POST /settings` uses a field allowlist (key-presence only, no type checking); `POST /brokers` allowlists most fields but spreads `...rest` unvalidated into the DB write; `POST /system/toggle` validates nothing; the `POST /trading/execute-override` route built this session is the one example of real type+enum validation before use.
- **No server-side re-check of WebSocket session validity after the initial handshake** — a revoked session's already-open socket keeps receiving the full event stream until the client itself disconnects.
- Encryption (`EncryptionService.ts`), auth (`AuthConfig.ts`), and the raw-write scanner (`scan_unallowlisted_writes.ts`, confirmed clean this session) remain as previously documented — no new findings there this pass.

---

# Performance & Reliability Analysis

**[FACT/INFERENCE mixed, clearly marked]**

- **[FACT]** `better-sqlite3` is synchronous — every DB call blocks the Node event loop for its duration. At current single-instance scale this is fine (confirmed no complaints/timeouts in the test suite), but it is a real architectural ceiling if concurrent load grows.
- **[FACT]** No concurrent-request queueing/backpressure exists for `RiskEngine.evaluateRisk()` — this is both the root cause of the TOCTOU races and a potential throughput concern under a burst of trade ideas.
- **[FACT]** WebSocket wildcard listener count scales 1:1 with concurrent connections on the `'*'` channel; >50 concurrent connections triggers a Node warning (not a crash) — no hard connection cap exists.
- **[INFERENCE]** Memory: `EventStore`'s ring buffers are explicitly capped (200 events, 500 traces) — a previously-fixed unbounded-growth bug (documented in `FINAL_ANALYSIS.md`) stays fixed. No new unbounded-growth pattern was found this pass.
- **NOT VERIFIED**: actual CPU/memory usage under real production load — this requires running the live system, which was not done this pass.

---

# AI/API Cost Analysis

**[FACT]**, from this pass's dedicated research.

**Real per-provider pricing (confirmed against source):**

| Provider | Model (hardcoded) | Input $/1M | Output $/1M |
|---|---|---|---|
| Gemini | `gemini-2.5-flash` | $0.30 | $2.50 |
| OpenAI | `gpt-4o` | $2.50 | $10.00 |
| DeepSeek | `deepseek-coder` | $0.14 | $0.28 |
| Local (Ollama/self-hosted) | any | $0 | $0 |
| Grok (via x.ai endpoint) | `grok-4` | $3.00 | $15.00 |
| Other aggregators | untracked | $0.50 (disclosed estimate) | $1.50 (disclosed estimate) |

**Real call-frequency ceilings (upper bounds, gated by real conditions — not all ticks result in a call):**
- FundamentalAgent: up to 1,440 ticks/day, 1 of 3 symbols per tick — an LLM call fires on **every** tick where `GEMINI_API_KEY` + `ALPHAVANTAGE_API_KEY` are set and data is available, **regardless of whether that data is fresh or served from the 24h cache** (real, previously undocumented cost inefficiency).
- MacroAgent: up to 1,152 ticks/day, same caching gap.
- NewsAgent: not a fixed number — gated by real article volume and real FinBERT decisiveness; only non-decisive articles escalate to a paid/local LLM call.
- ChiefTraderAgent debate: gated by qualifying `TRADE_IDEA_GENERATED` events (confidence > 0.6); each firing multiplies cost by the number of currently-live providers (parallel fan-out, not one call).

**Real finding: the per-agent model-override mechanism is broken for 3 of 4 provider types.** `GeminiProvider`, `OpenAIProvider`, and `DeepSeekProvider` all hardcode their model string and never read `options.model` — so `AIRouter.setAgentRoute()`'s per-agent model override has no effect for any of these three, only for `OpenAICompatibleProvider`-routed calls (local/aggregator endpoints). This means any attempt to route a specific agent to a cheaper/different Gemini or OpenAI model via the existing override UI silently does nothing.

**No response caching exists at the AI-router level** — `ExternalDataCache` is scoped to raw AlphaVantage fetches only, never to AI provider responses. Combined with the two findings above, Fundamental/MacroAgent's real steady-state cost is higher than necessary relative to how often the underlying data actually changes.

---

# Production Readiness Scorecard

**[FACT/INFERENCE]**, 0-100 scale. Scores reflect this pass's findings layered onto the prior session's baseline — a UI that looks complete is not scored as functional if the backend behind it is mocked or, per this pass, racy/incomplete.

| Category | Score | Why |
|---|---|---|
| Architecture | 72 | Real event-driven pipeline, clean separation; the fire-and-forget unqueued risk-evaluation pattern is the architecture's most consequential real weakness found this pass |
| Backend | 70 | Real, substantially correct; order-lifecycle gaps (no cancel, no partial-fill, no post-timeout follow-up) are real and unaddressed |
| Frontend | 65 | 13 widgets fixed this session with real backends; several tabs still contain deferred fabrication (Learning tab, Arena's risk-decomposition widget); Mission Control toggles remain fully fake |
| AI Agents | 68 | Real, genuinely local-first for one path (NewsAgent); no output validation anywhere; broken model-override for 3/4 provider types |
| Trading Engine | 65 | Real consensus + real gate ladder; 2 real TOCTOU races in the gate ladder are a genuine, not cosmetic, weakness |
| Risk Management | 62 | 11 real gates, but 2 have real concurrency races and the daily-loss boundary has a real timezone bug |
| Broker Integration | 62 | Real for Alpaca/paper; no cancellation logic anywhere; partial fills structurally unhandled |
| Portfolio Management | 75 | Real, confirmed-working reconciliation with a real automatic safety trip — one of the stronger-verified subsystems this pass |
| Data Quality | 60 | Real sources throughout, but no duplicate-tick protection and no WS-reconnect gap detection |
| Persistence | 78 | Real 41-table schema, real transaction-replay capability; the two TOCTOU races are DB-interaction bugs, not schema/persistence-design flaws |
| Testing | 68 | 326 real tests, but zero coverage of concurrency races, cancellation, or partial fills — because the underlying code paths themselves don't exist or aren't guarded |
| Security | 60 | Real auth/encryption fundamentals; a real (if narrow) secret-leak vector via URL-embedded keys; inconsistent input validation |
| Observability | 68 | Real, durable, replayable transaction trail; WS-reconnect event loss is a real observability gap for live UI consumers specifically |
| Performance | 65 | No evidence of current bottlenecks under test load; synchronous DB driver + unqueued risk evaluation is a real scaling ceiling, NOT VERIFIED under production load |
| Reliability | 60 | Real fail-safe behavior on broker/AI outages; the stuck-PENDING-order gap and WS event loss are real reliability weaknesses |
| **Overall Production Readiness** | **66/100** | Real, working paper-trading infrastructure with several genuine, previously-undocumented gaps in the order-lifecycle and risk-concurrency areas that matter specifically *because* this is a trading system, not generic web-app polish |

---

# Critical Issues

1. **Order-rate-limit gate TOCTOU race** — concurrent risk evaluations can collectively exceed the configured order-rate cap.
2. **Order stuck at PENDING indefinitely** — no follow-up after the 4-second fill-poll window; only correctable manually or indirectly, up to 5 minutes later, at the position (not order) level.
3. **No order cancellation path exists anywhere** — a stuck or unwanted order cannot be canceled by any Argus code path.

# High Priority Issues

4. Portfolio-drawdown peak-equity TOCTOU race.
5. Partial fills structurally unhandled (dormant today, live risk the moment a real broker returns one).
6. Real secret-leak vector via URL-embedded API keys in error logs.
7. Events lost on WebSocket disconnect, no reconnect backfill.
8. Daily-loss circuit breaker resets at UTC midnight, not exchange midnight.

# Medium/Low Priority Issues

9. FundamentalAgent/MacroAgent's cache doesn't gate the LLM call itself — real, ongoing cost waste.
10. Per-agent AI model-override broken for 3 of 4 provider types.
11. No CORS policy (not a vulnerability, but undocumented/unreviewed).
12. Inconsistent input validation across POST routes.
13. No server-side re-check of WebSocket auth after handshake.
14. Reconciliation re-entrancy (no guard against overlapping runs).
15. Duplicate-order idempotency check fails open on a DB error.
16. Dead code (`executeAutoBotTradeInSovereign`) carries the same race pattern as #4 — harmless while unwired, a real risk if ever reused.

---

# Mocked & Simulated Components

**[FACT]**, current state (post this session's 13 fixes):

- Mission Control's Granular Module Toggles (fully fake, HIGH RISK, not touched this session).
- Trading Arena's ~300-line risk-decomposition widget (interactive but fake).
- Learning & Evolution's Kelly-sizing learner, RL post-mortem pipeline, fake backtest-comparison section.
- Autonomous Dashboard's fabricated shell (hardcoded portfolio value, fake AI-health block) — unchanged, out of this session's scope.
- The Swarm Collaboration Transcript panel (`mockSwarmTranscripts`) — noted, not touched.
- Trading Arena broker-selection dropdown's fake "Robinhood"/"Charles Schwab" entries — noted in prior audits, not touched.

# Missing Capabilities

- Order cancellation (no code path exists).
- Partial-fill handling (structurally absent).
- WebSocket reconnect event backfill (backend capability exists, frontend doesn't call it).
- Concurrency control on risk evaluation (no queue/lock).
- AI response caching (none at the router level).
- Exchange-timezone-aware date boundaries anywhere in the calculation/risk layer.

# Regression Risks

- Any future change to `RiskEngine.ts`'s gate order or the peak-equity/order-rate read-write pattern must account for the real races documented here — a naive "fix" (e.g., adding a lock) could change gate-evaluation timing/ordering that downstream code depends on.
- Any change to `OrderManagementService` to add cancellation or partial-fill handling must preserve the existing idempotency guarantee and the real event payload shapes `TransactionLifecycleTracker`/`EventStore`/the frontend depend on.
- This session's 13 new routes are additive and low-risk, but the frontend components consuming them now depend on their exact `{ok, available, data, reason?}` response shape — changing that shape without updating all consumers would be a regression.

---

# Recommended Roadmap

**Must fix before continued paper trading (these are correctness/safety gaps in the paper-trading pipeline itself, not live-trading-specific):**
1. Close the order-rate-limit and peak-equity TOCTOU races (likely via a simple in-process mutex/queue around `evaluateRisk()`, given the single-Node-process architecture — no new infrastructure needed).
2. Add a follow-up mechanism for orders still `PENDING` after the initial poll window (even a periodic re-poll job would close most of the real gap).
3. Fix the daily-loss UTC-vs-exchange-time boundary.

**Must fix before any live-trading consideration (in addition to the above and the pre-existing "no validated trading edge" blocker):**
4. Implement real order cancellation.
5. Implement real partial-fill handling.
6. Close the URL-embedded-API-key log-leak vector (move to headers or scrub logs).

**Nice to have:**
7. WebSocket reconnect backfill.
8. AI response caching for Fundamental/MacroAgent to cut redundant LLM spend.
9. Fix the broken per-agent model-override for Gemini/OpenAI/DeepSeek.
10. Consistent input validation across all POST routes.
11. Finish the deferred frontend items (risk-decomposition widget, Learning tab's remaining sections, Mission Control toggles — per the previously-presented Change Plan).

Per your own instruction: **no microservices, no new database, no framework changes are recommended** — every fix above is achievable within the current single-process Node/Express/SQLite architecture.

---

# Paper Trading Readiness

**[FACT-based judgment]** **Paper-trading ready, with caveats.** The pipeline is real end-to-end, the safety gates are real (2 with real concurrency races that matter more under burst load than steady low-volume paper trading), and portfolio reconciliation is a confirmed-working automatic safety net. The order-lifecycle gaps (stuck PENDING, no cancellation) are real but lower-stakes in paper trading, where no real capital is at risk from a stuck simulated order.

# Live Trading Readiness

**NOT READY.** Unchanged from every prior audit's conclusion: no statistically validated trading edge exists anywhere in this codebase. Independently and additionally, this pass found concrete, real gaps (order-rate-limit race, no cancellation, no partial-fill handling, UTC-boundary daily-loss bug) that are each individually disqualifying for real capital regardless of the edge question.

# Final Verdict

**PAPER-TRADING READY** (with the "must fix before continued paper trading" items above addressed soon, not urgently). **NOT LIVE-TRADING READY**, for two independent reasons: (1) no validated trading edge, unchanged from every prior audit; (2) this pass's own new findings — real concurrency races in the risk gate ladder and a real, non-hypothetical order-lifecycle gap (no cancellation, no partial-fill handling, orders that can get stuck indefinitely) — are exactly the class of issue that must be closed before real capital is at risk, independent of the edge question.

---

**End of analysis. No code was modified. Per the governing instructions, no changes will be made until explicitly approved.**
