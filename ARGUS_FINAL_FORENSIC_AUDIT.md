# ARGUS FINAL FORENSIC AUDIT

**Audit date:** 2026-08-16  
**Auditor role:** Read-only forensic review of current source, config, schema, tests, and persisted SQLite. Existing markdown was treated as **claims**, not evidence.  
**Method:** Static path tracing; `npx tsc --noEmit` (this session); `npx vitest run` (this session); read-only query of `data/argus.db`; filesystem check for research warehouse.  
**Not done:** LIVE enablement, real broker orders, fabrication of paper fills, modification of production code/config.

---

## 1. Executive Verdict

Argus is a **real, fail-closed Node.js trading terminal** with a single production fill path (EventBus → ChiefTrader or operator override event → RiskEngine → OMS → BrokerManager → adapter `placeOrder`). Software tests in this session **pass**. That is **not** a trading edge and **not** LIVE readiness.

| Question | Verdict |
|---|---|
| Autonomous **paper** (Autobot ON, paper broker) | **CONDITIONAL GO** — plumbing can submit orders through RiskEngine/OMS. No proven expectancy. Operator must accept unattended paper fills. |
| Autonomous **real money** | **LIVE NO-GO** |
| Repeatable trading performance | **NOT PROVEN** — **NO EDGE** on REAL_MARKET_DATA NEXT_BAR_OPEN |
| Production operation | **CONDITIONAL** for a locked-down paper/dev host; **NOT** certified for unattended LIVE |
| Safe unattended 30-day operation | **NO-GO** |

**ORGANIC PAPER EVIDENCE = NONE** in `data/argus.db` (this checkout): 6 rows, all `PENDING` `BUY`, diagnostic symbols (`DIAGTEST*` / `DIAGPIPE*` / `DIAGORDER*`), zero `FILLED` `SELL` with `profit_loss`, zero `executionEnvironment=PAPER` stamps.

Research warehouse directory `data/research` is **MISSING**. Fixture `fixtures/research/golden_sma.json` is **UNIT_FIXTURE**, not promotion evidence.

Canadian automated live routing: **NOT AVAILABLE** (`canadianReadiness.ts` + `canadianEquities: false` on every adapter).

---

## 2. Current Readiness Scorecard

Scores are **not** raised because files, tests, or docs exist. Points require wired + tested + (where claimed) evidenced behavior.

| # | Dimension | Score /100 | Why this number |
|---|---|---|---|
| 1 | Software correctness | 76 | tsc PASS; 1011/1011 vitest; SPA almost untested; comment/doc drift (ATR vs 5% stop) |
| 2 | Execution reliability | 58 | Real OMS+idempotency; InternalPaper/Alpaca paper capable; IBKR 2FA; Coinbase paper refuses; Questrade cannot place; this DB has orphaned PENDING diagnostics |
| 3 | Risk management | 68 | 24 gates evaluated in code; several sizing gates **always record PASS** while clamping qty; `data_freshness` PASSES if no tick age; 5% stop assumption not ATR |
| 4 | Market data quality | 42 | Alpaca WS/REST **implemented**; live quality **UNPROVEN** here; no L2; 5-minute stale window |
| 5 | Strategy quality | 22 | Five CORE `evaluate()` modules exist; **UNTESTED** as promotion artifacts |
| 6 | AI quality | 36 | AIRouter + debate + numeric-null research notes; confidence ≠ probability; calibration empty → raw confidence |
| 7 | Backtest validity | 32 | `BacktestEngine` **SAME_BAR_CLOSE**; canonical NEXT_BAR exists; **ENGINE_MISMATCH** if mixed; zero research costs |
| 8 | OOS validity | 4 | Pipeline code exists; **no GREEN REAL_MARKET_DATA OOS artifacts** in this checkout |
| 9 | WFO validity | 4 | Code exists; SAME_BAR JSON must not count; CORE NEXT_BAR WFO **NOT ESTABLISHED** |
| 10 | Robustness | 4 | Code exists; **no real-data robustness ledger** |
| 11 | Organic paper evidence | 2 | Filter implemented; sample **0** |
| 12 | Statistical confidence | 6 | Monte Carlo/permutation **libraries**; no strategy sample |
| 13 | Operational reliability | 46 | Startup/recon/OMS follow-up exist; 30-day unattended **UNPROVEN** |
| 14 | Broker readiness | 52 | Alpaca unattended US equities **code-complete**; not live-account verified here |
| 15 | Canadian readiness | 15 | Explicitly blocked; Questrade `placeOrder` throws |
| 16 | Observability | 54 | Traces/gates/OMS events exist; many UI widgets `AwaitingSignal` |
| 17 | Security | 64 | Production refuses no-auth; mutating APIs gated; `ARGUS_DEV_TOKEN` logged in no-auth dev; GET open if auth unset |
| 18 | Autonomous recovery | 44 | OMS crash recovery + recon pause **implemented**; funded-account chaos **UNAVAILABLE** |

**OVERALL SOFTWARE READINESS: 68/100**  
(Weighted toward items 1–3, 14, 17. This is “can the pipes fail closed,” not “should you trust P&L.”)

**TRADING EDGE READINESS: 8/100**  
No REAL_MARKET_DATA NEXT_BAR OOS + WFO + robustness + organic paper for a frozen `strategyVersion`. Empty evidence in `tradingEdgeScore()` returns **8**.

---

## 3. Critical Findings

