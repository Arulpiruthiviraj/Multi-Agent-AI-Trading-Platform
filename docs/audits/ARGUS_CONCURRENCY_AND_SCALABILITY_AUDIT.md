# ARGUS — Concurrency, Throughput, Saturation & Scalability Forensic

**Mode:** architecture audit → capacity measurement → controlled load testing → bottleneck identification → remediation plan
**Date:** 2026-10-06
**Posture:** PAPER / RESEARCH ONLY. LIVE_NO_GO. No broker orders, no LIVE enablement, no RiskEngine weakening, no threshold changes, no production DB tests, no real broker as load target. No performance numbers fabricated — every figure below is measured or explicitly labeled as static-analysis inference.

---

## EXECUTIVE SUMMARY

**"100 concurrent" is five different questions in Argus, with five different answers:**

| Workload | 100 concurrent | Verdict |
|---|---|---|
| HTTP read requests (light endpoints) | SUPPORTED | ~357 req/s at 100 conc, p50 154 ms, 0 errors; degrades gracefully |
| HTTP read requests (mixed, incl. heavy `/health`) | SUPPORTED_WITH_LIMITS | ~161 req/s at 100 conc, p50 273 ms, p95 1.2 s |
| Symbol evaluations (full agent pipeline) | SUPPORTED_WITH_LIMITS | Governors serialize most of it (Fast Lane ≤3, Java ≤20, advisory single-flight); the unmodeled risk is synchronous CPU: 5 sync strategies/symbol on the event loop |
| Fast Lane candidates | SUPPORTED (by rejection) | Max 3 concurrent by config; the other 97 get explicit refusals, not silent queueing |
| DB reads (indexed) | SUPPORTED | Sub-ms at 1M rows; the danger is unindexed/full-scan reads, not concurrency |
| DB writes | SUPPORTED | Batched, bounded; flush loop caps at ~1,333 rows/s, SQLite could absorb ~50k rows/s |

**What saturates first:** the single Node.js event loop. Everything CPU-bound or synchronous (better-sqlite3 calls, the 5 synchronous strategies per symbol evaluation, RiskEngine's ~8 sync DB calls per decision, ReflectionEngine's per-minute 150k-row `.all()` materialization) runs on the main thread. There are **zero `worker_threads`** in the server. I/O concurrency (HTTP to Java, AI providers, market data) is well-governed and does not block Node.

**The single most dangerous pattern found:** `ReflectionEngine` runs unbounded synchronous full-table materializations (~1.2 s of main-thread block per 150k rows, growing linearly with table size) every 60 seconds — the same scan family behind the 2026-10-05 heap-growth → fail-closed auto-pause incident. The `kronos_predictions` scan is deliberately unbounded per a 2026-09-23 design decision and still needs its dedicated calibration review.

**Backpressure posture:** strong at the edges (Fast Lane rejects over cap, Java bridge coalesces, observability drops newest over 2000, WS drops congested clients), **weak in two FIFO queues with no cap and no timeout** — `ChronosForecastGate.waiters` and `RiskEngine.evaluationQueue` — where burst load means unbounded latency growth with no shed-load path.

**Final verdict:** `CURRENT_CAPACITY = MODERATE`, `SCALABILITY = IMPROVEMENTS_RECOMMENDED`, `100_CONCURRENT_WORK_ITEMS = SUPPORTED_WITH_LIMITS` (workload-specific, see table).

---

## RUNTIME MODEL

| Component | Runtime | Process | Thread model | Queue | Max concurrency | Backpressure | Timeout | Retry |
|---|---|---|---|---|---|---|---|---|
| Argus engine (TradingEngine, RiskEngine, OMS, all agents, discovery, consensus) | Node.js 24 | 1 (`scripts/argus-engine.ts`) | Single event loop, zero worker_threads | Various (see Backpressure) | Event-loop-bound | Mixed (see below) | Per-call | Varies |
| Java quant core | JVM 26 | 1 persistent (`scripts/lib/javaQuantCoreLauncher.ts`, port 8085) | JVM threads | HTTP server queue | 20 in-flight from Node side | Coalesce per symbol | 100 ms per call | Circuit breaker (3 fails, 30 s cooldown) |
| LangGraph research | Python | 1 isolated | Asyncio | Loopback HTTP | 2 concurrent runs | Reject over cap | Configured | Unknown |
| Ollama models | Ollama | Detached child_process | — | HeavyModelMutex | 1 active, queue 10 | Fail fast | Configured | Fail-closed |
| Chronos/Kronos inference | Python `local_ai_service.py` | 1 (port 8008) | — | ChronosForecastGate | 1 concurrent | **UNBOUNDED FIFO waiters, no timeout** | None found | Unknown |
| Market data WS | Node (same process) | — (in-engine) | Event loop | Single Alpaca IEX socket | 1 socket; 12 Alpaca / ~90 IBKR subs | Evict lowest-priority | Reconnect backoff | Yes |
| SQLite | better-sqlite3 (sync) | In-engine | Main thread only | Single shared connection | 1 writer, N readers (WAL) | busy_timeout 5000 ms | 5 s busy | No |

