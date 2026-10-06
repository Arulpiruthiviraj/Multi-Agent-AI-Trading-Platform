# Argus Architecture

## 2026-10-06: Synthetic Market Session Simulator — synthetic daily-bar provider closes the CORE-strategy certification gap

**Test infrastructure only — no live/paper decision path, gate, threshold, or consensus rule
changed.** `src/server/replay/synthetic/SyntheticDailyBarProvider.ts` gives
`HistoricalDataGateway`'s existing cache-first `ensureBars()` check real, scenario/seed-derived
synthetic `1Day` bars to find during an isolated synthetic session, closing the gap the same-day
earlier pass found and documented (`docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md` §4):
`QuantSignalAgent` — the only real caller of `StrategyEngine.evaluateAll()` (the 5 CORE
strategies) — always requests `1Day` bars, and the gateway correctly refuses a real network fetch
for them under `SYNTHETIC_SIMULATION=true`; with no synthetic substitute, every CORE-strategy
evaluation attempt failed closed on every prior run. Two pure functions, both derived from the
session's own seed/scenario (never a second data source): `generateSyntheticPriorDayHistory()`
(260 trading days of backward-anchored, Brownian-scaled daily OHLCV ending at the session's own
`config.startPrice`) and `rollupTodaysDailyBar()` (a real, point-in-time-safe OHLCV rollup of the
session's own already-revealed minute bars). Both refuse to run unless
`SYNTHETIC_SIMULATION === 'true'` (`assertSyntheticDailyBarProviderOnlyInSyntheticSession()`), and
a dedicated architecture-boundary test (`SyntheticDailyBarProvider.architectureBoundary.test.ts`)
proves no file outside `src/server/replay/synthetic/` can import it. A real ordering bug was found
and fixed while building this (seeding must run BEFORE `bootArgusCore()`, not after — see
`SyntheticSessionEngine.ts`'s own comment at the call site) — a background worker's own early
query of one symbol's `1Day` bars, with no synthetic rows present yet, poisoned
`HistoricalDataGateway`'s 60-second in-memory cache for the practical duration of that
400x-accelerated session. Re-run Strategy Certification Matrix: all 5 CORE strategies now evaluate
every cycle with real `triggerMet` results (3 of 5 — `RANGE_REVERSION`, `PULLBACK_CONTINUATION`,
`MEAN_REVERSION` — triggered with real conditions in at least one scenario; `MOMENTUM_BREAKOUT` and
`TREND_FOLLOWING` evaluated but never triggered in any scenario/seed tried, a documented
fixture-strength finding, not a strategy bug). See
`docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md` §4a (design) and
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT_2026-10-06-FOLLOWUP.md` (full re-run result and
verdict).

## 2026-10-05: quant research implementation - Form 4 scraper, meta-label capture, S-curve sizing

**SEC EDGAR Form 4 scraper** (`src/server/data/SecEdgarForm4Scraper.ts`). Polls the free SEC EDGAR
JSON API for Form 4 (insider transaction) filings on Argus's tracked symbols; parses the
ownershipDocument XML; stores to `insider_transactions` (dedupe on accession number). Respects
SEC rate limits (sequential, 500ms spacing, proper User-Agent). Gated by
`ARGUS_SEC_EDGAR_FORM4_ENABLED` (default false). Data plumbing only - emits no trade ideas.

**Meta-label feature capture** (`src/server/research/MetaLabelStore.ts`). Records a feature snapshot
(strategy, scores, regime, decision price, conditions) to `meta_label_features` for EVERY triggered
institutional setup, before the confidence vote gates (avoids selection bias). Joins to outcomes via
traceId -> agent_predictions.trace_id -> predictionOutcomes. `evidence_source` (PAPER/BACKTEST/REPLAY/LIVE)
is mandatory and must never be mixed in training. No meta-model is built - this is training-data
capture only; `countLabeledRows()` reports when sufficient real labels exist.

**S-curve bet sizing** (`quant-core-java/.../risk/MetaLabelSizing.java`). Pure math primitive:
`size = 2*Phi((p-0.5)/sqrt(p*(1-p))) - 1`. NOT wired into any live sizing path - activates only
when a calibrated meta-model exists with sufficient PAPER evidence.

## 2026-10-05: test-remediation follow-up and discovery-path verification

**Test remediation (no production code changed).** Five of the eight failing files from the
2026-10-05 full run (`npm test`, 633 files / 5316 tests) are fixed. `strategySelectionReplay.test.ts`
fixtures now carry `triggerMet` — they predated the trigger-gate contract, so the replay's real
`bestStrategyIdea()` call (correctly) selected nothing. The two BrokerManager tests stub
`ALPACA_EXECUTION_ENABLED=true` so they exercise adapter selection/authentication instead of
the 2026-09-29 execution-capability fail-closed fallback to the paper simulator.
`OrderManagement.reentrancy.test.ts` hoists the heavyweight `OrderManagement` import into
`beforeAll`: the real root cause was the first test's inline dynamic import (DB migrations + AI
model seeding) exceeding the 5s default test timeout, which left the second test a
partially-initialized module (`OrderManagementService is not a constructor`) — not a reentrancy
defect. A `tsc --noEmit` error in `PortfolioMonitor.isolation.test.ts` (`pnlPct` on `unknown`)
is also fixed. Four failures remain in the latest full run (634 files / 5317 tests, 5313
passed) — three are proven environment/load artifacts, one is a real unresolved defect:
(1) `urlSafety.test.ts` and (2) `webhooks.test.ts` fail because this sandbox's DNS resolves
external hostnames to `198.18.x.x` (RFC 2544 benchmarking range, verified via nslookup) — the
SSRF guard correctly fails closed on the non-public IP, so the tests' "real public hostname"
premise cannot hold here; not an Argus defect. (3) `positionFillEvidence.property.test.ts`
hit the 5s vitest timeout under full-suite parallel load and passes in isolation (2/2) — a
load artifact, not an oversell defect. (4) **Real failure:** the tier-4 compaction soak's 1M-row
aggregation took 6,207 ms in the full run (9,138 ms in a targeted run with adequate temp
space) against the <5,000 ms budget — a genuine performance failure, not a `/tmp`-size
artifact. No thresholds, gates, consensus math, OMS behavior, or kill-switch logic touched.

**Discovery path verified end to end (code inspection, 2026-10-05).** The master switch is
`ARGUS_OPPORTUNITY_LOOP_ENABLED`: `OpportunityDiscovery.runOpportunityScan()` returns before
any scan/shortlist/subscription work when it is off, while the broad-universe / movers /
news-catalyst caches refresh on their own independent flags. `opportunityDiscoveryWorker`
starts at boot (`ArgusCoreBoot`/`SystemBootstrap`); `getOpportunityScanUniverse()` merges the
curated seed/watch/momentum lists with broad-universe candidates, Alpaca movers, and news
catalysts; `blendedHotSwapScore()` / `scoreBroadUniverseChallenger()` let broad-universe
admissions compete for streaming slots on real gap evidence; `PostMarketAnalysis` already
classifies per-symbol funnel outcomes (`TRUE_UNIVERSE_MISS` / `NEWS_BLIND_SPOT` /
`LIQUIDITY_EXCLUDED` / …). Deliberate abstentions stand: `MarketUniverseScanner.computeRvol()`
returns null because real-time IEX partial volume and historical consolidated ADV are not
comparable — no RVOL ranking until a same-provenance volume source exists. Static curated
universe is ~122 unique names. Agreed PAPER discovery configuration:
`ARGUS_OPPORTUNITY_LOOP_ENABLED=true`, `ARGUS_BROAD_UNIVERSE_ENABLED=true`,
`ARGUS_MARKET_MOVERS_ENABLED=true`, `ARGUS_NEWS_CATALYST_DISCOVERY_ENABLED=true`,
`ARGUS_OPPORTUNITY_IDEAS_ENABLED=false` (the screener's tick-return vote stays off — widening
observation must not add a new BUY vote or weaken ChiefTrader/RiskEngine). Operating order:
enable the four flags → measure PAPER sessions against the discovery funnel → identify the
exact leakage stage → build only the missing capability. No new scanner, no top-N increase,
no polling change until measurement says so.

## 2026-10-04 (evening): capital-profile consistency in the pre-market readiness gate

**Production change (additive observability, fail-closed).** `TradingReadinessGate` gained a
`capitalProfile` node (`src/server/core/TradingReadinessGate.ts`) that asserts `settings.budget` —
the exact value RiskEngine gate 23 (`argus_capital_allocation`) enforces against — equals the
operator-declared `ARGUS_EXPECTED_BUDGET` env var (new, optional, documented in `.env.example`).
Any mismatch fails `tradingReady` with an explicit `BUDGET_MISMATCH` reason naming both values;
a missing/non-positive budget fails closed (gate 23 refuses every BUY anyway, so the pipeline is
not well-formed for trading); an unset intent is `notApplicable` (cannot verify, still passing).
This closes the $2K-intended vs $100K-runtime incident class, which previously had zero tripwire
(see `docs/audits/ARGUS_SYNTHETIC_FRAMEWORK_FORENSIC_2026-10-04.md` §1 blind spot #1). It changes
no threshold, gate, consensus math, sizing, OMS behavior, or kill-switch logic — pure
observability on the existing readiness surface (`GET /api/v2/runtime/trading-readiness`,
`argus-cli pipeline-ready`). 6 new tests (`TradingReadinessGate.test.ts`, 23/23 green).

## 2026-10-04: strategy trigger-gate contract (triggerMet)

`StrategyEvaluation` (TS) and the Java `StrategyEvaluation` record now carry a required
`triggerMet: boolean` — whether the strategy's DEFINING trigger event actually fired on the
evaluated bar (structural break, boundary touch, RSI extreme, sweep + CHoCH, genuine intraday
VWAP extension, …). This is selection-plane honesty, not a new calculation: setup quality and
trigger eligibility are now separate concepts.

`StrategyEngine.applyTriggerGate()` (TS) leaves the honest `setupScore` untouched but caps
`confidence` at `config/tradingSafety.json:triggerAbsentConfidenceCap` (0.4, below the
`minStrategyConfidenceToTrade` 0.6 trade bar) and appends an explicit contradiction when
`triggerMet` is false. The gate is applied in all three evaluation paths: live
`StrategyEngine.evaluateAll()`, `BacktestEngine`, and `argusStrategyReplay`. Previously a
triggerless momentum breakout could score 88/0.88 and be emitted as a tradeable idea because
`scoreFromConditions()` treated the trigger as one equally-weighted condition among many and
`bestStrategyIdea()` accepted confidence ≥ 0.6.

Related correctness fixes in the same change: `vwapMeanReversion` now requires genuine intraday
VWAP (daily-bar VWAP degenerates to a single-bar typical price and is flagged
`intradayBased: false` in `VWAPContext`) and uses side-aware no-ATR stop fallbacks;
`relativeStrengthRotation` no longer coerces a missing RS input to bullish;
`smcLiquiditySweep` truly requires sweep + CHoCH (score 0 without it);
`statisticalMeanReversion` returns a null target instead of a zero-distance one when the
Keltner mean is missing; `srBounce` adds contradictions for fades against the prevailing trend.
All 5 CORE Java strategies re-port the `triggerMet` contract (parity tests assert it).

No approval threshold, consensus math, RiskEngine gate, or OMS behavior was changed.

## 2026-10-04 (evening): backlog defect remediation and degenerate-input hardening

Three verified backlog defects and the remaining quant-repair items from the 2026-10-04 audit
pass, fixed without touching the protected trading spine, consensus math, or any approval
threshold.

**PortfolioMonitor per-holding isolation (P2).** The holdings loop previously ran under one
outer try/catch: a single holding's failure (e.g. `resolveOpeningTradeForLiveExit()` throwing
on a corrupt row) skipped stop/target review for every holding after it that cycle. Each
holding now gets its own try/catch — the failure is logged, a WARNING portfolio decision is
recorded for that symbol, and the loop continues. The outer catch remains as the backstop for
failures outside the loop (e.g. the initial holdings query).

**IBKR Web API request timeout (P2).** `InteractiveBrokersWebApiAdapter`'s `https.request()`
had no timeout: a Gateway that accepted the connection but never responded hung the promise
forever, including `placeOrder`. `config/ibkrConnection.json:webApiRequestTimeoutMs` (30s,
config-loaded with a 30s fallback) now bounds every request. Timeout rejects as
BROKER_TIMEOUT with outcome UNKNOWN — reconcile by `clientOrderId`, never assume the order
was not placed, never auto-retry. A `settled` guard plus fail-before-destroy ordering
guarantees the late socket error from `req.destroy()` cannot overwrite the timeout rejection.
OMS's existing "timeout stays PENDING / UNKNOWN, never FILLED" invariant is unchanged.

**Broker buying-power TOCTOU (P2/P3).** Risk evaluations are serialized by the
`evaluationQueue` mutex, but broker order placement sits outside it: two approved BUYs could
each observe the same unchanged broker buying-power snapshot before either filled. The
settings-budget side of this race was already closed (gate 23 `argus_capital_allocation`
with DB-backed `pendingBuys` + `PendingCapitalReservations`). New
`src/server/engines/buyingPowerReservations.ts` closes the broker side the same way: a
durable, DB-derived reservation (sum of quantity×price over non-terminal BUY orders,
excluding REPLAY/HISTORICAL_REPLAY, NULL environment counted as live like gate 23's own
filter) is subtracted from the fresh broker buying-power snapshot before sizing and gates.
It can only ever reduce buying power, never increase it. Unknown/reconciliation-required
orders keep their reservation (fail-closed).

**Opening-range session anchoring.** `openingRange()` anchored its window at the first bar
of the UTC day — wrong when premarket bars are included (a 4:00 AM bar is not the opening
range). It now takes an optional `regularSessionStartMs`; new `regularSessionOpenMs()` in
`src/server/replay/marketSession.ts` computes the real regular-session open
(`replaySafety.regularSessionStartMinutes`) in any IANA timezone, DST-correct via Intl with
no hardcoded EST/EDT offset. `CampaignOpeningSurge` (1Min bars include premarket) and
`QuantSignalAgent` (via `computeIntradayFetchWindow`, which already computed the session
open internally) now supply it. Omitted, behavior is byte-for-byte unchanged.

**Degenerate-input hardening (12 real defects).** A 421-case suite
(`degenerateInputs.test.ts`) feeds null/NaN/missing ATR, DMI, MACD, VWAP, moving averages,
RSI, Keltner, opening range, prior channel, previous-day levels, relative strength, and SMC
context to all 21 strategies: none may throw, none may return an actionable evaluation.
Twelve failures were real — `smcLiquiditySweep` on empty `{}`, `trendFollowing` /
`oscillatorMomentum` on null MACD, five VWAP consumers on null VWAP, four strategies on null
movingAverages — each fixed with a null-guard that fails the dependent condition closed
(never a fabricated signal). Defense-in-depth: `StrategyEngine.evaluateAll()` now isolates
each strategy in its own try/catch; a throwing strategy fails closed (triggerMet=false,
confidence 0, error stated in conditionsFailed) instead of aborting every other strategy's
evaluation that cycle.

No strategy, indicator, or quant calculation was added; per the Java Engine Authority
(AGENTS.md rule 13) these are bug fixes to existing TS calculations with no Java
counterpart (or, for the five CORE names, TS-side fixes recorded as Java migration
candidates — Java compilation remains unverified on this host).

## 2026-10-04: remaining forensic correctness and operations fixes

The read-only `/api/v2/quant-core/catalog` route resolves its configuration dependencies when
the router loads and responds synchronously. It no longer performs four request-time dynamic
imports. Its regression suite exercises both synchronous completion with real registry data
and the real HTTP route. The old test commentary attributing timeouts to parallel workers was
removed: current Vitest configuration runs files sequentially, so that explanation was stale.
This removes an asynchronous dependency from the request; it does not establish the cause of
every prior full-suite timeout or change any trading-engine flag.

The existing trading spine and all approval thresholds remain unchanged. These changes extend
its data and control-plane boundaries; they introduce no strategy or quant calculation in Node.

- `IBGatewaySocketAdapter.positions()` no longer substitutes average cost for a market mark or
  reports fabricated zero unrealized P&L. The positions callback supplies quantity and cost basis
  only. Current price, market value and unrealized P&L are NULL/UNAVAILABLE until a real valuation
  source is integrated; portfolio valuation is PARTIAL when any position lacks a mark. Broker
  account equity remains its independently reported account value. Quantity and basis survive.
  Reconciliation labels a nonempty portfolio with missing marks `ACCOUNT_VALUATION_UNAVAILABLE`
  rather than certifying account equity against cost basis. This holds readiness until real marks
  are available; it does not invent a valuation or erase the holdings.
- MarketDataWorker's existing spread formula now consumes separately observed BID and ASK, both
  fresh, instead of letting a LAST tick stand in for BID. This is input-provenance/freshness repair,
  not a new or duplicated quant calculation. Existing freshness limits remain authoritative.
- A single shared shutdown promise makes overlapping signal/API requests wait for the same drain.
  The clean-session marker is written only after successful worker/network/database shutdown;
  a failed step or forced network close retains dirty status. Session marker replacement is atomic,
  and the engine PID remains visible until the successful drain and marker write complete,
  and malformed existing markers hold entries rather than silently behaving like first boot.
- The October 1 crash log directly records `ERR_HTTP_HEADERS_SENT` in runtime health and VectorBT
  status after request timeouts. Those routes now settle late successes/failures without a second
  response or an unhandled rejection; the orders route has the same protection. This fixes that
  observed error class, not proof of the cause of every process death or the original orders delay.
  CLI transport errors distinguish unreachable engines from aborted requests and retain server
  correlation ids when headers arrived. No broker failure is inferred from a client timeout.
- Quant cycle scheduling remembers the first unattempted symbol after provider backoff. Previously
  every cycle restarted with the same priority names, allowing persistent tail starvation. This
  is control-plane fairness only, not changed strategy ranking, concurrency, subscription capacity,
  provider pacing or approval math. `QUANT_CYCLE_COMPLETED` records duration and attempted,
  completed and unattempted symbol sets. This defect is source/test verified; it is not established
  as the cause of Friday's entire coverage decline, especially on the distinct IBKR history path.
- Unsampled `RUNTIME_SESSION_STARTED`, `RUNTIME_PHASE_CHANGED` and
  `AUTOBOT_CONFIGURATION_PERSISTED` observations add timestamped startup/lifecycle/configuration
  evidence to the existing store. Effective SAFE_MODE still derives from the existing runtime,
  trading state and emergency flag, not a second state machine. These observations do not
  reconstruct missing historical uptime or create a guaranteed lossless audit log.
- `argus-cli paper-profile` previews the owner-requested allocation in
  `config/paperAllocationProfile.json`; `--apply` uses the existing validated settings API and
  reads values back. It requires confirmed PAPER, TRADING_PAUSED and disabled Autobot. It sets
  the allocation and caps the existing order ceiling at that allocation without increasing it.
  It never enables/resumes trading, changes the broker account, or claims a daily return.

Operational closure remains separate: the engine was unreachable during this pass, so profile
activation, authenticated broker reconciliation of the existing short, reviewed legacy baseline
recovery, historical accounting repair and deployment verification remain pending. The guarded
profile application was attempted and failed at the initial read, without a settings mutation.
Weak/conflicting signals and finite data entitlements are not solved by these engineering repairs;
strategy edge needs out-of-sample/forward evidence through the existing research/promotion gates.
No historical record, broker position, strategy enablement or approval threshold was changed.

## 2026-10-03: fill-backed inventory and forensic remediation

The October 1 OKTA incident exposed an eventual-consistency failure: a confirmed close deleted
the local long, an older positive broker quantity was subsequently reconciled back into the
cache, and a second independent exit sold it again. The existing execution spine remains
ChiefTrader → RiskEngine → sizing → OMS → BrokerManager. These are correctness changes inside
that spine, not a new execution path, new strategy, or permission to lower any approval gate.

Migration `0082_position_fill_evidence` adds nullable submission quantity/basis to `trades`
and signed post-fill quantity/basis plus gross realized P&L to `fills`. `positionFillEvidence.ts`
is an internal ledger helper, called by the existing OMS/fill transaction and read by the existing
risk/reconciliation paths. It is not another position service or broker client. Scope is adapter
id, execution environment and symbol; monotonic fill ids are observation watermarks, not a claim
that a provider supplied exchange sequence numbers.

- OMS obtains broker positions, then synchronously checks the scoped fill watermark and unresolved
  sibling orders and persists its basis immediately before its existing `placeOrder` call. A
  production SELL means CLOSE_LONG: a zero/negative position or quantity above remaining long is
  refused. OPEN_SHORT has no new authorized path. Existing PENDING/ambiguous orders reserve the
  symbol across restarts; no timeout releases that reservation by assumption.
- `insertIncrementalFill` commits the incremental fill, signed position, cost basis and gross
  realized P&L in one SQLite transaction. Duplicate cumulative watermarks have no economic effect.
  Terminal cumulative quantities below already-recorded fills are rejected for reconciliation.
  `localPortfolioSync.ts` and `omsEntryPrice.ts` are COMPATIBILITY_ONLY, with no production callers.
- The existing `sell_position_exists` gate also checks fill evidence. Reconciliation cannot
  hydrate/overwrite a fill-conflicting position and cannot publish a clean MATCH for that conflict.
  Both broker and local snapshots remain visible. Existing pause controls apply; no automatic
  flatten or resume is introduced.
- Delayed and recovered fills use durable basis. Only quantity reducing opposite exposure earns
  realized P&L; opening a short earns none. An unexpected short is represented as negative inventory
  and requires reconciliation, rather than being erased or booked as another profitable long exit.
  `trades.profit_loss` here is gross price P&L. Real commissions remain separate and nullable;
  this change does not establish net profitability or repair historical P&L records.
- Cancellation resolves through the order's original broker and requires terminal cumulative fill
  evidence before releasing its reservation. A cancel acknowledgment alone does not establish zero
  fills. The historical replay broker now also cancels its genuinely working partial remainder.

The Oct 1–2 audit is retained as a dated snapshot in
`docs/audits/ARGUS_THURSDAY_FRIDAY_TRADING_FORENSIC_2026-10-01_2026-10-02.md`.
**Deployment constraint:** legacy fills have NULL inventory watermarks. They deliberately fail
closed as `POSITION_FILL_BASELINE_UNAVAILABLE`; this migration does not infer a basis from a
historical BUY or rewrite old evidence. Existing positions, including the audited OKTA short,
require separately reviewed broker reconciliation and baseline recovery before a supervised
session. Broker-side native reduce-only is not claimed for equity MARKET orders: simultaneous
external/manual account activity cannot be made atomic with an Argus SQLite transaction. Broker
account switches likewise require reconciliation; an adapter id is not proof of account identity.
No production migration, account adjustment, historical ledger repair, restart, resume, or live
arming is implied by tests passing.

Observability extends the existing mechanisms:

- `QUANT_QUOTE_EVIDENCE` and `ORDER_QUOTE_EVIDENCE` record observed source, price age, independent
  bid/ask observations and their timestamps with existing trace/order ids. LAST is not labeled BID;
  absent observations remain NULL. Reissued subscriptions and backend switches invalidate cached
  quote evidence. Replay order quotes are explicitly NULL rather than borrowed from the live feed.
- The existing discovery-lineage report accepts `since`/`until` (exclusive end), distinguishes
  subscription requests, acknowledgments, capacity refusals and fresh assessment evidence, and
  reports actual fill-ledger rows. A rejected OMS row is not a submitted broker order. Its timeline
  exposes trace/order ids where present; symbol/time-only links are not asserted causal links.
- `CONSENSUS_TERMINAL_REASON` counts individual evaluations; `consensus_decisions` aggregates
  interim refusals through its periodic persistence sweep. A count mismatch alone is not data loss.
  Friday capacity pressure remains a measured limit, not proof that thresholds should be weakened.
- `/api/v2/runtime/orders` records start/completion/disconnection, request correlation and duration;
  ledger errors return a bounded 503 response. It still reads the ledger, never the broker order API.
  This supplies future timeout evidence; it does not establish the historical timeout's cause.

Regression coverage uses isolated SQLite and the real replay broker/OMS/reconciliation, with
stale broker snapshots injected at the broker-data boundary. The stale position is also rejected
by the real RiskEngine gate. Tests cover partial fills, repeated/concurrent exits, canceled
remainders, restart/late-fill attribution, and rollback across fill/inventory/P&L. These prove
engineering behavior under controlled conditions, not organic edge or production deployment.

**This file supersedes and replaces the following 9 files, deleted from `docs/architecture/` as
part of this consolidation (their content lives on in git history):** `SYSTEM_OVERVIEW.md`,
`MULTI_AGENT_CONSENSUS.md`, `RISK_ENGINE_24_GATES.md`, `JAVA_QUANT_CORE.md`,
`JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md`, `ARGUS_QUANT_OWNERSHIP_MATRIX.md`,
`LANGGRAPH_RESEARCH_SERVICE.md`, `ARGUS_PREMARKET_GAP_ANALYSIS.md`,
`ARGUS_SESSION_AWARE_TRADING_ARCHITECTURE.md`. This is now **the one living architecture
reference** for the repo, per `CLAUDE.md`. It stays separate from three things that are not folded
in here: `CLAUDE.md` itself (the operational master spec — numbers, gates, config keys are
authoritative there or in `config/*.json`/real code, never re-copied here to drift), `README.md`
(setup/name philosophy), and `docs/audits/` including `docs/audits/archive/` (dated, immutable
forensic snapshots — this doc may cite their conclusions but never restates old PIDs/test totals as
current).

**Adding markdown does not raise readiness scores.** Where anything below reads stale relative to
the real code, the code + `evaluateLiveReadiness()` + organic `trades`/`fills` win, not this file.

**Verified fresh for this consolidation (2026-09-05):**
- Table count: `grep -c "sqliteTable(" src/server/db/schema.ts` → **75** (drifts; re-run to check).
- RiskEngine gate count: **25**, not 24. `config/riskGateOrder.json` now lists 25 gate names ending
  in `extended_hours_execution_policy`, and `src/server/engines/RiskEngine.ts` genuinely implements
  and records that 25th gate (`recordGate('extended_hours_execution_policy', ...)`, line ~759) — this
  is real, wired code, not a config-only stub. See § Risk Engine Gates below for what it does.
- For any test-count claim: run `npm test` yourself — trust the runner, not a remembered number.

---

## System Overview

### Process model

Single Node.js process: Express + Vite (dev) / static files (prod) + raw `ws`. Backend entry
`server.ts`. Port **3000** hardcoded. Bind `127.0.0.1` unless `AUTH_PASSWORD` is set. Full boot
sequence, hooks, and the login-screen effect-ordering gotcha: `CLAUDE.md` §1.

### The live decision spine (do not rewrite, do not duplicate)

```
Alpaca WebSocket → MarketDataWorker.emitMarketData()
       │
       ▼
Idea agents (Technical / News / Fundamental / Macro / PortfolioMonitor / Quant / Kronos /
Opportunity Discovery+Screener) — full list, cadences, and honesty caveats: CLAUDE.md §1
       │  TRADE_IDEA_GENERATED (gated by gateTradeIdea / looksLikeListedTicker)
       ▼
ConfluenceCoordinator (default on) — on a qualifying TechnicalAgent signal, calls
QuantSignalAgent/KronosForecastAgent's existing on-demand entry points for the same symbol
(structurally independent — takes only a symbol, no vote to copy). Raises how often a second
agent evaluates the same symbol in-window; never changes ChiefTrader's weights/threshold.
       │
       ▼
ChiefTraderAgent — weighted consensus, optional AI debate, HOLD-veto
       │  CHIEF_APPROVED_IDEA
       ▼
RiskAgent → RiskEngine.evaluateRisk() — 25 fail-closed gates, serialized mutex
       │  RISK_ASSESSMENT_COMPLETED
       ▼
OMS → BrokerManager.getActiveBroker().placeOrder()
       │
       ▼
trades + fills (unique orderId + cumulativeQuantity) → ORDER_EXECUTED
```

Full detail (thread-safety invariants, fill idempotency, P0.1–P0.7 verified safety invariants,
5-layer LIVE arming): `CLAUDE.md` §1.

**Symbol universe feeding the idea agents above:** a curated seed/watch list, plus — when
`ARGUS_BROAD_UNIVERSE_ENABLED=true` — `MarketUniverseScanner.ts`'s real, liquidity/price/spread/
ADV-screened Alpaca tradable-assets funnel, merged in through the same candidate gate. Off by
default; real API cost when on. Neither path emits a trade idea itself. Detail:
`docs/ARGUS_OPPORTUNITY_DISCOVERY.md`.

**Session-aware layer:** see the dedicated § Premarket / Session-Aware Trading Architecture below —
this grew substantially past its original "Stage 1, observability only" description; as of
2026-09-05 it includes a real, opt-in extended-hours execution path (RiskEngine gate 25, OMS
limit-order construction, per-broker capability flags), not just session tracking.

### Protected architecture

`ChiefTraderAgent`, `RiskEngine`, `OrderManagementService`, `BrokerManager` + adapters,
reconciliation, the kill-switch system, the trading-state machine, portfolio accounting, order
lifecycle, fill processing, the risk gate ladder (now 25 gates), and paper/live safety controls are
**extended through their documented interface only** — never replaced, bypassed, weakened, or
duplicated. Full contract: `ARGUS_ARCHITECTURE_PROTECTION.md`, `ARGUS_ARCHITECTURE_CONTRACT.md`,
`ARGUS_ARCHITECTURE_INVARIANTS.md` (all repo-root, out of scope for this doc).

### Silent-death watchdog (`src/server/core/heartbeatWatchdog.ts`, added 2026-09-07 R2 remediation)

Complements — does not replace — an external process supervisor (still an operator/ops
responsibility; a crashed process cannot watch itself). Detects the *other* failure mode: the
process stays alive while some interval-driven worker has gone silently, invisibly dead. Signal:
`NewsAgent`'s heartbeat (`pipelineAgentHealth.ts`) is the one idea-agent heartbeat that ticks
unconditionally on its own timer regardless of Autobot/session state; a prolonged gap in it,
corroborated by `MarketDataWorker.isConnected()` also reporting disconnected (so a NewsEngine-only
glitch alone cannot trip this), is treated as a genuine silent-death signature
(`tradingSafety.heartbeatWatchdogSilenceThresholdMs`, 900000ms). On trip: reuses the existing
`tradingEngine.setTradingState('TRADING_PAUSED', ...)` path — the same one reconciliation mismatches
use, never a second/new kill switch — and never auto-resumes. One pause attempt per process
lifetime (does not spam-retrigger once an operator has re-enabled trading).

### Companion processes (all optional, all outside the decision spine)

| Process | Port | Role | Default |
|---|---|---|---|
| Argus Engine (Node/Vite) | 3000 | The trading system — sole writer of `data/argus.db` | Always on |
| Chronos/Kronos (Python) | 8008 | Local time-series forecasting for `KronosForecastAgent` | On unless `ARGUS_SKIP_CHRONOS=true` |
| Ollama | 11434 | Local LLM inference for AI-routed agents | On unless `ARGUS_SKIP_OLLAMA=true` |
| OpenAlice Guardian MCP | 47332 | Read-only external verification, never a trading path | On unless `ARGUS_SKIP_OPENALICE=true` / `ENABLE_OPENALICE=false` |
| IB Gateway / TWS (external app) | 4002 (paper) / 7497 | Broker socket Argus connects *to* — Argus does not launch or own this process | Probed, never auto-launched |
| Java Quant Core (`quant-core-java/`) | 8085 | **Optional, advisory-only** calculation bridge — see § Java Quant Core below | Off unless `QUANT_JAVA_CORE_ENABLED=true` |
| LangGraph Research Service (`langgraph-research/`) | 8090 | **Optional, advisory-only** strategy-graduation recommendation companion — see § LangGraph Research Service below | Off unless `LANGGRAPH_RESEARCH_ENABLED=true` |
| Fincept Terminal (external app, `src/server/services/FinceptCacheAdapter.ts`) | n/a (file-based) | **Optional, advisory-only, read-only** VIX/index context read from an independently-running Fincept Terminal's SQLite `cache.db` into `MacroAgent`'s reasoning text — never the prompt/cache key, never confidence/side. Argus does not launch, own, or hold credentials for this process. | Off unless `ENABLE_FINCEPT_CACHE_ADVISORY=true` |

None of these processes can place an order, hold broker credentials (except the Argus Engine
process itself), or bypass the spine above. Ecosystem startup mechanics:
`docs/operations/DEVOPS_LIFECYCLE.md`.

**Fincept Terminal integration, the real ground truth (2026-09-07, verified against the actual
open-source C++ source, not documentation or a relayed prompt):** Fincept's only genuine external-
facing surface (`src/mcp/TerminalMcpBridge.cpp` in its own repo) binds an OS-assigned ephemeral port
and mints a fresh, never-persisted auth token on every launch — deliberately, for its own bundled
Python subprocess only. There is no supported way for an external process to reach it, and this was
not treated as a gap to route around. The one real, safe read path is its `cache.db`'s generic
`unified_cache` key/value table (no credential columns, unlike `fincept.db`'s `credentials`/
`secure_credentials` tables, which `FinceptCacheAdapter.ts` never touches) — but that table is far
more transient than a live feed: it only holds data while Fincept's own UI is actively displaying
it, and was observed going from 57 rows to zero within minutes with no code change on either side.
`getFinceptMacroSnapshot()` returning `null` is therefore the common case, not an error.

### Where else to go

| Question | Doc |
|---|---|
| Exact gate rules and current thresholds | § Risk Engine Gates below → `CLAUDE.md` §2 |
| AI provider routing, model map | `CLAUDE.md` §3 |
| Decision trace schema, `traceId`/`transactionId` | `CLAUDE.md` §4 |
| Operational state, soak floors, pre-flight runbook | `CLAUDE.md` §5 |
| IBKR / broker connection setup | `docs/operations/IBKR_GATEWAY_SETUP.md` |
| `argus.sh` / ecosystem lifecycle | `docs/operations/DEVOPS_LIFECYCLE.md` |
| Daily Goal Campaign | `docs/operations/CAMPAIGN_MANAGEMENT.md` → `ARGUS_CAMPAIGN_TRACKER.md` |
| Operator/developer forensic debugging | `docs/ARGUS_DOCUMENTATION_INDEX.md` |

---

## Multi-Agent Consensus (ChiefTrader)

Authoritative source: `CLAUDE.md` §1 ("How a BUY / SELL happens") and §3 (AI routing). This section
is a focused summary of the debate/quorum mechanics specifically.

### Inputs

Every idea agent (TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent, PortfolioMonitor,
QuantSignalAgent, KronosForecastAgent, Opportunity Discovery/Screener) emits
`TRADE_IDEA_GENERATED { traceId, symbol, side, confidence (0–1), reasoning, agent, currentPrice }`
via `eventBus.emitTradeIdea(...)`, which gates it through `gateTradeIdea()` /
`looksLikeListedTicker()` before ChiefTrader ever sees it (garbage tickers/prices are rejected as
`TRADE_IDEA_REJECTED`, not silently dropped or passed through).

### Weighting

- Live weights come from `agent_performance_stats.currentWeight`, seeded from
  `config/agentWeights.json`'s defaults.
- `ReflectionEngine` (~60s cadence) updates weights based on real prediction-vs-outcome scoring,
  gated by **effective sample size** (not raw count) so autocorrelated/duplicated predictions from
  one agent can't inflate its own influence — see `src/server/research/effectiveSampleSize.ts` and
  `predictionIndependencePolicy.ts`. Weight changes are bounded per cycle
  (`tradingSafety.maxWeightAdjustmentPerCycle`) so one noisy cycle can't swing weighting to an
  extreme immediately.
- The risk-exit agent (`config/agentWeights.json`'s `riskExitAgent`, currently `PortfolioManager`)
  is excluded from this weight-learning loop entirely — its role is risk-exit, not alpha-seeking.

### Debate

- If confidence exceeds `tradingSafety.debateTriggerConfidence`, ChiefTrader can trigger a real
  multi-provider AI debate via `AIRouter.getInstance().routeConsensus(...)` (fans out to multiple
  providers in parallel — there is no single "Chief Trader model"). Provider failure fails closed
  (HOLD / confidence 0), never fabricates a vote.
- Requires at least `tradingSafety.minIndependentAgreeingAgents` (currently 2) independent agents
  agreeing, at a weighted confidence ≥ `tradingSafety.consensusApprovalThreshold` (currently 0.75).
  **Do not lower these to increase trade frequency** — see `CLAUDE.md`'s own repeated instruction
  on this exact point.
- A HOLD vote with confidence > 0 actively penalizes the opposing side's weighted score (it is not
  simply ignored).
- Risk-exit ideas (PortfolioMonitor SELL/REDUCE) skip debate and the min-agents requirement — exits
  are not alpha calls, they're risk management — but still go through every RiskEngine gate and OMS
  unchanged.

### Output

On approval, ChiefTrader mints a `transactionId` and emits `CHIEF_APPROVED_IDEA` — the **only**
event that authorizes RiskAgent to run `RiskEngine.evaluateRisk()`. The full, reviewed allowlist
of files permitted to emit this event (and why each one is there) lives in
`src/server/architecture.protection.test.ts` — a new emitter is a new order-approval path and
must never be added silently.

### Manual override / operator-confirmed trades

The Advanced Trade Sandbox's "Execute Override" and Opportunity Feed's CONFIRM BUY/SELL both route
through `runManualTradeCoEvaluation()` (`src/server/services/manualTradeCoEvaluation.ts`), which
triggers the same on-demand agent co-evaluation and waits for a real `ChiefTraderAgent` consensus
outcome at the same floors as the autonomous path (0.75 / min-2) — it does **not** shortcut
consensus or emit `CHIEF_APPROVED_IDEA` itself.

### ConfluenceCoordinator (automatic on-demand co-evaluation)

Added 2026-08-25 after real DB evidence showed ~90% of consensus attempts never reached
`minIndependentAgreeingAgents` — not from low confidence, but because `TechnicalAgent` almost
never had a second independent agent evaluate the *same* symbol in its ~60s freshness window.
`src/server/services/ConfluenceCoordinator.ts` (`tradingSafety.confluenceCoordinatorEnabled`,
default **on**) listens for `TRADE_IDEA_GENERATED`, and when the emitting agent is specifically
`TechnicalAgent` with a qualifying BUY/SELL at confidence ≥
`confluenceCoordinatorConfidenceThreshold` (not already in a per-symbol
`confluenceCoordinatorCooldownMs` cooldown), it calls `QuantSignalAgent.evaluateSymbol(symbol)`
and `KronosForecastAgent.evaluateOnDemand(symbol)` — the same on-demand entry points the manual
CONFIRM BUY/SELL path above already uses, not a new bypass. Both take only a symbol string (no
side/confidence/reasoning), so there is no channel for either to copy TechnicalAgent's vote;
independence is structural. It changes **how often** a second agent evaluates a symbol in-window —
never ChiefTrader's weights, threshold, or gate. NewsAgent is deliberately excluded (real paid-API
cost per call, no per-symbol on-demand hook, and it is already the rarest/most independent voice —
triggering it reactively risks burning its budget on symbols it wouldn't have chosen itself).
**Runtime-verified 2026-08-26:** fired 495 times in one ~3-hour session; quorum-cleared rounds
(`agreements_count >= 2`) were 21.1% of that session's 180 consensus rounds. Logged via
`structuredLogger` as `CONFLUENCE_COORDINATOR_TRIGGERED` into `observability_events` — a different
table than the EventBus-instrumented `event_traces` most other lifecycle events land in.

### What ChiefTrader is not

- Not a place to add a second "AI decides everything" shortcut — AI interprets quant evidence, it
  does not replace RiskEngine or invent prices/EV.
- `QuantCoreJava` (the optional Java Quant Core bridge, when live-idea emission is ever enabled)
  participates as **one more named agent** through the exact same `emitTradeIdea()` →
  weight/debate/consensus path — it gets no special treatment or separate quorum. See § Java Quant
  Core below.

---

## Risk Engine Gates

**`CLAUDE.md` §2 remains the authoritative version of the gate table** (dates, exact defaults, and
older-list caveats live there — verify against it or `config/tradingSafety.json` before trusting a
number copied here). This section exists so the gate list has a navigable, current home.

### Ground rules

- Catalog order comes from `config/riskGateOrder.json`. Pass/fail must come from the real
  `RISK_GATE_EVALUATED` event / `risk_gate_results` table — **never** inferred from the JSON file
  alone.
- Every gate is recorded even after the first failure. The **first failure in evaluation order**
  is the reported rejection reason.
- No AI provider, debate outcome, or learned rule can override this ladder.
- All numeric thresholds live in `config/tradingSafety.json` (or `settings` for a few
  operator-tunable ones) — never hardcoded in TypeScript. Do not copy today's numbers into code;
  load config.

### The gate count is 25, not 24 (verified this session)

Older docs (including the file this section replaces) said 24. As of this consolidation,
`config/riskGateOrder.json` lists **25** gate names, and `src/server/engines/RiskEngine.ts` (line
~759, `recordGate('extended_hours_execution_policy', ...)`) genuinely implements and records the
25th — this is real wired code, not a declared-but-unimplemented config entry. The new gate:

25. `extended_hours_execution_policy` — **additive, never a replacement or weakening of gates
    1–24.** Implemented in `src/server/risk/ExtendedHoursExecutionPolicy.ts`
    (`evaluateExtendedHoursExecutionPolicy()`). Per that file's own header: *"this module does not
    gate, weaken, or replace any of the existing 24 RiskEngine gates. It ADDS one new check that
    only ever evaluates (and can only ever fail) when the order is genuinely an extended-hours
    attempt."* Concretely:
    - **Auto-passes (`skipped: true`) whenever not applicable** — a REGULAR-session order, or when
      `EXTENDED_HOURS_EXECUTION_ENABLED` (env, off by default — verified via
      `isExtendedHoursExecutionEnabled()`) is off, changes nothing versus before this gate existed.
    - When it does apply (a genuine PRE_MARKET/AFTER_HOURS order attempt with the flag on), it
      fails closed on: the active broker adapter lacking `extendedHoursOrders` capability
      (`EXTENDED_HOURS_BROKER_UNSUPPORTED`), a stale quote beyond `extendedHoursMaxQuoteAgeMs`
      (`EXTENDED_HOURS_STALE_QUOTE` — a fresh quote is required outside RTH, unlike gate 13's flat
      RTH threshold), spread beyond `extendedHoursMaxSpreadBps`, and (per the file's own honesty
      note) an average-daily-volume floor sourced from `ExtendedHoursLiquidityCache.ts`, which
      reuses the **same** real `fetchAvgDailyVolumeShares()` the broad-universe liquidity screen
      already calls — never a second, duplicate ADV calculation — cached rather than fetched
      inline per order, since a gate evaluation must stay synchronous.
    - Gate 12 (`market_hours`) itself gained a matching, narrowly-scoped extension the same day
      (2026-09-05): when `extendedHoursEnabled` is true, `classifyMarketSession()` /
      `sessionAllowsFills()` can let a genuine PRE_MARKET/AFTER_HOURS attempt pass gate 12 that
      previously would have failed on Alpaca's binary clock — but per the code's own comment, this
      "only ever adds a new way to PASS (never a new way to fail) gate 12, and only when the
      operator has opted in"; with the flag off (the default, universal today) gate 12's live
      expression is byte-identical to its pre-existing behavior.
    - OMS (`OrderManagement.ts`) correspondingly gained real limit-order construction for this path
      (`{ type: 'LIMIT', price: orderConstruction.price, extendedHours: true }`) instead of the
      previously-hardcoded `MARKET` order, and `BrokerAdapter.ts`'s capability shape now carries an
      `extendedHoursOrders` flag consumed per-adapter.
    - Detailed implementation narrative: `docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md`
      (out of scope for this doc to restate — that's the audit trail; this section is the current
      architectural summary). See also § Premarket / Session-Aware Trading Architecture below,
      which is where this capability's design lineage (Gap 7 in the original gap-analysis audit)
      is explained.

### The 25 gates (names only — see `CLAUDE.md` §2 for the fail-closed rule of gates 1–24, and above
for gate 25)

1. `emergency_stop`
2. `autobot_enabled`
3. `same_symbol_cooldown`
4. `post_loss_cooldown`
5. `daily_trade_limit`
6. `duplicate_signal`
7. `invalid_account_equity`
8. `daily_loss`
9. `consecutive_loss`
10. `portfolio_drawdown`
11. `order_rate_limit`
12. `market_hours`
13. `data_freshness`
14. `news_veto`
15. `price_validity`
16. `order_notional_cap`
17. `symbol_concentration`
18. `open_positions_cap`
19. `sector_concentration`
20. `correlation_exposure`
21. `sufficient_size`
22. `sell_position_exists` (SELL only)
23. `argus_capital_allocation`
24. `daily_buy_notional`
25. `extended_hours_execution_policy` (new — see above; auto-pass/no-op unless a genuine,
    opted-in extended-hours attempt)

### Verifying gates are actually current (do this, don't trust this file's staleness)

```bash
# Real current thresholds:
cat config/tradingSafety.json
cat config/riskGateOrder.json
# Real current pass/fail behavior for a given trace:
curl -s http://127.0.0.1:3000/api/v2/traces/<traceId> | jq '.riskAssessment'
```

### Related, real code

| Concern | Where |
|---|---|
| Gate implementations (1–24) | `src/server/engines/RiskEngine.ts` |
| Gate 25 implementation | `src/server/risk/ExtendedHoursExecutionPolicy.ts`, `ExtendedHoursLiquidityCache.ts` |
| Evaluation-queue serialization (DEF-09) | `RiskEngine.ts` — Promise-chain mutex |
| Position sizing math (shared with backtests) | `src/server/engines/PositionSizing.ts` |
| Capital allocation (gate 23) | `src/server/engines/CapitalAllocation.ts` |
| Daily buy notional (gate 24) | `src/server/engines/DailyBuyNotional.ts` |

---

## Java Quant Core

The three prior source documents for this topic (`JAVA_QUANT_CORE.md`,
`JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md`, `ARGUS_QUANT_OWNERSHIP_MATRIX.md`) covered the same
evolving subject from three different points in time — an entry-point summary, a 2026-08-20/21
proposal-only design doc, and a 2026-09-04 verified ownership matrix. Merged below into one
current section. **Where they disagreed, the most recent, most specific claim wins** — in practice
that is almost always the Ownership Matrix (2026-09-04), which is a verified-from-code
consolidation, not a fresh re-derivation, of two still-standalone audits:
`docs/audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md` (2026-08-21) and
`docs/audits/JAVA_QUANT_ENGINE_ARCHITECTURE_CORRECTION_AUDIT.md` /
`docs/audits/JAVA_MIGRATION_COMPLETION_PLAN_SUPPLEMENT.md` (both out of scope here — cited, not
restated).

### 2026-10-05 — Institutional strategies wired to paper verification

Two new institutional signal strategies implemented in Java (from a literature survey —
Moskowitz-Ooi-Pedersen 2012, AQR vol-scaling practice, Daniel-Moskowitz momentum-crash
research): `INSTITUTIONAL_VOL_SCALED_MTF_MOMENTUM` (20/60d drift, vol-normalized, confluence +
vol-stability gates) and `INSTITUTIONAL_TS_MOMENTUM_12M` (12-1 formation, 21d skip, reversal
guard). A third existing-but-unwired strategy, `INSTITUTIONAL_MULTI_FACTOR_MOMENTUM`, was
included. All three are reachable via the generic
`/api/v1/institutional/strategy/{strategyId}/{symbol}` dispatcher (new default case routes
any `StrategyRegistry.INSTITUTIONAL` id through `evaluateInstitutional` and serializes the
`StrategyEvaluation`).

New `src/server/services/InstitutionalStrategyVoteService.ts` emits at most one independent
`TRADE_IDEA_GENERATED` vote per strategy evaluation, gated on: strategy env flag
(`ARGUS_VOL_SCALED_MTF_MOMENTUM_VOTE_ENABLED` / `ARGUS_TS_MOMENTUM_12M_VOTE_ENABLED` /
`ARGUS_MULTI_FACTOR_MOMENTUM_VOTE_ENABLED`, all default `false`), Mission Control agent
toggle, `isLiveIdeaGenerationEnabled()`, Java `triggerMet`, confidence >=
`javaQuantVoteMinConfidence` (0.6), valid price. Downstream spine (ChiefTrader 0.75 bar,
min-2-agents, all RiskEngine gates, OMS, PAPER-only) is unchanged. `INSTITUTIONAL_STAT_ARB`
is deliberately excluded — pairs need a pair universe and short-selling.

This is PAPER_TESTING infrastructure for the quant research program
(`docs/research/quant-program/CHARTER.md`), not a profitability claim. 9 unit tests pass.
Java verification (2026-10-05, this host): JDK 26 (Temurin) + Maven 3.9.9 installed to
`~/workspace/tools/`; all 225 main sources and 190 test sources compile clean; the 13 new
tests (2 strategies + registry dispatch) pass; full suite 841/843 (2 failures are
`SqliteBarLoaderTest` needing the real `data/argus.db` market-data artifact absent here;
5 HTTP-server test classes excluded - the sandbox blocks their TCP loopback). Zero
failures in the new code.

### The one-paragraph version (current state)

`quant-core-java/` is a standalone Java 26 process (loopback-only, port 8085) that computes
indicator math, evaluates the 5 CORE quant strategies' decision logic, and runs a demonstration
backtester. It has **zero broker imports, zero credentials, and no `.placeOrder()` equivalent**.
Default is `QUANT_JAVA_CORE_ENABLED=false`, but **as of the Ownership Matrix's verification
(2026-09-04), this deployment's `.env` currently has it set `true`** (bridge active, shadow mode) —
always check the live `.env`, don't assume the documented default. When enabled,
`src/server/services/QuantCoreBridge.ts` forwards live ticks to it and logs shadow-parity
divergence; every one of its ~10 HTTP calls to the Java process is wrapped in a hard timeout
(`tradingSafety.quantJavaCoreRequestTimeoutMs`). It does **not** emit trade ideas unless a
**second**, independent flag (`QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED`) is also set — confirmed unset
in this deployment as of the matrix's verification, and per the matrix: **Java has never emitted a
real trade idea in this repository's history.** Even when both flags are set, Java only ever calls
the same `eventBus.emitTradeIdea()` every other agent uses (see § Multi-Agent Consensus above) —
never a shortcut around ChiefTrader, RiskEngine, or OMS.

### Architecture

```
Market Data (Alpaca WS / IBKR Gateway)
          |
          v
TypeScript Control Plane (EventBus, agents, ChiefTrader, RiskEngine, OMS, BrokerManager — unchanged)
          |
QuantCoreBridge.ts — HTTP client, circuit breaker, forwards ticks IF QUANT_JAVA_CORE_ENABLED=true
          |
JSON over loopback HTTP (:8085)
          |
          v
Java 26 Quant Core (quant-core-java/) — QuantCoreServer (JDK-native httpserver)
          |
onSignal() validates + clamps
          |
          v
eventBus.emitTradeIdea() — ONLY IF QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED=true (second, separate flag)
          |
          v
ChiefTraderAgent → RiskEngine → OMS → BrokerManager → Broker
```

Both flags are validated in `loadTradingSafety()` (throws if missing from config — cannot silently
vanish).

Key invariants (preserved from `CLAUDE.md`, reconfirmed by the Ownership Matrix's safety
verification):

| Check | Result |
|---|---|
| No second order path | PASS — zero `placeOrder`/broker-adapter imports anywhere under `quant-core-java/` |
| Java bypasses ChiefTrader/RiskEngine/OMS | PASS (does not) |
| Java holds broker credentials | PASS (does not) |
| Double-gated live emission | PASS — `QUANT_JAVA_CORE_ENABLED` AND `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` both required |
| Live-ideas flag ever observed true outside a test | NO evidence found |

If the Java process is down, degraded, or slow, the existing TypeScript quant path
(`src/server/quant/strategies/*`, gated by `QUANT_ENGINE_ENABLED`) continues to function exactly as
it does today — Java is additive, not a replacement; its absence must fail closed (no ideas from
that source), never fail open (never fabricate a signal).

Data access: Java never writes to `data/argus.db` (Node.js is the sole writer). The backtester's
`SqliteBarLoader` opens it **read-only** with a 5s `busy_timeout`, verified safe under real
concurrent Node writes (`SqliteBarLoaderConcurrencyTest.java`). Parity-divergence records and
backtest reports are the only persisted outputs, and both go through existing TypeScript-owned
paths (`observability_events`, generated markdown reports) — never a new Java-owned table in the
live database.

### Capability-by-capability ownership (verified 2026-09-04)

| Quant capability | TS impl. | Java impl. | Currently active | Owner | Status |
|---|---|---|---|---|---|
| SMA / EMA | `TechnicalIndicators.ts` | `indicators/MovingAverages.java` | TS (live) | TS | PARITY_VERIFIED |
| RSI | `RSIEngine.ts` | `indicators/RSI.java` | TS (live) | TS | **CORRECTED 2026-09-06**: PARITY_VERIFIED only against synthetic fixtures. Real production shadow-comparison (`QUANT_CORE_PARITY_DIVERGENCE`, 14,207 events 2026-08-24→09-04) shows 80% diverging >5%, 56% diverging >20% on real ticks. See `docs/audits/ARGUS_CURRENT_STATE_AND_PAPER_READINESS_AUDIT.md` §17. Root cause not yet investigated. |
| MACD | `MACDEngine.ts` | `indicators/MACD.java` | TS (live) | TS | Same correction as RSI above — implicated in the same divergence data. |
| Bollinger Bands | `technicalSignal.ts` | `indicators/Bollinger.java` | TS (live) | TS | PARITY_VERIFIED against synthetic fixtures; not separately broken out in the production divergence data above (RSI/MACD/MACD-signal were the fields checked) — unconfirmed either way in real traffic. |
| ATR / volatility (tick-range) | `TechnicalIndicators.ts` | `indicators/Volatility.java` | TS (live) | TS | PARITY_VERIFIED |
| Rolling statistics | `quant/statistics.ts` | `stats/RollingStatistics.java` | TS (live) | TS | PARITY_VERIFIED |
| Correlation/covariance/beta/skew/kurtosis/autocorrelation | `statistics.ts` | `stats/Correlation.java` | TS (live) | TS | PARITY_VERIFIED |
| Kelly / Expected Value | `quant/risk/ExpectedValue.ts` | `risk/ExpectedValue.java` | TS (live, idea-suppression only) | TS | PARITY_VERIFIED |
| MOMENTUM_BREAKOUT / PULLBACK_CONTINUATION / MEAN_REVERSION / TREND_FOLLOWING / RANGE_REVERSION (decision logic) | `quant/strategies/*.ts` | `strategy/core/*.java` | TS (live) | TS | PARITY_VERIFIED — decision logic only; could not run standalone on real bars until §"JMIG-001" below closed |
| Trend / volatility / price-action / volume / support-resistance feature computation | `quant/indicators/{trend,volatility,priceAction,volume,supportResistance}.ts` | `io.argus.quantcore.features.*` (ported 2026-09-04) | TS (live) | TS | **PORTED, parity-verified, NOT wired** — see JMIG-001 below |
| Regime classification (`classifyRegime`) | `quant/RegimeEngine.ts` | `io.argus.quantcore.features.RegimeEngine` (ported 2026-09-04; distinct from the unrelated `institutional/models/HmmRegimeEngine.java`) | TS (live) | TS | **PORTED, parity-verified; shadow-wired 2026-09-05** — see JMIG-001 below |
| Market context (`getMarketContext`) | `quant/MarketContext.ts` | `io.argus.quantcore.features.MarketContext` (ported 2026-09-04) | TS (live) | TS | **PORTED, parity-verified, NOT wired** |
| VWAP, SMC primitives | `volume.ts`, `smcConfluence.json`-driven | none | TS (live/flag-gated) | TS | NOT_IMPLEMENTED_IN_JAVA — low migration urgency |
| Experimental strategies (~15) | TS only | none | TS, env-flag-gated | TS | TS_ONLY — correctly not migrated |
| Backtesting loop | `BacktestEngine.ts` (SAME_BAR_CLOSE) | `JavaBacktestEngine.java` (configurable) | Both exist independently | Neither — separate research tools | NOT_TESTED for trade-level parity (disclosed gap) |
| Position sizing / capital allocation / RiskEngine gates | `PositionSizing.ts`, `CapitalAllocation.ts`, `RiskEngine.ts` | none | TS (live, protected spine) | TS | **DO NOT MIGRATE** — control-plane, not quant-domain |
| GARCH / HMM regime / OLS / ADF / OU / EWMA covariance / StatArb / multi-factor alpha (institutional layer) | none | `institutional/math/*`, `institutional/models/*`, `institutional/features/*`, `institutional/data/*` | Neither — isolated, zero live wiring | Java (no TS equivalent) | JAVA_ONLY research module; **not** a port of anything above |

### Multi-Library Java Quant Decision Intelligence Integration (2026-09-23, in progress)

Operator-dispatched mandate to strengthen `quant-core-java/` with external, independently-authored
open-source Java quant libraries as an additional evidence source — never a replacement for the
protected spine, never a second order-execution path. Full mandate text and phase structure are in
the dispatching conversation, not reproduced here; this section records what was actually built,
labeled by verification level, not the mandate's aspirational scope.

**Phase 0 (library research — SOURCE VERIFIED, checked live against Maven Central
`maven-metadata.xml` and each project's own `pom.xml` at its release tag, not training-data
assumptions):**

| Library | Version | Java floor | License | Verdict |
|---|---|---|---|---|
| ta4j | 0.25.0 | 25+ (real, Maven-Enforcer-checked) | MIT | Added — independent indicator-parity reference only |
| ojAlgo | 57.3.1 | 11 | MIT | Added — zero production dependencies, real matrix/LP/QP/MIP capability |
| finmath-lib | (researched, not added) | 11 | Apache-2.0 | Deferred — pulls in `jblas`, a native/JNI-backed dependency with real cross-platform loading risk, not isolation-tested |
| OpenGamma Strata | (researched, not added) | unverified | Apache-2.0 | Deferred — OTC-derivatives/rates/FX pricing domain, near-zero overlap with Argus's equity trading scope (matches the existing `NOT_SUPPORTED` list already excluding options/CAD FX) |

Both added dependencies (`quant-core-java/pom.xml`) resolve with a lean, non-conflicting transitive
tree (`mvn dependency:tree`, TEST VERIFIED): ta4j pulls `slf4j-api`/`commons-math3`/`gson`; ojAlgo
pulls nothing. No Java-runtime change was required (Argus already targets Java 26 via
`maven.compiler.release`).

**Phase 2/3 — `Ta4jTechnicalParityEngine.java`** (`institutional/models/`, strategyId
`ta4j_technical_parity`, `config/engineOwnership.json` status `RESEARCH`): wraps ta4j's own
`RSIIndicator`/`MACDIndicator`/`SMAIndicator`/`EMAIndicator`/Bollinger indicators solely to compare
against Argus's existing, TS-ported `indicators.RSI`/`MACD`/`MovingAverages`/`Bollinger` — the same
class of bug the 2026-09-22 `MACDEngine` EMA-seeding defect was (found by comparing two
independently-authored implementations, not by re-reading one harder). Never emits a signal or
confidence value; returns raw `(argusValue, ta4jValue, absoluteDifference)` triples per indicator.

Real finding (TEST VERIFIED, `Ta4jTechnicalParityEngineTest`, and a one-off diagnostic run captured
here for the record): on a 120-bar synthetic series, RSI agrees to within ~0.04 (both sides
implement the same Wilder warmup convention, so this is a meaningful parity check, not a coincidence
— a real RSI divergence beyond floating-point epsilon would be a defect signal). EMA/MACD/Bollinger
diverge more at the 27-bar minimum (EMA ~0.93, MACD ~3.3) because Argus's EMA deliberately seeds with
the raw first price (a preserved TS quirk — see `MovingAverages.java`'s own doc comment) while ta4j
seeds with a period-SMA; that divergence decays exponentially and was ~8e-5/~0.003 by 120 bars. This
is a real, explained `WARMUP_DIFFERENCE`, not a defect in either implementation — Argus was **not**
changed to match ta4j, per the mandate's own explicit rule against doing so.

**Phase 4 — `OjAlgoPortfolioRiskEngine.java`** (`institutional/models/`, strategyId
`ojalgo_portfolio_risk`, `RESEARCH` status): real dense-matrix portfolio variance
(`w^T · Σ · w`) and per-symbol marginal risk contribution (`RC_i = w_i · (Σw)_i`, the standard
Qian (2006) risk-budgeting decomposition where `ΣRC_i` equals total portfolio variance exactly) via
ojAlgo's `MatrixR064` transpose/multiply — a genuine capability gap (this module had no previously
tested, general matrix-algebra implementation). Portfolio-level, not per-symbol: covariance/weights
are request-body fields; `closes`/`bars` are unused but still required by the shared institutional-
strategy HTTP contract (a minimal 1-bar array satisfies it). Advisory only — has no authority over
`PositionSizing.ts` or RiskEngine gate 17 (`symbol_concentration`); can only flag a caller-supplied
`maxWeightPct` bound. Does not implement ojAlgo's LP/QP/MIP solver (a larger, distinct follow-up).
Verified (TEST VERIFIED, `OjAlgoPortfolioRiskEngineTest`) against a hand-computable diagonal-
covariance closed-form case, agreeing to `1e-9`.

**Execution-semantics validation (2026-09-23, operator-directed correction: "framework available" is
not "validated"):** `Ta4jNextOpenExecutionParityTest.java` (`quant-core-java/src/test/java/io/argus/
quantcore/backtest/`) proves, on a hand-designed deterministic fixture, that ta4j's own built-in
`TradeOnNextOpenModel` fills at exactly bar T+1's open when a signal fires at bar T — byte-for-byte
the same entry/exit timing rule as Argus's real canonical research engine
(`src/server/research/canonicalNextBarEngine.ts`'s `applyNextBarLongFills`: `exec = signalIndex + 1`,
fill price = `bars[exec].open`). A second assertion confirms the two structurally different cost
mechanisms (Argus: spread/slippage baked into the fill price plus a separate per-share commission;
ta4j: a `CostModel` fee applied to the trade) reconcile to the same net PnL when fed the same raw
fill prices — hand-computed and verified (`103 → 103.103` buy, `106 → 105.894` sell, net PnL
`278.1` for an illustrative cost configuration). A second test proves the fill index is never equal
to the signal index itself (no look-ahead in this dimension).

**Scope, stated honestly — this validates 2 of the operator's 11 named dimensions (entry/exit timing,
cost-model reconciliation), not all of them.** Explicitly NOT validated and not claimed to be:
stop/target gap-through behavior (ta4j's `StopLimitExecutionModel` is a structurally different
ratio-trigger/partial-fill/pending-order-lifecycle model, not Argus's simple all-or-nothing
`bar.low <= stop` check — needs its own separate, carefully-configured comparison), partial fills,
warmup, look-ahead prevention beyond this one timing check, session/timezone boundaries, or
corporate actions. These remain open, named follow-up work, not silently assumed correct by this
test passing.

**What was explicitly NOT done this pass (honest scope boundary, not a defect):** no evidence-family/
independence metadata layer, no SHADOW-mode runtime wiring, no confidence normalization, no
cross-library golden-vector regression suite beyond the two test files above, no finmath-lib/Strata
implementation, no promotion-ladder integration, no decision-path wiring of any kind. Both new
engines have **zero HTTP consumers** (`liveConsumer: NONE` in `config/engineOwnership.json`, matching
~30 other `RESEARCH`-status engines already in this file) — they exist, compile, pass their own
tests, and are reachable via `POST /api/v1/institutional/strategy/{id}/{symbol}` for manual/research
use, but nothing in the live or shadow decision path calls them. Full Java suite green after this
change (TEST VERIFIED: 897 tests, 0 failures, 0 errors, `mvn -o test`, exit 0). No TypeScript files
were touched — this is a pure Java-module addition, so no TS regression was required and none was run.

### Evidence-family / methodology-family / data-dependency taxonomy (2026-09-23, roadmap item #1)

Operator-directed Priority #1 of the "Argus World-Class Open-Source Quant Expansion" program: build
the evidence-family/independence model before adding more decision sources. Audit found this was
**already partially real and live**, not greenfield: `evidenceIndependence.ts`'s
`resolveIndependentEvidenceGroup()` (2026-09-20 forensic-audit remediation) already collapses
`QuantEngine`/`JavaCoreEnsemble` into one independent-evidence group inside the actual live
`ChiefTraderAgent.ts` approval math (`uniqueIndependent`/`enoughIndependentVoices`) — grouping only
where source-verified structural overlap exists, fail-closed otherwise. This work extends that
mechanism additively rather than replacing it.

`src/server/services/evidenceFamilyTaxonomy.ts` (new) adds a richer, purely-observational
classification layer — `methodologyFamily`/`dataDependency`/`currentlyLive` per agent, reusing
(never recomputing) `resolveIndependentEvidenceGroup()` for the actual independence value. Covers
every currently-live evidence producer (`TechnicalAgent`, `NewsAgent`, `FundamentalAgent`,
`MacroAgent`, `KronosEngine`, `QuantEngine`, `JavaCoreEnsemble`, `JavaFactorComposite`,
`OpportunityScreener`, `TradePlanBuilder`, `PortfolioManager`, `ConsensusDebate`) plus two
explicitly-not-live placeholder entries (`Ta4jTechnicalParity`/`OjAlgoPortfolioRisk` — proposed
future names, not constants referenced anywhere else; nothing emits under either name today) so
that IF either research engine is ever wired to vote, its independence classification is already
decided and reviewed rather than retrofitted the day it's turned on. An unrecognized agent name
returns `UNCLASSIFIED`/`UNKNOWN`/`currentlyLive: false` rather than a guessed family — same
fail-closed convention as `evidenceIndependence.ts`.

Wired into `ChiefTraderAgent.ts`'s existing unconditional `CONSENSUS_TERMINAL_REASON` structured
log (`observability_events`) as a new, additive `evidenceFamilies` field alongside the pre-existing
`evidenceGroups` — **never read by any approval/confidence math**, verified by the regression suite
(`evidenceFamilyTaxonomy.test.ts`, 5 tests; the existing `ChiefTraderAgent.evidenceIndependence.test.ts`
suite passes unmodified, proving zero change to live consensus behavior).

**Probability/uncertainty contract — foundation only, not wired.** `EvidenceAggregator.ts` gained an
optional `ProbabilisticEnvelope` field on `Evidence` (`expectedReturnPct`/`downsideProbability`/
`expectedShortfallPct`/`regimeProbability`/`outOfDistributionProbability`/`modelSource`) — no
current producer populates it, and neither `netConfidenceFromVotes()` nor `EvidenceAggregator.aggregate()`
read it. This defines the shape a future evidence producer (e.g. `ForecastEngine.java`'s own
expected-return/probability-of-profit output) could populate once a validated distributional model
exists, so ChiefTrader has somewhere real to read from when that work is undertaken. **Deliberately
not wired into confidence or approval math in this pass** — per the operator's own explicit
sequencing correction, actually consuming distributions in ChiefTrader is separate, larger,
higher-risk work that comes after the data/cost/validation foundations below, not alongside this
observability-only piece.

Full regression: targeted suite (23 tests, `evidenceFamilyTaxonomy.test.ts` +
`ChiefTraderAgent.evidenceIndependence.test.ts` + `EvidenceAggregator.test.ts`) green;
`tsc --noEmit` clean.

### JMIG-001 — the feature-computation pipeline: ported, parity-verified, shadow-wiring started

This was the one gap identified by the 2026-08-21 status audit and the migration blueprint's
priority list as **blocking any further live-authoritative Java migration**: the 5 CORE
strategies' decision logic was ported and parity-tested, but the upstream feature-computation
pipeline (`RegimeEngine`, `MarketContext`, trend/volatility/price-action/volume/support-resistance
feature extraction — 1,291 TS lines total) that turns real `Bar[]` history into the
`StrategyContext` those strategies need was not — meaning Java's CORE strategies could only be
exercised against synthetic fixtures, never real market bars.

**Update (2026-09-04): closed at the calculation layer.** The pipeline is now ported
(`io.argus.quantcore.features.*`: `TrendFeatures`, `VolatilityFeatures`, `PriceActionFeatures`,
`VolumeFeatures`, `SupportResistanceFeatures`, `RegimeEngine`, `MarketContext`, plus supporting
`TechnicalIndicatorsCompat`/`StatisticsMath`/`FeatureThresholds`), verified byte-for-byte against
real captured TypeScript ground truth (`Phase2FeatureParityTest`, 9/9 passing, tolerance 1e-6,
re-run against the full `mvn test` suite — 341/341, `BUILD SUCCESS` at verification time; re-run
`mvn test` yourself for the current count). Spot-checked independently on the two highest-risk
files (`RegimeEngine.java`'s dead-zone/vote-counting logic, `MarketContext.java`'s `minOverlap`
correlation/beta semantics) — both confirmed faithful.

**Update (2026-09-05): shadow wiring deployed live, soak clock started.** `QuantSignalAgent.ts`'s
`evaluateSymbol()` now calls `QuantCoreBridge.compareRegimeParity(symbol, bars, regime)`
immediately after its own real `classifyRegime(bars)` call — fire-and-forget, double-wrapped
(async `.catch()` plus a synchronous try/catch), gated solely by the existing
`QUANT_JAVA_CORE_ENABLED` flag. Deployed to the live engine 2026-09-05T13:02 UTC after full suite
verification (TS 62/62 targeted + tsc clean; Java 344/344 `mvn test`) and a clean reconciliation
check. This is the first moment any real divergence data can exist — check `observability_events`
for `QUANT_CORE_REGIME_PARITY_DIVERGENCE` rows for accumulated soak data (zero as of deployment).

**What is still NOT done, as of the last verification:**
- `QuantSignalAgent.ts` still uses ONLY its own TS `classifyRegime`/`getMarketContext` output for
  every real decision — the Java comparison is observation-only.
- `FullArgusReplayEngine.ts` does not call the Java pipeline at all.
- `MarketContext`/full feature-set comparison was deliberately not wired (regime-only, by design).
- No TS file has been touched, deprecated, or deleted.
- `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` remains unchanged and must not be set true until a real,
  multi-week shadow-soak period (no shortcuts on calendar time, per the original migration
  blueprint's own precondition) is complete — a few hours or days of clean samples is **not**
  sufficient. This is a distinct flag/code path from the override immediately below — it governs
  `QuantSignalAgent.ts`'s own TS-vs-Java regime-parity comparison, which is still untouched.

**2026-09-09 addendum — a narrower, separate override, explicit operator decision:** the same
"real multi-week shadow-soak, no shortcuts on calendar time" precondition above also governed
whether `JavaQuantAdvisoryService.ts`'s `factor_composite` advisory (GARCH/HMM-regime/5-factor
composite, `SHADOW` status per `config/engineOwnership.json`) could ever call `emitTradeIdea`. The
operator was told that precondition directly — the shadow soak had not run to completion — and
chose to override it anyway, the same way `ARGUS_TRADE_PLAN_IDEAS_ENABLED` overrode
`TradePlanShadowTracker`'s equivalent precondition on 2026-09-05. `emitJavaQuantVoteIfEligible()`
(new function, same file) now casts one independent vote (agent `JavaFactorComposite`) into the
unchanged ChiefTrader consensus whenever `ARGUS_JAVA_QUANT_VOTE_ENABLED` (off by default, on in
this deployment's `.env`) plus Autobot/session-recovery plus the `JavaFactorComposite` Mission
Control toggle are all on, AND Java's own advisory-level gating already trusts the signal
(`!advisory.gated`, directional side, `adjustedConfidence >= tradingSafety.javaQuantVoteMinConfidence`
— 0.6). This override is scoped to that one advisory/vote path only — `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED`
above (a different flag, a different code path in `QuantSignalAgent.ts`) remains untouched and
still gated on the real precondition.

**2026-09-09, same day, a second and materially larger override — QuantEngine internal-ensemble
independent qualification:** distinct from the `factor_composite` vote above, this changes the
*shape* of ChiefTrader's own approval requirement rather than adding one more vote to it. The
`ARGUS_QUANTENGINE_EXPANSION_DESIGN_2026-09-09.md` companion audit (§16) recommended against this
specifically — `QuantEnsembleEngine.java`'s `effectiveIndependentCount()` correlation matrix is a
reviewed assumption, not measured data, and no historical strategy-outcome ledger exists yet to
show strong internal consensus outperforms weak consensus. Told this directly, the operator
overrode it anyway. Implementation: `src/server/quant/internalQuantEnsemble.ts` builds one combined
vote list (currently-firing TS strategies + 10 Java RESEARCH engines newly reachable via
`QuantCoreServer.java`'s generic `/api/v1/institutional/strategy/{strategyId}/{symbol}` dispatcher,
`src/server/quant/strategyFamilies.ts`'s real family classification), scores it through
`QuantEnsembleEngine.java`, and — only when `ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED` is on
(off by default, on in this deployment's `.env`) — lets `ChiefTraderAgent.ts` treat a single
`QuantEngine` idea as satisfying the independent-voice floor when it clears a bar strictly above the
normal 2-agent minimum (`minQuantIndependentFamilies` 3, `minQuantIndependentEffectiveCount` 2.5,
`config/tradingSafety.json`), reported as decision tier `QUANT_INDEPENDENT`. Every other requirement
(0.75 STRONG confidence, hard vetoes, RiskEngine's 25 gates, OMS) is unchanged — this substitutes
only for the second agent. See `docs/audits/ARGUS_QUANTENGINE_EXPANSION_DESIGN_2026-09-09.md` §16
for the full evidence-based reasoning this overrides, and this file's own tests
(`ChiefTraderAgent.quantIndependent.test.ts`, `internalQuantEnsemble.test.ts`) for the
flag-off-is-byte-for-byte-unchanged proof.

**2026-09-10, third and structurally distinct override — CORE-strategy Java ensemble
(`CoreStrategyRunner` → `JavaCoreEnsemble` → `emitTradeIdea`):** unlike the two overrides above
(which source from `JavaFactorComposite`'s SHADOW-status GARCH/HMM/factor-composite engines, or
from a mixed TS-strategy + Java-RESEARCH-engine vote list), this one is Java's own 5 CORE-strategy
ports (RangeReversion/PullbackContinuation/MeanReversion/TrendFollowing/MomentumBreakout, each
computing its own features from canonical bars via `FeaturesToStrategyContextAdapter`, never fed
TS's precomputed `StrategyContext`) combined through the same reused `QuantEnsembleEngine.java`
math. This signal was already being called every `QuantSignalAgent` cycle for shadow-parity
comparison (`QUANT_CORE_STRATEGY_PARITY_DIVERGENCE`, ~99 real observations at override time — see
`docs/audits/ARGUS_JAVA_QUANT_PHASE2_PRELIMINARY_PARITY_2026-09-10.md`), short of this codebase's
own documented multi-week soak precondition — disclosed directly before the override, same as the
two above. `src/server/services/JavaCoreEnsembleVoteService.ts`'s `emitJavaCoreEnsembleVoteIfEligible()`
casts one independent vote (agent `JavaCoreEnsemble`) into the unchanged ChiefTrader consensus,
gated behind **four** independent checks — one more than the `JavaFactorComposite` precedent:
`ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED` (off by default, on in this deployment's `.env`),
`isLiveIdeaGenerationEnabled()`, the `JavaCoreEnsemble` Mission Control toggle, plus
`ensemble.status === 'HEALTHY'` (Java's own data-sufficiency gate — `DEGRADED`/`UNAVAILABLE` never
votes, never conflated with a directional `HOLD`) and `confidence >= javaCoreEnsembleVoteMinConfidence`
(0.6, reusing `javaQuantVoteMinConfidence`'s reasoning, not a new invented number). No
double-counting with `JavaFactorComposite`: different Java engine, different features, different
flag — both can vote independently on the same symbol as two genuinely separate opinions. See
`docs/audits/ARGUS_JAVA_QUANT_WIRING_IMPLEMENTATION.md`'s "Phase 3" section for the full evidence
matrix, and `CLAUDE.md` § Java 26 Engine Authority for the equivalent operator-facing summary.

**2026-09-18 quote-freshness correction:** `JavaCoreEnsembleVoteService` also checks the
latest observed quote and its age when the asynchronous Java result arrives, using the existing
`evaluateQuoteFreshness` threshold. A historical bar close cannot establish current freshness.
Missing/stale quotes emit `DESK_NO_TRADE` / `STALE_MARKET_DATA` and no trade idea. Eligible ideas
carry the observed quote price. This adds no execution authority or threshold relaxation.

**2026-09-27 portfolio-impact research report (Master Redesign Plan Phase 5):** a new,
read-only, advisory-only reporting tool — `src/server/research/portfolioImpactReport.ts`
(`GET /api/v2/observability/portfolio-impact`, `argus-cli portfolio-impact`) — answers "what would
happen to portfolio risk if a hypothetical trade were added," using the real current portfolio
(`BrokerManager.getActiveBroker().portfolio()`) and real historical bars, routed through the
existing `QuantCoreBridge`/generic institutional-strategy dispatcher to two Java engines:
`OjAlgoPortfolioRiskEngine.riskContributions()` (Euler risk-contribution decomposition, already
existed) and a newly added `portfolio_min_variance_optimizer` dispatcher case exposing the
already-tested `PortfolioOptimizationEngine.minimumVariance()` (which previously had no HTTP
endpoint at all). Both remain RESEARCH-status, zero decision-path consumer per
`config/engineOwnership.json` — this report is their first, and still only, caller, and it never
imports `OrderManagement`/`RiskEngine`/`ChiefTraderAgent`/`PositionSizing`, never calls
`.placeOrder(` or `emitTradeIdea`, and fails closed (`BROKER_UNAVAILABLE`,
`INSUFFICIENT_RETURN_HISTORY`, `JAVA_QUANT_CORE_UNAVAILABLE`) rather than fabricating a covariance
matrix or optimizer weight. `architecture.protection.test.ts`'s `ALLOWED_BROKER_MANAGER_IMPORTERS`
allowlist was extended for this file with a dated, reviewed comment — not a silent bypass.

**2026-09-27 Phase 6 (Master Redesign Plan, final phase) — governance audit + calibration drift
report + why-no-trade addition:**

- **Adaptive/self-improvement safety re-verification.** Re-confirmed against current source (not a
  stale citation): `runEvolutionCycle` (`src/server/research/evolution/StrategyEvolutionEngine.ts`)
  has exactly two callers in the whole repository, both in
  `evolutionEndToEnd.test.ts` — no production scheduler, route, or worker calls it, so its `force`
  option (which bypasses the evidence gate) is unreachable outside a test process. No code change
  was needed; this is a re-verification, not a fix.
- **New: Calibration Drift Report** (`src/server/research/calibrationDriftReport.ts`,
  `GET /api/v2/observability/calibration-drift`, `argus-cli calibration-drift`). Closes a real gap:
  `CalibrationCandidateBuilder.buildCalibrationCandidates()` (Phase 7D/7E) recomputes each
  (agent, bucket)'s calibration from its *entire* pooled observation history — no code compared a
  recent window's effective-sample accuracy against an older window's to flag degradation. This
  report does exactly that, reusing the same raw-row fetchers
  (`fetchAgentPredictionRows`/`fetchKronosRows`/`toClusterableRows`, now exported for this purpose)
  and the same Wilson-interval/effective-sample machinery (`effectiveSampleSize.ts`) — no new data
  collection, no new table. A bucket is `DRIFT_SUSPECTED_DEGRADED`/`_IMPROVED` only when the two
  windows' 95% Wilson intervals don't overlap at all, and `INSUFFICIENT_SAMPLE` when either window's
  effective N is below `continuousIntelligence.calibrationDriftMinEffectiveSample` (8) — never a
  fabricated verdict. Window lengths (`calibrationDriftRecentWindowMs`/`calibrationDriftPriorWindowMs`,
  14 days each by default) are policy parameters in `config/continuousIntelligence.json`, not
  measured values. Purely read-only: never writes `agent_confidence_calibration`, `currentWeight`,
  or any live gate — a human (or a future, separately-authorized governance step) decides what to
  do with a flagged bucket. See `calibrationDriftReport.readOnly.test.ts` for the same
  architectural-guarantee test pattern `portfolioImpactReport.readOnly.test.ts` established.
- **why-no-trade addition:** `WhyNoTradeReport` gained `nextEligibleReevaluationAt`, computed only
  for the three cooldown-style RiskEngine gates whose own `OvertradingGuards.ts` detail JSON already
  records a reference timestamp + `cooldownMs` (`same_symbol_cooldown`, `post_loss_cooldown`) — null
  for every other rejection reason rather than guessing a time that doesn't exist as a fixed clock
  value (e.g. `symbol_concentration`, `market_hours`).
- **Reliability:** re-confirmed (not re-fixed) that `QuantCoreBridge.ts` applies a request deadline
  (`AbortSignal.timeout(tradingSafety.quantJavaCoreRequestTimeoutMs)`) to every one of its ~15 HTTP
  call sites and has explicit stale/misrouted-response defense (module comment, line ~335) — this
  session's own Batch 4 work, still true against current source. No new async-path gap was found or
  closed this phase beyond the calibration-drift report above.

`marketDataReadiness.ts` supplies the same read-only feed evidence to `pipeline-ready` and
`session-report`: connectivity alone is insufficient; at least one active symbol must have a
valid, fresh observed price. Its counts describe partial feed coverage, not readiness of every
candidate. Each candidate still faces its own freshness checks. A never-ticked Technical/Quant
agent is not excused as an expected idle state during the regular session. Outside that session,
idle can be expected, while absent fresh quotes still prevent a feed-ready claim.

**Unrelated but important discovery made while verifying this work:** the repo's root
`.gitignore` had a bare `models/` pattern that was also silently matching
`quant-core-java/src/{main,test}/java/io/argus/quantcore/institutional/models/` at any depth — the
entire "institutional layer" Java package (36 files: `GarchEngine`, `HmmRegimeEngine`,
`FactorAlphaEngine`, `StatArbEngine`, others) had **never once been committed to git**, despite
being real, on-disk, and referenced as built/tested in three prior audit documents. Fixed by
anchoring the pattern to `/models/` (repo-root only).

### Root cause of the original TS-vs-Java shadow-parity divergence (found 2026-08-26, not an
algorithm defect)

RSI/MACD/Bollinger are byte-for-byte identical between TS and Java on identical fixed-length
inputs. The live divergence instead came from `QuantCoreBridge.ts` and `SymbolState.java`
maintaining **different-length** rolling tick histories for the shadow comparison itself (TS
capped at 52 ticks, Java at 200) — since these indicators recompute fresh over the entire passed
array each call, feeding two different-length slices of the same tick stream into identical
algorithms reliably diverges. Fixed by adding `tradingSafety.quantJavaCoreLocalHistoryCap` (200,
matching Java's `CircularDoubleArray` capacity) so both sides compare over the same window length.

### Target architecture — deterministic Quant authority (2026-09-10 ADR, pointer only)

Full decision record, model classification, correlation/ensemble design, canonical-data protocol
design, AI/Java failure matrices, and staged implementation plan:
`docs/audits/ARGUS_JAVA_QUANT_AUTHORITY_ADR_2026-09-10.md`. Not repeated here — summary only:

- **Verdict:** Java Quant Core should become *a* deterministic quantitative foundation alongside
  TS's own `StrategyEngine.ts` — not the sole one. TS `StrategyEngine` stays permanently supported
  (not a legacy shim) specifically because it has zero external-process dependency, which is a real
  resilience property a Java-only design would give up for no offsetting benefit.
- **New finding, not previously documented:** the already-ported, already-parity-verified
  `io.argus.quantcore.features.*` package (`RegimeEngine.java`, `MarketContext.java`, etc.) is
  **not connected** to `io.argus.quantcore.strategy.types.StrategyContext` (the type the 5 CORE
  Java strategies actually consume) — two separate, disconnected record hierarchies for the same
  concept, with zero adapter between them. This is the concrete, smaller-than-expected P0 (an
  adapter class + a real shadow caller for `/api/v1/evaluate`), not a from-scratch FeatureEngine
  build.
- **Correlation/independence:** reuse `QuantEnsembleEngine.java`'s existing Kish/Grinold-Kahn
  `effectiveIndependentCount()` math (already real, already live via `internalQuantEnsemble.ts`) —
  do not build a second correlation system.
- **AI dependency:** confirmed via direct source read that `TechnicalAgent` + `QuantSignalAgent`
  (both zero-AI-dependency) already suffice to satisfy `minIndependentAgreeingAgents` without any
  LLM call — `ChiefTraderAgent.ts:455-473`'s `hasAnyRoutableProvider()` check already skips the
  debate (not a fabricated HOLD) on total AI outage. Gap found: partial AI degradation (some
  providers up, the attempted one fails) still produces a real fail-closed HOLD via
  `pushDebateFailClosed()` — backwards from total-outage handling, a named fix candidate.
- **Open risk named directly, not silently accepted:** both 2026-09-09 overrides
  (`JavaQuantAdvisoryService.emitJavaQuantVoteIfEligible()`, `isQuantIndependentQualificationEnabled`)
  are live in production paper trading (`.env` confirmed: `ARGUS_JAVA_QUANT_VOTE_ENABLED=true`,
  `ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED=true`) ahead of the canonical tick-delivery fix
  above — a real data-quality risk, not a safety-gate violation.
- **A second, unresolved conflict found this pass:** this section's own 2026-08-26 "root cause...
  fixed via history-window-length alignment" note may not fully explain the Forensic Audit's
  2026-08-24→09-04 divergence figures (a window spanning both sides of that fix). See the ADR's §6
  addendum for the recommended fresh, date-segmented measurement.

### Migration blueprint status (2026-08-20/21 proposal — mostly superseded by the above, kept for
roadmap context)

The blueprint (repo state at the time: `main`, Node `24.18.0`, `npm test` 323 files/2075 tests
green) was explicitly **"PROPOSAL ONLY. Not started, not approved, not scheduled"** and remains the
reference for anyone picking up further migration phases. Its phased roadmap (Phase 0 scaffolding →
Phase 1 math parity → Phase 2 shadow deployment → Phase 3 gated live emission → Phase 4 backtest
throughput, independent) is superseded in sequence by what actually happened (JMIG-001's feature
pipeline landed and shadow-wired ahead of/alongside this roadmap), but its **out-of-scope list
still governs**: `RiskEngine.ts`, `PositionSizing.ts`, `CapitalAllocation.ts`,
`OrderManagementService`, `BrokerManager` + adapters, `ChiefTraderAgent`'s consensus/debate logic,
the kill-switch system, reconciliation — moving any of these breaks the single-process-serialized-
mutex guarantees `CLAUDE.md` documents as load-bearing (`RiskEngine.evaluationQueue`,
`SystemBootstrap.isRunning`, WAL single-writer SQLite access). A cross-process hop on any of these
turns a correctness guarantee into a network race.

The blueprint's honest performance framing still holds: **there is no measured production evidence
of a TypeScript performance emergency.** `tradingSafety.json`'s `quantMaxConcurrentSymbols: 1` and
`quantCycleIntervalMs: 300000` (5 min) are deliberate rate-limiting/API-politeness choices (Alpaca/
AlphaVantage budgets), not symptoms of an overloaded event loop. `RiskEngine.evaluateRisk()`'s
serialized Promise-chain mutex is a correctness mechanism, not a perf bottleneck, and per the
blueprint should **not** move to Java. Java migration should be scoped and communicated as a
**future scale-out and research-velocity investment**, not an urgent fix.

### Verdict (as of the Ownership Matrix, 2026-09-04/05)

```
HAS ALL ELIGIBLE TS ENGINE LOGIC MIGRATED TO JAVA?  PARTIAL — JMIG-001's calculation layer is now
                                                     ported and parity-verified; wiring/shadow-
                                                     soak/cutover have started but not completed.
IS JAVA AUTHORITATIVE FOR ANYTHING LIVE TODAY?      NO — still zero live callers of the new pipeline
                                                     for real decisions (shadow-comparison only).
CAN NEW QUANT LOGIC BE ADDED IN TYPESCRIPT?         NO, per CLAUDE.md's Java 26 Engine Authority.
IS DELETION OF ANY TS QUANT FILE AUTHORIZED YET?    NO — not until the Java port is wired, soaked in
                                                     shadow mode, and confirmed working.
NEXT STEP:                                          Continue the real shadow-soak period on the
                                                     regime-parity wiring already deployed before any
                                                     live-ideas consideration; MarketContext/full
                                                     feature-set comparison remains unwired.
```

### CLI

```bash
./argus quant-core   # connectivity + enabled state
./argus parity       # recent shadow-parity divergences
./argus replay run --engine java ...   # the DIFFERENT demonstration backtester, not real replay
```

See `ARGUS_CLI.md` §4/§8 for details on each.

---

## Python AI/ML Service (Chronos / FinBERT)

**Audited 2026-09-05, at explicit operator request, specifically to decide whether to migrate this
service to FastAPI. Verdict: no — see § Should this become FastAPI? below.**

### What it is

`scripts/local_ai_service.py` (306 lines) — a single persistent Python process backing
`KronosInference.ts`'s real forecast calls and the news/sentiment pipeline's FinBERT scoring. Not a
framework-based service: a bare `http.server.BaseHTTPRequestHandler` on top of a bounded
`ThreadingHTTPServer` subclass. Loads both models once at startup and keeps them resident — never
reloaded per request. Launched via `npm run ai:serve`; the Node side (`KronosModelManager.ts`)
polls `GET /health` and treats an unreachable service as "unavailable," never fatal.

Two supporting modules, both deliberately kept model-independent so they're unit-testable without
a 15-30s Chronos/FinBERT load:
- `scripts/lib/bounded_http_server.py` (88 lines) — `BoundedThreadingHTTPServer`, `send_json_and_close`, `start_graceful_shutdown`.
- `scripts/lib/inference_worker.py` (79 lines) — `run_on_inference_worker()`, a single dedicated worker thread.

### Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `status`, `model`, `sentimentModel`, `device`, `memoryUsage`, `committedMemoryMb`, `threadCount`, `gpuUsage`, `lastInferenceMs` |
| POST | `/forecast` | `{prices, horizon}` → Chronos quantile forecast (`low`/`median`/`high`, `num_samples=40`) |
| POST | `/sentiment` | `{text}` → FinBERT `{label, score, signedScore}` (text hard-capped at 2000 chars before the model's own 512-token internal truncation) |

### The real defect this service had, and the real fix (not a framework problem)

A 2026-09-04 readiness audit found this process holding **6,451 threads and 15,245.9 MB of
committed (pagefile) memory while having served zero inferences** — RSS stayed low the whole time
(Windows trims idle thread stacks from the working set), so a memory monitor watching RSS alone
read "NORMAL" throughout. Root cause, found and fixed in two layers:

1. **HTTP-layer symptom** (`bounded_http_server.py`): stock `http.server.ThreadingHTTPServer`
   spawns one thread per accepted connection with no ceiling. Fixed with a real bounded semaphore
   (`BoundedThreadingHTTPServer`, `MAX_CONCURRENT_CONNECTIONS`, default 8), an explicit
   `Connection: close` on every response instead of relying on keep-alive inference, and a
   per-connection socket timeout (`CONNECTION_TIMEOUT_SECONDS`, default 30s). This fix alone was
   confirmed **insufficient**.
2. **Actual root cause** (`inference_worker.py`): `ThreadingHTTPServer`, even bounded, still hands
   each connection a *brand-new* `threading.Thread` — never a thread drawn from a reused pool. The
   first time any given OS thread calls into PyTorch/MKL/OpenMP-backed code, those native backends
   initialize a per-calling-thread native worker pool that is cached at the process level and never
   torn down — confirmed live: 8 sequential real `/forecast` calls grew thread count by +40 and
   committed memory by ~214MB even with connections capped at 8. Fixed by confining every
   torch/pipeline call in the whole process to **one single, long-lived worker thread**
   (`ThreadPoolExecutor(max_workers=1)`, created once at import time, never recreated) — every HTTP
   handler thread submits work to it and blocks on the result, so MKL/OpenMP only ever observes one
   calling thread for the process's entire lifetime.

Also present: `torch.inference_mode()` on every inference call (prevents autograd-graph retention —
a real, separate mechanism from the thread-pool leak above; without it, committed memory was
measured growing to ~42.8GB after ~5 hours of live trading-session load), graceful SIGTERM/SIGINT
shutdown (previously the only way to stop this process was an OS-level kill), and a duplicate-launch
guard (`_already_healthy()` checks `/health` before either model load begins, closing a real
2026-09-03 incident where a manual `npm run ai:serve` raced the engine daemon's own launcher and
both spent 15-30s loading a full model copy before only one could bind the port).

**None of the above is a FastAPI-shaped problem.** Every defect was either an HTTP-connection-layer
concurrency bound (fixed with a semaphore, not a framework) or a native-library thread-affinity
issue (fixed with worker-thread confinement, orthogonal to what HTTP framework sits in front of it —
FastAPI's default `async def` handlers would still each be free to call into torch from whatever
thread/event-loop context they run on unless the same single-worker confinement were added
underneath it anyway).

### Should this become FastAPI?

**Not now — no code change made, this is a documented decision, not a deferred one.** The current
service is small (3 routes, ~470 lines total across all 3 files), already bounded correctly, and has
no request/response-schema complexity or auth requirements that a hand-rolled `http.server` is
straining under. Per this codebase's own standing rule (CLAUDE.md's Java 26 Engine Authority §10:
*"do not migrate a component... simply because [X] is generally faster/better — profile the actual
bottleneck first"*), the same principle applies here: there is no profiled bottleneck FastAPI would
address, and the resource-safety mechanism required (single-worker thread confinement) is unrelated
to which HTTP framework sits on top of it.

**Revisit this decision if and when any of these becomes concretely true** (not preemptively):
- Multiple independent endpoint families emerge (today: 3 routes, all closely related)
- Request/response schemas become hard to maintain by hand (today: 2 simple JSON bodies)
- Authentication/validation requirements increase beyond localhost-only trust
- Concurrent inference becomes deliberately necessary (today: intentionally serialized to one worker thread — a design goal, not a limitation to lift casually)
- Operational observability would materially improve (structured request tracing, OpenAPI docs for an operator/integration audience)
- Deployment/maintenance becomes easier under a framework than the current bare script
- Profiling demonstrates a real, current bottleneck FastAPI specifically addresses

**Hard boundary, regardless of the above:** FastAPI (or any Python service) must never be inserted
between Node and Java Quant Core. `Node → QuantCoreBridge.ts → Java` is the quantitative boundary
and stays exactly two hops. Python's role is AI/ML inference (Chronos/FinBERT, this section) and
isolated research services (LangGraph, next section) — never a relay in the market-data → quant
path, per Java 26 Engine Authority rule 3 (TypeScript reaches Java only through the established
bridge, "never a new ad hoc process/IPC channel").

### Technology ownership (explicit, so future work doesn't blur these lines)

```
Node / TypeScript          Java Quant Core            Python
├─ orchestration           ├─ indicators              ├─ Chronos (forecast)
├─ EventBus                ├─ feature engineering      ├─ FinBERT (sentiment)
├─ agents                  ├─ quantitative scoring      ├─ ML/AI inference
├─ discovery                ├─ ALL production strategies └─ isolated research services
├─ ChiefTrader              ├─ Wyckoff (when built)         (LangGraph — next section)
├─ RiskEngine                └─ backtest/live/paper
└─ OMS                          quantitative truth
```

---

## LangGraph Research Service

**LangGraph is NOT part of the live trading decision spine.** It is an isolated, off-by-default,
shadow-only advisory companion — the same architectural tier as `quant-core-java` and
`scripts/local_ai_service.py` (Chronos), not a new entry point into
ChiefTraderAgent/RiskEngine/OrderManagement/BrokerManager.

**Status: Phase 0-3.1 implemented and runtime-verified. Phase 4A-5 are NOT implemented.** Phase 3
turned the Phase 0-2 recommendation into a proper human-reviewable artifact: counter-evidence, a
deterministic (non-LLM) evidence-strength/missing-evidence assessment, a deterministic
`humanReviewRequired` flag, a read-only Node API, and a read-only frontend panel. Phase 3.1
(2026-09-03) fixed a real production race (a genuine LLM-backed run, 11-16s, could exceed
`server.ts`'s 15s HTTP watchdog) by making the recommendation request asynchronous by construction,
added a real state machine, enforced the previously-unenforced `maxConcurrentRuns` config, and
added restart-orphan recovery. All of this adds **zero** new write paths, **zero** new promotion
authority, and **zero** new outbound calls.

### The one-paragraph version

`langgraph-research/` is a standalone Python process (loopback-only, port 8090, default **off** —
`LANGGRAPH_RESEARCH_ENABLED=false`) that runs one real LangGraph `StateGraph` producing a
**strategy-graduation recommendation**: given a strategy id, it fetches that strategy's
already-computed evidence from Argus over one narrow read-only HTTP route, has a local LLM
(Ollama) interpret the evidence and draft a structured recommendation, deterministically validates
that recommendation against Argus's own real gate results, and returns a JSON envelope. Node
persists that envelope into `research_agent_runs` and returns it to the caller. It has **zero
broker imports, zero credentials, no SQLite access, and no `.placeOrder()` equivalent** —
enforced by `langgraph-research/tests/test_safety_boundary.py` and
`src/server/langGraphArchitectureBoundary.test.ts`.

### Why isolated (the architectural precedent, not a new idea)

| | quant-core-java | local_ai_service.py (Chronos) | langgraph-research |
|---|---|---|---|
| Process | separate, Java | separate, Python | separate, Python |
| Protocol | plain HTTP, loopback only | plain HTTP, loopback only | plain HTTP, loopback only |
| Broker credentials | none | none | none |
| Can place an order | no | no | no |
| Default | off (`QUANT_JAVA_CORE_ENABLED`) | on (companion assumed present) | **off** (`LANGGRAPH_RESEARCH_ENABLED`) |
| Failure mode | advisory unavailable, non-fatal | forecast unavailable, non-fatal | recommendation unavailable, non-fatal |

### Why this use case (Phase 0 decision)

Two candidates came out of the read-only architecture assessment: (A) semantic precedent/RAG
search, or (B) a strategy-graduation recommendation workflow. **B was chosen.** (A) would have
required new infrastructure this codebase does not have and does not need for a first use case
(embeddings, a vector index, an ingestion pipeline) — and the one prior attempt at "semantic
memory" (`/api/v1/event-memory`) was fabricated and is now permanently quarantined at HTTP 410
with a code comment admitting it invented similarity scores; repeating that mistake with a
nominally "real" vector store was a much larger, riskier first step than justified. (B) required
no new infrastructure: `src/server/research/promotionEngine.ts` already computes exactly the
structured evidence (`StrategyEvidence`, `deriveLifecycleStatus()`, `liveGoNoGo()`) this workflow
needs — the only new surface was one read-only route
(`GET /api/v2/research/strategy-evidence/:strategyId`). The gap it fills is real: there is **no
automated strategy-promotion pipeline at all** in Argus today (moving a strategy from
`EXPERIMENTAL_STRATEGIES` to `CORE_STRATEGIES` requires a human hand-editing
`StrategyEngine.ts`'s array literals and redeploying). (A) is deferred, not rejected.

### HTTP contract

`POST http://127.0.0.1:8090/v1/strategy-graduation-recommendation`

```json
// request
{ "strategyId": "MOMENTUM_BREAKOUT", "correlationId": "b1e8e3c8-..." }
```

```json
// response (COMPLETED)
{
  "runId": "...", "correlationId": "b1e8e3c8-...", "strategyId": "MOMENTUM_BREAKOUT",
  "graphVersion": "strategy-graduation-v2", "status": "COMPLETED",
  "result": {
    "lifecycleStatusAtRequest": "OOS_TESTING", "live": "NO-GO",
    "failedGatesAtRequest": ["MIN_PAPER_TRADES"],
    "recommendation": "NOT_YET_ELIGIBLE", "confidence": 0.3,
    "rationale": "...", "limitations": ["..."], "evidenceUsed": ["paperTrades"],
    "counterEvidence": ["Only 3 paper trades exist so far - well below a statistical sample."],
    "missingEvidence": ["No canonical dataset id is recorded for this strategy's evidence."],
    "evidenceStrength": "WEAK", "evidenceStrengthRationale": "3/22 Argus evidence gates currently pass.",
    "humanReviewRequired": true,
    "provenance": { "source": "argus_strategy_evidence_endpoint", "strategyId": "MOMENTUM_BREAKOUT", "fetchedAt": "..." },
    "modelGeneratedNarrative": "..."
  },
  "error": null, "durationMs": 4210.5, "nodesExecuted": ["fetch_evidence", "..."], "providerModel": "llama3.2:latest"
}
```

Phase 3 field semantics (kept distinct on purpose — never collapse into one number):

| Field | Source | Meaning |
|---|---|---|
| `confidence` | LLM self-reported | The model's own stated confidence. **Not** a statistical confidence, **not** a validated win rate. |
| `evidenceStrength` / `evidenceStrengthRationale` | Deterministic | How many of Argus's own already-computed gate booleans are `true`, bucketed `NONE`/`WEAK`/`MODERATE`/`STRONG`. Never re-derives a gate; never influenced by `confidence`. |
| `live` / `failedGatesAtRequest` / `lifecycleStatusAtRequest` | Argus (`promotionEngine.ts`, read verbatim) | Lifecycle eligibility. Hard invariant: `validate_output_node` rejects any `PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW` recommendation when `live == "NO-GO"`. |
| `humanReviewRequired` | Deterministic | `true` unless `recommendation == "INSUFFICIENT_EVIDENCE"`. Never LLM-sourced. |
| `counterEvidence` | LLM, explicitly prompted | May be empty, but the model is instructed to say so rather than omit silently. |
| `missingEvidence` | Deterministic | Real absence-of-evidence flags (zero paper trades, no dataset id) — never an LLM guess. |

`GET /health` → `{ "status": "ok", "service": "langgraph-research", "version": "...", "capabilities": [...] }`.
No other endpoint exists. No arbitrary Python/SQL/shell execution, no filesystem access, no
database access is reachable through this API.

### Phase 3.1: asynchronous research execution lifecycle

**The defect this replaced**: `POST /research/strategy-graduation/:strategyId` used to await the
full LangGraph call (11-16s for a real LLM-backed run) before responding — this could exceed
`server.ts`'s blanket 15s `/api` request-timeout, which would send its own 504 first; when the
real result then arrived, the route's own `res.json(...)` threw a reproduced-live
`unhandledRejection` (`ERR_HTTP_HEADERS_SENT`, confirmed in `data/logs/crash.log`,
2026-09-03T10:44:50.577Z).

**The fix**: the POST route now only awaits `beginStrategyGraduationRun()` (a fast DB insert) and
responds in milliseconds with `{ status: "PENDING", runId, correlationId, ... }`. The slow
LangGraph call happens in `completeStrategyGraduationRun()`, invoked detached, mirroring the same
file's pre-existing `beginReplayRun`/`completeReplayRun` precedent.

```
PENDING --(begin)--> RUNNING --(LangGraph call)--> COMPLETED | FAILED | UNAVAILABLE | TIMEOUT
   |                                                                          ^
   +--(cancelResearchRun, best-effort)--> CANCELLED  <-----------------------+
                                                          (a late-arriving result can never
                                                           overwrite an already-CANCELLED row)
(any PENDING/RUNNING row found orphaned from a PRIOR process) --> FAILED_ON_RESTART
```

Every transition away from `PENDING`/`RUNNING` is a single conditional `UPDATE ... WHERE status IN
('PENDING','RUNNING')` — idempotent, prevents double-finalization. `config/langGraphResearch.json`'s
`maxConcurrentRuns` was loaded/validated but had **zero enforcement** before this fix (confirmed by
grep); now a `begin()` beyond the limit is persisted as an immediately-terminal `FAILED` row, never
queued, never silently dropped. `recoverOrphanedResearchRunsOnce()` runs once per process, lazily,
before the first new run, transitioning any orphaned row to `FAILED_ON_RESTART`. Cancellation
(`POST /research/runs/:runId/cancel`) is best-effort (cannot interrupt an in-flight HTTP call) but
wins the race against a later completion write and gives an auditable cancellation record.
`argus-cli research-recommend` now polls the existing read API (750ms interval, 60s bound) instead
of relying on a synchronous HTTP contract.

### Human-review API (Phase 3) and UI

Pure read routes over `research_agent_runs` (`src/server/research/researchRecommendations.ts`).
No route mutates anything; every response is labeled `disposition: "RESEARCH_RECOMMENDATION"`,
`notATradingApproval: true`.

- `GET /api/v2/research/strategy-recommendations/:recommendationId` — one recommendation. 404
  `RECOMMENDATION_NOT_FOUND`.
- `GET /api/v2/research/strategy-recommendations?strategyId=X&limit=20` — most recent, newest
  first (immutable history). 404 `UNKNOWN_STRATEGY_ID`; `limit` clamped `[1,100]`.
- Both surface `stale`/`evidenceAgeMs` (computed at read time against
  `researchRecommendationStalenessMs`, default 24h) and `failureReason` (re-derived from the
  existing `errorMessage` convention: `DISABLED`/`UNAVAILABLE`/`TIMEOUT`/`INVALID_RESPONSE`/graph
  error).

`src/components/StrategyResearchRecommendations.tsx`, mounted in the existing `scanner` tab (no
new `AppTabId`). Read-only: strategy-id selector, one "Request New Recommendation" button
(triggers the Phase 2 POST route), and a list of past recommendations, each banner-labeled
"RESEARCH RECOMMENDATION — NOT A TRADING APPROVAL". No Promote/Enable Strategy/Live
Trading/Risk Override/Place Order/Approve Trade control anywhere in this file — enforced by a
static grep in `src/server/langGraphArchitectureBoundary.test.ts`.

### Security boundary / failure behavior

Binds `127.0.0.1` only. Zero broker credentials, zero `ALPACA_*`/`IBKR_*` env vars read anywhere.
Zero SQLite access (enforced by both a Python-side static grep and a Node-side test). Two-endpoint
HTTP surface only; request bodies capped at 8KB.

| Failure | Result |
|---|---|
| `LANGGRAPH_RESEARCH_ENABLED` unset | `DISABLED` — no network call made |
| Python process not running | `UNAVAILABLE` |
| Request exceeds `requestTimeoutMs` (Node, 45s) or `MAX_GRAPH_EXECUTION_S` (Python, 35s) | `TIMEOUT` / `GRAPH_EXECUTION_TIMEOUT` |
| Response fails schema validation | `INVALID_RESPONSE` — rejected, never coerced |
| Ollama unreachable/timeout/malformed | graph node fails closed, envelope `status: FAILED` |
| Any of the above | Argus's live trading engine is completely unaffected |

### Graph structure

```
fetch_evidence --(ok)--> check_gates --(evaluated)--> assess_risk_factors --(ok)--> synthesize_recommendation --(ok)--> validate_output --(passed)--> finalize_success --> END
     |(failed)                        |(not evaluated)        |(LLM failed)                |(LLM failed)                  |(violation found)
     v                                v                       v                             v                              v
finalize_error <---------------- insufficient_evidence -> finalize_success          finalize_error <----------------- finalize_error
     |                                                                                       ^
     +---------------------------------------------------------------------------------------+
     v
    END
```

A brand-new strategy id with zero evidence takes the `insufficient_evidence` shortcut and never
calls an LLM; a real Argus or LLM failure at any stage short-circuits to `finalize_error`; a
recommendation contradicting Argus's own `live == "NO-GO"` is caught by `validate_output`, never
silently passed through.

### Persistence

- LangGraph's own checkpointer (`MemorySaver`, in-process, never written to disk) exists only
  because `compile()` expects one — not Argus's source of truth, discarded on process exit.
- Argus's own persistence (`research_agent_runs`, `drizzle/0055_natural_the_liberteens.sql`) is the
  durable record, written only by Node after validating the Python response. Python never opens
  `data/argus.db` — there is no second SQLite writer.

### Provider integration

Calls the **same local Ollama instance** Argus's Node side already uses
(`config/aiModels.json`'s `ollama.baseUrl`), deliberately without duplicating `AIRouter`'s full
provider-abstraction/failover/HeavyModelMutex machinery — one narrow, local, free, advisory-only
call, with one bounded retry on transient errors only. On any failure, an explicit error state is
returned; nothing is ever fabricated as a fallback.

### Startup

Mirrors `chronosLauncher.ts`/`javaQuantCoreLauncher.ts`: `scripts/lib/langGraphLauncher.ts`, wired
into `scripts/argus-engine.ts`, gated by `LANGGRAPH_RESEARCH_ENABLED=true`, using the same
generalized duplicate-launch lock (`scripts/lib/companionLaunchLock.ts`).

```bash
# manual start (same as `npm run ai:serve` for Chronos)
python langgraph-research/app/server.py
# or let the engine daemon start it automatically
LANGGRAPH_RESEARCH_ENABLED=true npm run start:engine
# trigger a run manually
npm run argus-cli -- research-recommend --strategy=MOMENTUM_BREAKOUT
```

To remove entirely: delete `langgraph-research/`, `scripts/lib/langGraphLauncher.ts`,
`src/server/services/LangGraphResearchService.ts`, `src/server/services/ResearchAgentRunner.ts`,
`src/server/research/researchRecommendations.ts`,
`src/components/StrategyResearchRecommendations.tsx` (and its mount line in `App.tsx`),
`config/langGraphResearch.json`, `src/server/config/langGraphResearch.ts`, the four routes in
`researchRoutes.ts`, the `research-recommend` CLI command, and (optionally, purely additive and
inert if left) the `research_agent_runs` table.

### Testing (at last verification — re-run `npm test` / the pytest suite yourself for current counts)

`langgraph-research/tests/` (pytest: every node, full graph execution, HTTP contract, safety
boundary), `LangGraphResearchService.test.ts`, `researchRecommendations.test.ts`,
`researchRoutes.strategyGraduation.test.ts` / `strategyRecommendations.test.ts`,
`langGraphArchitectureBoundary.test.ts`, `ResearchAgentRunner.test.ts` (Phase 3.1 lifecycle: PENDING→
RUNNING→terminal transitions, TIMEOUT-vs-UNAVAILABLE, bounded concurrency, idempotent completion,
restart-orphan recovery). No new frontend test framework exists (matches the rest of this SPA).

### Known limitations (as of last verification)

- Only reads one strategy's evidence; no cross-strategy comparison workflow.
- No cross-restart resumability of a specific interrupted run (by design) — a run orphaned by a
  restart is marked `FAILED_ON_RESTART`, never silently resumed with stale in-memory state; prior
  completed runs remain fully intact and queryable.
- Depends on a local Ollama model being loaded; no fallback provider (by design).
- `recommendation`'s three-value enum (`PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW` / `NOT_YET_ELIGIBLE` /
  `INSUFFICIENT_EVIDENCE`) kept unchanged from Phase 2 rather than expanded — a deliberate
  minimal-churn choice.
- No frontend automated test coverage (React Testing Library or equivalent) — matches the rest of
  this SPA.
- **Phase 4A (structured research-experiment proposals) explicitly NOT implemented.** Phases
  4B-5 (deterministic validation execution, promotion-gate integration, controlled
  self-improvement) remain **not** implemented.

---

## Premarket / Session-Aware Trading Architecture

Two source audits fed this section: a current-state forensic audit
(`ARGUS_SESSION_AWARE_TRADING_ARCHITECTURE.md`, dated 2026-09-05) and a gap-analysis/decision doc
built on it (`ARGUS_PREMARKET_GAP_ANALYSIS.md`, same date). **Important:** while merging these into
this doc, direct verification against the current repo found that one of their central findings —
"extended-hours execution: nothing exists yet, by design" — is now **stale**. A real, opt-in
extended-hours execution capability was implemented the same day/immediately after those audits
(RiskEngine gate 25, OMS limit-order construction, per-broker capability flags — see § Risk Engine
Gates above and the "What has since been built" subsection below, verified directly against
`src/server/risk/ExtendedHoursExecutionPolicy.ts`, `RiskEngine.ts`, `OrderManagement.ts`, and
`BrokerAdapter.ts` for this consolidation). Everything else in these two audits was **not**
independently re-verified for this consolidation and should be treated as accurate as of
2026-09-05 unless contradicted by code you check yourself.

### Executive summary (current-state audit)

Argus has **two independent, non-integrated systems** that each implement a meaningful slice of
"premarket intelligence," built at different times, in different directories, unaware of each
other:

| System | Location | What it does | Status |
|---|---|---|---|
| **A. `SessionLifecycle`** | `src/server/premarket/` | Tracks a market-session phase + an application-state phase, persists it, emits events on transition | Stage 1 only, explicitly observability-only — never scans, ranks, plans, or emits an idea |
| **B. The "Phase 4" continuous-intelligence series** | `src/server/continuous/` | Real candidate ranking (`ComposableRanking`), a persisted trade-plan object with thesis/entry-zone/invalidation (`TradePlanBuilder`), automatic revalidation at the open, missed-opportunity classification (`MissedOpportunityDetector`) | Functional, running in production, but structurally barred from the live idea-emission pipeline by its own governance rule, and never reads System A's session state (re-derives session via its own inline `classifyMarketSession()` calls) |

Neither system has any path to `TRADE_IDEA_GENERATED`, `ChiefTraderAgent`, `RiskEngine`, `OMS`, or
`BrokerManager`. Both are correctly isolated by test-enforced architecture boundaries
(`premarketArchitectureBoundary.test.ts` for System A; governance comments +
`architecture.protection.test.ts` for System B). The gap is not "premarket intelligence doesn't
exist" — it's that a real, working implementation exists in two disconnected pieces, neither wired
to the protected execution spine. Both `CLAUDE.md` and the prior `SYSTEM_OVERVIEW.md` had described
"broad-universe candidate ranking, a persisted TradePlan, market-open revalidation" as "designed
but not yet built" — the audit found that framing **stale relative to the code** for three of
those four items (only "after-close review" genuinely doesn't exist; `MissedOpportunityDetector`
classifies funnel drop-off, not a true close-of-day review).

### 2026-10-06: pre-market TradePlan lifecycle (local-only, PAPER)

The one-time-startup-snapshot defect verified live on 2026-10-06 (~08:29 ET: engine
started 08:23, five plans built once, never refreshed) is fixed by turning
`TradePlanBuilder` into a proper premarket lifecycle — design:
`docs/design/ARGUS_PREMARKET_TRADEPLAN_LIFECYCLE.md`, validation:
`docs/audits/ARGUS_PREMARKET_LIFECYCLE_VALIDATION.md`. Four scheduled points
(initial build on `PREMARKET_SESSION_STARTED`, post-08:30 mid-morning refresh,
~09:00–09:15 late refresh, ~09:20–09:28 pre-open validation) plus debounced
event-driven material refreshes; versioned plans with prior-version snapshots
(`trade_plan_revisions`) and no-churn hashing; bounded pre-open data
reservations (4 of 12 slots, 09:25 ET handover expiry); decomposed 10-component
pre-market score (`config/premarketFocus.json`); signed FinBERT sentiment as a
symmetric contextual term (never directional); 4-stage ticker extraction
replacing the 7-ticker hardcode; `PREMARKET_RVOL=BLOCKED_BY_DATA` (renders
`PREMARKET_RVOL_UNAVAILABLE`, never `0.00x`); `argus premarket-focus` CLI.
Invariants: the lifecycle never places orders, never emits trade ideas, never
bypasses consensus (0.75) / RiskEngine / OMS, never auto-tunes — enforced by
`tradePlanLifecycleBoundary.test.ts` and `premarketArchitectureBoundary.test.ts`.
Discovery funnels stay OFF by default; the lifecycle consumes enabled sources
and records them per report.

### Session representation — nine independent representations of "what phase of day is it"

`classifyMarketSession()` (`src/server/replay/marketSession.ts`) is the base function most other
session logic wraps or reimplements:

```ts
export type MarketSession = 'PRE_MARKET' | 'REGULAR' | 'AFTER_HOURS' | 'CLOSED';
export function classifyMarketSession(ms: number, timeZone: string, extendedHours: boolean): MarketSession { /* weekday + minute-of-day, config-driven thresholds */ }
```

Thresholds (`config/replaySafety.json`): premarket starts 04:00 ET, RTH 09:30–16:00 ET,
after-hours ends 20:00 ET. **No holiday or half-day awareness** anywhere in Argus's own code —
Christmas Day classifies as a normal Thursday. The only holiday-aware signal in the whole system is
Alpaca's `GET /v2/clock` (holidays handled server-side by Alpaca), and Argus only reads its boolean
`is_open` field — `next_open`/`next_close` are fetched but currently discarded everywhere.

At least nine distinct places each independently answer "what session is it" — two of them
(`RegimeEngine.classifyDeskSession()`, `SnapshotScanner.isSnapshotScannerRth()`) are **fully
independent reimplementations**, not derivations, meaning a future session-boundary bug fix (e.g.
adding holiday awareness) would have to be applied in at least three separate places to actually
take effect everywhere. `SnapshotScanner.isSnapshotScannerRth()`'s own comment is explicit about
this: *"ignores exchange holidays — fail-open for scan cadence."* The other seven representations
(a research-routes remap, a trading-session report enum, mobile UI chip mappers, a thin correct
wrapper in `newsSessionCadence.ts`, and `MarketOpenNewsConfluence`'s own ad hoc transition state)
either correctly derive from the base function or serve genuinely different purposes (UI labels,
desk-session subdivision) — the recommendation is to refactor only the two fully-independent
reimplementations to call the shared function, not to collapse all nine into one enum.

### `SessionLifecycle.ts` (System A) — what exists

- Combines `MarketSession` + `ApplicationSessionState` into
  `SessionLifecycleSnapshot = { marketSession, appState, tradingDate, evaluatedAt }` — narrower
  than a full `SessionContext` (`sessionId`, `isTradingDay`, `isExtendedHours`,
  `minutesToOpen/SinceOpen/ToClose` do not exist anywhere as named fields on any object).
- Persisted to `session_lifecycle_snapshots`, restored only for the *same* trading day on restart.
- Exposed via `GET /api/v2/runtime/session-lifecycle`. Runs on a 60s interval plus once at boot,
  wired from `ArgusCoreBoot.ts`.
- The `appState` map is a straight 1:1 with `MarketSession`: `PRE_MARKET→RESEARCHING`,
  `REGULAR→INTRADAY`, `AFTER_HOURS→CLOSE_REVIEW`, `CLOSED→IDLE`. **`PLAN_BUILDING`, `PLAN_READY`,
  `OPEN_REVALIDATION` are declared in the type but never assigned anywhere** in the codebase —
  they read as if designed specifically for what `TradePlanBuilder` (System B) does, but System B
  never sets them.
- Governance-enforced isolation from OMS/RiskEngine/BrokerManager/ChiefTraderAgent.

### The "Phase 4" continuous-intelligence series (System B) — what exists

- **`ComposableRanking.ts`** (2026-08-26): real, currently-running candidate ranking with 7 named,
  independently-scored components (`momentum | relativeVolume | rangeExpansion | gap | liquidity |
  newsCatalyst | agentConfidence`), each `{ score: 0-1|null, available, reason? }` — a component
  with no real data source is excluded from the weighted sum, never silently zeroed. Explicitly
  documented as not implemented: `sectorRelativeStrength`, `marketRegimeCompatibility`,
  `volatilitySuitability`, `historicalSetupQuality`, `premarketActivitySeparateFromMinuteBar`
  ("Alpaca IEX snapshot minuteBar is the latest available bar regardless of session — there is no
  separate premarket-only bar distinguishable from a regular-session minute bar in the feed this
  deployment uses"). **None of the 7 components call into `quant-core-java`** — pure TypeScript
  arithmetic on snapshot fields, contradicting a stated requirement that quant calculations come
  from the Java engine.
- **`TradePlanBuilder.ts`** (2026-08-27): a real, persisted trade-plan object
  (`TradePlanStatus = 'DRAFT'|'READY'|'REVALIDATING'|'VALID'|'INVALIDATED'|'EXPIRED'|'EXECUTED'|'CLOSED'`)
  with thesis text, catalysts, entry zone, invalidation level, target concept, confidence
  (`= candidate.finalScore`), evidence quality, rank, component scores. `revalidateTradePlan()`
  checks expiry, missing data (→ `INVALIDATED`, never silently kept valid), invalidation level vs
  live price, then the current ranking cycle's recommendation
  (`PROMOTE→REVALIDATED`, `HOLD→DOWNGRADED`, `REJECT→INVALIDATED`) — invoked from
  `SnapshotScanner.ts` **only when `marketSession === 'REGULAR'`**, i.e. the open-transition
  revalidation is already built and already runs. Its own governance header states verbatim:
  *"Whether/how a VALID plan ever re-enters the live pipeline... is a SEPARATE, deliberately
  NOT-yet-made decision."* Real gaps versus a cleaner design: `confidence` and "confluence score"
  are the same field (should be split); `catalysts` is free-text, not structured
  (`catalystType`/`catalystStrength`/`sourceReliability`); `targetConcept` is free text, not a
  numeric zone; no `executionEligibility` field distinct from lifecycle `status`; no dedicated
  premarket-only instantiation — it runs from whatever `SnapshotScanner` cycles produce, any
  session.
- **`MissedOpportunityDetector.ts`** (2026-08-27): real, working classification of where a
  `PROMOTE`-ranked candidate died in the funnel, first-failure-in-order (mirrors RiskEngine's own
  convention): `RANKING_MISS | SUBSCRIPTION_MISS | AGENT_MISS | CONSENSUS_REJECTION |
  RISK_REJECTION | EXECUTION_MISS | NOT_ACTUALLY_MISS`. Correctly derives `hadChiefApproval` from
  `transaction_traces.lifecycleStatus` membership in a real terminal-status set — a real bug
  (row-existence instead of lifecycle-status check) was found and fixed here 2026-09-04. Same
  governance discipline: never imports OMS/RiskEngine/broker, never emits `TRADE_IDEA_GENERATED`.
- **Not integrated with System A**: `SnapshotScanner.ts` calls `classifyMarketSession()` directly
  rather than reading System A's snapshot; System A's `PLAN_BUILDING`/`PLAN_READY`/
  `OPEN_REVALIDATION` values are never set by anything that calls into `TradePlanBuilder`.

### Discovery-to-evaluation coverage fix (2026-09-29)

Real, verified defect (docs/audits/archive/ARGUS_MIDDAY_ZERO_TRADE_2026-09-29.md): at full stream
capacity, `OpportunityDiscovery.ts`'s hot-swap challenger pool (`planSnapshotHotSwap()`'s `top`
argument) was sourced ONLY from `SnapshotScanner.ts`'s static momentum universe (seed/watch/
campaign/momentum-scan lists). A broad-universe-only admission — from `MarketUniverseScanner.ts`'s
ADV-gated scan, the movers funnel, or the news-catalyst funnel, all already computed into the same
cycle's `shortlist` — could only ever fill an EMPTY streaming slot (`topUpFromBroadUniverse`,
2026-09-16), never compete for an OCCUPIED one. Case study: IOVA was admitted 43 times over ~3
hours (real +34% move vs previous close) and never reached a quant assessment, because the stream
was already at its 12-symbol cap.

**Fix** (`OpportunityDiscovery.ts`, `runOpportunityScan()`'s `momentumRotationEnabled` branch):
broad-universe/mover/news-catalyst shortlist symbols not already in the momentum `top` list are now
also scored (`scoreBroadUniverseChallenger()`) and merged into the SAME candidate pool passed to
`planSnapshotHotSwap()`/`explainSnapshotHotSwapDecisions()` — the existing swap-cap/pacing
(`momentumHotSwapSlotsPerCycle`, 1 swap/cycle at full capacity) is unchanged; only the pool
competing for that bounded budget widens. Scoring reuses the existing `blendedHotSwapScore()`
(real mover-bonus/composable-ranking evidence) plus a new real, already-fetched signal —
`MarketUniverseScanner.ts`'s `gapPct` (dailyBar.o vs current price), previously computed every
cycle for the Discovery Lineage Ledger's `gapMover` tag but discarded before reaching this
decision. A symbol with zero real evidence (no gap, no mover-bonus, no composable score) scores
exactly 0 and never competes — admission alone was never sufficient. New config:
`broadUniverseHotSwapChallengerLimit` (15, bounds cost/noise), `broadUniverseGapHotSwapWeight`
(0.5, matches `SnapshotScanner`'s own `SCORE_WEIGHT_PCT` convention) in `continuousIntelligence.json`.
Per-candidate outcome (`PROMOTED`/`NOT_PROMOTED`/`ALREADY_ACTIVE` + reason) is now logged via the
existing `subscription_priority_decision` observability event for broad-universe challengers too,
tagged `source: 'BROAD_UNIVERSE_CHALLENGER'` vs `'MOMENTUM_UNIVERSE'`. A winning broad-universe
challenger's `WATCHLIST_SUBSCRIBE_REQUESTED` reason is `BROAD_UNIVERSE_HOT_SWAP`, distinct from the
existing `SNAPSHOT_HOT_SWAP`/`BROAD_UNIVERSE_TOPUP`. Still never emits `TRADE_IDEA_GENERATED`,
never imports OMS/RiskEngine/BrokerManager — this remains a subscribe-only discovery decision;
reaching real evaluation still depends on `QuantSignalAgent`/`TechnicalAgent`/etc. actually
evaluating the now-streamed symbol on a later cycle.

Same pass: `QuantSignalAgent.ts`'s `DESK_NO_TRADE` emission on a null quant idea previously
collapsed five distinct real conditions into two generic codes
(`EXPECTED_VALUE_TOO_LOW`/`INSUFFICIENT_EVIDENCE`). Now tracked explicitly and reported via
`config/noTradeReasons.json`: `NO_ELIGIBLE_STRATEGY` (no strategy cleared its own setup-confidence
threshold), `INSUFFICIENT_SAMPLE` (cold-start/warming-up, existing code reused correctly),
`EXPECTED_VALUE_UNCOMPUTABLE` (new — no usable stop/target risk-reward this cycle),
`EXPECTED_VALUE_TOO_LOW` (narrowed to its literal meaning — a real, measured, non-positive expected
value), `POOR_RISK_REWARD` (existing code, now used for the R:R-below-minimum case specifically).

### Volume provenance and intraday-bars-for-opening-range fixes (2026-09-29)

**Volume provenance.** `MarketUniverseScanner.ts`'s discovery-only `computeRvol()` (today's-volume /
ADV, feeding only the observability `rvolMover` tag, never a gate) mixes a real-time `feed=iex`
numerator (~1.5%-10% of true consolidated volume per the 2026-09-16 comment already in that file)
with a `feed=sip`-or-FMP-fallback full-trading-day historical denominator — structurally
non-comparable, understating true relative volume, and not time-of-day-adjusted. Not corrected
(would require either a consolidated real-time feed this account is not shown to be entitled to, or
a genuine intraday ADV curve — both real, separately-scoped follow-ups); instead made honestly
visible: `src/server/observability/discoveryCandidateLedger.ts` now attaches a `VolumeProvenance`
descriptor (`RVOL_PROVENANCE`, `comparable: false`, explicit numerator/denominator feed+scope) to
every `discovery_candidate_decision` event that carries a non-null `rvol`. Checked and confirmed
unaffected: `SnapshotScanner.ts`'s own `relativeVolume` (the one that actually feeds
`ComposableRanking` scoring) already uses matched `feed=iex` on both numerator and denominator plus
a real time-of-day adjustment (`expectedVolumeAtTimeOfDay`) — this fix does not touch that path.

**Intraday bars for `OPENING_RANGE_BREAKOUT`.** `QuantSignalAgent.ts` previously fetched only
`TIMEFRAME='1Day'` bars for its entire cycle (all 5 CORE strategies plus every live experimental
one) — `computeSupportResistanceFeatures()`'s `openingRange()`/`premarketHighLow()` were already
honest about reporting unavailable on daily bars (never fabricated a range from a daily candle),
but the agent never attempted an intraday fetch at all, so the honest-abstention path was the ONLY
path (2,027 of 2,072 real assessments that day). `computeSupportResistanceFeatures(bars,
intradayBars?)` gained a second, optional bar-set parameter, consumed only by `openingRange()` —
every other daily-appropriate feature (`previousDay`/`dailyHighLow`/`pivots`/`fibonacci`/
`priorChannel20`) is unaffected and keeps reading the main `bars` unchanged; omitting the new
parameter preserves the exact prior behavior byte-for-byte. `QuantSignalAgent.evaluateSymbol()`
now attempts a real, bounded `'1Min'` fetch (`computeIntradayFetchWindow()` — today's real regular-
session-open, DST-correct via `TradingCalendar.tradingWallTimeToIso`, capped at 8h, never before
session open) gated behind the SAME `isExperimentalStrategyLive('OPENING_RANGE_BREAKOUT')` check
`StrategyEngine.ts` already uses to decide live participation — zero added cost/behavior change for
any deployment that hasn't opted into this specific experimental strategy (`.env.example` default
`false`; this deployment's own `.env` has it `true`). Fail-open: any fetch failure leaves
`intradayBars` undefined and the strategy falls back to its pre-existing honest-unavailable
behavior, never blocking the real daily-bar CORE-strategy evaluation. No swing/CORE strategy's data
diet changed.

### PROPOSED, NOT ACTIVE — calibration provider-selection patch (2026-09-29 investigation)

**Real, verified bug, not yet fixed** (protected-component change — `ChiefTraderAgent.ts` is on the
protected list, so this is presented for review rather than silently applied, per this file's own
governance and CLAUDE.md's "extend through the documented interface only" rule).

`ChiefTraderAgent.calibrateConfidenceDetailed()` (`src/server/services/ChiefTraderAgent.ts:737-739`)
reads `agentConfidenceCalibration` filtered only by `(agentName, bucketLow)` and takes `rows[0]`,
with no `ORDER BY` and no `provider` filter. The schema itself
(`src/server/db/schema.ts:553-558`) documents the intended design explicitly: `provider` defaults
to `'ALL'` (an aggregate row) precisely so that "every current consumer... still reads and keeps
reading unchanged," with a real per-provider id row added *alongside* it, never replacing it.
`ChiefTraderAgent`'s query does not honor that convention.

**Confirmed against the real, live database (read-only query, 2026-09-29):** 5 real (agent, bucket)
combinations currently have more than one provider row. Worked example — `NewsAgent`, bucket 0.7 —
has 4 rows with materially different `calibrated_confidence` values:

| provider | wins | losses | calibrated_confidence |
|---|---|---|---|
| `271db452-...` | 27 | 25 | 0.5565 |
| `4afb8961-...` | 0 | 2 | 0.6250 |
| `ALL` | 62 | 48 | 0.5792 |
| `ec013fbf-...` | 8 | 4 | 0.7045 |

Without an `ORDER BY`, SQLite's row order for an unindexed multi-row match is not a deliberate,
guaranteed choice — `ChiefTraderAgent` could be using any of these four real, different values as
NewsAgent's live `decisionConfidence` for this bucket, not necessarily the intended aggregate.

**Proposed minimal patch** (adds one condition, matching the schema's own documented intent — does
not change the calibration *model*, only which already-existing row is selected):

```ts
const rows = await db.select().from(agentConfidenceCalibration).where(
  and(
    eq(agentConfidenceCalibration.agentName, agentName),
    eq(agentConfidenceCalibration.bucketLow, bucket.low),
    eq(agentConfidenceCalibration.provider, 'ALL'),
  )
);
```

**Why this is a decision-relevant change, not a pure bug fix to apply silently:** for any
(agent, bucket) with colliding rows, live `decisionConfidence` — and therefore ChiefTrader's
weighted consensus score for that agent's votes — would change from whatever `rows[0]` happened to
return today to the `'ALL'` aggregate. That is a real behavior change to the protected consensus
path, not merely an observability fix, even though the corrected behavior matches the schema's own
stated design.

**Recommended before activating:** (1) confirm live `decisionConfidence` for `NewsAgent` today
actually reflects one of the non-`'ALL'` rows (the ambiguity is proven; which row wins in practice
was not traced further this pass); (2) add a regression test seeding multiple provider rows for the
same (agent, bucket) and asserting `calibrateConfidenceDetailed()` returns the `'ALL'` row's
`calibratedConfidence`; (3) apply the patch and re-verify `agent_confidence_calibration`-driven
CONSENSUS_TERMINAL_REASON telemetry before/after on a real cycle. Not applied in this pass.

### Discovery-routing correction pass (2026-09-29, same day, post-review)

**Two real defects found in the first version of the discovery-to-evaluation fix above**, via
independent code review (not this session's own testing) after the fix was first reported as
"complete." Documented here rather than silently amended, per this session's own evidence
discipline.

1. **Unsorted combined candidate pool.** `combinedTop = [...top, ...broadUniverseChallengers]` was
   never sorted - `planSnapshotHotSwap()`'s array-order iteration let whichever momentum-universe
   candidate happened to be listed first consume the single swap-slot budget even when a much
   stronger broad-universe challenger was also present in the same cycle. The original IOVA-class
   test did not catch this because it emptied the momentum universe entirely, never exercising the
   both-pools-present case.
   **Fix:** one unified, documented scoring function (`priorityScoreOf()`, wrapping
   `scoreBroadUniverseChallenger()`) is now applied to EVERY candidate regardless of source -
   momentum-universe candidates' `momentumScore` is remapped through it too (strictly additive:
   `blendedHotSwapScore`/gap terms are non-negative, so a momentum candidate's score can only
   increase, never decrease, versus its old raw value). `combinedTop` is sorted descending by this
   one score with a deterministic alphabetical tiebreak (`symbol.localeCompare`) before being
   passed to `planSnapshotHotSwap()`/`explainSnapshotHotSwapDecisions()` - the existing swap-cap/
   pacing inside those functions is untouched.
2. **Lost score at subscription time.** The `WATCHLIST_SUBSCRIBE_REQUESTED` emission re-derived
   each symbol's `momentumScore` via `getLastSnapshotScore(symbol)` alone - null/undefined for any
   broad-universe-only symbol. `MarketDataWorker.subscribe()`'s `dynamicMomentumScores.set()` call
   is guarded by `typeof momentumScore === 'number'`, so a broad-universe winner's REAL score
   (the one that just won it the slot) was silently never stored; the very next
   `rankEvictionCandidates()` pass would then read it back as `0` (the worst possible value) via
   `dynamicMomentumScores.get(s) ?? 0`, making the symbol the first eviction candidate regardless
   of the real evidence that admitted it.
   **Fix:** a per-cycle `candidatePriorityScores` map (populated from `combinedTop` and the
   separate `topUpFromBroadUniverse` empty-slot path, both using the same `priorityScoreOf()`) is
   consulted first at the subscription-request emission point, falling back to
   `getLastSnapshotScore()` only when a symbol was never scored this cycle. This is not a second
   persistent scoring store - it is a per-cycle, discarded-after-use lookup that ensures the
   already-existing canonical store (`MarketDataWorker.dynamicMomentumScores`) gets seeded
   correctly instead of silently dropping to `undefined`.

**Tests added:** stronger-broad-beats-weaker-static (both pools present), the same with reversed
alphabetical/array positioning, a deterministic-tie case, and an explicit score-propagation
assertion (`OpportunityDiscovery.test.ts`). A separate real cross-service integration test
(`OpportunityDiscoveryToQuantAssessment.integration.test.ts`) traces subscription request → the
real `MarketDataWorker.subscribe()` call → a simulated provider-acknowledgment/fresh-tick
(`ingestIbkrQuote()`, the same real method the production IBKR tick handler calls) → a real
`QuantSignalAgent.evaluateSymbol()` call reaching a genuine regime/strategy-evaluation result
(never a fabricated or forced trade idea - correct abstention is an accepted outcome), plus
subscription-failure, capacity-refusal, and post-admission-eviction cases against the real
`marketDataWorker` singleton.

**Known, honestly-scoped limitation not fixed this pass:** once a symbol's priority score is
seeded, nothing periodically refreshes it for an already-active dynamic symbol - `toRequest` (the
only path that carries a `momentumScore` into `subscribe()`) only ever contains symbols not yet
subscribed. This is a **pre-existing property of the whole system**, equally true for
momentum-universe symbols before this fix existed, not something this fix introduces or makes
worse for broad-universe symbols specifically. Not addressed in this pass; a real periodic
rescoring pass for already-active dynamic symbols is a separate, larger change.

**Java-engine-ownership question, addressed directly (not silently assumed):** does
`scoreBroadUniverseChallenger()` (and the `priorityScoreOf()` wrapper added in this correction
pass) constitute new quantitative-calculation work that CLAUDE.md's Java 26 Engine Authority
section requires to live in `quant-core-java/`? Classification, reasoned explicitly:

- **What it is:** a numerical formula combining a real percentage price-gap with existing
  mover-bonus/composable-ranking bonuses into one additive score, used ONLY to decide which symbol
  wins a scarce, bounded market-data-streaming slot (a resource-scheduling/cache-priority decision).
- **What it is not:** it never produces or touches a trading signal, confidence, side, or strategy
  evaluation - it is never read by `ChiefTraderAgent`, `RiskEngine`, `PositionSizing`, or `OMS`, and
  it cannot itself cause a trade. Its only effect is "does Argus listen to this symbol's ticks right
  now" - the same category CLAUDE.md's own carve-out language already names when it says the policy
  "governs new quant/indicator/strategy compute only, not an automatic migration of the application
  shell," and lists persistence/safety-control/scheduling-adjacent code as staying in TypeScript.
- **Direct precedent already in this file:** `blendedHotSwapScore()` - the pre-existing function
  `scoreBroadUniverseChallenger()` wraps and extends - was itself added in TypeScript on
  2026-09-02/2026-09-03 (Phase 3 Dynamic Market Data Allocation / Universal Opportunity Discovery
  follow-up), predating this session, combining a real mover-bonus and a real ComposableRanking
  score the identical way. This correction pass's gap term is one more additive component in that
  SAME established pattern, not a new calculation category.
- **Honest limit of this argument:** a stricter reading of the Java Authority rule's own "no
  exception invented on the spot" language could still classify the gap term as quant-calculation
  work subject to Java ownership, since it IS a numeric transform of real market evidence. This is
  a genuine judgment call, not a settled fact - presented here for explicit operator review rather
  than silently resolved. If the stricter reading is preferred, the fix is narrow and low-risk: move
  only the gap-term arithmetic (`|gapPct| * 100 * weight`, a single-line formula) behind the
  existing `QuantCoreBridge.ts` HTTP integration boundary as a small, dedicated endpoint, leaving
  the surrounding subscription-scheduling control flow (candidate selection, ranking, capacity
  management, event emission) exactly where it is - that part is unambiguously control-plane
  regardless of how the gap term itself is classified.

### Decision-model investigation findings (2026-09-29, investigation only - no protected-path code changed)

Per this session's authorization boundary, items in this section are traced and documented, not
implemented. No consensus formula, evidence-participation rule, or calibration authority was
changed.

**Confidence semantics - mathematical property confirmed, not previously stated explicitly.**
`EvidenceAggregator.netConfidenceFromVotes()` (`src/server/services/EvidenceAggregator.ts:97-112`):
`weightedConfidence = Σ(confidence_i × weight_i)` over agreeing evidence, minus
`Σ(confidence_j × weight_j × DISAGREEMENT_PENALTY)` over disagreeing evidence, divided by total
weight, clamped to `[0,1]`. This is a weighted average with a subtractive penalty term. Confirmed
directly from the formula: with every weight non-negative, this value can never exceed the highest
individual `confidence_i` among agreeing evidence - adding more agents at similar calibrated
confidence redistributes weight but cannot itself push the result past that ceiling, and any
disagreeing vote can only pull it down further. This means "recruit more correlated-confidence
agents" is not a path to a stronger consensus number by construction, independent of the
evidence-independence grouping question `evidenceIndependence.ts` already handles separately.

What each score already means, largely already distinguished in code (this section makes it
explicit in one place rather than leaving it scattered across comments):
- **`rawSignalStrength`** (`CalibrationDetail.rawSignalStrength`): the agent's own stated
  confidence for this idea, untouched - a signal-strength number, not a probability.
- **`historicalReliability`** (`CalibrationDetail.historicalReliability`): a Beta-Binomial posterior
  mean anchored on this agent's own real win/loss history in this confidence bucket - directional-
  accuracy-adjacent, still not a calibrated profit probability.
- **`decisionConfidence`**: equals `historicalReliability` when real calibration data exists, else
  falls back to `rawSignalStrength` - this is the ONLY number that actually feeds
  `netConfidenceFromVotes()`.
- **`ProbabilisticEnvelope`** (`EvidenceAggregator.ts:51-59`, `expectedReturnPct`/
  `downsideProbability`/`expectedShortfallPct`/`regimeProbability`/`outOfDistributionProbability`):
  the net-profit-probability/uncertainty dimension already has a defined shape for a future producer
  to populate (e.g. a validated `ForecastEngine.java` output) - **zero current producer populates
  it, and nothing in `aggregate()`/`netConfidenceFromVotes()` reads it.** It exists as
  infrastructure only.
- **Consensus score**: the final `netConfidenceFromVotes()` output compared against
  `tradingSafety.consensusApprovalThreshold` (0.75) - a weighted-vote agreement score, not itself
  any of the above four quantities, and not a calibrated probability of anything.

**Recommendation (proposal only, not implemented):** any future alternative combination model
(one that could legitimately let independent, non-correlated agreement exceed a simple weighted
average - e.g. a proper Bayesian evidence-combination or log-odds pooling formulation) must be
built as a separate, explicitly-labeled shadow path with out-of-sample validation and correlation
controls before any activation decision, exactly as this session's own authorization requires. Nothing
in this pass proposes a specific replacement formula - only that the current ceiling property is a
real, confirmed mathematical fact worth an explicit operator decision, not an unexamined default.

**Horizon compatibility - real per-source horizon data exists, but is not consulted at consensus
time.** `config/evaluationHorizons.json` already maps real per-agent (`FundamentalAgent`: 7 days,
`MacroAgent`: 14 days) and per-quant-strategy (`MOMENTUM_BREAKOUT`: 1 day, `MEAN_REVERSION`: 4h,
`TREND_FOLLOWING`: 7 days, ...) expected holding periods - but this mapping is consumed ONLY by
`PredictionOutcomeEvaluator.ts` for GRADING a prediction after the fact (win/loss scoring), never
by `ChiefTraderAgent`'s consensus gathering, which groups fresh ideas by symbol alone
(`evidenceIndependence.ts` groups by structural-computation overlap, not by horizon at all). A
short-horizon SELL (e.g. a 4-hour `MEAN_REVERSION` idea) and a long-horizon BUY (e.g. a 7-day
`TREND_FOLLOWING` or `MacroAgent` idea) on the same symbol are currently treated as a direct
contradiction in the SAME weighted vote, when they may both be correct on their own terms.

**Recommended backward-compatible diagnostic extension (proposal only, not implemented this
pass):** attach each vote's resolved horizon (reusing the SAME `evaluationHorizons.json` lookup
`PredictionOutcomeEvaluator.ts` already performs - no new data source) to the
`CONSENSUS_TERMINAL_REASON`/`CONSENSUS_MODEL_COMPARISON` telemetry already emitted per round, and
compute a diagnostic `horizonSpreadMs`/`potentiallyIncompatibleHorizons` flag - purely observational,
changing no vote's participation or weight. `ConfluenceCoordinator.ts` (the existing, reviewed
mechanism for requesting additional same-symbol evaluations) is the right place to extend, per this
session's authorization, rather than a second coordinator. **The actual protected-path change** -
deciding whether/how incompatible-horizon evidence should be excluded, separately grouped, or
weighted differently within `netConfidenceFromVotes()` - is a genuine consensus-math change and is
explicitly NOT proposed here as a concrete formula; it requires its own reviewed design, shadow
validation, and tests before any activation, per this session's own authorization boundary. Not
implemented this pass (time/scope), but the diagnostic half (horizon exposure with zero decision
impact) is ready to build on the next pass without further design work.

**Calibration authority - traced AND corrected (2026-09-29, second review, item 6 - superseding the
paragraph below's own prior framing).** A second review pass correctly rejected the framing this
paragraph originally used ("describes a real, built, but not-yet-wired path, not a currently-
contradicted one") - explaining *why* two comments disagreed is not the same as fixing the
disagreement, and `ChiefTraderAgent.ts`'s own comment was, on direct inspection, actually WRONG, not
just differently-scoped from `CalibrationCandidateBuilder.ts`'s. `ChiefTraderAgent.ts`'s prior
comment claimed `agentConfidenceCalibration.calibratedConfidence` was "the output of
`CalibrationCandidateBuilder.runCalibrationValidationCycle()`'s own promotion mechanism, which has
its own statistical-significance gate before ever overwriting the currently-active calibrated
value" - verified false by reading `CalibrationCandidateBuilder.ts` directly:
`buildCalibrationCandidates()` only ever `SELECT`s from `agentConfidenceCalibration` (never writes
it), and `runCalibrationValidationCycle()`'s "promotion" writes exclusively to the separate,
generic `learning_versions`/`promotion_decisions`/`rollback_events` ledger via
`ChampionChallenger.createShadowVersion()`/`promoteToCandidate()`/`decidePromotion()`. The real,
verified writer of `agentConfidenceCalibration.calibratedConfidence` is `ReflectionEngine.ts` alone
(its `db.insert(agentConfidenceCalibration)...onConflictDoUpdate` upsert, ~60s cycle) - exactly as
`CalibrationCandidateBuilder.ts`'s own header already, correctly, said. `ChiefTraderAgent.ts`'s
comment (`calibrateConfidenceDetailed()`'s doc comment) has been rewritten to state this correctly
and to explicitly name all three real, distinct roles: (1) `ReflectionEngine.ts` as the sole writer
this method reads; (2) `CalibrationCandidateBuilder.ts` as an observational-only validation pipeline
whose champion/challenger promotion never touches `agentConfidenceCalibration`; (3)
`ModerateTierEvaluator.ts`'s `isAgentBucketCalibrationTrustworthy()` as a separate, third reader
that consults (2)'s champion ledger (not `agentConfidenceCalibration`) to gate MODERATE-tier trust
specifically - a check this method (the STANDARD-tier path) does not perform. No behavior changed;
`decisionConfidence`'s actual computed value is identical before and after this correction - only
the documentation of its provenance was wrong and is now fixed.

**AI outage / debate-dependency - verified correct, no fabricated vote found.**
`ChiefTraderAgent.ts:538-549`: when no AI provider is routable at all, ChiefTrader explicitly SKIPS
the multi-model debate rather than injecting a synthetic fail-closed HOLD vote - the code comment
states the reasoning directly ("not injecting a fabricated fail-closed HOLD"), and this was verified
by reading the real branch, not assumed. Consensus is then evaluated on the independent agents' own
evidence only, with the real `pendingDebateFailClosed` state recorded as a `FAIL_CLOSED_NO_ROUTE`
diagnostic (an AI-reliability measurement), never as a vote. An in-flight debate for the same symbol
(`debatePending()`) correctly defers rather than forcing an early decision. Existing veto policy
(`HARD_VETO_AGENTS`, debate-HOLD penalties) is unchanged and was not touched by this investigation.
Quant-only capability (Argus operating with zero AI providers routable) is real and already
exercised by this exact code path in production outage conditions - not merely assumed - though a
dedicated, isolated "AI fully down for an extended real session" soak was not run as part of this
pass.

### Second Codex review corrections (2026-09-29, same day, post-post-review)

A second review of the "Discovery-routing correction pass" above found the first pass's own tests
and fixes still fell short in named ways. This section records what changed in response - see
`OpportunityDiscoveryToQuantAssessment.integration.test.ts`, `OpportunityDiscovery.ts`,
`OpportunityDiscovery.test.ts`, and `MarketUniverseScanner.ts` for the actual diffs.

**Items 1-3 (causal integration wiring, honest "simulated" labeling, deterministic capacity
split).** The integration test previously called `marketDataWorker.subscribe()` and
`QuantSignalAgent.evaluateSymbol()` directly - proving those methods work in isolation, not that
discovery's emitted event automatically causes a subscription, or that a real per-cycle evaluation
automatically reaches the admitted symbol. Rewritten so `(marketDataWorker as
any).ensureWatchlistListener()` (private, idempotent - the exact handler `start()` registers in
production) is invoked once in `beforeAll`, and `runOpportunityScan()`'s emitted
`WATCHLIST_SUBSCRIBE_REQUESTED` event is what causes the real subscription through that listener -
the test itself never calls `subscribe()` for the discovered symbol. Full capacity is established
via real, repeated `subscribe()` calls against the real singleton (matching the pattern the
capacity-split tests already used), not mocked `getActiveSymbols()`/`getDynamicSymbols()` return
values. The quantitative assessment is reached via `quantSignalAgent.triggerNow()` - the same real,
production-callable entry point `SyntheticSessionEngine.ts` already uses for an accelerated clock -
which runs the exact private `runCycle()` the timer calls (fans real `getActiveSymbols()` out to
`evaluateSymbol()` per symbol with bounded concurrency); the resulting assessment for the symbol
under test is observed via a call-through spy (`vi.spyOn(QuantSignalAgent.prototype,
'evaluateSymbol')`, real implementation still executes) rather than a direct, single-symbol call.
Every reference to `marketDataWorker.ingestIbkrQuote()` is now labeled "simulated market-data
ingestion" throughout comments and the file's own header, never "provider acknowledgment" - this
file does not, and structurally cannot without a dedicated harness, exercise a real provider
subscription acknowledgment/rejection or transport lifecycle (that lives inside
`IbkrSocketSession`/`AlpacaBroker`'s own socket handling, out of scope for this pass). The single
non-deterministic capacity test (`admitted || refusedWithSignal`) is replaced with two deterministic
cases: an entirely dwell-cleared (evictable) full pool that must admit a higher-priority symbol via
a real bounded eviction, and a genuinely non-evictable full pool (every occupant deliberately left
within real dwell protection, so `rankEvictionCandidates()` structurally has nothing eligible to
evict) that must refuse and emit the real `MARKET_DATA_CAPACITY_FULL` signal - asserted separately,
never combined.

**Item 4 (challenger/incumbent scoring symmetry + cross-cycle double-counting - a real defect, not
just a test gap).** Verified by direct inspection: `planSnapshotHotSwap()`'s/
`explainSnapshotHotSwapDecisions()`'s `scoreOf` callback (used to rank the weakest active dynamic
incumbent for eviction comparison) used `blendedHotSwapScore(sym, baseScoreOf)` - missing the gap
term challengers were scored with via `priorityScoreOf()` (which adds
`scoreBroadUniverseChallenger`'s gap contribution on top of `blendedHotSwapScore`). An incumbent's
own real gap evidence was silently excluded from its own eviction-ranking score while an otherwise-
identical challenger's counted in full - a genuine source-dependent scoring bias, not a cosmetic
inconsistency. Separately, and more severe: `baseScoreOf` was `getLastSnapshotScore(s) ??
marketDataWorker.getDynamicMomentumScore(s) ?? 0` - for any symbol outside SnapshotScanner's own
scan universe (every broad-universe-only admission), `getLastSnapshotScore` is always null, so
`baseScoreOf` fell back to `getDynamicMomentumScore(s)` - the SAME `dynamicMomentumScores` map this
cycle's own `priorityScoreOf()` output (base + mover-bonus + composable + gap) gets stored into.
Once a broad-universe symbol became an incumbent, a later cycle's `baseScoreOf` call read back its
own already-bonused final priority as a "raw base" and `priorityScoreOf`/`blendedHotSwapScore` added
mover-bonus/composable/gap AGAIN on top - an unbounded, cycle-over-cycle compounding defect for any
incumbent this path applied to.

Fix: `baseScoreOf` now reads `getLastSnapshotScore(s) ?? 0` only - never falls back to the stored,
already-bonused `dynamicMomentumScores` value. This makes `priorityScoreOf()` safe to use
identically for both challenger scoring (`combinedTop`'s `momentumScore`) and incumbent scoring
(`scoreOf` in both `planSnapshotHotSwap` and `explainSnapshotHotSwapDecisions` calls), closing both
the symmetry gap and the compounding defect with one change. Two new regression tests in
`OpportunityDiscovery.test.ts` (`2026-09-29 second correction (Codex review item 4)` describe
block): one proves an incumbent's own gap evidence is correctly weighed against a challenger (not
silently zeroed by an asymmetric formula); the other runs two real, sequential `runOpportunityScan()`
cycles - a broad-universe symbol wins cycle 1 purely on gap evidence, becomes cycle 2's incumbent
(simulated via `getDynamicMomentumScore` returning exactly what cycle 1 propagated - the real shape
of what `MarketDataWorker.subscribe()` would have stored), and asserts a genuinely stronger new
challenger correctly wins cycle 2's slot - which only holds because `baseScoreOf` no longer
compounds; the same test would fail if the removed fallback were reintroduced, since the
incumbent's compounded score (34) would then exceed the challenger's real score (30).

**Item 5 (volume provenance - abstention, not just labeling).** The first pass added
`VolumeProvenance`/`RVOL_PROVENANCE` labeling (`comparable: false`) alongside `computeRvol()`'s
still-computed ratio - correctly flagged as insufficient ("makes the limitation visible; it does
not make the measurements compatible"). `MarketUniverseScanner.ts`'s `computeRvol()` now returns
`null` unconditionally: no genuinely compatible same-scope real-time-consolidated-volume source is
available without a new API entitlement/fetch this pass is not authorized to add (this file's own
established discipline throughout is "never a new API call" for exactly this class of addition), so
the honest choice is explicit abstention over a fabricated or silently-biased ratio, per the
review's own stated alternative. `isRvolMover()` is therefore always `false` and `rvolProvenance` is
therefore always `null` - confirmed observational-only before this change (never consulted by
`priorityScoreOf`/`blendedHotSwapScore` or any discovery admission/eviction decision, only
`PostMarketAnalysis.ts`/`discoveryLineageReport.ts` reporting), so no liquidity/ADV/spread/price gate
and no discovery admission decision is touched by this change. `discoveryCandidateLedger.ts`'s
`VolumeProvenance`/`RVOL_PROVENANCE` shape is kept in place, documented as reserved for if/when a
genuinely compatible source is added, not because the ratio is computed today.

**Item 7 (intraday-bars production-path audit + Java parity - new investigation this pass).** Every
caller of `computeSupportResistanceFeatures(bars, intradayBars?)` was enumerated directly
(`grep`-verified, not inferred): `src/server/strategiesEngine/core/MarketSnapshot.ts` (the isolated
`ANALYSIS_ONLY` research subsystem - never imports the live path), `src/server/engines/backtest/
BacktestEngine.ts` (SAME_BAR_CLOSE, explicitly non-promotable), `src/server/research/
argusStrategyReplay.ts` (also the code path `canonicalNextBarEngine.ts`'s NEXT_BAR_OPEN engine
delegates to for signal generation), and `src/server/research/strategyParityHarness.ts` (the TS-side
parity-test harness itself) all call it with **daily bars only**, unaffected by this change and
structurally unable to diverge since they never pass a second argument. **`src/server/services/
QuantSignalAgent.ts` is the only production/live-path caller that passes `intradayBars`**, gated
behind the same `isExperimentalStrategyLive('OPENING_RANGE_BREAKOUT')` check `StrategyEngine.ts`
already uses to decide live participation - zero behavior change for every other strategy and every
deployment that hasn't opted into this specific experimental strategy. Within
`computeSupportResistanceFeatures()` itself, only `openingRange()` reads `intradayBars` -
`previousDay`/`dailyHighLow`/`pivots`/`fibonacci`/`priorChannel20` all still read the main (daily)
`bars` unchanged, directly asserted by `supportResistance.test.ts`'s `2026-09-29 (intraday-bars-for-
opening-range fix)` describe block (three cases: intraday supplied, omitted, and an empty array -
`openingRange` is the only field that ever differs).

Java parity: **no Java equivalent exists for `OPENING_RANGE_BREAKOUT`** - it is one of the TS-only
`EXPERIMENTAL_STRATEGIES` (`quantExperimentalStrategies.json`), not one of Java's 5 CORE strategies
(`RangeReversion`/`PullbackContinuation`/`MeanReversion`/`TrendFollowing`/`MomentumBreakout`, see
Java Quant Core section). The existing TS/Java shadow-parity comparison
(`QuantSignalAgent.ts`'s `fetchCoreEnsembleDecision` call) already, deliberately, scopes itself to
`CORE_STRATEGIES` only ("Comparing only against the CORE subset... keeps this an apples-to-apples
check") - `OPENING_RANGE_BREAKOUT` was already excluded from that comparison before this change, by
design, not as an oversight this pass introduces. No new TS/Java divergence risk exists because Java
never computes this feature at all; there is no parity test to add for a feature with no Java
counterpart.

Java-ownership judgment for this specific change (Java 26 Engine Authority, rule 0): the actual
`openingRange()`/`premarketHighLow()` calculation logic is pre-existing, unchanged TS code (it
already correctly reported "unavailable" with no intraday data) - this change extends its DATA
INPUT (which bars get fetched and passed in), not its calculation. `computeIntradayFetchWindow()`
is pure date/session-boundary arithmetic (which bars to request), not a market/statistical
calculation. Classified as data-provisioning/orchestration for an existing TS-owned experimental
strategy that has no Java counterpart to check first - consistent with, not an exception to, rule
0's "check `quant-core-java/` for an existing implementation first" (there is none to find, and
none is being newly authored in TS either).

**Item 8 (full-suite status - precise framing, not "all green").** Full suite re-run after every
fix above (`npm test`, 2026-09-29): **596/597 files, 4597/4598 tests passing; 1 failure** -
`src/server/routes/v2System.quantCore.test.ts`'s `GET /quant-core/catalog > categorizes a known
Options engine correctly`, a 15000ms timeout under full-suite load. `git status`/`git diff` confirm
this file has zero changes from this pass or the prior one. Isolated re-run of that file alone:
**10/10 passed in 6.97s.** Correct framing: **full suite completed with 1 failure; isolated rerun
passed** - matching this codebase's own pre-existing `KNOWN_FLAKY` note for this catalog-route test
group. This is NOT reported as "nothing broke" or "all green": an isolated pass proves the test can
pass, not that the current change set contributed nothing to a timeout that only appears under
full-suite resource contention. This specific test (`GET /quant-core/catalog`) was not touched,
imported, or exercised by any file this pass modified, and the failure mode (a fixed 15000ms wall-
clock timeout on an HTTP route test, immediately following a `tsc --noEmit` full-project typecheck
that also passed clean) is consistent with the documented pre-existing flakiness rather than a new
regression - but that consistency is circumstantial, not a proof, and is recorded as such.

### Market data / discovery behavior outside RTH

`MarketDataWorker.ts` has **zero session awareness** — connects the Alpaca IEX WebSocket
unconditionally whenever keys are present, processes quote/trade messages through the identical
code path regardless of time of day (it naturally receives fewer ticks overnight only because
IEX itself trades less, not because Argus gates anything). Discovery and idea agents run premarket
essentially uniformly:

| Component | Runs premarket? |
|---|---|
| `MarketUniverseScanner.ts` | Yes, unconditionally (two plain `setInterval`s) |
| `OpportunityDiscovery.ts` | Yes, at a slower off-hours cadence (30s RTH vs 300s off-hours), never off |
| `TechnicalAgent.ts` | Yes, tick-driven, no session check |
| `QuantSignalAgent`/`evaluateAll()` | Yes, no session branch — daily-bar-driven by design |
| `FundamentalAgent.ts` / `MacroAgent.ts` | Yes, fixed ~60s/~75s intervals, no RTH gate |
| `NewsEngine.ts` | Yes, ingests/scores at a slower off-hours cadence, but a HIGH/MODERATE-strength catalyst is staged `STAGED_FOR_OPEN`, not acted on until the open |
| `MarketOpenNewsConfluence` | Deliberately RTH-gated — staged catalysts only match against real opening ticks, can only escalate to `emitTradeIdea` after 9:30am |
| `MarketDataWorker` subscription allocator (`maxActiveSubscriptions=12`, `maxConcurrentTemporaryDataRescues=3`) | Yes, with zero session awareness — same static caps serve premarket and RTH discovery identically |
| `ChiefTraderAgent.ts` | Yes, purely confidence/timing-based, no session term anywhere |

**`NewsEngine` is the one subsystem deliberately shaped by session** (poll cadence + the
`STAGED_FOR_OPEN` deferral). Everything else either runs identically at any hour or at a slower
off-hours cadence with no hard gate.

### RiskEngine session assumptions (current at the time of the audit — gate 25 changes some of this,
see below)

- **Gate 12 (`market_hours`)**: genuinely session-aware on the **replay** path
  (`classifyMarketSession`/`sessionAllowsFills`, honoring a per-run `extendedHours` flag); the
  **live** path was a binary Alpaca `/v2/clock` `is_open` check with no premarket-vs-weekend
  distinction — this was the documented, intentional behavior at audit time (*"`market_hours` is
  expected to fail pre-open"*). A real, independently-noted gap: gate 12 is `skip/pass` when Alpaca
  keys are unconfigured, **regardless of which broker is actually active** — a deployment running
  IBKR (the documented default) without Alpaca keys configured has zero live session check on this
  gate, at any hour.
- **Gate 13 (`data_freshness`)**: a single fixed `stalePriceThresholdMs` (5 min) with no session
  parameter — the same bar applies at 9:31am and 3:59am. Largely moot outside RTH today because
  gate 12 already fail-closes non-RTH live attempts first.
- **Gates 3/4/6** (`same_symbol_cooldown`, `post_loss_cooldown`, `duplicate_signal`): pure
  elapsed-milliseconds windows, no calendar-day or RTH-boundary concept at all.
- **Gate 8 (`daily_loss`)**: already correct — resets on a real America/New_York calendar-date
  change (DST-correct via `Intl.DateTimeFormat`), not a 9:30am-anchored window, so it already works
  correctly if Argus starts evaluating risk at 4:00am. No change was needed here.

**Update, verified for this consolidation (2026-09-05):** the live path of gate 12 has since been
extended, and gate 25 (`extended_hours_execution_policy`) has been added — see § Risk Engine Gates
above for the exact mechanics. This closes most of what the gap-analysis section below called
"Gap 7" (extended-hours execution). The change is additive and opt-in
(`EXTENDED_HOURS_EXECUTION_ENABLED`, off by default): with the flag off, gate 12's live behavior is
byte-identical to what this audit describes.

### Broker / OMS extended-hours capability (state at audit time; now partially superseded)

- **`ibkr_gateway`** (the actually-active broker per `CLAUDE.md`): constructs orders with
  `tif: 'DAY'` and never set `outsideRth` (IB TWS API's real extended-hours flag; defaults false
  when omitted).
- **`ibkr_web`**: also never set an explicit extended-hours field, but its order-confirmation
  auto-confirm loop happened to also confirm IBKR's *"submitted outside regular trading hours"*
  warning — proven by a real passing test — making it, at audit time, the one adapter with a
  demonstrated (if accidental) path to completing an extended-hours order. Per `CLAUDE.md`,
  `ibkr_gateway` (without this accidental path), not `ibkr_web`, is the currently-active broker.
- **`AlpacaBroker`**: `extended_hours` was never set; Alpaca requires it together with
  `type: 'limit'` for an extended-hours order, and OMS always called with `type: 'MARKET'` — a
  structural double-blocker.
- **OMS**: no time-of-day check anywhere; orders were hardcoded to `type: 'MARKET'`.

**Now (verified this consolidation): `BrokerAdapter.ts`'s capability shape carries an
`extendedHoursOrders` flag consumed per-adapter, and OMS constructs a real `{ type: 'LIMIT', price,
extendedHours: true }` order when the extended-hours gate/policy path is engaged.** Whether every
individual broker adapter (IBKR socket, IBKR web, Alpaca) has been updated to genuinely honor this
end-to-end for a real order was not re-verified line-by-line for this consolidation — check
`docs/audits/ARGUS_PREMARKET_TRADING_IMPLEMENTATION.md` (out of scope here to restate) and the
adapter source directly before relying on this for a specific broker.

### Non-gaps — already correct, do not touch

- **Reconciliation**: session-agnostic, fixed 5-minute interval, works correctly premarket.
- **Emergency stop / kill-switch**: session-agnostic, always the first gate evaluated.
- **Gate 8 (`daily_loss`)**: day boundary already correct (see above).
- **`AutoTradeScheduler`**: the HH:MM window comparator already supports an arbitrary window
  including premarket hours — expressible today by changing two settings fields — but only toggles
  Autobot on/off; it never widens gate 12 by itself.
- **`MissedOpportunityDetector`'s core classification logic**: correct, recently bug-fixed,
  directly extensible rather than needing replacement.

### The architectural decision (gap-analysis doc)

**Hybrid — but not the hybrid a naive first read might sketch. The correct hybrid is: unify the two
systems that already exist (A and B above), don't build a third.** Building a new premarket
discovery/ranking/thesis system from scratch would itself be exactly the "second uncontrolled
trading path" this codebase's own architecture rules forbid — just built adjacent to the existing
one instead of adjacent to ChiefTrader.

```
                  SessionLifecycle (System A)
                  — session phase + app-state, single source of truth —
                              │
              ┌───────────────┴───────────────┐
              │                               │
   ComposableRanking (System B)      MissedOpportunityDetector (System B)
   + TradePlanBuilder (System B)     (reads System B's own telemetry)
   — should read SessionLifecycle's
     phase instead of its own inline
     classifyMarketSession() call —
              │
              ▼
   Java Quant Engine (component in ranking — does not exist yet, see below)
              │
              ▼
      Agent Confluence (existing agents, session-mode-aware)
              │
              ▼
   TRADE_IDEA_GENERATED  ← the ONLY new wire between System B and the
              │              protected spine; does not exist today, and
              │              should not exist until specific
              │              preconditions are met (see below)
        ChiefTraderAgent (UNCHANGED)
              │
     Session-aware RiskEngine (extended — gate 12 + gate 25,
     both landed since this doc was written — everything else UNCHANGED)
              │
             OMS (extended: limit-order construction for extended-hours,
                   landed since this doc was written; everything else UNCHANGED)
              │
        Broker (extended: real extended-hours order flags per adapter)
              │
        Reconciliation (UNCHANGED — already session-agnostic)
```

Rejected alternatives, with reasons: a fully **separate premarket engine** was rejected outright by
evidence — `ComposableRanking`/`TradePlanBuilder`/`MissedOpportunityDetector` are already a
generic, session-agnostic scoring/thesis/revalidation system; a separate premarket-only engine
would duplicate this exact logic for no reason. "Same engine, add a session mode" in the naive
sense is also not quite right, because there isn't currently *one* engine — there are two, unaware
of each other; the real first move is consolidation, not mode-flagging.

### Wiring System B into the protected spine — the explicit precondition (not yet met)

Emitting `TRADE_IDEA_GENERATED` from a `VALID`/revalidated `TradePlan` would be architecturally
identical to any other new idea agent — it does not require touching `ChiefTraderAgent`,
`RiskEngine`, or `OMS` at all, per the existing "Adding a new agent" pattern. But `TradePlanBuilder`'s
thesis text and confidence score have never been evaluated against real graded outcomes — there is
no `agent_performance_stats`-equivalent evidence for "TradePlan-sourced ideas are reliable." The
gap-analysis doc's explicit recommendation, mirroring the same discipline applied to Java's
live-ideas flag: this wiring, once built, should default OFF and run in shadow/observability mode
first (record what it *would have* emitted, grade those predictions via the existing
`ReflectionEngine`/`PredictionOutcomeEvaluator` pipeline), and only enable live emission once
there's real evidence. `MissedOpportunityDetector`'s taxonomy should also gain a
`THESIS_INVALIDATED` classification tied to `tradePlans.status` before any live wiring.

### Java quant engine has no path into ranking or thesis-building (gap-analysis doc — status
unverified for this consolidation beyond what's noted above)

`ComposableRanking.ts`'s 7 components are pure TypeScript arithmetic — none call
`quant-core-java`. What's directly reusable per the gap-analysis doc: `FactorAlphaEngine.java`'s
5-factor composite (already exposed via `QuantCoreBridge.fetchInstitutionalFactors()`),
`GarchEngine.java`/`fetchInstitutionalVolatility()` for a real volatility/regime read, and
`StrategyRegistry.java`'s `CORE`/`INSTITUTIONAL` map pattern as the right place for any future
`PREMARKET` strategy map. Recommendation: add an 8th `ComposableRanking` component,
`javaQuantScore`, sourced from the already-computed, already-Z-scored `composite` factor field —
marked `available: false` with a clear reason when Java is disabled or the symbol lacks history,
matching the other 7 components' honesty convention. New premarket-specific strategies should be
built only if a demonstrated need survives a discovery-only phase first.

### Extended-hours execution sequencing (as originally scoped — now partly built, see gate 25 above)

The gap-analysis doc scoped this as deliberately **last**, in dependency order: (1) OMS limit-order
construction, (2) `ibkr_gateway`'s `outsideRth` flag, (3) `AlpacaBroker`'s `extended_hours` flag
(contingent on 1), (4) gate 12 extension to distinguish `PRE_MARKET`/`AFTER_HOURS` from `CLOSED`
(and fix the Alpaca-unconfigured skip-pass gap as part of the same change), (5) a new
`ExtendedHoursExecutionPolicy` gate running *in addition to* the existing 24 gates, never
replacing or loosening any. **Items (1), (4), and (5) have since landed** (verified this
consolidation — see § Risk Engine Gates above); whether (2) and (3) are fully complete per-adapter
was not re-verified here.

### `MarketDataWorker`'s subscription allocator has zero session awareness (unmeasured, unresolved)

The same static caps (`maxActiveSubscriptions=12`, `maxConcurrentTemporaryDataRescues=3`) serve
premarket and RTH discovery identically. The gap-analysis doc's explicit recommendation: this
needs **measurement before a fix, not a number change** — instrument subscription utilization,
candidate wait time, fresh-data denial rate, split by session, before deciding whether premarket
needs its own reserved-slot class (mirroring the existing `rescueReservedSlotsForPriorityClasses`
mechanism) or whether the existing pool is adequate once actually measured under premarket load.

### What this section does not claim

- It does not claim System B's code is bug-free or production-hardened for premarket volume.
- It does not claim Java-authority integration into ranking is a small change — whether
  `FactorAlphaEngine`'s composite is a good *premarket* discriminator is an empirical question, not
  an assumption.
- It does not assert a specific premarket resource-allocation fix — only that one must be measured
  first.
- It does not fully re-verify, for this consolidation, every claim in the two source audits beyond
  the extended-hours execution finding called out at the top of this section — treat anything not
  explicitly re-verified here as accurate as of the audits' own 2026-09-05 date, not as re-checked
  today.

## IBKR order-lifecycle crash recovery (2026-09-09 P0 remediation sprint, `CLAUDE.md` DEF-30)

**Problem found (2026-09-09 forensic audit):** `OrderManagement.ts`'s `reconcileStaleOrders()` and
`reconcileInboundBrokerOrders()` were already real, correct, broker-agnostic crash-recovery
machinery (`reconcileStaleOrders()` predates this sprint — comment cites an earlier
`ARGUS_SAFETY_HARDENING_REPORT.md` Phase 1 pass; `AlpacaBroker.getOrderByClientOrderId()` already
implemented the contract it depends on). But **IBKR had never implemented that contract at all**:
`buildIbkrOrder()`/`placeStockOrder()` never set IB's `Order.orderRef` field, `IbkrSocketSession`'s
`trackedOrders` map was in-memory only (empty after every process restart, by construction), and
`IBGatewaySocketAdapter` had no `getOrderByClientOrderId()` method — so the generic mechanism's own
`typeof broker.getOrderByClientOrderId !== 'function'` guard silently no-op'd for IBKR, every time.
A crash between "IB accepted the order" and "Argus recorded it locally" was therefore structurally
unrecoverable for IBKR specifically — the exact gap `docs/audits/` cite as the highest-priority
execution-safety defect at the time this section was written.

**Identity mechanism (investigated, not invented):** IB's `Order.orderRef` (`@stoqey/ib`'s own
`order.d.ts`) is a free-text field (~100 chars), set by the placing client, persisted by IB, and
echoed back on `openOrder`, `orderStatus`, and `execDetails` events for that order's entire
lifetime — including after a full Argus process restart or IB Gateway restart, as long as the same
IB account is queried. `Execution.orderRef` (`execution.d.ts`) carries the same value independently
on each individual fill. OMS already always passes `clientOrderId: <local trades.id>` into every
`placeOrder()` call (`OrderManagement.ts` `executeOrder()`) — this fix simply makes IBKR forward
that value into `orderRef`, and makes IBKR read it back out, matching the pattern
`AlpacaBroker.ts`'s `client_order_id` query param already established for the other broker.

**Fix, by file:**
- `src/brokers/IbkrSocketSession.ts`: `buildIbkrOrder()` sets `order.orderRef` from
  `opts.clientOrderId`. `TrackedOrder` gained a `clientOrderId` field and a
  `clientOrderIdIndex: Map<string, number>` (clientOrderId → IB orderId). `connect()` calls
  `ib.reqOpenOrders()` + `ib.reqExecutions(9002, {})` on every successful (re)connect (not just
  first boot). New `openOrder`/`openOrderEnd` handlers rehydrate `trackedOrders` for any order IB
  reports that this process instance didn't place itself (a prior instance's order, surviving a
  crash) — never overwrites an order this process already has fresher state for. `execDetails` was
  extended to do the same via `Execution.orderRef` for the case `reqOpenOrders()` alone cannot
  cover: an order that fully filled and dropped out of IB's open-orders set before this process
  could reconnect. `hasCompletedInitialRehydration()` (true only after `openOrderEnd` for the
  *current* connection) is the mechanism that keeps "rehydration hasn't finished yet" from being
  mistaken for "confirmed absent" downstream.
- `src/brokers/IBGatewaySocketAdapter.ts`: `placeOrder()` now forwards `order.clientOrderId` into
  `session.placeStockOrder()`. New `getOrderByClientOrderId()` implements the `BrokerAdapter`
  optional-interface contract — deliberately **throws** (not `null`) while
  `!session.hasCompletedInitialRehydration()`, so `OrderManagement.reconcileStaleOrders()`'s
  existing catch-and-skip-this-cycle behavior applies instead of a false REJECTED mark on a real,
  still-open broker order. `orders()` now includes `clientOrderId` in its mapped `Order[]` — this
  was a real, separate bug: without it, `reconcileInboundBrokerOrders()`'s own dedup check
  (`o.clientOrderId && byClientId.has(...)`) could never succeed for any IBKR order, so even an
  order Argus fully recognized would have been misfiled as an unrecognized `SOURCE: EXTERNAL_MANUAL`
  fill once rehydration started populating `orders()` at all.
- `src/server/services/OrderManagement.ts`: `reconcileInboundBrokerOrders()` gained a new branch —
  a broker order with **no** matching local `trades` row that has **not yet filled** (previously
  invisible to this function entirely; the pre-existing logic only ever acted once real fill dollars
  existed) now pauses trading via the existing `pauseTradingForOrphan()` path (no second kill
  switch) and surfaces via `triggerWebhooks()` — never auto-cancelled, never auto-retried, matching
  the sprint's required invariant (`UNKNOWN → PAUSE → RECONCILE`, never `UNKNOWN → RETRY`).

**What this does not fix:** a bare `execDetails` whose `Execution.orderRef` is itself empty (some
order types/vintages may not carry it) still cannot be mapped back to a local `trades` row — it is
rehydrated and logged loudly, not silently dropped, but stays unreconciled until an operator looks;
the unknown-order pause is periodic (`CRASH_RECOVERY_INTERVAL_MS`), not instantaneous. Neither gap
changes the core invariant: no blind retry, no duplicate order, no silently-lost fill.

**Tests:** `src/brokers/__tests__/IbkrSocketSession.crashRecovery.test.ts` (new, 7 tests — clientOrderId
round-trip, rehydration-in-flight vs. complete, `openOrder`/`execDetails`-based rehydration, no
overwrite of self-placed orders, multi-fill accumulation, reconnect resets rehydration state),
2 new cases in `IbkrSocketSession.buildIbkrOrder.test.ts`, a new "no false rejection" case in
`OrderManagement.crashRecovery.test.ts`, and `OrderManagement.unrecognizedBrokerOrder.test.ts` (new
file — kept separate because `db`/`sqliteDb` are process-wide singletons keyed off `ARGUS_DB_PATH`
at first import; a second `describe` block in the same test file reusing `await import('../db')`
gets back the first block's already-closed connection).

## Durable CryptoPaperBroker state (2026-09-28, Crypto Gap Analysis G5, `ARGUS_CRYPTO_TRADING_REDESIGN_PLAN.md`)

**Problem found:** `CryptoPaperBroker.ts` held `cash`/`_positions`/`_orders` purely in in-memory
`Map`s — a process restart silently lost the entire simulated crypto PAPER portfolio, and no fill
was durable enough to prove idempotent recovery under a duplicate event.

**Fix:** three new tables — `crypto_paper_broker_state` (singleton row: cash/initialCash/
realizedPnl), `crypto_paper_positions` (one row per symbol), `crypto_paper_orders` (one row per
order, unique-indexed on `client_order_id` for the same idempotency guarantee the real OMS path
already has). Deliberately separate from the canonical `trades`/`fills` tables — those record what
Argus's OMS submitted TO a broker; these are this broker's OWN internal book, the crypto-paper
equivalent of what a real venue's own database would hold. `initialize()` hydrates the in-memory
Maps (kept as a write-through cache for `tick()`'s hot synchronous loop) from durable state, or
persists a fresh starting snapshot on first boot. Every mutation (`placeOrder()`, `modifyOrder()`,
`cancelOrder()`, and each order's fill inside `tick()`) persists immediately; a single fill's
cash/position/order mutation is wrapped in one `db.transaction()` so a crash between two different
orders' fills within the same `tick()` call leaves the already-completed fill durably recorded and
the not-yet-reached one untouched, never a half-applied fill. `currentPrice`/`marketValue`/
`unrealizedPnl` are deliberately NOT persisted (pure display fields re-derived from `entryPrice`/
`quantity`/`entryFees` by the next real tick, never restored as a stale valuation).

**Migration note:** `drizzle-kit generate` for this change also emitted a large batch of unrelated
`CREATE TABLE`/`ALTER TABLE` statements (`staged_news_catalysts`, `trades.commission`, etc.) that
turned out to already exist in the real `data/argus.db` — the drizzle-kit snapshot journal had
drifted from what was actually applied, independent of this change. The generated migration file
(`drizzle/0078_skinny_mockingbird.sql`) was manually trimmed to only the three genuinely new
`crypto_paper_*` table statements before being committed; the regenerated snapshot JSON (which
schema.ts diffing actually depends on) is correct going forward.

**Tests:** `CryptoPaperBroker.durability.test.ts` (new, 5/5 pass) — fresh-boot snapshot
persistence, cash/position/order survival across a simulated restart (fresh instance, same DB),
duplicate-clientOrderId protection surviving that restart, a fully-closed position's row removal
(not left stale), and write-through consistency between in-memory and durable state after a
partial fill. Existing `CryptoPaperBroker.test.ts` (27 tests, pre-existing behavior) unaffected —
32/32 across both files.

## Real (not fabricated) upstream idea generation in the AI-outage baseline test (2026-09-28)

**Problem found:** `aiOutageQuantOnlyBaseline.integration.test.ts` (Master Redesign Plan Phase 3's
own "all AI unavailable" experiment) proved the DOWNSTREAM half of the quant-only path — a
directly-constructed idea reaching ChiefTrader → RiskEngine → OMS → a real PAPER fill with a
genuinely empty `AIRouter` — but its `TechnicalAgent` "idea" was `agent.reviewIdea({side:'BUY',
confidence:0.88, reasoning:'real RSI/MACD breakout...'})`: a hardcoded payload, not an actual
indicator computation. It never exercised market data → real strategy calculation → a naturally
emitted idea.

**Addition (not a replacement):**
`aiOutageQuantOnlyBaseline.marketDataDriven.integration.test.ts` starts the real `technicalAgent`
singleton (`TechnicalAgent.ts`), feeds it 50 real `MARKET_DATA` events using a price sequence
independently re-verified against the live `evaluateTechnicalSignals()` engine (BUY, confidence
0.831, real RSI/MACD-crossover-derived, matching `technicalSignal.test.ts`'s own `risingTrendPrices`
fixture at `quantThresholds.technicalHistoryBars`), captures the resulting real
`TRADE_IDEA_GENERATED` event from the EventBus (never constructed by the test), and feeds that
unedited payload into `ChiefTraderAgent.reviewIdea()` — same downstream assertions as the original
file (real fill, no fabricated `ConsensusDebate` vote, `RiskEngine` approval, `PAPER_TRADING_ONLY`).

**Known, explicitly-labeled remaining gap:** the second required independent voice (`QuantEngine`)
is still a directly-constructed idea in both outage test files. Driving it organically requires
`QuantSignalAgent.evaluateSymbol()`'s real path — real OHLCV bars plus real regime/momentum/volume/
support-resistance/market-context computation (including SPY/sector relative strength) — with no
existing known-good bar-shape fixture anywhere in this repository (`momentumBreakout.test.ts`'s
`baseFixture()` constructs a `StrategyContext` directly, not from bars). This is substantially
larger than a bounded batch and is the concrete next step for full upstream coverage, not attempted
in this pass.

## RECONCILIATION_REQUIRED outcome propagation (2026-09-27, `ARGUS_CODE_DEFECT_AUDIT_AND_FIX_PLAN.md` F04 reopened)

**Problem found:** the private `recordFillProgress()` helper in `OrderManagement.ts` — shared by
`executeOrder()`'s initial post-placement poll, the async follow-up job
(`applyFollowUpUpdate()`), and the crash-recovery loop in `reconcileStaleOrders()` — already
correctly rejected missing/non-finite broker fill evidence (via `fillLedger.ts`'s
`insertIncrementalFill()`) and marked the `trades` row `RECONCILIATION_REQUIRED`. But it returned a
bare `number`, so none of its three callers could see that outcome; each one unconditionally wrote
its own locally-tracked broker status (e.g. `FILLED`) a few lines later, silently overwriting
`RECONCILIATION_REQUIRED` and broadcasting a false `ORDER_EXECUTED`/`ORDER_FILLED`-shaped event for
an order whose fill economics were never actually recorded.

**Fix:** `recordFillProgress()` now returns `{ newQty: number; reconciliationRequired: boolean }`.
All three call sites check `reconciliationRequired` and, when true, use `RECONCILIATION_REQUIRED`
(never the broker-reported status) for their own subsequent `trades` write and execution event; the
crash-recovery path also skips closing the associated transaction as `RECONCILED` in that case. A
related defect the new tests surfaced: the crash-recovery write used
`realOrder.averageFillPrice ?? row.price` — nullish-coalescing does not catch `NaN` (only
`null`/`undefined`), so a NaN fill price (the exact invalid-economics case this fix exists for)
reached better-sqlite3's bind step and crashed the whole reconciliation loop
(`NOT NULL constraint failed: trades.price` — better-sqlite3 binds `NaN` as SQL `NULL`) instead of
degrading gracefully. Fixed with an explicit `Number.isFinite(...)` check; the other two call sites
already used truthy/`||` checks, which correctly treat `NaN` as absent.

**Tests:** `OrderManagement.lifecycle.test.ts` gained a new test exercising the initial-poll call
site directly (a controllable `placeOrderResponseOverride` on the stub broker) and its pre-existing
follow-up-path F04 test now also has an explicit `reconciliationRequired` check (previously
protected only incidentally by an unrelated CAS concurrency guard, which does not cover a
same-cycle repeat-rejection). `OrderManagement.crashRecovery.test.ts` gained a new test asserting
both the persisted `trades.status` and the captured `ORDER_EXECUTED` event payload never read
`FILLED` on rejected fill evidence.

## News prompt-injection isolation (2026-09-09 P0 remediation sprint, `CLAUDE.md` DEF-31)

**Problem found:** `NewsScoringEngine.analyzeWithAI()` interpolated externally-sourced
`article.title`/`content`/`source` (RSS feeds, paid news APIs — untrusted, attacker-influenceable
text) directly into the LLM prompt via a bare template literal, with no delimiter separating
instructions from data. Concretely exploitable, not theoretical: `NewsEngine.ts` feeds
`aiAnalysis.tradingBias`/`confidence` straight into `eventBus.emitTradeIdea()` as one of
ChiefTrader's independent votes, so a successful injection is a route toward influencing a real
trade idea, not just bad output text.

**Fix:** `buildNewsAnalysisPrompt()` (`src/server/news/NewsScoringEngine.ts`) places all
instructions and the output schema *before* a single `<UNTRUSTED_ARTICLE_DATA>...
</UNTRUSTED_ARTICLE_DATA>` block, with an explicit instruction that everything inside is data to
analyze, never commands — covering fake system/role messages, fake JSON impersonating the real
output schema, and prompt-extraction attempts. `neutralizeDelimiterEscapes()` strips any literal
occurrence of the tag strings from the untrusted text itself, so embedded article text cannot forge
a fake closing tag and escape the block. The instructional prose itself deliberately avoids
spelling out the literal `<UNTRUSTED_ARTICLE_DATA>` syntax a second time (an early version of this
fix did, which created a spurious extra "closing tag" occurrence before the real block even opened —
harmless to the security boundary since it sat in the trusted instruction text, but worth noting as
a documented pitfall for anyone extending this pattern to another agent's prompt).

This is structural isolation, not the *only* defense — `AIOutputValidator`'s pre-existing
`clampScore`/`coerceEnum`/`coerceString`/`looksLikeListedTicker` (unchanged by this fix)
independently bound every field to its valid schema/range regardless of what the model was tricked
into emitting, and `materiality`/`novelty`/`expectedHorizon`/`catalystType` were already, and
remain, deterministic server-side values never taken from the LLM at all — see this file's own
`AIAnalysisResult` doc comment. Defense in depth: even a "compromised" model response cannot exceed
the schema's own bounds.

**Not yet extended:** other agents (`FundamentalAgent`, `MacroAgent`, Bull/Bear research) also embed
externally-sourced text (data-provider responses, research notes) into their own prompts — same
class of risk, out of scope for this pass, a real candidate for the next hardening cycle rather than
an oversight to treat as already covered.

**Tests:** `src/server/news/NewsScoringEngine.promptInjection.test.ts` (new, 10 tests) covering the
full hostile-input battery this sprint required: "ignore previous instructions", fake system
messages, fake JSON, role-like content, injection via title/body/source, delimiter-escape forgery,
prompt extraction, and an end-to-end "compromised response" check confirming clamping still holds.

## Research Memory Platform — Phase 1: persisted pre-registered Hypothesis/Experiment/Trial store (2026-09-11)

**Mandate:** "ARGUS — Institutional Quant Research Memory, Telemetry & Continuous Learning
Platform" (94 sections) asked for an immutable research event store covering strategy identity,
signal provenance, drift detection, and — its own §37/§38 — a first-class, pre-registered
`Experiment` entity so a hypothesis is frozen *before* its evidence is examined, never redefined
after seeing results.

**Audit before building (same discipline as StrategyRegistry/SignalBus/CorrelationEngine/
FeatureEngine earlier in this same mandate arc):** a thorough audit found this codebase already
covers most of the 94 sections more than a fresh read of the spec would suggest — `event_traces`/
`consensus_evidence`/`agent_reasoning_logs` are genuinely insert-only and already power
`getDecisionTrace()`'s 7-table reconstruction; `learning_versions` +
`StrategyEmissionEligibility.ts` already give every strategy immutable identity/version/lifecycle;
`StrategyEvaluation.conditionsMet/conditionsFailed` is already a real per-cycle condition trace,
persisted in `quant_assessments` for every strategy on every symbol regardless of outcome, not
just the winner; `strategySelectionReplay.ts` already reconstructs a real no-signal/eligibility
taxonomy from that same data. Building new versions of any of those would have been exactly the
"more logs, not research memory" outcome the mandate itself warns against.

**The one genuine, confirmed gap:** `src/server/research/experimentLedger.ts` already had correct,
real logic — per-trial provenance (`TrialRecord`), a real Deflated Sharpe Ratio (Bailey & Lopez de
Prado), and multiple-testing awareness — but its `ExperimentLedger` was an in-memory singleton with
no pre-registration concept at all, evaporating on every process restart unless an operator
happened to set `ARGUS_WRITE_RESEARCH_PARQUET=true` for an optional JSON dump. This session's own
pre-registered walk-forward validations (the H1/H2/H3-style "freeze the hypothesis before
inspecting new results" discipline) only ever existed inside a conversation transcript or a dated
audit doc — nothing in the schema could answer "which hypotheses were pre-registered, and when."

**Fix — three new tables** (`src/server/db/schema.ts`, migration `drizzle/0063_fantastic_morg.sql`):

- `research_hypotheses` — `statement`, optional `strategyId`/`metric`/`expectedDirection`/
  `acceptanceCriteria`, `preregisteredAt` (set once, at insert, never updated — this is the
  timestamp that later proves the hypothesis existed before its evidence was examined), and
  write-once resolution fields (`resolvedAt`/`resolvedStatus`/`resolvedEvidenceJson`) enforced at
  the application layer (`resolveHypothesis()` throws on a second resolution attempt) rather than a
  full status-event table — a hypothesis has exactly one terminal resolution, not an evolving
  multi-step lifecycle the way a strategy version does (which already has `learning_versions` for
  exactly that reason).
- `research_experiments` — groups trials under one hypothesis test (`hypothesisId` nullable — an
  experiment need not be pre-registered), `status` (`DRAFT|RUNNING|COMPLETED|FAILED|ABANDONED`),
  write-once completion (`completeExperiment()`, same enforcement pattern).
- `research_trials` — durable mirror of `TrialRecord`, insert-only, linked to an experiment via a
  nullable `experimentId` (a trial can still be recorded standalone, outside any formal experiment
  — the pre-2026-09-11 default behavior, unchanged).

Both new tables reuse existing identity, never invent a second one: `strategyId` still points at
real strategy ids (`learning_versions`/`quant/strategies/`), `datasetHash` reuses the existing
convention already used by `strategy_engine_backtest_runs`/`replay_runs`.

**Hot-path isolation (mandate §77/§78):** `recordExperimentTrial()`'s existing synchronous
signature and in-memory behavior are completely unchanged — the DB write
(`experimentLedger.ts`'s `persistTrialToDb()`) is fire-and-forget, wrapped in try/catch, and never
awaited by the caller, so a persistence hiccup can never block or fail a real backtest/walk-forward
run. `experimentLedgerSnapshot()`'s multiple-testing warning is still computed from the in-memory
ledger exactly as before — durable persistence is an additive audit trail, not a swap of the
warning's live behavior.

**New programmatic API** (`experimentLedger.ts`): `registerHypothesis()`, `resolveHypothesis()`,
`createExperiment()`, `completeExperiment()`, `listHypotheses()`, `listExperiments()`,
`listTrialsFromDb()`, `getExperimentWithTrials()` (composes hypothesis + experiment + its full
durable trial history in one call — the research-lineage read this phase exists to make possible).

**New read-only routes** (`src/server/routes/researchRoutes.ts`): `GET /api/v2/research/hypotheses`,
`GET /api/v2/research/experiments`, `GET /api/v2/research/experiments/:id` — distinct from the
pre-existing `GET /api/v2/research/experiment-ledger` (that one remains the in-memory,
current-process-only multiple-testing counter, unchanged). Write access
(`registerHypothesis`/`createExperiment`/`resolveHypothesis`/`completeExperiment`) stays
programmatic-API-only this pass; a formal pre-registration workflow with operator review is
deliberately deferred rather than rushed into an unreviewed HTTP write surface.

**Explicitly not fabricated:** no historical hypothesis from this session's own prior forensic
work (Kronos BUY/SELL asymmetry, Quant BUY 0.7–0.8, Quant SELL 0.6–0.7 tail risk) was backfilled
into `research_hypotheses` — most of those were discovered in-sample, by inspecting the same data
later used to test them, and retroactively labeling them "pre-registered" would be exactly the
data-mining-bias-laundering this whole feature exists to prevent. The table starts empty and only
ever records real pre-registrations made from this point forward.

**Deliberately deferred to a later phase, not attempted in this pass:** multi-horizon forward-
outcome tracking (mandate §13 — `prediction_outcomes` remains one row per prediction at one
resolved horizon), a rolling-baseline drift detector (mandate §30–32 — only point-in-time
calibration-floor and one-shot expectancy-divergence checks exist today), and a no-signal feature
snapshot for every evaluation cycle (mandate §3/§10 — today's rich `snapshotFromStrategyContext()`
is computed and persisted only when a signal actually fires). Each is a real, smaller extension of
an already-built mechanism, not a new foundational entity, and the audit that produced this section
recommended they follow the Experiment/Hypothesis table rather than precede it — a real drift
detector's natural home is "did this experiment's live performance drift from what it was
pre-registered to expect," which needed this table to exist first.

**Tests:** `src/server/research/experimentLedger.persistence.test.ts` (6 tests — pre-registration
timestamp, write-once resolution/completion enforcement, cross-restart-style composition via a
fresh DB connection, null-experimentId standalone trials), `src/server/routes/
researchRoutes.hypothesesExperiments.test.ts` (3 tests, real Express router + real DB, no mocks).
Full existing `experimentLedger.test.ts` suite (backward-compatible 2-argument call site,
per-trial provenance, DSR) and `replayWalkForward.test.ts`/`v2System.quantObservability.test.ts`
(the two other real production call sites) verified unchanged.

## Research Memory Platform — Phase 2: multi-horizon forward-outcome tracking (2026-09-12)

**Gap closed** (deferred at the end of Phase 1 above, per the same audit's recommendation to
build it after the Experiment/Hypothesis table rather than before): mandate §13 ("Do NOT assume
one universal horizon... store +1 bar / +5 bars / +20 bars... where appropriate"). Before this,
`prediction_outcomes` was structurally one row per `(predictionId, sourceTable)` — a single
resolved evaluation horizon (real, and correctly per-strategy-tuned via
`config/evaluationHorizons.json`, but genuinely single-horizon, since it feeds
`agent_performance_stats.currentWeight` and one stable grading window per prediction is the
*correct* behavior there, not a bug).

**Fix — one new table, one new additive worker, deliberately separate from the live grading
path:** `prediction_outcome_horizons` (`src/server/db/schema.ts`, migration
`drizzle/0064_confused_leo.sql`) — `predictionId`/`sourceTable` (same convention as
`prediction_outcomes`), `horizonLabel`/`horizonBars`, direction-adjusted `forwardReturn` (same
sign convention as `prediction_outcomes.mfe`/`mae` — positive is always favorable for the
prediction's own side), raw `forwardDirection`, unique on `(predictionId, sourceTable,
horizonLabel)`. Real horizon definitions (`1_BAR`/`5_BAR`/`20_BAR`/`60_BAR` by default) live in
`config/multiHorizonOutcomeTracking.json` — never a TypeScript literal, per this codebase's
standing config rule.

`src/server/services/MultiHorizonOutcomeEvaluator.ts` is a new, independent interval worker
(own `start()`/`stop()`, wired into `SystemBootstrap.ts` immediately after
`predictionOutcomeEvaluator` and covered by the same `gracefulShutdown.ts` → `system.stop()` path
that already stops it — no separate DEF-27-style gap introduced). It reads the same
`agent_predictions`/`kronos_predictions` sources `PredictionOutcomeEvaluator.ts` does, applies the
same exclusions (skip `KronosEngine` rows inside `agent_predictions` — already graded once from
`kronos_predictions`; skip Digital-Twin telemetry-pulse rows; only directional BUY/SELL), but
computes its own independent set of fixed bar-offset forward returns from a single
`historicalDataGateway.getBars()` call per prediction, using `onConflictDoNothing()` for the same
idempotent-retry behavior. A horizon whose bars have not arrived yet is simply left unevaluated
(no row) and retried next cycle — never a fabricated or interpolated value, same honesty
convention `PredictionOutcomeEvaluator.ts` itself already uses.

**Explicitly does not touch:** `PredictionOutcomeEvaluator.ts` (unmodified — the live single-
horizon WIN/LOSS grade and its weight-learning consequences are completely untouched),
`agent_performance_stats.currentWeight`, `ChiefTraderAgent`, `RiskEngine`, `OMS`. This is
observational research telemetry only, on its own independent interval and its own table.

**Read access:** `src/server/research/multiHorizonOutcomeReport.ts`'s `buildMultiHorizonSummaryReport()`
(same JS-side full-table-read + `Map` grouping convention `agentEdgeAnalytics.ts` already uses,
not a new query style) joins back to `agent_predictions`/`kronos_predictions` for real
`agentName`/`strategyId` attribution (reusing the `agent_predictions.strategy_id` column from the
strategy-attribution work earlier this session), grouped by `(agentName, strategyId,
horizonLabel)` into `n`/`meanForwardReturn`/`positiveReturnRate`. Exposed at
`GET /api/v2/observability/multi-horizon-outcomes` (`argus-cli multi-horizon-outcomes`).

**Tests:** `src/server/services/MultiHorizonOutcomeEvaluator.test.ts` (7 tests — real `ohlcv_bars`
rows, same convention as `PredictionOutcomeEvaluator.test.ts`: direction-adjusted forward returns,
SELL sign-flip, HOLD exclusion, partial-horizon resume, insufficient-bars honesty, real
`evaluatePending()` persistence + idempotency + HOLD/telemetry-pulse/KronosEngine-duplicate
exclusion), `src/server/research/multiHorizonOutcomeReport.test.ts` (4 tests). Full existing
`PredictionOutcomeEvaluator.test.ts` suite verified unchanged (9 tests, confirming the live
single-horizon grading path was not touched by this addition).

## ConsensusDebate P0.5 forensic measurement (2026-09-13)

**The finding that motivated this:** a real, data-driven P0 funnel audit (live DB, 30-day window)
found Argus's evaluation/idea-generation funnel is large and healthy (44,051 quant cycles, 908,691
strategy evaluations, 104,889 total agent predictions) but only 58 of 9,856 consensus transactions
(0.6%) were approved. Tracing why found `ConsensusDebate` (ChiefTraderAgent's adversarial AI
second-opinion layer) participates in ~84% of consensus rounds, votes HOLD ~96% of the time, and
disagrees with the eventual consensus ~91% of the time — and, critically, its HOLD vote is not
just diluting the weighted average: `evaluateConsensusSerialized()`'s `debateSaidHold` branch is a
**hard, categorical veto** that fires before the strong-agreement approval branch, regardless of
weighted confidence or independent-agent count. `ConsensusDebate` had zero rows in
`agent_predictions`/`agent_performance_stats` — its own predictive value had never been measured
anywhere in this codebase, unlike every other agent (which goes through Wilson-interval
calibration before its weight is trusted).

**A confound found during the same audit, before any new code was written:** a separate, very
recent fix (2026-09-11, landed by concurrent work on this repo) corrected a real bug where
fail-closed debate outcomes (AI timeout/no-route/error) were being recorded as real 0.8-confidence
HOLD votes capable of triggering the same hard veto — a guaranteed artifact of an external outage,
not a real adversarial review. That fix had almost no runtime exposure before this measurement
work began (the engine was down for ~36 hours immediately after it shipped), so the historical
96%/91% figures are likely contaminated by the now-fixed defect and cannot yet be trusted as a
measurement of genuine debate behavior. This is why the mandate's objective is OBSERVATION ONLY:
measure cleanly from this point forward, not draw a conclusion from contaminated history.

**Fix — real counterfactual capture, wired into the live decision path, never changing what
ChiefTraderAgent actually decides:**

- `consensus_debate_predictions` (`src/server/db/schema.ts`, migration
  `drizzle/0065_silky_monster_badoon.sql`) — one row per debate involvement (valid vote or
  fail-closed AI-reliability event). `baseConsensusSide`/`baseConsensusConfidence` are the REAL
  counterfactual: `EvidenceAggregator.aggregate()` called a second time on the same evidence array
  with ConsensusDebate's own row excluded — not a reimplemented approximation of the consensus
  formula. `baseClearsThreshold`/`baseClearsIndependence` + the real final `withDebateApproved`
  together define `vetoFired` (debate's HOLD was the reason — or a contributing reason — an
  otherwise-qualifying round did not approve).
- `src/server/services/ConsensusDebateForensics.ts` — pure `computeConsensusDebateCapture()` (unit
  tested against the exact real weighted-vote formula, including confirming `ConsensusDebate` is
  in `config/agentWeights.json`'s `consensusHardVetoAgents`, so its HOLD vote both hard-vetoes
  *and* penalizes the weighted average) + `persistConsensusDebateCapture()` (best-effort, never
  throws into the caller). Wired into `ChiefTraderAgent.ts`'s `evaluateConsensusSerialized()`
  right after `approved`/`result` are fully resolved, and into `pushDebateFailClosed()` /
  the `noRoutableProviders` skip branch via a new per-symbol `pendingDebateFailClosed` map so a
  fail-closed event (which never becomes a vote) is still captured as real AI-reliability telemetry
  the next time that symbol's consensus round evaluates.
- `src/server/services/ConsensusDebateOutcomeEvaluator.ts` — new interval worker (wired into
  `SystemBootstrap.ts`, covered by the existing `gracefulShutdown.ts` drain path) that grades
  `baseConsensusSide` — "would the candidate ConsensusDebate vetoed have won or lost" — via the
  EXISTING `evaluatePrediction()` (`PredictionOutcomeEvaluator.ts`, now accepting
  `'consensus_debate_predictions'` as a `sourceTable`) and the EXISTING shared `prediction_outcomes`
  table, rather than a fourth parallel grading mechanism. FAIL_CLOSED_* rows are never graded — an
  AI reliability event is not a prediction.
- `src/server/research/consensusDebateHealthReport.ts` — the central metric this whole measurement
  exists to produce: **net economic value of vetoes** (sum of real forward returns across every
  graded, vetoed candidate — negative means ConsensusDebate is blocking more value than it
  protects; positive means it's net-protective), plus GOOD_VETO/BAD_VETO classification, veto
  precision, confidence-bucket breakdown, and regime breakdown. Sample-size gate reuses the
  existing, already-reviewed `researchSafety.json` `minOosTrades` (30) floor rather than inventing
  a new number. Recommendation states match the mandate's own vocabulary:
  `INSUFFICIENT_DATA | POSITIVE_INCREMENTAL_VALUE | NEUTRAL_INCREMENTAL_VALUE |
  NEGATIVE_INCREMENTAL_VALUE`. Exposed at `GET /api/v2/observability/consensus-debate-health`
  (`argus-cli consensus-debate-health`, optional `--hours=N`).

**Explicitly deferred, not silently omitted:** grading `ConsensusDebate`'s own directional (BUY/SELL)
calls for accuracy (rare — ~3.6% of participations in the initial audit; the HOLD-veto question is
the one that matters at this system's actual usage pattern); a full chronological
train/validation/OOS three-way split (the report accepts an optional `sinceIso` window so this can
be added once real sample size exists — building it now, against near-zero data, would only
produce three empty buckets); a frontend Consensus Debate Forensics page (the mandate's own
priority order puts the measurement phase first — "only after P1–P7 work" for the frontend and
P1-mandate work, and this phase's own explicit rule is OBSERVATION ONLY until real evidence exists).

**Tests:** `ConsensusDebateForensics.test.ts` (7 tests, including one that reproduces the exact
real weighted-vote arithmetic from a live audit sample and confirms it matches to 3 significant
figures), `ConsensusDebateOutcomeEvaluator.test.ts` (4 tests, real `ohlcv_bars` + real grading),
`consensusDebateHealthReport.test.ts` (5 tests, real DB), and a targeted wiring test,
`ChiefTraderAgent.consensusDebateCapture.test.ts` (2 tests, proving a real debate HOLD veto
triggers the capture call with correct evidence — using the same mocked-db/EventBus/AIRouter
convention `ChiefTraderAgent.test.ts` already established, plus a spy on the capture function).

## Real Opportunity Snapshot (Institutional Transformation Mandate, Part 8/9, 2026-09-13)

A 32-part "master transformation mandate" (UniverseService, FeatureEngine, StrategyCorrelation
Engine, QuantForecastEngine, AlphaOpportunityEngine, PortfolioConstructionEngine,
CapitalAllocationEngine, intraday event loop, execution analytics, institutional frontend, …)
arrived requesting Argus evolve into a full systematic-trading platform. Per the mandate's own
Part 31 ("Implementation Discipline" — inspect existing implementation, identify reusable
infrastructure, minimal compatible changes, one subsystem at a time) and this session's
established audit-before-build discipline, most of the requested subsystems were already found,
across this and earlier sessions, to either already exist (`StrategyRegistry` ≈
`strategyCatalog.ts`, `FeatureEngine` ≈ Java `QuantitativeFeatureEngine`/`quant-core/catalog`,
`CorrelationEngine` ≈ Java `correlation_engine` at RESEARCH status, Research Memory ≈ this
document's own Phase 1/2 sections above, Missed Opportunity Engine ≈
`MissedOpportunityDetector.ts`'s existing real taxonomy) or require genuinely new Java quant
calculation work (expected-return/volatility/probability-of-profit modeling — CLAUDE.md's Java 26
Engine Authority: "all new quant/indicator/strategy calculation work goes to Java") that must not
be rushed into a TypeScript approximation.

**What was genuinely missing and safely buildable now:** a real, evidence-ranked cross-sectional
view composing already-real numbers — Part 8/9's intent — without inventing the expected-return
model Part 7 would require. `src/server/research/opportunitySnapshot.ts` composes five already-real
reports (recent `QuantEngine` ideas via `agent_predictions.strategy_id`, real historical edge via
`agentEdgeAnalytics.ts`, real multi-horizon forward returns via `multiHorizonOutcomeReport.ts`, real
strategy metadata via `strategyCatalog.ts`, real held-position status) into one ranked view, sorted
by real evidence quality (`evidenceClassification`, then Wilson lower bound) — deliberately never a
synthetic weighted "opportunity score," which the mandate's own Part 8 explicitly warns against
("Not a fake score... every number must have provenance") absent a validated economic model.

**A real correctness bug found and fixed while building this:** `agentEdgeAnalytics.ts` still
groups by `secondaryGroupKey()` (reasoning-text regex), not yet by the real `strategy_id` column
added earlier this session — and per this file's own Phase 1 note above, essentially every current
`QuantEngine` idea is still `COLD_START_BOOTSTRAP`-sourced (zero organic closed trades exist yet),
meaning a naive `strategyId` lookup into `agentEdgeAnalytics`'s rows would almost never match real
production data. `opportunitySnapshot.ts`'s `lookupEdge()` checks both the plain and
`__COLD_START_BOOTSTRAP`-suffixed variants (same pattern `strategyReadiness.ts` already
established), surfacing which variant matched — never merging the two populations.

Exposed at `GET /api/v2/observability/opportunity-snapshot` (`argus-cli opportunity-snapshot
--limit=N`). **Tests:** `opportunitySnapshot.test.ts` (6 tests, including one specifically
reproducing the `COLD_START_BOOTSTRAP` fallback against realistic production-shaped reasoning
text).

## Execution Quality / Slippage Tracking (Institutional Transformation Mandate, Part 16, 2026-09-13)

CLAUDE.md's own Frontend Honesty table previously documented a genuine, structural gap: "no
slippage field (proposal price not persisted)." Root cause was not missing intent but a mutable
column — `trades.price` is deliberately overwritten by `OrderManagement.ts` as an order progresses
(once at broker acceptance, again as fills resolve), so by the time a real fill existed to compare
against, the original decision-time price had already been destroyed. This directly blocks the
mandate's own Part 32 final-acceptance question #18, "Is execution destroying alpha?" — genuinely
unanswerable without a stable arrival-price baseline.

**Fix:** `trades.arrival_price` (schema.ts, migration `0066_wooden_power_man.sql`) is written once,
at the same pre-broker-call insert that already computes `intendedPrice` (`OrderManagement.ts`'s
`executeOrder()`), and is never touched by any later `.update(trades)` call — verified directly by
a new regression test (`OrderManagement.lifecycle.test.ts`, "preserves arrival_price untouched
through the full PARTIALLY_FILLED -> FILLED transition") that drives a real order through a full
lifecycle with a broker-reported fill price deliberately different from the arrival price, and
confirms `price` mutates while `arrival_price` does not.

`src/server/research/executionQuality.ts` computes real slippage only where both a real
`arrival_price` and a real matching `fills` row exist — legacy trades predating this column, and
any order with no recorded fill, are excluded rather than estimated (never a fabricated number).
Sign convention: positive always means "worse than the price the decision was made at" for either
side (a BUY that filled above arrival, or a SELL that filled below), so the aggregate mean/median
slippage-in-bps answers the mandate's Q18 as a single signed number. Also derives real
submission-to-first-fill latency per order from the same real timestamps.

Exposed at `GET /api/v2/observability/execution-quality` (`argus-cli execution-quality
--limit=N`). **Tests:** `executionQuality.test.ts` (8 tests: BUY/SELL slippage sign, weighted-average
multi-fill aggregation, exclusion of legacy no-arrival-price rows, exclusion of no-fill rows,
summary statistics, `NO_DATA` formatting guard) plus the OMS-level regression test above. Runtime-
verified 2026-09-13: correctly reports `NO_DATA` immediately post-restart (no trade in the database
yet carries a real `arrival_price`, since this is a schema addition, not a backfill — exactly the
honest behavior the Frontend Rule requires rather than fabricating historical slippage).

## Quant Forecast Engine (Institutional Transformation Mandate Part 7, 2026-09-13)

The first real, working, end-to-end statistical forecast layer. Per the mandate's own explicit
scoping ("a dedicated Quant Forecast Engine pass... the smallest real, deterministic, testable
Quant Forecast Engine"), this is deliberately a real historical-statistics estimator over Argus's
own already-graded prediction outcomes, not a machine-learning model — the audit (below) found no
existing Java engine for this, and this codebase does not yet have enough real per-strategy
evidence volume to justify a more sophisticated model.

**Audit findings before building:**
- `quant-core-java/institutional/` has no existing forecast/expected-return engine (checked by
  name and by content search). `VolatilityEngine.java`, `QuantEnsembleEngine.java` (correlation-
  adjusted aggregation), `NormalDistribution.java` exist and are reused/left alone, not duplicated.
- `prediction_outcomes` (`PredictionOutcomeEvaluator.ts`) has 81,736 real graded rows today — real,
  substantial evidence volume. `prediction_outcome_horizons` (`MultiHorizonOutcomeEvaluator.ts`,
  built earlier this same mandate pass) has zero rows — real infrastructure, genuinely idle,
  needing elapsed time (matches the ledger's own prior finding for that part).
- **A real, load-bearing bug was found and fixed as a direct prerequisite**: `agent_predictions.strategy_id`
  (the canonical strategy-attribution column added in an earlier session) was populated on
  **zero of 6,249** real live QuantEngine rows. Root cause: `ReflectionEngine.ts`'s write path read
  `idea.quantDetail?.strategyEvaluation?.strategy`, which `QuantSignalAgent.ts`'s cold-start-
  bootstrap branch (the path essentially every real QuantEngine idea takes today, per this file's
  own "organic closed PAPER FILLED SELL P&L: 0" ground truth) deliberately nulls right after using
  it to build reasoning text — so the real strategy identity (e.g. `TREND_FOLLOWING`) only ever
  survived as free text ("Cold-start bootstrap: TREND_FOLLOWING is..."), never in the structured
  column. This is exactly what the user's own review of this session flagged as needing to be a
  tracked fix ("the canonical strategy identity needs to travel through the signal contract
  itself"), found to be more severe than a deferred migration — it was a genuine bug in the
  write path itself. **Fixed**: `QuantSignalAgent.ts` now captures `resolvedStrategyId` immediately
  after strategy selection, before any branch nulls `matchedStrategyEvaluation`, and emits it as a
  dedicated top-level `strategyId` field on the trade idea; `ReflectionEngine.ts` prefers that field.
  This fixes attribution for all NEW predictions going forward; the 81,736 existing historical rows
  were written before the fix and still rely on `secondaryGroupKey()` (reasoning-text regex) for
  strategy grouping — a real, tracked follow-up to migrate once enough post-fix volume exists.

**Architecture decision (Java 26 Engine Authority boundary):** the actual statistical computation
(mean/median/trimmed-mean/dispersion/Wilson-interval probability-of-profit) is a decision-
authoritative forecast calculation — it belongs in Java (rule 0/16), distinct from the existing
TS-side `wilsonInterval()` (`effectiveSampleSize.ts`), which remains a diagnostic/observability
tool for agent-calibration reporting, never this authoritative Forecast object. `ForecastEngine.java`
(new, `quant-core-java/institutional/models/`) is pure and deterministic: given a real sample of
historical forward returns and a transaction-cost assumption, computes every canonical-contract
numeric field, returning `INSUFFICIENT_DATA` (all fields null, never a fabricated default) below
`MIN_SAMPLE_SIZE` (20). "Profit" is defined net of transaction cost (`return > costBps`), not
merely `return > 0`, per the mandate's own explicit definition. Exposed at
`POST /api/v1/institutional/forecast` (`QuantCoreServer.java`), same request/response idiom as
`handleInstitutionalEnsemble`. 12 JUnit tests with hand-verified numerical fixtures (symmetric
1..20 sample for mean/median/trimmed-mean, hand-computed Wilson interval at p=0.5, net-of-cost
profit definition, INSUFFICIENT_DATA boundary) plus adversarial cases (empty/null/single-element
arrays, all-identical returns, an extreme 5000% outlier proving trimmed mean resists distortion
raw mean does not, all-catastrophic-negative sample, 100%-profit Wilson boundary).

`src/server/research/forecastEngine.ts` owns exactly the TypeScript side of rule 16
("orchestrate, expose APIs, persist read models, coordinate services"): assembles a real,
direction-oriented historical-return sample from `prediction_outcomes` (default horizon,
`PRIMARY_EVAL_HORIZON`) or `prediction_outcome_horizons` (explicit horizon labels), grouped by
agent and — when requested — real strategy id via `secondaryGroupKey()` (the same established
mechanism `agentEdgeAnalytics.ts`/`opportunitySnapshot.ts` already use, for the reason above), calls
`QuantCoreBridge.fetchForecast()`, and persists one immutable, versioned row to the new
`quant_forecasts` table (migration `0067_regular_wong.sql`) — never overwritten, a changed model
produces a new row with a new `modelVersion`. `MODEL_UNAVAILABLE` (Java disabled/unreachable/
circuit-open) is tracked as a distinct status from `INSUFFICIENT_DATA` (Java reachable, real sample
too thin) — both leave every numeric field null, never fabricated.

**A second real reliability bug was found and fixed during live verification**: the first live CLI
test (`argus-cli forecast --agent=TechnicalAgent --symbol=AAPL --direction=BUY`) returned
`MODEL_UNAVAILABLE` despite Java being healthy — `observability_events` showed the real cause:
`TIMEOUT` at 108ms against `quantJavaCoreRequestTimeoutMs`'s 100ms budget, because the unbounded
query had assembled and serialized **all 57,504** real TechnicalAgent historical rows into one HTTP
POST body. Fixed by capping the sample to the most recent `forecastEngineMaxSampleSize` (500,
`config/tradingSafety.json` — not hardcoded in TS, per this codebase's own config rule)
observations before ever calling Java — both a real reliability fix (matches the mandate's own
"Java Bridge Reliability... do not repeat the previous unbounded-concurrency problem" instruction)
and the statistically correct choice (recent, representative evidence over an unbounded
stale-inclusive blend). Provenance reports both `sourceRowCount` (true total evidence found) and
`sampleSizeSentToModel` (post-cap) so the real evidence volume is never understated. Re-verified
live after the fix: the same CLI call now returns `status: "VALID"`, `sampleSize: 500`,
`sourceRowCount: 57504` — a real forecast (`expectedReturn≈0.024%`, `probabilityOfProfit≈49%`,
honestly near-coin-flip, consistent with this system's documented lack of established edge, not a
sign of a bug).

Integrated into `opportunitySnapshot.ts` (mandate item 24) as an additive `modelForecast` field —
a bounded local DB read (`mostRecentForecast()`, no live Java call in that hot path, avoiding the
same unbounded-concurrency risk class the bug above just demonstrated), clearly distinct from the
existing `historicalEdge` field (OBSERVED/MEASURED real past outcomes vs. this MODEL FORECAST).

Exposed at `POST /api/v2/observability/forecast` (build + persist) and
`GET /api/v2/observability/forecast` (bounded read-only lookup); `argus-cli forecast --agent=
--symbol= --direction= [--strategyId=] [--horizon=]`. **Tests:** `forecastEngine.test.ts` (7 tests:
BUY/SELL return orientation, real strategy-id filtering via `secondaryGroupKey()`, `INSUFFICIENT_DATA`
from a real thin Java response, explicit non-default horizon honestly finding zero rows today, the
sample-cap regression, `mostRecentForecast()` null-when-absent) plus 2 new `opportunitySnapshot.test.ts`
cases (null by default, populates from a real persisted row). Full suite green (489 files / 3578
tests) after every change in this pass; `tsc --noEmit` clean; `mvn test` green (804 Java tests).

### Real strategy-diversity evidence integration (Part 9, same day, second pass)

Closed the one gap the Forecast Engine build above deliberately left open: `strategyCount`/
`familyCount`/`effectiveIndependentCount` were persisted as honest nulls because
`forecastEngine.ts` has no live market bars or strategy-evaluation context of its own to compute
them, and must never approximate or duplicate `internalQuantEnsemble.ts`'s own canonical,
correlation-adjusted measurement. **Audit finding:** `computeInternalEnsembleQualification()`
(`internalQuantEnsemble.ts`) already runs, live, inside `QuantSignalAgent.ts`'s own idea-emission
path (gated behind `isQuantIndependentQualificationEnabled()`/`isStrategySelectionConfluenceGuardEnabled()`,
both flags this deployment already has on) — it is the SAME real evidence ChiefTrader's own
independent-qualification bar already trusts, computed once per real emission, never per
evaluation cycle. No second correlation system, no new independent-count algorithm, no duplicate
strategy registry were created.

`ForecastRequest` gained an optional `ensembleEvidence` field carrying exactly
`{strategyCount, familyCount, effectiveIndependentCount}` — `forecastEngine.ts` only ever persists
what a caller supplies, never computes it. `internalQuantEnsemble.ts` gained a new pure, exported
`resolveEnsembleEvidenceForForecast()` (same "extract for independent unit-testability" pattern as
the existing `shouldSuppressForConfluenceGuard()`) that returns `null` — not the raw ensemble
result — whenever there is no ensemble for this cycle OR `sideMismatch` is true: a mismatched
ensemble's family/independence counts describe the OPPOSING side the ensemble actually agreed
with, so attaching them to an idea going the other direction would misrepresent contradicting
evidence as support. `QuantSignalAgent.ts` calls `buildForecast()` fire-and-forget (`void ...catch(...)`,
never awaited, never able to add latency or a new failure mode to the live decision path) exactly
once per real emitted QuantEngine idea — riding along on that already-bounded, already-rate-limited
real event, not a new unbounded call site.

`opportunitySnapshot.ts`'s `modelForecast` field and its text-table formatter gained the same
three fields (`EffIndep(fam)` column), rendering the literal string `UNKNOWN` — never a fabricated
number — whenever a persisted forecast carries no real ensemble evidence.

**Tests:** 4 new `internalQuantEnsemble.test.ts` cases for `resolveEnsembleEvidenceForForecast`
(null on no-ensemble, null on sideMismatch, faithful passthrough, and an explicit
correlated-strategies case proving `effectiveIndependentCount` is never inflated to equal raw
`strategyCount`), 2 new `forecastEngine.test.ts` cases (persistence + read-back round-trip with
real supplied evidence; null-propagation with none supplied), 2 new `opportunitySnapshot.test.ts`
cases (display of real values; `UNKNOWN` display when absent). Full suite green (489 files / 3585
tests) after this change; `tsc --noEmit` clean; build succeeds. No Java code changed this pass — the
existing, already-deployed `ForecastEngine.java`/endpoint needed no modification, since this
integration is entirely about what evidence TypeScript supplies to an unchanged Java contract.
Live-verified: single fresh engine process, watchdog unchanged, Java process unchanged (correctly,
since untouched), IBKR Gateway Socket `CONNECTED` (`DUR959160`, a real `DU*`-prefixed paper
account), reconciliation `RECONCILIATION_MATCH` on every recent cycle, zero positions,
`LIVE: NO-GO`, `argus-cli forecast`/`opportunity-snapshot`/`execution-quality` all respond
correctly post-deploy. Observing a real live QuantEngine-triggered forecast with populated
`ensembleEvidence` requires an actual QuantEngine idea to fire in real trading — not forced or
fabricated for this verification pass, since Autobot was in its pre-existing, unrelated
`TRADING_PAUSED` state; the wiring itself is proven by the round-trip persistence test instead.

### Frontend: real Opportunity Snapshot panel (2026-09-13 late pass)

`src/components/OpportunitySnapshotPanel.tsx` (new) — mounted in the existing `opportunities` tab
below the pre-existing "Autonomous Opportunity Feed" (a different, raw `agent_predictions` view),
reads the already-real, already-tested `GET /api/v2/observability/opportunity-snapshot`
(`opportunitySnapshot.ts`). Follows the exact structural pattern of `MultiHorizonOutcomesPanel.tsx`
(loading/error/empty states via `AwaitingSignal`, no fabricated placeholder rows). Displays real
evidence classification, Wilson lower bound, the Part 7 forecast (expected return/probability of
profit, `NO_FORECAST` when absent, the real status string — e.g. `INSUFFICIENT_DATA` — when not
`VALID`), and the Part 9 diversity evidence (effective independent count/family count, rendering
the literal `UNKNOWN` when a forecast carries none). Verified via `tsc --noEmit` and a successful
Vite build; this codebase has no established React-component unit-test convention (CLAUDE.md's own
documented UI-test-coverage gap), so verification followed the same discipline other panels in this
codebase use — deployed and confirmed the backing API responds correctly live post-deploy; actual
browser rendering was not visually confirmed in this session (no browser available), an honestly
flagged residual gap for the next session with browser access.

## Master Completion Ledger (2026-09-13)

A permanent, continuously-updated per-part status ledger for the 32-part "ARGUS MASTER
TRANSFORMATION MANDATE" now lives at [`docs/ARGUS_MASTER_COMPLETION_LEDGER.md`](../ARGUS_MASTER_COMPLETION_LEDGER.md)
— a status-tracking document, not a second architecture reference (this file remains the one
living architecture doc per CLAUDE.md). It records, per mandate part: status (from a fixed
vocabulary — `COMPLETE_AND_VERIFIED` through `NOT_IMPLEMENTED`/`BLOCKED_BY_*`), what exists, what's
runtime-wired, what's frontend-wired, what's tested, real production/paper evidence, blockers,
dependencies, and next action. Initial pass (this date) found: Parts 18 (RiskEngine) and the
process-level Parts 0/31 fully verified; Part 12 (intraday event loop) and Part 22 (missed
opportunity taxonomy) proven at current scale but unproven at the mandate's target scale; the
majority of parts partially implemented with real, named gaps; Part 6 (strategy diversity) scaffolded
on an assumed rather than measured correlation matrix; Parts 7 (forecast engine) and 10 (portfolio
construction) genuinely not implemented and correctly gated behind upstream evidence; Part 23
(paper validation) blocked purely by calendar time. Also documents one deliberately deferred
finding: `ChiefTraderAgent.ts`'s own debate prompt interpolates `idea.reasoning` (potentially
LLM-originated free text) with no delimiter isolation of the kind DEF-31 added to
`NewsScoringEngine.ts` — not fixed yet because any change to that prompt's wording risks shifting
`ConsensusDebate`'s response distribution while Part 1's forensic telemetry is still accumulating
clean evidence.

## Heap-snapshot capture — P1 memory-leak investigation (2026-09-14)

Real, live-observed incident: durable memory telemetry (`processTelemetry.ts`'s 5-minute
`sampleAndPersistMemoryTelemetry()`, persisted to `observability_events` as
`MEMORY_TELEMETRY_SAMPLE`) showed sustained, approximately linear RSS growth over a 112-minute
session — 788.5MB → 4,014.9MB (~28.9MB/min, ~1.7GB/hour), with `heapUsed` tracking `rss` closely
(473.2MB → 3,657.8MB) — a real JS-heap object-retention signature, not a native/socket leak or a
one-off spike. `MemoryTelemetryGuard` correctly paused trading (`TRADING_PAUSED`, existing
mechanism, no second kill switch) at the configured CRITICAL threshold (3,584MB RSS). A controlled
restart reduced RSS to 804.9MB; the retaining allocation was not identified by static code review
(`ChiefTraderAgent.ts`'s per-symbol Maps, `AIRouter.ts`'s provider Maps, `QuantCoreBridge.ts`'s
capped price/volume history, `MarketDataWorker.ts`'s per-symbol Maps — all checked, all properly
bounded).

`src/server/observability/heapSnapshotCapture.ts` (explicit operator authorization, scoped exactly
as specified): one baseline snapshot `heapSnapshotBaselineDelayMs` after boot, one snapshot at the
first WARNING/CRITICAL memory-telemetry crossing, one optional follow-up if still elevated after
`heapSnapshotFollowUpDelayMs`, a hard `heapSnapshotMaxPerProcessLifetime` cap (default 3) and
`heapSnapshotCooldownMs` gate regardless of how many times the level flaps, disk-bounded (oldest
`.heapsnapshot` files pruned before writing a new one, by both file count and total size). All
thresholds in `config/observability.json`, none hardcoded (this file's own standing rule). Wired
into the EXISTING `processTelemetry.ts` memory-sample interval — no new `setInterval` worker, so no
new `gracefulShutdown.ts` stop-order entry was needed; the one-shot baseline timer is `unref()`'d
and cleared via `stopHeapSnapshotScheduler()` (called from the existing `stopProcessTelemetry()`).

**Never gates or delays `applyMemoryCriticalFailSafe()`'s own `TRADING_PAUSED` intervention** —
called strictly after it in `sampleAndPersistMemoryTelemetry()`, and is otherwise fully
independent: it never imports or touches `tradingEngine`/`RiskEngine`/OMS. **Honesty, not a claim
this is free**: `v8.writeHeapSnapshot()` performs a real, synchronous V8 heap walk — it blocks the
event loop for its duration (inherent to how V8 produces a consistent snapshot, not an
implementation choice this module could avoid). This is an infrequent (capped, cooldown-gated),
*measured* (every capture's wall-clock duration is logged via `HEAP_SNAPSHOT_CAPTURED`/
`HEAP_SNAPSHOT_FAILED`) pause, never a non-blocking one. Fail-open throughout: a capture failure is
logged, never thrown, never crashes the process. Test-isolated the same way as
`ARGUS_TEST_ALLOW_CHRONOS`/`OLLAMA`/`OPENALICE` (`vitest.setup.ts`): disabled by default in tests
via `ARGUS_DISABLE_HEAP_SNAPSHOTS`, so an unrelated test that happens to drive a fake
WARNING/CRITICAL memory sample doesn't write a real file (confirmed live during this same change —
it did, a real ~500ms/13MB capture, before the guard was added). Root cause of the underlying leak
remains **UNKNOWN** — this closes the "what tool finds it" gap, not the leak itself.

**A second, distinct P1 (call it P1-B, tracked separately from the still-unresolved P1-A memory-leak
root cause above) — CONFIRMED, not suspected: this same mechanism froze the trading process and it
was externally killed.** The first live WARNING-level capture (pid 27000, 2026-09-14T20:17:52Z) was
followed by the engine's event loop going unresponsive for ~6 minutes (external watchdog: heartbeat
staleness climbing continuously from 20:18:28Z, `FROZEN_CONFIRMED` + force-kill at 20:24:10Z,
restart, then this codebase's own new restart-safety guard — see below — correctly forced
`TRADING_PAUSED`). The process being killed by the external watchdog is a directly observed fact.

**Likely mechanism** (well-supported by timing plus a 2.04GB completed output file plus the missing
completion log, but not proven to the precision of an exact duration-vs-size formula):
`v8.writeHeapSnapshot()` is a real, synchronous, unavoidably-blocking V8 heap walk; serializing
~2.04GB is consistent with a multi-minute block, consistent with the observed freeze window. Do not
claim more precision than this — "the snapshot caused the freeze" is reasonable given the timing;
"2.04GB takes exactly N minutes" is not established.

**The baseline measurements do not license the conclusion "baseline capture is safe."** 8.8–11.8s
at ~600MB on two occasions shows baseline capture was safe under that specific, low, tested
condition — not that it is intrinsically or generally event-loop-safe at arbitrary heap sizes. Two
low-memory data points do not extrapolate to a multi-GB heap. Elevated-level (WARNING/CRITICAL-
triggered) capture is disabled (`heapSnapshotEnabled=false`); baseline-only capture remains enabled
as a narrowly-scoped exception proven only at the condition actually tested, not a general safety
claim about the mechanism.

**The eventual redesign is not "make the same call async."** `v8.writeHeapSnapshot()` blocks the
calling thread's own event loop regardless of how the call is scheduled (`Promise`, `setImmediate`,
same-process wrapper) — none of that changes what the call itself does. A `worker_thread` has its
own separate V8 heap; it cannot snapshot the *main* thread's heap just by being asked from within
the same process. A real fix requires the trading-critical process to never be the one whose heap
gets synchronously walked — genuine process-level separation between the trading-critical process
and any research/forensic process that needs deep heap introspection, matching the general rule this
incident establishes: **a trading-critical process may not run any operation that synchronously
blocks its event loop for an unbounded or poorly-characterized duration; expensive
diagnostics/analytics belong in a separate research/forensic process, not inside the trading
process itself.**

Both completed files (`data/heap-snapshots/`, gitignored) are preserved as genuine forensic evidence
for a future proper offline analysis (e.g. Chrome DevTools' heap-snapshot comparison) — disk usage
from these should be monitored, not left unbounded. See `config/observability.json`'s own comment
for the full incident record.

## Overnight safety-first remediation (2026-09-14, second pass) — P1-A investigation + a second real event-loop blocker found

Real, bounded, O(1)-memory offline analysis of the preserved 2.04GB incident snapshot
(`scripts/forensic/analyze_heap_snapshot.mjs`/`sample_heap_snapshot_strings.mjs` — new, permanent,
OFFLINE-FORENSIC-classified tooling; runs only against `.heapsnapshot` files on disk, never
imported by the application, never runs inside the trading process). Verified live under a hard
`--max-old-space-size=512` cap, completed in ~11s: **30,377,433 nodes, 92,056,473 edges**. `string`
nodes dominate — 18,271,808 of them, 59.5% of total self_size. A bounded content sample shows the
dominant recurring shape is `trace_<SYMBOL>_<epochMs>_<hash>` — exactly `generateTraceId()`'s
format — interleaved with ISO-8601 timestamps, UUIDs, and full agent-reasoning text blobs. The
leading hypothesis this pointed at, `EventStore.ts`'s in-memory ring (`recentEvents`/`tradeTraces`,
described elsewhere in this document as "capped"), was checked directly and **ruled out by
evidence**: `eventStoreMaxRecentEvents: 200` and `eventStoreMaxTraces: 500` are both small and
correctly enforced (verified by reading the real eviction logic) — far too small to explain 18M+
retained strings. **The actual retaining owner remains unidentified** — this specific finding
requires either a full retainer/dominator-path analysis (needs the 92M-edge array cross-referenced
against nodes, a substantially larger undertaking than safely completable on a 16GB host with only
~5GB free RAM alongside the live engine) or a live, isolated reproduction harness. See
`docs/audits/ARGUS_MASTER_REMEDIATION_BASELINE.md`'s "Overnight Safety-First Remediation" section
for the full evidence matrix.

**A second, real, previously-undiscovered event-loop blocker was found and fixed in the same pass**:
`DbBackupService.ts` performed a synchronous `fs.copyFileSync()` of the entire live database file
(measured at **4.08GB** during this same audit) — and did so on **every engine boot**, not only on
its documented 24-hour interval (`start()` calls `runBackup()` immediately). This is the same risk
class as the P1-B heap-snapshot incident, and had been firing on every restart throughout this
entire session. Unlike `v8.writeHeapSnapshot()`, `fs.copyFile`'s async form is a genuine fix (real
libuv-threadpool I/O, not a synchronous call hidden behind a `Promise`) — converted, with the
existing `DbBackupService.test.ts` updated to `await` the now-async `runBackup()`. The
`sqliteDb.pragma('wal_checkpoint(TRUNCATE)')` call in the same function remains genuinely
synchronous (better-sqlite3 has no async API) — a smaller, harder-to-eliminate residual risk,
honestly left as-is, not silently ignored.

## Synthetic Market Session Simulator (`src/server/replay/synthetic/`, 2026-09-14 mandate) — isolation hardening + certification findings

An isolated harness (OFFLINE-FORENSIC classification, same posture as `scripts/forensic/`) that
feeds a deterministic synthetic market session through the REAL production decision pipeline
(`eventBus.emitMarketData()` → real TechnicalAgent/KronosForecastAgent/QuantSignalAgent → real
ChiefTraderAgent → real RiskEngine → real OMS → an isolated `HistoricalReplayBroker`, installed via
the same `ActiveReplaySession`/`setActiveReplaySession()` seam `src/server/replay/`'s Historical
Evaluation (MODE B) already uses) to answer "if the market were opening right now, how would Argus
actually behave?" — never a special simulation-only decision path. Core files:
`SyntheticSessionEngine.ts` (orchestrator), `SyntheticMarketClock.ts` (real-time-accelerated clock,
extends `ReplayClock`), `SyntheticMarketDataEngine.ts`/`SyntheticScenario.ts` (deterministic seeded
price-path generator + named scenario profiles), `CertificationGate.ts` (the mandatory post-change
certification described below), `DecisionTimeline.ts` (real-EventBus-sourced behavioral log). CLI:
`npm run sim:market-open -- --scenario=<id> | --certify`.

**Isolation architecture (Step 1, post-incident hardening).** A real production-database pollution
incident occurred during initial smoke-testing (a top-level, non-dynamic import transitively opened
`src/server/db/index.ts` before the harness's own isolation env vars were set — fixed, and detailed
in this doc's own commit history / `docs/audits/`). The durable fix is two-layered: (1)
`src/server/db/syntheticSimulationDbGuard.ts`'s `assertSyntheticSimulationNotOpeningProductionDb()`
is a pure, independently unit-tested function called from `db/index.ts` itself, immediately before
`new Database(dbPath)` — it throws FATAL if `SYNTHETIC_SIMULATION=true` and the resolved DB path
equals the resolved production path, so a future import-ordering mistake fails LOUDLY before any
connection opens, rather than being merely detected afterward. (2) `scripts/sim/marketOpen.ts` is a
thin PARENT process with **zero Argus-module imports** — it computes the isolated DB path (via the
pure `src/server/replay/syntheticSimulationPaths.ts`, shared with `SyntheticSessionEngine` so the
two processes can never disagree on the formula) and spawns a CHILD Node process
(`scripts/sim/marketOpenChild.ts`) with every isolation env var (`SYNTHETIC_SIMULATION`,
`ARGUS_DB_PATH`, `PAPER_TRADING_ONLY`, …) set via `child_process.spawn`'s `env` option AT SPAWN TIME
— i.e. before the child's own module graph, including its first import statement, ever executes.
This closes the import-ordering bug class structurally rather than by convention: even a
hypothetical future static top-level import of a db-touching module in the child would still see the
correct isolated `ARGUS_DB_PATH` already in `process.env`.

**Two further real root causes found and fixed while validating the certification (Step 2).** Both
are instances of the same underlying mechanism: `EncryptionService.ts` calls `dotenv.config()` as a
module-load side effect, and since `dotenv` only fills environment keys that are not already set,
any isolation env var the harness had not explicitly forced leaked in from this deployment's real
`.env`. (1) `ARGUS_OPPORTUNITY_LOOP_ENABLED`/`ARGUS_BROAD_UNIVERSE_ENABLED`/`ARGUS_MARKET_MOVERS_ENABLED`
are all `true` in this deployment's real `.env`, so `bootArgusCore()`'s unconditional
`opportunityDiscoveryWorker.start()` ran a REAL Alpaca discovery scan within moments of boot inside
what was meant to be a fully isolated, deterministic, no-real-network-dependency session — and its
real `subscribe()` calls competed with (and evicted) the synthetic session's own symbols from
`MarketDataWorker.activeStreams`, since `cacheObservedQuote()` (the method the harness feeds
synthetic prices through) deliberately never increments `tickCounts`/`dynamicMomentumScores`,
making every synthetic symbol look permanently "cold" to the real eviction ranking. Fixed by forcing
all three flags `false` in the isolated environment (both in the child's spawn-time `env` and inside
`prepareIsolatedEnvironment()`, matching the same "an isolated simulation must never depend on real
external market data" principle already applied to FundamentalAgent/MacroAgent/NewsEngine's own real
network calls) — this is NOT reproducible in live production, where every genuinely live-streamed
symbol's activity bookkeeping is real. (2) A second, larger effect of the same leak:
`ARGUS_ACTIVE_BROKER=ibkr_gateway` (this deployment's real active broker) caused
`BrokerManager.resolveBootBrokerSelection()` to select IBKR Gateway for the isolated session too
(since its own fresh, isolated `settings` row has no persisted `selectedBroker`), which made
`MarketDataWorker.subscribe()` route through its `ibkr_gateway` branch — and since no real IB
Gateway process is reachable from an isolated simulation, every subscribe call threw and, in its own
catch block, immediately deleted the symbol it had just added. `QuantSignalAgent.getActiveSymbols()`
was therefore permanently empty for the entire duration of every certification run to date, and
QuantSignalAgent never evaluated a single symbol. Fixed by forcing `ARGUS_ACTIVE_BROKER=internal_paper`
in the isolated environment — safe because order placement is already, separately, unconditionally
redirected to the session's own `HistoricalReplayBroker` via `ActiveReplaySession`; this only affects
`MarketDataWorker`'s internal quote-backend bookkeeping. Both fixes were verified empirically (zero
"no actively-tracked symbols" cycles, real `MOMENTUM_BREAKOUT`/`TREND_FOLLOWING` strategy
evaluations, and continuous per-bar `MARKET_DATA` coverage for every universe symbol across a full
240-bar session) and left the production database provably untouched (`settings` row count and
`ohlcv_bars` synthetic-row count re-verified at 1 and 0 respectively after every run).

**A real latent clock race was also found and fixed** while validating a longer (240-bar) session:
`SyntheticMarketClock` is always constructed with `speedMultiplier: 1`, and a separate `reset()` call
placed BEFORE the main loop left a small but real window in which further setup work could elapse
enough real wall-clock time for the clock's own 1:1 auto-drift to carry `now()` past the session's
first bar timestamp — so that bar's own `advance()` call (routed through `setTime()`'s
backward-move guard) would then throw. Fixed by moving the `reset()` call to the loop's own first
iteration (`i === 0`), closing the gap entirely instead of narrowing it.

**Certification result (Step 3/4) — `VALIDATED_CONVERGENCE_CONTROL` scenario.** A single, narrowly-
purposed scenario (not one of the mandate's 15 named scenarios) engineered for genuine multi-agent
convergence — an opening structural breakout (gap + volume/volatility pop) followed by a long
(240-bar, enough for `TREND_FOLLOWING`'s own SMA200-ordering condition to actually be evaluable),
low-noise, volume-confirmed uptrend — run with **zero changes** to `minIndependentAgreeingAgents`,
`consensusApprovalThreshold`, or any calibration logic. Test A (`QUIET_OPEN`): **PASS**,
`zeroTradeReason=NO_CONSENSUS`. Test B: **FAIL**, blocked at `CONSENSUS`, but with a materially
different and more valuable diagnostic than the scenario this superseded (`TRENDING_BULL_GAP_AND_GO`,
which failed on raw confidence/independence alone): two genuinely independent real agents
(`JavaCoreEnsemble`'s CORE-strategy ensemble and `KronosForecastAgent`'s Chronos forecast) agreed on
SPY (both SELL, ~65% combined confidence), clearing `minIndependentAgreeingAgents` and reaching
MODERATE-tier consideration — and were then correctly rejected by `MODERATE_REJECT_UNTRUSTED_CALIBRATION`
(`src/server/continuous/ModerateTierEvaluator.ts`): neither agent has a statistically-validated
calibration champion for its confidence bucket, because a fresh, from-scratch isolated database has
zero historical graded predictions to validate one from. Per that evaluator's own test suite, this is
"the honest real-data default" for any brand-new deployment or isolated session, not a bug. This
means a single-session, from-scratch synthetic simulation may be structurally unable to ever clear
MODERATE-tier calibration trust regardless of scenario quality — a genuine architecture/research
finding (not a defect to route around), left exactly as the operator mandate required: the system was
not modified to force a pass.

**Correction + follow-up (2026-09-15, Rule 5 diagnostic pass) — supersedes the paragraph above.**
The "two genuinely independent real agents... agreed on SPY" claim above silently included
`CalibrationHistorySeeder`'s 25 synthetic seed rows (symbol `SEEDCAL`) in its counts, and separately,
the simulator was found to never start the two real backing services (`KronosForecastAgent`'s local
Chronos on `:8008`, `JavaCoreEnsembleVoteService`'s Java Quant Core HTTP server on `:8085`) that
`KronosEngine`/`JavaCoreEnsemble` need to produce a REAL prediction — both agents were correctly,
honestly failing closed (`KRONOS_UNAVAILABLE`; zero `QUANT_CORE_STRATEGY_PARITY_DIVERGENCE` events),
not disagreeing on timing. After manually starting both real services and re-running Test B (same
seed/scenario), genuine three-independent-family data became available for the first time: real,
repeated, contemporaneous (~1-second co-occurrence) convergence WAS found —
`JavaCoreEnsemble`+`TechnicalAgent` on SPY SELL, `KronosEngine`+`TechnicalAgent` on QQQ SELL, dozens
of times, `MODERATE_TIER_EVALUATED` events confirming `independentAgentCount: 2` with both real
agent names listed. The system still correctly declines to trade — not because no shared view
exists, but because (1) the weighted STRONG-tier confidence tops out near 0.65-0.66, short of 0.75
(traced to `config/agentWeights.json`'s `unlistedAgentWeight: 1.0` outweighting `TechnicalAgent`'s
listed `0.25`, combined with `JavaCoreEnsemble`'s own confidence staying a flat, unvarying 0.65 for
the entire 240-minute session - flagged as a real, separate, not-yet-investigated candidate finding)
and (2) MODERATE-tier's calibration-trust gate correctly refuses every case because this pass's
operator-authorized calibration seeding covered only `JavaCoreEnsemble`/`KronosEngine`, never
`TechnicalAgent` - the calibration system working exactly as designed, not a defect. This is a
materially different and more precise finding than "different reaction horizons" - contemporaneous
multi-agent consensus is empirically confirmed to work; the blockers are two already-documented,
intentional safety gates operating correctly on real data. See
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_2026-09-15.md`'s "Rule 5 follow-up" section for the full
evidence trace. Open, not yet fixed: the simulator does not yet start Chronos/Java Quant Core itself
(a real completeness gap, distinct from and in addition to the determinism fix below).

**End-to-end determinism fix (2026-09-15 follow-up).** A same-seed QUIET_OPEN run executed twice
showed identical seeded-price-path output (`ohlcv_bars`, TechnicalAgent analysis-cycle count) but
different `news_clusters`/agent-prediction counts — root cause: the real `NewsEngine` (live RSS +
paid news APIs + LLM) and real `FundamentalAgent`/`MacroAgent` (AlphaVantage + AIRouter) run on
their own real-time schedules from `ArgusCoreBoot`/`SystemBootstrap` regardless of the harness's own
deterministic `SyntheticNewsGenerator` provider (which only ever covered gate 14's read, never
stopped the separate real background loop). Fixed via a new `ARGUS_NEWS_ENGINE_ENABLED` flag gating
**both** of `newsEngine.start()`'s two independent call sites (`ArgusCoreBoot.ts` and
`SystemBootstrap.ts` — the harness's first fix pass found only the first, and a same-seed re-check
caught the second still firing), forced `'false'` only inside `prepareIsolatedEnvironment()`
(zero behavior change for any real deployment), plus an explicit in-process
`setPipelineAgentEnabled('FundamentalAgent'/'MacroAgent', false)` in `SyntheticSessionEngine.run()`
(no synthetic/deterministic equivalent exists for a real AI-provider call, so the honest fix is to
not run them in a synthetic session rather than fabricate one). Verified via two same-seed QUIET_OPEN
reruns: `news_clusters` and non-TechnicalAgent predictions are now identically zero across both runs
(previously 86 vs 76, and 12 vs 13 respectively). A smaller, separate, honestly-disclosed residual
remains — TechnicalAgent's own idea count still differed by one (10 vs 11) between the two otherwise-
identical runs, with a real-time-dependent `MarketDataWorker.requestTemporaryDataRescue` timing
interaction as the leading unconfirmed candidate — left open for a future pass rather than patched
without a confirmed root cause. See `docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_2026-09-15.md`'s own
"Determinism fix" section for the full before/after evidence table.

**Certification gate strengthening (2026-10-04).** `CertificationGate.ts` previously only
*counted* timeline events, which cannot catch ordering defects (a full-looking lifecycle with a
bypassed gate still counts the same). New `TimelineInvariants.ts` (pure, unit-tested) reads causal
ordering off the real pipeline's own timeline, linked by `traceId` (enforced by
`EventBus.assertTraceId`): `RISK_BYPASS` (order without a prior approved risk assessment),
`PHANTOM_FILL` (fill without a submitted order — the class that previously escaped into
historical replay), `CONSENSUS_BYPASS` (chief approval without a debate), `ORDER_DURING_OUTAGE`
(order inside a scenario-derived feed-outage window), plus `UNLINKED_ORDER` (warn-only). Any
FAIL-severity violation fails certification unconditionally, in both test shapes. Two further
gate fixes in the same pass: Test A (`QUIET_OPEN`) previously passed *unconditionally* — even
with zero `MARKET_DATA` ticks (a dead simulator read as a safety proof); it now FAILs when no
market data was recorded. And `POSITION_CLOSED` was inferred from `realizedPnl !== 0`, which
missed closes at exactly breakeven; a SELL fill causally after a BUY fill for the same symbol is
now independent evidence of a completed round-trip. CLI: `--certify --seeds=N` runs each test on
N consecutive seeds, all of which must pass (a deterministic simulator that only passes on one
seed proves nothing). 20 new unit tests (`TimelineInvariants.test.ts`,
`CertificationGate.test.ts`); the gate itself previously had zero. This strengthens defect
detection only — no threshold, gate, consensus, or calibration logic was touched.

## Post-audit critical remediation (2026-09-15)

Full detail: `docs/audits/ARGUS_COMPLETE_IMPLEMENTATION_AUDIT_2026-09-14.md` (the forensic audit) and
`docs/audits/ARGUS_REMAINING_WORK_CLOSURE_2026-09-15.md` (this pass's closure report). Two real,
previously-unreported live-path defects were found and fixed: (1) `PortfolioReconciliation.ts` did
not pause trading on an unknown/failed broker sync state (`broker.portfolio()` throwing) — only a
confirmed, measured position mismatch did; fixed by reusing FD-7's own consecutive-cycle debounce,
escalating to a real `TRADING_PAUSED` (verified to block new orders at RiskEngine's `emergency_stop`
gate) after 2 consecutive failures, with a new `RECONCILIATION_SYNC_FAILED` event. (2) `RiskEngine.ts`
fetched the entire `trades` table, unfiltered, on every live risk evaluation for gates 3/4/5 (same
unbounded-query class P1-A already fixed elsewhere, left open here) — fixed with a semantics-
preserving bound (`getTradingDayStartMs()`, new in `TradingCalendar.ts`) rather than an arbitrary
LIMIT. Also fixed: three unguarded periodic timers (`MarketDataCrossChecker`, `AIProviderHealthCheck`,
`CalibrationValidationWorker`) now use the same `createSingleFlightGuard` primitive every other
periodic worker already uses; a stale `config/observability.json` comment overstating baseline heap-
snapshot capture's current safety; explicit calibration-seeding provenance fields
(`CertificationResult.calibrationProvenance`) on the Synthetic Market Session Simulator's
certification contract; and a real structural bug in the `VALIDATED_CONVERGENCE_CONTROL` scenario
(volatility too low relative to drift, pinning RSI at 85-97 and causing agents to correctly read an
over-extended monotonic ramp as a SELL/mean-reversion setup) — fixed, though genuine same-symbol
same-side 2-agent convergence remains an open, now well-diagnosed research finding, not forced.
Full suite: 507 files / 3748 tests passing after this pass, zero regressions.

## Test/production runtime-file isolation guard (2026-09-15, P1 - same day, later pass)

**Real incident, not hypothetical.** Running the full test suite while today's real paper-trading
engine was live produced a genuine `UNCLEAN_SHUTDOWN_DETECTED` log line naming that exact live PID -
`sessionRecovery.ts`'s default session-marker path (`data/.argus_runtime_session.json`) is the
identical file the live engine's own 15-second heartbeat writes to, and two test files
(`ArgusRuntime.test.ts`, `ArgusEngineRuntime.test.ts`) booted the real core without isolating it.
This is the SECOND occurrence of this exact incident shape - `enginePid.ts`'s own header already
documented a first one (2026-08-25, `data/.argus_engine.pid`), "fixed" both times by an opt-in
`*PathForTests()`/`*_PATH` override a caller has to remember to set. Two incidents of the identical
shape is a pattern, not a coincidence, and the fix belongs at the mechanism level.

**`src/server/core/productionRuntimePathGuard.ts`** (+ `.test.ts`, `.integration.test.ts`) - a
shared, fail-LOUD mechanical backstop, the session/PID-file equivalent of
`syntheticSimulationDbGuard.ts`'s existing DB-side guard. `assertNotProductionRuntimePath()` throws
immediately whenever a process running under test/simulation conditions (`VITEST=true`,
`NODE_ENV=test`, or `SYNTHETIC_SIMULATION=true`) resolves a runtime-identity file path to the exact
real production path - called at the actual I/O call sites in `sessionRecovery.ts` (`read()`/
`write()`) and `enginePid.ts` (`resolveEnginePidPath()`, the single choke point every read/write/
clear call already goes through), not merely documented as a convention. Verified via a real,
mocked-fs integration test that a call with no isolation override throws AND performs zero real
writes, while a properly-isolated call succeeds normally. `scripts/argusWatchdog.ts` separately
gained the same `isMainModule` guard `argus-cli.ts` already had (it previously called `main()`
unconditionally at module load - a latent, not-yet-triggered risk, since no test currently imports
it, but the identical shape of gap) plus a defense-in-depth path-guard call on its own heartbeat
write.

**Re-running the full suite with the guard active found, and safely surfaced, exactly the same two
real test files** - this time as fast, informative, zero-production-impact test failures naming the
resolved path, instead of a silent file touch. Both fixed with the same `setSessionRecoveryPathForTests()`
pattern `ArgusCoreBoot.test.ts` already established. Full suite re-certified clean after the fix -
see `docs/audits/ARGUS_CALIBRATION_METHOD_COMPARISON_2026-09-15.md`'s "Process note" section for the
original incident's own real-time verification (live PID/heartbeat/trading-state all confirmed
unaffected throughout).


## September 19, 2026 correctness update: recovery, valuation and evidence

Implemented source behavior (runtime deployment is separately recorded in `docs/audits/ARGUS_ZERO_TRADE_2026-09-18.md`):

- `IbkrSocketSession` keeps bounded desired symbol ownership across socket generations, restores subscriptions once on authenticated managed-account receipt, and uses the existing IBApi scheduler. Request-ID tick routing remains generation-specific. Cancellation while disconnected removes ownership; explicit adapter teardown clears intent and stops reconnect. `BrokerManager` notifies `MarketDataWorker` when a replacement request has actually been issued, invalidating prior generation quotes/errors. The maximum line count and SDK pacing are unchanged.
- `ArgusRuntime.brokerReadiness()` checks broker synchronization, connection authentication where available, and bounded adapter health. `TradingReadinessGate` consumes that diagnostic without importing another broker authority. This does not turn cached reconciliation into fresh broker evidence or bypass reconciliation gates.
- Existing Node-owned `PositionSizing` values relevant BUY holdings at their own fresh, sourced marks. RiskEngine supplies feed/replay-cache marks; BacktestEngine supplies the most recent bar visible to its synthetic clock. PIT risk forwards provenance. Missing or stale required marks prevent increased exposure. SELL exits retain existing risk and held-quantity constraints. Replay cache age is not proof of underlying bar age.
- `executionQuality` partitions persisted evidence before query limits: organic paper needs affirmative consensus attribution and a recognized broker; manual, unattributed paper, replay, simulation, backtest, live and unknown remain separate. Explicit outer SQL column qualification protects correlated attribution subqueries. OMS environment stamping recognizes `ibkr_gateway` and `ibkr_web`; it does not retroactively relabel history.
- Forecast contract `forecast-v2-gross-only-2026-09-19` reports Java gross-return statistics where available. Measured organic-paper arrival-to-fill slippage is provenance, not commissions/financing/total cost. Total cost, net expected return and probability of profit remain null. Migration 0070 makes cost nullable and preserves every historical row/index transactionally. Read views suppress unsupported legacy cost-derived fields while preserving their stored provenance. Existing historical probability examples above describe older outputs, not currently justified profit probabilities.

The next economic validation requires measured total USD costs, environment-separated strategy attribution, out-of-sample and robustness evidence, and a supervised paper lifecycle only when legitimate approval occurs. Passing software tests does not establish positive net expectancy.

## ARGUS Crypto V2 — BTC/ETH Research Engine & Synthetic Population Simulator (2026-09-21)

Two related but independently-scoped pieces of work, both additive, both `RESEARCH` status, neither wired into the live spine (ChiefTraderAgent/RiskEngine/OMS/BrokerManager) or into `data/argus.db`. The running production engine (PID unchanged throughout, `TRADING_ENABLED`/PAPER/`LIVE_NO_GO`/`consistent:true` verified before, during, and after this work) was never restarted, never had its database touched, and never picked up any of this code — nothing in the live spine imports either module tree, enforced by dedicated static architecture-boundary tests (`src/server/crypto/cryptoArchitectureBoundary.test.ts`, `src/server/crypto/synthetic/syntheticCryptoArchitectureBoundary.test.ts`).

### Part A — Tan (2025) BTC baseline reproduction + adaptive research extensions

Source: Tan, K. H. (2025), "Optimal Bitcoin Trading Strategy Development Using Quantitative Models for the Current Market Regime." Treated as a baseline specification to reproduce faithfully, not as proof the proposed strategies work — the thesis itself reports its volatility-adjusted momentum baseline traded only ~1.5 round trips and did not beat Buy-and-Hold on Sharpe, and its Bollinger mean-reversion baseline generated zero trades.

Implemented in `quant-core-java/institutional/models/` per CLAUDE.md's Java 26 Engine Authority rule (all new quant/strategy calculation goes to Java):

| Class | Role |
|---|---|
| `CryptoLogReturns` | Canonical `ln(P_t/P_{t-1})` log-return + rolling annualized-volatility primitives — genuinely distinct from `StatisticsMath.rollingReturns()`'s simple-return formula, not a duplicate |
| `CryptoBollingerBands` | SMA ± caller-supplied-multiplier bands — distinct from the fixed-2.0-multiplier live `Bollinger.java`, needed for the multiplier sweep research |
| `BtcTan2025VolAdjustedMomentumStrategy` / `BtcTan2025BollingerMeanReversionStrategy` | Faithful reproductions, fixed at the thesis's own exact parameters (30d/60d/80th-percentile; window=20/multiplier=2.0) |
| `BtcAdaptiveVolatilityMomentumStrategy` / `BtcAdaptiveBollingerMeanReversionStrategy` | Same computation, caller-supplied parameters — the baseline classes are thin wrappers delegating to these (single authoritative computation path per calculation, CLAUDE.md Java rule 7), never a second parallel implementation |
| `CryptoRegimeConditionalMomentumStrategy` | Gates a momentum LONG on `CryptoRegimeEngine` independently reading `TRENDING_BULL` — can only suppress a signal into FLAT, never invent one |
| `CryptoTransactionCostModel` | Tan's flat 0.1%/trade reproduced exactly, plus a separate fee+spread+slippage structure that must be populated with real evidence before use |
| `CryptoVolatilityScaledPositionSizing` / `CryptoAtrRiskNormalization` | `RESEARCH_ADVISORY_ONLY` sizing suggestions, same disclosed pattern as the existing `VolatilityTargetingEngine` — never callable from `PositionSizing.ts` |
| `WalkForwardValidator` / `CryptoBenchmarkComparison` | Chronological TRAIN/VALIDATE/OOS fold builder + causal per-bar evaluator (verified via truncation-equivalence: changing bars after index *i* never changes the decision at or before *i*); Buy-and-Hold benchmark, used only as a comparison point, never as a signal |

**Real HTTP wiring (2026-09-21):** all four BTC strategies plus `crypto_feature`/`crypto_regime` are now reachable via the existing generic dispatcher `POST /api/v1/institutional/strategy/{strategyId}/{symbol}` (`QuantCoreServer.java`'s `evaluateResearchStrategy()` switch, six new `case` branches) — a real, tested integration point, still zero live consumer (nothing in the Node live path calls these `strategyId`s). 21/21 tests pass in `QuantCoreServerResearchStrategyTest.java` (7 new). Evidence: full `quant-core-java` suite **862/862 tests, `BUILD SUCCESS`**, zero regressions.

**Not built:** ML forecasting (LSTM/N-BEATS/gradient boosting), real historical BTC OHLCV replay, real OOS/walk-forward results, real paper evidence, live-spine wiring (`emitTradeIdea`/ChiefTrader/RiskEngine/OMS) — none of this exists yet and none of it is claimed. No real multi-year BTC dataset is connected to this environment; fabricating OOS numbers against synthetic-only data would misrepresent evidence quality, so `WalkForwardValidator` ships as a verified mechanism only.

### Part B — Synthetic crypto population & market simulator (`src/server/crypto/synthetic/`)

A deterministic, seeded, heterogeneous synthetic crypto market generator, built to exercise Argus-shaped decision logic against thousands of materially different synthetic assets without depending on real market data or touching the live broker/database. Reuses the existing `SyntheticRandom` (mulberry32) PRNG from the equity Synthetic Market Session Simulator rather than a second PRNG implementation; is otherwise a separate engine (that simulator is single-RTH-session, 1-minute-bar, ~10-symbol equity-shaped — none of that fits a 24/7, thousands-of-asset, cross-correlated crypto population).

| Module | Role |
|---|---|
| `SyntheticCryptoAssetTypes.ts` | Type contracts — liquidity/volatility/correlation-cluster/behavioral-archetype taxonomy, `SYN`-prefixed symbols (mechanically distinct from any real ticker) |
| `SyntheticCryptoPopulationGenerator.ts` | Deterministic heterogeneous population generator; index 0/1 are always the `SYN-BTC-USD`/`SYN-ETH-USD` anchors |
| `SyntheticCryptoRegimeStateMachine.ts` | 7-regime Markov chain (TRENDING_BULL/BEAR, RANGE, VOLATILITY_EXPANSION/COMPRESSION, CRASH, RECOVERY) — verified row-stochastic and to exhibit real bar-to-bar persistence, not i.i.d. per-bar labeling |
| `SyntheticCryptoPriceProcess.ts` | Unifies regime drift/vol, BTC-factor loading, mean-reversion pull, and idiosyncratic noise into one causal generator — verified that high-beta assets measurably correlate more with the BTC factor than low-beta ones, and that RANDOM-archetype assets don't |
| `SyntheticOrderBook.ts` | Deterministic bid/ask/depth-by-level snapshots; spread widens and depth thins with volatility |
| `SyntheticSlippageModel.ts` | Square-root market-impact model as a function of order size, book depth, and liquidity condition (LIQUID/NORMAL/ILLIQUID/CRISIS) — not a single constant |
| `SyntheticFillEngine.ts` / `SyntheticCryptoBroker.ts` | Mechanically isolated order lifecycle (ACKNOWLEDGED → PARTIALLY_FILLED/FILLED/REJECTED/CANCELLED/UNKNOWN, clientOrderId idempotency, immutable arrival price, terminal-state no-ops) — imports nothing broker-related, so no code path here can reach a real broker |
| `SyntheticEventInjector.ts` | Deterministic fault injection (flash crash/pump, gap, vol/volume spike, stale quote, missing/duplicate/out-of-order bars) applied onto an already-generated bar series |
| `productionPollutionGuard.ts` | `assertSyntheticSymbol()`, `assertNotProductionDatabasePath()`, `assertSyntheticArtifactPath()` — fail-loudly guards, not silent redirects |
| `SyntheticExperimentRegistry.ts` | Isolated append-only JSON-lines registry under `data/argus-synthetic/experiments/` (gitignored) — deliberately not a second SQLite schema, to avoid any resemblance to the production DB driver pattern |
| `SyntheticMonteCarloRunner.ts` | Multi-seed distribution runner (median/p25/p75/best/worst), not a single-universe result |

**Safety, verified structurally, not just asserted:** a dedicated `syntheticCryptoArchitectureBoundary.test.ts` statically scans every file in this directory and fails the build if any of them import a broker adapter, `BrokerManager`, `RiskEngine`, `OrderManagement`, `ChiefTraderAgent`, the production DB module, or `MarketDataWorker`, call `.placeOrder(`/`.emitTradeIdea(`, or reference `CHIEF_APPROVED_IDEA`/`PAPER_TRADING_ONLY`/`LIVE_ARM` — plus a walk of the entire live-spine directory tree (`src/server/core`, `src/server/services`, `src/server/engines`, `src/server/risk`, `src/brokers`) proving nothing there imports this directory back.

**Real, measured evidence (`npx tsx scripts/crypto_sim_cli.ts fullsim`, this machine, 2026-09-21), not projected:**

| Assets | Bars/asset | Total bars generated | Wall-clock | Bars/sec | Heap delta |
|---|---|---|---|---|---|
| 100 | 1,000 | 95,062 | 37.9 ms | 2.51M | 3.7 MB |
| 1,000 | 1,000 | 940,763 | 223.8 ms | 4.20M | 2.4 MB |
| 5,000 | 1,000 | 4,692,742 | 1,288.8 ms | 3.64M | 13.2 MB |
| 10,000 | 1,000 | 9,375,725 | 1,830.2 ms | 5.12M | 6.9 MB |

Single-threaded, no worker pool required at this scale — pure in-memory generation is far cheaper than the mandate's own concern about unbounded concurrency anticipated (that concern applies to a full FeatureEngine→Strategy→QuantEngine→Consensus pipeline evaluation per asset, which this benchmark does **not** measure — see "Not built" below). A 100-seed Monte Carlo run (`--size=200 --bars=500`) completed in 38 ms and produced a real, wide return distribution (median −44%, p25 −75%, p75 +20%, best +477%, worst −94%) — an honest finding, not a hidden one: `DEFAULT_TRANSITION_MATRIX`'s regime parameters are a reviewed starting point, explicitly undocumented as calibrated against any real return distribution (see that file's own header comment), and this run shows they skew bearish/high-variance by default over an unconditioned ~500-bar walk starting from RANGE. Recorded to the isolated experiment registry as real evidence, not asserted from memory.

**Test evidence:** 110 vitest tests across 14 files, all green; `tsc --noEmit` clean repo-wide; `architecture.protection.test.ts` (repo-wide, 25 tests) unaffected.

**Not built (real backlog, not implied by anything above):** order-book/slippage/broker/fill-engine wiring into an actual end-to-end pipeline run (FeatureEngine → Strategy → QuantEngine → Consensus → Risk → OMS → SyntheticBroker) — each piece exists and is tested in isolation, but no test yet drives synthetic bars through that full chain; the full ~15-scenario adversarial suite (6 of the mandate's ~15 named scenarios have injector support today: flash crash/pump, gap, vol/volume spike, stale quote, missing/duplicate/out-of-order bars — liquidity-crisis/broker-disconnect/DB-slowdown/duplicate-event-storm scenarios are not yet composed into named test scenarios, though the underlying primitives like `SyntheticCryptoBroker.simulateDisconnect()` and `generateOneSidedBook()` exist); lookahead/property-based testing across the full pipeline (causality is verified per-module via truncation-equivalence, not yet as one cross-component property suite); a real memory/perf regression gate with stored baselines; CLI commands beyond the four built (`population`/`pricepath`/`fullsim`/`montecarlo`/`report`); any frontend surface; a database-backed (vs. file-based) experiment registry. None of these were silently skipped — they require either real design decisions (how does a synthetic order interact with a real `RiskEngine` call without RiskEngine believing it's a real broker equity?) or substantially more session time than was available, and attempting them superficially would produce exactly the kind of unproven, half-wired code this document exists to avoid claiming.

## Broker migration IBKR → Alpaca + real crypto live-data bridge + AI provider forensics (2026-09-21)

Follow-up to the same day's trade/no-trade forensic audit (which found 0/90 IBKR market-data subscriptions receiving data — an unresolved IBKR paper-account real-time entitlement gap, external, not an Argus defect). Operator-directed migration to Alpaca as the active paper broker/data provider, using the existing `POST /api/v1/brokers/active` runtime-switch mechanism (`BrokerManager.setActiveBroker()`) — no new broker abstraction added, IBKR (`ibkr_gateway`/`ibkr_web`) remains fully registered, just no longer active. `PAPER_TRADING_ONLY=true` enforces paper mode structurally inside `setActiveBroker()` regardless of what's requested.

**Result, measured, not asserted:** after a full graceful restart (a mid-session live switch alone left `marketDataConnected: false` for several minutes — the WebSocket genuinely needs a fresh process, confirming the restart step was necessary, not just convenient), `market-data-diagnostics` went from Allocated 90/Receiving 0/Error 90 (IBKR) to Allocated 12/Receiving 12/Fresh 12/Error 0 (Alpaca). The decision pipeline immediately started producing real activity: Ideas Generated 0→36, Consensus Rounds Started 0→22 in the first ~10 minutes. Bottleneck moved from MARKET DATA to CONSENSUS (0/23 evaluations reached 0.60 confidence that session) — a materially different, and materially more informative, failure mode. Full evidence, build/test results (549 files / 4,090 tests green, `tsc` clean, build succeeded), and the complete pre/post funnel comparison are in the session transcript; not duplicated here per this file's own rule against restating operational-state numbers that will drift.

### Follow-up investigation (same day, six items, operator-directed)

1. **AI provider health (0/10 → still mostly external).** Full per-provider forensic breakdown: 7 of 10 providers (Gemini, OpenRouter free+paid, OpenAI, Claude, Kimi) are genuine external billing/quota/credit exhaustion — not fixable by Argus code. LiteLLM Gateway (`http://localhost:4000`) is an optional, operator-run local proxy that simply isn't started here — "fetch failed" is the correct, expected error for an unstarted local service, not a bug. Mistral's `routingState: ACTIVE` despite 121 recent errors was investigated as a possible cooldown-classification bug and found to be **correct behavior**: the query happened to land ~6.5 minutes after Mistral's last failure, past the real 5-minute (`aiProviderUnreachableCooldownMs`) cooldown window — a cooldown that expires on schedule is the system working, not failing. Ollama showed a real 8.4% success rate / ~43s average latency against its 25s timeout, but this measurement window overlapped with this same session's own heavy concurrent Maven/vitest/tsc load on the same machine — reported as a real number with that confound stated explicitly, not treated as an established permanent defect (same discipline already applied to a watchdog-heartbeat observation earlier the same day).

   **Real, fixable defect found and fixed:** NVIDIA's configured `defaultModel` (`meta/llama-3.1-8b-instruct`) returns HTTP 410 Gone — genuinely retired by NVIDIA (confirmed against the real, live `/v1/models` catalog, which no longer lists it). Rather than guessing a replacement from training-data knowledge (explicitly rejected — `NvidiaProvider.ts`'s own header comment already documents why guessing a hardcoded model id is unsafe), the real catalog was queried live and multiple candidates were **empirically tested with real completions against this account's real entitlements** (several 200-in-catalog models 404'd as "not found for account" — the public catalog and this account's actual access are different things). `meta/llama-3.2-11b-vision-instruct` was confirmed working end-to-end and saved via the existing `POST /api/v1/config/providers` route, preserving the existing encrypted API key explicitly (that route nulls `apiKeyEncrypted` if no key is passed — a real landmine avoided by reading the key from `.env` in a script that never printed it). Takes effect on next restart (`AIRouter.initialize()` is boot-only, documented in that route's own response).

2. **Alpaca subscription cap (12 → 20).** The prior report's "Alpaca's default cap — maxActiveSubscriptions=12" was corrected on review: 12 is Argus's own `config/continuousIntelligence.json` value, not a documented Alpaca platform limit (Alpaca's real streaming-market-data docs state limits are "package-dependent" with no published number; a direct isolated-connection capacity test returned Alpaca error 406 "connection limit exceeded," which is a **one-connection-per-account** constraint, not a symbols-per-connection one, since the live engine already held the account's one connection). Raised to 20 — a modest, evidence-proportionate step (same discipline as the 2026-09-05 IBKR rescue-capacity 3→6 change), grounded in real `missed-opportunities` evidence: 8 genuine `SUBSCRIPTION_MISS` candidates in a 24h window (ranks 1–6, `finalScore` 0.65–0.73, including the #1-ranked candidate, AVGO) that never got a slot under the old cap. Verify via `market-data-diagnostics` after the next restart that all 20 report `RECEIVING_FRESH` with zero new errors before considering a further increase. Two test fixtures with hardcoded symbol-array sizes tied to the old cap (`MarketDataWorker.test.ts`) were resized; one test asserting the literal config value `12` as if it were a code invariant (`MomentumUniverseScanner.test.ts`) was removed as a pre-existing violation of "tests must derive expected values from the same config production loads," not merely patched to assert `20` instead.

3. **Confidence clustering below 0.60 — root-caused, not just observed.** Five different real symbols (TSLA, NVDA, MSFT, META, AMD) all showed the identical KronosEngine confidence to 3 decimal places moments after the restart. Verified empirically, not assumed: the local Chronos service itself was proven to vary its output correctly on different inputs (flat/volatile/trending synthetic series gave relativeSpread 0/0.096/0.027); real per-symbol 90-day Alpaca daily bars fed directly to Chronos for TSLA/NVDA/MSFT produced clearly different, non-matching spreads that would clamp to the confidence *floor* (0.3), not land at the observed 0.472 — ruling out a degenerate-data-source bug in the historical-bars fallback path (itself re-checked and confirmed correctly per-symbol after the migration's `registerHistoricalBarProvider(null)` cutover). Conclusion: the live evaluations were using the short, tick-buffered path (`kronosMinHistory`=30, comfortably reached within ~25 minutes of a fresh restart on liquid names), and a short, recent, comparably-quiet real window across correlated large-cap tech names can legitimately produce converged confidence readings this early post-restart — a genuine timing artifact of very recent restart, not a code defect. No code change made; the correct remedy is continued real elapsed operation time, consistent with not treating a short-window artifact as permanent.

4. **Vote independence/correlation.** KronosEngine (13/hour), TechnicalAgent (3), QuantEngine (2), OpportunityScreener (1) are structurally distinct code paths and data sources (confirmed by architecture, not just by label) - genuine independence in the sense ChiefTrader's `minIndependentAgreeingAgents` cares about. However, finding #3 above means KronosEngine's dominant vote share was, in this specific early-post-restart window, carrying materially less real per-symbol information than its raw confidence number implied - a real, evidence-based qualifier on how much weight "2-agent agreement" should be given in the hours immediately following a restart, not a claim that the independence *mechanism* is broken.

5. **Calibration fit.** The 2026-09-04 `kronosConfidenceSpreadMultiplier=25` recalibration was tuned against a 3,000-row real sample; finding #3 shows a fresh restart's first ~30 minutes is a structurally thinner, more converged sample than that calibration assumed. Flagged as a real scope caveat, not re-tuned from one session's anecdotal observation - re-calibrating a production constant needs the same kind of real, sufficient sample the original 2026-09-04 pass used, not a same-day reaction.

6. **Alpaca crypto — real market data wired, order placement deliberately stopped short.** Confirmed live: Alpaca's crypto API (`data.alpaca.markets/v1beta3/crypto/us`) returns real BTC/USD and ETH/USD quotes/bars using the *same* already-configured `ALPACA_API_KEY`/`ALPACA_SECRET_KEY` (no separate credential), and this paper account has `crypto_status: ACTIVE` with `BTC/USD` a real tradable, fractionable asset. Built `src/server/crypto/live/` (`AlpacaCryptoMarketData.ts`, `AlpacaCryptoResearchBridge.ts`): a real REST client plus a bridge into the REAL Java `crypto_feature`/`crypto_regime`/BTC-strategy endpoints built earlier the same session, reusing the *existing* `QuantCoreBridge.fetchResearchStrategy()` integration boundary rather than a new one. This surfaced a second real, independent bug: the JDK's built-in `HttpServer` decodes a URL-encoded slash (`%2F`) in the request path *before* `getPath()` returns it, so `crypto_feature/BTC%2FUSD` (exactly what `encodeURIComponent('BTC/USD')` produces) arrived as `.../crypto_feature/BTC/USD` and an unlimited `split("/")` turned it into 3 segments instead of 2, always failing with 400 — invisible until a symbol genuinely containing a slash was tried, since no equity ticker ever does. Fixed with `split("/", 2)` (limits splitting to the first slash after `strategyId`; the rest, slashes included, is the symbol) — a one-line, scope-limited fix confirmed with a real regression test reproducing the client's exact percent-encoding, full Java suite still green (863 tests) after the change. **Deliberately not built:** live crypto order placement. RiskEngine gate 21 / OMS order construction assume whole-share sizing (`Math.floor(dollars/price)`); Alpaca's real BTC/USD `min_order_size` is 0.000012 and the asset is explicitly fractional — whole-share math would floor every realistic paper order to 0 and fail closed, which is safe but not a real integration. Gate 12 (`market_hours`) is RTH-shaped; crypto trades 24/7. Per CLAUDE.md's protected-architecture rule ("if a requested feature appears to require modifying anything in [the protected list]: stop, explain the conflict"), this stops at real, verified, live market data reaching real Java research computation — genuinely wiring order placement needs fractional-sizing and 24/7-session decisions made deliberately, with tests, not smuggled in under a market-data client.

### Same-day operator review: disaggregated component health + flaky-test discipline (2026-09-21, later pass)

Two small, deliberately non-architectural follow-ups, both requiring only a future restart (whenever one next occurs for another reason) to take live effect — no restart was performed solely for these:

- **`GET /api/v2/runtime/component-health`** (`v2Runtime.ts`): the existing `/health` route blends AI-provider status into one process-level signal, which this session's own evidence showed is misleading — QuantEngine/RiskEngine/OMS/Alpaca connectivity all stayed genuinely fine while AI providers sat at 0/10 healthy. The new route reports 8 components (Market Data, QuantEngine, RiskEngine, OMS, Alpaca Paper, AI Providers, Crypto Research, Crypto Execution) each from already-computed real signals (`computeAiAvailability()`, `computeQuantAvailability()`, `BrokerManager`, the latest real `reconciliation_events` row) — no new health check invented, no per-request network call added. RiskEngine/OMS status is explicitly documented as "process-up + kill-switch-clear," not a deep self-test, since neither has an external connection to independently fail. Crypto Execution unconditionally reports `NOT_ENABLED` with the reason, matching item 6 above. 10 new tests (`v2Runtime.test.ts`), typecheck clean.

- **Flaky-test discipline, not silent pass.** `v2System.quantCore.test.ts`'s `GET /quant-core/catalog` describe block was observed failing a *different* one of its 5 tests on 3 consecutive isolated re-runs (one failure an explicit `Test timed out in 5000ms`, not an assertion mismatch) — root-caused to a thin default timeout margin under this session's own sustained concurrent Maven/vitest/tsc load, not a code defect in the route (config/engineOwnership.json is ~170 entries/~69KB, microseconds to parse; the dynamic imports the route uses are already warm by the second test in the file). Fixed by raising this block's timeout to 15s via `vi.setConfig()`, with a comment documenting the evidence and explicitly stating that a trip *even at 15s* would be real evidence of an actual regression, not just load — the point being to record `KNOWN_FLAKY` with its real cause, not to silently keep re-running until green.

## ARGUS Crypto Expansion — Phase 0 forensic audit + Phase 1 canonical instrument/validation/sizing (2026-09-21)

Distinct, larger-scoped follow-up to the same-day Crypto V2 work above (research engines / synthetic simulator / live data bridge) — that work built crypto-specific *capability*; this pass is about whether the *shared, equity-shaped core* (symbol validation, position sizing, RiskEngine gates) can represent a crypto instrument at all. Operator-authorized, phased mandate (Phase 0 audit, Phase 1 implementation below; explicitly **not** authorized beyond Phase 1 — no crypto market-data ingestion, no crypto session/day gates, no paper crypto broker, no strategy changes, no live/real-money execution in this pass).

**Phase 0 (forensic audit, no code changed):** found real, already-built, isolated crypto scaffolding (`CryptoSessionClock.ts`, `src/server/crypto/synthetic/`, `AlpacaCryptoMarketData.ts`/`AlpacaCryptoResearchBridge.ts`, the Java `Crypto*`/`Btc*` engines) that never touches the live spine — plus two structural blockers that would have stopped any of it from ever reaching a real (even paper) RiskEngine evaluation: `AIOutputValidator.ts`'s `looksLikeListedTicker()` (equity-only regex, 24 real callers, rejects every realistic crypto pair format) and `PositionSizing.ts`'s `Math.floor(dollars/price)` (hardcoded whole-share flooring, 4 call sites, shared by live RiskEngine and BacktestEngine). Full caller survey and severity table live in that audit's own report (not duplicated here); this section documents only what Phase 1 actually built in response.

**Phase 1 (implemented):**

- **`config/cryptoInstruments.json` + `src/server/config/cryptoInstruments.ts`** — the canonical crypto instrument registry. Registers exactly `BTC-USD` and `ETH-USD` (no broader universe yet — mandate explicitly scoped this to Phase 1). Each entry carries `baseAsset`/`quoteAsset`/`pricePrecision`/`quantityPrecision`/`quantityStep`/`minimumQuantity`/`minimumNotional`/`enabledForResearch`/`enabledForPaper`. Same loader pattern as `config/multiAsset.json` (missing required keys fail boot). Precision/step/minimum figures are reviewed defaults, explicitly labeled `UNCALIBRATED`/not vendor-verified in the config file's own comment — same honesty convention `multiAsset.json` already uses for its penny-stock thresholds.
- **Deliberately a distinct type from `multiAsset.ts`'s `MultiAssetClass`.** That existing type (`LARGE_CAP`/`MID_CAP`/.../`PENNY_STOCK`/`ETF`) is an equity liquidity-tier classifier, not a cross-asset-class model — conflating the two was an explicit Phase 0 finding to avoid. The new `AssetClass = 'EQUITY' | 'CRYPTO'` type lives in `cryptoInstruments.ts`.
- **`src/server/core/InstrumentRegistry.ts`** — `validateInstrumentSymbol()`. Additive, not a replacement: the equity path is byte-for-byte `looksLikeListedTicker()` (unmodified, still the single source of truth for every one of its other 23 callers); a new CRYPTO branch checks the canonical registry by exact match only — never a "contains a hyphen" heuristic, so an unregistered crypto-shaped string (`DOG-FAKE`) still fails closed, same as before. **Migrated in Phase 1: only RiskEngine's `price_validity` gate (gate 15).** The other 23 `looksLikeListedTicker()` callers (`gateTradeIdea()`/`tradeIdeaContract.ts` most notably — the pre-ChiefTrader DEF-24 idea gate) are untouched by design: nothing in this codebase emits a crypto `TRADE_IDEA_GENERATED` event yet, so widening them now would be unexercised surface area with real regression risk and zero present benefit. `gateTradeIdea()` remains a real, documented remaining blocker for a future idea-emission phase.
- **`src/server/engines/QuantityQuantization.ts`** — `quantizeQuantityDown(rawQuantity, step)`. `step===1` (the equity default) takes an exact `Math.floor()` fast path with **zero** epsilon tolerance, deliberately, so existing equity sizing outputs stay byte-for-byte identical (proven by the full pre-existing `PositionSizing.test.ts` suite passing unmodified). `step<1` (crypto) uses a scaled-integer epsilon-guarded floor (1e-7 tolerance in scaled-unit space) to absorb ordinary IEEE-754 double representation error without ever rounding up past a genuine boundary — bounded maximum overshoot ~1e-15 in quantity terms at 8 decimals, far below any practically meaningful notional tolerance.
- **`PositionSizing.ts`** — `SizingContext` gained three optional fields (`quantityStep`, `minimumQuantity`, `minimumNotional`), all `undefined` for every existing caller, preserving current behavior exactly. All 4 real `Math.floor(dollars/price)` sites (order-notional/risk/buying-power, symbol concentration, sector concentration, correlation exposure) now route through `quantizeQuantityDown()`. Below-minimum sizing is **rejected** (`maxQuantity = 0`, `sufficient_size` gate detail carries `reason: 'SIZE_REJECTED_MIN_NOTIONAL'` or `'SIZE_REJECTED_MIN_QUANTITY'`), never rounded up to meet a venue minimum — folded into the existing `sufficient_size` gate rather than adding a 26th named gate, since RiskEngine's 25-gate catalog (`riskGateOrder.json`) is otherwise unchanged. BUY-only, matching this file's existing SELL-is-never-capped asymmetry (SELL/exit sizing was never constrained by this module before, and still isn't).
- **`RiskEngine.ts`** — gate 15 now calls `validateInstrumentSymbol()` instead of `looksLikeListedTicker()` directly (equity behavior unchanged; `assetClass` added to the gate's recorded detail, purely additive/observability). The `calculatePositionSizing()` call site now looks up `getCryptoInstrument(proposal.symbol)` and passes its `quantityStep`/`minimumQuantity`/`minimumNotional` through — `undefined` (i.e. today's exact defaults) for every symbol not in the crypto registry, which today means every real symbol this deployment actually trades.

**What Phase 1 does NOT do (explicitly out of scope, per the mandate):** no change to `marketSession.ts` or RiskEngine's `market_hours` gate (12) — crypto's 24/7 session semantics remain a future phase; no change to `HistoricalDataGateway.ts` or any crypto market-data ingestion into `MarketDataWorker`; no change to `CoinbaseBroker.ts` and no new broker registered (`BrokerManager.registerBroker()` untouched); no strategy changes (the Java `Btc*`/`Crypto*` engines are untouched); no crypto `TRADE_IDEA_GENERATED` wiring. A registered crypto instrument existing in the registry does **not** by itself make BTC/ETH tradable — `gateTradeIdea()` and the entire idea-generation path remain equity-only until a future phase.

**Tests:** `QuantityQuantization.test.ts` (13), `InstrumentRegistry.test.ts` (9), `cryptoInstruments.test.ts` (5), `cryptoPhase1ArchitectureBoundary.test.ts` (6, proves the 3 new files never import OMS/RiskEngine/BrokerManager/a broker adapter and never reference `PAPER_TRADING_ONLY`/`LIVE_ARM`), plus new cases in `PositionSizing.test.ts` (BTC/ETH fractional sizing, never-exceed-notional invariant across price/step combinations, minimum-notional/quantity rejection, SELL-never-capped-by-minimums) and `RiskEngine.gates.test.ts` (gate 15: AAPL unchanged, BTC-USD/ETH-USD pass, `DOG-FAKE`/`BTC/USD` still fail, missing price still fails even for a registered crypto symbol). Full existing `PositionSizing.test.ts` and `RiskEngine.gates.test.ts` suites pass unmodified, proving zero equity regression. Full suite/build status: see the dated completion-ledger entry for this phase.

## OMS: SELL now routes to the broker that opened the position, not whichever is active (2026-09-22)

Operator-reported, live-reproduced defect. `OrderManagement.executeOrder()` resolved `BrokerManager.getInstance().getActiveBroker()` unconditionally for every order — BUY and SELL alike. This is correct for BUY (whichever broker is active opens the position), but wrong for SELL: switching the active broker mid-session (e.g. Alpaca → IB Gateway via `POST /api/v1/brokers/active`, the same runtime switch documented in the broker-migration section above) would route a closing SELL for a position opened on the *previous* broker to the *new* one — an account that never received the original fill and holds no knowledge of the position at all.

The tagging half of this already existed and needed no new column: `portfolio.brokerSource` is already stamped at fill time (`syncLocalPortfolioAfterBuyFill()`/`PortfolioReconciliation.ts`) and every `trades` row already carries its own `broker_id`. The gap was purely on the read side — nothing consulted `brokerSource` when choosing which broker should execute the order.

**Fix:** `OrderManagement.resolveOrderBroker(symbol, side)` — BUY is unchanged (always the active broker); SELL looks up the position's `portfolio.brokerSource` and, if it names a different, still-registered broker, routes there via `BrokerManager.getBroker(id)` (a pre-existing read-only lookup — `MarketDataCrossChecker` already used it for a similar reason — that returns a specific registered adapter instance without disturbing which one is "active"). Falls back to the active broker, loudly (a console warning naming both brokers), when the position has no recorded `brokerSource` (legacy rows) or the recorded broker is no longer registered — never a silent no-op, since a wrong fallback here sends a real order to the wrong account. Resolved once per `executeOrder()` call and reused consistently for the initial `trades` row insert, `executionEnvironment` classification (`resolveFillEnvironment()` now takes an explicit broker id), and the actual `placeOrder()` call, so none of those can disagree about which broker is acting.

**Same-defect-elsewhere check (per this file's own engineering standard):** `followUpOpenOrders()` had the identical bug one layer down — it polled only the active broker's `orders()` for every non-terminal trade row regardless of which broker actually placed it, so an order correctly routed to a non-active broker by the fix above would never be found during follow-up polling and would eventually be given up on. Fixed by grouping due orders by their own stamped `trades.broker_id` and polling each broker once per cycle. `reconcileInboundBrokerOrders()`/`reconcileStaleOrders()` were surveyed and left unchanged for this pass — they discover orders that already exist on whichever broker they query, which is a different, narrower problem (multi-broker crash-recovery scanning across every registered broker, not just the active one) — flagged as a real, separate follow-up rather than folded into this fix.

**Tests:** 4 new cases in `OrderManagement.test.ts` (SELL routes to the originating broker when a different one is active; BUY always uses the active broker regardless of any position's recorded origin; falls back to active broker when the recorded origin broker isn't registered; falls back to active broker for a legacy position row with no `brokerSource`). Full `OrderManagement*.test.ts` suite (7 files, 51 tests), `PortfolioReconciliation.test.ts`, `localPortfolioSync.test.ts`, `candidateToFillE2E.test.ts`, `paperSpineInternalPaper.test.ts`, and `RiskEngine.gates.test.ts` all pass unmodified except the new cases; `tsc --noEmit` clean.

## Full autonomous CLI runtime forensics pass: MACD math defect, DB bloat/missing index, allowlist drift (2026-09-22)

Operator-directed, full investigate→trace→fix→test→verify mandate (not an audit-only pass). Confirmed via direct DB/HTTP evidence: zero trades in the real analysis window (all engine restarts this session considered) — `consensus_decisions` showed 1726 `NO_CONSENSUS` rows and **zero** approvals; `risk_assessments`/`trades` were empty for the window, consistent (RiskEngine is only reached from `CHIEF_APPROVED_IDEA`). Root-caused, not just observed: (1) 78.8% of consensus rounds had only ONE independent evidence group (KronosEngine dominates volume — 3816/6055 evaluations that window — while `ConfluenceCoordinator` only pulls in a second agent off a qualifying *TechnicalAgent* signal, so most symbols Kronos alone touches never get a second independent vote); (2) KronosEngine's raw ~0.85 confidence is correctly Beta-Binomial-calibrated down to ≈0.47 (`ChiefTraderAgent.calibrateConfidenceDetailed()`, matching this agent's own documented Wilson-lower-bound ≈0.48 "not distinguishable from chance") — both are **EXPECTED SAFETY BEHAVIOR**, left unchanged; the objective was verifying the machine, not forcing trades.

**Real defects found and fixed this pass:**
- **`MACDEngine.calcEMA()` seeded every EMA with a single raw price instead of the standard SMA-of-first-`period` warmup**, and because `calculate()` also runs the same function over the derived `macdLines` array, `macdLines[0]` was always exactly 0 regardless of real data — a second, compounded instance of the same bug corrupting the signal line's own seed. Found via the real TS-vs-Java parity comparator (`strategyContextParity.ts`'s `QUANT_CORE_PARITY_DIVERGENCE` events): `macdSignal` diverged 17.5% from Java's independent implementation on real bars, a clear outlier next to `rsi` (6.8%) and raw `macd` (5.4%) on the same data. This is the live TechnicalAgent's actual indicator engine (`technicalSignal.ts`, 6 real consumers total). Fixed with the standard SMA-seeded convention; new `MACDEngine.test.ts` (4 cases: hand-verified seeding, cross-check against an independently-written reference implementation, constant-series convergence, existing insufficient-history contract). Real consequence, expected and correct: MACD crossovers now fire near genuine trend *onset* rather than deep into an already-mature constant-velocity trend (MACD's histogram is fundamentally a measure of trend acceleration) — 3 existing tests whose synthetic fixtures had implicitly depended on the old bug's specific residual bias to cross the threshold were updated to a flat-lead-in-then-onset shape and re-verified against the real (fixed) engine, not just patched to pass.
- **`candidate_rankings` had zero retention anywhere in the codebase** (live DB query: 1.38M+ rows spanning 26 days, unbounded — `observability_events` already had a real 14-day sweep, this table never did). Fixed with `operationalRetention.ts`, mirroring `sweepObservabilityRetention()`'s exact pattern (`candidateRankingsRetentionDays`/`candidateRankingsRetentionSweepMs`, `runtimeIntervals.json`, 14 days / hourly).
- **`event_traces` (500K+ rows, the permanent decision-trace audit trail — correctly never pruned) had zero indexes beyond its primary key**, despite three real route handlers querying it by `correlation_id`/`trade_id`/`transaction_id` — every one a full table scan. Live-measured before the fix: even the bare `/health` liveness route took 13.2s to respond under real load. Fixed via drizzle migration `0071` (3 new indexes). Post-restart, same endpoint: 5.8ms. Not claimed as the sole cause of this deployment's long-standing chronic watchdog flakiness (a separate, still-open heap-growth lead exists — see memory) but a real, proven, unambiguously-correct contributor.
- **Architecture-allowlist drift**: `src/server/risk/CryptoVenueAvailability.ts` (Crypto Expansion Phase 13, earlier this session) added a real, legitimate, read-only `BrokerManager.getInstance().getCryptoBrokerId()` call but was never added to `architecture.protection.test.ts`'s reviewed allowlist — caught by re-running the full suite, added with justification.

**Explicitly investigated and found NOT to need a code change:** DEF-26 (zero `UNCLEAN_SHUTDOWN_DETECTED` events in the entire watchdog.log history; this session's own graceful restarts confirmed `graceful: true`); the `v2System.quantCore.test.ts` catalog-count flakiness (already correctly diagnosed and labeled `KNOWN_FLAKY` on 2026-09-21 as full-suite worker-pool scheduling contention, re-confirmed passing in isolation, not touched further); `InteractiveBrokersAdapter.ts` (re-verified still genuinely unreferenced in production code, matching this file's own existing documentation — not deleted, no clear instruction to and it retains its own test coverage); Java Quant Core (0 code changes; 882/882 Java tests green, confirming the TS-side fix doesn't require a Java-side counterpart for parity to improve going forward).

**Full regression:** 562/562 TS test files, 4234/4234 TS tests green; 882/882 Java tests green (`mvn test`); `tsc --noEmit` clean; production build clean. Safe restart performed (watchdog stop → engine stop → engine start → watchdog start → resume), zero data loss (`portfolio` empty before and after, matching), trading resumed on Alpaca with real market data flowing (11/12 symbols `RECEIVING_FRESH` within seconds of boot).

## Targeted post-forensics improvement pass: symmetric Confluence trigger, P1-A partial finding, indicator golden-vectors (2026-09-22)

Operator-directed follow-up to the pass immediately above, scoped to the three unresolved questions it surfaced. Implement-and-verify, not report-only.

**A — Confluence asymmetry (real architectural defect, fixed).** `ConfluenceCoordinator.ts` was hardcoded to `if (idea.agent !== 'TechnicalAgent') return;` — a deliberate, evidence-based design from the 2026-08-25 audit that targeted TechnicalAgent specifically because it was that day's most evidence-starved agent (10,626 rows, only 38/39 co-occurrences with Quant/Kronos). One month later, live evidence showed the roles had reversed: KronosEngine now evaluates ~5x more often than TechnicalAgent (3,816 vs 787 in a real 6h window) — but a strong Kronos-only signal never pulled in a second independent voice at all, because the trigger check only recognized TechnicalAgent. This is a real, source-verified contributor to the 78.8%-single-independent-evidence-group statistic from the prior pass.

Fix: `TRIGGER_ELIGIBLE_AGENTS = {'TechnicalAgent', 'QuantEngine', 'KronosEngine'}` (the same deterministic/local, zero-marginal-cost set the module already used to justify these three over paid NewsAgent). Whichever of the three fires a qualifying signal now fans out to the *other two* — never itself (redundant, not independent). `technicalAgent.evaluateOnDemand()` (already existed, symmetric with Kronos's own on-demand method, computes purely from real tick/bar history — zero side/confidence leak, same structural guarantee as the pre-existing Quant/Kronos calls) is now wired in as a third trigger target. The existing per-symbol cooldown Map (`confluenceCoordinatorCooldownMs`, 60s) is reused unchanged and keyed by symbol, not by (symbol, triggering agent) — no evaluation-storm risk, no new concurrency control needed. Fundamental/MacroAgent's existing moderate-confidence-gated fan-out is unchanged in its own logic and is now reachable from all three sources instead of only one, matching its own "this symbol was worth a look" intent. Consensus math, weights, and thresholds in `ChiefTraderAgent.ts`/`EvidenceAggregator.ts` are completely untouched — this module still only asks agents that were already going to evaluate a symbol eventually to do so sooner. 23 tests in `ConfluenceCoordinator.test.ts` (6 new: symmetric Kronos/Quant-triggered fan-out, never-self-trigger, per-agent Mission Control disable for the new Technical path, independence preserved on the new path, replacing one now-stale "TechnicalAgent only" assertion).

**B — P1-A heap growth (still open; one small, real, unrelated leak found and fixed).** No live heap snapshot was attempted (standing prohibition — a prior snapshot capture froze the engine for ~6 minutes and caused a second incident, P1-B). Source-level audit instead: (1) searched for raw SQL built via template-literal interpolation of per-call-unique values (a plausible unbounded-statement-cache mechanism matching the P1-A snapshot's `trace_<SYMBOL>_<epochMs>_<hash>`-shaped string dominance) — found none; every `.prepare()` call in the codebase uses `?`/`@named` parameter binding, ruling this specific hypothesis out. (2) Re-verified the 2026-09-07-documented `PendingCapitalReservations` traceId-keyed leak fix (`RiskEngine.persistThenPublishAssessment()`) is still comprehensive — every non-approval and persist-failure path releases the reservation; the outer `evaluateRiskSerialized()` catch block correctly routes through the same release path. (3) Audited every per-symbol `Map` in `ChiefTraderAgent.ts` for eviction: found `lastDebateStartedAt` had **zero delete/eviction calls anywhere** (confirmed by grep), unlike every sibling Map in the same class (`manualSideExpectations`, `pendingDebates`, `consensusAggregationTimers`), all of which explicitly clean up their own entries. This is a real, proven, unbounded-growth defect — fixed with an opportunistic 10x-cooldown sweep on every set (`recordDebateStarted()`), 2 new regression tests proving bounded growth across 500 simulated distinct symbols and proving the sweep never evicts anything still within the real cooldown window. **Explicitly not claimed as the P1-A root cause**: this Map holds bare symbol strings, not the full traceId-shaped strings the P1-A heap snapshot found dominant, and a real discovery universe (low thousands of distinct tickers at most) is nowhere near the 18.27M string count that incident measured. P1-A's actual root cause remains genuinely unidentified — memory updated accordingly, not closed.

**C — Numerical golden-vector audit.** New test files with hand-derived and independently-cross-checked expected values (matching the method that found the MACD bug) for every engine named in the mandate that had zero direct tests before this pass: `RSIEngine.test.ts` (6 cases — confirmed already correct, proper Wilder's-Smoothing SMA seed, no defect), `TechnicalIndicators.test.ts` (11 cases covering SMA/EMA/ATR/Bollinger/VWAP — all confirmed correct; notably `calculateEMA` here already used the correct SMA-seeded convention MACDEngine was missing, meaning two independent EMA implementations existed in this codebase, one buggy and one not — a real instance of the split-brain risk this file's own "extend, don't fork" principle warns about, flagged but not consolidated this pass since they have different return-type contracts, a real refactor rather than a drop-in fix). `statistics.ts` (z-score, correlation, beta, skewness, volatility) was reviewed and found to already have adequate real golden-vector-style coverage from before this pass — not duplicated. RiskEngine's own drawdown-from-peak-equity formula and `PositionSizing.ts` were source-reviewed (both already extensively tested elsewhere this session) and found correct — neither touched, per "fix only PROVEN defects." Momentum-family indicators in `quant/indicators/momentum.ts` were reviewed via source only, not golden-vector tested this pass — the lightest-touch area of this audit, noted honestly rather than claimed complete.

**Full regression:** 565/565 TS test files, 4257/4257 tests green; `tsc --noEmit` clean; production build clean. Safe restart performed (watchdog stop → engine graceful stop [`graceful: true`] → fresh start → watchdog start → resume); zero data loss; `/health` 6.3ms post-restart. Zero changes to `consensusApprovalThreshold`, `minIndependentAgreeingAgents`, `disagreementPenalty`, any RiskEngine gate, or any `placeOrder(` call site — confirmed via direct `git diff` grep across every file this pass touched.

**Post-restart runtime verification, 18 real minutes:** `consensus_decisions.agreements_count` distribution shifted from the pre-restart 1h baseline (1 group 77.5%/404, 2 groups 16.6%, 3 groups 5.9%) to 1 group 72.4%/29, 2 groups 24.1%, 3 groups 3.4% — directionally favorable but n=29 is too small to claim statistical significance, stated as such rather than oversold. The load-bearing evidence is qualitative: 26 real `CONFLUENCE_COORDINATOR_TRIGGERED` production events in that window — 22 Kronos-originated, 4 Quant-originated, 0 Technical-originated. Before this fix these counts were structurally 0/0 forever (the hardcoded `idea.agent !== 'TechnicalAgent'` check made a non-Technical trigger impossible by construction) — going from impossible to 26 real observed events is the actual proof the fix works in live production, independent of the small-sample percentage.

**Operator review follow-up (2026-09-22, same day):** flagged a real remaining risk the initial pass had reasoned about but not proven with a test — symmetric triggering means a fanned-out agent's own on-demand call can itself emit a fresh `TRADE_IDEA_GENERATED` (evaluateOnDemand's whole purpose), and since that agent is now also trigger-eligible, the coordinator could in principle see its own fan-out's output arrive back through the same listener. The existing 60s per-symbol cooldown already prevents this in practice, but that's a timing argument, not a structural guarantee a future cooldown-value change couldn't quietly break. Added `ConfluenceCoordinator.test.ts`'s "bounded episode" test: a mocked `technicalAgent.evaluateOnDemand()` emits a real re-entrant `TRADE_IDEA_GENERATED` for the same symbol as a side effect, and the test proves each fan-out target is still called exactly once — because the per-symbol cooldown Map is set synchronously at the very top of `maybeTrigger()`, before any fan-out job is even created, a re-entrant emission from a fan-out job (sync or async) can never observe a clear cooldown for that symbol. Structural, not timing-dependent. 24/24 `ConfluenceCoordinator.test.ts` tests green (1 new). No production code changed by this follow-up — test-only, confirming an already-deployed property more rigorously. Per explicit operator guidance, no further architecture change was made this session: this build now runs through real paper-market time before the next comparison (candidate → Confluence-eligible → fan-out requested/completed → 2+ independent evidence groups → agreement/disagreement → ≥0.75 → ChiefTrader → RiskEngine → order/no-order), and P1-A memory investigation continues separately from trading-behavior changes.

## P1-A memory-leak root cause found and fixed (2026-09-23) — offline heap-snapshot analysis, no live capture

Per explicit operator direction ("pursue the ownership/lifecycle of those traceId-shaped strings next rather than another broad memory audit"), and respecting the standing prohibition on triggering a NEW live heap snapshot (a prior capture froze the engine ~6 minutes and caused a second incident, P1-B) — this pass instead built a small, purpose-written V8 heap-snapshot parser (raw nodes/edges flat-array scan, typed-array-scale, never a full `JSON.parse` of the whole file) and ran it **offline** against the two `.heapsnapshot` files already preserved on disk from the 2026-09-14 incident (`data/heap-snapshots/`) — zero interaction with any live process.

**Method:** walked the retainer chain of the incident's dominant string shape (`trace_<SYMBOL>_<epochMs>_<hash>`) by hand, one level at a time: string → held as an object's `traceId` property → that Object's exact field set (`id, agentName, symbol, prediction, confidence, reasoning, timestamp, traceId, aiCallId, provider, latencyMs, regime, strategyId`) is a precise, field-for-field match for an `agent_predictions` DB row → the Object is an **element of a single JS Array** → in just the smaller (282MB) of the two preserved snapshots, that one array already held **108,262+ elements**.

**Root cause, SOURCE VERIFIED:** `ReflectionEngine.ts` drove `evaluateAgents()` from a plain `setInterval(() => this.evaluateAgents(), 60_000)` with **no re-entrancy guard anywhere in the class** (only field was `intervalId`). Every cycle ran three unbounded full-table scans (`trades`, `agent_predictions` — 146,058+ rows and growing, `kronos_predictions` — 25,416+ rows and growing) and held all of them alive simultaneously across several more `await`s (insert loops). Both source tables grow every cycle, so each cycle gets slower over time — self-reinforcing. Once a cycle ever ran longer than 60s, `setInterval` fired again with nothing to stop a second, fully-overlapping `evaluateAgents()` from starting with its *own* full copies of both tables alive alongside the first. Repeated over enough overlapping cycles across real uptime, this is a well-evidenced, plausible mechanism for the incident's actual scale (2.04GB snapshot, ~18.27M trace-id-shaped strings).

**Fix:** the same `inFlight` boolean re-entrancy guard already used elsewhere in this codebase for an identical periodic-worker shape (`PostMarketAnalysis.ts`'s `tick()`) — early-return if already running, `try/finally` reset. Deliberately did **not** change the queries themselves (bounding/windowing `agent_predictions`/`kronos_predictions`) in this pass — that would be a real, separate change to calibration semantics (what evidence counts toward `agentConfidenceCalibration`) needing its own dedicated review, not a drop-in part of closing a concurrency gap. The guard alone eliminates the *compounding/unbounded* growth mechanism regardless of how long any single cycle takes.

**Tests:** `ReflectionEngine.reentrancy.test.ts` (3 new, real-DB integration harness) — a second concurrent call while one is in flight is a genuine no-op; `inFlight` correctly resets after both a successful and a failed (thrown) cycle. Full existing `ReflectionEngine.*.test.ts` suites (25 tests, 6 files) pass unmodified. Full regression: 566/566 TS files, 4261/4261 tests green; `tsc --noEmit` clean; build clean. Safe restart performed, zero data loss, trading resumed.

**Explicitly NOT claimed:** that this is *proven* to be the entirety of P1-A's cause — it is a well-evidenced, source-verified, structurally-sound root-cause candidate found via legitimate forensic analysis of real incident data, not a live reproduction of the original incident. Memory (`project_argus_p1a_memory_leak_open.md`) updated to reflect this finding while keeping the file's own standing rule intact: don't declare P1-A fully closed without further real-world confirmation over elapsed uptime.

## Canonical Cost Model + Trade Economic Attribution (2026-09-23, roadmap Priority #2)

Operator-directed Priority #2 of the "Argus World-Class Open-Source Quant Expansion" program,
explicitly sequenced before ojAlgo portfolio optimization, VaR/ES, or any new model/oracle work:
"build economic truth first," and explicitly **not** touching consensus, model weights, or
promotion. Audit found substantial real infrastructure already in place — `executionQuality.ts`
(2026-09-13) already computes real, sign-consistent arrival-vs-fill slippage from `trades.arrival_price`
(written once at insert, never overwritten) and an already-real, SQL-classified evidence taxonomy
(`PAPER_ORGANIC`/`PAPER_MANUAL`/`PAPER_UNATTRIBUTED`/`REPLAY`/`BACKTEST`/`SIMULATION`/`LIVE`/`UNKNOWN`)
that already keeps research and PAPER evidence from being mixed — but its own header explicitly
documented commission/total-cost as unmeasured ("Slippage only; commissions and total costs
unknown"), and no per-trade gross/net P&L attribution existed anywhere.

**`src/server/research/canonicalCostModel.ts`** (new) — the shared cost vocabulary: `CostQuality`
(`MEASURED`/`ESTIMATED`/`PARTIAL`/`UNAVAILABLE`), `worstCostQuality()` (a combined cost's quality is
always the WORST of its components, never silently upgraded), and `classifyCommission()`. Real
schema addition: `trades.commission` (nullable real, migration `0072_trades_commission.sql`) — no
current broker adapter populates it yet (confirmed by source grep: neither `AlpacaBroker.ts` nor
`IbkrSocketSession.ts` parses or discards any commission field today), so it exists as real,
ready infrastructure for a future capture pass (IBKR's TWS API has a real `commissionReport`
callback event, currently unwired) rather than being retrofitted later. One narrow, source-verified
exception to "commission unknown": Alpaca's own documented fee schedule charges **zero** commission
on US equity orders — classified `MEASURED, $0`, a verified fact about that specific broker/asset
class, never extended to Alpaca crypto (which does carry real fees) or to any other broker with no
reported commission (which stays honestly `UNAVAILABLE`, never assumed zero).

**`src/server/research/tradeEconomicAttribution.ts`** (new) — the closed-loop, per-trade record:
gross P&L (`trades.profit_loss`, real, SELL legs only), the canonical cost breakdown, a net-P&L
figure, strategy family (reuses `strategyFamilies.familyForStrategyId()` — the existing classifier
for strategy ids, distinct from `evidenceFamilyTaxonomy.ts`'s agent-name classifier added earlier
this same roadmap pass), evidence class (reused from `executionQuality.ts`, never reclassified),
and decision-vs-fill timestamps.

**Honest, explicitly-documented scope limitation on net P&L (the roadmap's own "never pretend
estimated cost is observed cost" instruction applied to a real structural constraint, not glossed
over):** Argus prices positions by real broker-reported AVERAGE COST BASIS
(`resolvePreTradeEntryPrice()` in `OrderManagement.ts`), not FIFO/LIFO lot tracking — there is no
durable foreign key from a SELL's `trades` row back to the specific BUY row(s) that opened the
position, especially for a position built from multiple partial buys. `netPnlAfterExitLegCostOnly`
therefore nets out ONLY the SELL leg's own slippage+commission against the real gross P&L — it
deliberately does **not** attempt to also subtract the original BUY leg's own execution cost, since
there is no reliable, non-heuristic way to attribute it in an average-cost-basis system. The field
name states precisely what is and is not included rather than presenting a synthesized "complete"
round-trip figure the data cannot actually support. A future FIFO/lot-tracking layer could close this
gap properly; it was not built as a shortcut inside this pass.

Exposed at `GET /api/v2/observability/trade-economic-attribution` (optional `?scope=`/`?limit=`,
`argus-cli trade-economic-attribution --scope=X --limit=N`), mirroring `execution-quality`'s own
route/CLI shape exactly.

**Tests:** `canonicalCostModel.test.ts` (10, pure unit — commission classification including the
verified Alpaca-equity-zero-commission fact and its crypto exception, worst-quality combination,
total-cost null-propagation), `tradeEconomicAttribution.test.ts` (6, real-DB integration harness —
SELL-leg net P&L on a MEASURED-commission broker, UNAVAILABLE net P&L on an unmeasured-commission
broker, BUY-leg-has-no-P&L-yet, empty-input formatting). Full regression: 443 tests across the
`src/server/research/` suite plus `OrderManagement.test.ts`/`OrderManagement.lifecycle.test.ts`
green (including the full pre-existing `executionQuality.test.ts` suite unmodified — proving zero
change to already-real slippage classification); `tsc --noEmit` clean.

**What was explicitly NOT done this pass, per the operator's own sequencing (real backlog, not an
oversight):** no cost-quality-driven gating of anything (this is observability infrastructure only —
still fully additive, nothing reads these new fields anywhere near ChiefTrader/RiskEngine/OMS); no
net-expectancy plumbing on `ForecastEngine`'s gross-only contract (roadmap item #5, a distinct,
separately-scoped follow-up); no IBKR commission-capture wiring (the schema column exists, nothing
populates it yet); no spread-component measurement (only slippage and commission are covered —
real bid/ask spread capture at decision time is a further, not-yet-built piece); no daily/strategy-
level cost rollup beyond what `dailyStrategyPerformance`/`CampaignTracker.ts` already track
separately (unification of research vs. PAPER cost vocabulary at that rollup layer remains open).

## Net-Expectancy Plumbing (2026-09-23, roadmap Priority #5)

Operator-directed Priority #5, immediately following Priority #2 (canonical cost model): connect
real cost evidence into the existing gross-only forecast contract, explicitly SHADOW/observability
only — "do not let ChiefTrader, RiskEngine, PositionSizing, or OMS consume the new fields yet."

**Extended the existing contract rather than creating a parallel one**, per explicit instruction:
`Forecast.estimatedTransactionCostBps`/`netExpectedReturn` already existed in both the TypeScript
interface and the `quant_forecasts` schema (Master Transformation Mandate Part 7, 2026-09-13) but
were **always null** — `resolveTransactionCostBps()` unconditionally returned `UNKNOWN_TOTAL_COST`
even though real measured slippage was available, because commission was never measured at all
until Priority #2 landed. `provenance.transactionCostSource` already had `'REAL_EXECUTION_QUALITY'`
as a declared-but-never-reached type value — confirming the original contract was designed for
exactly this extension, not a new one.

**`resolveExpectedCost()`** (renamed from `resolveTransactionCostBps()`) now sources from
`tradeEconomicAttribution.ts`'s real per-leg cost breakdown (slippage + honestly-classified
commission, Priority #2) instead of `executionQuality.ts`'s slippage-only summary. Reports a real,
usable bps figure (`costQuality: 'MEASURED'`) only once at least `researchSafety.minOosTrades` (30
— the same reviewed "trustworthy sample" floor already used elsewhere in this research module
family, not a newly-invented number) real MEASURED-cost trade legs exist; `UNAVAILABLE`/null
otherwise — never an `ESTIMATED` guess dressed up as real.

**Cost semantics honestly scoped to what `expectedReturn` actually measures:** `expectedReturn`
(from `prediction_outcomes.actualReturn`) is a ONE-WAY forward price return referenced from a
prediction's own timestamp to a horizon — not a realized round-trip trade. The cost netted against
it is therefore the mean cost of ONE trade leg, deliberately never doubled to simulate an entry+exit
round trip `expectedReturn` was never measuring. No BUY-leg-to-SELL-leg cost linkage is invented
anywhere in this module — that same limitation is already documented, not worked around, in
`tradeEconomicAttribution.ts`'s own header (Priority #2).

**New fields** (additive, `Forecast` interface + `quant_forecasts` schema, migration
`0073_forecast_cost_quality.sql`): `costQuality: CostQuality` (reused from `canonicalCostModel.ts`
— never a second enum), `netReturnAvailable: boolean` (a single explicit gate so a future consumer
never has to infer "is net return real" from a null-check), and `provenance.costSampleSize` (folded
into the existing `provenance` bag rather than a new parallel top-level field — the roadmap's own
"costProvenance" concept, satisfied by extending what already exists). Model version bumped to
`forecast-v3-net-expectancy-2026-09-23` (from `forecast-v2-gross-only-2026-09-19`) since this is the
first version where these two fields can ever be genuinely non-null.

**A real, separate bug found and fixed while wiring this:** `mostRecentForecast()`'s read path
unconditionally forced `estimatedTransactionCostBps`/`netExpectedReturn` to `null` regardless of
what was actually persisted — harmless before this pass (every real row genuinely had them null
anyway, since the write path never populated them), but a real defect once the write path could
produce genuine values: every read would have silently destroyed correctly-computed net-expectancy
evidence. Fixed to return exactly what was persisted; legacy rows (written before migration `0073`,
where `cost_quality`/`cost_sample_size` are `NULL`) correctly read back as `costQuality: 'UNAVAILABLE'`.

**Tests:** `forecastEngine.test.ts` gained a real end-to-end test (30 real `PAPER_ORGANIC` SELL legs
on Alpaca — the verified $0-commission equity broker — each with known 50bps slippage, plus a real
gross-return sample and a mocked Java response) proving genuine gross→cost→net propagation through
an actual `buildForecast()` call and a round-trip through persistence and `mostRecentForecast()`
(`0.02 - 0.005 = 0.015`, hand-verified), plus two backward-compatibility tests (a genuinely
legacy-shaped row reads as `UNAVAILABLE`/never crashes; a real `MEASURED` row reads back faithfully
instead of being suppressed — the actual bug just described). One pre-existing test
(`does not expose legacy zero-cost profit estimates`) was rewritten: its old assertion encoded the
now-incorrect blanket-suppression behavior; replaced with a test of what the read path genuinely
still guarantees (never fabricating `probabilityOfProfit`, which this module still does not compute
at all — a distinct, unrelated, not-yet-built piece — and never mutating the historical row on
read). `opportunitySnapshot.test.ts`'s existing forecast-integration test and `opportunitySnapshot.ts`
itself were updated identically (the read-path fix applies there too — `modelForecast` gained the
same `costQuality`/`netReturnAvailable` fields). Full regression: 432 tests across `src/server/research/`
+ `QuantSignalAgent.test.ts` + route wiring green; `tsc --noEmit` clean. `QuantSignalAgent.ts`'s
real production call site (`void buildForecast({...})`, fire-and-forget) and the `POST /forecast`
route (pure passthrough) both confirmed unaffected — neither accesses the new or changed fields.

**What was explicitly NOT done this pass, per the operator's own sequencing:** no consumption of
these fields anywhere near ChiefTrader/RiskEngine/PositionSizing/OMS (still pure research
observability); `probabilityOfProfit` remains uncomputed (a distinct, pre-existing gap, not this
roadmap item's scope); no spread-component measurement beyond what Priority #2 already covers; no
IBKR commission capture (still the named follow-up from Priority #2). Next per the operator's stated
order: ojAlgo constrained portfolio optimization, then VaR/ES, then the PIT research warehouse.

## September 27, 2026 — Defect remediation contract corrections

The operator authorized corrective implementation following `ARGUS_CODE_DEFECT_AUDIT_AND_FIX_PLAN.md`. The protected idea → ChiefTrader → RiskEngine → PositionSizing → OMS → BrokerManager path, trading thresholds and enablement defaults are unchanged.

- Fill-ledger updates serialize cumulative-watermark reads and inserts in an immediate SQLite transaction. The incremental fill price is derived from cumulative broker notional less recorded notional. Invalid/missing fill economics are rejected. Local BUY accounting receives the execution broker identity and incremental price. Historical rows are not rewritten; OMS reconciliation handling for rejected economics remains an open follow-up.
- Backups use SQLite online backup to a unique temporary destination, verify integrity, then rename for publication. CLI callers await completion and receive failures. Scheduled backups retain existing single-flight scheduling. The destination integrity check is synchronous; production-scale latency has not been measured.
- Snapshot ranking joins metrics by symbol. Regular TradePlan expiry resolves 16:00 America/New_York through the timezone database; holidays/early closes are not yet implemented. Miss classification requires explicit risk approval before assigning an execution miss.
- ADV uses an explicit completed-day range, bounded pagination and distinct dated observations. Both Alpaca and fallback evidence require the configured sample count. Missing coverage remains unavailable, not proof of illiquidity or permission to lower a gate.
- Crypto ingestion uses the existing single-flight primitive, cancellation and generation checks. Invalid/future timestamps cannot become fresh observations. Bid/ask evidence is validated; historical pagination is bounded and rejects invalid/conflicting bars. Polling metrics are exposed in worker status. Resource limits live in `config/dataTransportLimits.json`; they are transport bounds, not strategy thresholds.
- Crypto PAPER accounting charges entry fees to realized P&L proportionally on sale, reserves pending SELL quantities, validates order amendments/marks and latches triggered stops across partial fills. This does not complete the separate crypto live-routing integration.
- Coinbase retains caller client-order IDs, rejects unsupported order types, and requires a broker acknowledgement ID. Accounts/orders paginate with bounded cursors; balances include held amounts, cash aggregates supported cash wallets, and buying power excludes held cash. Unknown valuation and cost basis remain unresolved under the current non-null portfolio contract. The adapter retains its existing USDC dollar-equivalence assumption; it is not certified valuation evidence.
- Commission classification excludes registered crypto and non-equity-shaped symbols from the Alpaca equity exception. IPv6 URL screening canonicalizes mapped addresses and checks the full link-local prefix; connection-time DNS binding and redirect policy remain open.
- Java `CryptoExpectedEdgeEngine` rejects invalid calibration/economic inputs and requires a positive minimum sample policy. Invalid evidence is no longer silently clamped into an apparently calibrated estimate. No signal, vote or execution authority was added.

These are engineering corrections, not alpha validation or LIVE authorization. See the audit follow-up for remaining defects and validation evidence.

## September 28, 2026 — Failed broker initialization and zero-idea recovery

A runtime audit found an enabled PAPER session with fresh market data but `BrokerManager.syncState=FAILED`, `interruptedSessionHold=true`, and `liveIdeaGenerationEnabled=false`. Through 15:58 EDT on September 28, all 4,016 quant assessments were non-emitting; there were no recorded ideas, consensus decisions, risk assessments, trades or fills in the trading-date window beginning 04:00 UTC. These are incident observations, not readiness certification.

`BrokerManager.setActiveBroker()` now serializes explicit activations against initialization/reconciliation, authenticates a replacement before disconnecting the prior adapter, and transitions successful activation to `READY` before calling the existing portfolio flush/reconcile path. `READY` here means the reconciliation worker may run, not that reconciliation passed or an order is authorized. A previous `FAILED` state no longer permanently suppresses that worker after a successful explicit reconnection. Authentication failure remains fail-closed; invalid broker IDs do not change the current synchronization state. Boot initialization also checks the adapter's boolean authentication result instead of silently accepting `false`.

The existing restart hold still releases only through a real `RECONCILIATION_MATCH`. This change does not resume `TRADING_PAUSED`, clear `EMERGENCY_STOP`, emit a substitute match, submit an order, or add a retry scheduler. No operational flags, consensus/risk thresholds or AI/quant authority changed.

Diagnostics now include the actual broker sync state in runtime readiness, a separate Entry Generation readiness node with the existing hold/state reason, durable initialization-stage/activation-state events, and preservation of `syncState`, `fromState`, `toState` and `code` in the EventBus observability projection. Quant candidates withheld by the entry gate or agent switch produce explicit `DESK_NO_TRADE` reasons while their original assessment remains persisted. No new quant calculation is introduced.

Regression coverage uses the real manager, reconciliation worker, isolated SQLite and session-recovery listener with a fixture broker. It checks matched, mismatched, unreachable and rejected-authentication cases, overlapping activation refusal, and unchanged paused state. The quant candidate test is a focused refusal/telemetry test using an existing mocked strategy fixture, not a market-data-to-fill certification.

The first controlled deployment reproduced initialization failure in `crypto_paper` with `SqliteError` before broker selection. The real database lacked all three crypto paper tables despite successful migration startup. Migration `0078_skinny_mockingbird` has journal timestamp `1790593282631`, below already-applied `0077` (`1790600000000`); Drizzle compares timestamps with the database watermark and silently skips 0078 on this upgrade path. Fresh databases apply it, explaining why fresh-database tests missed the defect. Forward-only migration `0079_repair_skipped_crypto_paper_tables` creates the same tables/indexes if absent, preserving any existing broker ledger. Historical migration files/timestamps remain unchanged. Regression tests cover the deployed watermark, populated prior tables, fresh full-journal migration, repeat migration, and rejection of future timestamp regressions. This is a reproduced startup cause and compatible with the day's failure chain; the original morning exception was not durably retained.

Deployment verification: after the normal graceful restart and automatic boot migration, engine PID 28476 reported `alpaca: Healthy`; production `reconciliation_events` recorded a real Alpaca match at `2026-09-29T02:22:04.467Z` (September 28, 22:22 EDT), with no action taken. The new readiness node correctly reports `TRADING_PAUSED`; no resume command was issued. `LIVE_NO_GO` was rechecked through the live-readiness endpoint. Off-hours fresh-quote coverage was zero, so this is broker/reconciliation recovery evidence, not next-session organic trading certification.

## September 29 full-session review remediation (2026-09-30)

Implementation pass against `docs/audits/archive/ARGUS_FULL_SESSION_REVIEW_2026-09-29.md`'s evidence-ordered remaining-work list. Engine was not restarted, resumed, broker-switched, or LIVE-armed at any point in this pass; all production-database reads below were read-only, direct SQLite queries (`better-sqlite3`, `readonly: true`) against `data/argus.db`, never through the running engine.

**1. IOVA-class request-to-evaluation gap, closed (highest priority).** Root cause was two compounding defects, both verified by direct source reading, not assumed from the audit's own hypothesis: (a) `MarketDataWorker.ensureWatchlistListener()` - the real production `WATCHLIST_SUBSCRIBE_REQUESTED` handler - never forwarded `requestedBy`, so `subscribe()`'s existing `requestedBy`-gated observability (`SYMBOL_NOT_SUBSCRIBED`/`MARKET_DATA_CAPACITY_FULL`) silently skipped every discovery-originated call; (b) `OpportunityDiscovery.ts`'s hot-swap planner ranked eviction candidates from `MarketDataWorker.getDynamicSymbols()`, a superset that includes dwell-protected and active-rescue symbols the worker's own `rankEvictionCandidates()` would refuse to evict - the planner could "win" a swap against a never-evictable incumbent, leaving the real `subscribe()` call to fail silently with nothing evicted. Fixed: the listener now forwards `${source}:${reason}`; `subscribe()` now logs an unconditional `MARKET_DATA_SUBSCRIPTION_OUTCOME` (ACCEPTED/ALREADY_ACTIVE/REFUSED_CAPACITY/REFUSED_PROVIDER_REJECTED/REFUSED_INVALID_TICKER) regardless of caller, via the same `structuredLogger` pattern already used for rescue grants/denials; a new public `MarketDataWorker.getEvictionEligibleDynamicSymbols()` (a wrapper around the existing `rankEvictionCandidates()` logic, not a parallel allocator) is now what the planner ranks incumbents from, so planning and actual eviction always agree - when zero incumbents are genuinely evictable, planning now correctly produces zero swap requests that cycle instead of repeatedly proposing one the worker cannot fulfill. 12 new/extended tests in `OpportunityDiscoveryToQuantAssessment.integration.test.ts` reproduce every real-world case the audit named: `requestedBy` propagation, dwell-protected refusal, rescue-protected refusal (RENEWAL-exempt from the rescue budget, a distinct mechanism from dwell), a heterogeneous no-eligible-eviction mix matching the real IOVA-day pattern (dwell + rescue + core-protected together), IOVA's real 7x repeated-request pattern (never admitted, never silent, no state leak), a genuine provider-level subscription rejection (isolated `MarketDataWorker` instance, IBKR bridge throws, real rollback), and a reconnect/generation-change dwell re-arm check (isolated instance, zero real network touched).

**2. September 29 market-data disconnects (93 regular-session "socket closed" events) - measured, not merely counted.** Paired each `MARKET_DATA_DISCONNECTED` timestamp against its immediately-following `MARKET_DATA_GAP_DETECTED` (the real Alpaca WebSocket re-authentication confirmation - `MarketDataWorker.ts` emits it the moment `authenticated` flips back to `true`). All 117 full-calendar-day disconnects paired to a same-day reconnect: min 1.19s, median 1.30s, p90 3.25s, max 5.87s - zero exceeded 10s, three exceeded 5s. Against gate 13's 300,000ms staleness threshold, none of these could have caused a `data_freshness` failure by itself; this is evidence of fast, self-healing transport-level reconnects, not sustained outages, and is not a demonstrated cause of the day's zero-trade outcome. Found and fixed the reason this couldn't be measured from persisted data alone: `instrumentEventBus.ts`'s generic EventBus-to-observability bridge extracts a fixed field whitelist per event type (a real, repeat-offender gap - three prior confirmed instances: `AI_PROVIDERS_EXHAUSTED` 2026-09-06/07, `NEWS_ANALYZED` 2026-09-10, `WATCHLIST_SUBSCRIBE_REQUESTED` 2026-09-16). `MARKET_DATA_GAP_DETECTED`'s real payload (`gapMs`/`disconnectedAt`/`reconnectedAt`) was not in that whitelist, so every one of the 117 real rows persisted with an empty payload - confirmed by direct query, not inferred. Added the three fields (fourth instance of the same narrow fix) so future gap events are durably measurable.

**3. Java bridge fan-out storm (13,051 timeouts / 6,585 circuit-opens that day) - grouped by endpoint, root-caused, fixed.** Direct query and regex-parse of the ~1M `QUANT_BRIDGE_CALL_OUTCOME` rows that day (the payload's `reasoning` field carries `endpoint=`/`result=`/`durationMs=` as unstructured text - not itself changed in this pass, a candidate for a future narrow structuring fix matching the pattern above). `ticks` (97% of volume, already fixed 2026-09-11 for its own unbounded-fan-out concurrency storm) is healthy: 0.86% timeout rate, p50 10ms latency - that fix holds. The remaining, unfixed problem: `internalQuantEnsemble.ts`'s `computeInternalEnsembleQualification()` fired all 10 `JAVA_RESEARCH_STRATEGY_IDS` via a single unbounded `Promise.all` for every symbol - the exact unbounded-fan-out shape already diagnosed for `forwardTick()` but never extended to this separate caller. Evidence: all 10 `institutional/strategy/*` endpoints showed a strikingly consistent ~27s max latency and ~2.05s p90 (a queueing/contention signature, not 10 independently slow endpoints), and `quant/ensemble` (called immediately after, once per symbol) showed 1,025 timeouts + 934 circuit-opens out of 4,301 calls (~46% non-success). Fixed: bounded concurrent dispatch to `quantResearchStrategyFanoutMaxConcurrency` (4, `config/tradingSafety.json` - grounded in the real distinct-family count these 10 strategy ids collapse into via `strategyFamilies.ts`'s own `JAVA_RESEARCH_STRATEGY_FAMILIES`, not an invented number), via the same bounded-worker-pool pattern `QuantSignalAgent.ts`'s own cycle already uses. A new regression test asserts peak concurrency never exceeds the configured bound while still calling all 10 strategies exactly once. Java itself was not modified - this is a TS-side control-plane dispatch-throttling fix, the same class of change as the precedent it extends.

**4. ORB input-contract verification - one real defect found and fixed, one area reviewed and left as-is.** Traced every input `openingRangeBreakout.ts` consumes: `currentPrice` (daily-bar-derived, `bars[bars.length-1].close` with `end=now` - Alpaca's `1Day` bars endpoint returns a live-updating current-day aggregate during market hours, not a stale prior-day close; reviewed, not a confirmed defect); `supportResistance.openingRange` (already fixed in the prior pass - real intraday bars); relative volume (`computeVolumeFeatures`'s `relativeVolume`, still daily-cumulative-volume-vs-20-day-daily-average - a coarser measure than a true same-time-of-day intraday comparison, but internally scope-consistent (daily numerator over daily denominator), not the same class of defect as VWAP below; a genuine fix would need a real intraday historical ADV curve, a separate, larger, not-yet-built follow-up); stop/target (`structural ± 1x ATR`, `currentPrice ± 2x ATR` - ATR is a volatility magnitude from daily bars, not a session-anchored level, so pairing an intraday structural break level with a daily-ATR-scaled buffer is standard, defensible practice, not a timestamp mismatch). **Real, confirmed defect found and fixed: session VWAP.** `computeVolumeFeatures(bars)` was called with only daily bars project-wide; `computeVWAPContext(bars)` -> `calculateSessionVWAP(bars)` filters for bars at/after "today's" midnight-UTC boundary, which against a one-row-per-day series matches at most the single most recent daily bar - "session VWAP" degenerated to that one bar's own typical price `(h+l+c)/3`, not a genuine intraday-cumulative VWAP, even though `openingRangeBreakout.ts`'s own "Price above/below session VWAP" condition depends on it being real. Fixed the same way the opening-range feature itself was fixed in the prior pass: `computeVolumeFeatures(bars, intradayBars?)` gained the identical optional/additive parameter shape, and when real intraday bars are supplied (only `QuantSignalAgent.ts`'s live ORB path does, same `isExperimentalStrategyLive('OPENING_RANGE_BREAKOUT')` gating as before), VWAP is computed from them instead - a genuine volume-weighted intraday VWAP. Every other CORE/experimental strategy and every other caller of `computeVolumeFeatures` (`BacktestEngine.ts`, `PortfolioMonitor.ts`, replay/research/strategiesEngine paths) is unaffected, still daily-only, verified by direct enumeration. `relativeVolume`/`isSpike`/`volumeROC`/`obv`/`mfi`/`cmf`/`ad` are unchanged regardless of whether `intradayBars` is supplied - only VWAP is affected, asserted by a dedicated regression test. Java ownership: this is data-provisioning for a pre-existing TS calculation (`calculateSessionVWAP` already existed), not new calculation logic - same classification as the opening-range fix, not an exception to Java Engine Authority rule 0.

**Discovery RVOL vs. strategy RVOL - traced, not conflated.** These are two different calculations from two different modules with two different data sources: `MarketUniverseScanner.ts`'s `computeRvol()` (discovery-layer mover classification, now unconditionally abstains per the prior pass's second-review fix - real IEX-snapshot/SIP-historical feed-scope incompatibility) and `indicators/volume.ts`'s `relativeVolume()` (strategy-layer, `StrategyContext.volume.relativeVolume`, daily-bar-derived, reviewed above as scope-consistent though coarse). Neither reads from or writes to the other; fixing one does not fix or affect the other.

**Verification of the prior pass's fixes (item 3 of this pass's own scope).** Re-read (not re-implemented) `OpportunityDiscovery.ts`'s combined-challenger sorting, priority-score propagation, symmetric planner scoring (`priorityScoreOf` used for both challenger and incumbent ranking), and the removed already-bonused-score fallback in `baseScoreOf` - all confirmed present and unchanged in current source at the start of this pass. The causal integration-test revision (real listener, real capacity, real scheduler) was also confirmed present. This pass's own eligibility fix (item 1 above) builds directly on top of that unchanged foundation - `activeDynamic`'s new source (`getEvictionEligibleDynamicSymbols()`) is the only change to the planning function itself; the scoring formula it feeds is untouched.

**Full suite after this pass's changes:** re-run required before this section's own claim can be treated as verified - see the Master Completion Ledger / most recent commit for the exact result recorded alongside these changes; report it precisely (file/test counts, named failures, isolated-rerun status) rather than "all green."

**Protected-authority items from item 6 of this pass's mandate (calibration governance, provider-ambiguous lookup, horizon compatibility, the confidence/reliability/probability/consensus/evidence-sufficiency distinction) were investigated and resolved as documentation-only corrections in the prior same-day pass** (see this document's own "Decision-model investigation findings" and "Second Codex review corrections" sections above - the `ChiefTraderAgent.ts`/`CalibrationCandidateBuilder.ts` contradictory-comment fix, the confidence-semantics ceiling proof, and the horizon-compatibility diagnostic-extension proposal). No new protected-decision-model change was proposed or activated in this pass; nothing new is pending review beyond what those sections already list as PROPOSED/NOT ACTIVE.

**Deployment identity:** this pass's own commits are the only source-revision claim available - no separate build/deploy artifact was inspected, and the running engine (per this pass's own standing instruction) was never restarted, so no runtime-verified confirmation that these fixes are live in a running process exists as of this writing. Source-tested (typecheck clean, targeted + related suites green, regression tests added and passing) is not the same claim as runtime-verified; this section makes only the former claim.

## October 4, 2026 — cost-aware validation: DSR selection gate + synthesis cost-liveness proof

Two audit/suggestion follow-ups, both measurement/validation (no strategy, sizing, consensus, or execution change; nothing on the protected spine touched).

**1. DSR as a real WFO selection gate (`scripts/run_vectorbt_wfo.py`, audit finding).** The Python walk-forward previously computed the Deflated Sharpe Ratio and stored it (`dsr_train`) but the promotion decision only rejected `dsr is None` - any defined DSR passed, so the multiple-testing correction had no selective force. New `promotion_decision()` requires all three: positive out-of-sample expectancy, passed permutation test, **and** `dsr >= dsrMinThreshold` (new `config/researchSafety.json` field, default **0.95** - the Bailey & Lopez de Prado 95%-confidence bar; typed through `src/server/config/researchSafety.ts`, config-driven, never a TS literal). Skip reasons are now specific (`OOS_EXPECTANCY_FAIL` / `PERMUTATION_FAIL` / `DSR_UNDEFINED` / `DSR_BELOW_THRESHOLD`) instead of one opaque bucket; the report carries the threshold and per-candidate DSR. `python/argus_research/test_wfo_dsr_gate.py` (7 tests) pins the gate, including the boundary (`dsr == threshold` promotes). Verified: script runs clean on the golden fixture; no upserts (fixture is `SYNTHETIC_NOT_PROMOTABLE` by construction).

**2. Synthesis certification proves the cost model is live.** The synthetic session already fills against a real cost profile (`replaySafety.json` `Base`: $0.005/share, 2bps spread, 5bps slippage), but the certification report never surfaced it - a silently-disabled cost model would have been invisible and every simulated P&L a gross-fiction. `SyntheticSessionResult` now carries the session's `costProfile`; `evaluateCertification` FAILs closed (`COSTS_NOT_APPLIED`) when fills occurred under a non-zero profile but the broker recorded zero fees/slippage, and the report now prints fees paid, slippage paid, and the active profile next to realized P&L. A zero-cost profile (explicit research mode) legitimately passes. 3 new `CertificationGate.test.ts` cases cover the liveness failure, the zero-cost pass, and the surfaced profile. Complements (does not duplicate) the 2026-09-23 Canonical Cost Model section: that work built the cost vocabulary for research/paper evidence; this work proves the cost model is actually biting inside the pre-market certification runs.

## October 6, 2026 — Jev (noul/choice/score) news-triage integration, all three phases, fully inert

Jev is a classification-only provider (returns structured noul/choice/score answers, generates no text).
Integrated as a strict enhancement behind default-off flags, per the October 5 AI-as-enhancement
architectural boundary: Argus must trade with zero AI, and Jev never influences a trading decision.

**Adapter (already on main):** `src/server/ai/providers/JevProvider.ts` — `POST /v1/systemone` with
noul/choice/score question types, strict fail-closed response validation, chat/stream/vision/embeddings
throw (Jev generates no text). Supports `JEV_API_KEY` / `TYPESAFE_API_KEY` / `JEV_BASE_URL`. No key
exists; live smoke has not run.

**Phase 1 — shadow scoring (default OFF):** `JevNewsTriage.ts` builds one complete-validated-or-skip
state per article (fresh ≤ `jevShadowMaxAgeHours`, body bounded by `jevShadowMaxBodyChars`) and scores
it with one batched 6-question request (relevance, sentiment, market impact, surprise, contradiction,
urgency). `JevShadowLedger.ts` persists the score plus, when the article also got LLM analysis, the
LLM comparison and agreement into `jev_shadow_scores` (drizzle migration 0088). Fire-and-forget from
`NewsEngine`; never replaces `aiAnalysis`; never blocks the cycle. `JevNewsTypes.ts` holds the shared
`JevNewsScore` type and field mapping (extracted 2026-10-06 to break the triage↔ledger circular import).

**Phase 2 — confidence-gated escalation (default OFF):** `JevEscalation.ts` — Jev scores first; the LLM
runs only when Jev confidence is below `jevEscalationConfidenceThreshold` (0.75), relevance below
`jevEscalationRelevanceThreshold` (0.6), the article is high-stakes (credibility ≥
`jevHighStakesCredibility` 0.8 AND impact ≥ `jevHighStakesImpact` 7.0), or Jev is unavailable. Thresholds
are conservative initials pending Phase 1 calibration data — not measured optima. `NewsEngine`
integration is flag-gated (`ARGUS_JEV_ESCALATION_ENABLED`); when off, the FinBERT→LLM path runs
byte-for-byte unchanged. Failures fall through to the existing path; Jev can never block news analysis.

**Phase 3 — widening hooks (advisory only):** `analyzeAgreementByConfidence()` buckets Jev-vs-LLM
agreement by Jev confidence so a human can see what agreement WOULD be at candidate thresholds —
read-only, never auto-applies. `GET /api/v2/observability/jev-calibration` (+ `argus jev-calibration`
CLI) exposes scored count, agreement rate, buckets, and cumulative cost. `JevClassificationTask.ts`
is the extension contract for future classification tasks (perfect-data state → single batched
evaluate() → validated mapping); no task is registered, and the contract is classification-only —
never reasoning, recommendations, votes, or trading signals.

**Boundaries (unchanged by this work):** no Jev vote, recommendation, consensus input, RiskEngine input,
OMS access, or broker access. All operational thresholds live in `config/tradingSafety.json` (typed
through `src/server/config/tradingSafety.ts`), never TS literals. All new env fields in `.env.example`
with explanatory comments. 55 Jev tests pass; tsc clean.

## October 6, 2026 — Day-movers-vs-coverage reconciliation (workstream H, local-only)

**Modules:** `src/server/reflection/moverCohort.ts` → `coverageReconciler.ts` →
`dailyReflection.ts` (`runDailyReflection(tradingDate)`); migration `0093`
(`mover_coverage`, `UNIQUE(trading_date, symbol)`). Wired into the post-close
lifecycle as a step in `PostMarketAnalysisWorker.tick()`, right after the
post-market report — runs once per trading date after close, idempotent via the
UNIQUE constraint (plus per-process memoization so an `INSUFFICIENT_EVIDENCE`
cohort does not re-hit the network every tick).

**Problem fixed:** post-market reflection only ever classified symbols Argus had
already touched (survivorship bias) — `TRUE_UNIVERSE_MISS` was unreachable. The
reconciliation builds an **independent EOD benchmark mover cohort** (the day's
real investable-universe movers) and joins every member against the real
discovery/evaluation evidence, so a mover Argus never saw is genuinely
reconcilable as `NEVER_SEEN`.

**Cohort** (`moverCohort.ts`): same-date path uses the same real Alpaca
`/v1beta1/screener/stocks/movers` endpoint the `MarketUniverseScanner` movers
funnel uses (per-side rank preserved for `RANK_CAP` analysis); past-date path
(backfill, e.g. 2026-10-05 — the live screener cannot serve a historical date)
recomputes movers from the same provider's historical 1Day SIP bars over the
tradable-assets universe. Investable screens mirror the funnel's own gates
(price/dollar-volume/spread/ADV, same `config/continuousIntelligence.json`
values — penny/microcap noise excluded per mandate); `eod_move_pct` is always
bar-derived, never the screener's intraday percent_change. No provider keys (or
any provider failure) → `INSUFFICIENT_EVIDENCE`, zero rows, never fabricated
movers.

**Reconciler** (`coverageReconciler.ts`): pure function over an injected evidence
store joining discovery lineage, `transaction_traces`, `risk_assessments`,
`trade_plans`/`trade_plan_revisions`, `premarket_focus_reports`,
`premarket_data_reservations`, `quant_assessments`, `missed_opportunities`,
`trades`/`fills`. Funnel-ordered ladder assigns exactly one `primary_fate`
(`ACTED_ON | APPROVED_NOT_EXECUTED | CONSENSUS_REJECTED | RISK_REJECTED |
STRATEGY_NO_SETUP | EVALUATED | SUBSCRIBED_NOT_EVALUATED | DISCOVERED_FILTERED |
DISCOVERED_NOT_PROMOTED | NEVER_SEEN | INSUFFICIENT_EVIDENCE`) with JSON
`secondary_reasons`. `NEVER_SEEN` causes (`UNIVERSE_COVERAGE |
NEWS_SOURCE_COVERAGE | MARKET_MOVER_SOURCE | RANK_CAP | DATA_UNAVAILABLE |
SYMBOL_EXTRACTION | PREMARKET_REFRESH_TIMING | OTHER | UNKNOWN`) require
positive evidence — `UNKNOWN` is honest, never invented. `premarket_known_by`
records which pre-market surface knew the symbol (`plan0400` / `refresh0915` /
`fastLane` / `discovery`).

**Hook points:** `callOutcomeAudits()` (workstream I — wired 2026-10-06 to
`outcomeAudits.ts`, failure-contained) and `computeSessionMetrics()`
(workstream K — no-op pending the weekly-digest wiring).

**Boundaries (unchanged by this work):** diagnostic only — never emits
`TRADE_IDEA_GENERATED`, never calls ChiefTrader/RiskEngine/OMS/BrokerManager,
never changes the 0.75 consensus bar, independence requirements, RiskEngine
gates, freshness, or capital limits. 43 workstream-H tests pass; tsc clean.

## October 6, 2026 — Post-market reflection outcome audits (workstream I, local-only)

**Module:** `src/server/reflection/outcomeAudits.ts`, entry hook `callOutcomeAudits(tradingDate)`
(intended call site: `dailyReflection.ts`'s `callOutcomeAudits` hook — that file does not exist
yet on main; the hook is exported and ready). **Strictly diagnostic:** never emits trade ideas,
never calls ChiefTrader/RiskEngine/OMS/BrokerManager, never changes the 0.75 consensus bar,
independence requirements, RiskEngine gates, freshness, or capital limits. A filter or risk
rejection that "would have worked" in hindsight is a research observation only — never a reason
to loosen the gate that fired.

**What it audits, per trading date** (reads workstream H's `mover_coverage` table, migration
0093; degrades gracefully to "nothing to audit" until 0093 lands):
1. **Causal outcome windows** — forward moves over +5m/+15m/+30m/+60m/close from recorded
   1-min `ohlcvBars`, anchoring at the decision bar's close (or a stored price-at-decision)
   and EXCLUDING the bar containing the decision timestamp. No same-bar hindsight; bars
   unavailable → null windows, never fabricated. Merged flat into
   `mover_coverage.outcome_windows` alongside workstream H's pre-existing `{eod}` block
   (never destroyed); `secondary_reasons` keeps its JSON-string-array contract with audit
   blocks appended as JSON-encoded string elements (`{kind: 'discoveryFilterAudit' |
   'riskRejectionAudit', ...}`); `premarket_known_by` persists exactly
   `{plan0400, refresh0915, fastLane, discovery}` per H's column contract.
2. **Discovery-filtered audit** — for `DISCOVERED_FILTERED` movers, loads the contemporaneous
   lineage filter reason + evidence from `observability_events` and judges premise correctness
   AT DECISION TIME into `filter_premise_correct` (0/1/null). The judgment function takes only
   (reason, evidence, thresholds) — no outcome parameter exists, so a later rally structurally
   cannot flip the verdict. Thresholds come from `config/continuousIntelligence.ts`, never TS
   literals; unjudgeable cases record null with a basis, never a guess.
3. **Risk-rejected audit** — for `RISK_REJECTED` movers, records rejecting gate(s) from
   `risk_assessments`/`risk_gate_results`, the real decision timestamp, and the reference price
   (stored consensus-evidence price, else decision-bar close) plus outcome windows.
4. **Pre-market effectiveness** — per mover, `premarket_known_by` JSON across plan0400
   (`trade_plans` v1 before the day's first focus report), refresh0915 (focus-report tiers or
   `trade_plan_revisions`), fastLane (`FAST_LANE` observability events), discovery (lineage
   ledger). Measures the incremental value of the ~09:15 refresh.
5. **Data readiness at open** — PRIMARY focus entries classified FRESH / SUBSCRIBED_FRESH_UNKNOWN /
   NO_SUBSCRIPTION_SLOT / RESERVATION_DENIED / RESERVED_BUT_STALE / STALE_QUOTE / RESCUE_DENIED /
   PLAN_NOT_LIVE / UNKNOWN, each with the WHY (joining `premarket_data_reservations`).
   Diagnosis, not a blind 100% target.
6. **Session metrics** — one `reflection_session_metrics` row per date (migration 0094):
   movers_total/seen, focus_recall, primary_data_readiness, catalyst_coverage, never_seen_rate,
   discovery_filter_rate, evaluation_rate (real `quant_assessments`), valid_trigger_rate (real
   `strategy_engine_signals` with entry_met=1), consensus_approval_rate, primary_precision
   (PRIMARY selections that developed a legitimate setup — better discovery, not more symbols).
   Zero denominators yield null, never a masquerading 0%.

**Boundaries:** the only arithmetic is diagnostic return computation on recorded bars (same
category as `PostMarketAnalysis.auditRejectedCandidates`' existing move math — no indicator,
strategy, signal, or portfolio math, so the quant-core-java rule is intact). 19 tests in
`outcomeAudits.test.ts` cover decision-time premise judgment (wide spread + later +20% rally →
still premise-correct), same-bar exclusion, risk-rejection gate/timestamp/reference recording,
04:00-vs-09:15 known-by, readiness classification with failure WHYs, per-date metric persistence
with upsert idempotency, and JSON-contract preservation (string-array secondary_reasons,
4-key premarket_known_by, eod-block merge).

## October 6, 2026 — Daily reflection report surfaces (Part B, workstream J, local-only)

**Module:** `src/server/reflection/reflectionReportService.ts` (pure assembly), read-only
`GET /api/v2/observability/daily-reflection/:date` (`:date` = YYYY-MM-DD or `latest`),
`argus daily-reflection [--date=YYYY-MM-DD]` CLI command, and the TUI "Reflection" page
(`scripts/tui/screens/Reflection.tsx`, key `8`). **Read-only by construction:** SELECTs only
(plus a `sqlite_master` existence check), never writes, never touches ChiefTrader/RiskEngine/
OMS/BrokerManager, never carries a direction/side. Explains what happened — never what to trade.

**Sources** (all fail-soft; a missing producer table yields an honest empty section, never
fabricated rows): workstream H's `mover_coverage` (migration 0093), workstream I's
`reflection_session_metrics` (migration 0094), `premarket_focus_reports` (workstream D),
`postmarket_reports`. Eight sections: PREMARKET FOCUS PERFORMANCE (tier counts, missing
inputs), DISCOVERY COVERAGE (movers → seen → evaluated → acted funnel + fate histogram +
workstream-I rate scorecard), NEVER-SEEN MOVERS (with `never_seen_cause`), FILTERED
WINNERS-LOSERS (filter-centric: `filter_premise_correct=false` = "filtered winner", never an
invented return threshold), CONSENSUS REJECTIONS, RISK REJECTIONS, DATA-READINESS FAILURES,
CATALYST COVERAGE. Rejection sections take the primary fate first and fall back to
secondary-reason text only when the reason carries rejection vocabulary — a bare topic mention
(e.g. `CONSENSUS: 0.81 > 0.75`, a pass note) never counts as a rejection. Repeating issues are
derived observed patterns only (e.g. a never-seen cause hitting ≥2 movers); issue text is never
invented. Fate taxonomy is workstream H's exact `primary_fate` set (ACTED_ON /
APPROVED_NOT_EXECUTED / CONSENSUS_REJECTED / RISK_REJECTED / STRATEGY_NO_SETUP / EVALUATED /
SUBSCRIBED_NOT_EVALUATED / DISCOVERED_FILTERED / DISCOVERED_NOT_PROMOTED / NEVER_SEEN /
INSUFFICIENT_EVIDENCE); unknown values parse to UNKNOWN and count as unseen.

**Surfaces:** the CLI is presentation-only (calls the service, prints
`formatDailyReflectionReport` or raw JSON with `--json`); the TUI page shows the funnel, the
top-movers table with fate badges, blind spots, repeating issues, and a keyboard drill-down
(↑/↓ select, Enter, Esc) to per-symbol fate/secondary-reasons/outcome-windows/premarket_known_by.
The TUI imports only React/Ink plus its own presentation modules (enforced by
`reflection.imports.test.ts` alongside the existing architecture-protection test).

**Tests:** 11 service tests (all 8 sections from fixtures, honest empty states, invalid-date
rejection, never-mutates via full row-count snapshot), 3 route smoke tests, 4 TUI import/path
tests. `tsc --noEmit` clean.

## October 6, 2026 — Weekly reflection digest + taxonomy cleanup + reflection architecture tests (Part B, workstream K, local-only)

**Modules:** `src/server/reflection/weeklyDigestAggregate.ts` (pure, zero imports),
`src/server/reflection/weeklyDigest.ts` (DB layer: read week's COMPLETED `postmarket_reports`,
aggregate, upsert). **Diagnostic only**, same safety contract as the daily reflection
surfaces: never imports RiskEngine/OMS/BrokerManager, never emits TRADE_IDEA_GENERATED /
CHIEF_APPROVED_IDEA, writes only to its own `weekly_reflection_digest` table (migration
0095: `week_start`, `pattern_key`, `occurrences`, `symbols` JSON, `first_seen`, `last_seen`,
UNIQUE(`week_start`, `pattern_key`)).

**Recurrence gate:** a pattern enters the digest only after occurring on >= 2 distinct
trading days in the week (`DEFAULT_MIN_OCCURRENCES`, configurable per call) — a one-day
anomaly is never promoted to an architecture-level conclusion. Pattern keys derive only
from real daily-report evidence: blind-spot `patternKey`s, `FILTER_<reason>` (discovery
filter reasons, e.g. `FILTER_RANK_CAP`), `FATE_<classification>` (per-symbol fate
distribution), `NO_FRESH_DATA` (real NEWS_IDEA_DISCARDED_NO_FRESH_DATA events),
`FAILURE_<category>` (narrative failure categories, excluding NONE),
`AUDIT_<verdict>` (rejected-candidate audits), `UNIVERSE_MISS_<cause>` (workstream H's
`never_seen_cause`). Per-pattern symbol lists (capped at 50) and first/last-seen dates.

**Taxonomy cleanup (same change):** `RANKING_MISS` removed from `MissClassification`
(dead — in the union but `classifyMiss()` never returned it, and the module's own
anti-hindsight governance forbids any honest producer; removal documented in-code with
reintroduction conditions). `TRUE_UNIVERSE_MISS` in PostMarketAnalysis is now genuinely
populated: `readNeverSeenMovers()` reads workstream H's `mover_coverage` NEVER_SEEN rows
(migration 0093) into findings (a symbol with any discovery event is never mislabeled
never-seen; absent table degrades to zero, never fabricated). Full fate/reason inventory
audited in-code (PostMarketAnalysis.ts taxonomy comment): every code classified
USED / IMPLEMENTED_BUT_UNREACHED / DEAD / DUPLICATE; no duplicate merges were needed —
the candidate overlaps (CORRECT_NON_ACTION vs FILTERED_OTHER, RISK_REJECTION vs
RISK_NOT_CONFIRMED, mover primary_fate vs MissClassification) are genuinely distinct
populations and documented as such.

**Tests:** `reflectionSafety.test.ts` — 6 tests proving reflection is diagnostic-only: (a)
no BrokerManager/OMS/placeOrder imports (static scan), (b) no emitTradeIdea /
CHIEF_APPROVED_IDEA, (c) write-table allow-list (weekly_reflection_digest,
reflection_session_metrics, mover_coverage only), (d) no consensus/agent-weight/
RiskEngine/tradingSafety mutation, (e) single-occurrence patterns never promoted;
`weeklyDigestAggregate.test.ts` — 13 unit tests (recurrence, key derivation, caps,
determinism); `weeklyDigest.persistence.test.ts` — 2 tests (migration applies, end-to-end
recurrence, RUNNING reports excluded, upsert idempotent); `PostMarketAnalysis.universeMiss.test.ts`
— 3 tests (TRUE_UNIVERSE_MISS genuinely populated with real cause; seen symbols not
mislabeled). Existing PostMarketAnalysis (18) + MissedOpportunityDetector (30) + Detector
persistence (8) suites pass unchanged after the taxonomy edits.