1. **LIVE NO-GO / NO EDGE** — promotion and `evaluateLiveReadiness()` cannot become LIVE_READY on current evidence (`liveReadinessEngine.ts`).
2. **ENGINE_MISMATCH** — live research promotion model is NEXT_BAR_OPEN (`canonicalNextBarEngine.ts`, `config/executionModels.json`); `BacktestEngine` fills **same-bar close** (`executionModel: SAME_BAR_CLOSE`). Mixing PnL is invalid.
3. **THEORETICAL_ZERO_COST** — `config/researchSafety.json` `commissionPerShare/spreadBps/slippageBps` = 0 and `zeroCostBlocksPromotion: true`.
4. **Organic paper = NONE** — SQLite this checkout.
5. **Warehouse UNAVAILABLE** — no `data/research` tree.
6. **Sizing-gate honesty** — `order_notional_cap`, `symbol_concentration`, `sector_concentration`, `correlation_exposure` often record `passed: true` even when they bind quantity to 0 (`PositionSizing.ts`); `sufficient_size` is the actual fail.
7. **`data_freshness` fail-open on never-seen symbol** — `priceAgeMs === null` ⇒ `stale === false` (`RiskEngine.ts`).
8. **Operator paths skip ChiefTrader** — `POST /api/v2/trading/execute-override` and `PipelineFlatten` emit `CHIEF_APPROVED_IDEA` directly; **RiskEngine still runs**. Autobot-off still blocks **new BUY**.
9. **Comments lie about ATR** — `ExpectedValue.ts` header and execute-override comment claim ATR sizing; live sizing uses `stopLossAssumptionPct` **0.05**.
10. **Kelly does not size live orders** — `PositionSizing.ts` has **zero** Kelly/EV imports. Quant may **suppress ideas** if EV ≤ 0.
11. **Dual mode** — `settings.tradingMode` vs `brokerConnections.paperMode`; OMS fail-closed on UNKNOWN (`brokerEnvironment.ts`).
12. **This DB contains orphaned PENDING diagnostic BUYs** — not fills; shows recovery/cleanup is incomplete in the operator DB.

---

## 4. Repository Architecture

**Process:** Single Node.js process. Entry `server.ts` (Express + Vite middleware or static + `ws`). Port **3000 hardcoded** (`PORT` unused). Package name `my-money-miner`.

| Subsystem | Entry | Trading? | Persistence | Frequency | Failure | Tested | Validated |
|---|---|---|---|---|---|---|---|
| EventBus | `src/server/core/EventBus.ts` | Yes (ideas/risk/OMS) | In-memory + `event_traces` (not all ticks) | Event-driven | Lost in-memory events on crash | Isolation tests | N/A |
| MarketDataWorker | `src/server/services/MarketDataWorker.ts` | Indirect | Latest prices in memory | WS ticks | No emit if Autobot off | Worker tests | UNPROVEN live quality |
| TechnicalAgent | `src/server/services/TechnicalAgent.ts` | Ideas | None required | On MARKET_DATA | No tick ⇒ no idea | Gate tests | Not an edge |
| NewsEngine | news services | Catalyst; ideas **off** by default | `news_*` | RSS/API timers | Veto uses clusters | Provider tests | News accuracy **not re-measured this audit** |
| Fundamental/Macro | agent files | Ideas if Autobot on | Cache | ~60–75s | LLM fail ⇒ no idea typical | Some tests | UNPROVEN |
| QuantSignalAgent | same | Ideas only if `QUANT_ENGINE_ENABLED=true` **and** Autobot on **and** EV gate | `quant_assessments` | `quantCycleIntervalMs` 300000 | Default **OFF** | Strategy unit tests | CORE **UNTESTED** |
| KronosForecastAgent | Chronos :8008 | Ideas if running | `kronos_predictions` | Timer | Honest if /health down | Partial | UNPROVEN |
| ChiefTrader | `ChiefTraderAgent.ts` | Consensus | `consensus_*`, PIT ledger | On ideas | Debate fail continues without debate vote | Calibration tests | Confidence ≠ P(win) |
| RiskEngine | `RiskEngine.ts` | Gate | `risk_assessments`, `risk_gate_results` | Serialized queue | Fail-closed on missing equity | Extensive | Controls ≠ alpha |
| OMS | `OrderManagement.ts` | **Only production `placeOrder` caller** | `trades`, `fills` | On approved risk | Reject + crash recovery | OMS tests | Paper plumbing |
| BrokerManager | `src/brokers/BrokerManager.ts` | Adapter select | `broker_connections` | Startup | Default InternalPaper | Manager tests | See broker section |
| PortfolioMonitor | `PortfolioMonitor.ts` | SELL ideas | Reads trades | ~60s | Still runs Autobot off | Tests | Exits not edge |
| PortfolioReconciliation | `PortfolioReconciliation.ts` | Can pause | `reconciliation_events` | Interval | Mismatch → `TRADING_PAUSED` | tradingBlock test | Not LIVE cert |
| Research | `src/server/research/*` | **canPlaceOrders: false** | Optional parquet | On demand | Missing data = reject | phase*.test.ts | Not promotion |
| SPA | `src/App.tsx` | No `placeOrder` | localStorage tour | UI | Login hooks still run | Almost none | UI theater risk |
| Python/VectorBT | `scripts/`, research CLI | Forbidden broker | Files | CLI | Timeout | Skipped unless env | Not edge |
| OpenAlice | integrations | Fire-and-forget | `openalice_verifications` | After approve | Does not block fill | Tests | UNPROVEN vs real OA |

**SQLite:** `better-sqlite3` + Drizzle, WAL, `data/argus.db`. Schema `src/server/db/schema.ts` — **46** `sqliteTable` exports counted this audit. Migrations: `drizzle/` applied on `src/server/db/index.ts` import. `database/migrate.ts` **exists** as a thin re-import of that boot path (`package.json` `db:migrate`).

---

## 5. Complete Trading Execution Path

```
Alpaca (or other) quotes → MarketDataWorker
  → if isLiveIdeaGenerationEnabled() (Autobot ON AND tradingState === TRADING_ENABLED)
     emit MARKET_DATA
  → idea agents → TRADE_IDEA_GENERATED {traceId, symbol, side, confidence, reasoning, agent, currentPrice?}
  → ChiefTraderAgent.reviewIdea
       (ignore non-risk-exit if Autobot off)
       optional debate / BullBear (env)
       evaluateConsensus: min 2 independent agents, weighted conf > 0.75, HOLD veto
  → CHIEF_APPROVED_IDEA
  → RiskAgent.assessRisk (always forwards)
  → RiskEngine.evaluateRisk (serialized)
  → RISK_ASSESSMENT_COMPLETED approved
  → OMS.executeOrder
       insert PENDING (unique traceId)
       classify broker PAPER/LIVE/UNKNOWN — UNKNOWN rejects
       activeBroker.placeOrder({ clientOrderId: local order UUID })
  → fills / P&L on SELL
  → PortfolioMonitor / thesis invalidation SELL ideas (same path)
  → PortfolioReconciliation vs broker
```