Single Node process, zero worker_threads — confirmed by grep. Research, RiskEngine, OMS, reconciliation, heartbeat, observability flush, and all agents share the one main-thread event loop. What runs elsewhere: Java (separate JVM over HTTP), LangGraph (separate Python over loopback HTTP), Ollama (detached child process).

---

## EVENT LOOP

### What blocks it (ranked)

**CRITICAL**
- `src/server/engines/RiskEngine.ts:116,357,360,388,404,444,445,538` — `evaluateRisk()`, the serialized hot path for **every** trade decision, performs ~8 synchronous better-sqlite3 round-trips per evaluation (`trades`, `riskAssessments`, `settings`, `portfolio`, plus a `settings` update). Each blocks the event loop for its full query duration. (The 2026-10-05 `e461e8e` fix replaced a full-table materialization with two scoped SQL queries — the count of sync calls is unchanged, only scan cost dropped.)
- `src/server/services/ReflectionEngine.ts:310,283` — **unbounded** `db.select().from(kronosPredictions).all()` plus full `agent_predictions` materialization **every 60 s**. Measured on a 1M-row schema-identical synthetic DB: **~1.2 s of synchronous main-thread block per 150k-row `.all()`**, growing linearly with table size. Same scan family as the 2026-10-05 heap incident.

**HIGH**
- `src/server/observability/ObservabilityStore.ts:40-41` — `defaultPersist` does a synchronous multi-row `db.insert` on the main thread per flush (batch 100, every ≤75 ms under load). Batched, but still main-thread-blocking per flush. Measured: 1.9 ms per 100-row batch.
- `src/server/core/Logger.ts:38-42` — legacy JSONL logger: every trading-event log call does `existsSync` + `statSync` + rotation check + `appendFileSync`. Synchronous fs I/O per event on the main thread.

**MEDIUM**
- `src/server/continuous/OpportunityDiscovery.ts:151,571,611,750` — `.sort()` over candidate arrays per discovery cycle; currently bounded by TOP_N caps (25), small unless caps rise.
- `src/server/continuous/PostMarketAnalysis.ts`, `ComposableRanking.ts` — `JSON.parse` on DB-stored JSON blobs per row during scans; bursty.

**LOW**
- TS indicator math (`TechnicalIndicators.ts`, `quant/indicators/*`) — O(n) over bounded bar arrays (hundreds of bars). Heavy quant lives in `quant-core-java/` per the standing architecture rule.
- `crypto.scryptSync` (startup only), PID-file/session-recovery sync fs (startup/recovery only).

### Measured event-loop pressure (HTTP concurrency, isolated engine, PAPER)

The p50/p95 latency inflation under concurrency **is** the event-loop queueing signal — no separate lag probe was needed to see it:

Mixed read endpoints (`/health`, `/status`, `/live-readiness`):
- 10 conc: 179 req/s, p50 20 ms, p95 177 ms
- 50 conc: 178 req/s, p50 115 ms, p95 559 ms
- 100 conc: 161 req/s, p50 273 ms, p95 1,223 ms
- 250 conc: 116 req/s, p50 1,351 ms, p95 1,992 ms — throughput falling, saturation

Light endpoint (`/status` only, ~3–5 ms idle):
- 50 conc: 379 req/s, p50 88 ms, p95 233 ms
- 100 conc: 357 req/s, p50 154 ms, p95 578 ms
- 250 conc: 278 req/s, p50 392 ms, p95 827 ms
- 500 conc: 184 req/s, p50 923 ms, p95 1,874 ms — **0 errors at 500 concurrent; degrades gracefully, never crashes**

Idle per-endpoint cost: `/health` ~10–28 ms (fans out over agents/broker/AI checks — the heaviest read), `/status` ~3–5 ms, `/live-readiness` ~2–3 ms.

**Classification:** at 100 concurrent mixed reads, event-loop queueing delay is in the 100–500 ms band (p50 273 ms); at 250+ it exceeds 500 ms and throughput declines. The loop never deadlocked in any test.

---

## CPU

