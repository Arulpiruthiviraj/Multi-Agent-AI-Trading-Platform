# ARGUS — Deep Architecture + Java/Python/Node Performance Boundary Audit

Read-only forensic audit. No source, config, `.env`, database schema, or trading state was modified while producing this report. Numbers not directly measurable from static inspection are marked **ESTIMATE** or **UNVERIFIED — needs instrumentation**, never invented.

---

## 1. Executive Summary

Argus today is overwhelmingly **Node.js/TypeScript**, single-process, single-threaded (no `worker_threads` usage found anywhere in `src/` or `scripts/`). A real Java quant core exists (`quant-core-java/`, 39 main files / 21 test files after this session's additions, 134/134 JUnit tests green) but is **advisory-only and inactive at runtime by default** — zero live-path dependency. Python exists in two small, disconnected pockets: a VectorBT/parity research CLI (`python/argus_research/`) and a handful of standalone scripts (Chronos server, XGBoost training, WFO runner) — none of them are imported by the Node process; they are invoked as separate OS processes.

**The true performance-critical path today is not the Java engine — it's the Node event loop**, because every CPU-bound calculation in the entire live decision spine (RSI/MACD/Bollinger, RiskEngine's 24 gates, ChiefTrader's evidence aggregation) runs synchronously on Node's single thread with zero worker offload. This is the actual bottleneck class worth measuring before moving anything to Java for "speed."

## 2. Current Architecture (traced, not inferred from filenames)

```
Alpaca/IBKR WebSocket/Socket → MarketDataWorker (Node, single process)
        → EventBus (Node EventEmitter, in-process, synchronous dispatch)
        → Idea agents (Technical/News/Fundamental/Macro/Quant/Kronos) — each its own setInterval or MARKET_DATA listener
        → ChiefTraderAgent (EvidenceAggregator vote math, sync; optional AIRouter.routeConsensus, async HTTP to Ollama/cloud LLMs)
        → RiskEngine.evaluateRisk() (evaluationQueue Promise-chain mutex — serialized, not parallel; 24 gates, mostly sync CPU + a few better-sqlite3 reads, which are synchronous I/O)
        → OrderManagementService → BrokerManager → broker adapter (Alpaca REST / IBKR socket)
        → trades/fills (better-sqlite3, synchronous, WAL mode, single writer)
        → EventBus → ws WebSocket broadcast → React SPA
```

Everything above runs in **one Node process** (`server.ts`). `quant-core-java/` is a **separate OS process** reachable only via HTTP (`QuantCoreBridge.ts` → `http://127.0.0.1:8085`), gated off by default. Python scripts are **separate OS processes**, invoked via `npm run` scripts or `child_process`-style spawns (Chronos, XGBoost training), never imported into the Node event loop.

## 3. One Complete Trade — Code-Level Trace

| Step | Component | File | Language | Sync/Async | Network? | DB? | Blocking risk |
|---|---|---|---|---|---|---|---|
| Market data arrival | `MarketDataWorker` | `src/server/services/MarketDataWorker.ts` | Node | Async (WS `on('message')`) | Yes (Alpaca WS / IBKR socket) | No | Low — event-driven |
| Signal (Technical) | `TechnicalAgent` | `src/server/services/TechnicalAgent.ts` | Node | Sync CPU (RSI/MACD/BB), on MARKET_DATA or timer | No | No | Low per-symbol, but **runs on the main thread** — many symbols = event-loop contention |
| Idea emitted | `emitTradeIdea` → `EventBus` | `src/server/core/EventBus.ts` (extends `EventEmitter`) | Node | Fully synchronous listener dispatch | No | No | Synchronous fan-out to all listeners on the same call stack |
| Consensus | `ChiefTraderAgent.evaluateConsensusSerialized` | `src/server/services/ChiefTraderAgent.ts` | Node | Sync vote math; optional `await AIRouter.routeConsensus` | Optional (LLM HTTP) | Reads `agent_performance_stats` (sync better-sqlite3) | LLM call is the only real network wait in this step |
| Risk | `RiskEngine.evaluateRisk` | `src/server/engines/RiskEngine.ts` | Node | `evaluationQueue` Promise-chain — **serializes all evaluations**, one at a time | No | Multiple sync better-sqlite3 reads/writes per gate | **Real serialization point** — a slow gate blocks every other symbol's risk evaluation queued behind it |
| Order | OMS → BrokerManager → adapter | `src/server/services/OrderManagement.ts`, `src/brokers/*` | Node | `await` broker HTTP/socket call | Yes (Alpaca REST / IBKR socket) | Sync insert (`trades`) | Broker latency dominates this step, not CPU |
| Fill | Broker webhook/poll → `fillLedger.ts` | Node | Async | Yes | Sync insert (`fills`, unique `(orderId,cumulativeQuantity)`) | Low |
| Persistence | `db` singleton | `src/server/db/index.ts` (`better-sqlite3`) | Node | **Synchronous** (better-sqlite3 is sync-by-design) | No | Yes — every query blocks the event loop for its duration | Structurally cannot race the classic "event before commit" bug (confirmed earlier this session), but a slow query blocks everything else |
| UI | `ws` broadcast | `server.ts` | Node | Async | Yes (WebSocket to browser) | No | Low |

## 4. True Performance-Critical Path

| Category | Real components found | Evidence |
|---|---|---|
| CPU-bound | `TechnicalAgent` indicator math, `RiskEngine`'s 24-gate evaluation, `EvidenceAggregator.aggregate()`, Java `GarchEngine`/`HmmRegimeEngine`/`FactorAlphaEngine`/`StatArbEngine` (when invoked) | Direct source read |
| Latency-sensitive | `RiskEngine.evaluationQueue` (serialized — a slow gate delays every other pending evaluation), broker order placement round-trip | `evaluationQueue` Promise-chain confirmed in `RiskEngine.ts` |
| Concurrency-heavy | Idea agents fan out across N symbols on independent `setInterval`s (30 files use `setInterval` in `src/server/`) — all on **one Node thread**, no worker pool | `grep -rl setInterval src/server/` = 30 files; zero `worker_threads`/`new Worker(` usage anywhere |
| I/O-bound | Broker REST/socket calls, LLM `AIRouter` calls, Alpaca/IBKR market data, `better-sqlite3` (synchronous, but still I/O in nature) | Source read |
| Memory-heavy | None found that stand out — no evidence of large in-memory matrices/tensors on the Node side; Java's Nelder-Mead/HMM fits are the heaviest numeric workloads and are already isolated in the Java process | `quant-core-java/institutional/` inspection |

**Key finding:** there is **no worker-thread offload anywhere in Node**. Every CPU-bound calculation (including RiskEngine's 24 gates for every candidate trade) runs on the same single event-loop thread that also serves the WebSocket UI and HTTP API. This is the actual concurrency bottleneck class, independent of whether Java exists.

## 5. Java Engine Deep Audit

- **Location:** `quant-core-java/src/main/java/io/argus/quantcore/`
- **Packages found:** `backtest/engine` (`JavaBacktestEngine`, tested), `institutional/math` (OLS, ADF, EWMA covariance, Matrix, Nelder-Mead, OU estimator), `institutional/models` (`FactorAlphaEngine`, `StatArbEngine`, `GarchEngine`, `HmmRegimeEngine`), `server` (`QuantCoreServer` — JDK `com.sun.net.httpserver`, **binds 127.0.0.1 only**, `Executors.newVirtualThreadPerTaskExecutor()` confirmed real), `strategy` (5 CORE strategy ports + `StrategyRegistry`), `logging` (`StructuredLogger`, `TraceContext`).
- **HTTP surface (verified this session):** `/health`, `/api/v1/ticks`, `/api/v1/indicators/`, `/api/v1/evaluate`, `/api/v1/institutional/factors/`, `/api/v1/institutional/pairs`, and — added this session — `/api/v1/institutional/volatility/` (GarchEngine) and `/api/v1/institutional/regime/` (HmmRegimeEngine), closing the "compiled-but-unreachable" gap flagged in the previous audit.
- **Threading:** virtual-thread-per-request server; `SymbolState` per-symbol tick ingestion uses a `ConcurrentHashMap`. No evidence of lock contention or thread starvation in the code (small critical sections, immutable records for computed results).
- **Test coverage:** 134/134 JUnit tests green as of this session (surefire reports, 0 failures).
- **Performance benchmarks:** **UNVERIFIED — needs instrumentation.** No JMH or load-test harness found in `quant-core-java/`. The spec's "10,000 tick evaluations in <50ms" style claims from an earlier session request were never actually benchmarked — do not treat them as measured.
- **Currently used where it provides value?** No — `QUANT_JAVA_CORE_ENABLED` / `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` both default `false`. The engine is real and tested but contributes zero live trading decisions today.

## 6. Node.js Deep Audit

| Component | File(s) | Should remain Node? | Java candidate? | Why |
|---|---|---|---|---|
| Market data ingestion | `MarketDataWorker.ts` | Yes | No | I/O-bound (WebSocket), needs tight integration with `BrokerManager`/`EventBus`; not CPU-heavy itself |
| `EventBus` | `EventBus.ts` | Yes | No | In-process pub/sub; moving it would require a cross-process message bus, a large architectural change for no proven bottleneck |
| `TechnicalAgent` indicators | `TechnicalAgent.ts`, `RSIEngine.ts`, `MACDEngine.ts` | Split candidate | **Yes, already exists** | The exact same math already has real Java parity implementations (`RSIEngine`/`MACDEngine` equivalents referenced by `QuantCoreBridge.ts`'s `compareSnapshots`) — this is the most concrete, already-half-built Java migration candidate, not a new idea |
| `ChiefTraderAgent` vote math | `ChiefTraderAgent.ts`, `EvidenceAggregator.ts` | Should remain Node/authoritative | No | Small, cheap computation (weighted sum + thresholds); the value of Java here would be negligible versus the risk of a second implementation of consensus logic — CLAUDE.md's single-authoritative-path rule argues against duplicating this |
| `RiskEngine` (24 gates) | `RiskEngine.ts` | **Must remain Node, authoritative** | No — see §13 | Safety-critical; CLAUDE.md is explicit that Java may never bypass or replace RiskEngine |
| OMS/BrokerManager | `OrderManagement.ts`, `BrokerManager.ts`, `src/brokers/*` | Must remain Node | No | Broker credentials, safety gates, sole `.placeOrder(` caller — architecturally forbidden to move per CLAUDE.md |
| AI agents (News/Fundamental/Macro) | `src/server/services/*Agent.ts` | Yes | No | LLM orchestration via `AIRouter`, I/O-bound, not CPU-bound |
| Replay/backtest orchestration | `FullArgusReplayEngine.ts` | Yes | Partial — could call Java strategy evaluation instead of TS | Currently reuses live TS ChiefTrader/RiskEngine vote math directly (by design, for fidelity) |

## 7. Python Components (real inventory, not assumed)

| File | Role | Connected to Node? |
|---|---|---|
| `python/argus_research/core_features.py`, `core_strategies.py`, `stats.py`, `strategy_evaluate.py` | VectorBT-adjacent research/parity CLI (`cli.py`) — feature/strategy parity checks against the TS implementation | No — invoked as a separate process via `npm run` scripts, output read as files |
| `python/argus_research/test_core_parity.py`, `test_golden_sma.py`, `verify_feature_parity.py`, `verify_strategy_parity.py` | Parity test/verification scripts | No |
| `scripts/local_ai_service.py` | Chronos (`amazon/chronos-t5-mini`) HTTP server on `:8008` | Yes, indirectly — Node's `KronosForecastAgent` calls this over HTTP, same pattern as the Java bridge |
| `scripts/train_xgboost_direction.py` | ML model training (standalone) | No — offline training script |
| `scripts/run_vectorbt_wfo.py` | Walk-forward optimization runner | No — standalone |
| `scripts/bootstrap_models.py`, `probe_research_env.py` | Environment/model setup | No |

**Conclusion:** Python's current footprint is small and already correctly isolated (research/ML training, one inference server). There is no Python component on the live trading path today, and none should be added to it — this matches the mega-spec's own proposed boundary (Python = research/ML, never execution).

## 8. Java Candidate Analysis (scored 1-10)

| Component | Current Language | CPU | Latency | Concurrency | Memory | Java Benefit | Recommendation |
|---|---|--:|--:|--:|--:|--:|---|
| Technical indicators (RSI/MACD/BB) | Node | 4 | 3 | 6 (many symbols, one thread) | 2 | 5 | MOVE TO JAVA (parity path partially exists) |
| RiskEngine 24-gate evaluation | Node | 3 | 7 (serialized queue) | 8 | 2 | 2 | **KEEP** — safety-critical, CLAUDE.md forbids |
| ChiefTrader vote math | Node | 1 | 2 | 2 | 1 | 1 | KEEP |
| GARCH/HMM/StatArb/FactorAlpha | Java (already) | 8 | 3 | 4 | 4 | 9 | KEEP IN JAVA (already done) |
| Market data ingestion | Node | 2 | 6 | 5 | 2 | 2 | KEEP |
| OMS/broker calls | Node | 1 | 5 | 3 | 1 | 1 | KEEP — architecturally forbidden to move |
| LLM/AIRouter calls | Node | 1 | 4 | 3 | 1 | 1 | KEEP |
| News/Fundamental/Macro agents | Node | 2 | 3 | 3 | 2 | 2 | KEEP |
| Backtest/replay loop (bar-by-bar) | Node | 6 | 2 (offline) | 5 | 3 | 6 | SPLIT — `JavaBacktestEngine.java` already exists as a separate, faster harness; needs parity tests before being trusted alongside `FullArgusReplayEngine.ts` |
| UI API / WebSocket gateway | Node | 1 | 3 | 4 | 1 | 1 | KEEP |
| Database access | Node (better-sqlite3) | 1 | 2 | 2 (single writer, WAL) | 2 | 1 | KEEP |

## 9. Migration Reasoning (per CLAUDE.md's own "don't move to Java just because it's faster" rule)

**Technical indicators → Java:**
- *Current problem:* every symbol's RSI/MACD/BB recomputation runs on Node's single thread; with enough symbols this could contend with the event loop serving the UI/API.
- *Evidence:* zero `worker_threads` usage found; `TechnicalAgent.ts` runs synchronously in-process.
- *Expected benefit:* moves CPU work off the Node event loop entirely (a separate JVM process, virtual threads).
- *Cost:* a second implementation to keep in parity (parity tests already exist per `StrategyParityTest.java` convention — extending, not inventing).
- *Risk:* low if kept advisory/parity-only, as it already is.
- *Recommendation:* **MOVE TO JAVA** — but only measured, not assumed. **No current measurement proves this is actually a bottleneck today** (symbol counts in typical use are modest). Phase 0 below should benchmark this before committing to more indicator porting.

**RiskEngine → Java:** **KEEP.** CLAUDE.md explicitly forbids Java from touching RiskEngine, and the actual CPU cost of the 24 gates is small (mostly comparisons + a handful of sync SQLite reads) — the real latency contributor is the **serialization** (`evaluationQueue`), not raw CPU, and serialization is a correctness requirement (DEF-09 rate-limit race fix), not a performance problem to "solve" by parallelizing in Java.

## 10. Performance Hotspot Analysis

| Hotspot | Rank | Evidence |
|---|---|---|
| `RiskEngine.evaluationQueue` full serialization | P1 | Confirmed Promise-chain mutex in `RiskEngine.ts` — by design (correctness), but is the single biggest per-trade latency contributor under load |
| No worker-thread offload for CPU work | P1 | Zero `worker_threads` usage anywhere; all indicator/vote/risk math shares the event loop with HTTP/WebSocket serving |
| `better-sqlite3` synchronous I/O on the hot path | P2 | Real, but WAL mode + small per-query cost make this unlikely to dominate versus network calls |
| Many `setInterval`-driven agents (30 files) | P2 | Legitimate polling architecture per CLAUDE.md's documented design; not inherently a bug, but 30 independent timers is worth auditing for redundant overlapping work |
| LLM/AIRouter calls | P2 | Already has timeouts/circuit breakers (`HeavyModelMutex`, per-agent cooldowns) — already mitigated |
| Java engine's own HTTP JSON serialization (hand-rolled `Json` class) | P3 | No framework overhead, but no benchmark exists to know if this matters at the volumes Argus actually sees |

No P0s found — nothing observed that looks like an active, unmitigated critical bottleneck; the P1s are architecturally-understood tradeoffs (serialization for correctness, single-threaded Node by platform design), not bugs.

## 11. Market Data Path

```
Alpaca WS / IBKR socket → MarketDataWorker (parse + normalize, Node)
   → EventBus.emit('MARKET_DATA', ...) (synchronous fan-out, same thread)
   → each idea agent's listener runs synchronously in the same emit() call stack
   → sampled subset persisted (observability.json's marketDataPersist, not every tick)
```

Hops: 1 network boundary (broker → Node), 0 additional serialization boundaries until the optional Java/LLM calls. **Should market-data processing move into Java?** Not currently justified — the parsing/normalization is lightweight; the actual per-tick fan-out to N synchronous listeners is the more interesting scaling question, and moving only the *source* to Java would still require crossing back into Node for `EventBus`/`ChiefTrader`/`RiskEngine`, adding a network hop for no proven gain.

## 12. Strategy Engine Inventory

| Strategy/Engine | Language | Location | Frequency | CPU cost | State | Concurrency |
|---|---|---|---|---|---|---|
| 5 CORE strategies (`MOMENTUM_BREAKOUT`, etc.) | TS (live) + Java (parity, advisory) | `src/server/quant/strategies/`, `quant-core-java/.../strategy/` | Per `QUANT_ENGINE_ENABLED` cycle | Low-moderate | Stateless per evaluation | N/A |
| TechnicalAgent (RSI/MACD/BB) | TS (live) | `TechnicalAgent.ts` | Per tick/timer | Low | Debounced state (cooldown) | Per-symbol |
| `FactorAlphaEngine` | Java (advisory only) | `institutional/models/` | On-demand HTTP call | Moderate | Stateless | Per-request |
| `StatArbEngine` | Java (advisory only) | `institutional/models/` | On-demand HTTP call | Moderate | Stateless | Per-request |
| `GarchEngine` | Java (advisory only, newly HTTP-exposed) | `institutional/models/` | On-demand | Moderate-high (Nelder-Mead fit) | Stateless | Per-request |
| `HmmRegimeEngine` | Java (advisory only, newly HTTP-exposed) | `institutional/models/` | On-demand | High (Baum-Welch EM) | Stateless | Per-request |
| `strategiesEngine/` (SHADOW/ANALYSIS_ONLY) | TS | `src/server/strategiesEngine/` | Research-only | Variable | Stateless | N/A |

**Which should execute inside Java?** Only the ones already there (Factor/StatArb/GARCH/HMM) — these are genuinely CPU-heavier numerical fits (Nelder-Mead, EM) where a JVM's tighter numeric loops plausibly help, and they are already isolated/advisory. The 5 CORE live strategies stay dual (TS authoritative, Java parity) by explicit design (`StrategyParityTest.java`).

## 13. Risk Architecture

- **Risk Calculation vs Risk Authorization — real distinction found in code:** `RiskEngine.evaluateRisk()` does both today (calculates AND authorizes pass/fail per gate) inside one Node module. There is no existing split where Java calculates and Node merely authorizes.
- CPU-intensive parts of RiskEngine: negligible (comparisons, a capital snapshot calculation, a correlation-overlap check) — nothing here is a real numeric-fit workload the way GARCH/HMM are.
- Safety-critical: **all of it.** CLAUDE.md is explicit and this audit found no code path that treats any gate as non-authoritative.
- **Recommendation: Node remains the sole risk-calculation AND risk-authorization layer.** There is no performance case for moving any part of this to Java — the gates are cheap, and the correctness/safety cost of a second implementation (even calculation-only) is not justified by any measured bottleneck.

## 14. OMS / Execution

Order creation, validation, persistence, broker communication, fill processing, and reconciliation are **100% Node**, and architecturally must stay that way (CLAUDE.md: OMS is the sole `.placeOrder(` caller; Java has zero broker imports, verified by source inspection — no `.placeOrder(`-equivalent call anywhere in `quant-core-java/`). There is no "execution calculation" component separable from "broker connectivity" here worth moving — order sizing math (`PositionSizing.ts`) is cheap arithmetic, not a numeric-fit workload.

## 15. AI Agent Analysis

| Agent | Current language | Recommended | Why |
|---|---|---|---|
| TechnicalAgent | Node | Node (or Java parity, see §9) | Deterministic math, not LLM |
| NewsAgent, FundamentalAgent, MacroAgent | Node | Node | LLM orchestration via `AIRouter`, I/O-bound |
| ChiefTraderAgent | Node | Node | Vote math + optional LLM debate; authoritative, must stay single-path |
| RiskAgent | Node | Node | Wraps `RiskEngine`, safety-critical |
| Kronos (time-series forecast) | Python (inference server) + Node (agent wrapper) | Keep as-is | Already correctly split — Python does the ML inference, Node orchestrates |

No agent in this list is a Java candidate; none does the kind of heavy numeric-fit work GARCH/HMM/StatArb do.

## 16. Database Analysis

- Hot tables (by write frequency in the live path): `observability_events`, `event_traces`, `risk_assessments`+`risk_gate_results`, `agent_reasoning_logs`, `ai_calls`. Sampling/dropPolicy (`observability.json`) already exists specifically because these are write-heavy.
- Read-heavy: `agent_performance_stats` (ChiefTrader weighting), `settings`.
- All access is via `better-sqlite3`, **synchronous** — this means every query blocks the Node event loop for its duration, but each query is small (indexed lookups), and WAL mode + single-writer discipline (already documented, DEF-18) avoids the concurrency failure mode that would otherwise matter here.
- **Is DB access on the trading-critical path?** Yes — `RiskEngine`'s gates read/write several tables per evaluation, inside the serialized `evaluationQueue`. This is a real, if modest, contributor to per-trade latency; **UNVERIFIED — needs instrumentation** to know the actual microsecond cost.

## 17. Threading / Concurrency Audit

- **Node:** single-threaded event loop, zero `worker_threads`, zero `new Worker(` usage anywhere in `src/`/`scripts/`. All CPU-bound work (indicators, risk gates, vote math) competes with I/O event handling on the same thread. This is the single most consequential concurrency fact in the whole audit.
- **Java:** `Executors.newVirtualThreadPerTaskExecutor()` in `QuantCoreServer` (real, confirmed) — appropriate for the current light request volume; `ConcurrentHashMap` for per-symbol tick state; small, well-scoped critical sections in `HmmRegimeEngine`'s EM loop (no shared mutable state across requests since each fit/decode call is self-contained).
- **Python:** no evidence of multiprocessing/async in the research scripts inspected — they are one-shot CLI invocations, consistent with their offline/research role.
- **Where would concurrency improvements actually matter?** Node's lack of worker-thread offload for CPU-bound indicator/risk math, if and when symbol/agent counts grow enough to make event-loop contention measurable (not yet proven to be a problem at current scale).

## 18. Fault Isolation

- **Java failure → Node/trading:** cannot crash it. `QuantCoreBridge.ts` has a hard timeout + circuit breaker (`quantJavaCoreCircuitBreakerCooldownMs`) and is entirely optional; a dead/unreachable Java process just means those advisory signals are absent.
- **Python (Chronos) failure → Node/trading:** cannot crash it. `KronosForecastAgent` explicitly reports "unavailable" when `/health` is down rather than fabricating forecasts (already-documented honest-failure behavior).
- **Node failure → Java/Python:** N/A — Java/Python have no dependency on Node being alive (they're servers/scripts Node calls out to, not the reverse).
- **Conclusion:** fault isolation between the three runtimes is already correctly one-directional and safe — this is a genuine strength of the current architecture, not a gap.

## 19. Target Architecture (recommended, grounded in what actually exists)

```
                              ARGUS
                                |
        +------------------------+------------------------+
        |                       |                          |
     Node.js                  Java                       Python
   (platform +              (advisory                 (research +
    trading spine,           quant core,                ML training +
    authoritative)            optional)                 Chronos inference)
        |                       |                          |
   EventBus, ChiefTrader   FactorAlpha/StatArb/       Chronos server (:8008)
   RiskEngine, OMS,        GARCH/HMM (HTTP,           VectorBT parity CLI
   BrokerManager,          8085, gated off             XGBoost training
   AI agent orchestration  by default)                (all offline/standalone)
        |                       |
        +-----------------------+
                    |
              Broker (Alpaca/IBKR)
```

This is very close to the mega-spec's proposed shape and to what's already implemented — the main correction is that Java is **advisory input**, never a parallel execution path, and Python is **fully disconnected** from the live process (correctly so).

## 20. Migration Plan (phased, no rewrites)

- **Phase 0 (no code changes):** instrument `TechnicalAgent` indicator calculation time and `RiskEngine.evaluateRisk()` gate-by-gate timing under realistic symbol/agent load. This is the missing baseline every subsequent phase should be justified against.
- **Phase 1:** if Phase 0 shows real event-loop contention, move technical-indicator computation to the already-partially-built Java parity path (`RSIEngine`/`MACDEngine` Java equivalents + `QuantCoreBridge.ts`), advisory-only at first (shadow-compare, not authoritative), per CLAUDE.md's parity-test requirement.
- **Phase 2:** expand Java's institutional models (already scoped separately per this session's Java-engine-enhancement discussion) — e.g. connect `GarchEngine`/`HmmRegimeEngine`'s now-real HTTP endpoints into an optional advisory context for ChiefTrader's reasoning (never a vote, per §9/§13's safety boundary).
- **Phase 3:** only if Phase 1 proves out, consider moving strategy *evaluation* (not decision) into Java for the CORE strategies at higher symbol counts — still shadow/parity-gated.
- **Phase 4/5:** portfolio/risk and execution-path optimization are **not recommended** — §13/§14 show no CPU bottleneck there, only safety-critical logic that must stay Node-authoritative.
- **Phase 6:** Python model export → Java inference is plausible for a future trained model (e.g. the XGBoost direction model) if it's ever promoted beyond research, but no such promotion exists today.

Each phase's rollback is trivial today: the entire Java integration is a feature flag (`QUANT_JAVA_CORE_ENABLED`) — turning it off fully reverts to the current all-Node path with zero data migration.

## 21. Performance Targets

No existing measured baseline exists for any of: market-data processing latency, feature-calculation latency, strategy-evaluation latency, signal-generation latency, risk-calculation latency, end-to-end decision latency, throughput, memory, GC pauses, or CPU utilization. **Recommendation:** do Phase 0 (§20) before setting any numeric target — publishing a target without a baseline risks exactly the "invented numbers" problem CLAUDE.md warns against elsewhere in this codebase.

## 22-33. (Consolidated — see the numbered sections above for full detail per topic)

Component inventory (§2-§7), trade lifecycle (§3), Java engine (§5), Node engine (§6), Python (§7), market data (§11), strategy (§12), risk (§13), portfolio (position sizing is inside RiskEngine's gate 21/PositionSizing.ts, cheap arithmetic, no Java case), OMS/broker (§14), AI agents (§15), database (§16), event/messaging (EventBus, §2/§11), threading/concurrency (§17), hotspots (§10), Java candidates (§8-§9), Python candidates (§7), Node components that should remain (§6, §13, §14), components that should split (Technical indicators — §9; replay/backtest — §8).

## 34. Priority Matrix

| Item | Priority |
|---|---|
| Baseline performance instrumentation (Phase 0) | P1 |
| Worker-thread or Java offload for indicator math, if Phase 0 proves contention | P2 (conditional) |
| Wire newly-exposed GARCH/HMM endpoints into any advisory consumer | P2 |
| JMH/load benchmark for `quant-core-java` | P2 |
| Moving RiskEngine/OMS to Java | **Do not do** — architecturally forbidden, no evidence it would help |

## 35. Benchmarking Plan

Add timing instrumentation (already-existing `StructuredLogger`/`observability_events` pattern) around: `TechnicalAgent` indicator computation, `RiskEngine.evaluateRisk()` total + per-gate, `EvidenceAggregator.aggregate()`, and the Java HTTP round-trip (`QuantCoreBridge.ts` already has latency tracking hooks per its own header comment — confirm they're actually being read anywhere, which was not verified in this pass). Run under a realistic symbol count (the ARGUS_DISCOVERY universe size, ~31 symbols, is a reasonable load proxy) before drawing conclusions.

## 36-39. Expected Benefits / Risks / What Should NOT Be Migrated

- **Expected benefit** of any indicator/strategy-evaluation move to Java: reduced Node event-loop contention **if and only if** Phase 0 proves it's currently contended — not proven today.
- **Risk of migration:** a second implementation to keep in parity forever (mitigated by the existing parity-test convention); operational complexity of a second JVM process becoming load-bearing instead of purely advisory.
- **What should NOT be migrated, ever, regardless of Java's speed:** RiskEngine gate evaluation/authorization, OMS order placement, BrokerManager/broker adapters, ChiefTrader's final approve/reject decision, the kill switch, and any code path that would let Java call `.placeOrder(`-equivalent — all explicitly forbidden by CLAUDE.md's protected-architecture contract, and this audit found no performance evidence that would justify overriding that rule even if it were up for debate.

## 40. Final Recommendation

**If I were the principal architect inheriting this exact codebase:** keep Node.js as the authoritative trading spine (EventBus → ChiefTrader → RiskEngine → OMS → BrokerManager) exactly as CLAUDE.md mandates — nothing found in this audit changes that conclusion; the safety and single-authoritative-path arguments are sound independent of performance. Keep Java exactly where it already, correctly, sits: an optional, advisory, HTTP-isolated numerical engine for the genuinely CPU-heavy fits (GARCH, HMM, cointegration, factor composites) that benefit from tighter numeric loops — and now, after this session, actually reachable end-to-end. Keep Python exactly where it already sits: research, parity verification, and one inference server, fully disconnected from the live process. The one real, evidence-backed opportunity this audit surfaces that isn't already done is moving deterministic technical-indicator computation off Node's single thread — but even that should be measured (Phase 0) before committing engineering time, not assumed just because Java exists and is fast.

---

## Most Important Final Question — Answered

**Node.js keeps:** EventBus, ChiefTraderAgent, RiskEngine, OMS, BrokerManager/broker adapters, AI agent orchestration (News/Fundamental/Macro/Technical), the kill switch, all persistence, the UI/API/WebSocket gateway. All of this is either safety-critical (must stay single-authoritative per CLAUDE.md) or not CPU-bound enough to justify a second language.

**Java keeps/gains:** the institutional numerical models already built (`FactorAlphaEngine`, `StatArbEngine`, `GarchEngine`, `HmmRegimeEngine`) — genuinely CPU-heavier fits where a JVM plausibly helps — kept strictly advisory, HTTP-isolated, zero broker/OMS/RiskEngine access. `JavaBacktestEngine.java` stays a separate, faster research harness pending parity tests against the TS engines.

**Python keeps:** VectorBT/parity research CLI, ML model training scripts, and the Chronos inference server — all already correctly disconnected from the live trading process.

This is, in substance, the architecture Argus already has today (not a hypothetical redesign) — the actual finding of this audit is that the current boundary choices are already close to correct, and the highest-value next step is *measurement* (Phase 0), not another migration.