OpenAlice, if enabled, does **not** block this path.

---

## 6. All Order Paths

Production TypeScript `.placeOrder(` (non-test):

| File | Role |
|---|---|
| `src/server/services/OrderManagement.ts` (~line 302) | **Only OMS production submit** |
| `src/brokers/AlpacaBroker.ts` | Adapter |
| `src/brokers/InternalPaperBroker.ts` | Adapter; `closePosition` calls `this.placeOrder` |
| `src/brokers/InteractiveBrokersAdapter.ts` | Adapter; `closePosition` may call `this.placeOrder` |
| `src/brokers/CoinbaseBroker.ts` | Adapter; `closePosition` may call `this.placeOrder`; **refuses paper** |

`server.ts` does not call `.placeOrder(`. SPA does not. Research engines set `canPlaceOrders: false`.

| Order Path | Source | Destination | RiskEngine? | OMS? | Broker? | Bypass controls? | Risk |
|---|---|---|---|---|---|---|---|
| A Sacred path | Agents + ChiefTrader | OMS | Yes | Yes | Yes | No | Baseline |
| B Manual override | `POST /api/v2/trading/execute-override` | `CHIEF_APPROVED_IDEA` | Yes | Yes | Yes | Bypasses **ChiefTrader consensus only**. BUY still `autobot_enabled`. Needs live price. | Operator can force a proposal |
| C Pipeline flatten | `submitPipelineSells` | `CHIEF_APPROVED_IDEA` SELL | Yes | Yes | Yes | Skips consensus; still RiskEngine | Intended for flatten |
| D Broker `closePosition` | Adapter internal | Same adapter `placeOrder` | Only if invoked **from OMS/HTTP that used pipeline** | If OMS called close | Yes | **HTTP handlers must not call closePosition** (PipelineFlatten comment). Direct adapter close would bypass RiskEngine | High if a future route calls adapter close |
| E Questrade | Any | throws | N/A | Would fail | No | Cannot place | — |
| F GET `/api/v1/signals` | Legacy | HTTP 410 | N/A | No | No | Quarantined | Was a bypass; now dead |
| G Research/VectorBT/Python | CLI | No broker | No | No | No | Forbidden | — |
| H Tests | Vitest | Stubs | Mixed | Mixed | Stub | Test-only | Do not count as paper |

**ChiefTrader bypass:** Paths B and C. **RiskEngine bypass for fills:** not found on production HTTP. **OMS bypass:** not found.

---

## 7. BUY Decision Pipeline

1. **Trigger:** MARKET_DATA only if Autobot on + `TRADING_ENABLED` (`ideaGenerationGate.ts`, `MarketDataWorker.ts` ~93).
2. **Agents:** Technical (RSI/MACD/BB); Quant only if env; Fundamental/Macro timers; News **does not emit trade ideas** when `deskIntelligence.newsEmitsTradeIdeas` is false.
3. **Confidence:** Agent-stated 0–1; ChiefTrader `calibrateConfidence` uses `agent_confidence_calibration` or **raw** if no row.
4. **Consensus:** `EvidenceAggregator`; `minIndependentAgreeingAgents` **2** (ConsensusDebate does not count); `consensusApprovalThreshold` **0.75**; HOLD from debate or BearResearcher can veto; Quant AI contradiction can veto **without overwriting side**.
5. **LLM:** Optional debate if confidence > `debateTriggerConfidence` **0.6**. Debate failure: log + still `evaluateConsensus` (**debate fail-open**; order still needs 2 agents + bar).
6. **Bull/Bear:** Off unless `QUANT_BULL_BEAR_ENABLED`. Numerics nulled (`parseResearchNote.ts`).
7. **News veto:** RiskEngine, direction-blind, clusters `impactScore` mapped > `newsVetoMinImpactScore` **80**, window 4h.
8. **Price:** `price_validity` requires finite `proposal.currentPrice` > 0. Override requires `marketDataWorker.getLatestPrice`.
9. **Sizing:** `calculatePositionSizing` — FIXED_DOLLAR default cap `maxTradeSize` or `defaultMaxTradeSizeDollars` **3000**; risk `accountEquity * riskPct / (price * 0.05)`; whole shares `Math.floor`; **no fractionals**; **no shorts** as new positions (SELL needs existing qty).
10. **Submit:** OMS after approval.

**BUY with Autobot OFF:** ChiefTrader drops entry ideas; RiskEngine `autobot_enabled` fails BUY; MarketDataWorker does not emit. Override BUY still hits `autobot_enabled` → **no new BUY**.

---

## 8. SELL Decision Pipeline

| Mechanism | Path | Autobot OFF? |
|---|---|---|
| PortfolioMonitor TP/trailing/thesis invalidation | TRADE_IDEA_GENERATED as risk-exit → ChiefTrader `isRiskExit` skips debate → RiskEngine | **SELL still allowed** if `TRADING_ENABLED` |
| Quant stop/target on persisted quant fields | PortfolioMonitor | Same |
| Emergency flatten | PipelineFlatten → CHIEF_APPROVED_IDEA SELL | Yes (RiskEngine) |
| Recon flatten | Only if `autoFlattenOnReconciliationMismatch` **true**; default **false** | Pause still happens |
| Manual override SELL | execute-override | Yes |
| `sell_position_exists` | RiskEngine | Blocks SELL with no broker position |

**BUY Autobot OFF: blocked. SELL Autobot OFF: allowed** (by design).

---

## 9. RiskEngine Forensic Audit

**File:** `src/server/engines/RiskEngine.ts` `evaluateRiskSerialized`.  
**Catalog:** `config/riskGateOrder.json` is **UI order only** (file comment). Pass/fail = recorded gates.

All gates recorded except **early return** on invalid equity (later gates not run that cycle).