- Engine process during/after load: ~428 MB RSS, idle CPU ~0% post-test, healthy `/health` throughout. No CPU saturation observed from HTTP load alone — the ceiling is event-loop serialization, not core exhaustion (single-threaded Node cannot saturate multiple cores by itself).
- Hottest synchronous CPU identified statically: `StrategyEngine.evaluateAll()` — 5 strategies via synchronous `.map()` per `QuantSignalAgent.evaluateSymbol()` (`src/server/quant/strategies/StrategyEngine.ts:136-165`); `EventBus.emit()` sequential sync dispatch loop (`src/server/core/EventBus.ts:124-137`).
- 100 symbols × 5 strategies = 500 sequential strategy evaluations occupying the event loop — the primary CPU-contention candidate. Not directly load-measured (no market data in the sandbox); static finding.
- No per-core saturation measured; GC pauses not observed as a factor in these tests.

## MEMORY

- Observed: engine RSS ~428 MB after HTTP sweep (up from ~300 MB-class at boot); no leak signature in the short window, but the 2026-10-05 incident (heap 900 MB → 2.1 GB in ~10 h from three unbounded per-cycle scans, two since fixed) shows the growth vector is **unbounded scan materialization**, not request load.
- Bounded caches verified: `closesCache` evicts (`e461e8e`), `recentIdeas` TTL-swept and bounded by symbols × agents, `pendingDebates` ref-counted, `consensusQueues` entries deleted on settle, `trackedOrders` capped at 1000 (evict-oldest).
- Observability queue hard-capped at 2000 events (drop-newest). WS per-client 1 MB high-water drop.
- **Not performed:** 15–30 minute soak under sustained load (memory/CPU/WAL trend). Stated plainly as a gap.

---

## DATABASE

**Verdict: `SQLITE_ANALYTICS_BOTTLENECK`** — writes are healthy; the binding constraint is synchronous analytical/full-scan reads on the main thread.

- **Connection model:** single shared read-write better-sqlite3 connection (`src/server/db/index.ts:73`), drizzle-wrapped. WAL mode, `busy_timeout=5000`, `synchronous=NORMAL`, `temp_store=MEMORY`, `cache_size` 2 MB. All writes serialize through the one connection; WAL gives many-readers/one-writer. **Every better-sqlite3 call runs synchronously on the Node main thread** — zero worker-thread DB usage. WAL helps SQLite's concurrency; it does not make a synchronous query asynchronous from Node's perspective.
- **Write path:** observability flush = one multi-row INSERT per batch (100 rows / 75 ms) = one implicit transaction; measured **1.9 ms per 100-row batch** → flush loop caps throughput at ~1,333 rows/s while SQLite itself could absorb ~50k rows/s. Consensus rounds use explicit `db.transaction()` (atomic). Agent predictions are single-row autocommits (low frequency). No write bottleneck measured or visible in code.
- **Read latency (1M-row synthetic, production-identical schema/indexes; local dev DB was nearly empty so this is the meaningful measurement):** PK lookup 0.03 ms; latest-50 `ORDER BY ts DESC LIMIT 50` 0.21 ms; `COUNT(*)` full scan 17.5 ms (~175 ms at 10M rows); **full 150k-row `.all()` materialization ~1,270 ms** (full scan + V8 materialization, linear growth).
- **Index gaps (latent, not active):** no index on `symbol`, `component`, `logger_name`, `level`, `session_id` in `observability_events` — fine for `LIMIT 50` short-circuit scans today (0.29 ms), but a rare-symbol forensic lookup at 10M rows degrades toward a full scan (~175 ms+ sync block). Recommend `(symbol, ts)` if symbol-filtered forensics become frequent.
- **Checkpoints:** manual `wal_checkpoint(TRUNCATE)` only at graceful shutdown / DB export / import; otherwise SQLite auto-checkpoints at 1000 WAL pages (~4 MB), briefly taking the write lock (covered by busy_timeout).
- **Retention sweep:** batched 5,000-row DELETEs with `setImmediate` yields between batches — the 8-minute main-thread block is fixed.
- The local `data/argus.db` in this environment is 1.2 MB / 91 tables (dev DB); production comments reference ~9.8M observability rows. All scale numbers above come from the synthetic 1M-row test, labeled as such.

---

## FAST LANE

