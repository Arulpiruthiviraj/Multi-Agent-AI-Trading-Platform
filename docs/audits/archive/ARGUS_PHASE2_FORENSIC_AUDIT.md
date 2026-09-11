# ARGUS PHASE 2 — POST NO-TRADE FORENSIC HARDENING — PHASE 1 AUDIT

**Mode:** Read-only verification of the prior audit's remediation claims, against current source. No code changed during this audit pass (one small, separately-verified fix — item #3 — was applied afterward and is called out explicitly below, not folded into the audit itself).
**Written:** 2026-08-20
**Scope:** Verifies every claim in `docs/audits/archive/ARGUS_NO_TRADE_REMEDIATION_STATUS.md` (an **uncommitted** working-tree file — `git log` shows no commit for it) against the actual current source. Prior document trusted nothing on its word; every finding below cites exact file/function evidence.

**Taxonomy** (per `docs/audits/archive/ARGUS_LIVE_NO_TRADE_FORENSIC_AUDIT.md` §9): A Process/runtime · B Autobot · C Trading pause · D Market data · E Stale data · F Idea generation · G Pre-Chief rejection · H Consensus · I RiskEngine · J OMS · K Broker · L Capital/sizing · M Reconciliation/session · N News veto · O Other/infrastructure.

---

## Summary table