| Gate | Condition (actual) | Fail | BUY/SELL | Paper/Live | Fail-open/closed | Cosmetic? | Tests |
|---|---|---|---|---|---|---|---|
| emergency_stop | `tradingState === TRADING_ENABLED` | Pause/EMERGENCY_STOP | Both | Both | Closed | No | gates + recon |
| autobot_enabled | BUY requires `enabled === true` | Blocks BUY | BUY only | Both | Closed | No | gates |
| same_symbol_cooldown | BUY; last FILLED age | Config ms | BUY | Both | Skip if SELL or cooldown 0 | No | OvertradingGuards |
| post_loss_cooldown | BUY after losing SELL | Config | BUY | Both | Skip SELL | No | same |
| daily_trade_limit | BUY count | Config | BUY | Both | Skip SELL | No | same |
| duplicate_signal | Recent risk_assessments | Window | BUY typically | Both | — | No | same |
| invalid_account_equity | `isPositiveFiniteMoney(portfolio.equity)` | Missing/≤0 | Both | Both | **Closed; no placeholder** | No | AccountEquity tests |
| daily_loss | NY-session equity vs day start; trip at **0.8** of daily limit; LIVE clamped | Block | Both | Live tighter | Closed | No | restrictedLive |
| consecutive_loss | Last **3** FILLED with P&L all < 0 | Block | Both | Both | Closed if history | Needs 3 closed | gates |
| portfolio_drawdown | vs persisted `peakEquity`; default **15%** | Block | Both | Both | Closed | Peak persist fail logs | gates |
| order_rate_limit | Count **assessments** last 60s vs `maxOrdersPerMinute` default **5** | Block | Both | Both | Closed | Counts rejects too | concurrency |
| market_hours | Alpaca clock; no keys → **unconfigured skip (PASS)**; keys+HTTP fail → **unavailable FAIL** | Block | Both | Skip only if no keys | Closed if keys | Paper tests rely on skip | clock tests |
| data_freshness | age > **300000** ms | Block | Both | Both | **PASS if never ticked** | Honesty gap | stale tests if any |
| news_veto | High-impact cluster on symbol | Block | Both | Both | Closed if cluster exists | Direction-blind | news tests |
| price_validity | finite price > 0 | Block | Both | Both | Closed | No | gates |
| order_notional_cap | Records binding info | **Always passed: true** | BUY sizing | Both | N/A | **Recorded PASS always** | sizing tests |
| symbol_concentration | Clamps to 20% equity | Always passed: true | BUY | Both | Clamp | Same | sizing |
| open_positions_cap | New symbol vs max (LIVE max 3) | Can fail | BUY | Live tighter | Closed | No | restrictedLive |
| sector_concentration | Clamp 40% if in `SECTOR_MAP` else skip PASS | Always passed: true | BUY | Both | Unknown symbols skip | Map incomplete | sizing |
| correlation_exposure | Clamp 50% if history; skip PASS if no closes | Always passed: true | BUY | Both | **Skip PASS no history** | Honesty + fail-open skip | sizing |
| sufficient_size | `maxQuantity > 0` | Fail | Both | Both | Closed | Real fail | sizing |
| sell_position_exists | SELL only | No shares | SELL | Both | Closed | BUY omitted | gates |
| argus_capital_allocation | `settings.budget` vs reserved | Fail | BUY | Both | Closed | Distinct from broker equity | capital tests |
| daily_buy_notional | Paper cap **0 = unlimited**; LIVE **15000** | Fail | BUY | Live | Closed | Paper unlimited notional | DailyBuyNotional |

**Known bypass / misreport:** concentration/correlation/notional **PASS** while `sufficient_size` FAIL.  
**Config disable:** cooldown `<= 0` skips; `maxDailyBuyNotionalDollars: 0` disables paper daily notional. **Defaults are generally conservative except unlimited paper daily buy notional and 5-minute staleness and never-seen tick PASS.**

Restricted live (`RestrictedLiveMode.ts`): LIVE only, clamps max order **$5000**, open positions **3**, daily loss **$1000**. Not profitability.

---

## 10. Position Sizing Audit

| Item | Source | Finding |
|---|---|---|
| Account equity | `broker.portfolio().equity` | LIVE: must be real positive or NO TRADE |
| Buying power | broker; 0 if invalid | Caps shares |
| Argus allocation | `settings.budget` | Separate ceiling |
| InternalPaper seed | `internalPaperDefaultCash` **100000** | **Not** live equity; easy to confuse with buying power |
| Max order | FIXED_DOLLAR **$3000** default often binds before 20% concentration | |
| Stop model | `stopLossAssumptionPct` **5%** | **Not ATR** |
| Kelly / EV | Quant idea suppression only | **Not RiskEngine size** |
| Leverage / options / shorts / fractionals | Not supported as live product | Whole shares; long-only new positions |
| Race | evaluateRisk serialized | OMS unique `traceId` |

Over-allocation vs broker: allocation guard + equity fail-closed. Duplicate: unique index `idx_trades_trace_id_unique` (NULL traceIds **not** unique in SQLite).

---

## 11. Broker Audit

| Broker | placeOrder | Paper | Live | Auth | Notes |
|---|---|---|---|---|---|
| InternalPaperBroker | Yes (sim) | Yes | No | Local | Default active; in-memory fills; seed $100k |
| Alpaca | REST `/v2/orders` | paper-api | api.alpaca.markets | Key/secret; `authenticate` honors `isLive` | Timeouts, retries **idempotent only**, circuit breaker, `client_order_id`. **Not live-account verified in this audit.** Unattended US equities **code**. |
| IBKR | Gateway Client Portal | DU* | U* | Session + **2FA ~24h** | `requiresManualReauth`; `canadianEquities: false`; User-Agent required |
| Coinbase | Advanced Trade | **placeOrder refuses paper** | Possible if LIVE confirmed | CDP JWT | **Not funded-account verified** |
| Questrade | **throws** | Read-only OAuth | Cannot be order broker | Refresh token | `NON_FUNCTIONAL_BROKER_IDS` |

BrokerManager will not select Questrade as order-placing broker.

---

## 12. OMS Audit