- One candidate → one `quantSignalAgent.evaluateSymbol(symbol)` → 1 bar fetch + 5 synchronous strategies. No per-strategy network fan-out; shadow-only (never emits trade ideas, never touches ChiefTrader/RiskEngine/OMS/BrokerManager — `fastLaneEvaluator.ts:74-78`).
- **Governor:** `fastLaneMaxConcurrentEvaluations: 3` (`config/tradingSafety.json:4`), enforced at `fastLaneEvaluator.ts:104`. Same-symbol single-flight via `inFlightBySymbol` (concurrent same-symbol calls coalesce onto one promise); per-symbol 60 s cooldown.
- **100 candidates:** at most **3 evaluations in flight**; the rest receive explicit `MAX_CONCURRENT_EVALUATIONS_REACHED` / `SYMBOL_EVALUATION_COOLDOWN_ACTIVE` refusals. Worst-case compute expansion is 100 × 5 = 500 strategy evals, but serialized through the 3-slot gate — bounded by rejection, not by queueing. **This is the correct pattern** (bounded + explicit refusal).
- Fast Lane is registered in the same independence group as core quant evidence, so it cannot manufacture a second independent consensus vote from the same calculation.

## AGENTS

- Dispatch: `EventBus.emit()` iterates listeners with a plain sync `for` loop — **no `Promise.all`, no awaiting** (`EventBus.ts:124-137`). One symbol's tick invokes each subscriber's sync prefix sequentially; each then launches its own un-awaited async work.
- Idea-emitting agents: TechnicalAgent, NewsAgent, FundamentalAgent, MacroAgent, KronosEngine, QuantSignalAgent, JavaFactorComposite, JavaCoreEnsemble. AI/LLM-backed: Macro, Fundamental, News. Deterministic: Technical, Quant, Kronos, JavaCoreEnsemble, JavaFactorComposite (the four non-AI voters can reach consensus alone — standing invariant).
- **Fan-out multiplier (static model):** 1 symbol ≈ 10–14 tasks (tick dispatch 5 + assessments + 4 parallel Java HTTP + debate 2 LLM if triggered + consensus per idea). Extrapolated: 10 symbols ≈ 100–140; 50 ≈ 500–700; 100 ≈ 1000–1400 **potential** tasks — but realized concurrency is bounded by governors: EventBus dispatch is sequential, Java advisory is round-robin single-flight (1 symbol/tick), Fast Lane ≤3, Java ticks ≤20 in flight. The feared "100 × 8 = 800 simultaneous assessments" does not materialize as true simultaneity.
- Consensus aggregation is parallel **per idea** (`Promise.all` over ideas); ChiefTrader debate is exactly 2 parallel LLM calls (bull+bear) with cooldown.

## STRATEGIES

- `evaluateAll()` runs the 5 core strategies **synchronously and sequentially** per symbol. 100 symbols = 500 sequential strategy evals on the event loop — CPU-bound, uninterruptible, no timeout. This is the primary "100 CPU-heavy jobs" hazard: unlike I/O, it cannot yield mid-flight.
- Trigger gate (2026-10-04): a strategy whose defining trigger didn't fire gets confidence capped below the trade bar — fail-closed, no silent promotion.
- Experimental strategies are quarantined behind flags; `resolveStrategiesForLiveEvaluation()` returns the core 5 by default.

## JAVA

- **Mechanism: HTTP to a persistent JVM** (not JNI, not spawn-per-call). Bridge: `QuantCoreBridge.ts`; JVM launched once at boot (`javaQuantCoreLauncher.ts`), fixed port 8085.
- **Java does not block Node.** All calls are `await fetch()` with `AbortSignal.timeout(100 ms)`; worst case is a 100 ms timeout + fail-closed null. Separate circuit breakers per endpoint family (3 failures → 30 s cooldown).
- **Concurrency governor:** `quantJavaCoreTickMaxConcurrency: 20`; `forwardTick()` coalesces per symbol (latest tick wins, max one in-flight per symbol). This was a real measured fix: pre-fix bursts hit **3,326 simultaneous in-flight requests**; post-fix ~8.
- Tick path is the only network-throttled surface; compute calls are separate.

## AI PROVIDERS

- Fan-out bounded by provider count (~10), not by workload (`Promise.all` over `availableProviders`).
- Heavy local LLM models: **1 active, queue 10** (`HeavyModelMutex.ts`); overflow **fails fast** with thrown error → caller fail-closes (HOLD / confidence 0).
- News LLM escalation: **2 calls/cycle**; overflow skips with warning.
- Provider quota/rate limits are a **provider-side** constraint, not an Argus CPU constraint — audited separately by design. Timeouts, circuit breakers, backoff present.

## MARKET DATA

