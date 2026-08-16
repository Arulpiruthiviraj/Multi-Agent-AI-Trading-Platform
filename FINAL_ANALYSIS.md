# Argus Autonomous Trading Platform — FINAL ANALYSIS

**Audit date:** 2026-08-16 (forensic pass)  
**Audience:** Operator / engineer deciding paper vs live.  
**Method:** Current `.ts` / `.tsx` / `config/*.json`; read-only `data/argus.db`; `npx tsc --noEmit` (PASS); `npx vitest run` **1011/1011** (154 files).  
**Authoritative long-form:** `ARGUS_FINAL_FORENSIC_AUDIT.md` (do not trust older ARGUS_*.md as truth).  
**Not used as truth:** older markdown, VectorBT being installed, a busy Agent Network graph, or “the system should…”. Adding files does **not** raise scores.

Companions (implementation, not extra points):

| Doc | Use |
|---|---|
| `ARGUS_PHASE19_IMPLEMENTATION_REPORT.md` | Leak gates, CORE feature translation, warehouse ingest, PIT reconstruct |
| `ARGUS_PHASE18_*.md` | Provenance, Argus `evaluate()` replay, rejection catalog |
| `ARGUS_PHASE17_*.md` | Research VectorBT CLI, promotion engine, organic-paper filter |
| `ARGUS_PHASE16_IMPLEMENTATION_REPORT.md` | Desk overlay, extra BUY gates, event-memory 410 |
| `ARGUS_TRADING_EDGE_REPORT.md` | Edge score **8** |
| `ARGUS_REAL_MONEY_READINESS.md` | Scorecard (do not inflate) |
| `ARGUS_LIVE_CANDIDATE_CHECKLIST.md` | Promotion gates |
| `docs/ARGUS.md` / `CLAUDE.md` | Architecture contract. **This file wins** where ARGUS.md still says 18 gates or Autobot-off ticks reach TechnicalAgent. |

---

## 1. Executive verdict

| Question | Verdict |
|---|---|
| Ready for **real money (LIVE)**? | **NO-GO** |
| Ready for **paper plumbing** (InternalPaper / Alpaca paper)? | **CONDITIONAL GO** — pipes, not expectancy |
| Autobot **off** ⇒ no **new BUY** fills? | **GO** — RiskEngine `autobot_enabled` + ChiefTrader drop + no `MARKET_DATA` emit |
| Validated trading edge? | **NO** (score **8 / 100**) |
| Organic paper in this `data/argus.db` | **NONE** (6 PENDING diagnostic BUYs; 0 FILLED SELL P&L) |
| CORE strategies promotion status? | All **UNTESTED** |
| SMC live? | **UNVALIDATED**; env-gated off |
| Quant live cycle? | **Off** unless `QUANT_ENGINE_ENABLED=true` |
| VectorBT / Python / Rust can `placeOrder`? | **NO** (`canPlaceOrders: false`) |
| Canadian automated live routing? | **NOT AVAILABLE** (IIROC) |
| `npx tsc --noEmit` | **PASS** |
| `npx vitest run` (this pass) | **1011 passed / 1011 total** (154 files). Isolation: OpenAlice/Chronos/Ollama sockets mocked; VectorBT CLI skipped unless `ARGUS_TEST_ALLOW_VECTORBT=true` |

Argus is a **multi-agent trading terminal with a real fail-closed fill path**. It is **not** an elite discretionary trader and is **not** profitable because research libraries exist. Plumbing + research ≠ expectancy.

**One-line operator rule:** keep `tradingMode` PAPER; keep Autobot off unless you accept unattended paper orders through RiskEngine/OMS; never enable LIVE until organic paper + OOS/WFO **pass** on a named `strategyVersion` and you still approve manually.

---

## 2. What the system is

Single Node.js process: Express + Vite SPA (`src/App.tsx`) + raw `ws`. Package name `my-money-miner`. Listen port **3000** hardcoded (`PORT` unused). SQLite `data/argus.db` (WAL). LLM calls only through `AIRouter`.

**Live fill path (do not rewrite):**

```
Alpaca WS (MarketDataWorker) → MARKET_DATA  [only if Autobot on AND TRADING_ENABLED]
  → idea agents → TRADE_IDEA_GENERATED
  → ChiefTraderAgent.reviewIdea  [entry ideas ignored if Autobot off]
  → CHIEF_APPROVED_IDEA
  → RiskAgent → RiskEngine.evaluateRisk  (all gates recorded; first failure is reported)
  → OMS → BrokerManager.getActiveBroker().placeOrder
  → trades / fills
```