`OrderManagement.ts`: PENDING insert before broker; `clientOrderId = order UUID`; unique `traceId`; poll fill; follow-up bounded (`omsFollowUpMaxAgeMs` 30 min); crash recovery for PENDING without broker id; unmatched inbound fills `EXTERNAL_MANUAL`; env stamp in **reasoning** (no `executionEnvironment` column on `trades`); PAPER/LIVE/UNKNOWN gate before `placeOrder`.

Restart: unique traceId prevents duplicate **same trace**; crash recovery must not blindly POST without lookup (Alpaca GET-by-client-id path exists in comments/tests). **This DB’s 6 PENDING diagnostic BUYs** show rows can remain non-terminal.

Fees/slippage on live fills: **broker-reported**; not a research cost model.

---

## 13. Portfolio Reconciliation

Compares local vs broker positions, open orders, approximate cash/equity (`PortfolioReconciliation.ts`). Significant mismatch (~$100): emit `RECONCILIATION_MISMATCH`, `setTradingState('TRADING_PAUSED')` → RiskEngine `emergency_stop`. Optional flatten flag **default false**. Persist `reconciliation_events`. Broker is treated as remote truth for mismatch, not “Argus always wins.”

---

## 14. Market Data Audit

Live path: Alpaca WS via MarketDataWorker when keys exist. REST bars via `HistoricalDataGateway` / `ohlcv_bars`. Stale: 5 minutes if a tick was seen. Clock: Alpaca `/v2/clock`. No L2. No corporate-action engine on the live tick path (**UNAVAILABLE** as a complete CA system). Research ingest: Alpaca historical, no fabricate (`ingestAlpacaWarehouse.ts`). **Look-ahead:** SAME_BAR_CLOSE backtest is optimistic vs live market orders.

---

## 15. Strategy Inventory

| ID | Class | Live `evaluateAll` | Status |
|---|---|---|---|
| MOMENTUM_BREAKOUT | CORE | Default (Quant off globally) | **UNTESTED** |
| PULLBACK_CONTINUATION | CORE | Default | **UNTESTED** |
| MEAN_REVERSION | CORE | Default | **UNTESTED** |
| TREND_FOLLOWING | CORE | Default | **UNTESTED** |
| RANGE_REVERSION | CORE | Default | **UNTESTED** |
| SMC_LIQUIDITY_SWEEP | Experimental | Only `QUANT_SMC_STRATEGY_ENABLED=true` | **UNVALIDATED** |
| VWAP/ORB/Donchian/MA/oscillators/etc. | Experimental family | Per `quantExperimentalStrategies.json` env | **UNVALIDATED**; do not enable to “see” |
| GOLDEN_SMA | Research fixture | No | UNIT_FIXTURE |

`QUANT_ENGINE_ENABLED` default **off** → CORE do not emit live Quant ideas.

---

## 16. Strategy-by-Strategy Analysis

All CORE: long-oriented `evaluate(ctx)` on daily-bar features; off-regime confidence × **0.5**; live fill = market order via OMS **not** next-bar open. Research canonical = T+1 open. **Mismatch vs paper/live execution.** Stops in Quant thesis are PortfolioMonitor numbers, not broker native stop orders (OMS places **MARKET**).

SMC: pattern module; live excluded unless env; backtest long-only so bearish sweeps do not short.

---

## 17. Backtest Audit

`BacktestEngine`: fill at **currentBar.close** × slippage (`SAME_BAR_CLOSE`). Shared `PositionSizing` math with live (good). Commission helpers exist for this engine. **Look-ahead / same-bar leakage: YES relative to canonical NEXT_BAR_OPEN.** Intrabar stop/target ambiguity on same bar: inherent.

`canonicalNextBarEngine.ts`: signal T, fill T+1 open; `promotable: false` always in type; `canPlaceOrders: false`; zero costs → cannot `backtestPass`.

**ENGINE_MISMATCH** if SAME_BAR PnL used as NEXT_BAR evidence.

---

## 18. OOS Audit

Code/routes exist. **No GREEN REAL_MARKET_DATA OOS result files** in this checkout. Golden SMA ≠ OOS. Vitest ≠ OOS. **OOS-VALIDATED STRATEGIES: 0.**

---

## 19. Walk-Forward Audit

`coreWalkForward.ts` / WalkForwardValidator exist. Quarantine claim on `WALKFORWARD_CHECK_RESULTS.json` (SAME_BAR / cherry-pick) must stand until a CORE NEXT_BAR artifact exists. **WFO-VALIDATED: 0.**

---

## 20. Robustness Audit

`coreRobustness.ts` exists. **No persisted real-data robustness ledger. ROBUSTNESS-VALIDATED: 0.** Classify **UNTESTED** not FRAGILE (FRAGILE requires a failed robustness run).

---

## 21. Research Warehouse Audit

Filesystem: `data/research` **UNAVAILABLE**. Dataset on disk for promotion: **NONE**. Fixture: `fixtures/research/golden_sma.json` only. Ingest requires Alpaca keys; does not invent bars. Quality grades implemented in `dataQuality.ts` (not exercised on a warehouse here).

---

## 22. Organic Paper Evidence

**DATABASE (`data/argus.db`, read-only 2026-08-16):**

| Metric | Value |
|---|---|
| `trades` rows | 6 |
| FILLED SELL with `profit_loss` | **0** |
| `executionEnvironment=PAPER` in reasoning | **0** |
| Status/side | 6× PENDING BUY |
| Symbols | DIAGTEST* / DIAGPIPE* / DIAGORDER* (diagnostic) |
| Organic closed paper (`isOrganicClosedPaper`) | **0** |
| Sessions | **0** |
| Expectancy / Sharpe | **INSUFFICIENT_SAMPLE / NONE** |

**ORGANIC PAPER EVIDENCE = NONE.** Do not count Vitest OMS fills.

---

## 23. AI / LLM Audit

All LLM via `AIRouter`. Timeouts `aiProviderTimeoutMs` 20000. Debate confidence for ConsensusDebate is **config `debateResultConfidence` 0.8**, not a calibrated probability. Calibration lookup fail → **raw confidence**. Hallucinated prices in Bull/Bear **nulled**. LLM **cannot** `placeOrder`. LLM outage: debate skipped; Technical can still propose; Quant may not emit; **no LLM-forced order**. `AIFailureCircuitBreaker` can pause live after repeated failures (config). ExplainabilityAgent is narrative, not the fill path. MarketRegimeAgent **not a voter** on the sacred path.

