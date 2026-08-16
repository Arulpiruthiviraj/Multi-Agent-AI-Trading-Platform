# Argus Autonomous Trading Platform — FINAL FORENSIC ANALYSIS & READINESS MATRIX

**Audit Date:** 2026-08-16
**Auditor:** Principal Quantitative Systems Auditor & Risk Officer (hostile, read-only pass)
**Build & Test Verification:** `npx tsc --noEmit` — **PASS** (exit 0, zero errors). `npx vitest run` — **PASS**, **1089 tests / 166 files**, 0 failed (vitest 4.1.10, ~150-200s depending on system load).
**Overall Real-Money Readiness:** **61.8%** (Section 9 — deterministic weighted calculation; do not round up)
**Verdicts:**
- **LIVE Autonomous Trading:** **NO-GO**
- **Paper Trading (Supervised):** **CONDITIONAL GO**
- **Trading Edge:** **8/100 (NO-GO / UNTESTED)** — per the zero-fabrication rule: organic closed paper trades in `data/argus.db` = 0, so this score is a floor value, not a measurement of a real edge.

This document was produced by direct source/schema/data inspection this session, not by trusting prior markdown claims, comments, or docstrings. Every specific claim below cites a real file, and every count is from a live command run against the current tree and `data/argus.db`.

---

## 1. Executive Summary & Critical Findings

Argus's engineering is materially stronger than a naive read of "passing tests" would suggest: there is exactly one production order path, it is provably isolated from research/UI/Python code, encryption and secrets handling fail closed, and the risk gate ladder (24 real gates) records an honest pass/fail for every gate on every evaluation — including a real fix that prevents a binding sizing clamp from ever being reported as a pass at zero shares. None of that is trading edge, and none of it is claimed as such anywhere in the code.

The five most critical gaps preventing real-money deployment, in priority order:

1. **Zero organic closed paper trades exist.** `data/argus.db`'s `trades` table has 8 rows total: 6 are diagnostic-script artifacts (`DIAGTEST*`/`DIAGPIPE*`/etc., all `PENDING`, never filled), and the only FILLED BUY/SELL pair (AAPL, real -$91.05 realized loss) is tagged `execution_environment='REPLAY'` — it came from the historical-replay lab, not real paper trading. `organicPaper.ts`'s `isOrganicClosedPaper()` correctly excludes it. The `minPaperTrades: 30` threshold in `config/researchSafety.json` is 0/30 met.
2. **No out-of-sample statistical edge has been demonstrated.** The real walk-forward/robustness/permutation harnesses (`coreWalkForward.ts`, `coreRobustness.ts`, `multipleTesting.ts`) exist and run against real GREEN data, but the recorded prior real run (SPY, 1Day, NEXT_BAR) reported WFO **FRAGILE** and robustness **FAILED/insufficient**. The infrastructure to validate an edge is real; the validated edge is not.
3. **Python/VectorBT strategy parity is not established.** `config/researchSafety.json`'s own `proxyAdapterNote` states CORE feature vectors (BOS/RVOL/Keltner/S-R) match the TS fixture (`FEATURE_SUBSET_PARITY`), but full `StrategyContext.evaluate()` is not byte-identical in Python, and VectorBT itself is `state: 'UNAVAILABLE'` in this environment (not installed) — `getVectorBTStatus()` confirms no Rust backend, no Python bridge active.
4. **`BacktestEngine.ts` still fills on `SAME_BAR_CLOSE`, not `NEXT_BAR_OPEN`.** It is explicitly stamped `promotable: false` / `SAME_BAR_CLOSE_NOT_PROMOTABLE` in its own header comment — a real, intentional, non-silent limitation, but it means the older/broader backtest surface cannot be used as promotion evidence. Only `canonicalNextBarEngine.ts`'s narrower NEXT_BAR_OPEN path can.
5. **Live capital enablement is correctly, deliberately hard to reach — and that is by design, not accident.** Five independent, redundant checks (confirmation phrase, `BrokerManager.setLiveMode` arming, per-order `assertBrokerEnvironmentAllowsOrder`, per-order `isLiveTradingArmed()`, and a live-Alpaca-host refusal absent that arm) must all agree before a single real LIVE order can be placed, and a process restart clears the arm even if the DB still says LIVE. This is correct, verified fail-closed behavior — but it also means the system has never been exercised end-to-end with real capital, which is itself an evidence gap, not just a safety feature.

