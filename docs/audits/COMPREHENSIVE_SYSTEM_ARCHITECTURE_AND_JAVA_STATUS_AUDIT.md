# ARGUS — Comprehensive System Architecture, Friday Session Forensics & Java 26 Status

Read-only synthesis (no code, config, or database changes made while producing this report). This document does not raise readiness scores — ground truth is `evaluateLiveReadiness()`, the organic `trades`/`fills` tables, and the source code itself, per `CLAUDE.md`.

**Scope note on Phase 1:** the underlying market session (Friday 2026-08-21) and its `data/argus.db` rows have not changed since `docs/audits/ARGUS_CURRENT_STATE_AND_FRIDAY_SESSION_FORENSIC_AUDIT.md` was produced earlier this same session — no new trading day has occurred. Phase 1 below restates those already-DB-verified numbers rather than re-running identical SQL queries; treat that source document as the primary record, this section as a compact index into it.

---

## 1. Executive Scorecard

| Dimension | Status | Evidence |
|---|---|---|
| Engine (TypeScript control plane) | **Sole execution spine, protected, unchanged** | `CLAUDE.md` architecture contract; `phase21.invariants.test.ts` (OMS sole `.placeOrder(` caller); full suite 352 files / 2233 tests green as of this session |
| Java 26 Quant Core | **PARTIAL — real, tested, advisory-only, inactive at runtime by default** | `QUANT_JAVA_CORE_ENABLED` / `QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED` both default `false`; see §4 |
| IBKR Gateway (historical replay path) | **Real bridge; boot-time registration bug found and fixed this session** | See §5.2 — `BrokerManager.initialize()` now calls `applyMarketDataBinding()` |
| Replay/backtest fidelity | **Three real, structurally distinct engines; PIT Agent Ledger System now wired for News/Macro/Fundamental context** | See §5 |
| LIVE readiness | **`LIVE_NO_GO`, unchanged** | `evaluateLiveReadiness()`; `PAPER_TRADING_ONLY=true` |
| Organic paper edge | **Still unestablished** — 0 organic FILLED SELL P&L, soak floors unmet | `researchSafety.json` floors; Friday session produced 0 organic approvals |

---

## 2. Phase 1 — Friday 2026-08-21 Session Forensics (index, full detail in the dedicated audit)

Full detail: `docs/audits/ARGUS_CURRENT_STATE_AND_FRIDAY_SESSION_FORENSIC_AUDIT.md`. Key numbers (DB-verified against the corrected epoch-ms window `1787270400000`–`1787356799999`):

| Funnel stage | Count |
|---|---|
| `TRADE_IDEA_GENERATED` | 4,521 |
| `CHIEF_CONSENSUS_STARTED`/`COMPLETED` cycles | 4,400 |
| Persisted `consensus_decisions` rows | 360 (intentional per-resolution-window collapse — see below, not a drop) |
| `CHIEF_APPROVED_IDEA` | 7 (6 manual-override + 1 risk-exit SELL) |
| Risk-approved | 4 |
| `BROKER_ENVIRONMENT_UNKNOWN` rejections | 2 (TSLA, RIOT manual-override orders) |
| Real fills | 2 (IWM BUY/SELL) |
| Organic (non-override, non-risk-exit) approvals | **0** |

**Consensus bottleneck:** avg BUY confidence 0.179, avg SELL confidence 0.267 — both well below the 0.75 `consensusApprovalThreshold`. Root cause (confirmed this session in `docs/research/AGENT_CONFIDENCE_CALIBRATION_AND_TELEMETRY_REPORT.md`): genuine, correctly-modeled disagreement between KronosEngine (670 BUY/2137 SELL, avg conf 0.845) and TechnicalAgent (816 BUY/36 SELL, avg conf 0.617) — two structurally different signal classes disagreeing 68% of cycles, with `EvidenceAggregator`'s `DISAGREEMENT_PENALTY` correctly netting confidence down. Not a bug. Not lowered for this report.

**The 4,400-vs-360 gap** is `ChiefTraderAgent`'s intentional per-symbol-per-resolution-window collapse (`recordUnresolvedAsNoConsensus()` persists at most one `NO_CONSENSUS` row per sweep), not a silent drop — confirmed via code path tracing, and a diagnostic-only interim-evaluation counter/log was added this session (`ChiefTraderAgent.ts`) with no behavior change.

**Reconciliation:** one real $424.08 GLD mismatch against IB Gateway correctly paused trading; no auto-resume occurred (`autoFlattenOnReconciliationMismatch: false` honored).