---

## 24. News / Fundamental / Macro

News: RSS + optional Finnhub/FMP/etc. Veto is **RiskEngine**, not a BUY vote when `newsEmitsTradeIdeas` is false. Fundamental/Macro: AIRouter on fundamentals/macro timers; they **can** emit ideas when Autobot on. Stale news cluster can veto 4h. Historical “44.6% news accuracy” is **not re-measured this audit** → treat as **UNAVAILABLE** now, not a current score.

---

## 25. Autonomy Audit

| Horizon | Verdict |
|---|---|
| 1 hour paper Autobot on | **CONDITIONAL** — process must stay up; InternalPaper or Alpaca paper |
| 1 day | **CONDITIONAL** — clock, WS reconnect, recon |
| 1 week / 1 month unattended | **NO-GO** — IBKR 2FA, no 30-day evidence, orphaned PENDING in this DB, no organic paper stability |
| Human required | LIVE phrase, broker 2FA, secrets, recon incidents, Autobot toggle, Canadian legal |

---

## 26. Failure Injection Audit

| Scenario | Expected | Actual (code/tests) |
|---|---|---|
| Broker timeout | No silent duplicate | Alpaca client_order_id + OMS recovery; tests |
| Broker 500 / circuit | Fail closed | Alpaca circuit breaker |
| Duplicate trace | One row | Unique index + OMS skip |
| Partial fill | Aggregate fills | OMS lifecycle tests |
| Stale price (known tick) | Block | data_freshness |
| Never-seen tick | Should be conservative | **PASS freshness** — gap |
| Missing equity | Block | invalid_account_equity |
| Clock outage with keys | Block | unavailable |
| Clock unconfigured | Skip hours | Paper tests |
| LLM malformed JSON | No invented prices | parseResearchNote / validators |
| LLM hallucinated price | Null numerics | parseResearchNote |
| Recon mismatch | Pause | tradingBlock test |
| Autobot off BUY | Block | Multiple |
| LIVE + paperMode | Reject | brokerEnvironment tests |
| DB lock | SQLite busy | Partial; not full chaos |
| Disk full | Unknown | **UNAVAILABLE** |
| Market halt | Unknown native | **UNAVAILABLE** as halt API |

---

## 27. Concurrency Audit

RiskEngine **serialized** `evaluationQueue`. OMS unique `traceId`. EventBus is Node EventEmitter (same process). Concurrent override + consensus both hit RiskEngine FIFO. TOCTOU on drawdown/order-rate **addressed by serialization**. Residual: two different **traceIds** can still submit two orders if both pass gates (by design).

---

## 28. Database Audit

WAL SQLite. Unique `trades.trace_id` (NULLs distinct). Risk/OMS/recon/event traces persist. `executionEnvironment` **not a column** — stamped in `reasoning`. Diagnostic PENDING rows in this DB **survived restart** (state survives, quality of that state is dirty). Backup: export-db routes exist (not exercised this audit). `npm run db:migrate` now re-imports boot migrator — still prefer boot import as source of truth.

---

## 29. Security Audit

- Production `NODE_ENV=production` without `AUTH_PASSWORD`: **fatal exit** (`enforceAuthConfigOrExit`, `server.ts` ~395).
- Auth on: session cookie; WS requires session when password set (`server.ts` ~1629).
- Auth off (dev): mutating `/api/v1|/api/v2` need loopback or `X-Argus-Dev-Token`; **GET remains open**; **dev token printed to logs**.
- EncryptionService AES-256-CBC; fail-closed.
- execute-override is a **real order proposal** if authenticated — attacker with session can skip consensus, not RiskEngine.
- No LLM code exec. Research import forbids `placeOrder` keys (claimed in prior work; research tests exist).

**LIVE NO-GO independent of security score.**

---

## 30. UI Honesty Audit

SPA `src/App.tsx` + components. Login early-return **after** most hooks (effects still run).

| Surface | Honesty |
|---|---|
| DigitalTwinVisualizer | REAL EventBus; idle = idle |
| AgentFocusMode | REAL internals |
| Multi-Agent Dialogue Graph | `AwaitingSignal` / not live accuracy |
| AgentWorkflowTheater | File exists; historically unmounted — **do not treat as ticks** |
| AutoBotFlowVisualizer / legacy cycle | **NOT** EventBus fill path |
| Research Lab / Scanner | Capability; **not** edge |
| L2 | Must stay unavailable — no source |
| Live-readiness API | Honest LIVE_NO_GO if wired in UI |
| Documentation tab | Can drift vs RiskEngine ATR comments |

Operator could still **misread** InternalPaper $100k, Research Lab, or agent confidence as LIVE-ready. **UI THEATER** where labeled `AwaitingSignal` is honest; unlabeled charts **untrusted**.

---

## 31. Testing Audit

**This session (2026-08-16):**

| Command | Result |
|---|---|
| `npx tsc --noEmit` | **PASS** |
| `npx vitest run` | **1011 passed / 1011 total**, **154 files**, ~109s |
| Coverage | **UNAVAILABLE** (not collected) |
| Playwright e2e | **NOT RUN this audit** (`e2e/moduleToggleParity.spec.ts` exists) |

Critical untested: SPA, funded Alpaca LIVE, IBKR Gateway 2FA expiry, Canadian legal, 30-day soak, GREEN warehouse CORE OOS.

---

## 32. Observability Audit

Can reconstruct a **pipeline** trade if: EventBus/`event_traces`, `consensus_*`, `risk_assessments` + `risk_gate_results`, OMS `trades`/`fills`, broker id. Quant extras if Quant-sourced. **Cannot** claim every UI trade is reconstructable. Diagnostic PENDING rows in this DB have RiskEngine-style reasoning but are **not** closed P&L.

---

## 33. Latency / Cost Audit