There is **no** second OMS. UI, Quant, News, Chronos, OpenAlice, Python, and Rust **cannot** place orders.

**Quarantined / not that path:**

- `GET /api/v1/signals` → HTTP **410** `SIGNALS_PATH_QUARANTINED`
- `POST /api/v1/llm/dual-verify-trade` → 410
- Event-memory theater `GET`/`POST` `/api/v1/event-memory*` → **410** `EVENT_MEMORY_QUARANTINED`

---

## 3. How a BUY happens (honest)

1. Autobot `enabled === true` and `tradingState === TRADING_ENABLED`.
2. An idea agent emits `TRADE_IDEA_GENERATED` with `{traceId, symbol, side, confidence, reasoning, agent, currentPrice?}`.
3. ChiefTrader: weights from `agent_performance_stats` (defaults `config/agentWeights.json`). Optional debate if confidence > `debateTriggerConfidence` (0.6). Min **2** independent agreeing agents. Weighted confidence vs `consensusApprovalThreshold` (**0.75** in `tradingSafety.json`). HOLD with confidence > 0 penalizes both sides. ConsensusDebate does **not** count as an independent agent.
4. `CHIEF_APPROVED_IDEA` → RiskEngine. **No live price ⇒ refuse.** Every gate is recorded. First failure in evaluation order is the reported rejection.
5. Whole-share `Math.floor(dollars / price)`. Alpaca `qty` only, never `notional`. No fractionals.
6. OpenAlice (if enabled) is fire-and-forget; it does **not** block the fill.

**SELL:** same path + `sell_position_exists`. PortfolioMonitor (~60s) emits SELL ideas (`PortfolioManager` / risk-exit agent). Risk-exits skip multi-agent debate. They **still** hit RiskEngine/OMS. Liquidate/`PipelineFlatten` emits ManualOverride `CHIEF_APPROVED_IDEA` (skips consensus, **not** RiskEngine). Rebalance: **501**.

`settings.budget` is Argus **allocation**, not broker equity. Enforced by `CapitalAllocation` + gate `argus_capital_allocation`. Example: broker $2000, budget $100 → $101 BUY fails allocation.

---

## 4. RiskEngine gate ladder

Catalog: `config/riskGateOrder.json` (**24** names). Pass/fail comes from `RISK_GATE_EVALUATED` / `risk_gate_results`, **not** from painting the JSON green. `sell_position_exists` is recorded on SELL only.

| Seq | Gate | Notes |
|---|---|---|
| 1 | `emergency_stop` | Also blocks `TRADING_PAUSED` |
| 2 | `autobot_enabled` | **BUY** only when Autobot off |
| 3–6 | `same_symbol_cooldown`, `post_loss_cooldown`, `daily_trade_limit`, `duplicate_signal` | BUY-only overtrading (Phase 16). `daily_trade_limit` **0** = unlimited |
| 7 | `invalid_account_equity` | No `equity \|\| 10000` |
| 8 | `daily_loss` | Kill-switch fraction `dailyLossKillSwitchFraction` (0.8 of daily limit). LIVE min $1000 via restricted-live |
| 9 | `consecutive_loss` | 3 |
| 10 | `portfolio_drawdown` | settings; fallback 15% from peak |
| 11 | `order_rate_limit` | settings; fallback 5/min |
| 12 | `market_hours` | Alpaca clock; skip if no keys; **fail-closed** if keys exist and clock HTTP fails |
| 13 | `data_freshness` | stale tick > `stalePriceThresholdMs` (5 min) |
| 14 | `news_veto` | `news_clusters.impactScore`, 4h, **direction-blind** |
| 15 | `price_validity` | |
| 16–21 | PositionSizing | `order_notional_cap`, concentration, `open_positions_cap`, correlation, `sufficient_size` |
| 22 | `sell_position_exists` | SELL only |
| 23 | `argus_capital_allocation` | `settings.budget` |
| 24 | `daily_buy_notional` | paper unlimited unless JSON > 0; LIVE uses `restrictedLiveMaxDailyBuyNotionalDollars` ($15k) |

Stop-per-share assumption in sizing: `stopLossAssumptionPct` **0.05**, **not ATR**. Kelly/EV can suppress **Quant ideas** only; RiskEngine does **not** size from Kelly.

