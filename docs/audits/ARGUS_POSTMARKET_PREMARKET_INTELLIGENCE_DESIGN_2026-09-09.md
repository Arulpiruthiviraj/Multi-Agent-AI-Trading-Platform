# Argus — Post-Market Analysis + Premarket Intelligence: Audit & Design (2026-09-09)

**Status: Phase 0 (architecture/design only). No code was changed for this document.** Requested by the
operator as a senior-architect audit-and-design pass, explicitly "do not immediately start coding."
Everything below is grounded in either (a) direct code/DB inspection this session, or (b) a dedicated
read-only research pass (see §Methodology). Anywhere evidence was incomplete, it's marked **NOT
VERIFIED** rather than guessed — per the operator's own instruction not to assume a component exists
because documentation claims it.

**Governing constraint, repeated because it's the whole point:** this subsystem is
`OBSERVATION → ANALYSIS → DIAGNOSIS → RESEARCH RECOMMENDATION`, never
`OBSERVATION → AUTOMATIC STRATEGY CHANGE → TRADE`. It must never import or call RiskEngine, OMS,
BrokerManager, or ChiefTraderAgent, never call `emitTradeIdea` or `placeOrder`, and never auto-change
agent weights, risk limits, or strategy parameters. Every recommendation in §7 is a proposal for a
*separate* human/research review, not something this system applies to itself.

## Methodology

A dedicated read-only research pass (isolated worktree, no file writes) inspected 24 named areas of
the live codebase and queried the live `data/argus.db` directly (read-only) for real row counts and
date ranges. Its full findings are folded into §1-§6 below with exact file/line citations preserved.
Additionally reused, without re-deriving, work already directly verified earlier in this same session:
`MissedOpportunityDetector.ts`, `MissedOpportunityEvaluator.ts` (a real gap found and fixed this
session — see §1.9), `TradePlanBuilder.ts`, `SnapshotScanner.ts`, `ComposableRanking.ts`,
`ChiefTraderAgent.ts`'s consensus math, `PredictionOutcomeEvaluator.ts`, `gracefulShutdown.ts` /
`SystemBootstrap.ts`'s worker-registration pattern, and the JSON-config-plus-typed-loader pattern
(`continuousIntelligence.ts` / `tradingSafety.ts`).

---

## §1. Current Argus architecture relevant to this feature

Organized by pipeline stage, not by the audit's original 24-item order (easier to design against).

### 1.1 Market data (live + historical)
- **Live ticks**: `src/server/services/MarketDataWorker.ts`. Alpaca WS → `lastTick: Map<string,
  {timestampMs, price}>` (in-process memory, not persisted per-tick — high-frequency ticks are
  sampled, per `config/observability.json`'s `marketDataPersist`). Safe to *read* getters from a new
  feature; never import the class to mutate it — it's already a load-bearing singleton for RiskEngine
  gate 13.
- **Historical bars**: `ohlcv_bars` table, read via `HistoricalDataGateway.ts` (`getBars`/`ensureBars`
  — the exact same real-bars pattern `PredictionOutcomeEvaluator.ts` and the newly-fixed
  `MissedOpportunityEvaluator.ts` both use). **Live inventory, queried directly this session:
  232,787 rows total** — `1Day`: 171,525 rows / 599 symbols / Jan 2018–Sep 2026; `1Min`: 61,085 rows /
  224 symbols / ~last 25 days only; `5Min`: 177 rows / **1 symbol** (not a usable dataset, a stub).
  **This is the single biggest data-availability constraint on the whole design** — see §4.

### 1.2 News, fundamentals, macro
- `NewsEngine.ts`: adaptive cadence, 10s in RTH / 300s off-hours (`config/runtimeIntervals.json`
  `newsEngineMs`/`newsEngineOffHoursMs`) — confirms CLAUDE.md's claim exactly. Writes
  `news_clusters` (`articleCount`, `sourceCount`) and `news_predictions` (`stagingStatus`:
  `ACTIVE`/`STAGED_FOR_OPEN`/`EXPIRED`/`CONSUMED`).
- `FundamentalAgent.ts` (60s), `MacroAgent.ts` (75s): both real AlphaVantage calls behind a shared
  budget/backoff (`AlphaVantageBudget`). `MacroAgent.ts` is also the **only** live consumer of
  `FinceptCacheAdapter` — see §1.8.

### 1.3 Idea generation → decision → execution (the protected spine — read-only for this feature)
- `TechnicalAgent.ts` (event-driven off ticks, real debounce via indicator state-transitions, not
  just a wall-clock cooldown), `agent_predictions` (graded-prediction ledger) and
  `agent_reasoning_logs` (per-decision reasoning, part of the 7-table trace join) are both written
  before consensus resolves.
- `ChiefTraderAgent.ts`: consensus math already verified this session (STRONG 0.75 bar / MODERATE
  tier via `ModerateTierEvaluator.ts` / `terminalReasonCode` classification). **New finding this
  pass**: the class registers two `setInterval`s at module-load (`recordUnresolvedAsNoConsensus`
  every 60s — writes `consensus_decisions`/`consensus_evidence`; `syncWeights` every 10s) that are
  **not stopped by `gracefulShutdown.ts` or `SystemBootstrap.stop()` anywhere** — the same failure
  shape as the already-fixed DEF-27, on a component that fix's enumeration missed.
  `AIProviderHealthCheck.ts`'s health-monitor interval has the same gap (lower severity — appears
  in-memory only). **Flagged, not fixed, per this phase's own "no code changes" instruction — see
  §16 recommendation to open this as a follow-up defect.**
