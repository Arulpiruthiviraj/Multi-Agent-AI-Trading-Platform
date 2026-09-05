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

None of these processes can place an order, hold broker credentials (except the Argus Engine
process itself), or bypass the spine above. Ecosystem startup mechanics:
`docs/operations/DEVOPS_LIFECYCLE.md`.

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
| RSI | `RSIEngine.ts` | `indicators/RSI.java` | TS (live) | TS | PARITY_VERIFIED (byte-for-byte, real TS ground truth) |
| MACD | `MACDEngine.ts` | `indicators/MACD.java` | TS (live) | TS | PARITY_VERIFIED |
| Bollinger Bands | `technicalSignal.ts` | `indicators/Bollinger.java` | TS (live) | TS | PARITY_VERIFIED |
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
  sufficient.

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