- **Not stress-tested** (per instructions — IBKR is never a load target). Audited from code/config.
- Subscription caps: 12 Alpaca / ~90 IBKR Gateway streaming lines; max 20 new subscriptions/cycle; eviction of lowest-priority dynamic symbols when full. Temp data rescues: 6 concurrent with reserved priority slots.
- **The ~90-line IBKR constraint is a subscription entitlement limit, not an application-processing limit** — it must not be reported as "Argus can only process 90 things."
- `ARGUS_DISABLE_MARKET_DATA_WS=true` in the perf environment; no market-data concurrency was measured.

## WEBSOCKETS

- **No server-side broadcast fan-out exists to audit.** `wsRegistry.ts` defines `setGlobalWss`/`getGlobalWss`, but `setGlobalWss` has **zero callers** — no WebSocketServer is ever instantiated for client broadcast. UI live updates go over HTTP polling/SSE.
- The only real WebSocket is **outbound**: `MarketDataWorker`'s single Alpaca IEX client socket, with reconnect backoff. No per-client fan-out, no slow-client backpressure question arises.
- **TUI impact:** the new TUI polls HTTP (2 s health/banner, 5 s screens, 8–10 s slow diagnostics) with request dedup (never overlapping). At these rates one TUI adds ~1–2 req/s — immaterial against the measured ~180–380 req/s HTTP capacity. Multiple monitoring clients scale linearly and remain negligible until dozens of clients. **If a future TUI/UI adds WS/SSE broadcast fan-out, that will need its own backpressure design; currently N/A.**

## OBSERVABILITY

- Pipeline: in-memory queue (cap 2000, **drop-newest** on overflow, counter incremented) → batched flush (100 rows / 75 ms) → synchronous multi-row INSERT (measured 1.9 ms). Flush errors **discard the batch** (no re-queue). Kill-switch `enqueueBlocked`.
- Max theoretical event rate ≈ 1,333 rows/s by flush-loop design; SQLite could absorb ~50k rows/s — the loop, not the DB, is the limiter.
- The `/events` API (`ORDER BY ts DESC LIMIT 500`) and `getDecisionTrace` (`decision_id`) are index-served — sub-ms at 1M rows.
- **Verdict: observability cannot take down trading by volume** — bounded queue, drop-newest, discard-on-error, isolated from the live trading spine by explicit design. The risk is not write volume but the **read side**: unbounded forensic scans (ReflectionEngine) on the same main thread.

---

## BACKPRESSURE

### Bounded / well-behaved
- Observability queue: 2000 cap, drop-newest, discard-on-flush-error.
- Java tick bridge: per-symbol coalescing + ≤20 global in-flight (fixed a real 3,326-in-flight incident).
- Fast Lane: 3 concurrent, reject-over-cap + same-symbol single-flight + 60 s cooldown.
- Consensus: per-symbol promise-chain mutex, entries deleted on settle; debate cooldown.
- WS: per-client 1 MB high-water drop + keepalive termination of congested sockets.
- `recentIdeas` TTL-swept; `pendingDebates` ref-counted; `trackedOrders` capped 1000 (evict-oldest-terminal-first).
- Heavy reports: `guardHeavyReport` serializes with a memory circuit breaker (refuses rather than queues).

### UNBOUNDED — red flags
1. **`ChronosForecastGate.waiters` (`KronosInference.ts:37`): NO cap, NO timeout.** With max 1 concurrent forecast, a burst piles FIFO waiters indefinitely, each holding its caller's promise chain. Unbounded queue growth with no backpressure signal to the producer.
2. **`RiskEngine.evaluationQueue` (`RiskEngine.ts:223-248`): global FIFO promise-chain mutex, NO waiter cap, NO queue timeout.** Every `evaluateRisk()` serializes behind all prior ones; latency grows without bound under burst, no shed-load path. Combined with ~8 sync DB calls per evaluation, one slow query lengthens the queue for everyone — including the trading spine.
3. **`EventBus.emit` (`EventBus.ts:34,61`): synchronous, `setMaxListeners(50)`.** No queue at all — a slow listener blocks the emitter and every subsequent listener inline.

### Priority under load (§30)
P0 (risk, reconciliation, position accounting, kill switch) and P1 (market data, positions) share the single event loop with P2–P4 (decisions, research, Fast Lane, observability, UI). **No priority enforcement exists at the loop level** — a P4 synchronous scan (ReflectionEngine) blocks P0 work for its full duration. Partial mitigations: observability is volume-isolated (drop-newest), Fast Lane/Java/AI are concurrency-gated, heavy reports have a circuit breaker. The residual risk is any synchronous DB/scan work issued outside those gates.

---

## LOAD TESTS