- `RiskEngine.ts` (25 gates, `evaluationQueue` mutex), `OrderManagement.ts` (sole `.placeOrder(`
  caller, `clientOrderId` idempotency), `trades`/`fills`/`portfolio` tables, `PortfolioReconciliation.ts`
  (5-min cadence, `autoFlattenOnReconciliationMismatch` confirmed `false`-gated in code, never
  stopped by `SystemBootstrap.stop()` by design — only by `gracefulShutdown.ts`).
- `omsEntryPrice.ts` computes real per-trade `profit_loss` from a pre-trade entry-price snapshot
  (never a nearest-timestamp proxy). `daily_trading_summary` / `daily_strategy_performance` exist
  for rollups — **writer of `daily_trading_summary` NOT VERIFIED this pass.**

### 1.4 Reflection, calibration, performance tracking
- `ReflectionEngine.ts`: 60s cadence (confirmed), updates `agent_performance_stats.currentWeight`
  via a bounded step gated on *effective* (autocorrelation-clustered) sample size. Two independent
  `learned_rules` writers (organic-loss-triggered, structurally near-never fires; and
  `generateCalibrationInsightRules()`, Wilson-upper-bound-below-chance triggered, 24h/agent cooldown)
  — both text-only, debate-prompt-only.
- `agent_performance_stats` already carries `winRate, averageReturn, profitFactor, sharpeRatio,
  effectivePredictions, effectiveCorrect, wilsonLower, wilsonUpper, evidenceStatus, currentWeight` —
  but it's a **live running value, not date-partitioned**. There is no table that preserves
  "agent X's stats as of trading day Y" — a real gap for the rolling 5/20/50/100-session analysis
  Phase 17 of the request wants (see §8).
- `ModelPerformanceTracker.ts` computes real win rate per bucket; **whether it also computes
  profit factor/expectancy is NOT VERIFIED this pass** (only win rate confirmed by direct read).
- `PredictionOutcomeEvaluator.ts`: real-bars MFE/MAE grading via `HistoricalDataGateway`, "never
  fabricates — a symbol with no real bar history in the window is left unevaluated." This is the
  exact pattern the new post-market subsystem should reuse, not reinvent.

### 1.5 Discovery, ranking, and premarket (the most directly relevant prior art)
- `OpportunityDiscovery.ts` / `MarketUniverseScanner.ts` / `SnapshotScanner.ts` /
  `ComposableRanking.ts` / `TradePlanBuilder.ts`: already form a working discovery → rank →
  premarket-plan pipeline, PROMOTE/HOLD/REJECT tiered, session-aware
  (`rankingThresholdsBySession`), liquidity-screened. Live counts this session: **`trade_plans` =
  230 rows, `missed_opportunities` = 592 rows** — real accumulated data, not just schema.
- **`MissedOpportunityDetector.ts` / `MissedOpportunityEvaluator.ts`**: this is *already* a working,
  narrow version of what Phase 3/5/6 of the request asks for — `classifyMiss()` already implements
  most of the taxonomy (`SUBSCRIPTION_MISS`, `AGENT_MISS`, `CONSENSUS_REJECTION`, `RISK_REJECTION`,
  `EXECUTION_MISS`, `THESIS_INVALIDATED`, `NOT_ACTUALLY_MISS`), scoped to PROMOTE-recommended
  candidates only (an explicit, deliberate anti-hindsight-bias safeguard — a REJECT-recommended
  candidate is never classified as "missed"). **This session found and fixed two real bugs in it**:
  (a) `priceAtDetection` was hardcoded to `null` at the only call site, making evaluation structurally
  impossible; (b) the evaluation half (`getPendingEvaluations`/`evaluateAgainstPriceSeries`/
  `persistEvaluation`) had zero production callers at all — confirmed live, 592/592 historical rows
  were `PENDING` forever. Both fixed this session (new `MissedOpportunityEvaluator.ts` worker, real
  `HistoricalDataGateway` bars, registered in `SystemBootstrap.ts`, 68 passing tests). **This is
  significant for the current design: the exact "did we detect this in time" methodology already
  exists, is now genuinely working end-to-end, and should be extended, not replaced.**
- Discovery Lineage Ledger (`DISCOVERY_CANDIDATE_ADMITTED`/`FILTERED`, structured-log `eventType`
  strings, not EventBus constants) gives a real per-candidate audit trail of *why* something was or
  wasn't scanned.