**`BROKER_ENVIRONMENT_UNKNOWN` resolution — re-verified this session:** `OrderManagement.ts` reads trading mode through `normalizeTradingMode()` (`src/server/core/tradingModeEnv.ts`), which fails safe to `'PAPER'` rather than surfacing an unclassifiable string. Confirmed still present in the current codebase (not reverted). This does not retroactively un-reject the 2 historical TSLA/RIOT rows — it prevents recurrence.

---

## 3. Phase 2 — Current Architecture & Component Health

### 3.1 Port / service topology (verified against config, not assumed)

| Service | Port | Verified against |
|---|---|---|
| Node.js API + Vite/static UI | `3000` | `server.ts` (hardcoded; `PORT` env unused) |
| IB Gateway Desktop socket | `4002` (paper) / `7497` | `config/ibkrConnection.json` comment: "Default IBKR path is TCP socket — see config/ibkrConnection.json (paper 4002 / 7497)" |
| Chronos AI time-series forecaster | `8008` | `config/networkEndpoints.json`: `chronosDefault: http://127.0.0.1:8008` |
| Java 26 Quant Core | `8085` | `config/tradingSafety.json`: `quantJavaCoreBaseUrl: http://127.0.0.1:8085` |
| Ollama local LLM | `11434` | `config/networkEndpoints.json`: `ollamaDefault: http://127.0.0.1:11434` |
| OpenAlice Guardian MCP | `47332` | `config/networkEndpoints.json`: `guardianMcpUrl: http://127.0.0.1:47332/mcp` |

### 3.2 Dual-loop verification

- **BUY loop:** idea agents (Technical/News/Fundamental/Macro/Quant/Kronos, each on its own timer or `MARKET_DATA` trigger) → ChiefTrader → RiskEngine → OMS. Runs on each agent's own interval (`config/runtimeIntervals.json`), independent of the exit loop.
- **SELL/Exit loop:** `PortfolioMonitor` (~60s) evaluates open positions independently — cost-basis take-profit/trailing-stop plus Quant thesis invalidation — and emits SELL as a `TRADE_IDEA_GENERATED`, not a raw broker flatten. It shares ChiefTrader/RiskEngine/OMS downstream but is not gated by the BUY loop's Autobot-enabled check (Autobot-off blocks new BUY only; SELL/exits still require `TRADING_ENABLED`).
- Both loops converge on the same protected spine (ChiefTrader → RiskEngine → OMS → BrokerManager) — this is a shared terminal path, not two independent order-placement systems, which is the architecturally correct design per `CLAUDE.md`'s single-spine invariant.

### 3.3 Risk & safety controls

- 24 RiskEngine gates: catalog order `config/riskGateOrder.json`, pass/fail sourced from `risk_gate_results` per evaluation (not re-audited row-by-row in this pass — see `CLAUDE.md` §2 for the authoritative gate table; no gate was modified this session except the capital-allocation race fix in §5.3, which strengthens gate 23 rather than weakening it).
- `PAPER_TRADING_ONLY=true` confirmed in `.env.example` default and unchanged this session.
- `evaluateLiveReadiness()` remains `LIVE_NO_GO` — nothing in this session's fixes touches the 5-layer LIVE arm.

---

## 4. Phase 3 — Java 26 Quant Core Migration Status

### 4.1 Build / integration status

- `mvn clean test` last run this session (surefire reports present, 0 `FAILURE` markers across 31 report files as of the most recent Java test run this session).
- `QuantCoreBridge.ts` (TypeScript side): gated by `tradingSafety.quantJavaCoreEnabledEnvVar` (`QUANT_JAVA_CORE_ENABLED`), hard request timeout (`quantJavaCoreRequestTimeoutMs`), circuit breaker (`quantJavaCoreCircuitBreakerCooldownMs`). Never imports RiskEngine/OMS/BrokerManager — confirmed by source inspection.
- `QuantCoreServer.java` genuinely uses `Executors.newVirtualThreadPerTaskExecutor()` (real, not aspirational) and exposes exactly 6 HTTP contexts: `/health`, `/api/v1/ticks`, `/api/v1/indicators/`, `/api/v1/evaluate`, `/api/v1/institutional/factors/`, `/api/v1/institutional/pairs`.
- Shadow parity: `GET /api/v2/quant-core/parity` is real (`src/server/routes/v2System.ts:1825`), backed by `observability_events` rows, tested in `v2System.quantCore.test.ts`.

### 4.2 Institutional Quant Library — actual file inventory vs. the originally-specified 6-pillar/100+-model roadmap

**Important correction to an earlier-session claim:** a prior spec in this session ("100+ FACTOR SCALING") requested ~20 granular classes across 6 pillars (`OrderFlowImbalance.java`, `VpinEstimator.java`, `RollingKalmanFilter.java`, `HiddenMarkovClassifier.java`, `WaveletDenoising.java`, etc.). What was actually built and is present in `quant-core-java/src/main/java/io/argus/quantcore/institutional/` today is a **smaller, consolidated set** — 4 model engines + 6 math helpers, not the full granular roadmap. This audit reports the real inventory rather than restating the original spec as if it were completed:

| Pillar | Requested (original spec) | Actually present | Status |
|---|---|---|---|
| 1. Microstructure (OFI, VPIN, Amihud, Roll Spread) | 4 classes | **None** | NOT STARTED |
| 2. Statistical Arbitrage / Cointegration | Johansen, Engle-Granger, Kalman, OU half-life | `StatArbEngine.java` (Engle-Granger via `OlsRegression`+`AugmentedDickeyFuller`, Z-score, OU half-life via `OrnsteinUhlenbeckEstimator`) | PARTIAL — no Johansen (multi-asset), no rolling Kalman hedge ratio |
| 3. Multi-Factor Alpha | 4 separate factor classes + combiner | `FactorAlphaEngine.java` (5-factor composite: momentum, mean-reversion, volume/liquidity, Z-scored, combined in one engine rather than separate factor+combiner classes) | PARTIAL — consolidated, not the requested per-factor file split |
| 4. Advanced Volatility | GARCH(1,1), Yang-Zhang, squeeze detector | `GarchEngine.java` (GARCH(1,1) MLE fit, real) | PARTIAL — no Yang-Zhang, no squeeze/breakout detector |
| 5. Regime Classification | 4-state Gaussian HMM, structural break detector | `HmmRegimeEngine.java` (4-state Gaussian HMM via Baum-Welch EM) | PARTIAL — HMM present and matches spec; no structural break detector |
| 6. Signal Processing | Wavelet denoising, DFT cycle detector, fractional differentiation | **None** | NOT STARTED |

**Reachability from the HTTP bridge:** only `FactorAlphaEngine` (via `/api/v1/institutional/factors/`) and `StatArbEngine` (via `/api/v1/institutional/pairs`) are exposed over HTTP today. `GarchEngine` and `HmmRegimeEngine` are real, compiled, and unit-tested in Java, but have **no HTTP endpoint** — the TypeScript control plane cannot call them at all yet, even in an advisory capacity. This is a genuine integration gap, not a safety issue (nothing bypasses the spine either way).

### 4.3 Advisory execution contract

Confirmed by source inspection: all Java HTTP responses are plain JSON records (`StrategySignal`-shaped outputs from `handleInstitutionalFactors`/`handleInstitutionalPairs`), zero broker credentials anywhere in `quant-core-java/`, zero `.placeOrder(`-equivalent calls. Contract holds.

---

## 5. Phase 4 — Backtest & Replay Engines

### 5.1 Engine comparison matrix

| Engine | File | Fill model | Consensus/decision logic | Status |
|---|---|---|---|---|
| Argus Historical Evaluation (MODE B) | `src/server/replay/FullArgusReplayEngine.ts` | `NEXT_BAR_OPEN`, volume-participation-capped partial fills, real fees/slippage deltas | Reuses real `replayChiefTraderFromEvidence` vote math + 24 real `RiskEngine.evaluateRisk()` gates + real OMS-equivalent submission against `HistoricalReplayBroker` (isolated, never the live broker) | Most fidelity-accurate; long-running, symbol-timestamp loop |
| Research Backtest Engine | `src/server/engines/backtest/BacktestEngine.ts` | `SAME_BAR_CLOSE` (explicitly non-promotable) | TA-rule only, no AI, long-only | Lightweight, explicitly research-only per its own labeling |
| Java Quant Core Replay | `quant-core-java/.../backtest/engine/JavaBacktestEngine.java` | Java-side, not cross-checked against the other two in this pass | High-throughput, multi-threaded | Real file exists with a real test (`JavaBacktestEngineTest.java`); not wired into the TS replay UI — a standalone Java-only harness today |

