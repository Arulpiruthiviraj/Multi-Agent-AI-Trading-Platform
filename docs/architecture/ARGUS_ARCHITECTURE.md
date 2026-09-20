# Argus Architecture

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