Not measured at runtime this audit. Config: Alpaca timeout 15s; AI 20s; Quant cycle 5 min. Debate adds LLM latency **before** consensus. Live orders are **market** — latency vs next-bar research is a **material execution mismatch**. AI $: `estimateCost` in AIRouter; local Ollama $0. **UNAVAILABLE** as a production cost report.

---

## 34. Canadian Trading Considerations

**Not legal advice.** Technical facts: `markets.json` CA `automatedOrderRouting` unavailable; IBKR/Questrade/Alpaca/Coinbase/InternalPaper all `canadianEquities: false`; Questrade cannot place; IIROC 3200A.1(b)(i) cited in adapter comments. Flipping flags does **not** create legal permission. **LIVE = BLOCKED** for Canadian automated routing until a lawyer/broker confirms a permitted path.

---

## 35. Production Deployment Audit

`ecosystem.config.cjs` exists (PM2). Docker **not verified** as complete LIVE. TLS/firewall/log rotation: **operator**, not proven. Secrets in `.env` (gitignored). Backup export-db. Port 3000. **NOT** a certified production LIVE deployment.

---

## 36. Trading Edge Score

**8/100.** `src/server/research/edgeScore.ts`: UNTESTED / non-REAL provenance → 8. Awarded **only** because that is the honest empty-evidence band, not because architecture exists.

No points for VectorBT, golden SMA, vitest, or UI.

---

## 37. Strategy Lifecycle Matrix

Promotion derived from evidence booleans (`promotionEngine.ts`); cannot assign VALIDATED by hand.

| Strategy | Version | Data hash | Exec model | Provenance | Lifecycle |
|---|---|---|---|---|---|
| MOMENTUM_BREAKOUT | spec in `strategySpecs` / hash if frozen | UNAVAILABLE | NEXT_BAR canonical vs SAME_BAR engine | UNKNOWN / no GREEN set | **UNTESTED** |
| PULLBACK_CONTINUATION | same | UNAVAILABLE | same | same | **UNTESTED** |
| MEAN_REVERSION | same | UNAVAILABLE | same | same | **UNTESTED** |
| TREND_FOLLOWING | same | UNAVAILABLE | same | same | **UNTESTED** |
| RANGE_REVERSION | same | UNAVAILABLE | same | same | **UNTESTED** |
| SMC_LIQUIDITY_SWEEP | experimental | UNAVAILABLE | N/A live | N/A | **UNVALIDATED** |
| Experimental family (14 others) | env-gated | UNAVAILABLE | N/A | N/A | **UNVALIDATED** |

No `MANUAL_LIVE_APPROVED`. `liveGoNoGo(emptyEvidence)` = **NO-GO**.

---

## 38. P0 Blockers

| ID | Sev | File | Problem | Why | Evidence | Blocks LIVE | Blocks PAPER plumbing |
|---|---|---|---|---|---|---|---|
| P0-1 | P0 | warehouse / DB | No GREEN REAL_MARKET_DATA | Cannot promote | `data/research` missing | Yes | No |
| P0-2 | P0 | `data/argus.db` | Organic paper 0 | Promotion paper gates | SQL counts | Yes | No (plumbing ok) |
| P0-3 | P0 | `researchSafety.json` | Zero costs | `backtestPass` blocked | JSON 0/0/0 | Yes | No |
| P0-4 | P0 | `BacktestEngine.ts` vs canonical | ENGINE_MISMATCH | Wrong fill model for promotion | SAME_BAR vs NEXT_BAR | Yes if mixed | No |
| P0-5 | P0 | `canadianReadiness.ts` | Routing NOT_AVAILABLE | Legal/tech | Code | Yes (CA live) | No |
| P0-6 | P0 | Operator | No manual LIVE approval evidence | Required | emptyEvidence.manualLiveApproval false | Yes | No |
| P0-7 | P0 | CORE evaluate | UNTESTED | No OOS/WFO/robust | emptyEvidence | Yes | No |

---

## 39. P1 Blockers

| ID | File | Problem | PAPER validation |
|---|---|---|---|
| P1-1 | `PositionSizing.ts` | Gates always PASS while clamping | Honesty of risk UI |
| P1-2 | `RiskEngine.ts` data_freshness | Never-seen tick PASS | Use only with real ticks / Autobot |
| P1-3 | `tradingSafety.json` | Paper daily buy notional 0 = unlimited | Can overtrade paper |
| P1-4 | OMS MARKET only | No native broker stop | Exit via PortfolioMonitor ideas |
| P1-5 | `ExpectedValue.ts` comments | Claim ATR; false | Confusion |
| P1-6 | This DB PENDING DIAG* | Orphans | Cleanup before paper study |
| P1-7 | SPA tests | Almost none | Operator error |
| P1-8 | Auth off GET | Info leak if bound to LAN | Bind localhost + AUTH_PASSWORD |

---

## 40. P2 Improvements

Observability metrics; halt API; L2 honesty already; coverage reports; funded-account chaos; IBKR 2FA runbook rehearsal; UI copy “click node” drift; `ARGUS_DEV_TOKEN` log hygiene; persist `executionEnvironment` column.

---

## 41. Exact Remediation Roadmap

**P0-1 warehouse**  
PROBLEM: No GREEN dataset.  
REMEDIATION: Ingest Alpaca with keys; grade RAW then clean; persist hash.  
ACCEPTANCE: Sidecar with GREEN + REAL_MARKET_DATA; no fabricated bars.

**P0-2 organic paper**  
PROBLEM: 0 closed PAPER SELL P&L.  
REMEDIATION: Autobot ON, paper broker, RiskEngine/OMS, organic filter, ≥30/10 plus expectancy gates.  
ACCEPTANCE: `isOrganicClosedPaper` count ≥ floors; DIAG traces excluded.

**P0-3 costs**  
PROBLEM: 0 commission/spread/slippage.  
REMEDIATION: Reviewed non-zero JSON; re-run canonical; still fail if edge dies.  
ACCEPTANCE: `isTheoreticalZeroCost()===false`; cost-stress.

**P0-4 ENGINE_MISMATCH**  
PROBLEM: SAME_BAR vs NEXT_BAR.  
REMEDIATION: Promote only canonical NEXT_BAR artifacts; quarantine SAME_BAR PnL.  
ACCEPTANCE: Promotion rejects engineMismatch.