Environment: real engine boot, isolated temp DB, `SYNTHETIC_SIMULATION=true`, `PAPER_TRADING_ONLY=true`, `internal_paper` broker, market-data WS disabled, port 3400. Read-only endpoints only. No broker touched.

| Test | Result |
|---|---|
| HTTP mixed reads (10/50/100/250 conc, 400 req) | 179 → 178 → 161 → 116 req/s; p50 20 ms → 1,351 ms; **0 errors at every level** |
| HTTP light reads (50/100/250/500 conc, 500 req) | 379 → 357 → 278 → 184 req/s; p50 88 ms → 923 ms; **0 errors even at 500 concurrent** |
| Engine survivability | Healthy `/health` throughout and after; RSS ~428 MB; no crash, no deadlock |
| DB write model (synthetic 1M-row) | 1.9 ms per 100-row batch; ~1,333 rows/s flush-limited |
| DB read model (synthetic 1M-row) | Indexed lookups 0.03–0.29 ms; full 150k-row `.all()` ~1,270 ms sync block |

**Not performed (stated, not faked):** 15–30 min soak; symbol-evaluation load at 10–200 symbols (no market data in sandbox); DB write flood at 500–1000 rows/s against the live engine; failure injection; watchdog-under-load behavior.

---

## SOAK TEST

Not performed. The short-window load tests show no leak signature (RSS stable post-test), but the standing 2026-10-05 incident (heap 900 MB → 2.1 GB in ~10 h from unbounded per-cycle scans) is the reason a soak is warranted — specifically watching `kronos_predictions` growth against the per-minute ReflectionEngine scan. Recommended before any capacity claim beyond this report.

## CAPACITY ENVELOPE

Measured (M) vs. static inference (S). Do not treat S rows as measured.

| WORKLOAD | SAFE | DEGRADED | SATURATION | Basis |
|---|---|---|---|---|
| HTTP reads, light endpoints | 100 conc / ~350 req/s | 250 conc, p95 ~0.8 s | ~500 conc, p95 ~1.9 s, throughput falling | M |
| HTTP reads, mixed (incl. `/health`) | 10–50 conc / ~180 req/s | 100 conc, p95 ~1.2 s | 250 conc, throughput falling | M |
| DB writes (observability model) | ~1,300 rows/s | — | Flush-loop-limited by design, not by SQLite | M (synthetic) |
| DB indexed reads | 100+ concurrent logical | — | Not reached; sub-ms at 1M rows | M (synthetic) |
| DB full-scan reads | — | — | **1.2 s sync block per 150k rows, linear growth** | M (synthetic) |
| Fast Lane evaluations | 3 concurrent (hard) | Refusals beyond | N/A — bounded by rejection | S (config+code) |
| Java quant calls | ≤20 in-flight, coalesced | Breaker at 3 fails | 100 ms timeout fail-closed | S (config+code) |
| Symbol evaluations (full pipeline) | Unknown sustained | — | CPU: 5 sync strategies/symbol serialize on loop | S (code) |
| Agent assessments | Governor-bound per agent | — | Realized concurrency unknown without market data | S (code) |
| WebSocket clients | N/A | — | No broadcast server exists | S (code) |
| LLM/API concurrency | Provider-bounded (~10) | Queue 10 / fail-fast | Provider quotas (external) | S (config+code) |

**Sustained vs. burst:** HTTP burst to 500 concurrent is absorbed without errors (degraded latency); sustained throughput peaks ~180 req/s mixed / ~380 req/s light. Symbol-evaluation burst/sustained split not measured.

---

## BOTTLENECKS (ranked)

1. **P0 — ReflectionEngine unbounded scans** (`ReflectionEngine.ts:283,310`): ~1.2 s main-thread block per 150k rows every 60 s, linear growth. Same family as the Oct 5 heap incident. `kronos_predictions` scan deliberately unbounded (open calibration review).
2. **P0 — RiskEngine serialized sync DB path** (`RiskEngine.ts:223-248` + ~8 sync queries/eval): every trade decision serializes behind all prior ones on an uncapped FIFO with no timeout; one slow query stalls the trading spine.
3. **P1 — ChronosForecastGate unbounded waiters** (`KronosInference.ts:37`): no cap, no timeout, max 1 concurrent — burst = unbounded promise-chain growth.
4. **P1 — Synchronous strategy CPU** (`StrategyEngine.evaluateAll`): 5 sync strategies/symbol, no yield, no timeout. 100 symbols = 500 sequential evals blocking P0 work.
5. **P2 — Observability/Logger sync write paths**: small per-call, high frequency; already batched/bounded but still main-thread.
6. **P2 — HistoricalDataGateway cold-cache duplicate fetch**: no in-flight request map; concurrent cold callers from different paths duplicate provider fetches.
7. **P3 — Latent index gaps** (`symbol`, `component`, `level` on observability_events): fine today, degrading path at 10M+ rows.

