# ARGUS Oct 12 live forensic — INTERIM RECORD (frozen before any repair)

Read-only evidence from `data/argus.db` (window from 13:27:24Z, engine run since resume). No secrets. No engine/DB/config changes were made to produce this.

## Quant evaluation latency (exact STARTED→FINISHED pairing by trace_id; 1126 pairs, 262 STARTED without FINISHED)

| Stage | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Total, outcome ASSESSED | 812 | 311 s | 1515 s | 1753 s | 2055 s |
| Total, outcome ERROR | 314 | 306 s | 387 s | 485 s | 524 s |
| Data wait (start → bar-input event), ASSESSED | 812 | 11 ms | 146 s | 667 s | 676 s |
| After bars (compute + persist), ASSESSED | 812 | 308 s | 1467 s | 1634 s | 1784 s |

## Findings
1. **ERROR cause (inferred, strongly supported):** all 314 errors fail before the bar-input event, cluster at ~300 s, and `config/tradingSafety.json:quantBarsCoalesceEntryMaxAgeMs = 300000`. They match `HistoricalDataGateway` COALESCE_CALLER_TIMEOUT: a caller waits on an in-flight `ensureBars` whose inner provider call has no cancel path. Not yet confirmed from a log line (engine stdout is discarded; the error message is not persisted by `QUANT_SYMBOL_EVAL_FINISHED`). 41 distinct symbols affected, not one bad symbol.
2. **Latency is not data fetch.** Median data wait is 11 ms; the median 308 s sits after bars are available (getMarketContext, strategy evaluation, persistence, event-loop stalls). Per-stage split inside that span is NOT yet measured.
3. Observability gap: evaluation error cause is not persisted; engine console output is discarded.
4. Earlier-established (see session): quant ideas dropped at authorization (70/72 NO_LIFECYCLE_RECORD), single evidence group blocks consensus, 0 authorized strategies, legacy sequential scheduler active.

## Addendum (same day, after review feedback)
- **Correction to finding 2:** the 11 ms data-wait covers only the primary symbol's bars. `getMarketContext()` (`MarketContext.ts:148-160`) then fetches SPY/QQQ/IWM, the sector ETF and relative-strength bars through `ensureBars()` — none of that is timed. "Not data fetch" is NOT established. Cache logic (3-day tail tolerance, 0.85 coverage) means benchmarks are usually cache hits, so provider calls mainly occur for newly admitted symbols with thin caches; the IBKR historical path is one global serial chain (`IbkrSocketSession.histChain`, 15 s timeout per request) falling back to Alpaca (400 ms pacing). A silent IBKR gateway therefore queues every provider fetch behind 15 s timeouts. Hypothesis, untimed.
- **Coalesce timeout is consistent with, not proof of, the 314 errors.** Error text is not persisted. 262 started-but-unfinished are unclassified (age/epoch not yet checked); do not call them hung.
- **Host resource evidence (measured 10:46 ET):** free RAM 0.8 of 15.7 GB, Pages/sec 6380 → 589 across 3 samples (heavy paging), CPU ~62%; llama-server 4.0 GB, node 1.4 GB, Chronos python 308 MB; the Java quant core's working set is only 32–264 MB (paged out/trimmed).
- **Java bridge today (28,138 outcomes):** `ticks` TIMEOUT 2,009 (of ~23.5k), `quant/ensemble` TIMEOUT 465 + CIRCUIT_OPEN 619, `institutional/*` CIRCUIT_OPEN ~800, concentrated 13–14 UTC hours. Breaker is opening. The Java ensemble call is fire-and-forget, so this does not directly add to evaluation wall time, but it is the same contention signature.
- **Working hypothesis (untested):** host memory pressure/paging (Ollama model + other processes) inflates every await, event-loop stalls stretch wall-clock durations, and bar-gateway stalls produce the coalesce timeouts. Needs per-stage timing before any claim.
- **Planned repair (isolated worktree only, not deployed today):** persist bounded error code on `QUANT_SYMBOL_EVAL_FINISHED`; emit per-stage duration events (intraday fetch, market context, features, evalAll, selection, AI, persist); bound the inner IBKR/Alpaca fetch with a real timeout; synthetic latency regression test. No restart until stage timings exist.

