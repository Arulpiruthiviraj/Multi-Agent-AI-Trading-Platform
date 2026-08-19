# CLAUDE.md

Argus operational master specification. This file is the live-path contract for agents and operators. Dated phase reports were synthesized here (2026-08-18). **Adding markdown does not raise readiness scores.** Code + `evaluateLiveReadiness()` + organic `trades`/`fills` beat this document.

Argus is a Node.js multi-agent trading terminal (Express + Vite SPA + `ws` + SQLite). Package name `my-money-miner`. The **live decision path** is EventBus → idea agents → ChiefTrader → RiskEngine → OMS → BrokerManager. Do not rewrite that path. New work is additive, modular, feature-flagged, tested, and backward compatible.

## ARGUS CORE ARCHITECTURE — DO NOT MODIFY

AI coding agents **must not** alter the protected trading architecture unless the repository owner explicitly authorizes an architectural change. Full contract: `ARGUS_ARCHITECTURE_PROTECTION.md`.

Protected (extend through the documented interface only — never replace, bypass, weaken, or duplicate): `ChiefTraderAgent`, `RiskEngine`, `OrderManagementService`, `BrokerManager` + broker adapters, reconciliation, the kill-switch system, the trading-state machine, portfolio accounting, order lifecycle, fill processing, position reconciliation, the 24 risk gates, paper/live safety controls (5-layer LIVE arming).

If a requested feature appears to require modifying anything in that list: **stop**, explain the architectural conflict to the user, and do not implement a bypass. Prefer adding an adapter, service, event, strategy, or integration point around the existing architecture — see the extension-zone examples (`src/server/multiAsset/`, `src/server/continuous/`) in `ARGUS_ARCHITECTURE_PROTECTION.md`.

**LIVE real-money: `LIVE_NO_GO`.** Paper: `PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS` (supervised, conditional). Empirical edge is **not established**.