**Restricted LIVE** (`RestrictedLiveMode.ts`, file-reviewed, not a UI knob): $5k order, 3 open positions, $1k daily loss. No-op in paper.

Do **not** add a second kill switch. `emergency-stop` / `TRADING_PAUSED` already exist.

---

## 5. Agents (who votes)

| Role | Source | Default |
|---|---|---|
| TechnicalAgent | RSI/MACD/BB | `MARKET_DATA` when idea-gen enabled; 50-tick warmup |
| NewsEngine | RSS + APIs + optional LLM | Timer; **does not** emit trade ideas unless `deskIntelligence.newsEmitsTradeIdeas` (default **false**) |
| Fundamental / Macro | AlphaVantage + AIRouter | Autobot 60s / 75s |
| QuantEngine | `StrategyEngine` CORE five | Off until `QUANT_ENGINE_ENABLED=true`. Live emit = `strategyIdea` only (no regime-only BUY) |
| KronosEngine | local Chronos | Ticks if `/health`; honest warning if down |
| PortfolioManager | TP / trail / thesis invalidation | ~60s **SELL** ideas |
| ChiefTrader / RiskAgent | Consensus / gates | Always constructed |

**Not live voters:** `MarketRegimeAgent` (LLM), `AdvancedQuantEngines` (telemetry only). **No classes:** SentimentAgent, OrderFlowAgent (UI names only).

NewsAgent last scored pass: **44.6% on 242 predictions**. News is **not** a default voter.

LLM providers with classes: Gemini, OpenAI, DeepSeek, Nvidia, OpenAI-compatible (Ollama). Extra env keys (Anthropic, Grok, …) may exist without a provider class. Bull/Bear (`QUANT_BULL_BEAR_ENABLED`) **nulls** LLM-invented prices/EV.

---

## 6. Brokers

| Broker | Reality |
|---|---|
| InternalPaperBroker | Default. Seed cash `internalPaperDefaultCash` = **$100,000**. Not broker equity. Not `maxTradeSize`. |
| Alpaca | Paper or live REST. Only fully unattended US-equity broker. IEX top-of-book (no L2). |
| IBKR | Client Portal Web API. Local Gateway + **human 2FA** ~24h. `canadianEquities: false`. |
| Questrade | Read-only OAuth. `placeOrder` throws. Never the order-placing broker. |
| Coinbase | Real Advanced Trade JWT. **`placeOrder` refuses in paper** (no sandbox). Not funded-account verified here. |

`PAPER_TRADING_ONLY` does **not** by itself force `BrokerManager` paper. Operator must keep `tradingMode === 'PAPER'`.

---

## 7. Quant, research, Phase 18–19

### CORE five (`StrategyEngine.ts`)

`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`.

Live `evaluateAll()` is these five. SMC (`SMC_LIQUIDITY_SWEEP`) only if `QUANT_SMC_STRATEGY_ENABLED=true` at **call time**. `findStrategy(id)` still finds experimental for **backtest** without the live flag.

Phase 19: CORE VectorBT adapters are **`FEATURE_TRANSLATION`** of BOS / RVOL / Keltner / swing S/R (`python/argus_research/core_features.py` + `coreParityVectors.ts`). **Not** an SMA proxy. **Not** byte-identical RegimeEngine/DMI/MACD/CMF. **Not** an edge. Status **UNTESTED**. SMC stays `PROXY_NOT_FEATURE_PARITY` / **UNVALIDATED**.

`BacktestEngine.runStrategyBacktest` is long-only and uses a **same-bar** fill model. Research replay uses **NEXT_BAR_OPEN**. Do not paper over `ENGINE_MISMATCH` by picking the better PnL.

Golden SMA fixture = **determinism** (signal at T uses closes through T; execute next open). It is **UNIT_FIXTURE**, not CORE OOS, not `BACKTEST_PASS` for promotion.

### Warehouse

`scripts/ingest_research_warehouse.ts` can fetch 1m/5m/15m/1h/1D from Alpaca REST for `markets.json` US benchmarks. `cleanOhlcv` drops invalid bars. Parquet write **only if** `ResearchDataQualityEngine` grade is **GREEN**. No keys ⇒ no bars fabricated. Empty `data/research/*.parquet` = **UNAVAILABLE**, not a fake SPY book.

### PIT LLM