### 1.6 Backtesting / replay
- `BacktestEngine.ts` = **SAME_BAR_CLOSE** (explicitly non-promotable). `canonicalNextBarEngine.ts`
  = **NEXT_BAR_OPEN** (the only promotion-adjacent path) — both confirmed to exist as described.
  `src/server/replay/` (Argus Historical Evaluation / MODE B) reuses real ChiefTrader/RiskEngine/OMS
  against an isolated `HistoricalReplayBroker` — description trusted from CLAUDE.md, not
  independently re-verified line-by-line this pass beyond confirming the directory and a
  `replayRuns` table exist.

### 1.7 Observability / decision traces
- `observability_events`: **991,007 rows live**. `ts` is a numeric epoch-millisecond column, **not**
  an ISO string — this session was bitten twice by a `LIKE 'YYYY-MM-DD%'` query silently returning
  zero rows before catching it. Any new code touching this table must use `Date.parse(...).getTime()`
  range comparisons. Retention: `config/observability.json` — 14 days, hourly sweep.
- The 7-table `getDecisionTrace(traceId)` join (`src/server/observability/queryTraces.ts`) is the
  authoritative per-decision reconstruction — a new report should join into this, never duplicate it.

### 1.8 Fincept — real but narrow
- **`FinceptCacheAdapter.ts`** is the only live path: read-only SQLite connection to Fincept
  Terminal's local `cache.db` (**never** `fincept.db`, which was directly schema-inspected and
  confirmed to hold real credential tables — deliberately untouched). Gated by
  `ENABLE_FINCEPT_CACHE_ADVISORY` (default `false`). Its only consumer is `MacroAgent.ts` — folds a
  VIX/index snapshot into reasoning **text only**. Fails silently on any error, by design; cache
  observed live to be highly transient (57 rows → 0 within minutes).
- **`FinceptResearchAdapter.ts`** (`src/server/research/fabric/`) is a **dead stub** —
  `fetchFinceptPackets()` hardcoded to `return []` with an honest comment. No importers beyond its
  own test. Not live in production.
- No MCP server configuration references Fincept anywhere in the repo. `FinceptTerminal` is treated
  purely as an untrusted sibling desktop process per CLAUDE.md, same as `vibe-trading`/`autohedge`.
- **Conclusion for this design: there is no general Fincept research bridge to build on.** Any new
  read-only Fincept integration is new work, not an extension of something existing — see §15.

### 1.9 Scheduled workers — full inventory and shutdown-drain coverage

| Worker | Interval | Started by | Stopped by |
|---|---|---|---|
| FundamentalAgent / MacroAgent | 60s / 75s | `pipelineAgentRuntime.ts` (Mission Control) | same |
| PortfolioMonitor / ReflectionEngine / MarketDataCrossChecker / SystemMetricsWorker / DbBackupService | 60s / 60s / 60s / 2s / 24h | `SystemBootstrap.start()` | `SystemBootstrap.stop()` |
| NewsEngine (+ MarketOpenNewsConfluence) | adaptive | `SystemBootstrap.start()` | `SystemBootstrap`+`gracefulShutdown` (belt-and-suspenders) |
| PortfolioReconciliation | 5min + 30s warmup | `SystemBootstrap.start()` | **only** `gracefulShutdown.ts` (by design — recon must survive Autobot toggles) |
| SessionLifecycle / JavaQuantAdvisoryService / CalibrationValidationWorker / MarketUniverseScanner / CampaignTracker / AutoTradeScheduler / StrategyEngineShadowRunner / OpenAliceVerificationService | various | boot | `gracefulShutdown.ts` (DEF-27 fix, 2026-09-05/06) |
| heartbeatWatchdog | 60s | boot | `gracefulShutdown.ts` (2026-09-06 fix) |
| **ChiefTraderAgent** (×2) | 60s / 10s | module-load singleton | **nowhere — real gap, this pass** |
| **AIProviderHealthCheck** | 180s | `ArgusCoreBoot.ts` | **not in production — only a test-reset helper exists** |
| MissedOpportunityEvaluator (new, this session) | 5min | `SystemBootstrap.start()` | `SystemBootstrap.stop()` |
| processTelemetry / sessionRecovery / MarketRegimeAgent | — | **NOT VERIFIED** start/stop coverage this pass | — |

---

## §2. Existing components that can be reused (summary)

Read-only, safe as-is: `ohlcv_bars`+`HistoricalDataGateway`, `news_clusters`/`news_predictions`,
`agent_predictions`/`agent_reasoning_logs`, `trades`/`fills`/`portfolio`, `risk_assessments`/
`risk_gate_results`, `event_traces`/`observability_events`/the 7-table trace join, `trade_plans`,
`missed_opportunities` (now fully working), `prediction_outcomes`, `agent_performance_stats`,
`daily_strategy_performance`. Reusable *patterns* (not just tables):
`PredictionOutcomeEvaluator.ts`'s real-bars-or-nothing grading discipline; `MissedOpportunityDetector.ts`'s
PROMOTE-only anti-hindsight-bias scoping; the `continuous/` directory's architecture-boundary-test
pattern (`premarketArchitectureBoundary.test.ts`); the JSON-config + typed-loader + required-key
validation pattern; `SystemBootstrap.ts`'s start/stop worker registry.