---

## 2. Complete Repository & Subsystem Inventory

| Subsystem | Path | Role | Test coverage | Health |
|---|---|---|---|---|
| Live decision spine | `server.ts`, `src/server/services/{TechnicalAgent,ChiefTraderAgent,RiskAgent,QuantSignalAgent}.ts` | Real agents → consensus → risk → order | Extensive (unit + integration) | Real, production |
| Risk & sizing | `src/server/engines/{RiskEngine,PositionSizing,RestrictedLiveMode,CapitalAllocation,DailyBuyNotional}.ts` | 24-gate risk ladder, sizing honesty | Extensive | Real, production |
| Order execution | `src/server/services/OrderManagement.ts`, `src/brokers/*` | Sole `placeOrder` caller, broker adapters | Extensive | Real, production |
| Broker adapters | `src/brokers/{AlpacaBroker,InternalPaperBroker,InteractiveBrokersAdapter,CoinbaseBroker,QuestradeBroker,HistoricalReplayBroker}.ts` | Real execution surfaces | Per-adapter | Alpaca fully unattended; others partial/blocked (Section 6) |
| Encryption / secrets | `src/server/core/EncryptionService.ts`, `server.ts` secrets guard | Fail-closed key handling | Direct + integration | Real, verified this session |
| Research/backtest core | `src/server/engines/backtest/BacktestEngine.ts`, `src/server/research/canonicalNextBarEngine.ts` | SAME_BAR (legacy) vs NEXT_BAR (canonical/promotable) | Extensive | Real, two distinct fill models, not mixed |
| Research validation | `src/server/research/{coreWalkForward,coreRobustness,multipleTesting,robustness,edgeScore}.ts` | WFO, permutation, cost-stress, edge scoring | Extensive | Real infrastructure; real prior result was FRAGILE/FAILED |
| Python bridge | `python/argus_research/{cli.py,core_features.py}` | Feature-subset parity check, VectorBT bridge | Present | `FEATURE_SUBSET_PARITY` only; VectorBT itself `UNAVAILABLE` here |
| Historical replay | `src/server/replay/FullArgusReplayEngine.ts`, `src/server/routes/researchRoutes.ts` | Full pipeline replay against golden/real historical bars | Present (`phase17-25` test files) | Real; explicitly `executionEnvironment: 'REPLAY'`, excluded from organic paper |
| Promotion engine | `src/server/research/promotionEngine.ts` | Lifecycle status / GO-NO-GO derivation from real evidence | Present | Real; currently emits `promotable: false` across recorded runs |
| Data quality / warehouse | `src/server/research/{dataQuality,parquetStore,warehouseInventory,ingestAlpacaWarehouse}.ts` | GREEN/YELLOW/RED grading, Parquet export | Present | 1 GREEN dataset on disk (SPY), 0 Parquet files written |
| AI routing | `src/server/ai/AIRouter.ts`, `src/server/ai/providers/*` | Multi-provider LLM routing, failover | Extensive | Real; Gemini/OpenAI/DeepSeek/Nvidia/OpenAI-compatible implemented |
| UI (SPA) | `src/App.tsx`, `src/components/*` | Single-page frontend | Minimal (documented, longstanding gap) | Key visualizers (`DigitalTwinVisualizer`, `AgentFocusMode`) verified real-event-only; Mission Control verified free of hardcoded win-rate strings |
| Legacy/quarantined | `GET /api/v1/signals`, event-memory routes | Old fabricated-consensus path | N/A | Confirmed `410 SIGNALS_PATH_QUARANTINED`, not restorable |

---

## 3. Order & Execution Path Forensics

**The single authorized path:**

