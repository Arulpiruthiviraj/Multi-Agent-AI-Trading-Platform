# ARGUS_PRE_IMPLEMENTATION_BASELINE.md

**Historical Phase 0 snapshot.** Later work extracted many thresholds into `config/tradingSafety.json`
and related JSON files. Do not treat hardcoded constants listed below as current source of truth —
verify against `config/` and the modules named in `ARGUS_CURRENT_ARCHITECTURE_MAP.md`.

**Phase 0 deliverable only.** No production trading code has been modified to produce this
document — it is a read-only baseline, built from `FINAL_ANALYSIS.md` Section 30 (the current
ground-truth audit, produced via five independent call-chain traces plus direct source verification)
and fresh re-verification run today: `npx tsc --noEmit` clean, `npx vitest run` → **94 test files /
667 tests passing**. Per the explicit instruction this baseline was requested under, **no Phase 1+
implementation begins until this document is reviewed and approved.**

Working-tree note: `git status --short` currently shows 187 uncommitted paths on top of commit
`8b6e476` — this reflects the cumulative work of this session and prior sessions (the additive quant
layer, the E1-E7 backtest/quant hardening pass, and this audit's own new documents), none of it yet
committed. This baseline describes the *working tree as it stands*, not a specific commit.

---

## A. Current Architecture

Single Node.js process (`server.ts`, ~3,050 lines): Express + Vite dev middleware (dev) or static
serving (prod), plus a raw `ws` WebSocket server. Frontend is a single ~11K-line React SPA
(`src/App.tsx`). Two structurally separate execution paths exist and share no state:

1. **Real EventBus-driven pipeline** (the one this baseline and all 15 planned phases concern
   themselves with): independent agents emit `TRADE_IDEA_GENERATED` → `ChiefTraderAgent` aggregates
   into `CHIEF_APPROVED_IDEA` → `RiskAgent` forwards unconditionally to `RiskEngine.evaluateRisk()`
   → `RISK_ASSESSMENT_COMPLETED` → `OrderManagementService` → a real broker adapter → `trades`/`fills`
   tables → WebSocket broadcast to the frontend.
2. **Legacy `/api/v1/signals` endpoint** — now a deprecated stub returning a fixed
   `{decision:"HOLD"}` regardless of input. Still called by one frontend widget (Trading Arena's
   "Swarm Decision Outcomes," confirmed broken). Out of scope for the 15-phase plan; not to be
   revived or extended.

`better-sqlite3` + Drizzle ORM, WAL mode, 30 tables. Migrations run automatically on
`src/server/db/index.ts` import (never run `npm run db:migrate` — that script targets a path that
doesn't exist).

## B. Current Live Decision Pipeline

```
Market data (Alpaca WS, MarketDataWorker.ts)
  → TechnicalAgent.ts (real RSI/MACD/SMA/Bollinger, always on)
  → NewsEngine.ts (real RSS+paid APIs, always on)
  → FundamentalAgent.ts (real AlphaVantage+AIRouter, 60s timer, 3 hardcoded symbols)
  → MacroAgent.ts (real AlphaVantage+AIRouter, 75s timer, 3 hardcoded symbols)
  → PortfolioMonitor.ts (real, 60s timer, exit-only — now settings-driven as of this session)
  → QuantSignalAgent.ts (5 real quant strategies, 5-min timer — QUANT_ENGINE_ENABLED=true in this
    repo's ACTUAL .env right now, contributing live evidence today, despite .env.example's
    documented false default)
        ↓ eventBus.emit('TRADE_IDEA_GENERATED', {traceId, symbol, side, confidence, reasoning, agent, currentPrice?})
ChiefTraderAgent.ts
  → EvidenceAggregator.aggregate(): weighted vote, 0.5x disagreement penalty, HOLD excluded from
    both numerator and denominator — not raw vote-counting
  → Beta-Binomial confidence calibration (real, ConfidenceCalibration.ts, prior strength 10)
  → optional AI debate (adversarialDebateMode=true by default, fires when confidence>0.6) — real
    AIRouter call, fire-and-forget, NO TIMEOUT anywhere in the AI stack (confirmed, §30.8)
  → approves only if confidence > 0.75 (hardcoded CONSENSUS_APPROVAL_THRESHOLD, not configurable)
        ↓ eventBus.emitChiefApproval() → 'CHIEF_APPROVED_IDEA'
RiskAgent.ts → RiskEngine.evaluateRisk() — forwards UNCONDITIONALLY, no pre-filtering
  → 16 gates, first-failure-wins, FAILS CLOSED on internal exception (verified by direct read of
    the catch block, RiskEngine.ts:374-388)
        ↓ eventBus.emitRiskAssessment() → 'RISK_ASSESSMENT_COMPLETED'
OrderManagementService (the ONLY listener that places orders — confirmed structurally, no bypass
exists anywhere in this codebase)
  → BrokerManager.getActiveBroker().placeOrder() → AlpacaBroker (no timeout, no retry — §30.11)
  → db.insert(trades) + eventBus.emit('ORDER_EXECUTED', ...) → WebSocket broadcast
```

**Structural guarantee, independently confirmed**: no code path can place an order without passing
through `RiskEngine.evaluateRisk()` first, including the manual-override route
(`POST /api/v2/trading/execute-override`), which emits the identical `CHIEF_APPROVED_IDEA` event
through the identical chain. Do not build any new "fast path" that skips this in later phases.

## C. Current Risk Pipeline

`RiskEngine.ts`, 16 real gates, exact order (see `FINAL_ANALYSIS.md` §30.9 for the full table with
file:line references, not reproduced in full here to avoid drift between two copies of the same
table): `emergency_stop` → `daily_loss` (80% of `settings.dailyLossLimit`) → `consecutive_loss` (3,
hardcoded) → `portfolio_drawdown` (`settings.maxPortfolioDrawdownPct`, default 15%, real persisted
high-water-mark) → `order_rate_limit` (`settings.maxOrdersPerMinute`, default 5) → `market_hours`
(Alpaca `/v2/clock`; **known gap: a REST failure returns `null`, which passes the gate — an outage
is treated as "open," not "unknown"**) → `data_freshness` (5 min; **known gap: a symbol that has
never ticked reports `null` age, which silently passes**) → `news_veto` (`impactScore>80`, 4h
window) → `price_validity` → sizing gates (`order_notional_cap` — `FIXED_DOLLAR` $3,000 default or
opt-in `PERCENT_OF_EQUITY`, `symbol_concentration` 20%, `open_positions_cap`, `sector_concentration`
40%, `correlation_exposure` 50%/corr>0.7) → `sell_position_exists` (SELL only) → `sufficient_size`.

**This gate ladder passed structural review in the current audit and is the one component this
15-phase plan should touch the LEAST** — Phase 1's reconciliation fix must route through
`TradingEngine.setTradingState()`, which the `emergency_stop` gate already correctly reads; it does
not require changing the gate ladder itself.

## D. Current Broker Pipeline

`BrokerManager.ts` (singleton) → `AlpacaBroker.ts` (the only broker capable of running fully
unattended; IBKR needs human 2FA ~every 24h; Questrade/Coinbase order placement are non-functional
by design, not bugs). Real, confirmed gaps (§30.11, independently re-verified by two research
passes this audit):

- **No request timeout anywhere** — `AlpacaBroker.fetchAlpaca()` uses raw `fetch()`, no
  `AbortController`. A hung call blocks indefinitely.
- **No retry/backoff/429 handling** — any Alpaca failure, including a rate limit, propagates
  straight to a thrown error, which `OrderManagement.ts` turns into `REJECTED`.
- **Real, working idempotency** — DB-level `uniqueIndex` on `trades.traceId`
  (`schema.ts:240`) + a fast-path check, verified against a genuine concurrent race in
  `OrderManagement.lifecycle.test.ts`. **Do not weaken this in Phase 1's timeout/retry work** — any
  retry logic added must reuse this existing idempotency key, never mint a new one per attempt.
- **Real, working partial-fill aggregation**, with a **hard give-up**: `followUpOpenOrders()` polls
  every 15s from 6s to 30 minutes old, then permanently stops touching that order at its
  last-known non-terminal status. No other job ever revisits it.
- **Real backend cancellation** (`POST /api/v2/trading/cancel-order/:id`), unreachable from any
  frontend UI.
- **No order-level crash reconciliation** — `PortfolioReconciliation.ts` checks *positions* only,
  never orders. `TransactionStatus` has an unused `'RECONCILED'` enum value nothing ever sets — a
  real sign this was anticipated but never finished, and the most direct hook for Phase 1's
  crash-recovery work.
- **Unrecognized broker status falls through silently** — `TERMINAL_ORDER_STATUSES =
  ['FILLED','REJECTED','CANCELED']`; real Alpaca statuses like `DONE_FOR_DAY`/`REPLACED`/`EXPIRED`/
  `STOPPED` are treated as still-open with no alert.

## E. Current Backtest Pipeline

`BacktestEngine.ts`, two real entry points sharing the same cost/sizing infrastructure
(`Commissions.ts`, `Slippage.ts`, `ReplayClock.ts`, `PositionSizing.ts`):

- **`run()`** — the original deterministic technical strategy (inline SMA/RSI/MACD/Bollinger,
  duplicated from — not reused from — `TechnicalAgent.ts`'s live rules; a real, previously-flagged
  duplication risk). Real corporate-action detection (`checkForUnadjustedCorporateActions()`) halts
  the run rather than corrupting P&L on an unadjusted split — this is why AAPL/NVDA/TSLA are
  excluded from this session's baseline runs, not a gap.
- **`runStrategyBacktest()`** — added this session, backtests the 5 real `quant/strategies/`
  strategies individually per symbol, with real regime segmentation, real backtest-derived EV/Kelly,
  real failure classification, real benchmark comparison, and optional decision-trace logging.
- **`WalkForwardValidator.ts`** — pre-existing but had zero test coverage until this session;
  extended this session to also drive `runStrategyBacktest()` (previously `run()`-only).
- **Known, real, un-fixed live/backtest parity gaps** (§30.15, directly relevant to Phase 2):
  RiskEngine's daily-loss/consecutive-loss/drawdown/order-rate/market-hours/staleness/news-veto
  gates are **not simulated in either backtest entry point at all** — only the sizing/concentration
  math is; and a quant strategy's backtest credits its own per-strategy stop/target logic, but a
  live position from that same signal actually exits under `PortfolioMonitor`'s generic
  settings-driven thresholds, not the strategy's own logic. **These two gaps are Phase 2's real
  scope**, not a hypothetical.
- **Backtest never simulates partial fills** (fills in full at signal-bar-close + slippage) —
  live can partially fill; backtest never does. A one-directional, documented gap.

## F. Current AI Pipeline

`AIRouter.ts` (singleton) wires Gemini/DeepSeek/OpenAI/Nvidia/OpenAI-compatible (covers
Grok/OpenRouter/Ollama at `http://localhost:11434/v1`). Real sequential failover in `routeTask()`;
real parallel aggregation in `routeConsensus()`. Real output validation/coercion
(`AIOutputValidator.ts`) at every parse site (`NewsScoringEngine.ts`, `FundamentalAgent.ts`,
`MacroAgent.ts`, `AIRouter.ts`'s own consensus parse) — malformed AI output degrades to safe
defaults (HOLD/NEUTRAL/0-confidence), **never a fabricated BUY/SELL**, closing the exact bug class
(`tradingBias==='BULLISH'?'BUY':'SELL'`) an earlier hardening pass found and fixed for real.

Confirmed, real, current gaps (§30.8, independently found by two research passes):

- **Zero timeout anywhere** in `AIRouter.ts` or any provider file.
- **Zero hallucination protection** — `MarketDataCrossChecker.ts` only cross-checks raw *price*
  (Alpaca vs Questrade), never AI output.
- **Zero reproducibility control** — no temperature/top_p/seed set anywhere.
- **`AIRouter.test.ts` does not exist** — the failover loop, parallel-consensus aggregation, and
  provider health tracking have no direct unit coverage.
- **Zero historical AI backtesting, ever** — `BacktestEngine.ts` has zero references to
  `AIRouter`/`routeTask`/any LLM call, confirmed by direct grep.
- Local stack: Ollama (checked non-blockingly at boot) and a local Chronos forecasting service
  (`KronosForecastAgent`/`KronosModelManager`, polls `/health` every 30s) both real, but
  `KronosForecastAgent`'s actual live contribution to `agentWeights` (weight 0.20) was **not
  independently re-traced this pass** — marked `UNVERIFIED`, worth a direct check before Phase 7.

## G. Current QuantEngine Pipeline

`src/server/quant/` — real, additive, off by default in `.env.example` (`QUANT_ENGINE_ENABLED=false`)
but **on in this repository's actual running `.env` today** (`true`). Real regime classification
(`RegimeEngine.ts`, multi-signal, never a single indicator), real market context (SPY/QQQ/IWM/sector
relative strength), 5 real strategies with explicit entry/invalidation logic, real correlation-aware
scoring (`GroupedScores.ts` — blends correlated oscillators into one reading, exactly avoiding the
"RSI=vote, MACD=vote" trap Phase 5 of the new plan also warns against; **this component already
satisfies Phase 5's architecture**, not a gap to build), real backtest-derived EV/Kelly
(`ExpectedValue.ts`, refuses below 20 real trades, hard-caps suggested size at 10%; **this component
already satisfies most of Phase 6**), one real AI integration point that can record disagreement but
never overwrite a deterministic value (`QuantContradictionAnalyzer.ts`).

**This session (E1-E7) added**: selectable sizing mode, settings-driven exit thresholds, opt-in
decision-trace logging, real failure classification, walk-forward extended to quant strategies, real
Monte Carlo scenario analysis (bootstrap, always labeled as such), real benchmark comparison, honest
small-account reporting.

**The one real out-of-sample check ever run on this layer** (this session, on its own two
highest-Sharpe results) **failed**: OOS return collapsed to 11-21% of in-sample. This is the central
fact the entire 15-phase plan's Phase 4/5/15 work must not talk around.

## H. Current Persistence / Reconciliation Model

`PortfolioReconciliationWorker` (`src/server/services/PortfolioReconciliation.ts`) — real, runs on
boot and every 5 minutes, compares `broker.portfolio().positions` against the local `portfolio`
table, real re-entrancy guard, real auto-correction (broker treated as source of truth), real
persistence to `reconciliation_events`/`portfolio_snapshots`.

**The Phase 1 target, precisely**: for a mismatch ≥$100, the code sets
`tradingEngine.state.emergencyStopActive = true` **directly**, bypassing `setTradingState()`.
`RiskEngine.ts`'s real `emergency_stop` gate reads `tradingEngine.state.tradingState`, never
`emergencyStopActive`. **The "pauses trading" claim in the reconciliation code's own comments does
not reach the real gate — verified by tracing both sides to source.** This is the audit's single
most important finding and Phase 1's first, highest-priority fix.

Also confirmed: **only positions are reconciled.** `Portfolio.cash`/`.buyingPower` exist on the
broker interface and are never read by the reconciliation worker. No open-broker-order
reconciliation exists anywhere. No filled-order-vs-`trades`-table reconciliation exists anywhere.
These three gaps are Phase 1, item 4's real scope.

## I. Current Test Coverage

Re-verified fresh today: `npx tsc --noEmit` clean; `npx vitest run` → **94 test files / 667 tests
passing**. Real coverage exists for: RiskEngine gates and concurrency (incl. `PositionSizing.ts`'s
sizing math and its new `FIXED_DOLLAR`/`PERCENT_OF_EQUITY` modes), `OrderManagement` idempotency/
partial-fill-aggregation/cancellation (but NOT timeout/crash-recovery/unknown-status/rate-limiting —
zero tests exist for any of those four), `ChiefTraderAgent` consensus + Beta-Binomial calibration
(with `AIRouter` mocked — the real debate-hang risk is untested), backtester parity infrastructure
(`Commissions.ts`/`Slippage.ts`/`ReplayClock.ts` look-ahead guard), the full quant layer, and this
session's new `WalkForwardValidator.test.ts`/`FailureClassification.test.ts`/`MonteCarlo.test.ts`/
`AccountSizeReport.test.ts`/`PortfolioMonitor.test.ts`/`BacktestEngine.exitThresholds.test.ts`.

**Real, zero-coverage gaps directly relevant to the phases ahead**: `AIRouter.test.ts` does not
exist (Phase 7); no test exercises a hung/timed-out broker or AI call (Phase 1, Phase 7); no test
exercises order-level crash recovery (Phase 1); no test exercises the reconciliation
mismatch→trading-actually-blocked path end-to-end (Phase 1, item 1's own explicit requirement); no
chaos-style test suite exists at all (Phase 11).

## J. Current Failure/Recovery Behavior

Summarized from `FINAL_ANALYSIS.md` §30.20 (full table there). **Safe**: duplicate market-data
events, duplicate orders, clock/timezone handling (real IANA `America/New_York` trading-day
boundary, DST-tested), malformed AI responses (coerced to safe defaults). **Recoverable**: process
crash/restart (kill-switch state persists; reconciliation runs immediately on boot), WS disconnect
(fixed 5s retry forever, no backoff cap — crude but functional), AI provider outage (real failover
exists, though untested at the router level). **Potentially dangerous**: broker unavailable (no
downstream consumer of disconnect events; `market_hours` gate treats a REST failure as "open"), API
rate limits (unhandled for both Alpaca and every AI provider). **CRITICAL**: API timeout for either
broker or AI calls (zero timeout anywhere in either stack — an agent tick or an order submission can
hang indefinitely); server restart during order submission (no mechanism reconciles an order that
reached Alpaca but was never recorded locally).

**RiskEngine itself fails closed on internal exception** — verified by direct read of
`RiskEngine.ts:374-388`'s catch block. This is the one piece of "fail-safe by default" behavior this
baseline can assert with full confidence; the phases ahead should extend this same posture
(fail-closed, not fail-open) to the broker/AI/reconciliation gaps above, not invent a different
failure philosophy.

---

## Known Bugs (confirmed, current)

1. **CRITICAL** — Portfolio reconciliation's mismatch-pause does not reach the real RiskEngine gate
   (§H above / audit §30.12).
2. Unrecognized broker order status silently treated as still-open indefinitely (§D above).
3. `TransactionStatus.RECONCILED` enum value exists and is never set by any code path (§D above).
4. AI-debate injection uses a hardcoded 0.5/0.8 confidence value the code's own nearby comment flags
   as a possible 50/80-vs-0-1 scale bug (`ChiefTraderAgent.ts` — noted in the ChiefTrader research
   pass this audit, not yet independently re-verified against a live run this baseline).

## Known Limitations (by design, not bugs — do not "fix" these without a separate explicit decision)

- Fractional shares unsupported by any broker adapter in this codebase.
- Interactive Brokers requires human 2FA ~every 24h — not fixable in software.
- Questrade/Coinbase order placement are non-functional by design (regulatory/unbuilt, respectively).
- L2 market depth has no real data source anywhere in this codebase.
- The backtester does not, and per its own module header was never scoped to, replay the live
  AI-agent consensus pipeline against historical data — only the deterministic technical strategy
  and, as of this session, the quant strategies.

## Current Test Count

94 test files / 667 tests, all passing, re-verified today.

## Current Backtest Results (real, this session, reused not re-run — nothing in the underlying
strategy logic changed since generation)

SPY+QQQ+MSFT+AMD, 2018-01-01 to 2025-12-31, $100,000, `BacktestEngine.run()`: +14.91% total return,
50.9% win rate, 165 closed trades, Sharpe 0.51, max drawdown 3.54% — underperforms real SPY
buy-and-hold (+165% over the same window) by a wide margin. Per-strategy quant results and the
walk-forward OOS failure: `BASELINE_RESULTS.json` / `WALKFORWARD_CHECK_RESULTS.json` (this session),
summarized in `FINAL_ANALYSIS.md` §30.7/§30.17.

## Current Strategy Behavior

See Section G above and `FINAL_ANALYSIS.md` §30.6's full strategy inventory table. Headline: every
strategy capable of influencing a real order today is statistically unvalidated; the only one
formally out-of-sample tested failed that test.

## Current Broker Behavior

See Section D above.

## Current AI Behavior

See Section F above.

## Current Risk Behavior

See Section C above.

## Current Paper-Trading Behavior

Real and functional — AutoBot has run continuously in PAPER mode with real per-agent consensus live
end-to-end (documented in this file's own original Section 1). **No long-duration, large-sample real
paper-trading track record with a formal before/after-cost report is documented anywhere in this
repository's history** — this is Phase 10's actual scope, not yet started, and cannot be fabricated
or estimated from the backtest numbers above.

---

## Files That Will Be Modified (planned, by phase — none touched yet)

This is a forward-looking map for Phases 1+, grounded in the evidence above. It will be revisited
and corrected at the start of each phase, not treated as a fixed contract signed today.

| Phase | Likely files |
|---|---|
| 1 (P0 safety) | `PortfolioReconciliation.ts` (route the pause through `TradingEngine.setTradingState()`), `TradingEngine.ts` (possibly a new `TRADING_PAUSED`-style state transition reason, reusing the existing `tradingState` enum rather than inventing a new field), `AlpacaBroker.ts` (timeouts, retry-with-backoff reusing the existing idempotency key, never a new one per attempt), `OrderManagement.ts` (startup/periodic order-level reconciliation against real Alpaca order state), `PortfolioReconciliation.ts` (extend to cash/buying-power/open-orders), `schema.ts` (if a new reconciliation-tolerance or order-recovery table is needed — additive only), new test files for all of the above |
| 2 (parity) | New `LIVE_BACKTEST_PARITY_SPEC.md` (documentation only); likely `BacktestEngine.ts` and/or `PortfolioMonitor.ts` to close the two real gaps in §E above — exact scope to be decided at Phase 2's own start, not pre-committed here |
| 3 (QuantEngine backtest) | **Largely already done this session** (`runStrategyBacktest()`) — Phase 3's real remaining scope is verification/extension, not net-new construction |
| 4 (walk-forward) | **Largely already done this session** (`WalkForwardValidator.ts` extended) — real remaining scope is applying it more broadly and adding bootstrap/permutation statistics on top |
| 5 (strategy selection) | **Architecture already exists** (`GroupedScores.ts`) — real remaining scope, if any, is verification that live `ChiefTraderAgent` consumption matches this design, not new construction |
| 6 (EV engine) | **Already exists** (`ExpectedValue.ts`) for the quant layer; the deterministic `TechnicalAgent` path has no equivalent EV/Kelly layer — that gap, if addressed, is genuinely new work |
| 7 (AI reliability) | `AIRouter.ts` (timeout, circuit breaker), all files in `src/server/ai/providers/`, new `AIRouter.test.ts` |
| 8 (AI decision logging) | Likely additive columns/tables alongside the existing `event_traces`/`consensus_decisions`/`consensus_evidence` (Transaction Observatory) rather than a parallel system — exact scope to be decided at Phase 8's own start |
| 9 (historical AI validation) | New, staged, multi-session work — no files identified yet |
| 10 (paper trading validation) | New report generation tooling reading existing `trades`/`risk_assessments`/`event_traces` tables — likely no schema change |
| 11 (chaos testing) | New test files only |
| 12 (monitoring/alerting) | New alerting mechanism (email/webhook/etc. — channel TBD), hooking into existing `RECONCILIATION_MISMATCH`/`MARKET_DATA_DISCONNECTED`/emergency-stop events, which already exist and already fire — the gap is a real subscriber, not new event infrastructure |
| 13 (restricted live mode) | Likely `RiskEngine.ts` (an additional mode-aware gate) and `settings` schema (a new mode flag) — additive |
| 14 (capital/sizing) | **Largely already exists** (`PositionSizing.ts`'s two modes, `AccountSizeReport.ts`) |
| 15 (final readiness score) | New report only |

## Files That Will Remain Untouched (explicit, for every phase)

- `src/server/quant/strategies/*.ts` (the 5 strategy implementations) — evaluated, never rewritten,
  per every phase's own "do not optimize until validated" rule.
- `RiskEngine.ts`'s gate ladder and gate order — extended (Phase 13 may add a mode-aware gate) but
  never removed or reordered; no phase requires weakening any existing gate.
- `ChiefTraderAgent.ts`'s `EvidenceAggregator`/consensus math — real, tested, correctly avoids
  vote-counting already; not in scope for any phase above.
- `BrokerManager.ts`'s broker-selection/capability-gating logic.
- `Commissions.ts`, `Slippage.ts`, `ReplayClock.ts` — reused as-is by every backtest phase.
- The frontend (`src/App.tsx`, `src/components/`) — none of the 15 phases are frontend work; the
  9-13 broken/mocked tabs documented in the current audit are explicitly out of this plan's scope
  unless a later phase says otherwise.
- `archive/python-platform/` — disconnected, not touched by anything in this codebase.

---

**End of Phase 0 deliverable. Awaiting review before Phase 1 begins**, per the explicit instruction
this document was produced under.
