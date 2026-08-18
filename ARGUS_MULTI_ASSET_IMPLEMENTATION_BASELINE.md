# ARGUS multi-asset implementation baseline

Forensic snapshot before any multi-asset / penny-stock code. This is not a readiness certificate. LIVE remains `LIVE_NO_GO`. Organic paper edge is not established.

## Current architecture (protected)

Live path (authoritative, will not be rewritten):

```
TRADE_IDEA_GENERATED (gateTradeIdea / looksLikeListedTicker)
  → ChiefTraderAgent (min 2 independent agents, bar from tradingSafety.json)
  → CHIEF_APPROVED_IDEA
  → RiskAgent → RiskEngine.evaluateRisk() (24 recorded gates)
  → RISK_ASSESSMENT_COMPLETED
  → OMS executeOrder (MARKET, whole shares, clientOrderId)
  → BrokerManager.getActiveBroker().placeOrder
  → fills / trades
```

| Layer | Location | Fact |
|---|---|---|
| Idea gate | `src/server/core/tradeIdeaContract.ts` | DEF-24: invalid ticker or missing price never reaches ChiefTrader |
| ChiefTrader | `src/server/services/ChiefTraderAgent.ts` | No asset-class or strategy-id branch. HOLD veto and min-agents stay. |
| RiskEngine | `src/server/engines/RiskEngine.ts` | 24 gates. Catalog length asserted in `phase21.invariants.test.ts`. |
| Sizing | `src/server/engines/PositionSizing.ts` | FIXED_DOLLAR default. Stop = `stopLossAssumptionPct` (not ATR). No per-class table. |
| OMS | `src/server/services/OrderManagement.ts` | **Hardcodes `type: 'MARKET'`**. Sole production `.placeOrder(` caller. |
| Brokers | `src/brokers/*` | Alpaca IEX top-of-book. Questrade cannot place. Coinbase is crypto, not this spine. |
| Quant | `src/server/quant/` | Five CORE strategies in live `evaluateAll()`. Experimental only if that env is `'true'` at call time. `QUANT_ENGINE_ENABLED` defaults off. |
| Shadow engine | `src/server/strategiesEngine/` | Isolated. Does not import ChiefTrader / RiskEngine / OMS / EventBus. |
| Research fills | `canonicalNextBarEngine.ts` | NEXT_BAR_OPEN, promotion-adjacent. `BacktestEngine.ts` is SAME_BAR_CLOSE, not promotable. |

## Existing capabilities that already cover “broad equities”

- `looksLikeListedTicker` accepts `^[A-Z]{1,5}(\.[A-Z])?$` — AAPL, MSFT, NVDA, AMZN, TSLA, SPY, QQQ, IWM, and most US penny tickers **already parse**.
- Default WS universe is `config/markets.json` US benchmarks: **SPY, QQQ, IWM, DIA**. RSI scan defaults include AAPL/MSFT/NVDA/AMD/SPY/GLD/TLT/TSLA.
- CORE strategies (`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`) are not large-cap-only in code. They were **not** validated as a penny edge.
- Experimental modules already exist for VWAP, ORB, volume confirmation, gaps, Donchian, etc. They are **UNVALIDATED** and off.

## What does **not** exist today

- No market-cap / LARGE_CAP / PENNY_STOCK classifier.
- No live bid–ask spread: MarketDataWorker stores **bid price** (`bp`) only; **ask is not stored**. No dollar-volume field.
- No Amihud / penny toxicity filter (GuardrailsPanel lists Amihud as NOT_IMPLEMENTED).
- No LIMIT / participation / slippage gate on the live OMS path.
- News symbol extraction heuristic is mega-cap only (AAPL, TSLA, MSFT, NVDA, GOOGL, AMZN, META). Small-name catalysts are not systematic.
- `phase21` asserts RiskEngine catalog length **24**. Adding a 25th named gate requires changing that invariant test — forbidden as a silent “make it pass” edit.

## Reusable components (extend, do not duplicate)

- `config/*.json` + `loadRepoConfigJson` (fail boot on missing keys)
- Env feature flags at **call time** (`QUANT_*` pattern)
- `emitTradeIdea` / `EventBus.emit(TRADE_IDEA_GENERATED)` (single choke point before ChiefTrader)
- `TRADE_IDEA_REJECTED` + `noTradeReasons.json`
- CORE + experimental `evaluate()` modules (research/backtest via `findStrategy` without live flags)
- `GET /api/v2/opportunities` (agent_predictions — do not overload as a penny scanner)
- Strategy Scanner RSI scan (honest empty states)
- `researchSafety.json` spread/slippage (research costs, not live quotes)
- Organic paper classifier (`execution_environment`, soak floors)