```
MarketDataWorker (real Alpaca WS ticks)
  -> EventBus 'MARKET_DATA' / 'MARKET_DATA_UPDATED'
  -> Independent agents (TechnicalAgent, NewsEngine, FundamentalAgent, MacroAgent,
     PortfolioMonitor, QuantSignalAgent) -> 'TRADE_IDEA_GENERATED'
  -> ChiefTraderAgent.evaluateConsensus() -> 'CHIEF_APPROVED_IDEA'
  -> RiskAgent.assessRisk() -> RiskEngine.evaluateRisk() (24-gate ladder, serialized queue)
  -> 'RISK_ASSESSMENT_COMPLETED'
  -> OrderManagementService (sole `placeOrder` caller in production TS)
  -> BrokerManager.getActiveBroker() -> broker adapter -> real order
```

**Invariant proof, this session:**

- `grep -rn "executeAutoBotTradeInSovereign"` across the tree (excluding `node_modules`): **0 matches.** The function does not exist.
- `find . -iname "BrokerEngine.ts"`: **no results.** Confirmed deleted; no dormant `submitOrder` path parallel to OMS.
- `grep -rln "\.placeOrder("` across `src/` (excluding `*.test.ts`): only the five broker adapters (`CoinbaseBroker`, `HistoricalReplayBroker`, `InteractiveBrokersAdapter`, `InternalPaperBroker`) calling `this.placeOrder` internally for close/flatten helpers, plus `OrderManagement.ts` — the only external caller. `server.ts` and every file under `src/server/routes/` have zero `.placeOrder(` calls. `src/App.tsx` has zero.
- Python/VectorBT: `getVectorBTStatus()` reports `canPlaceOrders: false`; no `BrokerManager` import anywhere under `python/`.

**Manual override path** (`POST /api/v2/trading/execute-override`): skips only ChiefTrader's consensus step — still goes through the identical RiskEngine → OMS path, reasoning is stamped `SOURCE: MANUAL_OVERRIDE`, and `organicPaper.ts`'s `isOrganicClosedPaper()` explicitly excludes anything with that reasoning marker or a `manual-override-` traceId prefix, so an operator override can never inflate the organic-paper count.

**Verdict:** Real order placement is structurally isolated to one path. This is a code-level guarantee (verified by exhaustive grep, not sampling), not a policy.

---

## 4. State Machine & Safety Matrix

| State dimension | Where enforced | BUY impact | SELL impact |
|---|---|---|---|
| `tradingState` (`TRADING_ENABLED` / `TRADING_PAUSED` / `EMERGENCY_STOP`) | `RiskEngine.ts` gate `emergency_stop` (evaluated first, always) | Blocked unless `TRADING_ENABLED` | Blocked unless `TRADING_ENABLED` |
| Autobot on/off | `RiskEngine.ts` gate `autobot_enabled` | **Blocked** when Autobot is off | **Not blocked** — SELL/exit still runs so `PortfolioMonitor` can flatten existing paper positions even with Autobot off |
| `tradingMode` (`PAPER`/`LIVE`) vs `paperMode` flag | `assertBrokerEnvironmentAllowsOrder()` (`src/server/core/brokerEnvironment.ts`), called in `OrderManagement.ts` | Disagreement between the two flags -> order outcome `UNKNOWN`, no order placed | Same |
| Per-order LIVE arm | `isLiveTradingArmed()` (`LiveTradingConfirmation.ts`), checked in both `OrderManagement.ts` and `AlpacaBroker.placeOrder` (refuses the real `api.alpaca.markets` host without it) | Refused without arm | Refused without arm |
| Confirmation phrase | `TradingEngine.toggle()` requires `confirmLiveTrading === 'ENABLE LIVE TRADING'` to enable LIVE at all | Gates the whole LIVE mode, upstream of every order | Same |
| Process restart | Arm state is in-memory only; a restart clears it even if `settings.tradingMode` in SQLite still says `LIVE` | Every order after a restart requires re-arming | Same |
| Replay session active | `RiskEngine.ts`: `getActiveReplaySession()` substitutes replay-scoped trading state/clock/news; refuses if `tradingMode === 'LIVE'` | Replay never touches real trading state | Same |