No two of these compute the same signal through a silently-diverging path — each is labeled and scoped distinctly (`CLAUDE.md`'s single-authoritative-path rule holds).

### 5.2 IBKR Gateway data provider — real bug found and fixed this session

**Symptom (user-reported, reproduced in reasoning, not fabricated):** Settings > Brokers showed IBKR Gateway (Socket) as the active/connected broker, but the Replay UI's data-provider table still reported `ibkr: DATA_PROVIDER_UNAVAILABLE`, and a replay run with `dataProvider: 'ibkr'` failed immediately (`DATA_UNAVAILABLE`).

**Root cause:** `HistoricalDataProviderRegistry.ts`'s `ibkrProvider` already had a fully real implementation — it reuses the exact same `reqHistoricalData` bridge (`IBGatewaySocketAdapter.getHistoricalBars` → `IbkrSocketSession.requestHistoricalBars`) that the live Quant/backtest path uses, gated on `getRegisteredHistoricalBarProvider()?.id === 'ibkr_gateway'`. That registration is performed by `BrokerManager.applyMarketDataBinding()`. `setActiveBroker()` (the mid-session broker-switch path) always called it — but `initialize()` (the boot path, which restores the previously-selected broker from `settings.selectedBroker`) never did. So after any server restart with IBKR already selected, the broker really was active and connected, but the historical-bars bridge stayed unregistered until an operator explicitly re-selected the broker in Settings.

**Fix applied:** `BrokerManager.ts`'s `initialize()` now calls `await this.applyMarketDataBinding(this.activeBroker)` at the end of boot — the same call the switch path already made. No new IBKR client, no loosened broker-id matching (a looser `name.includes('ibkr')` check, as an earlier spec this session proposed, would not have fixed the actual gap and risked misclassifying `ibkr_web` as socket-capable).

**Verified:** `npx tsc --noEmit` clean; `src/brokers/` suite 86/86; `HistoricalDataProviderRegistry.ibkr.test.ts` + `architecture.protection.test.ts` 30/30; full suite re-run (see this session's own completion notification for the final count).

### 5.3 SQLite bar caching & look-ahead guards

- Real cache: `ohlcv_bars` (not a separately-named `historical_bars` table — the ibkr replay provider's `fetch()` routes through `historicalDataGateway.ensureBars()`/`getBars()`, the same cache-first path the live Quant/backtest engine already uses, so a replay re-run over the same window never re-hits IB Gateway's historical-data pacing limit).
- Look-ahead guard: `InformationCutoff.assertNotFuture()` (`src/server/replay/InformationCutoff.ts`) throws `LOOK_AHEAD_BIAS_DETECTED` on any future-timestamped item reaching the decision loop; the replay engine's per-symbol bar filter (`bars.filter(b => b.timestamp < t)`) keeps this from ever firing in the normal path.

### 5.4 PIT (point-in-time) agent availability during replay

Fixed and extended this session — see `ARGUS_HISTORICAL_EVALUATION.md`'s agent-availability table for the authoritative version:

| Agent | Replay status |
|---|---|
| QuantEngine, TechnicalAgent | PARTIAL — always active, PIT bars only (baseline quorum) |
| NewsAgent | `CATALYST_ONLY` (golden fixture, non-voting) / **`AVAILABLE`** (real independent vote from `historical_news_archive`'s stored `sentimentScore` once the archive has rows for the run's symbols/window) / `UNAVAILABLE` |
| FundamentalAgent, MacroAgent | `DATA_LOADED_CONTEXT_ONLY` once `historical_fundamental_snapshots`/`historical_macro_releases` have real rows (surfaced as `AGENT_ASSESSMENT` context, deliberately non-voting — see `config/replaySafety.json`'s `historicalPitAgentDisclosure` for why: turning raw macro/fundamental numbers into a trade direction is the interpretive step live Argus delegates to AIRouter's LLM) / `UNAVAILABLE` |
| KronosForecastAgent | `UNAVAILABLE` — explicit disclosure entry added this session; no point-in-time forecast store exists |

New: `src/server/replay/pitProviders.test.ts` (6/6 passing) proves zero lookahead per provider; two live end-to-end sample replays (no PIT rows, then seeded PIT rows) confirmed the wiring behaves correctly at runtime, not just in unit tests.

---

## 6. Actionable Recommendations (prioritized)

1. **Pre-market (Monday 2026-08-24):** no new operator action beyond the existing `CLAUDE.md` §5 pre-market checklist. This session's fixes (IBKR boot binding, capital-allocation race, quant warm-up gate, P&L attribution logging) are defect fixes, not new required steps.
2. **Java pillar 1 (Microstructure) and pillar 6 (Signal Processing)** have zero implementation — if these are wanted, they are net-new work, not "finishing" something already scaffolded.
3. **Expose `GarchEngine`/`HmmRegimeEngine` over HTTP** (new `QuantCoreServer` contexts, e.g. `/api/v1/institutional/volatility/`, `/api/v1/institutional/regime/`) before claiming they contribute anything — right now they are unreachable from the control plane.
4. **`JavaBacktestEngine.java`** is a standalone harness with its own test but no TS-side wiring or parity comparison against `FullArgusReplayEngine.ts`/`BacktestEngine.ts` — parity tests would be required before treating its output as comparable evidence, per `CLAUDE.md`'s Java migration rule 9.
5. Per `CLAUDE.md`'s Java 26 Engine Authority section (updated this session, rule 13): any future bug fix to a calculation that has a Java counterpart goes to Java, not a TS-only patch.