## Proposed extension points (flag OFF = identity)

1. **Config** `config/multiAsset.json` — classes, ETF allowlist, uncalibrated thresholds, profiles, env var names.
2. **Classifier / profiles / router / safety filter** under `src/server/multiAsset/` — pure functions. No OMS, no BrokerManager, no `placeOrder`.
3. **Idea choke** inside existing `EventBus` TRADE_IDEA_GENERATED gate — extra BLOCK only when flags are on and class is PENNY_STOCK/MICRO_CAP. SELL/exits passthrough (still 24 gates).
4. **Optional strategy intersection** in `evaluateAll()` when `ctx.assetClass` is set and penny flag is on. CORE live set for AAPL/ETF/UNKNOWN **unchanged**.
5. **Subordinate notional clamp** in RiskEngine before `calculatePositionSizing` — `min(global, profile)` never loosens global caps. Identity when flags off.
6. **Research cost overlay** — never cheaper than `researchSafety` global bps. Zero-cost still cannot promote.
7. **Read-only API** `GET /api/v2/multi-asset/*` — OPPORTUNITY ≠ ORDER.
8. **Scanner UI panel** on existing Strategy Scanner — honesty labels ELIGIBLE / WATCH / BLOCKED.

## Files that should remain untouched (behavior)

Do not rewrite: RiskEngine gate ladder, OMS `placeOrder` MARKET payload, BrokerManager, ChiefTrader quorum, `PAPER_TRADING_ONLY` / LIVE_ARM, fill ledger, reconciliation auto-flatten policy, organic-paper rules, `strategiesEngine/` isolation, CORE strategy `evaluate()` math.

Allowed surgical hooks only: EventBus idea gate, optional `StrategyContext.assetClass`, RiskEngine notional `Math.min` (flagged), v2 router mount, Strategy Scanner panel, `.env.example` flags default **false**.

## Architectural conflicts (do not silently “fix”)

| Conflict | Decision |
|---|---|
| OMS is MARKET-only; pennies often need LIMIT | **Do not change OMS.** Penny/micro BUY ideas BLOCK when penny flag is on, because MARKET is marked unfit in config. LIMIT requires a separately audited OMS change. |
| No 25th RiskEngine gate without breaking `phase21` catalog length | Extra penny rules live **upstream** of ChiefTrader (idea BLOCK) + subordinate sizing clamp. All 24 gates still run on anything that is approved. |
| No market cap / ask / dollar volume on the live quote | Classifier prefers **UNKNOWN** over a guessed cap bucket. ETF from allowlist. Optional symbol overrides (AAPL etc.) are explicit config, not inference. Price-below-threshold penny heuristic is **UNCALIBRATED**. |
| Missing spread | Penny/micro BUY → BLOCK (fail-closed). LARGE_CAP/ETF/UNKNOWN → passthrough so AAPL/QQQ/IWM do not regress. |
| News/catalyst for small names | Catalyst+momentum stays **UNAVAILABLE** as a live edge. Scanner must not invent a catalyst. |
| Quant default off; CORE untested on pennies | Do not set `QUANT_ENGINE_ENABLED=true`. Penny `permittedStrategyIds` defaults to **[]** (no live Quant strategy auto-enabled for pennies). |
| ChiefTrader still needs 2 agents at 0.75 | Do not lower quorum. If pennies never approve, that is a **reportable fact**, not a bypass. |

## Regression risks

- Hooking EventBus incorrectly could reject AAPL ideas when flags are off → every idea-gate test and paper path.
- Filtering `evaluateAll()` without `assetClass` would change CORE for everyone.
- A 25th gate or OMS LIMIT would fail phase21 / OMS tests.
- Enabling env flags in default `.env` would change production behavior.

## Compatibility

- Feature flags default **unset/false**. Existing tests and paper/LIVE posture unchanged.
- No schema migration in this pass (opportunities are computed + EventBus; traces keep `traceId`).
- LIVE stays disarmed. New classes, if any idea survives, still get `execution_environment` from existing OMS classification.

## Implementation order

A this document → B classifier → C profiles → D safety filter → E flagged strategy routing → F research cost overlay → G paper path via existing `emitTradeIdea` → H UI → I full tests + report.