## Addendum 2 (11:00–11:25 ET): Ollama stop and stage localisation
- **Ollama:** `ollama serve` (child of the tray app) held `0xroyce/plutus:latest` (3.5–4 GB). Argus (Bull/Bear researchers, MacroAgent, ConsensusDebate fan-out) kept calling it: 942 of the last 1,000 logged requests were HTTP 500 (~22 s each), "Load failed" repeated, and a `keep_alive:0` unload was undone within seconds by new calls. With operator authorization the tray app, server and orphaned `llama-server` were stopped (~11:02 ET); nothing respawned (12 samples). Argus `/health` stayed ok. Not touched: Argus, Java core, IBKR Gateway, Chronos, config, trading state.
- **Host effect (measured):** free RAM 0.8–1.1 GB → 4.7–6.1 GB; Pages-input ≈8,700/s (peaks 16,000/s while the model reloaded) → ≈80–300/s with occasional spikes (2,648/s once, coinciding with a node working-set swing); Java bridge SUCCESS:TIMEOUT 2,244:911 → 15,118:655 cumulative-in-window (ratio improved); evaluation errors 41/460 → 5/299.
- **Not improved:** throughput ≈30 evaluations/min before and after; latency of evaluations that STARTED after the stop: p50 301 s, p95 308 s, max 315 s. Memory pressure is therefore NOT the cause of the 300 s.
- **Where the 300 s is (exact, from existing per-trace events, 294 evaluations started after the stop):** start→bar-input p50 7 ms; **bar-input → selection-pool p50 300,575 ms (p95 307,801)**; selection → quote-evidence p50 4 ms; → finished p50 10 ms. No evaluation (n=303, 89 symbols) was under 20 s in that span, so it is universal, not symbol-specific. The span covers intraday fetch, regime, `getMarketContext`, feature computation, `evaluateAll`, adaptive selection, `groupedScores`, input-evidence recording and `filterQuarantinedStrategies`. The tight variance (300–315 s) indicates a ~300 s timer or serialized queue, not load.
- **Supporting facts:** `getMarketContext` benchmark failures swallowed into `marketContext.source` strings are COALESCE_CALLER_TIMEOUT (143 in assessments since start; 11 for sector ETF XLP post-stop), i.e. confirmed for that sub-path; relativeStrengthVsSPY was non-null in 454/454 post-stop assessments, so benchmark data usually arrives — yet the 300 s still elapses. XLI daily cache tail is 46.6 days stale. Several ETFs hold more daily rows than trading days (QQQ 489 rows / 364-day span), consistent with two sources (alpaca 04:00Z vs ibkr 00:00Z timestamps) writing separate rows for the same day — unverified, candidate data-quality defect.
- **Scheduler (running engine, started 09:27:24 ET from source; `QUANT_PRIORITY_SCHEDULER_ENABLED` absent from `.env`):** legacy fan-out. Only ONE `QUANT_CYCLE_STARTED` today (13:28:15Z, universe 10, concurrency 1, provider `ibkr_gateway`) and no `QUANT_CYCLE_COMPLETED` in ~100 min; the legacy per-symbol attempts logged durations of 452 s and 4,071 s. The ~30/min evaluations are on-demand callers, not the cycle. Priority scheduler code is present, flag-gated, certified by tests, default OFF; enabling needs a restart.
- **Instrumented build** (`repair/quant-latency-instrumentation`, uncommitted) will name the exact stage; not deployed.

## Addendum 3 (11:40 ET): measured concurrency and its source
- From STARTED/FINISHED events since 13:27Z: **3,035 on-demand vs 8 cycle-driven evaluations; in-flight count 218–406 (max 406, ~311 at last sample); 101 symbols, median 33 evaluations per symbol (NVDA 45).** Little's-law estimate (30/min × 300 s ≈ 150) understated it.
- **Source verified in code:** `ConfluenceCoordinator.maybeTrigger` calls `quantSignalAgent.evaluateSymbol(symbol)` with only a 60 s per-symbol trigger cooldown (`confluenceCoordinatorCooldownMs`) and no in-flight guard; 3,174 `CONFLUENCE_COORDINATOR_TRIGGERED` events today. Evaluations last ~300 s, so ~5 overlap per symbol. (The legacy cycle, concurrency 1, is not the load.)
- **Status of the 300 s itself:** still unlocated. The overlap is a verified amplifier (hundreds of simultaneous `getMarketContext` benchmark/sector `ensureBars` calls) and a plausible cause of the shared-queue behaviour, but it is NOT proven to be the cause.
- **Repair (isolated worktree `argus-repair-latency`, uncommitted):** per-symbol in-flight guard for the coordinator's QuantEngine trigger (`ConfluenceCoordinator.ts`), released on success and on failure; regression `ConfluenceCoordinator.quantInflight.test.ts` (red against old behaviour: 2 calls vs 1; 5 tests; all 32 coordinator tests green). No threshold, consensus, lifecycle, Risk/OMS or scheduler change. Not deployed.

## Not yet established
Per-stage compute split; strategy-level funnel; movers comparison against a second data source; per-candidate classification; Jev/provider table. No repair, restart, or authority change has been made today.