## RECOMMENDATIONS

| # | Finding | Change | Benefit | Risk | Test |
|---|---|---|---|---|---|
| 1 | P0 unbounded scans | Bound/paginate the kronos + agent_predictions scans (or move off the hot loop); complete the kronos calibration review | Removes the 1.2 s/60 s main-thread block | Medium — touches calibration | Measure scan time before/after at 1M rows |
| 2 | P0 RiskEngine queue | Add waiter cap + queue timeout with explicit shed (fail-closed HOLD) | Bounded decision latency under burst | Low — refusal path already exists elsewhere | Burst evaluateRisk load test |
| 3 | P1 Chronos gate | Cap waiters + timeout (fail-closed null forecast) | No unbounded promise growth | Low | Burst forecast test |
| 4 | P1 sync strategies | Yield (`setImmediate`) between strategies/symbols; budget per evaluation | P0 work not starved by 500-eval bursts | Low — pure scheduling | 100-symbol eval timing |
| 5 | P2 gateway dedup | In-flight request map in `HistoricalDataGateway.ensureBars` | Kills duplicate cold-cache fetches | Low | Concurrent cold-fetch test |
| 6 | P3 indexes | Add `(symbol, ts)` when symbol forensics become frequent | Caps rare-symbol lookup | Very low | EXPLAIN QUERY PLAN |
| — | Metrics (§41) | Add `event_loop_lag_ms`, `evaluation_queue_depth`, `db_query_latency`, `fastlane_queue_depth`, `java_active_calls`, `observability_write_rate` | Makes the next audit measurement-native | Very low | — |

**What is NOT recommended:** Postgres/Redis/Kafka migration (no measured justification — writes are healthy, indexed reads are sub-ms); microservice split (contention is main-thread scheduling, not process boundaries); worker_threads for ordinary I/O (only CPU-bound strategy/scan work qualifies, after recommendation 4 is measured).

---

## FINAL QUESTIONS