**Verdict:** No single flag, and no pair of flags, is sufficient to place a real LIVE order. Every path requires the confirmation phrase (upstream), the dual-flag agreement (per-order), and the explicit arm (per-order) simultaneously.

---

## 5. RiskEngine 24-Gate Deep Audit

Canonical order from `config/riskGateOrder.json` (used for the UI catalog only — actual pass/fail always comes from `RISK_GATE_EVALUATED` / `risk_gate_results`, per that file's own `$comment`). All 24 gates are evaluated **unconditionally** on every proposal (not short-circuited), per `RiskEngine.ts`'s own documented Phase-2 design — a rejected proposal still gets a complete, honest gate-by-gate record.

| # | Gate | Source | Fail-mode | BUY | SELL |
|---|---|---|---|---|---|
| 1 | `emergency_stop` | `RiskEngine.ts:219` | Closed (blocks unless `TRADING_ENABLED`) | Yes | Yes |
| 2 | `autobot_enabled` | `RiskEngine.ts:230` | Closed for BUY only | Yes | No (exits always allowed) |
| 3 | `same_symbol_cooldown` | `OvertradingGuards.ts` via `RiskEngine.ts:244` | Real trade-history lookback | Yes | Yes |
| 4 | `post_loss_cooldown` | `OvertradingGuards.ts` via `RiskEngine.ts:246` | Real trade-history lookback | Yes | Yes |
| 5 | `daily_trade_limit` | `OvertradingGuards.ts` via `RiskEngine.ts:248` | Real trade-history lookback | Yes | Yes |
| 6 | `duplicate_signal` | `OvertradingGuards.ts` via `RiskEngine.ts:252` | Real `risk_assessments` lookback window | Yes | Yes |
| 7 | `invalid_account_equity` | `AccountEquity.ts` via `RiskEngine.ts:297` | **Closed** — non-positive/missing broker equity refuses outright, no placeholder balance | Yes | Yes |
| 8 | `daily_loss` | `RiskEngine.ts:344` | Real exchange-day (America/New_York) baseline, 80% kill-switch fraction | Yes | Yes |
| 9 | `consecutive_loss` | `RiskEngine.ts:350` | Real realized P&L from last N FILLED trades (replay/backtest/diagnostic rows excluded) | Yes | Yes |
| 10 | `portfolio_drawdown` | `RiskEngine.ts:367` | Real persisted high-water-mark, never resets down | Yes | Yes |
| 11 | `order_rate_limit` | `RiskEngine.ts:383` | Real 60s `risk_assessments` count | Yes | Yes |
| 12 | `market_hours` | `RiskEngine.ts:392` | **Fail-closed** — HTTP/network failure on Alpaca clock is `unavailable`, treated as blocking, never as open | Yes | Yes |
| 13 | `data_freshness` | `marketDataQuality.ts` | **Fail-closed** — `priceAgeMs === null` returns grade `UNKNOWN`, `passed: false`, never treated as fresh | Yes | Yes |
| 14 | `news_veto` | `newsClusterMatch.ts` | `newsImpactOnVetoScale()` real-verified: normalizes a 0-1 raw `impactScore` to the 0-100 threshold scale before comparing, closing a real unit-mismatch bug | Yes | Yes |
| 15 | `price_validity` | `RiskEngine.ts:435` | Requires finite, positive current price | Yes | Yes |
| 16 | `order_notional_cap` | `PositionSizing.ts:153` | `passed:false` when `maxSharesByCapital <= 0` | Yes | N/A |
| 17 | `symbol_concentration` | `PositionSizing.ts:171` | `passed:false` when remaining room floors to 0 shares | Yes | N/A |
| 18 | `open_positions_cap` | `PositionSizing.ts:180` | Blocks a genuinely new position once `existingPositions.length >= maxOpenPositions` | Yes | N/A |
| 19 | `sector_concentration` | `PositionSizing.ts:192` | `passed:false` at zero remaining sector room; `failClosedUnknownInputs` (LIVE only) treats an unmapped symbol as **FAIL**, not skip | Yes | N/A |
| 20 | `correlation_exposure` | `PositionSizing.ts:222` | Same zero-room honesty; LIVE fails closed on missing price history instead of skipping | Yes | N/A |
| 21 | `sufficient_size` | `PositionSizing.ts:258` | **Verified honesty fix**: a post-hoc pass (`PositionSizing.ts:240-256`) re-flips any gate that reported `CLAMPED`/`PASS` but left `maxQuantity === 0` to `FAIL` — a binding clamp can never be reported as a pass at zero shares | Yes | N/A |
| 22 | `sell_position_exists` | `RiskEngine.ts:484` | Recorded on SELL only (BUY assessments omit it, per `riskGateOrder.json`'s own comment) | N/A | Yes |
| 23 | `argus_capital_allocation` | `CapitalAllocation.ts` via `RiskEngine.ts:510` | Real allocation ceiling, distinct from broker buying power | Yes | Yes |
| 24 | `daily_buy_notional` | `DailyBuyNotional.ts` via `RiskEngine.ts:524` | Real cumulative-BUY-dollars-today cap, resolved per `tradingMode` | Yes (SELL notional is 0, always passes) | Yes |

**Sizing honesty, directly verified in code (`PositionSizing.ts:239-256`):** after all sizing gates compute, if `maxQuantity === 0`, the function walks back over every gate and flips any that still reads `passed:true` with a `CLAMPED` status and `boundQuantity === 0` to `passed:false, status:'FAIL'`. This is the exact mechanism that prevents a UI/audit trail from showing a green checkmark next to a gate that actually zeroed out the trade.

---

## 6. Research Engine, Backtesting & VectorBT Parity Audit

| Dimension | Status | Evidence |
|---|---|---|
| `BacktestEngine.ts` fill model | **`SAME_BAR_CLOSE`**, not converted | File header, `src/server/engines/backtest/BacktestEngine.ts:14-17`: explicitly stamped `promotable: false` / `SAME_BAR_CLOSE_NOT_PROMOTABLE` |
| Canonical promotion fills | **`NEXT_BAR_OPEN`**, separate engine | `canonicalNextBarEngine.ts` — mixing the two models is treated as `ENGINE_MISMATCH`, not silently reconciled |
| Transaction costs (research) | **Non-zero, real** | `config/researchSafety.json`: `commissionPerShare: 0.005`, `spreadBps: 2`, `slippageBps: 5`, `zeroCostBlocksPromotion: true` |
| CORE feature-vector parity (Python) | `FEATURE_SUBSET_PARITY` | `strategyEvidence.ts:10,34` — BOS/RVOL/Keltner/S-R vectors match the TS unit fixture |
| Full `StrategyContext.evaluate()` parity | **Not established** | `researchSafety.json`'s own `proxyAdapterNote`: "Full StrategyContext evaluate() is not byte-identical in Python" |
| SMC strategy | `PROXY_NOT_FEATURE_PARITY` | `strategyEvidence.ts:10,34` — explicitly separated from the CORE five, flagged UNVALIDATED |
| VectorBT installation | **`UNAVAILABLE`** in this environment | `VectorBTService.ts`: `installed: false`, `rustBackend.available: false`, `state: 'UNAVAILABLE'` |
| Data warehouse GREEN grade | 1 real dataset | `data/research/SPY_1Day_2024-07-21.meta.json`: `provenance: 'REAL_MARKET_DATA'`, `qualityStatus: 'GREEN'`, `barCount: 519` |
| Parquet bytes on disk | **0 files written** | `find data -iname "*.parquet"` — zero results. The GREEN meta sidecar's own `parquetBytesWritten: false` confirms the write job hasn't run |
| Recorded research runs | 5 real runs on disk, all real results | `data/research/runs/*/promotion.json`: every run reports `"live": "NO-GO"`; `promotable: false` in all 5; `backtestPass` true in 2 of 5, false in 3 |

**Verdict:** The research/backtest infrastructure is real and genuinely separates "the vector subset matches" from "the full strategy matches" from "a validated edge exists" — it does not conflate them. None of the three currently clears its own bar.

---

## 7. Empirical Paper Trading & Database Analysis

Direct query against `data/argus.db` this session:

```
trades table: 8 total rows
  6x DIAGTEST*/DIAGPIPE*/DIAGORDER*/DIAGCHAIN* — all status=PENDING, execution_environment=null
  1x AAPL BUY  — status=FILLED, execution_environment=REPLAY
  1x AAPL SELL — status=FILLED, execution_environment=REPLAY, profit_loss=-91.05

transactions table: 698 total rows
  415x NO_CONSENSUS
  243x RISK_REJECTED
   40x OPEN (unresolved — see below)

fills table: 2 rows (both from the same REPLAY pair above)
```

**Organic closed paper trades: 0.** `organicPaper.ts`'s `isOrganicClosedPaper()` requires `status='FILLED' AND side='SELL' AND profitLoss is a real number AND classifyTradeEnvironment(row) === 'PAPER'`. The one real FILLED SELL classifies as `REPLAY` (both via its explicit `execution_environment` column and its `replay-<id>-...` traceId prefix), which the filter correctly excludes. Zero rows pass.

**`minPaperTrades: 30` threshold (`config/researchSafety.json`): 0/30 met.**

**The 40 `OPEN` transactions** are a known, separately-diagnosed historical artifact (documented in this session's own prior forensics): pre-dating a same-day server restart that loaded a real status-transition fix; they are not evidence of a currently-broken pipeline — the same fix has correctly transitioned 243 real `RISK_REJECTED` rows since.

**Verdict:** There is no organic paper trading track record in this environment, full stop. The one closed trade that exists came from the historical-replay lab against 2024 data, not from the live pipeline trading paper in real time.

---

## 8. AI, Catalyst & News Pipeline Audit

**Real, router-native LLM providers** (`src/server/ai/providers/`): `GeminiProvider`, `OpenAIProvider`, `DeepSeekProvider`, `NvidiaProvider` (extends `OpenAICompatibleProvider`), `OpenAICompatibleProvider` (covers local Ollama). All extend a common `BaseAIProvider`. Every call routes through `AIRouter.getInstance()` — no agent calls a provider SDK directly (verified in Section 3's broader grep sweep of production call sites).

**Probability discipline** (`src/server/research/statsIntervals.ts:13-18`):
```ts
export type ProbabilityKind = 'MODEL_ESTIMATE' | 'EMPIRICALLY_VALIDATED' | 'UNAVAILABLE';
if (source === 'llm') return 'MODEL_ESTIMATE';
if (sampleSize >= minSample) return 'EMPIRICALLY_VALIDATED';
```
An LLM's stated confidence is never labeled as a validated win probability — it is always tagged `MODEL_ESTIMATE` at the type level, and only a real sample crossing `minSample` can earn `EMPIRICALLY_VALIDATED`. This is a real, structural discipline, not a comment.

**`news_veto` math** (Section 5, gate 14): verified fix normalizes `news_clusters.impactScore` (0-1 scale from `NewsImpactEngine`) to the 0-100 scale `tradingSafety.json`'s threshold is expressed in, via `newsImpactOnVetoScale()`. Before this normalization existed, a real 0-1 score compared against an 0-100 threshold would have silently never fired.

---

## 9. Comprehensive Real-Money Readiness Scorecard (Exact % Calculation)

Each score is grounded in the evidence gathered in Sections 3-8 above, not estimated. Per the zero-fabrication rule, dimensions where the real recorded evidence is negative or absent (OOS, WFO, robustness, organic paper, trading edge) are scored low even though the *infrastructure* to measure them is real and well-built — infrastructure quality and validated results are scored as what they are: two different things.

| # | Dimension | Weight | Score (/100) | Weighted Contribution | Evidence / Reason |
|---|---|:---:|:---:|:---:|---|
| 1 | Software & Compiler Correctness | 10% | 90 | 9.0% | `tsc --noEmit` clean; 1089/1089 tests pass across 166 files. Docked for thin UI test coverage (longstanding, documented) and one transient flaky run observed under heavy concurrent system load this session (passed clean on re-run). |
| 2 | Execution Spine & OMS Isolation | 15% | 92 | 13.8% | Section 3: zero dormant paths, `.placeOrder(` isolated to OMS + adapters, `BrokerEngine.ts` confirmed deleted, `executeAutoBotTradeInSovereign` confirmed absent. Docked for the shadow ledger existing as a second (OMS-fill-only) ledger and an unresolved `EventBus` single-point-of-failure risk (one throwing listener can starve later listeners — a real, structural, previously-documented fragility not fixed as of this audit). |
| 3 | Risk Management & Gate Honesty | 15% | 90 | 13.5% | Section 5: all 24 gates verified in source, unconditional evaluation, verified sizing-honesty flip-to-FAIL mechanism, fail-closed `data_freshness`/`market_hours`/`invalid_account_equity`. Docked for `RestrictedLiveMode`'s hardcoded ceilings being LIVE-only by design (paper trading relies on settings-driven, not hardcoded, ceilings). |
| 4 | Market Data & Freshness Pipeline | 8% | 75 | 6.0% | Real Alpaca WS ticks, real fail-closed staleness gate. Docked: no L2 order book (documented, unfixable without a paid data tier), no extended real-time soak test on record. |
| 5 | Strategy Logic & Feature Parity | 7% | 45 | 3.15% | Real deterministic TS strategy logic (5 CORE strategies); Python side only reaches `FEATURE_SUBSET_PARITY`, explicitly not full `StrategyContext.evaluate()` parity. |
| 6 | Research & Backtest Consistency (NEXT_BAR) | 8% | 55 | 4.4% | Real, correctly-separated NEXT_BAR canonical path exists and is used for promotion; the older/broader `BacktestEngine.ts` remains SAME_BAR_CLOSE and explicitly non-promotable. |
| 7 | Out-of-Sample (OOS) Validation | 6% | 20 | 1.2% | Real harness exists and ran; recorded real result was FRAGILE, not a pass. |
| 8 | Walk-Forward Optimization (WFO) | 6% | 20 | 1.2% | Same real harness/result as #7 — infrastructure real, outcome not passing. |
| 9 | Statistical Robustness & Permutation | 5% | 20 | 1.0% | `permutationTestPnls`/`costStress` real and configured (`permutationAlpha: 0.05`); recorded result FAILED/insufficient. |
| 10 | Organic Paper Validation (30+ Trades) | 5% | 0 | 0.0% | Section 7: 0/30 real organic closed paper trades. Zero-fabrication rule applies directly. |
| 11 | Empirical Trading Edge & Expectancy | 5% | 8 | 0.4% | No real expectancy is computable from 0 organic trades; scored at the mandated floor value per the audit's own zero-fabrication rule. |
| 12 | Broker Adapter & Security Hardening | 5% | 82 | 4.1% | Section 1/4: encryption fail-closed (verified `throw` on missing `ENCRYPTION_SECRET` and on decrypt failure), `secrets.json` boot guard verified, 5-layer LIVE arm verified. Docked: only Alpaca is fully unattended; IBKR/Questrade/Coinbase all have real, documented restrictions. |
| 13 | Operational Recovery & Observability | 3% | 75 | 2.25% | Real reconciliation, alerting, crash recovery on record from prior phases. Docked: OpenAlice/IBKR companion health can fail without blocking RiskEngine — an operational gap, not a safety one. |
| 14 | Legal & Regulatory Compliance (Canada) | 2% | 90 | 1.8% | Canadian automated live routing (IIROC) is correctly, verifiably blocked rather than falsely offered — `markets.json` documents the restriction; no code path unlocks it. |
| **TOTAL** | **Real-Money Readiness** | **100%** | — | **61.8%** | **LIVE: NO-GO** |

**Read this number carefully.** 61.8% is a blend of genuinely strong engineering (dimensions 1-3, 12-14 average ~88) and genuinely absent trading validation (dimensions 7-11 average ~14). Averaging them into one number is only useful as a compact answer to "how far along is this, overall" — it must never be read as "62% likely to be profitable," and nothing in this document should be read that way.

---

## 10. Remaining Work Breakdown (Phase-by-Phase Roadmap)

- **Phase A: Execution Parity & Cost Realism.** Decide, explicitly and with sign-off (this is a real trading-behavior fork, not a unilateral call): either bring `BacktestEngine.ts` onto `NEXT_BAR_OPEN` to match `canonicalNextBarEngine.ts`, or formally retire it in favor of the canonical engine for anything promotion-adjacent. Files: `src/server/engines/backtest/BacktestEngine.ts`, `src/server/research/canonicalNextBarEngine.ts`.
- **Phase B: VectorBT / Python Feature Parity Bridge.** Close the gap from `FEATURE_SUBSET_PARITY` to full `StrategyContext.evaluate()` parity for the 5 CORE strategies; only after that, reconsider SMC's `PROXY_NOT_FEATURE_PARITY` status. Files: `python/argus_research/core_features.py`, `src/server/research/strategyEvidence.ts`, `config/researchSafety.json`.
- **Phase C: Real Market Data Ingestion / Parquet Completion.** Run the real `write_parquet` job (`allowlistedJobs` already includes it) against the one GREEN dataset to produce actual Parquet bytes; expand GREEN coverage beyond the single SPY dataset. Files: `src/server/research/parquetStore.ts`, `scripts/ingest_research_warehouse.ts`.
- **Phase D: UI Telemetry & Arena Cleanup.** Already substantially done (Section 2, Section 8 of the prior pass) — remaining work is expanding UI test coverage, the longest-standing documented gap in this codebase.
- **Phase E: The 30-Day Organic Paper Soak.** The single highest-value remaining action. Run Argus continuously, in real PAPER mode, Autobot on, against real Alpaca paper ticks, for long enough to accumulate 30+ real closed SELL trades across varied market conditions. This cannot be shortcut, accelerated, or simulated without violating the zero-fabrication rule — it requires real elapsed market time.

---

## 11. Timeline & Effort Estimation

- **Engineering effort (Phases A-D):** Phase A is a real trading-behavior decision plus a bounded implementation (days, not weeks, once the direction is chosen). Phase B is the largest remaining engineering lift — true cross-language strategy parity is genuinely hard and multi-day at minimum. Phase C is small (the pipeline exists; it needs to actually run). Phase D is incremental and ongoing.
- **Market incubation effort (Phase E):** 30 real organic trades at realistic signal frequency, spread across enough sessions to see more than one market regime, realistically requires multiple weeks of continuous real-time operation — this is elapsed calendar time, not compute time, and is the one item on this list nothing in this session (or any single engineering session) can shortcut.

---

## 12. Final Authoritative Verdict

| Question | Call |
|---|---|
| **Paper trading (supervised: Autobot on, real ticks, PAPER + `paperMode` aligned, InternalPaper or Alpaca paper)** | **CONDITIONAL GO** — the path is real and fail-closed; this is not a claim of profitability. |
| **Paper trading (100% unattended / "PAPER TRADING READY (TECHNICAL)")** | **NO-GO** — 0 real organic closed trades means the claim has no evidentiary basis yet, technical soundness notwithstanding. |
| **Live capital / autonomous real-money trading** | **NO-GO** — no validated statistical edge exists at any layer (Sections 6-7), independent of how well the surrounding infrastructure is built. |
| **Canadian automated live execution** | **BLOCKED (external, IIROC)** — correctly refused, not a code gap. |
| **Start the 30-day organic paper soak now?** | **Infrastructure: CONDITIONAL GO.** Nothing code-level blocks starting it. Evidence remains at 0 until it actually runs. |

Do not enable LIVE. Do not treat VectorBT status, the historical-replay lab, passing tests, or the CORE strategy files as evidence of a trading edge. Do not count the shadow ledger, replay trades, or manual overrides as organic paper. The 61.8% readiness score in Section 9 describes engineering maturity blended with trading validation — it is not, and must never be represented as, a probability of profit.