`debateReplayed: true` **only** when stored `ai_calls` has prompt **and** `rawResponse` with `createdAt <= asOfMs` **and** a matching `news_clusters` row. Otherwise false. Empty PIT ledger ⇒ `allowBuy: false` (unless explicit technical-only option — labeled TECHNICAL_BACKTEST, not AI consensus).

### Promotion

`promotionEngine.ts` **derives** status. `LIVE_CANDIDATE` needs data quality, backtest, OOS, WFO, robustness, organic paper floors (`minTradesForPaperValidation` = 30; `minPaperSessions`), risk/ops health, Canadian approval if CA, then **manual** `LIVE_APPROVED`. None of those evidence flags are true for CORE today.

Organic paper: `executionEnvironment=PAPER` FILLED **SELL** with P&L. UNKNOWN / BACKTEST / REPLAY / test traces / REJECTED do **not** count. This pass **did not** query `data/argus.db` — **do not invent** a closed-trade count.

---

## 8. Capital labels (do not confuse)

| Label | Source | Typical |
|---|---|---|
| `paperInitialCapital` | `tradingSafety.internalPaperDefaultCash` | $100,000 InternalPaper seed |
| `defaultMaxTradeSizeDollars` | `tradingSafety.defaultMaxTradeSizeDollars` | $3,000 order-notional **fallback** when settings unset |
| `argusAllocationBudget` | `settings.budget` | Argus allocation, not equity |
| `researchInitialCapital` | `researchSafety.goldenInitialCapital` | $10,000 golden fixture |
| `brokerEquity` | live broker | **null** when unavailable — never 10000 |

`GET /api/v2/research/capital-labels` returns these explicitly.

---

## 9. Autobot-off behavior (Phase 19)

| Module | Autobot off |
|---|---|
| MarketDataWorker | Caches last quote; **no** `MARKET_DATA` EventBus emit |
| Technical / Kronos / AdvancedQuant | No tick ingest / no ideas (also gated by `isLiveIdeaGenerationEnabled`) |
| ChiefTrader | Drops stray **entry** ideas before LLM |
| Fundamental / Macro | No ideas |
| QuantSignalAgent | May persist assessments; no ideas unless Autobot on **and** EV + min R:R |
| NewsEngine | `NEWS_CATALYST` only unless `newsEmitsTradeIdeas` |
| PortfolioMonitor | **Still emits SELL** (exits) through RiskEngine |
| RiskEngine BUY | Fails `autobot_enabled` |

`docs/ARGUS.md` still says Autobot-off ticks can drive Technical if `TRADING_ENABLED`. **Code:** emit is gated. Trust this file.

---

## 10. Scorecard (evidence-gated; not raised for more files)

From `ARGUS_REAL_MONEY_READINESS.md`. Phase 19 did **not** move these numbers.

| Area | Score | Why it is not 100 |
|---|---|---|
| Software | 78 | tsc/vitest strong; SPA almost untested |
| Execution | 55 | Path is real; IBKR 2FA; Questrade cannot place; Coinbase paper refuses |
| Risk | 72 | 24 recorded gates; still no L2; stop model is 5% not ATR |
| AI | 40 | Debate conf ≠ calibrated win rate; news 44.6%; PIT only if logs exist |
| Quant | 48 | CORE UNTESTED; QUANT default off; SMC UNVALIDATED |
| Paper validation | 28 | Filter exists; sample not proven here |
| **Trading edge** | **8** | No OOS+WFO+robustness+organic paper for a named version |
| Canadian | 35 | Live routing blocked |
| Observability | 58 | Real traces + Agent Network; other widgets still mock/`AwaitingSignal` |
| Data (research) | 40 | Contract + ingest script; warehouse empty until keyed GREEN write |
| Research harness | 45 | Golden SMA / translation tests ≠ book of business |
| Broker honesty | 55 | Equity fail-closed; paper seed easy to misread as buying power |
| Operational recovery | 50 | Startup health exists; 2FA and recon still operator work |

---

## 11. §25.3 — UI tab honesty matrix

SPA: ~21 nav surfaces in `App.tsx`. Login early-return is **after** most hooks — effects still run on the login screen; gate fetches on `isAuthenticated`.

**Rule:** unlabeled charts are **untrusted** until the component is read. `AwaitingSignal` / `NOT_IMPLEMENTED` is honest. Do not treat Research Lab or Focus Mode as Sharpe.

