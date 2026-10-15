# ARGUS October 15, 2026 - 10:00 ET live-market forensic audit (FIRST VERDICT, partial)

Audit window: 09:30-10:00 ET (13:30-14:00Z). Production was read through the CLI/API and bounded, index-ordered, read-only SQLite reads (`agent_predictions` by timestamp; `event_traces` tail by rowid). No production edits, restarts, pauses, config or schema changes. PAPER only; LIVE_NO_GO. Evidence labels: **[V]** verified production observation, **[I]** inference, **[O]** OPEN / NOT_VERIFIED. Funnel counters that the CLI only windows by hours cover 09:29-10:10 ET (a ~10-minute overrun past the primary window); agent-level rows are exact 09:30-10:00.

## 1. Executive verdict
Argus did not trade between 09:30 and 10:10 because **no idea reached the 0.75 bar after calibration, and almost every round had only one independent evidence group**; this is, on the evidence, **correct abstention given the current evidence quality**, not a software fault that blocked valid work. Contributing, verified factors:
* **Calibration limitations [V]:** 3,170 of 3,182 consensus rounds had confidence reduced by calibration; 13 reached >= 0.60, 0 reached >= 0.75. (The agents' own raw confidences are high: Kronos avg 0.83, Quant up to 1.00.)
* **Missing independent agreement [V]:** 1-agent rounds 2,653, 2-agent 514, 3-agent 12, 4+ 0; 2,656 rounds below the required evidence groups. Only local Ollama among the AI providers is ACTIVE; Gemini, OpenAI, Claude, Kimi, Mistral, NVIDIA, OpenRouter, LiteLLM are skipped/offline, so News, Fundamental-style and debate evidence is largely absent.
* **Engineering inefficiencies that degrade evidence but do not explain zero trades [V]:** an unprioritized global idea cap dropping ~28-33% of ideas from every agent (D1), repeated near-identical Kronos predictions (D3), a movers funnel that kept 0 of 100 movers (D2).
* **Not established:** whether Argus missed genuinely tradable opportunities - **no independent market reference feed was available** (Alpha Vantage delayed data is not entitled on this key; I did not use the IBKR connector because its market-data requests could compete with the engine's 90 lines). Classification of individual morning movers is therefore NOT_VERIFIED.
No safety-critical condition was found. Nothing here supports lowering thresholds.

## 2. Funnel (09:29-10:10 ET, CLI window; production evidence)
| Stage | Count | Notes |
|---|---|---|
| Subscriptions | 90 allocated / 90 receiving / 90 fresh / 0 stale / 0 errors (10:08) | entitlement failures 0, contract failures 0 |
| Opportunity scan | 122 scanned (last scan), 139 shortlisted in the opportunity block; 64 shortlisted candidates | `subscribeRequested` 1 in the last cycle |
| Broad universe | 8,494 assets fetched, 8,435 screened, **20 candidates**; rejections PRICE 2,085, DOLLAR_VOLUME 6,100, SPREAD 130, NO_SNAPSHOT 59 | plausible at an open, unverified in detail |
| Movers (Alpaca) | 50 gainers + 50 losers fetched, 100 screened, **0 candidates** | reason breakdown NOT_VERIFIED (D2) |
| News-catalyst discovery | 100 considered, 57 screened, 19 candidates | |
| Agent evaluations | 3,079-3,182 (Kronos 2,788-2,884, Technical 1,294-1,345, Quant 233-241, JavaCoreEnsemble 77-78) | directional 99.9% |
| Rounds >= 0.60 / >= 0.75 | 13 / 0 | |
| Consensus approvals (STRONG/MODERATE) | 0 / 0 | MODERATE rejects: insufficient independence 5, calibration 8 |
| RiskEngine reached / approved | 0 / 0 | no RiskEngine rejections |
| OMS orders / fills | 0 / 0 | |
| Open positions / working orders | none / none (last orders Oct 13) | |
First stage at which the funnel becomes zero: **consensus** (0.75 not met after calibration). Upstream stages are non-zero. Missed-opportunity detector: 19 rows, all `CONSENSUS_REJECTION` (e.g. INTC rank 1, NVDA rank 3, MU rank 5 at 09:31-09:33 ET with ComposableRanking scores 0.66-0.71), horizon outcomes still PENDING (no outcome claimed).

## 3. Agent and strategy participation (09:30-10:00 ET exact, `agent_predictions`)
| Agent | n | symbols | BUY/SELL/HOLD | avg / max confidence |
|---|---|---|---|---|
| KronosEngine | 3,152 | 114 | 863 / 1,843 / 446 | 0.834 / 0.850 |
| TechnicalAgent | 570 | 104 | **568 / 2** / 0 | 0.593 / 0.788 |
| MacroAgent | 880 | 109 | 0 / 0 / **880** | 0.009 / 0.700 |
| QuantEngine | 129 | 15 | 37 / 92 / 0 | 0.804 / 1.000 |
| JavaFactorComposite (vote disabled) | 14 | 14 | 11 / 3 / 0 | 0.174 / 0.771 |
| JavaCoreEnsemble | 50 | 7 | 0 / 50 / 0 | 0.657 / 0.700 |
Quant by strategy: RANGE_REVERSION 89 (11 symbols; 37 BUY / 52 SELL), MOMENTUM_BREAKOUT 22 (SOFI, IWM; all SELL, **all raw confidence exactly 1.000**), MEAN_REVERSION 10 (WMT, SELL), TREND_FOLLOWING 8 (MCD, SELL). Observations: Kronos is SELL-heavy (58%); Technical is 99.6% BUY in the opening window; Macro is 100% HOLD (zero information); Quant is concentrated on 15 symbols. Pipeline agent states at 10:08: Kronos TICKING (one transient FAILED seen earlier; Chronos `/health` ok, last inference 423 ms), Quant GATED, News/Fundamental idea toggles off, JavaFactorComposite vote off. Strategy lifecycle states for the four CORE strategies were not re-read in this pass (**[O]**; verified at deployment).
Example top-confidence rejected round: GLD 10:09 ET, Technical BUY 0.40 vs Kronos SELL 0.51, 1 independent group, final 0.365, `CONFIDENCE_BELOW_STRONG` - consistent with correct abstention under disagreement.

## 4. Defects and findings (ranked; none is a proven cause of zero trades)
| ID | Sev | Finding | Evidence | Fix / status |
|---|---|---|---|---|
| D1 | P1 (exit latency) / P2 | `allowTradeIdea()` is a global first-come sliding window (120 ideas/min, `src/server/core/pipelineRateLimit.ts`, applied in `EventBus.emit`, no priority, no exemption). It was saturated (120 in window; 3,547 dropped since boot). Over the last ~30 min of `event_traces`: dropped/(emitted+dropped) = Kronos 28%, Macro 28%, Technical 33%, JavaCoreEnsemble 43%; Quant had 132 drops (its passed ideas are not labeled by agent in that sample, so no rate is stated). MacroAgent HOLD ideas alone spend ~20% of the budget on zero-information messages. | [V] counters and tail sample. Protective exits are subject to the same cap, but a dropped exit releases its cooldown (`portfolioIntel.ts` `IDEA_RATE_LIMITED` handler) and is re-emitted on the next ~60 s monitor cycle, so the loss is delay, not abandonment [V by code]. | **UPDATE (after this audit):** genuine protective exits (risk-exit agent SELL with origin PORTFOLIO_EXIT, same dual-key predicate as ChiefTrader) are now exempt from the cap and drops are attributed per agent - FIXED_AND_TESTED, MERGED_TO_MAIN (`8b0a47e3`), not deployed. Research-vote fairness (Macro HOLDs, Kronos repeats) is NOT changed (would alter how many votes reach ChiefTrader; needs separate review). |
| D2 | P2 -> reclassified | Movers funnel kept 0 of 100 at the open. | [V] Lineage ledger tail sample: PRICE 271 rejections (sub-$5 warrants/penny names, e.g. SEATW at $0.0029), DOLLAR_VOLUME 129 (thin leveraged single-stock ETFs and tiny names, mostly < $0.5M partial-day IEX dollar volume). | Reclassified as **genuine rejection**. Caveat [I]: the gate compares partial-day IEX volume to a full-day $5M threshold, biasing against the morning; a few names (SNDQ ~$1.8M, FMC ~$1.4M) might be liquid on consolidated volume. No proven blocked valid setup; research item only. |
| D3 | P2 | Kronos emits ~28 predictions per symbol per 30 min with saturated confidence; drives DB growth, grading starvation, and inflated evidence counts. | [V] | Dedup/throttle repeats; relates to the grading redesign. |
| D4 | P3/[O] | Technical 568 BUY / 2 SELL; Kronos SELL-heavy. Directional bias vs. market regime not established. | [V] counts, [O] cause | Research. |
| D5 | P2 | Calibration provider-row selection defect (per-provider rows returned before the `ALL` row). **Effect measured 11:10 ET [V]** on the production `agent_confidence_calibration` table (41 rows): only **NewsAgent** has per-provider rows (12 non-`ALL` rows against 5 `ALL` rows). Technical, Kronos, Quant, JavaCoreEnsemble, JavaFactorComposite, Fundamental and every other agent have **only `ALL` rows, so the defect cannot change their confidences**; MacroAgent has no calibration row at all (raw confidence passes). Where NewsAgent rows diverge, |provider - ALL| is typically 0.03-0.10 and reaches 0.28 in one thin bucket (0.9: 0.595 vs 0.875, n=11 vs 2). NewsAgent's idea toggle is off in this deployment, so **this defect did not cause any of today's low confidences**. | [V] | Fix `d6efe67b` is MERGED_TO_MAIN (owner instruction) and FIXED_AND_TESTED (2 regression tests); it is **not** in release candidate `8b0a47e3` and not deployed. It becomes relevant only when NewsAgent votes. |
| D6 | [O] | SELL ideas on symbols not held cannot trade (RiskEngine gate 22) yet appear as dissent; how ChiefTrader weighs them was not verified. | [I] | Research/verify. |
| D7 | P2 | Jev shadow scoring never runs because `ARGUS_JEV_SHADOW_SCORING_ENABLED` is unset (default off). See `ARGUS_JEV_INTEGRATION_FAILURE_ROOT_CAUSE.md`. | [V] | Ledger dedupe, idle-reason status and an end-to-end test are FIXED_AND_TESTED and MERGED_TO_MAIN; activation needs the flag and a controlled restart. See that document. |
Runtime notes: `EVENT_LOOP_LAG_WARN` last logged 09:37:55 ET and `SLOW_SQL_STATEMENT` 09:50:47 ET (detail not examined, **[O]**); `NEWS_PROVIDER_FAILED` is being emitted (providers not enumerated, **[O]**).

## 5. Runtime and safety (10:08-10:12 ET)
| Subsystem | State |
|---|---|
| Runtime SHA / checkout | PASS: `32613911842dfce05b722360bf67b7fb673dbb7b`, detached HEAD in the production checkout |
| Process | PASS: pid 25116, started 07:50:12, ~2 h 20 m |
| Mode / trading | PASS: PAPER, `TRADING_ENABLED`, Autobot on, no emergency stop, `LIVE_NO_GO` |
| IBKR Gateway | PASS: socket adapter, syncState READY |
| Reconciliation | PASS: latest cycle MATCH |
| Market data | PASS: 90/90 fresh |
| Positions / working orders | none / none |
| Watchdog | PASS: running (pid 21840), no storm lockout, 0 restarts in window |
| Agents | DEGRADED: AI providers mostly offline; Kronos had a transient FAILED |
| RiskEngine, OMS, PortfolioMonitor | NOT_VERIFIED beyond "no activity": exercised only by integration tests, no production order to observe |
| Event loop (mean/p95/p99) | NOT_VERIFIED this pass (one lag warning logged 09:37:55 ET) |
| Resources | RSS 1.29 GB (was 1.16 GB at 08:28 and 0.75 GB at 08:06); free disk 27 GB; `argus.db` 30.27 GB (+~1.05 GB since 08:00, ~0.5 GB/h, ~3 GB per full session); WAL 24 MB |
| Backup | NOT_VERIFIED/INADEQUATE: no restorable full backup; 40 MB critical-state export is not one |
Process liveness vs pipeline progress: the pipeline is progressing (Quant cycle completed 10:06 ET, subscription outcomes logged 10:08 ET).

## 6. Midday release decision
* CURRENT_PRODUCTION_SHA: `32613911842dfce05b722360bf67b7fb673dbb7b`
* MAIN_SHA: `8b0a47e329bb7b3bc8fcc1e5eeff22a9d6176fc3` (at the time of this update)
* CANDIDATE_SHA: `8b0a47e3` - certification IN PROGRESS (typecheck PASS, production build PASS, full suite running); production-calibrated and positive-capability synthetic sessions NOT RUN (heavy; not run during market hours)
* CERTIFICATION_STATUS: NOT_PROVEN until the full suite result is in
* OPEN_POSITIONS: none; WORKING_ORDERS: none
* BACKUP_RECOVERY_STATUS: no full recoverable backup
* INTRADAY_RESTART_SAFE: not decided - depends on the certification result; the book is flat, which would permit a restart, but none happens without explicit owner approval
* RECOMMENDED_ACTION: keep production running until certification completes, then request approval.
* REQUIRED_OWNER_APPROVAL: any deployment.

## 7. Next measurements (no engine disruption)
Per-candidate reasons for the 100 movers (D2); per-agent drop counts from a longer `event_traces` tail (D1); a quantified calibration effect of the provider-row defect on an isolated copy (D5); strategy lifecycle states and expected-value / reward-to-risk gate counts for the four CORE strategies; an independent reference feed for a real opportunity-recall audit (needs an entitled data source).

## 8. Bounded diagnostics of the 09:30-10:00 window (added 11:00 ET; indexed `observability_events` scan of 170,719 rows in 2.6 s)
* **Subscriptions healthy across the whole window [V]:** `MARKET_DATA_SUBSCRIPTION_OUTCOME` ALREADY_ACTIVE 462 / 481 / 504 and ACCEPTED 17 / 11 / 14 in the three 10-minute buckets; zero subscription error/stale/failed events in the window (not only at 10:08).
* **Event-loop lag 7.6 s at 09:37:55 ET [V event, I cause]:** coincides with a 7,516 ms `select ... from observability_events where event_type = ? and ts >= ? and ts < ?` (`SLOW_SQL_STATEMENT`). The only reader I know of at that moment was my own read-only `argus trading-funnel` call (default 24 h window, started 09:37:47 ET, the exact window start recorded in its output): **the engine's own report endpoint ran the query inside the trading process, stalling its event loop ~8 s.** This is self-inflicted by the audit, and also an engineering finding: **D8 (P2): an operator read-only report can stall the trading event loop for seconds.** Correction (11:40 ET): `/trading-funnel` is ALREADY covered by the router-level `operatorReportGuard` (since 2026-10-14); that guard serializes and memory-gates reports but cannot stop a synchronous query from blocking the loop. The fix is the bounded window (default 2 h, cap 24 h); a first attempt to add `guardHeavyReport` was wrong (it deadlocks against the outer guard, caught by `operatorReportGuard.test.ts` in certification) and was removed.
* **Slow SQL 2.0 s at 09:50:47 ET [V]:** `DELETE FROM consensus_evidence WHERE id IN (SELECT ... JOIN consensus_decisions ... LIMIT ?)` - the retention sweeper's batched delete blocked the loop for ~2 s during trading: **D9 (P2).** Batch size/yield tuning is a candidate; not changed.
* **Synchronous observability persist [V]:** 8 `SYNC_PERSIST_SLOW` events (0.5-0.96 s each, `ObservabilityStore.defaultPersist`) in the window: **D10 (P2)**, known class (the persistence is synchronous on the event loop).
* **News providers failing continuously [V count, O identity]:** `NEWS_PROVIDER_FAILED` 362 times in 30 minutes (~12/min). The emitting code (`NewsProviderManager.fetchAllLatest`) publishes `{providerId, error}`, but the persisted observability payload is empty `{}` and the event is not in `event_traces`, so **which provider fails and why cannot be recovered from the database: D11 (P2 observability defect).** `news_providers` table is empty (providers are configured elsewhere). News evidence is therefore degraded for an unattributed reason; NOT_VERIFIED whether it relates to the provider outages seen in the AI-provider health table.
* **Idea-cap pressure [V]:** `IDEA_RATE_LIMITED` 1,608 events in the window, consistent with D1.
* **Zero consensus approvals - scoring defect check [V/I]:** no deterministic-scoring defect was found in the sampled rounds (example GLD round: Technical BUY 0.40 vs Kronos SELL 0.51 -> final 0.365 with one independent group). The reduction applied in 3,170 of 3,182 rounds is the calibration layer working as designed on agents with thin/clustered calibration samples; whether the provider-row selection defect (D5) distorts it is the open measurement.