**P0-5 Canada**  
PROBLEM: No automated live routing.  
REMEDIATION: Legal/broker confirmation — **not** a flag flip.  
ACCEPTANCE: Written approval; still `canadianEquities` false until then.

**P1-1 gate honesty**  
PROBLEM: concentration PASS with qty 0.  
REMEDIATION: Fail the binding gate when clamp forces 0.  
ACCEPTANCE: Tests show `symbol_concentration` failed not only `sufficient_size`.

**P1-2 freshness**  
PROBLEM: null age PASS.  
REMEDIATION: Fail closed if no tick age for the symbol.  
ACCEPTANCE: Test with empty MarketDataWorker.

---

## 42. Required Acceptance Tests

Already present (do not weaken): OMS unique traceId; autobot BUY; invalid equity; recon pause; broker UNKNOWN; live-readiness LIVE_NO_GO; fill-path scan; Questrade throw; Coinbase paper refuse.

Missing for LIVE: funded broker chaos; organic paper ledger test against **real** DB snapshot; GREEN warehouse CORE OOS/WFO/robustness **fail or pass honestly**.

---

## 43. Final PAPER GO/NO-GO

| Mode | Verdict |
|---|---|
| Autobot **OFF**, paper, no new BUY | **GO** (safety) |
| Autobot **ON**, InternalPaper or Alpaca **paper**, flatten flag false | **CONDITIONAL GO** (infrastructure only) |
| Treat paper as proof of edge | **NO-GO** |

---

## 44. Final LIVE GO/NO-GO

**LIVE NO-GO.**

`evaluateLiveReadiness()` is designed so mandatory UNAVAILABLE/FAIL/BLOCKED ⇒ **LIVE_NO_GO**. Software tests passing does not change this.

---

## 45. What Must Be Proven Before LIVE

1. GREEN REAL_MARKET_DATA warehouse with hashes.  
2. Frozen CORE `strategyVersion` NEXT_BAR OOS **pass** with min sample (or honest FAIL).  
3. WFO median folds **pass** (not best fold).  
4. Robustness **ROBUST** not FRAGILE/FAILED.  
5. Non-zero costs; edge survives.  
6. Organic paper ≥ config floors + positive expectancy + recon vs research.  
7. Broker env LIVE independently confirmed; equity live; no UNKNOWN.  
8. Canadian/legal written if applicable — else stay US-only with counsel.  
9. Human `ENABLE LIVE TRADING` **after** LIVE_CANDIDATE — never auto.  
10. Staged capital (restricted-live caps are ceilings, not a green light).

Until then: **NO EDGE**, **UNTESTED**, **LIVE NO-GO**.

---

## 46. Evidence Appendix

| Finding | Type | File | Function/Line | Actual behavior | Confidence |
|---|---|---|---|---|---|
| Single OMS placeOrder | SOURCE_CODE | `OrderManagement.ts` | ~302 | Only production caller | HIGH |
| Signals path dead | SOURCE_CODE | `server.ts` | ~1227 | HTTP 410 | HIGH |
| 24 gates | CONFIG+CODE | `riskGateOrder.json` / `RiskEngine.ts` | evaluateRiskSerialized | Matches implementation with equity early-return | HIGH |
| Autobot BUY block | SOURCE_CODE | `RiskEngine.ts` | ~214–223 | BUY blocked | HIGH |
| SELL Autobot off | SOURCE_CODE | same + ChiefTrader isRiskExit | Exits proceed | HIGH |
| Equity fail-closed | SOURCE_CODE | `AccountEquity.ts` + RiskEngine ~267 | No placeholder | HIGH |
| Clock fail-closed | SOURCE_CODE | `readMarketClock` | unavailable ≠ open | HIGH |
| Freshness never-seen PASS | SOURCE_CODE | RiskEngine ~365–367 | null age not stale | HIGH |
| Concentration always PASS | SOURCE_CODE | `PositionSizing.ts` ~148–206 | passed: true | HIGH |
| Stop 5% not ATR | CONFIG | `tradingSafety.json` | stopLossAssumptionPct 0.05 | HIGH |
| Kelly unused in sizing | SOURCE_CODE | PositionSizing no import | Quant EV emit only | HIGH |
| NEXT_BAR canonical | SOURCE_CODE | `canonicalNextBarEngine.ts` | T+1 open | HIGH |
| SAME_BAR backtest | SOURCE_CODE | `BacktestEngine.ts` ~431, ~580 | close fill | HIGH |
| Zero costs | CONFIG | `researchSafety.json` | 0/0/0 | HIGH |
| Questrade no orders | SOURCE_CODE | `QuestradeBroker.ts` ~238 | throw | HIGH |
| Coinbase paper refuse | SOURCE_CODE | CoinbaseBroker header + tests | refuse | HIGH |
| Canadian blocked | SOURCE_CODE | `canadianReadiness.ts` | NOT_AVAILABLE | HIGH |
| Override skips Chief | SOURCE_CODE | `v2System.ts` ~636–659 | emit CHIEF_APPROVED_IDEA | HIGH |
| Unique traceId | SOURCE_CODE | `schema.ts` ~254 | uniqueIndex | HIGH |
| Organic paper 0 | DATABASE | `data/argus.db` | 6 PENDING BUY | HIGH |
| Warehouse missing | RUNTIME | `data/research` | absent | HIGH |
| tsc/vitest | TEST | this session | 1011/1011 | HIGH |
| News 44.6% | DOCUMENTATION | prior reports | **NOT RE-MEASURED** | LOW / UNAVAILABLE |
| Funded LIVE Alpaca | UNAVAILABLE | — | — | — |
| Edge 8 | SOURCE_CODE | `edgeScore.ts` | empty → 8 | HIGH |
| LIVE_NO_GO engine | SOURCE_CODE | `liveReadinessEngine.ts` | mandatory fails | HIGH |

---

*End of forensic audit. Implementation over documentation. LIVE NO-GO. NO EDGE. ORGANIC PAPER NONE.*