## §3. Missing capabilities

- No date-partitioned agent-performance history (`agent_performance_stats` is running/live only) —
  blocks Phase 17's rolling-window statistics.
- No market-level daily summary table (SPY/QQQ/IWM/VIX/sector performance) — nothing currently
  aggregates this daily.
- No full-eligible-universe post-market "what moved and did Argus see it" scan — `MissedOpportunityDetector`
  is scoped to candidates the discovery funnel already ranked PROMOTE; it structurally cannot tell you
  about a mover that was never in the scan universe at all (that would surface as "not applicable," not
  as a classified miss — a real, distinct gap from "Argus saw it and passed").
- No "correct non-action" classification — `classifyMiss()` only fires for PROMOTE-tier candidates;
  there's no explicit, evidenced category for "this looked interesting in hindsight but the
  point-in-time evidence genuinely didn't support acting" (Phase 3J of the request). This is a real,
  valuable gap — recommended as new work in §7.
- No formal point-in-time-integrity framework (`data_timestamp` vs `observation_timestamp` vs
  `decision_timestamp` fields) — the codebase's culture already leans this way (fail-closed,
  never-fabricate, PROMOTE-only scoping) but nothing enforces it structurally for a NEW report that
  reconstructs "what did Argus know when."
- No persisted premarket/post-market report artifact — `PremarketIntelligence.tsx` (the existing UI
  tab) is read-only observability of `TradePlanBuilder`'s output; it is not the structured,
  multi-source report Phase 9 describes.
- No remediation-recommendation ledger, no data-quality-event ledger distinct from ad hoc
  `observability_events` rows.

## §4. Exact data sources available today

| Source | Status |
|---|---|
| Daily OHLCV, 599 symbols, 2018-2026 | AVAILABLE_NOW |
| 1-minute bars, 224 symbols, ~25 days | AVAILABLE_NOW (narrow — see §5) |
| 5-minute bars | **NOT_AVAILABLE in practice** (1 symbol, not a real dataset) |
| News clusters/sentiment | AVAILABLE_NOW |
| Fundamentals (AlphaVantage OVERVIEW) | AVAILABLE_NOW (budget-limited) |
| Macro (AlphaVantage) | AVAILABLE_NOW (budget-limited) |
| VIX/index snapshot via Fincept cache | AVAILABLE_WITH_EXISTING_SOURCE (narrow, transient, off by default) |
| Agent votes, consensus outcomes, risk gates, trades/fills | AVAILABLE_NOW |
| Discovery lineage (admitted/filtered reasons) | AVAILABLE_NOW |
| Premarket plans + missed-opportunity classification/evaluation | AVAILABLE_NOW (fixed this session) |

## §5. Exact data sources that would be required (and are not confirmed to exist today)

- **Broad 1-minute intraday history across the full eligible universe.** Current coverage (224
  symbols / ~25 days) is nowhere near enough for a genuine full-universe post-market mover scan.
  Expanding this means real Alpaca API cost/rate-limit exposure — the same category of cost this
  codebase already gates behind explicit flags for broad-universe discovery. **REQUIRES_NEW_SOURCE**
  in the sense of "requires deliberately fetching much more of what Alpaca already offers," not a new
  vendor.
- **Index futures / overnight session data** (ES/NQ/RTY) — Alpaca does not appear to be a futures
  data source in this codebase. **NOT_AVAILABLE** without a new integration.
- **Economic/earnings calendar.** AlphaVantage is already used for fundamentals/macro, and it does
  offer calendar-style endpoints, but no existing Argus code path is confirmed to consume one.
  **REQUIRES_NEW_SOURCE** (plausibly the same vendor, unconfirmed implementation).
- **Sector-level daily performance beyond the coarse `SECTOR_MAP`** in `PositionSizing.ts` (used for
  the concentration gate, not analytics) — sector ETF (XLF/XLE/XLK/…) daily bars are fetchable via
  the existing `HistoricalDataGateway` path, so this is **AVAILABLE_WITH_EXISTING_SOURCE**, just not
  wired into anything today.