| # | Area | Class | Verdict | Real-trading impact | Safe to auto-fix |
|---|---|---|---|---|---|
| 1 | Kronos/Chronos fail-closed voting | O | **CONFIRMED FIXED** — exceeds claim | Yes (was a real integrity issue; now closed) | N/A — already fixed |
| 2 | Quant/Alpaca 429 handling | O | **PARTIALLY FIXED** — gap: no request-dedup cache | Indirect (raises 429 risk, doesn't corrupt data) | Yes, additive-only |
| 3 | News tick success telemetry | O | **WAS NOT FIXED — now fixed in this pass** | No (observability-only; never affected the trading decision) | Yes — done |
| 4 | AI provider health surface | H (adjacent) | **ALREADY EXISTED** — route-naming mismatch only | No | N/A |
| 5 | Consensus decision record | H | **ALREADY EXISTED**, no gap | No | N/A |
| 6 | News veto observability | N (adjacent) | **PARTIALLY EXISTS** — gap: cluster IDs not persisted, only count | No (veto logic itself unaffected) | Yes, additive-only |
| 7 | NVDA target provenance | O | **CONFIRMED FIXED AND TESTED** (16/16) | Yes (was real contamination risk; closed) | N/A — already fixed |
| 8 | Single-writer / PID / shutdown | A/M | **CONFIRMED** — correctly scoped to what's fixable in code | Low (residual risk is OS-level, not a code gap) | N/A |

---

## 1. Kronos/Chronos fail-closed voting — CONFIRMED FIXED

- **File/function:** `src/server/services/KronosForecastAgent.ts` `onTick()` (~L86-121). Checks `kronosEngine.getStatus().isAvailable` before calling `predict()`, and re-checks after the await returns ("Fail-closed for ideas: never emit BUY/SELL if availability flipped while the call was in flight"). `broadcastForecast()` only calls `emitTradeIdea` on a BUY/SELL prediction; the unavailable path publishes `EVENTS.KRONOS_UNAVAILABLE` with `side:'HOLD', confidence:0` — never a vote.
- **Circuit breaker:** `KronosModelManager.markUnavailable()` latches `isAvailable=false` and immediately schedules a re-probe. `kronosFailureKind.ts` classifies `AbortError`/timeout as `'transient'` (only that symbol's forecast fails) vs `'hard'` (latches global unavailable) — only `'hard'` failures call `markUnavailable`, so one slow/CPU-bound symbol cannot starve or poison forecasts for the rest of the universe.
- **Bounded timeout:** `KronosInference.ts callForecastService` uses `AbortSignal.timeout(runtimeIntervals.kronosHttpTimeoutMs)`. `batchPredict` iterates sequentially with per-call try/catch.
- **Root cause (historical):** none remaining — this was already closed before this audit pass.
- **Tests:** `KronosForecastAgent.test.ts` (fail-closed suite), `kronosFailureKind.test.ts`.
- **Safe to fix automatically:** N/A, already fixed. Does not touch RiskEngine/OMS/EventBus spine.

## 2. Quant Engine / Alpaca 429 — PARTIALLY FIXED

- **File/function:** `HistoricalDataGateway.ts` — `rateLimitedUntilMs` is an instance field on the exported singleton (`getInstance()`), so the 429 backoff **is** genuinely shared across every caller (`RiskEngine.ts`, `MarketContext.ts`, `QuantSignalAgent.ts`, `PredictionOutcomeEvaluator.ts`). `armBarsRateLimitBackoff()` honors a `Retry-After` header, else falls back to `tradingSafety.alpacaCircuitBreakerCooldownMs` (30000ms) — real, but a **fixed** cooldown, not exponential backoff. `QuantSignalAgent.runCycle()` reacts to a 429-pattern error by breaking the remaining symbol loop for that cycle only; the actual gating state lives entirely in the gateway's `rateLimitedUntilMs`, re-checked on every `ensureBars()` call.
- **Gap:** `ensureBars()` has **no read-before-fetch freshness/dedup check** — despite a doc comment implying one ("fetching from Alpaca if the cached count looks incomplete"), no such check exists; it unconditionally calls Alpaca on every invocation. With 4+ independent call sites potentially requesting the same symbol/day-range within one cycle (RiskEngine, MarketContext, QuantSignalAgent, PredictionOutcomeEvaluator, plus two v2System routes), this is exactly the redundant-request pattern that produces 429s.
- **Root cause:** missing request-level caching/dedup, not missing backoff.
- **Proposed fix (not applied this pass):** an in-process, short-TTL "already have fresh bars for symbol+timeframe+range this cycle" check at the top of `ensureBars()`, before the Alpaca call — additive, data-layer only, does not touch RiskEngine/OMS/ChiefTrader.
- **Tests today:** `HistoricalDataGateway.test.ts` covers the shared-backoff/fail-closed behavior, not caching (because caching doesn't exist yet).
- **Safe to fix automatically:** yes — purely additive, data-layer.

## 3. News tick success telemetry — WAS NOT FIXED, fixed in this pass

- **Bug (before this pass):** `NewsEngine.ts runPipeline()` called `notePipelineAgentTick('NewsAgent')` at cycle start and `notePipelineAgentFailure('NewsAgent', e)` on the catch path, but **never called `notePipelineAgentSuccess('NewsAgent')` anywhere in the file** (confirmed by grep: the import list didn't even include it). `pipelineAgentSnapshot.ts` surfaces `heartbeat.lastSuccessfulTickAt` straight from this heartbeat map to `GET /api/v1/system/pipeline-agents` — the exact route the original no-trade audit read and reported `lastSuccessfulTickAt=null`. This made that null **permanent by construction**, even on cycles that fetched and analyzed articles successfully — a false-negative health signal, not a real provider failure.
- **This was not mentioned or addressed in `docs/audits/archive/ARGUS_NO_TRADE_REMEDIATION_STATUS.md` at all**, despite being one of the four "contributing infrastructure problems" the original audit named.
- **Fix applied:** `src/server/news/NewsEngine.ts` — imports `notePipelineAgentSuccess`; calls it once the pipeline body completes without throwing (right after publishing `NEWS_PIPELINE_TICK`), regardless of whether any catalyst was found that cycle (a cycle finding zero new/qualifying articles is still a real success, not a gate — matches the per-cycle semantics this function already has elsewhere in the codebase).
- **Tests added:** `src/server/news/NewsEngine.test.ts` — 2 tests: (a) a cycle with zero fetched articles records `lastSuccessfulTickAt` and `currentState:'SUCCESS'`; (b) a thrown provider error still records `FAILED`, not success. Both pass. `tsc --noEmit` clean.
- **Real-trading impact:** none — this is purely an observability signal; it never fed into ChiefTrader consensus, RiskEngine, or the news_veto gate (those consume `news_clusters`/`news_articles` directly, not this heartbeat).
- **Safe to fix automatically:** yes — done, additive-only, one file, no spine contact.

## 4. AI provider health for consensus debate — ALREADY EXISTED (no functional gap)

- **File/function:** `AIRouter.routeConsensus()` (~L476-510) already reads persisted per-provider health from `schema.aiProviders` (`health`, `priority`, `successRate`, `latency`, `lastFailure`, `lastSuccess`), excludes `health==='Offline'` providers unless all are dead, sorts by priority/health/successRate/latency, and only throws `"No AI Providers available for consensus"` after emitting an `emitProvidersExhausted` telemetry event when the routable set is empty post-filter.
- **Route-naming note:** `GET /api/v1/config/routing` only returns `agentRoutingOverrides` (manual agent→provider overrides), not health. The actual persisted health/latency/successRate is exposed via **`GET /api/v1/config/providers`** (`buildProviderInventory(providers)`, same `aiProviders` rows). CLAUDE.md's own routing table doesn't name this second route — a documentation gap, not a code gap.
- **Safe to fix automatically:** N/A; no functional issue to fix. (A CLAUDE.md doc update naming `/config/providers` would be a reasonable, separate, tiny follow-up.)

## 5. Consensus decision record — ALREADY EXISTED, no gap

- **File/function:** `ChiefTraderAgent.ts` (~L490-590) builds `lastConsensusOutcome` with `independentAgreeingAgents`, `requiredAgents`, `confidence`, `threshold`, a human-readable `reason` (e.g. `"[NO TRADE] Only 1 independent agent(s) agreed..."`), and a full `agentVotes` array. Separately persists via `tracingService.logChiefConsensus()` with a complete `votingMatrix` (agent/side/confidence/weight/agreed/sourceTraceId) and `terminalReason`; on approval, `recordConsensusTransaction()` persists `weightedConfidence`, `threshold`, `evidence[]`. `GET /api/v2/traces/:traceId` and `.../export` already consolidate this into one queryable record.
- **Conclusion:** the "structured decision record" Phase 4 of the mega-spec asks for is not a gap to build — it already exists and is already queryable per-`traceId`. Any further work here would be a UI/dashboard presentation layer on top of existing data, not new backend plumbing.

## 6. News veto observability — PARTIALLY EXISTS

- **File/function:** `RiskEngine.ts` (~L495-509) — gate 14 (`news_veto`) builds `symbolNews` filtered by `newsVetoWindowMs` and `newsImpactOnVetoScale(impactScore) > newsVetoMinImpactScore`, then records `recordGate('news_veto', symbolNews.length===0, { matchingClusters: symbolNews.length, replay })`, persisted per-trace in `risk_gate_results.detail` (a JSON text column, joined by `trace_id`).
- **Gap:** only the **count** of matching clusters is recorded — not their IDs, impact scores, or headlines. An operator asking "why was this specific trade blocked" gets `matchingClusters: 3` from the trace but must separately query `news_clusters` by symbol + the same time window to find which three. No existing route joins these automatically.
- **Proposed fix (not applied this pass):** attach the matching clusters' `id`/`impactScore`/`headline` (not just their count) into the same `detail` blob already being persisted — additive, does not touch the veto's pass/fail logic (which is correct and intentionally direction-blind per CLAUDE.md).
- **Safe to fix automatically:** yes — additive-only, one function.

## 7. NVDA target provenance — CONFIRMED FIXED AND TESTED

- **File/function:** `PortfolioMonitor.ts` — `NON_LIVE_OPENING_TRADE_ENVS` = exactly `REPLAY/BACKTEST/SIMULATION/HISTORICAL_REPLAY/HISTORICAL_SIMULATION/TELEMETRY_PULSE` as claimed. `resolveOpeningTradeForLiveExit()` excludes these environments and any `traceId` starting with `replaySafety.replayTracePrefix`. `isValidLongQuantTarget()` requires `quantTarget > averagePrice`. Both `resolvePositionStopTarget()` and `reviewPortfolio()` route through these guards, with inline comments citing the exact forensic finding (a REPLAY MOMENTUM_BREAKOUT NVDA fill at $114/target $121.90 had been binding onto a live EXTERNAL_SYNC position).
- **Tests:** `PortfolioMonitor.test.ts` — **16/16 passing**, including the specific `'does NOT bind REPLAY FILLED BUY stop/target onto a live EXTERNAL_SYNC holding (NVDA $121.90 forensic)'` regression test and a `resolvePositionStopTarget` REPLAY-exclusion test.
- **Conclusion:** fully implemented and regression-tested exactly as the remediation doc claimed. No further action needed.

## 8. Single-writer / runtime stability — CONFIRMED, correctly scoped

- **File/function:** `enginePid.ts` — `reconcileEnginePidFile()`/`isEngineProcessRunning()` clear a stale PID file when the PID is no longer alive; `claimEnginePid()` throws if a different live PID holds the file; `isPidLikelyArgusProcess()` is a Windows `wmic` command-line check guarding against OS PID-reuse handing a stale PID to an unrelated process (fails open by design, i.e. doesn't block startup on an inconclusive check). `gracefulShutdown.ts drainTradingProcess()` on SIGTERM/SIGINT marks clean shutdown, clears the PID file, pauses trading, stops workers, WAL-checkpoints and closes the DB before closing HTTP/WS. The DB itself runs `journal_mode=WAL` + `busy_timeout=5000`, which directly mitigates the `SQLITE_IOERR_READ`-under-concurrent-open scenario the original audit observed.
- **Tests:** `enginePid.test.ts` — stale-PID clear, claim-throws-on-live-PID, PID-reuse safety net.
- **Residual gap (not a code gap):** none of this can make an *unclean death* (kill -9, crash, power loss — no SIGTERM delivered) itself clean; that's inherent to the OS, not fixable in-process. What exists is correct **next-boot detection and refusal** (stale PID cleared, no silent double-writer), which is the right mitigation for that class of problem — there is no further code fix to make here.

---

## What this audit does NOT cover (explicitly out of scope for this pass)

The originating mega-spec's Phases 5, 9, 10, 11, 12, 13 ask for substantially new subsystems, not fixes to existing gaps:

- **Phase 5** (Opportunity Discovery config clarity) — `ARGUS_OPPORTUNITY_IDEAS_ENABLED` being absent from `.env` is very likely intentional (it's the flag gating `OpportunityScreener`'s own idea-emission, separate and more consequential than the watch-only `ARGUS_OPPORTUNITY_LOOP_ENABLED`) — not independently re-verified in this pass.
- **Phase 9/10** (unified decision-lifecycle event, `NoTradeDiagnosticService`) — largely already achievable by composing what §4/§5 above show already exists (per-traceId consensus record, risk gate results); a dedicated aggregation service is new, non-trivial work, not a bug fix.
- **Phase 11** (research/learning ledger with MFE/MAE/calibration stats) — `PredictionOutcomeEvaluator.ts` (extended earlier this session for News predictions) already covers a meaningful part of this for `agent_predictions`/`kronos_predictions`/`news_predictions`; a full agent-precision/calibration reporting layer on top is new work.
- **Phase 12/13** (TradingAgents research adapter + credential mapping) — no code exists for this; it remains a proposal only, not started, per explicit standing instruction not to build it without direct authorization.

These are legitimate follow-on work, but they're new construction, not verification-and-fix of an existing claim — they don't belong in a "verify the remediation doc" audit, and attempting all of them in one pass would repeat the mistake this session already corrected once before (building parallel/duplicate systems instead of extending what exists).

## Recommended next bounded increment

In order of value-to-effort, if continuing:

1. **Quant request-dedup cache** (§2) — closes the real remaining 429-risk gap, small, additive, data-layer only.
2. **News-veto cluster-ID persistence** (§6) — closes the "why was this blocked" observability gap, small, additive.
3. Everything else (Phases 5/9/10/11/12/13) is a multi-file, multi-day scope each and should be scoped/confirmed individually rather than attempted together.