TradingAgents (https://github.com/TauricResearch/TradingAgents, Apache-2.0) is **inspiration only**. Vendor **zero** of that source. Argus stays system of record.

---

## Ground truth (do not inflate)

| Source | Use for |
|---|---|
| This file | Live path, 24 gates, AI routing, traces, soak, defects, working rules |
| `README.md` | Setup, commands, `.env`, local AI, ecosystem spawn |
| `docs/ARGUS_DOCUMENTATION_INDEX.md` | Operator vs developer forensic debugging / DB / EventBus (does **not** replace this contract) |
| `config/*.json` | Numbers, strategy IDs, event names — not TypeScript literals |
| `src/server/db/schema.ts` | Table count (drifts; count `sqliteTable(`) |
| `evaluateLiveReadiness()` / `ARGUS_LIVE_READINESS.json` | Machine LIVE gates (6/28 PASS as of 2026-08-18) |

NewsAgent last scored pass: **44.6% on 242 predictions**. Walk-forward OOS for checked quant combos **failed**. Organic closed paper FILLED SELL P&L: **0**. Historical AI replay of past years is **UNAVAILABLE** without point-in-time news/LLM logs — do not fabricate a 2022 debate.

Forensic snapshot (2026-08-18 hostile pass, not a certificate): engineering ~89.3%, capital/validation ~12%, blended ~50.7%. Trading-edge score **8/100**. Dual scores are not LIVE eligibility.

---

## Hard working rules

- Do **not** bypass RiskEngine, BrokerManager, or OMS. AI interprets quant evidence; it does not replace it or invent prices/EV.
- Do **not** add a second kill switch. `emergency-stop` / `TRADING_PAUSED` / `EMERGENCY_STOP` already exist. Autobot off is **not** a second kill switch (it blocks new BUY; SELL/exits still require `TRADING_ENABLED`).
- `settings.budget` is Argus **allocation**, not broker equity. Enforced by `CapitalAllocation` + gate `argus_capital_allocation`.
- Do **not** hardcode operational/safety thresholds or **strategy-id literals** in TypeScript. Put numbers and strategy membership in `config/*.json`. Tests must derive expected values from the same config production loads.
- Quant live cycle is **off** unless `QUANT_ENGINE_ENABLED=true`. SMC in live `evaluateAll()` only if `QUANT_SMC_STRATEGY_ENABLED=true`. Do not enable flags to “see if it works.”
- Do not describe unused agents (`MarketRegimeAgent`, `AdvancedQuantEngines`) as if they vote on trades. No classes: SentimentAgent, OrderFlowAgent (UI names only).
- Sibling engines (`vibe-trading`, `autohedge`, `OpenAlice`, `FinceptTerminal`) are **untrusted, read-only**. They never receive Argus broker credentials, never call `placeOrder`, and AutoHedge `WALLET_PRIVATE_KEY` / `SOLANA_PRIVATE_KEY` are forcibly emptied by the orchestrator.
- `PAPER_TRADING_ONLY=true` refuses LIVE arm (`BrokerManager.setLiveMode(true)` and Alpaca LIVE authenticate throw).
- AGENTS.md-era ATR-based sizing is **not** live RiskEngine. Stop assumption is `tradingSafety.stopLossAssumptionPct` (0.05), not ATR.

---

# 1. System Core Architecture & Execution Spine

## Process model

Single Node.js process: Express + Vite middleware (dev) or static files (prod) + raw `ws`. SPA: `src/App.tsx`. Backend entry: `server.ts` (remaining `/api/v1/` plus quarantined routes). Many routes live under `src/server/routes/`. Port **3000** hardcoded (`PORT` is unused). Bind: **`127.0.0.1` when `AUTH_PASSWORD` unset** (loud WARNING); `0.0.0.0` only when auth is enabled.

**Login-screen gotcha:** `if (!isAuthenticated) return <Login/>` sits in `App()` *after* most `useEffect` hooks. Hooks still run on the login screen. Gate every fetch/WebSocket effect on `isAuthenticated`. DEF-22: WebSocket must not connect until session confirmed.

Boot (simplified): import constructors → AIRouter → **`await BrokerManager.initialize()` before `tradingEngine.initialize()`** (DEF-01) → seed settings → **MarketDataWorker.start always** → model probes → listen. Autobot `system.start` only if `autoBotEnabled`. Migrations run on first import of `src/server/db/index.ts`. `npm run db:migrate` (`database/migrate.ts`) imports that same module.

Autobot off: ticks can still drive Technical/Kronos → pipeline if `TRADING_ENABLED`. `system.stop` does not stop MarketDataWorker (Diagnostics/RiskEngine still need a feed).

`AutoTradeScheduler`: when a schedule window says Autobot should be on and `enabled` is already true, the tick is an **idempotent no-op** (no `toggle()`, no worker respawn, no pause auto-resume). `market_hours` is independent of the schedule.

## Live path (do not rewrite)

```
Alpaca WebSocket → emitMarketData() → MARKET_DATA + MARKET_DATA_UPDATED
 ↓
Idea agents (timer or MARKET_DATA):
  TechnicalAgent       → real RSI/MACD/Bollinger; TRADE_IDEA_GENERATED
  NewsEngine           → real RSS + paid news APIs (+ optional LLM)
  FundamentalAgent     → AlphaVantage + AIRouter (~60s, tracked symbols)
  MacroAgent           → AlphaVantage + AIRouter (~75s)
  PortfolioMonitor     → ~60s; settings.takeProfitPct / trailingStopPct
                         (cost-basis vs average, **not** ATR/peak trail);
                         Quant thesis invalidation (config/thesisInvalidation.json)
                         (exits are SELL *ideas*, not raw broker flattens)
  QuantSignalAgent     → off unless QUANT_ENGINE_ENABLED=true
  KronosForecastAgent  → optional local Chronos; honest warning if /health is down
 ↓ TRADE_IDEA_GENERATED {traceId, symbol, side, confidence, reasoning, agent, currentPrice?}
    (gated by gateTradeIdea / looksLikeListedTicker — DEF-24)
ChiefTraderAgent
  → weights from agent_performance_stats (defaults: config/agentWeights.json)
  → optional AIRouter.routeConsensus (per-symbol cooldown); HOLD can veto
  → min independent agreeing agents + weighted confidence vs
    tradingSafety.consensusApprovalThreshold (JSON, not a TS literal)
    Risk-exit agent PortfolioManager skips debate/min-agents
    Liquidate: PipelineFlatten emits ManualOverride CHIEF_APPROVED_IDEA
      (skips consensus, **not** RiskEngine). Rebalance: `PortfolioRebalance.ts`
      same pipeline (direction only; RiskEngine sizes).
 ↓ CHIEF_APPROVED_IDEA  (mints transactionId; optional OpenAlice fire-and-forget)
RiskAgent → RiskEngine.evaluateRisk()
  → evaluationQueue mutex (serialized)
  → refuses invalid equity / invalid ticker+price
  → every gate recorded even after first failure
  → persist risk_assessments then emit RISK_ASSESSMENT_COMPLETED (P0.3)
 ↓ OMS → BrokerManager.getActiveBroker().placeOrder(...)
    authorizeProductionOrder first (P0.1 LIVE_NO_GO)
 ↓ trades + fills (unique orderId, cumulativeQuantity — P0.4)
 ↓ ORDER_EXECUTED → WebSocket wildcard → React
```

`GET|ALL /api/v1/signals` is **HTTP 410** `SIGNALS_PATH_QUARANTINED`. Event-memory routes are **410** `EVENT_MEMORY_QUARANTINED`. They are not restorable order paths. Older docs that described a live legacy simulation are **superseded**.

OMS is the sole production `.placeOrder(` caller (`phase21.invariants.test.ts`). Broker timeout stays **PENDING / UNKNOWN**, never FILLED.

## Thread safety, queues, fill idempotency

| Invariant | Rule |
|---|---|
| RiskEngine `evaluationQueue` | Promise-chain mutex; only `evaluateRisk()` is serialized. Closes DEF-09 rate-limit count-then-insert race. |
| P0.3 persist-then-emit | Persist failure emits `RISK_BLOCK` and **does not** emit `RISK_ASSESSMENT_COMPLETED` (OMS never fires). |
| P0.4 fill ledger | Unique `(order_id, cumulative_quantity)` on `fills`. Duplicate watermark is a unique-constraint no-op. |
| OMS crash recovery | `clientOrderId` always passed; `reconcileStaleOrders()` looks up by `client_order_id` (DEF-05, DEF-06). |
| SQLite | One writer. Import `db` from `src/server/db/index.ts` only. Second process on the same file has been seen to report false `SQLITE_CORRUPT`. WAL. |
| Ticks | `MarketDataWorker.acceptTickTimestamp`: reject future skew / out-of-order (`tickFutureSkewMs`, `tickOutOfOrderEpsilonMs`). `lastTick` lookup uses `quoteKey`. |
| Worker start | `SystemBootstrap.isRunning`, worker `intervalId`, MarketDataWorker OPEN/CONNECTING socket — no duplicate loops on Autobot re-enable. |
| Reconciliation | Never auto-flatten (`autoFlattenOnReconciliationMismatch: false`). Never auto-resume pause. Warmup suppresses pause, still persists mismatches (DEF-02). |

## P0.1–P0.7 verified in-process safety invariants

Verified in unit tests (2026-08-18). **Tests are not LIVE evidence.** `SOFTWARE_TESTS` inside `evaluateLiveReadiness()` remains UNAVAILABLE by design.

| ID | Invariant | Code |
|---|---|---|
| P0.1 | LIVE_NO_GO blocks OMS `placeOrder`; paper unaffected | `liveOrderAuthorization.ts`, `OrderManagement.ts` |
| P0.2 | IBKR paper/live account isolation fail-closed | `config/ibkrAccountClassification.json`, `InteractiveBrokersAdapter.ts` |
| P0.3 | RiskEngine persist-then-emit | `RiskEngine.ts` |
| P0.4 | Fill unique `(orderId, cumulativeQuantity)` | `fillLedger.ts`, `drizzle/0037_fills_cumulative_unique.sql` |
| P0.5 | Compile/test/build green in that session | `tsc`, vitest, `npm run build` |
| P0.6 | `unhandledRejection` / `uncaughtException` → `data/logs/crash.log` + `SYSTEM_ANOMALY` | `globalErrorHandlers.ts` |
| P0.7 | Operator ack for `FILLED_ORDER_MISSING_LOCALLY` | `ReconciliationAcknowledgements.ts` |

Also verified: P1.1 SIGTERM/SIGINT drain (`gracefulShutdown.ts` — pause, stop workers, WAL checkpoint, close HTTP/WS; does not invent broker cancel/fill outcomes); P1.7 Coinbase live `placeOrder` requires LIVE_ARM + `PAPER_TRADING_ONLY` check.

## 5-layer LIVE arming (all required; all fail-closed)

1. Human confirmation phrase on `tradingEngine.toggle` when going LIVE.
2. `tradingState === 'TRADING_ENABLED'` (cannot go LIVE while paused).
3. `PAPER_TRADING_ONLY` must be false (env).
4. Alpaca live host refuses without arm.
5. Per-process `LIVE_ARM` is memory-only (cleared on restart). OMS still refuses if `evaluateLiveReadiness() !== LIVE_READY`.

## How a BUY / SELL happens

BUY: ticks → idea (Technical after ~50 ticks, or timers) → ChiefTrader (debate if confidence > `debateTriggerConfidence`; min **2** independent agents; bar **0.75**; HOLD with confidence > 0 penalizes) → RiskEngine (needs live price; all 24 gates recorded) → whole-share MARKET → broker. OpenAlice does not block.

SELL: same path + `sell_position_exists`. No fractional/notional shares: `Math.floor(dollars / price)`; Alpaca `qty` only.

## Config JSON (reviewed files, not API/UI knobs)

Loaded via `src/server/config/loadRepoConfigJson.ts`. Missing required keys **fail boot**.

| File | Role |
|---|---|
| `tradingSafety.json` | Thresholds (consensus, stale ms, concentration, restricted-live caps, cooldowns, quant interval, …) |
| `riskGateOrder.json` | Catalog order for UI — pass/fail from `risk_gate_results` |
| `eventNames.json` | EventBus type strings |
| `agentWeights.json` | Default ChiefTrader weights |
| `aiModels.json` | Local Ollama routes + heavy-model mutex |
| `observability.json` | Log levels, retention, taxonomy |
| `markets.json` | US/CA metadata. Does **not** authorize Canadian live routing |
| `ibkrAccountClassification.json` | Paper vs live account prefixes |
| `smcConfluence.json` | SMC detection/strategy weights |
| `thesisInvalidation.json` | Rule types’ strategy lists — no strategy-id literals in TS |
| `noTradeReasons.json` | NO_TRADE catalog |
| `bullBearResearch.json` | Bull/Bear schema; numeric fields must come from Quant |
| `quantExperimentalStrategies.json` | Experimental strategy IDs + env flags |
| `quantForumStrategies.json` | Forum playbook → module or `NOT_SUPPORTED` |
| `quantStrategyTaxonomy.json` | ~760 name aliases — not 760 live edges |
| `researchSafety.json` | Soak / OOS / WFO floors (research, not live knobs) |
| `runtimeIntervals.json` | Worker intervals |
| `consensusFixtures.json` | Test fixtures |

## EventBus

`src/server/core/EventBus.ts` — Node `EventEmitter` singleton. `EventStore.ts` is a capped in-memory ring. Decision-lifecycle events persist to `event_traces`. Canonical types in `config/eventNames.json`. High-frequency ticks are sampled / not all durably stored (`observability.json` `marketDataPersist`).

## Brokers

`BrokerManager.getInstance().initialize()` from `startServer()`. Default if none selected: **InternalPaperBroker** (in-memory fills, `$100k` default cash from `internalPaperDefaultCash`).

| Broker | Role |
|---|---|
| AlpacaBroker | Paper or live REST; only fully unattended broker. TLS via `node:https` + system CA (DEF-10/11). Timeouts/retry/circuit breaker in `tradingSafety.json`. |
| InteractiveBrokersAdapter | Client Portal Web API. Local Gateway + human 2FA ~24h (`requiresManualReauth: true`). Cannot place Canadian-exchange equities (IIROC 3200A.1(b)(i)). Gateway WAF 403 if no `User-Agent` — adapter sets one. `U*` live / `DU*` paper — adapter trusts Gateway session; P0.2 fail-closes classification mismatch. |
| CoinbaseBroker | Real Advanced Trade CDP-JWT. `placeOrder()` **refuses in paper** (no sandbox). Live requires LIVE_ARM. Not funded-account verified here. |
| QuestradeBroker | Read-only OAuth2. `placeOrder()`/`modifyOrder()` throw. Never the order-placing broker. |

Encryption: AES-256-CBC (`ENCRYPTION_SECRET` or `data/.encryption_key`). Export DB + copy the key or encrypted keys are unrecoverable.

## Capital / TradingEngine

`TradingEngine.toggle()` is **async**. Enable transition checks allocated `budget` vs broker `buyingPower`/`cash` and rejects if over. Callers must `await`. Restricted LIVE file ceilings (`RestrictedLiveMode.ts`, never a UI knob): `$5000` order, `3` open positions, `$1000` daily loss. No-op in paper.

Daily buy notional: paper uses `maxDailyBuyNotionalDollars`; LIVE always `restrictedLiveMaxDailyBuyNotionalDollars`. Distinct from the daily-loss kill-switch.

Position sizing: shared `PositionSizing.ts` (live + `BacktestEngine`). Default `FIXED_DOLLAR` (`settings.maxTradeSize`, fallback `$3000`). Optional `PERCENT_OF_EQUITY`. Zero-quantity `CLAMPED` results are **FAIL**, never silent pass. LIVE unknown sizing inputs fail-closed.

Kelly/EV (`quant/risk/ExpectedValue.ts`) can suppress Quant **ideas** only. RiskEngine does **not** size from Kelly. Kelly refuses &lt; 20 closed trades; fraction capped at 10% of capital.

## Quant (additive, default off)

`src/server/quant/`. Five **CORE** in live `evaluateAll()`: `MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`. Experimental (UNVALIDATED; live only if that env is `'true'` at **call time**): includes `SMC_LIQUIDITY_SWEEP`, VWAP/ORB/Donchian/MA/oscillator/BB/gap/Fib/volume/SR/RS rotation, `STATISTICAL_MEAN_REVERSION`, others in `quantExperimentalStrategies.json`. `findStrategy(id)` searches core then experimental so **backtests work without the live flag**. Off-regime confidence is discounted (`regimeMismatchConfidenceMultiplier`), never zeroed.

`NOT_SUPPORTED` (never fill zeros): breadth, options, L2, volume profile, TSI, anchored VWAP, pairs, CAD FX, Wheel CSPs / 0DTE / GEX / DOM/CVD.

Isolated `src/server/strategiesEngine/` (modes `OFF` / `SHADOW` / `ANALYSIS_ONLY`) is a **second** research subsystem: own `MarketSnapshot` (not live `StrategyContext`), condition trees (`entry` / `confirmation` / `invalidation` / `exit`), AND/OR/NOT/XOR DSL, deterministic variant IDs. It reuses quant indicator **math** only. It does **not** import ChiefTrader, RiskEngine, OMS, BrokerManager, or EventBus; the live path does not import it. `METADATA_ONLY` families (options, L2, pairs, ML, …) stay non-evaluable. Generated variant counts come from `getEngineStats()`, not a hardcoded claim. `StrategyPerformance` is a result **shape**, not fabricated Sharpe. This subsystem **never** places or influences a real order.

Research fill models: `canonicalNextBarEngine.ts` = **NEXT_BAR_OPEN** (only promotion-adjacent path); `BacktestEngine.ts` = **SAME_BAR_CLOSE** (explicitly non-promotable). Warehouse parquet presence ≠ OOS/WFO/paper validation.

Backtest `run()` = TA-like rules, no AI. `runStrategyBacktest()` = named strategy, **long-only**. Walk-forward does not optimize.

## Reflection / learning

`ReflectionEngine` (~60s) scores predictions vs price, updates `agent_performance_stats.currentWeight`. LLM rule text → `learned_rules`. Recent rule text is truncated into the ChiefTrader **debate prompt only** (`debateLearnedRulesCount` / `debateLearnedRuleMaxChars`). It does not override RiskEngine.

## Frontend honesty

**20** desktop `AppTabId`s (`src/components/responsive/responsiveNavConfig.ts` `ALL_TABS`): dashboard, command, portfolio, arena, agents, evaluation, memory, activity, observatory, scanner, intelligence, learning, kronos, opportunities, news, settings, diagnostics, audit, validation, documentation. There is **no** `deployment` tab (that copy lives inside validation). Mixed REAL/MOCK.

Phone layout (`src/components/mobile/`, width <768 or Mobile toggle): **6** tabs `cockpit | positions | brain | risk | terminal | settings`. Operator how-to: `docs/ARGUS_MOBILE_SETTINGS.md`.

| Surface | Honesty |
|---|---|
| L2 order book | No L2 source (Alpaca IEX top-of-book). UI: “L2 Depth Data Unavailable”, never a fake ladder |
| DigitalTwinVisualizer | Node/edge glow from **real WebSocket events only** |
| AgentWorkflowTheater | Educational motion; looping scenes are architecture, not ticks |
| Sentiment trend | `-1` to `+1`, not 0–100 |
| Execution quality | Submit-to-fill latency; **no slippage field** (proposal price not persisted) |
| Execute override | Full RiskEngine; never OMS-direct |
| Arena performance widgets | `AwaitingSignal` — not RNG win rates |
| MultiAgentDialogueGraph / some Agent Network charts | Fabricated/mock series — do not cite as live accuracy |
| DecisionTracePanel | Persisted rows by `traceId`; not a fabricated LLM council |
| Mobile Settings | Dual-config overlays + operator knobs; `PAPER_TRADING_ONLY` padlocked; scan/watchlist/spread/quorum **read-only** from reviewed JSON. Does not arm LIVE. |

Do not dump hidden chain-of-thought. Safe: side, confidence, EV, model name, latency, data-quality, NO_TRADE code, `inventedNumericFieldsRejected`.

---

# 2. 24-Gate RiskEngine Reference

Catalog order: `config/riskGateOrder.json`. Pass/fail must come from `RISK_GATE_EVALUATED` / `risk_gate_results` — never from the JSON file alone. All gates are **recorded** even after the first failure. The **first failure in evaluation order** is the reported rejection. AI cannot override this ladder.

Numbers below are the production `tradingSafety.json` / settings defaults as of consolidation. Do not copy them into TypeScript; load config.

| # | Gate | Fail-closed rule |
|---|---|---|
| 1 | `emergency_stop` | Pass iff `tradingState === 'TRADING_ENABLED'`. `TRADING_PAUSED` and `EMERGENCY_STOP` both block. Replay forces ENABLED for research clock. |
| 2 | `autobot_enabled` | New **BUY** requires Autobot on. **SELL**/exits are not blocked by Autobot-off. |
| 3 | `same_symbol_cooldown` | BUY blocked if a FILLED same-symbol trade within `sameSymbolCooldownMs` (300000). |
| 4 | `post_loss_cooldown` | BUY blocked for `postLossCooldownMs` (900000) after a losing fill. |
| 5 | `daily_trade_limit` | BUY count vs `maxDailyTrades`. **0 = skipped** (no cap). NY calendar day. |
| 6 | `duplicate_signal` | Same symbol/side risk assessment within `duplicateSignalWindowMs` (60000). Replay skipped (uses `openStops`). |
| 7 | `invalid_account_equity` | Broker equity missing or not positive. **No `$10000` placeholder.** Downstream gates recorded `SKIPPED_INVALID_ACCOUNT_EQUITY`. |
| 8 | `daily_loss` | `dailyLoss < dailyLossLimit * dailyLossKillSwitchFraction` (0.8). Day baseline is **America/New_York** (`getTradingDateStr`), not UTC. LIVE min daily-loss cap `$1000` when restricted-live active. |
| 9 | `consecutive_loss` | Last `maxConsecutiveLosses` (3) closed FILLED trades all losers → fail. |
| 10 | `portfolio_drawdown` | `(peak − equity) / peak < maxPortfolioDrawdownPct` (settings; default 0.15). Peak only ratchets up. Distinct from daily loss. |
| 11 | `order_rate_limit` | `risk_assessments` in last 60s &lt; `maxOrdersPerMinute` (settings default 5). Replay skipped. |
| 12 | `market_hours` | Alpaca `/v2/clock`. **Unconfigured (no keys) → skip/pass.** Closed → fail. HTTP/network failure → **fail-closed** (`unavailable`), never treat outage as open. Replay uses session classifier. Independent of AutoTradeScheduler. |
| 13 | `data_freshness` | Tick age ≤ `stalePriceThresholdMs` (300000). **Null age (never ticked) → fail** (DEF-08, by design). Replay uses last completed bar. |
| 14 | `news_veto` | `news_clusters` in `newsVetoWindowMs` (4h) covering symbol with impact &gt; `newsVetoMinImpactScore` (80). **Direction-blind.** |
| 15 | `price_validity` | `looksLikeListedTicker(symbol)` **and** finite `currentPrice > 0`. Reason codes: `INVALID_SYMBOL`, `MISSING_PRICE`, `NON_NUMERIC_PRICE`, `NAN_PRICE`, `NON_FINITE_PRICE`, `NON_POSITIVE_PRICE`. Upstream `gateTradeIdea()` drops garbage before ChiefTrader. Do not weaken this gate. |
| 16 | `order_notional_cap` | PositionSizing: notional ≤ `maxTradeSize` / restricted-live `$5000`. |
| 17 | `symbol_concentration` | Position ≤ `maxSingleSymbolConcentrationPct` (0.20) of equity. |
| 18 | `open_positions_cap` | Open names ≤ settings / restricted-live 3. |
| 19 | `sector_concentration` | Sector ≤ `maxSectorConcentrationPct` (0.40). Coarse `SECTOR_MAP` in PositionSizing. |
| 20 | `correlation_exposure` | Correlated overlap ≥ `correlationMinOverlap` (20) and corr ≥ `correlationThreshold` (0.7) → cap `maxCorrelatedExposurePct` (0.50). |
| 21 | `sufficient_size` | Whole shares ≥ 1 after stops/BP. Stop-per-share = `stopLossAssumptionPct` (0.05), **not ATR**. |
| 22 | `sell_position_exists` | **SELL only.** Recorded on SELL; BUY assessments omit it. Must have quantity &gt; 0. |
| 23 | `argus_capital_allocation` | BUY notional ≤ remaining Argus allocation (budget − positions − pending BUYs). Example: broker `$2000`, budget `$100` → `$101` BUY fails here. |
| 24 | `daily_buy_notional` | Cumulative BUY dollars on the NY session vs paper/LIVE caps. |

Older “18-gate” lists omitted 1–7 (`autobot_enabled` through `invalid_account_equity`). **24 is current.**

---

# 3. 6-Model AI Routing & Concurrency Map

All LLM calls go through `AIRouter.getInstance()`. Failover, health, EMA latency, `setAgentRoute()` / `GET|POST /api/v1/config/routing`. `estimateCost()` uses published pricing; local/Ollama is `$0`. Extra `.env` keys (Anthropic, Mistral, Grok, …) do **not** imply a dedicated provider class. Router-native today: Gemini, OpenAI, DeepSeek, Nvidia, OpenAI-compatible (Ollama `http://127.0.0.1:11434/v1`).

Persisted `agent_routing_overrides` **win** over `config/aiModels.json` defaults.

## Default local routes (`config/aiModels.json`)

| Agent | Model | Fallback | Notes |
|---|---|---|---|
| NewsAgent | `fingpt:latest` | `0xroyce/plutus:latest`, `llama3.2:latest` | Financial-news specialization |
| FundamentalAgent | `0xroyce/plutus:latest` | `llama3.2:latest` | Valuation / statements prompt |
| MacroAgent | `0xroyce/plutus:latest` | `llama3.2:latest` | CPI / Fed / unemployment |
| ReflectionEngine | `deepseek-r1:14b` | plutus, llama3.2 | Post-trade post-mortem |
| BullResearcher | `deepseek-r1:14b` | plutus, llama3.2 | Only if `QUANT_BULL_BEAR_ENABLED` |
| BearResearcher | `deepseek-r1:14b` | plutus, llama3.2 | Same; HOLD evidence possible |
| ExplainabilityAgent | `llama3.2:1b` | `llama3.2:latest` | Fast UI copy |

**Not routed here:** TechnicalAgent (deterministic RSI/MACD/BB — no LLM). ChiefTrader `routeConsensus('ConsensusDebate')` fans out to **multiple providers in parallel**; there is no single “Chief Trader model” in this file.

`qwen2.5:14b` is a **heavy** model (VRAM lock) available for operator override. It is **not** a default `routes` entry.

## 14B VRAM concurrency lock

`HeavyModelMutex` (`config/aiModels.json` `heavyModels`: `qwen2.5:14b`, `deepseek-r1:14b`):

- `maxConcurrentHeavyModels`: **1**
- `maxQueueDepth`: **10** (fail fast when full → caller HOLD / confidence 0)
- fingpt / plutus / llama3.2 variants are **not** throttled
- RiskEngine / OMS / broker never pass through this mutex

## DeepSeek `<think>` sanitization

`OpenAICompatibleProvider` strips `<think>...</think>` from `.content` before JSON parse. Downstream never consumes hidden chain-of-thought. Fail-closed on malformed AI: HOLD / confidence 0 (`AIOutputValidator`). Confidence is clamped 0–1 (never 0–100 mistaken as 85).

Bull/Bear `parseResearchNote.ts`: LLM entry/stop/target/EV/probability are **nulled** and listed on `inventedNumericFieldsRejected`. Interpretive confidence is **not** a calibrated win rate.

NVIDIA OpenAI-compatible default still falls back to `gpt-3.5-turbo` when `default_model` is null (NIM 404). Operator must set a real NIM model id. This is an AI-ops defect, not a LIVE unlock.

Chronos: `npm run ai:serve` → `scripts/local_ai_service.py` on `:8008` (`amazon/chronos-t5-mini`). KronosForecastAgent needs 30+ ticks and ≤1 call/symbol/60s. If `/health` is down, report unavailable — do not fabricate forecasts. FinBERT / XGBoost are local numeric helpers, not order authority.

---

# 4. Authoritative Decision Trace Schema

A **decision** is one `traceId` minted by `generateTraceId(symbol)` (`src/server/core/traceId.ts`). That string **is** `decisionId` and `correlationId` on the spine.

`transactionId` is a **different** ledger key minted at ChiefTrader consensus. Do not join on the wrong id.

## 7-table reconstruction

`getDecisionTrace(traceId)` (`src/server/observability/queryTraces.ts`) joins:

1. `transaction_traces` — lifecycle status, consensus scores
2. `agent_reasoning_logs` — per-agent thoughts
3. `event_traces` — durable EventBus envelopes (`correlation_id = traceId`)
4. `observability_events` — structured logs (`decision_id = traceId`)
5. `risk_assessments` + `risk_gate_results`
6. `trades` + `fills` (if an order exists)
7. `ai_calls` — assembled view uses **promptHash only** (`promptHashLength` in observability.json). Raw `ai_calls.prompt` may still exist forensically — do not display CoT.

## HTTP

| Method | Path |
|---|---|
| GET | `/api/v2/traces` |
| GET | `/api/v2/traces/:traceId` |
| GET | `/api/v2/traces/:traceId/export` (`schema: argus.decision_trace.v1`) |
| GET | `/api/v2/observability/decisions/:traceId` |
| GET | `/api/v2/observability/orders/:orderId` |
| GET | `/api/v2/observability/metrics` (`sessionId`) |
| GET | `/api/v2/live-readiness` |

Export JSON includes `live: "NO-GO"` and `organicClaim: "NOT_ASSERTED"`. Presence of a trace is **not** organic paper evidence.

## Observability ops

Levels TRACE→FATAL. Safety categories never DEBUG (`safetyMinLevel` INFO). Fail-open logs / fail-closed trading. Retention/sampling from `config/observability.json` (`retentionDays` 14, queue 2000, dropPolicy `newest`). Secret redaction: JWT/Bearer/query/objects (`SecretRedaction.ts`). Process telemetry ring is **not** a multi-hour soak.

**Not a decision trace:** telemetry pulse / Digital Twin animation; REPLAY / HISTORICAL_REPLAY fills; DIAGNOSTIC pending trades; in-memory `EventStore.recentEvents` after restart.

## Database (notable)

Count `sqliteTable(` in `schema.ts` (drifts). Include: `settings`, `trades`, `fills`, `portfolio`, `ai_calls`, `event_traces`, `observability_events`, `risk_assessments`, `risk_gate_results`, `transaction_traces`, `agent_reasoning_logs`, `news_clusters`, `ohlcv_bars`, `quant_assessments`, `kill_switch_events`, `reconciliation_events`, …

Backup: `GET /api/v1/system/export-db`. Restore: `POST /api/v1/system/import-db` (`application/octet-stream`; restart required).

---

# 5. Operational State, Soak Floor & Pre-Flight Runbook

## Current readiness

| Item | Status |
|---|---|
| Paper (supervised) | **`PAPER_READY_WITH_REQUIRED_OPERATOR_ACTIONS`** — mechanically possible; operator must watch recon, Autobot, and RTH |
| LIVE | **`LIVE_NO_GO`** — `evaluateLiveReadiness().result`; live eligibility FAIL |
| Organic PAPER FILLED SELL P&L | **0 / 30 trades · 0 / 10 sessions · 0 / 30 calendar days** |
| Profit factor / expectancy | null (need PF ≥ 1.2, expectancy &gt; 0 from `researchSafety.json`) |
| Canadian live routing | **BLOCKED** (IIROC 3200A.1(b)(i)). `markets.json` metadata ≠ execution |
| Quant default | OFF |
| CORE strategies | UNTESTED on REAL_MARKET_DATA NEXT_BAR_OPEN |
| Mandatory LIVE gates | **6 / 28 PASS**: `SOFTWARE_ORDER_PATH`, `EXECUTION_OMS`, `RISK_GATES`, `RESEARCH_WAREHOUSE`, `ZERO_COST_RESEARCH`, `QUANT_DEFAULT` |

Soak floors (`config/researchSafety.json`): `minPaperTrades` 30, `minPaperSessions` 10, `minPaperCalendarDays` 30, `minPaperProfitFactor` 1.2, `minPaperExpectancy` 0, `minOosTrades` 30. REPLAY / EXTERNAL_SYNC / DIAGNOSTIC / shadow / telemetry pulse **do not count**. Script: `npx tsx scripts/organic_paper_soak_status.ts`.

`TRADING_ENABLED` + Autobot on **does not** equal soak completion.

## Required operator actions (paper)

1. Copy `.env.example` → `.env`. Keep `PAPER_TRADING_ONLY=true` unless you are not this environment’s LIVE program.
2. Set `AUTH_PASSWORD` (+ `AUTH_SESSION_SECRET`) for any non-localhost bind.
3. Confirm Alpaca **paper** keys; MarketDataWorker WS OPEN before expecting `data_freshness` to pass.
4. Reconcile broker vs local **before** enabling Autobot. Do not ack-and-resume blindly; do not auto-flatten.
5. Confirm `GET /api/v2/live-readiness` is `LIVE_NO_GO`.
6. Autobot ON only when you intend paper ideas. Kill switch remains `TRADING_PAUSED` / `EMERGENCY_STOP`.
7. Do not set `tradingMode: LIVE` without confirmation phrase **and** LIVE_READY (it is not).
8. Do not treat VectorBT / Research Lab green / parquet as fills.

## Pre-market checklist (America/New_York)

- [ ] Process up (`npm run dev` or `dev:server-only`); Chronos `:8008` healthy if Kronos enabled; Ollama optional
- [ ] `trading_state=TRADING_ENABLED` only after recon is clean (or mismatches understood)
- [ ] Autobot schedule: if engine already running at 09:30, scheduler is a no-op (no restart)
- [ ] Expect `market_hours` FAIL until Alpaca clock says open — that is correct
- [ ] Confirm no LIVE arm; no Canadian routing attempts
- [ ] Note `sessionId` from `/api/v2/observability/metrics` for the session

## Intraday (RTH 09:30–16:00 ET)

- [ ] `market_hours` should PASS when clock is open (keys present)
- [ ] Watch `RECONCILIATION_MISMATCH` / `TRADING_PAUSED` — operator ack, never auto-resume
- [ ] `price_validity` / `TRADE_IDEA_REJECTED` for garbage tickers is expected (DEF-24); session may idle
- [ ] `data_freshness` FAIL with no ticks = DEF-08; certify WS, do not weaken the gate
- [ ] Export 3–5 `traceId`s that reached OMS (`/api/v2/traces/:id/export`); `execution_environment=PAPER`

## Post-market

- [ ] Autobot off or schedule window ended (16:00 default)
- [ ] Confirm fills unique vs broker; no LIVE rows
- [ ] WAL checkpoint / optional DB export
- [ ] Do not count the day toward soak if zero organic closes or if only REPLAY/EXTERNAL_SYNC exist

## Active known issues

| ID | Issue | Status |
|---|---|---|
| DEF-08 | Null quote age → `data_freshness` fail | **BY DESIGN** fail-closed |
| DEF-18 | WAL concurrent open / false SQLITE_CORRUPT | Documented; one writer |
| DEF-23 | False `MISSING_LOCALLY` (GLD/NVDA stale snapshot / `checkedAt`) | **FIXED in unit tests**; not soak-proven on a real open. Recurrence was seen 2026-08-18 before the compare-time stamp fix. Never auto-resume. |
| DEF-24 | Garbage LLM symbols / missing prices | **FIXED upstream** (`gateTradeIdea`); `price_validity` stays fail-closed |
| NVIDIA NIM | `gpt-3.5-turbo` fallback 404 | Operator model-id |
| UI | `App.tsx` almost untested; SPA chunk large | Thin coverage |
| Edge | 0 organic closes; OOS/WFO failed | Calendar + research |

Fixed (do not re-open as current): DEF-01 boot InternalPaper-before-Alpaca; DEF-02 warmup unused; DEF-03/04 missing reconnect imports; DEF-05/06 OMS idempotency; DEF-07 pause flag vs `tradingState`; DEF-09 evaluation queue; DEF-10/11 Alpaca TLS; DEF-22 WS-before-auth.

Canadian: automated routing **BLOCKED**. IBKR `placeOrder` does not call `isCanadianListing` as a second legal gate — IIROC block is policy + `canadianEquities: false`.

## Commands

```bash
npm run dev              # ecosystem-dev.ts → optional vibe/autohedge/OpenAlice/Fincept →
                         # devWithOpenAlice.ts → tsx server.ts (:3000).
                         # Also Chronos (:8008) and Ollama if missing.
                         # Skip: ARGUS_SKIP_CHRONOS / ARGUS_SKIP_OLLAMA /
                         # ARGUS_SKIP_OPENALICE / ENABLE_*=false
npm run dev:core         # Chronos/Ollama/OpenAlice/IBKR + server (no vibe/autohedge/Fincept)
npm run dev:server-only  # tsx server.ts only
npm run build            # Vite SPA + esbuild → dist/server.cjs
npm run start            # node dist/server.cjs
npm run clean
npm run lint             # tsc --noEmit
npm test                 # vitest run — trust the runner, not a remembered count
npm run test:e2e         # playwright (e2e/moduleToggleParity.spec.ts)
npm run security:scan-writes
npm run setup:ai         # Ollama pull + HF warm-up
npm run ai:serve         # Chronos on :8008
```

E2E uses an isolated temp SQLite DB (never `data/argus.db`). Fresh DB opens **two** onboarding surfaces: Setup Wizard (`settings.onboardingComplete`) and guided tour (`localStorage["argus_tour_seen"]`). Seed both (`e2e/globalSetup.ts` + `page.addInitScript()`).

## Forensic debugging (operators / developers)

Do not duplicate this file. Pointers only:

- **Operators:** `docs/ARGUS_DOCUMENTATION_INDEX.md` → why-not-trading, daily checklist, mobile Settings, SQL under `docs/sql/`.
- **Developers:** same index → pipeline, IDs, database architecture, EventBus. `src/server/db/schema.ts` remains table-count ground truth.

## Adding a new agent

1. Emit `TRADE_IDEA_GENERATED` via `emitTradeIdea` with `{traceId, symbol, side, confidence (0–1), reasoning, agent, currentPrice}`.
2. ChiefTrader already listens.
3. Add `agent_performance_stats` (and `config/agentWeights.json` default if it should bootstrap).
4. LLM: `AIRouter.getInstance().routeTask(...)` only.
5. New EventBus types: add to `config/eventNames.json` first.

## Adding a quant strategy

1. Pure `evaluate(ctx)` module. Put it in `EXPERIMENTAL_STRATEGIES` until validated (OOS + paper).
2. Invalidation: strategy id / thresholds in `config/thesisInvalidation.json`. New comparison logic = new rule type in `ThesisInvalidation.ts`, still no strategy-id `if` ladders.
3. Confluence weights in JSON.
4. Backtest is long-only; bearish setups will not open shorts.
5. Do not enable live flags to “see if it works.”

## Canadian / disconnected

`markets.json` documents TSX/TSXV. Automated routing **BLOCKED_IIROC**. `archive/python-platform/` is disconnected — the Node app never imports it.

## Default notional honesty

`FIXED_DOLLAR` `maxTradeSize` (default `$3,000`) often binds before the 20% symbol cap on large accounts. `PERCENT_OF_EQUITY` is opt-in.