| Tab id | Honesty |
|---|---|
| `dashboard` | Mix. Live quotes/positions where wired. Several overlays use `AwaitingSignal` (historian, fake RSI overlay, risk decomposition). |
| `command` | Real Autobot/settings/guardrails. `AutoBotFlowVisualizer` of legacy `activeCycle` is **NOT** the live path (`AwaitingSignal`). |
| `portfolio` | Real `trades` / broker portfolio where APIs exist. Stress/counterfactual widgets `AwaitingSignal` if no real parallel sim. |
| `arena` | RNG performance widgets replaced with `AwaitingSignal` (2026-08-15). |
| `news` | Real news pipeline UI where backed by `news_*` tables / EventBus. |
| `opportunities` | `GET /api/v2/opportunities` — real high-confidence `agent_predictions` or empty `AwaitingSignal`. Not hardcoded NVDA cards. |
| `scanner` | Strategy Scanner / Research Lab. RSI scan uses cached `ohlcv_bars`. Research Lab = capability + promotion, **not** edge. |
| `intelligence` | Desk overlay (`EliteDeskPanel`) — reviewed catalog, not a live edge claim. |
| `agents` | **See §11.1.** DigitalTwin + Focus Mode = EventBus only. Dialogue graph = `AwaitingSignal`. |
| `evaluation` | Mixed; treat as untrusted except labeled APIs. |
| `kronos` | `KronosDashboard` — honest if Chronos `/health` down. |
| `learning` | `GET /api/v2/agents/learning-summary` + `learned_rules`. No fabricated “Alpha Generated by RL”. |
| `memory` | Event-memory **410** quarantined. Do not show 82% Trade War theater. |
| `observatory` | `TransactionObservatory` via `GET /api/v2/transactions/:id` — real joins. |
| `activity` | Process/activity; do not assume P&L. |
| `diagnostics` | Real health/AI usage where routed. |
| `audit` | Lists real `GET /api/v2/transactions` (not a fake LLM council timeline). |
| `validation` | `AwaitingSignal` / research status — not a live GO. |
| `deployment` | Real instance health check. |
| `settings` | Real settings + broker keys (encrypted). Restricted-live caps are **not** knobs. |
| `documentation` | Docs tab. |

### 11.1 Agent Network (`agents`) — Focus Mode

| Widget | Status |
|---|---|
| `DigitalTwinVisualizer` | REAL EventBus pulses/packets. Tick throttle 125ms + rAF. Idle tape ⇒ idle graph. |
| `AgentFocusMode` | REAL internals; expand ≤280ms. Backdrop / Escape / Close. |
| Technical | RSI/MACD/BB from TechnicalEngine calcs; confidence only on TechnicalAgent ideas |
| News / Ollama | Completed JSON only — **no** token stream on EventBus |
| Chief | Live stack + `EvidenceAggregator` math vs 0.75; official bar from `CHIEF_CONSENSUS_COMPLETED` |
| Risk | 24-gate catalog; colors after `RISK_GATE_EVALUATED` or persisted `risk_gate_results` |
| `OrchestrationStatus` | `/api/v2/orchestration/*` |
| Win-rate bar | `agent_performance_stats` or empty |
| Multi-Agent Dialogue Graph | **NOT SHOWN** (`AwaitingSignal`) |
| `AgentWorkflowTheater.tsx` | File exists; **not mounted** |

Copy drift: App still says “Click a node for the process log.” Click opens Focus Mode. Not a data lie.

**Does not raise** Observability (58) or edge (8).

---

## 12. §31 — Honesty pass (do / do not)

**Do**

- Say LIVE **NO-GO** and paper **CONDITIONAL GO**.
- Cite EventBus / `trades` / `risk_gate_results` for live decisions.
- Show `—` / Awaiting when payloads are missing.
- Keep QUANT and SMC flags **off** until evidence exists.
- Distinguish paper seed $100k vs $3k notional cap vs budget vs broker equity.

**Do not**

- Enable LIVE to “see if it works.”
- Count golden SMA, VectorBT version, or Focus Mode as edge.
- Describe unused agents as voters.
- Invent organic paper counts, 2022 LLM debates, or L2 ladders.
- Treat `riskGateOrder.json` as pass/fail.
- Claim CORE VectorBT = `runStrategyBacktest` PnL.
- Vendor TradingAgents source (inspiration only, Apache-2.0).

Known unavailable (never fill zeros): L2, options, breadth, volume profile, TSI, anchored VWAP, pairs, CAD FX, ORB/gap/HOD as live detectors unless that experimental env is on **and** validated.

---

## 13. P0 / P1 register (this date)