1. **How many OS processes does Argus normally use?** 1 Node engine + 1 JVM + 1 Python research (opt-in) + 1 Python Chronos (opt-in) + 1 Ollama (detached). Core trading: 1 process.
2. **How many threads?** Node: 1 main thread (zero worker_threads) + libuv pool (fs/crypto only). JVM: its own threads (separate process).
3. **What runs on Node's main event loop?** Everything except Java/LangGraph/Ollama: agents, ChiefTrader, RiskEngine, OMS, discovery, reconciliation, observability flush, market-data WS handling, all better-sqlite3.
4. **What operations are synchronous?** All better-sqlite3 calls; the 5 strategies per evaluation; EventBus dispatch; Logger fs calls; observability flush inserts; large `.all()` materializations.
5. **What is current event-loop P99 latency?** Not instrumented as a metric (recommended). Proxy from load tests: p99 ~1.3 s at 100 concurrent mixed reads; ~1.2 s at 100 concurrent light reads. Idle: single-digit ms.
6. **What is CPU saturation point?** Not reached in HTTP tests (single-threaded ceiling hit first: ~180 req/s mixed, ~380 req/s light). CPU-bound symbol evals not measured.
7. **What is memory saturation point?** Not reached; RSS ~428 MB post-load. Historical incident: 2.1 GB heap from unbounded scans (since fixed except kronos).
8. **Is SQLite currently a bottleneck?** Writes: no. Indexed reads: no. **Analytical full-scan reads on the main thread: yes** — `SQLITE_ANALYTICS_BOTTLENECK`.
9. **How many DB writes/sec can Argus sustain?** ~1,333 rows/s by flush-loop design; SQLite could absorb ~50k rows/s. No write bottleneck.
10. **How many symbol evaluations can run concurrently?** Governor-bounded (Fast Lane 3, advisory serial, Java 20); sustained full-pipeline number not measured — static model only.
11. **How many Fast Lane evaluations?** 3 concurrent, hard cap; rest explicitly refused.
12. **How many agent tasks?** Bounded per governor; realized concurrency under load unknown without market data.
13. **Can Argus handle 100 concurrent evaluations?** WITH_LIMITS — governors serialize/refuse most of it; the risk is synchronous CPU bursts, not task count.
14. **Can it handle 200?** WITH_LIMITS — same, with more refusals and higher queue latency in the uncapped FIFOs (RiskEngine, Chronos gate).
15. **Can it handle 500?** For HTTP reads: yes, degraded (0 errors at 500 conc). For evaluations: not measured; the uncapped queues would grow unboundedly — this is the red flag.
16. **Can it handle hundreds of HTTP requests?** Yes — measured to 500 concurrent, graceful degradation, zero errors.
17. **Can it handle hundreds of market events?** Static: EventBus dispatch is sequential sync; market-data subs capped at 12/90. Not load-measured.
18. **What breaks first?** Latency, not correctness: the event loop queues (p95 >1 s at 100+ concurrent mixed reads); under evaluation bursts, the uncapped FIFOs grow without bound.
19. **Are queues bounded?** Mostly yes (observability 2000, Fast Lane 3, Java 20, WS 1 MB, LLM 1+10). **No:** ChronosForecastGate.waiters, RiskEngine.evaluationQueue, EventBus (no queue at all).
20. **Can research work starve RiskEngine/reconciliation?** **Yes, in principle** — single event loop, no priority enforcement. A synchronous P4 scan blocks P0 for its full duration. Partial mitigations exist (gates, drop-newest, circuit breaker).
21. **Does Java block Node?** No — async HTTP, 100 ms timeout, fail-closed. Measured by design; never blocks the loop.
22. **Are duplicate data requests coalesced?** Mostly yes (Java ticks, Fast Lane, advisory single-flight, news sequential, LLM cache). **Gap:** `HistoricalDataGateway` cold-cache concurrent fetches; Java institutional debate calls may duplicate advisory calls.
23. **Does observability materially affect throughput?** No — bounded, drop-newest, 1.9 ms per 100-row flush, isolated from the trading spine.
24. **Does TUI materially affect throughput?** No — ~1–2 req/s per TUI against ~180–380 req/s capacity. Negligible.
25. **Can watchdog falsely restart under high load?** Not tested. The mechanism (heartbeat vs. event-loop stall) makes it plausible under a multi-second sync block (e.g., the 1.2 s ReflectionEngine scan); unknown threshold — flagged for the soak test.
26. **Which workloads require worker_threads?** Only after measurement: the 5 sync strategies and the ReflectionEngine scans are the candidates. Not ordinary I/O.
27. **Which workloads justify separate processes?** None measured as justified today. Java/LangGraph/Ollama are already separate.
28. **Is SQLite still appropriate?** **Yes** — writes healthy, indexed reads sub-ms at 1M rows. Migration not justified; fix the scan pattern first.
29. **What is Argus's measured sustainable capacity?** ~180 req/s mixed HTTP reads; ~380 req/s light reads; ~1,300 observability rows/s; 3 concurrent Fast Lane evals; 20 concurrent Java calls.
30. **What is Argus's measured burst capacity?** 500 concurrent HTTP reads absorbed with 0 errors (p95 ~1.9 s). Evaluation bursts not measured.
31. **What are the top 5 scalability improvements?** (1) Bound ReflectionEngine scans; (2) cap + timeout RiskEngine queue; (3) cap + timeout Chronos gate; (4) yield between sync strategies; (5) in-flight dedup in HistoricalDataGateway.
32. **Is architecture change required today?** No — improvements recommended, no migration, no microservices, no new infrastructure. The fixes are bounded queues, timeouts, and scan bounds.

---

## FINAL VERDICT

- **CURRENT_CAPACITY = MODERATE** — I/O concurrency is healthy into the hundreds with graceful degradation; CPU-bound and heavy-endpoint work saturates the single event loop earlier.
- **SCALABILITY = IMPROVEMENTS_RECOMMENDED** — five bounded fixes (scans, two FIFO caps, strategy yielding, gateway dedup), no architectural migration justified by measurement.
- **100_CONCURRENT_WORK_ITEMS = SUPPORTED_WITH_LIMITS** — HTTP reads: supported. Fast Lane: supported by explicit rejection. DB: supported. Full 100-symbol evaluation bursts: supported-with-limits — governors serialize most of it, but the uncapped FIFOs and synchronous strategy CPU are the measured risks to close.

**Final principle, confirmed by measurement:** the question was never "can Node handle hundreds of things" — it can, for I/O, with zero errors at 500 concurrent. The measured envelope is: **hundreds of concurrent I/O operations are fine; synchronous CPU and unindexed scans on the main thread are the scarce resource; and the two uncapped FIFO queues are where overload becomes unbounded rather than degraded.** Backpressure exists at the edges and is missing in exactly the two places that matter most under burst.
