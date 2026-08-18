# Strategies Engine

A standalone, isolated strategy-definition/research subsystem living at `src/server/strategiesEngine/`. It is **not** connected to Argus's live trading path.

## 1. Architecture

### Why this location and shape

Argus already has a live-reachable quant engine at `src/server/quant/strategies/` (`StrategyEngine.ts`, `CORE_STRATEGIES`/`EXPERIMENTAL_STRATEGIES`), consumed directly by `BacktestEngine` and `QuantSignalAgent`, which itself feeds the live decision path (`EventBus → agents → ChiefTraderAgent → RiskEngine → OrderManagementService → BrokerManager`). That engine's `StrategyContext` type is therefore a live-path type — importing it here would create exactly the coupling this phase is required to avoid.

The Strategies Engine is a **second, separate** subsystem under `src/server/strategiesEngine/`, with its own types (`MarketSnapshot` instead of `StrategyContext`), its own condition interpreter, and its own registry. It reuses the *math* from `src/server/quant/indicators/*` and `src/server/quant/statistics.ts` (pure functions, no side effects, not part of the live path themselves — `BacktestEngine` already calls them read-only the same way) via one real adapter (`core/MarketSnapshot.ts`'s `buildMarketSnapshotFromBars`), so no indicator is reimplemented. It does **not** import `StrategyContext`, `ChiefTraderAgent`, `RiskAgent`, `OrderManagementService`, `BrokerManager`, or `EventBus`, and nothing on the live path imports this engine. Verified via `grep -r` sweeps in both directions (see §18).

### Directory structure

```
src/server/strategiesEngine/
├── core/
│   ├── types.ts                 StrategyDefinition, conditions, rules, metadata
│   ├── MarketSnapshot.ts        this engine's own evaluation-input type + real bars adapter
│   ├── id.ts                    deterministic id: canonical JSON + sha256
│   ├── createStrategy.ts        factory + bumpVersion (immutable versioning)
│   └── StrategyPerformance.ts   future performance/ranking interfaces (no computation)
├── conditions/
│   ├── ConditionTypes.ts        LeafCondition / CompositeCondition (AND/OR/NOT/XOR) DSL
│   ├── conditionCatalog.ts      the real, enumerable list of every leaf type implemented
│   └── evaluateCondition.ts     the one interpreter for the condition DSL
├── registry/
│   └── StrategyRegistry.ts      register/get/getByFamily/getByTag/search/listAll/count/remove/versions
├── generators/
│   ├── ParameterSpace.ts        lazy parameter-combination iterator (never eager Cartesian)
│   ├── StrategyVariantGenerator.ts  template -> many real StrategyDefinitions, dedup by id
│   └── composeAxes.ts           shared timeframe/stop/risk axes applied across all templates
├── families/
│   └── catalog.ts               15 real base templates + honest METADATA_ONLY family list
├── validation/
│   └── validateStrategy.ts      structural + compatibility validation, never throws on bad input
├── serialization/
│   └── serialize.ts             JSON round-trip with tamper/corruption detection
└── index.ts                     public API (Section 23)
```

## 2. What this engine does

- Represents strategies as **composable condition trees** (`ConditionNode`), not one flat interface or N hand-written classes.
- Evaluates those trees for real against real market data (`buildMarketSnapshotFromBars`, backed by the existing RSI/MACD/ADX/ATR/VWAP/SMC engines).
- Generates **real, deterministic, non-duplicate parameterized variants** from a small set of hand-authored templates — 15 family templates × 3 shared risk/timeframe axes currently produce **10,320** genuinely distinct configurations (verified by `generators/StrategyVariantGenerator.test.ts`; exact figures come from `getEngineStats()`, never a bare claim).
- Validates, serializes, versions, and catalogs those definitions independently of any execution system.

## 3. What this engine explicitly does NOT do

- Does not place orders, call a broker adapter, or touch `OrderManagementService`/`BrokerManager`.
- Does not run inside `ChiefTraderAgent`'s or `RiskAgent`'s decision loop.
- Does not automatically generate or execute trades from any signal it computes.
- Does not fabricate performance numbers, win rates, or Sharpe ratios — `core/StrategyPerformance.ts` defines only the *shape* a future real backtest result would take.
- Does not claim a family is real when Argus has no data/infra to back it (see §6).

## 4. Strategy model

`StrategyDefinition` (`core/types.ts`) separates:

- `entryConditions` / `confirmationConditions` / `invalidationConditions` / `exitConditions` — distinct condition trees, not one `if → BUY`.
- `stopLoss` / `takeProfit` / `positionSizing` — typed rule objects (`kind` + `value` + `basis`), not magic numbers.
- `parameters` (the real tunable space) vs `parameterValues` (this instance's concrete choice).
- `metadata.origin`: `'BASE' | 'VARIANT' | 'GENERATED'` — never conflates a hand-authored strategy with a generated one.
- `implementationStatus`: `'REAL' | 'METADATA_ONLY'` — carries the same honesty convention already established in `config/quantMasterTaxonomy.json`'s `NOT_SUPPORTED` entries into this new engine, rather than re-litigating it. Validation rejects a non-`BASE` strategy marked `METADATA_ONLY` — a generated/variant strategy must be real and evaluable.

## 5. Condition system

A `ConditionNode` is either a `LeafCondition` (one real primitive: `PriceAbove`, `RSIAbove`, `CrossAbove`, `FVGPriceInZone`, …) or a `CompositeCondition` (`AND`/`OR`/`NOT`/`XOR` over children). It is plain, function-free JSON — trivially serializable and hashable. `conditions/evaluateCondition.ts` is the single interpreter; every leaf reads only real `MarketSnapshot` fields and returns `false` (never throws, never guesses) when an input is `null`/missing.

`FVGDetected` vs `FVGPriceInZone` (and the order-block equivalents) are deliberately distinct: the former means "a Fair Value Gap was found somewhere in recent history," the latter means "price has actually returned into that zone" — the real ICT entry trigger. Collapsing these would have been a materially weaker, less honest condition.

## 6. Strategy families

| Status | Families |
|---|---|
| **REAL** (15 templates) | TREND (2), MOMENTUM (2), MEAN_REVERSION (3), BREAKOUT (2), GAP (1), SUPPORT_RESISTANCE (1), VOLUME (1), VOLATILITY (1), SMART_MONEY (2) |
| **METADATA_ONLY** (27 families) | OPTIONS, MARKET_MAKING, MARKET_MICROSTRUCTURE, ORDER_FLOW, ARBITRAGE, STATISTICAL (pairs/cointegration), MACHINE_LEARNING, AI, EVENT_DRIVEN, FUNDAMENTAL, NEWS_SENTIMENT, MACRO, FOREX, FUTURES, CRYPTO, SEASONAL, PORTFOLIO, RISK, MULTI_TIMEFRAME, INTRADAY, SCALPING, SWING, PULLBACK, CANDLESTICK, FIBONACCI, MARKET_STRUCTURE, PRICE_ACTION |

Every `METADATA_ONLY` family in `families/catalog.ts` carries a one-line, specific reason (missing L2 data, no options chain, no multi-symbol context, no trained model, etc.) — the same convention as `config/quantMasterTaxonomy.json`. A few of these (PULLBACK, CANDLESTICK, FIBONACCI) are real, scoped **gaps** — Argus already computes the underlying data (Fibonacci levels, candlestick patterns) but it isn't wired onto `MarketSnapshot` yet — documented honestly as future work, not faked in this pass.

## 7. Generator

`generators/ParameterSpace.ts` iterates a parameter space **lazily** (a JS generator, odometer-style) — the full Cartesian product is never materialized. `generators/StrategyVariantGenerator.ts` calls a template's real `build(values)` function once per combination; uniqueness is guaranteed **by construction** (the deterministic id is a hash of the actual resulting condition tree + parameter values — two variants can only collide if `build()` produced byte-identical output, which the generator still detects and reports rather than silently double-registering).

`generators/composeAxes.ts` adds three shared, genuinely meaningful axes to every template — timeframe (5), stop-loss ATR multiple (6), risk-per-trade fraction (4) — mirroring the build directive's own "entry × confirmation × timeframe × exit × risk model" example. Each axis changes a real field in the resulting definition (`stopLoss.value`, `positionSizing.value`, `parameterValues`), so no combination is a "same rule, renamed" duplicate.

`generateVariantsAcrossTemplates(templates, { limit })` treats `limit` as a **global** cap spent across templates in order (not per-template), and does not cross-multiply unrelated templates against each other (each keeps its own bounded space) — the "garbage combination" risk Section 9 of the build directive warns about.

## 8. Registry

`registry/StrategyRegistry.ts` is a plain in-memory class — `register`/`get`/`getByFamily`/`getByTag`/`search`/`listAll`/`count`/`exists`/`remove`/`versions`/`clear`. `register()` runs `validateStrategy()` first and throws `InvalidStrategyError` on failure, or `DuplicateStrategyError` on an id collision — it never silently overwrites. `index.ts` exposes one process-wide `defaultRegistry`, pre-seeded with the 15 real `BASE_STRATEGIES`; callers needing isolation construct their own `new StrategyRegistry()`.

## 9. Validation

`validation/validateStrategy.ts` never throws on a malformed object — it is the real gate `deserializeStrategy()` runs arbitrary parsed JSON through, so it defensively checks top-level shape (`parameters` is an array, `metadata.tags` is an array, `stopLoss` is an object, …) before walking deeper structure. It checks: required fields present, condition-tree depth/circularity (genuine object-identity cycles, not merely structurally-identical-but-distinct nodes), `NOT` has exactly one child, no empty composites, parameter ranges are sane (`min <= max`, `step > 0`), and non-`BASE` strategies cannot be `METADATA_ONLY`.

## 10. Serialization

`StrategyDefinition` is already plain JSON (the condition DSL has no functions), so `serializeStrategy`/`deserializeStrategy` are a real `JSON.stringify`/`parse` round trip. `deserializeStrategy` re-validates after parsing and **re-derives the id from the parsed content**, rejecting the blob if the embedded id doesn't match its own content hash — real tamper/corruption detection, not just shape-checking.

## 11. Versioning

`createStrategy()` returns a frozen (`Object.freeze`) object. `bumpVersion(strategy, changes, metadataChanges)` returns a **new** `StrategyDefinition` with `version + 1` (and therefore a new id, since version is part of the identity hash) and `metadata.derivedFromId` pointing at the original — the original is never mutated.

## 12. How to add a new strategy family

1. Confirm the family has a real data source on `MarketSnapshot` (or extend `core/MarketSnapshot.ts`'s adapter with a new field from an existing pure indicator function — never fabricate one).
2. Write a `StrategyTemplate` in `families/catalog.ts`: real `parameters`, a `build(values)` that constructs a genuinely different condition tree per combination.
3. Add it to `FAMILY_TEMPLATES`. It is automatically wrapped with the shared risk axes and included in `REAL_TEMPLATES`.
4. If the family has no real backing yet, add an honest entry to `METADATA_ONLY_FAMILIES` with a specific reason instead.

## 13. How to add a new condition primitive

1. Add the literal to `LeafConditionType` in `conditions/ConditionTypes.ts`.
2. Add it to the runtime list in `conditions/conditionCatalog.ts` (a test cross-checks these two never drift apart).
3. Implement its case in `conditions/evaluateCondition.ts`'s `evaluateLeaf` switch — read only real `MarketSnapshot` fields, return `false` on any missing/null input, never throw.

## 14. How to generate strategy variants

```ts
import { generateStrategies, getEngineStats } from './src/server/strategiesEngine';

const stats = getEngineStats(); // real counts - baseStrategies, realTemplates, totalVariantSpaceSize, ...
const { generated, truncated } = generateStrategies({ limit: 500 }); // bounded, registered into defaultRegistry
```

## 15. How to retrieve a strategy

```ts
import { getStrategy, findStrategies } from './src/server/strategiesEngine';

const s = getStrategy('STRAT-MOM-RSI-MOMENTUM-xxxxxxxx-V1');
const trendStrategies = findStrategies({ family: 'TREND', implementationStatus: 'REAL' });
```

## 16. How future backtesting can consume this engine

`StrategyDefinition.entryConditions` (and its siblings) are pure data — a future backtest adapter can:

1. Build a `MarketSnapshot` per historical bar via `buildMarketSnapshotFromBars` (already real, already used by this engine).
2. Call `evaluateCondition(strategy.entryConditions, snapshot)` at each bar to get a real entry signal.
3. Simulate fills/exits using `strategy.stopLoss`/`takeProfit`/`exitConditions` and record a real `StrategyPerformance` object (`core/StrategyPerformance.ts`).
4. Feed that into `rankStrategies()` for real, evidence-based ranking.

None of this exists yet in this phase — the point is that the types and interpreter are already shaped to make it a real, scoped follow-on rather than a redesign.

## 17. How future trading-flow integration should be done safely

**Do not** import this engine directly into `ChiefTraderAgent`, `RiskAgent`, or any broker adapter. The safe path, when a future phase decides to connect it, is a **new, explicit adapter module** (e.g. `src/server/services/StrategiesEngineBridge.ts`) that:

1. Reads a specific, already-validated, already-backtested `StrategyDefinition` by id.
2. Evaluates it against a real `MarketSnapshot` built from the live pipeline's own bars.
3. Emits a `TRADE_IDEA_GENERATED` event through the **existing** agent-onboarding path documented in `CLAUDE.md`'s "Adding a New Agent" section — going through `ChiefTraderAgent`'s normal consensus/weighting logic and `RiskEngine`'s full gate ladder like any other agent, never bypassing them.

This keeps the dependency direction one-way (bridge → engine, bridge → live path) and the engine itself permanently reusable/testable in isolation.

## 18. Isolation verification

```bash
# Nothing in the engine imports the live path (comments excluded from these being real matches):
grep -rnE "ChiefTrader|RiskAgent|RiskEngine|OrderManagementService|BrokerManager|EventBus" src/server/strategiesEngine

# Nothing outside the engine imports it yet:
grep -rl "strategiesEngine" --include="*.ts" src server.ts scripts | grep -v "^src/server/strategiesEngine/"
```

Both currently return no real matches (the first returns only doc-comment mentions of the isolation contract itself).

## 19. Known limitations (honest, not hidden)

- `MarketSnapshot` is single-symbol, single-timeframe — no real pairs/cointegration, portfolio-level, or multi-timeframe conditions exist yet (tracked as `METADATA_ONLY`, not faked).
- `Slope`/`PercentChange` conditions are real two-point (prior vs current) deltas, not a multi-bar regression slope — `MarketSnapshot.series` only carries two points per series today.
- `RejectsLevel` is a single-bar wick-vs-close check, not the multi-bar false-breakout pattern `indicators/priceAction.ts`'s `detectFalseBreakout` implements — a real, disclosed simplification.
- No backtest runner is wired in yet (§16 above) — `StrategyPerformance` is a real, populated-by-nobody-yet interface.