### Closed

| ID | Item | Evidence |
|---|---|---|
| P0 | Autobot unused on BUY | `autobot_enabled` |
| P0 | News/Fund/Macro ideas Autobot off | agent files + `newsEmitsTradeIdeas: false` |
| P0 | VectorBT as second broker | `canPlaceOrders: false` |
| P0 | `VALIDATED` without evidence | `promotionEngine.ts` |
| P1 | Quant regime-only live BUY | live emit = `strategyIdea` only |
| P1 | Empty PIT = AI BUY | `allowBuy: false` |
| P1 | Event-memory 82% | HTTP 410 |
| P1 | Vitest optional AI sockets | `vitest.setup.ts`; VectorBT skipped |
| P1 | Golden SMA look-ahead | `smaCrossover.ts` |
| P1 | WFO test leakage | `optimizedOnTest: false` |
| P1 | UNKNOWN/BACKTEST as organic paper | `organicPaper.ts` |
| P1 | MarketDataWorker Autobot-off emit | `isLiveIdeaGenerationEnabled` |
| P1 | ChiefTrader Autobot-off debate | `reviewIdea` early return |
| P1 | $100k vs $3000 confusion | named `tradingSafety` keys |
| P1 | SMA-as-CORE VectorBT | `FEATURE_TRANSLATION` |
| P1 | `debateReplayed` hardcoded false | `PitLlmReplay.ts` (true only if reconstructed) |

### Open

| ID | Item | Evidence |
|---|---|---|
| P1 | PortfolioMonitor SELL Autobot off | by design; still RiskEngine |
| P1 | Live MTF 1m–daily execution | not a live path |
| P1 | ORB / gap / HOD / L2 | `UNAVAILABLE` or experimental |
| P1 | Full VectorBT RegimeEngine port | only BOS/RVOL/Keltner/S-R translated |
| P1 | Years of GREEN parquet on disk | pipeline yes; files only after ingest |
| P0* | No measured edge | trading-edge, not a missing kill-switch |

---

## 14. Is unattended paper “safe”?

**Autobot off:** no new BUY (RiskEngine + ChiefTrader + no tick emit). VectorBT cannot fill. Residual: PortfolioMonitor **SELL** and recon flatten if that flag is on.

**Autobot on, paper broker, `autoFlattenOnReconciliationMismatch: false`:** orders still full RiskEngine/OMS. QUANT off unless env. News does not independently vote BUY. Default is still **NO TRADE** until consensus + gates pass.

**Not safe to claim:** profitable, OOS-validated CORE, elite-trader, LIVE-ready, “VectorBT found an edge.”

---

## 15. GO / NO-GO

### Paper

- Autobot off, no new BUY: **GO**
- Autobot on, paper/internal, flatten flag false: **CONDITIONAL GO** (infrastructure)
- Do **not** size up from golden SMA, Research Lab, Scanner, VectorBT/Rust versions, or Focus Mode

### Live capital

**NO-GO** until **all** of:

1. Organic paper fills exist (honest filter; floors 30 trades / 10 sessions).
2. Walk-forward / permutation **pass** on that ledger for a named `strategyVersion`.
3. Experimental flags stay off unless separately validated.
4. RiskEngine/OMS remain the only fill path.
5. Canadian routing verified only if legally permitted — never by flipping `canadianEquities`.
6. Manual approval after `LIVE_CANDIDATE`.

Remaining blockers even then: IBKR 2FA, Questrade cannot place, restricted-live caps are ceilings not an edge, no L2, debate confidence uncalibrated.

---

## 16. Commands (ground truth)

```
npm run dev              # companions + tsx server.ts :3000
npm run dev:server-only  # Node only
npm run build            # Vite SPA + esbuild → dist/server.cjs
npm test                 # vitest run — trust the runner count
npm run lint             # tsc --noEmit
npx tsx scripts/assert_core_vectorbt_parity.ts
npx tsx scripts/ingest_research_warehouse.ts   # needs Alpaca keys; no fabricate
```

`npm run db:migrate` now exists as a thin re-import of `src/server/db/index.ts`. Boot still migrates on first import. Prefer `npm run dev` / `npm run start` as the real path.

---

*End of analysis. Forensic companion: `ARGUS_FINAL_FORENSIC_AUDIT.md`. Scores not raised for more reports. LIVE NO-GO. Trading edge 8. Organic paper in this DB: NONE. Paper CONDITIONAL GO for plumbing only.*