- **Real point-in-time "when did Argus actually receive this bar" tracking.** `ohlcv_bars` has a
  `timestamp` (the bar's own market time) but no confirmed separate "when Argus fetched/observed
  this" field. A bar fetched retroactively (backfilled after the fact) is indistinguishable from one
  Argus had live, in the current schema. **This is the single most important gap for §6.**

## §6. Point-in-time data risks

This is the most important section, because the entire value of the subsystem collapses into
hindsight theater if this is wrong.

1. **The `ohlcv_bars` backfill risk (§5, last item).** `HistoricalDataGateway.ensureBars()` will
   fetch missing history from Alpaca on demand — meaning a bar that "exists in the DB" for 10:00 AM
   today could have been fetched at 4:00 PM today, after the move already happened. Any T0
   reconstruction that says "Argus had this data at T0" must not rely on bar *existence* alone; it
   needs either (a) a real fetch-timestamp column added to `ohlcv_bars` (schema change, low risk,
   additive), or (b) cross-referencing against `MarketDataWorker`'s live tick cache / a
   contemporaneous `observability_events` row proving the data was actually flowing at that moment —
   the second option reuses what already exists and is the recommended default.
2. **`ComposableRanking`'s `finalScore`/rank is itself a snapshot computed once, at scan time** —
   reusing it for a T0 reconstruction is safe *as long as* the report only ever looks at the rank/score
   value as it was computed at that scan's own timestamp, never a later rescan's value applied
   retroactively. `MissedOpportunityDetector.ts` already gets this right (it snapshots
   `evidenceAtDecisionJson` at classification time) — the new subsystem should follow the identical
   pattern, not query current-state tables and pretend the result reflects an earlier moment.
3. **`observability_events.ts` epoch-ms gotcha** (§1.7) — a real, demonstrated risk of silently
   querying the wrong window and drawing false "Argus knew nothing" or "Argus knew everything"
   conclusions. Any point-in-time query against this table needs a code-reviewed helper function,
   not ad hoc `Date.parse`/`LIKE` calls repeated in every consumer.
4. **News/AI text is UNTRUSTED DATA for anything but narrative summary** (Phase 12's own rule,
   already this codebase's convention for Bull/Bear research and Java debate-context injection). A
   post-market reconstruction must not let an LLM's own retrospective summary of "why this moved"
   stand in for a real, timestamped, point-in-time news_clusters row.
5. **Revised/restated fundamentals.** `FundamentalAgent.ts` overwrites its own cached view on each
   60s tick per symbol — there's no confirmed historical snapshot of "what fundamentals looked like
   at T0" distinct from "current fundamentals." **NOT VERIFIED** whether any versioning exists;
   treat any fundamentals-based counterfactual claim as `POINT_IN_TIME_UNKNOWN` unless proven
   otherwise.

**Recommendation:** every new table in §8 gets `data_timestamp`, `observation_timestamp`, and
`decision_timestamp` columns (per Phase 10's own request) from day one, and a single shared
`pointInTimeQuery.ts`-style helper (mirroring `HistoricalDataGateway`'s existing "single source of
truth" role) is the only sanctioned way to ask "what did Argus know at time T" — no ad hoc queries
scattered across the new worker files.

---

## §7. Proposed architecture

A new, isolated directory — `src/server/intelligence/` (avoiding `postmarket/`/`premarket/` naming
collision with the existing `src/server/premarket/` session-state directory, which is a different,
narrower thing) — following the exact safety pattern already proven for `src/server/continuous/` and
`src/server/premarket/`: a dedicated `intelligenceArchitectureBoundary.test.ts` that greps every file
in the directory and asserts zero imports of `RiskEngine`, `OrderManagement`, `BrokerManager`, or
`ChiefTraderAgent`, and zero calls to `emitTradeIdea`/`placeOrder`/`CHIEF_APPROVED_IDEA` — the same
mechanical enforcement, not a policy document alone.

Two new workers, each a thin orchestrator over mostly-existing read logic:

- **`PostMarketAnalysisWorker`** — triggered once per trading day near/after close (reuse
  `SessionLifecycle`'s existing `AFTER_HOURS`/`CLOSED` transition as the hook, matching how
  `TradePlanBuilder`'s premarket cycle already hooks `PRE_MARKET`). Scans the **same
  liquidity-screened universe `MarketUniverseScanner` already maintains** (not a new universe — see
  §18 on cost), computes deterministic forward-return/MFE/MAE outcomes via the exact
  `PredictionOutcomeEvaluator`/`MissedOpportunityEvaluator` real-bars pattern, joins against
  `trade_plans`+`missed_opportunities`+`agent_reasoning_logs` to classify what Argus did or didn't do
  for each mover, and persists one immutable `postmarket_reports` row.
- **`PremarketIntelligenceWorker`** — triggered once per trading day at the same `PRE_MARKET` point
  `TradePlanBuilder`'s own one-shot cycle already fires at (after it, not instead of it — reads its
  output rather than re-scanning). Fetches SPY/QQQ/IWM/VIX/sector daily bars (already-available data
  source, just not currently aggregated), builds the market-regime summary, and persists one
  immutable `premarket_reports` row referencing that day's `trade_plans` rows by `plan_date`.

Both workers: pure functions over already-fetched/queried data wherever possible (mirroring
`buildMissedOpportunityRecord`'s pure-function style, which is directly unit-testable without a live
DB), registered in `SystemBootstrap.ts`'s start/stop pair exactly like `MissedOpportunityEvaluator`
was this session, and — given the real gap found in §1.9 — verified with a boot-time
`assertRuntimesCoverCatalog()`-style check so they can never become the next orphaned interval.

## §8. Database/schema proposal

Trimmed from the requested 14 tables to 8 genuinely new ones, reusing 6 existing tables, per the
request's own "avoid unnecessary duplication, use existing Argus schemas wherever possible"
instruction:

**New:**
| Table | Purpose | Notes |
|---|---|---|
| `market_daily_summary` | One row/trading day: SPY/QQQ/IWM/VIX close+change, sector leaders/laggards, regime label | Merges the requested `market_snapshots`+`daily_market_summary` into one table — two tables for the same daily cardinality is the duplication the request itself warns against |
| `opportunity_outcomes` | Post-market full-universe mover scan results (return/MFE/MAE/volume/catalyst per symbol per day), independent of whether the symbol was ever ranked | Distinct purpose from `missed_opportunities`, which is discovery-funnel-scoped only |
| `agent_performance_daily` | Date-partitioned snapshot of what `agent_performance_stats` looked like that day | The real gap in §3 — required for Phase 17's rolling-window statistics |
| `remediation_recommendations` | Phase 7's JSON shape verbatim (problem/evidence/proposed_change/expected_benefit/risk_of_change/data_required/backtest_required/paper_validation_required/minimum_sample_size/confidence) | Research-status only, never auto-applied — enforced by the architecture-boundary test |
| `data_quality_events` | Point-in-time data-availability tracking specific to a report's own inputs (was SPY data fresh, was a symbol's news feed stale, etc.) | Narrower than `observability_events` — this is "was this specific report's input trustworthy," not a general log |
| `premarket_reports` | Immutable persisted premarket report JSON | Phase 9's structure |
| `postmarket_reports` | Immutable persisted post-market report JSON | Phase 15's structure |
| `error_classifications` (optional, Phase 2+) | Only if `missed_opportunities.classification`'s existing enum + the new "correct non-action" category (§3) turn out insufficient once real data exists | Recommend deferring — extend the existing enum first, add a separate table only if that proves inadequate |

**Reused as-is, no schema change:** `trade_plans`, `missed_opportunities`, `prediction_outcomes`,
`agent_performance_stats`, `daily_strategy_performance`, the 7-table decision-trace join
(`event_traces`/`observability_events`/`transaction_traces`/`agent_reasoning_logs`/
`risk_assessments`+`risk_gate_results`/`trades`+`fills`/`ai_calls`).

Every new table gets `data_timestamp`, `observation_timestamp`, `decision_timestamp` (nullable where
not applicable), `market_session`, `source`, `source_timestamp`, and `traceId` (nullable) per §6's
point-in-time recommendation — additive columns only, no existing table is altered.

## §9-10. Premarket / post-market pipelines

See §7's architecture — both pipelines are additive hooks onto `SessionLifecycle`'s already-real
session-state transitions, not new scheduling infrastructure. Explicitly: **the post-market
subsystem never runs during market hours** (it's triggered off `AFTER_HOURS`/`CLOSED`, matching the
request's own Phase 14 lifecycle diagram) — it cannot interfere with live execution by construction,
not just by policy.

## §11. Missed-opportunity methodology

Extend `MissedOpportunityDetector.ts`'s existing `classifyMiss()` — do not replace it. Two concrete
additions:
1. A new classification, `CORRECT_NON_ACTION` (or extend `NOT_ACTUALLY_MISS`'s meaning), for a
   PROMOTE-tier candidate where the point-in-time evidence (`evidenceAtDecisionJson`, already
   captured) genuinely did not support the direction the price later moved — computed by checking
   whether the SAME snapshot already stored (momentum/volume/gap/news-catalyst scores) was actually
   weak/absent at detection time, not by looking at what happened afterward. This directly answers
   the operator's own framing: "Argus did not know this would happen" vs "Argus missed a detectable
   opportunity."
2. A genuinely new path for symbols that were **never in the scan universe at all** — today,
   `classifyMiss()` only ever runs against `ComposableRanking`'s output, so a mover outside that
   universe produces no record whatsoever, not even a "not applicable" one. The post-market full-scan
   worker (§7) should surface these separately, tagged `UNIVERSE_GAP` in `opportunity_outcomes`
   rather than forced into `missed_opportunities`'s existing taxonomy (which is specifically
   discovery-funnel-scoped by design — conflating the two would blur a real, useful distinction).

## §12. Error taxonomy

Maps directly onto the request's categories A-J:

| Category | Existing coverage |
|---|---|
| A. Universe problem | New `UNIVERSE_GAP` tag (§11) |
| B. Data problem | New `data_quality_events` table |
| C. Detection problem | `AGENT_MISS` (exists) |
| D. Agent disagreement | `CONSENSUS_REJECTION` + `independentAgentCount`/`terminalReasonCode` (both exist in `ChiefTraderAgent`'s `CONSENSUS_TERMINAL_REASON` structured log — already directly queried this session) |
| E. ChiefTrader decision | Same as D |
| F. RiskEngine | `RISK_REJECTION` (exists) |
| G. Execution | `EXECUTION_MISS` (exists) |
| H. Timing | New — needs `data_timestamp` vs `decision_timestamp` comparison per §6/§8 |
| I. Strategy limitation | Narrative-only, from `remediation_recommendations`, never auto-classified |
| J. Correct non-action | New `CORRECT_NON_ACTION` (§11) |

## §13. Statistical methodology

Phase 17's rolling 5/20/50/100-session analysis is blocked today only by the missing
`agent_performance_daily` date-partitioning (§3/§8) — once that exists, the actual statistics
(precision/recall/calibration/agent-combination performance) reuse `agent_performance_stats`'s
already-real Wilson-bound/effective-sample-size math (`ChampionChallengerService.ts`,
`CalibrationCandidateBuilder.ts` — both already directly read this session for the MODERATE-tier
work). Require the SAME minimum-sample-size discipline those files already enforce (Wilson lower
bound above chance, not raw win rate) before any DESCRIPTIVE finding is labeled STATISTICALLY
SUPPORTED — do not invent a second, laxer bar for this new subsystem.

## §14. AI boundaries

Reuse the existing `AIOutputValidator`/`inventedNumericFieldsRejected` fail-closed pattern
(Bull/Bear research already nulls and flags any LLM-invented numeric field). AI may only produce
narrative text from deterministic inputs computed in code — never P&L, returns, timestamps, or scores.
**Recommended follow-up audit** (not done this pass): review `NewsEngine.ts`'s prompt construction
specifically for prompt-injection resistance, per the operator's Phase 12 ask — this session's
research pass confirmed the file's cadence/behavior but did not specifically audit prompt-injection
handling.

## §15. Fincept boundaries

Given §1.8's finding (one narrow, gated, transient, text-only path; one dead stub; zero MCP
integration), **recommend not building a new Fincept bridge as part of this initiative's early
phases.** If a future need specifically requires earnings-calendar or similar data Fincept might
provide and no other source exists, any new bridge must follow `research/fabric/`'s existing
normalization discipline (`normalizeFinceptPacket()`'s `publicReleaseDate`-required pattern) — never
raw Fincept tool IDs consumed directly, and never anything beyond the existing read-only, fail-silent,
untrusted-source contract.

## §16. Testing strategy

Mirror what this session already proved works: an architecture-boundary test (§7), fake-timer worker
start/stop tests (`MissedOpportunityEvaluator.test.ts`'s own pattern, written this session), real-SQLite
persistence integration tests (`MissedOpportunityDetector.persistence.test.ts`'s pattern), and — most
importantly — a **dedicated point-in-time-integrity test suite** implementing the operator's own
synthetic scenario verbatim: a stock +1% at 10:00, +15% at 10:30, post-market analysis at 16:00 must
not conclude Argus should have known about the 15% move at 10:00 unless real T0 evidence supports it.
This is a natural extension of `MissedOpportunityDetector.ts`'s own existing "explicit safeguard
against hindsight bias" design comment — the instinct already exists in this codebase's culture, it
just needs a named, permanent regression test for the new subsystem specifically.

**Separately flagged, not part of this design:** the real DEF-27-shaped gap found in §1.3/§1.9
(`ChiefTraderAgent`/`AIProviderHealthCheck` intervals never stopped) should get its own fix and test,
independent of this initiative — recommend opening it as a follow-up (tentatively "DEF-30") rather
than bundling it into this design's first implementation phase.

## §17. Operational/scheduling strategy

Register both new workers in `SystemBootstrap.ts` exactly like `MissedOpportunityEvaluator` was this
session (start/stop pair, covered by the existing `gracefulShutdown.ts` drain via
`SystemBootstrap.stop()`). Given §1.9's finding that coverage has silently drifted before, add a
boot-time assertion (mirroring `pipelineAgentRuntime.ts`'s `assertRuntimesCoverCatalog()`) that
enumerates every registered interval-driven worker and fails loudly if a new one is added without a
matching stop path — currently no such global assertion exists; this would be new, cheap, and directly
prevents the exact class of bug found twice this session (DEF-27 originally, and again in §1.9).

## §18. Resource/CPU/storage implications

`observability_events` is already at 991k rows under a 14-day retention sweep — every new table needs
an equivalent retention policy from day one, not added later. The single largest cost risk is §5's
"expand 1-minute coverage" item — recommend explicitly **not** doing that; instead scope the
post-market full-universe scan to daily bars (already broad: 599 symbols back to 2018, zero
additional cost) plus the existing liquidity-screened `MarketUniverseScanner` universe for anything
needing intraday resolution, matching the same cost discipline CLAUDE.md already documents for
broad-universe/movers discovery (explicit flags, bounded caps, real API cost acknowledged).

## §19. Failure modes

Data source down → mark fields `UNAVAILABLE`, never fabricate (matches Phase 8's own taxonomy).
Worker crash mid-report → stage the full report in memory and persist atomically at the end
(mirrors `persistMissedOpportunities`'s existing all-or-nothing batch insert), never a partially
written row. Process restart mid-cycle → same DEF-27 lesson as everything else this session touched:
register the worker properly, verify with the new boot-time assertion (§17).

## §20. Security concerns

Same prompt-injection surface as `NewsEngine.ts` already has (§14) — no new attack surface beyond
what already exists, since this subsystem only reads and narrates, never acts. No new attack surface
against RiskEngine/OMS/BrokerManager, provably enforced by the architecture-boundary test (§7), the
same mechanism already proven for `continuous/`.

## §21. Implementation phases

Mapped onto the operator's own requested Phase 0-6 structure:

- **Phase 0 (done):** this document.
- **Phase 1:** new tables only (§8) + migrations. Zero workers, zero report generation. Prove the
  schema and the point-in-time-tracking columns are right before anything reads/writes real data.
- **Phase 2:** `PostMarketAnalysisWorker` computing deterministic outcomes only (real forward-return/
  MFE/MAE via the proven `HistoricalDataGateway` pattern) against the existing liquidity-screened
  universe. No missed-opportunity reconstruction yet, no AI narrative.
- **Phase 3:** extend `MissedOpportunityDetector.classifyMiss()` with `CORRECT_NON_ACTION` and
  `UNIVERSE_GAP` (§11), wire the post-market scan to classify against it. This is where most of
  Phase 3/6's methodology actually lands, reusing the majority of already-existing code.
- **Phase 4:** `PremarketIntelligenceWorker` + `premarket_reports`, reading `TradePlanBuilder`'s
  already-computed output rather than re-scanning.
- **Phase 5:** AI-generated narrative summaries only, over deterministic math already computed in
  Phases 2-4 — same fail-closed/untrusted-text discipline as everywhere else in this codebase.
- **Phase 6:** `agent_performance_daily` rollups + the 5/20/50/100-session statistical analysis
  (§13) — the genuinely new statistical-learning layer, gated on real accumulated Phase 1-4 data.

**Do not implement Phase 2+ until Phase 1's schema and point-in-time tracking are proven correct** —
stated directly per the operator's own instruction, and consistent with how `MissedOpportunityDetector`
itself already shipped detection well before its evaluation half actually worked (a lesson this exact
session lived through firsthand).

## §22. Exact files to create/modify (Phase 1-2 scope only; later phases not yet designed to file level)

**New:**
- `src/server/db/schema.ts` — additive table definitions (§8), no changes to existing tables.
- `drizzle/00XX_intelligence_tables.sql` — migration.
- `src/server/intelligence/` — new directory: `PostMarketAnalysisWorker.ts`, `PremarketIntelligenceWorker.ts`,
  `pointInTimeQuery.ts` (the shared T0-query helper, §6), `intelligenceArchitectureBoundary.test.ts`.
- `config/intelligenceReports.json` (or extend `continuousIntelligence.json`) — cadence/threshold
  config, following the existing JSON+typed-loader+required-key pattern.

**Modified (additive only):**
- `src/server/continuous/MissedOpportunityDetector.ts` — new `CORRECT_NON_ACTION`/`UNIVERSE_GAP`
  classification cases (Phase 3).
- `src/server/core/SystemBootstrap.ts` — register/deregister the two new workers.
- `src/server/core/pipelineAgentRuntime.ts` or an equivalent global assertion (§17) — new boot-time
  coverage check.
- `CLAUDE.md` / `docs/architecture/ARGUS_ARCHITECTURE.md` — new section once Phase 1 actually ships
  (per this repo's own rule that an architecture change updates both in the same change).

## §23. Risks of modifying the existing trading system

Essentially none, provided the architecture-boundary test lands in Phase 1 itself (not deferred) —
this exact pattern is already proven safe for `continuous/` and `premarket/`. The one real risk is
scope creep: a future session wiring an `intelligence/`-derived signal into `ChiefTrader` the way
`TradePlanBuilder`/`JavaFactorComposite` were — both of those were explicit, informed operator
overrides, not accidents, and the boundary test is exactly what would force any future attempt to be
equally explicit rather than silent.

## §24. Recommendation: **BUILD NOW — Phase 1 only, strictly gated**

Reasoning: roughly 80% of the needed infrastructure already exists and is proven in production this
session — `TradePlanBuilder`, `ComposableRanking`, `MissedOpportunityDetector`/`Evaluator` (the last
of which this very session found broken and fixed, proving both the pattern's value and that it needs
real maintenance attention), `PredictionOutcomeEvaluator`, `ReflectionEngine`, and the full
observability/decision-trace stack. The marginal new work for Phase 1 (schema + point-in-time
plumbing) is small, additive, and low-risk given the architecture-boundary safety net already proven
elsewhere in this exact codebase. **Do not build Phases 5-6** (AI narrative summaries, full
statistical learning) until Phases 1-4 have real accumulated data to summarize and analyze — building
those first would produce exactly the "hindsight looks like foresight" theater this whole initiative
exists to prevent.
