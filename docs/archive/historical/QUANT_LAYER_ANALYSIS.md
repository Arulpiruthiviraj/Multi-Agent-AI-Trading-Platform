# QUANT_LAYER_ANALYSIS.md

Deep repository analysis for the requested "professional quantitative decision layer" enhancement, produced per the explicit instruction: **analyze first, wait for approval before implementing.** No code was changed to produce this document.

---

## 0. The headline finding

**A large fraction of what's being requested already exists**, built by a process running concurrently with this session's own hardening work (confirmed via `.env.example`'s `QUANT_ENGINE_ENABLED` block, `SystemBootstrap.ts` wiring `quantSignalAgent.start()`, and a full `src/server/quant/` directory with real tests). It independently arrived at almost the same additive philosophy this request describes, including explicit code comments explaining why it does *not* duplicate `RSIEngine`/`MACDEngine`/`TechnicalIndicators`/`PositionSizing`'s existing correlation math/`AgentSynergy`'s correlation math.

Treating this as a from-scratch build would mean duplicating real, tested, already-integrated work. The right frame is: **audit what exists against the 10-phase spec, then propose the delta.** That's what follows.

---

## 1. Current architecture analysis (as it relates to this request)

```
Real tick data (Alpaca WS) → MarketDataWorker → eventBus.emit('MARKET_DATA')
                                                        │
        ┌───────────────────────────────────────────────┼───────────────────────────────┐
        ▼                       ▼                       ▼                               ▼
  TechnicalAgent         FundamentalAgent          MacroAgent                    QuantSignalAgent (NEW,
  (RSI/MACD/BB,          (AlphaVantage +           (AlphaVantage +                concurrent work, off by
   tick-driven)          AIRouter, 60s timer)      AIRouter, 75s timer)           default via
        │                       │                       │                       QUANT_ENGINE_ENABLED,
        │                       │                       │                       5-min timer over real
        │                       │                       │                       daily OHLCV bars)
        └───────────┬───────────┴───────────┬───────────┴───────────┬───────────────────┘
                     ▼                                               ▼
          eventBus.emit('TRADE_IDEA_GENERATED', {traceId, symbol, side, confidence(0-1), reasoning, agent, currentPrice})
                     │
                     ▼
            ChiefTraderAgent.reviewIdea() → (optional AI debate) → evaluateConsensus()
                     │   agentWeights: TechnicalAgent 0.25, FundamentalAgent 0.20, MacroAgent 0.15,
                     │   NewsAgent 0.25, QuantEngine 0.15 (already reserved for the new agent),
                     │   ConsensusDebate 0.35 (special-cased in resolveWeight)
                     ▼
          EvidenceAggregator.aggregate() → weighted confidence vs CONSENSUS_APPROVAL_THRESHOLD (0.75)
                     │
                     ▼ (only on approval)
          eventBus.emit('CHIEF_APPROVED_IDEA', {traceId, symbol, side, confidence, reasoning})
                     │
                     ▼
          RiskAgent.assessRisk() → RiskEngine.evaluateRisk() [serialized - this session's Phase 1 fix]
                     │   11 gates: emergency_stop, daily_loss, consecutive_loss, portfolio_drawdown,
                     │   order_rate_limit, market_hours, data_freshness, news_veto, price_validity,
                     │   + PositionSizing.ts's symbol/sector concentration, correlation exposure,
                     │   open-positions cap, sufficient-size (real ATR-based sizing)
                     ▼ (only on approval)
          eventBus.emit('RISK_ASSESSMENT_COMPLETED', {..., maxQuantity})
                     │
                     ▼
          OrderManagementService.executeOrder() → BrokerManager → real broker → trades/fills tables
```

Everything above `QuantSignalAgent` is pre-existing and working. `QuantSignalAgent` is new (this session's concurrent work), already wired into every layer below it via the exact same `TRADE_IDEA_GENERATED` contract every other agent uses - no special-casing needed anywhere downstream. This is the "safe extension point" the request asks me to identify: **it already exists and is already in use.**

## 2. Existing calculation inventory

### Pre-existing (before any of this session's work, must not change)
| Engine | Location | Covers |
|---|---|---|
| `RSIEngine.ts` | `src/server/engines/` | RSI (Wilder), singleton, used by `TechnicalAgent`, `BacktestEngine`, and now the new `indicators/momentum.ts` |
| `MACDEngine.ts` | `src/server/engines/` | MACD, same reuse pattern |
| `TechnicalIndicators.ts` | `src/server/engines/` | Shared Bollinger Bands calc, used by `AdvancedQuantEngines.ts`/`Slippage.ts`, and now `indicators/volatility.ts` |
| `TechnicalAgent.ts`'s own `calcBollingerBands` | `src/server/services/` | A *second*, private BB implementation, pre-existing, tick-driven. Not touched by the new quant layer (which correctly uses `TechnicalIndicators.calculateBollingerBands` instead) - a **pre-existing minor duplication**, not introduced by this work, out of scope to "fix" here per the preservation mandate. |
| `PositionSizing.ts` | `src/server/engines/` | Real ATR-based position sizing, symbol/sector concentration caps, `returnCorrelation` (Pearson, scoped to the correlated-exposure risk gate), `SECTOR_MAP`/`getSector` |
| `AgentSynergy.ts` | `src/server/services/` | A third, independent Pearson correlation implementation, scoped to agent-signal correlation (Strategy Synergy Matrix UI) |
| `AdvancedQuantEngines.ts` | `src/server/engines/` | Real ATR/ADX/VWAP-based UPTREND/DOWNTREND/CHOPPY telemetry - **emitted but never consumed by any decision** (a known, pre-existing gap, documented in `CLAUDE.md`) |
| `MarketRegimeAgent.ts` | `src/server/services/` | LLM-based regime guess from general knowledge (not real price data), hardcoded `SIMULATED_BULL_MARKET` fallback without a Gemini key - real, but not deterministic and not what Phase 2 of this request wants |
| `BacktestEngine.ts` | `src/server/engines/backtest/` | Real backtest replay with commissions/slippage/look-ahead-bias guard; its metrics function already computes win rate, profit factor, Sharpe, Sortino, expectancy, max drawdown |

### New (concurrent work, already merged into this working tree, already tested)
| Module | Location | Maps to request's phase | Test status |
|---|---|---|---|
| `indicators/trend.ts` | `src/server/quant/indicators/` | Phase 1 (Trend) | Tested |
| `indicators/momentum.ts` | same | Phase 1 (Momentum) - **imports real `rsiEngine`/`macdEngine`, does not reimplement them** | Tested |
| `indicators/volatility.ts` | same | Phase 1 (Volatility) - **imports real `TechnicalIndicators.calculateBollingerBands`** | Tested |
| `indicators/volume.ts` | same | Phase 1 (Volume) | Tested |
| `indicators/supportResistance.ts` | same | Phase 1 (Support/Resistance) | Tested |
| `indicators/priceAction.ts` | same | Phase 1 (Price Action) | Tested |
| `statistics.ts` | `src/server/quant/` | Phase 5 (Statistical Layer) - **explicitly documents why it doesn't duplicate `PositionSizing.returnCorrelation`/`AgentSynergy.pearsonCorrelation`** | Tested |
| `RegimeEngine.ts` | `src/server/quant/` | Phase 2 (Market Regime Engine) - multi-feature vote, dead-zones, min-real-votes guard, honest `insufficientData` flag | Tested |
| `MarketContext.ts` | `src/server/quant/` | Phase 3 (Market Context) - SPY/QQQ/IWM, sector ETF proxy reusing `PositionSizing.getSector`, relative strength, correlation, beta; breadth honestly reports `available:false` | Tested |
| `strategies/{momentumBreakout,pullbackContinuation,meanReversion,trendFollowing,rangeReversion}.ts` + `StrategyEngine.ts` + `types.ts` | `src/server/quant/strategies/` | Phase 4 (Strategy Engine) - the exact 5 strategy names requested, explicit entry/confirmation/invalidation/stop/target per strategy, `setupScore`/`confidence`/`conditionsMet`/`conditionsFailed`/`contradictions` matching the request's own example shape | **Untested** - `testHelpers.ts` exists but is imported nowhere (dead scaffolding) |
| `QuantSignalAgent.ts` | `src/server/services/` | Phase 3/4 wiring - real singleton, `start()`/`stop()`, off by default (`QUANT_ENGINE_ENABLED`), emits `TRADE_IDEA_GENERATED` as `agent:'QuantEngine'` (a weight for that exact name already existed in `ChiefTraderAgent.ts`, unused until now), persists full assessments to a new `quant_assessments` table, emits `QUANT_ASSESSMENT_COMPLETED` | Tested (9 tests) |
| `quant_assessments` table | `src/server/db/schema.ts` (migration `0018`) | Storage for the above - **already has a `groupedScores` column reserved and commented "Phase 5, null until then"** (their internal numbering for what this request calls Phase 6) | N/A |

**Total: 120 passing tests already cover Phases 1-4 and most of 5.**

## 3. Existing functionality that must NOT change

Everything in the pipeline diagram above `QuantSignalAgent`, unchanged: `RSIEngine`, `MACDEngine`, `TechnicalIndicators`, `TechnicalAgent`, `FundamentalAgent`, `MacroAgent`, `NewsEngine`, `ChiefTraderAgent`'s existing consensus math for every *other* agent, `RiskEngine`'s 11 gates and their evaluation order, `PositionSizing`'s sizing/concentration/correlation math, `BrokerManager`/every broker adapter, `OrderManagementService`, the `trades`/`fills`/`risk_assessments` schema, the WebSocket broadcast contract, and every existing test (534 passing as of the end of this session's own hardening pass - see `ARGUS_HARDENING_VERIFICATION.md`). Also: the new quant layer's own existing files (`RegimeEngine`, `MarketContext`, the 5 strategies, `StrategyEngine`, `statistics.ts`, all 6 indicator files, `QuantSignalAgent`) - these are now "existing functionality" too, as of this analysis, and the same preservation rule applies to them.

## 4. Missing capabilities (the real delta against the 10-phase spec)

Precise, not padded - most of the spec is already done:

- **Phase 1 (indicators)**: **complete, corrected from this document's first draft.** My initial pass missed that `volume.ts`'s `computeVolumeFeatures` already calls `TechnicalIndicators.calculateOBV`/`calculateMFI` (real, pre-existing methods, reused not duplicated), and `supportResistance.ts` already calls `TechnicalIndicators.calculateFibonacciRetracement` (a *previously dead* pre-existing method - this is its first real caller). Both were missed by a grep pattern (`export function \w+`) that only caught locally-declared functions, not method calls on the reused `TechnicalIndicators` class. No further Phase 1 work is needed. Break of Structure/Change of Character remain implicit in `detectMarketStructure`'s trend-transition logic rather than exposed as their own named events - a naming/exposure nuance, not a missing calculation, and not worth a dedicated change on its own.
- **Phase 2 (Regime Engine)**: done.
- **Phase 3 (Market Context)**: done, including the honest breadth-unavailable disclosure.
- **Phase 4 (Strategy Engine)**: done functionally; **zero test coverage** is the real gap (the one piece of this whole layer with no tests at all).
- **Phase 5 (Statistical Layer)**: done.
- **Phase 6 (Probabilistic/grouped-score decision layer)**: **not built.** `quant_assessments.groupedScores` is a reserved, currently-null column - the schema anticipated this, nothing populates it yet. No `trendScore`/`momentumScore`/`volumeScore`/`vwapScore`/`marketScore`/`sectorScore`/`relativeStrengthScore`/`overallSetupScore` computation exists anywhere.
- **Phase 7 (AI integration for contradiction detection)**: **not built.** `QuantSignalAgent` emits a plain reasoning *string* like every other agent (matching the existing contract, which is correct) but nothing feeds the structured `RegimeResult`/`MarketContextResult`/`StrategyEvaluation[]` objects into an AI call for contextual reasoning, contradiction detection, or scenario analysis. `QUANT_ASSESSMENT_COMPLETED` is emitted but has zero consumers anywhere in the codebase (confirmed via repo-wide search) - not even a UI panel.
- **Phase 8 (richer Chief Trader)**: **partially not built.** Chief Trader already *receives* QuantEngine's signal through the standard weighted-evidence path (this is real, working, and correct) - but it receives only `{side, confidence, reasoning}`, not the rich structured payload the request describes (regime object, strategy candidates, contradictions, invalidation conditions, proposed entry/stop/target, expected holding period). `ChiefTraderAgent`'s own output (`CHIEF_APPROVED_IDEA`) also doesn't carry those richer fields to `RiskEngine` or the frontend.
- **Phase 9 (Risk/EV enhancements)**: **partially not built.** Position sizing, stop-distance-implied sizing (via real ATR), daily loss limits, max exposure, correlated exposure, and drawdown monitoring all already exist in `RiskEngine`/`PositionSizing` and must not be duplicated. **Missing**: an explicit risk/reward ratio calculation, expected value calculation, and any Kelly-criterion logic (grepped `PositionSizing.ts` for `kelly`/`expectedValue`/`riskReward` - zero matches).
- **Phase 10 (backtesting per-strategy, per-regime)**: **partially not built.** `BacktestEngine.ts` already computes win rate, profit factor, Sharpe, Sortino, expectancy, and max drawdown (a real, reusable metrics function) but has no awareness of the new `StrategyEngine`/5 named strategies and does not segment results by regime. **Missing** from its metrics specifically: average R-multiple and consecutive-loss count (both explicitly requested, neither present).
- **Cross-cutting gap not named as its own phase but real**: **zero observability.** No route, no frontend widget, anywhere reads `quant_assessments` or listens for `QUANT_ASSESSMENT_COMPLETED`. This entire real, tested capability is currently invisible to a human operator.

## 5. Proposed architecture (additive only, matching the existing quant/ module's own established style)

```
src/server/quant/
  indicators/            [existing - Phase 1, complete, unchanged]
  statistics.ts          [existing - unchanged]
  RegimeEngine.ts         [existing - unchanged]
  MarketContext.ts        [existing - unchanged]
  strategies/             [existing - unchanged logic; ADD test files]
  scoring/                [NEW - Phase 6]
    GroupedScores.ts       - trendScore/momentumScore/volumeScore/vwapScore/marketScore/
                             sectorScore/relativeStrengthScore/overallSetupScore, each computed
                             from ALREADY-COMPUTED Phase 1-4 features (no new data fetching,
                             no new indicator math) - a pure aggregation/weighting layer
    GroupedScores.test.ts
  risk/                   [NEW - Phase 9 delta only]
    ExpectedValue.ts        - riskReward(), expectedValue(), fractionalKelly() - pure functions,
                             consumed by PositionSizing.ts as an ADDITIONAL input to its existing
                             sizing decision, never a replacement for its existing hard caps
    ExpectedValue.test.ts
  ai/                     [NEW - Phase 7]
    QuantContradictionAnalyzer.ts  - takes a RegimeResult + StrategyEvaluation[] + GroupedScores,
                             calls AIRouter.getInstance().routeTask() (same contract every other
                             AI-calling agent uses - no new AI plumbing), asks for contradiction/
                             scenario commentary ONLY, never a re-derived BUY/SELL/confidence
                             number - the deterministic values it was given are the ones that
                             flow onward untouched (matches the request's explicit "AI must NOT
                             overwrite deterministic calculations" rule)
    QuantContradictionAnalyzer.test.ts

src/server/services/QuantSignalAgent.ts   [MODIFIED, additively]
  - after evaluateAll(), ALSO compute GroupedScores and (if AI available) run
    QuantContradictionAnalyzer; persist both into quant_assessments (groupedScores column
    already reserved; one new nullable column for contradiction commentary)
  - TRADE_IDEA_GENERATED payload gains an OPTIONAL structured `quantDetail` field (regime +
    strategy + groupedScores + contradictions) alongside the existing required
    {traceId,symbol,side,confidence,reasoning,agent,currentPrice} fields every consumer already
    expects - purely additive, no existing field renamed/removed/retyped

src/server/services/ChiefTraderAgent.ts   [MODIFIED, additively]
  - evaluateConsensus() already stores each idea in `this.recentIdeas` (an array of the full idea
    object) - it ALREADY has access to `idea.quantDetail` if present, no interface change needed
    to receive it
  - CHIEF_APPROVED_IDEA payload gains an OPTIONAL `supportingQuantDetail` field, populated only
    when the approved idea (or one of the evidence entries) carried one - existing consumers that
    don't read this new field are completely unaffected

src/server/engines/PositionSizing.ts   [MODIFIED, additively]
  - one new exported function, e.g. `computeExpectedValue(entry, stop, target, winRateEstimate)`,
    called by RiskEngine's existing sizing step as an ADDITIONAL logged/returned value on the
    assessment - never as a new hard gate, never able to increase size beyond the existing caps
    (matches the request's explicit "never allow a mathematical sizing model to bypass hard risk
    limits" rule)

src/server/engines/backtest/BacktestEngine.ts   [MODIFIED, additively]
  - new optional entry point, e.g. `backtestStrategy(strategyId, symbol, dateRange)`, that runs
    ONE named quant strategy (via StrategyEngine) against real historical bars using the EXISTING
    metrics function (win rate/Sharpe/Sortino/expectancy/max-drawdown, already correct) plus two
    new metrics (avg R-multiple, consecutive-loss count) and segments results by the real regime
    at each trade's entry (via RegimeEngine, already real) - the EXISTING backtest entry point
    (whatever currently drives replay-parity testing) is untouched

New frontend (additive only, new tab/panel, nothing existing modified):
  - A read-only "Quant Signals" panel reading a new GET /api/v2/quant/assessments/:symbol route
    (new route file or a new section in v2System.ts, following its own established
    {ok, available, data, reason?} convention) - the Phase-11-equivalent observability fix for
    this specific new capability
```

## 6. Exact files/classes/modules that would be changed

| File | Change | Risk |
|---|---|---|
| `src/server/services/QuantSignalAgent.ts` | Add grouped-scores + optional AI-contradiction step to `evaluateSymbol()`; add optional `quantDetail` to the emitted idea | Low - purely additive fields, existing behavior (regime/strategy-derived idea, DB persistence) unchanged |
| `src/server/services/ChiefTraderAgent.ts` | Populate `supportingQuantDetail` on `CHIEF_APPROVED_IDEA` when available | Low - new optional field only |
| `src/server/engines/PositionSizing.ts` | Add EV/R:R helper, surfaced as additional data on the existing sizing return object | Low - additive field; existing sizing/cap logic untouched |
| `src/server/engines/backtest/BacktestEngine.ts` | Add a new, separate strategy-backtest entry point + 2 new metrics | Low - new function, existing backtest path untouched |
| `src/server/db/schema.ts` | Populate `quant_assessments.groupedScores` (column already exists); add one new nullable column for AI-contradiction commentary | Low - additive column, real migration required |
| `src/server/core/SystemBootstrap.ts` | None required - `quantSignalAgent.start()`/`.stop()` already wired | None |
| New route file (or `v2System.ts` addition) | New read-only GET endpoint | Low - additive route |
| New frontend panel | New tab/panel only | Low - no existing component touched |

## 7. New files/classes/modules required

- `src/server/quant/scoring/GroupedScores.ts` + test
- `src/server/quant/risk/ExpectedValue.ts` + test
- `src/server/quant/ai/QuantContradictionAnalyzer.ts` + test
- `src/server/quant/strategies/*.test.ts` (5 files) + `StrategyEngine.test.ts` - **closing the one real test gap in the existing new work**, not a new capability
- New frontend component + new route (naming TBD, proposed: `QuantSignalsPanel.tsx` + `GET /api/v2/quant/assessments/:symbol`)

## 8. Dependency impact

All new dependencies are on already-real, already-tested internal modules: `RegimeEngine`, `MarketContext`, `StrategyEngine`, `AIRouter.routeTask()` (same contract every agent already uses - no new AI plumbing), `PositionSizing.getSector`/existing sizing return shape, `BacktestEngine`'s existing metrics function. Zero new third-party npm dependencies required - everything is pure TypeScript math plus reuse of existing real infrastructure (DB, EventBus, AIRouter, HistoricalDataGateway).

## 9. Data requirements

No new data source. Everything draws on `ohlcv_bars` (already Alpaca-backed, already used by `HistoricalDataGateway`) for price/volume, and `AIRouter` for the one new LLM call (Phase 7's contradiction analyzer) - itself gated the same way `FundamentalAgent`/`MacroAgent` already gate their own AI calls (`GEMINI_API_KEY` presence), so it degrades honestly (skips AI commentary, keeps the deterministic values) rather than failing when no AI provider is configured.

## 10. Performance implications

`QuantSignalAgent` already runs on its own 5-minute timer (or `QUANT_ENGINE_INTERVAL_MS`), off by default - this proposal adds one more per-cycle computation (grouped scores, pure math, negligible cost) and one optional AI call per cycle per symbol (only when `GEMINI_API_KEY` is set and only at the existing cadence, not per-tick) - matching `FundamentalAgent`/`MacroAgent`'s own existing AI-call cadence and cost profile, including this session's own Phase 7 caching pattern (cache the AI-analysis result by content hash so an unchanged assessment doesn't re-pay for a duplicate LLM call). The new `BacktestEngine` entry point runs on-demand only (never on a timer), same as the existing backtest path.

## 11. Risk of regression

Very low, by construction: every proposed change is either (a) a brand new file with no existing caller, or (b) an additive optional field on an existing event/return object that no existing consumer reads yet. The one place with real (if still low) risk is `ChiefTraderAgent.ts` - any edit there touches the real consensus path - so that change should be the most heavily tested of the batch and should ship with an explicit before/after comparison against `ChiefTraderAgent.test.ts`'s existing 2 tests, run before and after, exactly as every phase in this session's own hardening pass was verified.

## 12. Testing strategy

Matches this session's own established pattern throughout the hardening pass: pure-function unit tests for `GroupedScores`/`ExpectedValue` (fixture-based, no mocks needed, same style as `statistics.test.ts`); a mocked-`AIRouter` test for `QuantContradictionAnalyzer` (same style as `FundamentalAgent.test.ts`/`MacroAgent.test.ts`); real isolated-DB integration tests for the new `BacktestEngine` entry point (same style as `OrderManagement.lifecycle.test.ts`); and - closing the existing gap - real fixture-based tests for the 5 existing strategy files and `StrategyEngine.ts`, which currently have none. Every new/changed file gets its own test run immediately, then the full suite, before moving to the next file - the same phase-by-phase discipline as `ARGUS_HARDENING_CHANGELOG.md`.

## 13. Rollback strategy

Every new capability is either off by default (`QUANT_ENGINE_ENABLED`, already the existing convention) or additive-only (new optional fields, new files, new routes). Rolling back means: don't set the env var, or revert the specific new file/field - nothing downstream breaks because nothing downstream is required to read the new fields. The one schema change (a new nullable column) is forward-only per this codebase's existing migration convention (matches how this session's own Phase 2 unique-index migration was handled) - safe to leave in place even if the feature using it is later disabled.

## 14. Implementation phases (proposed order, each independently shippable and testable)

1. **Close the existing test gap** (strategies/`StrategyEngine.test.ts`, 6 files) - zero new capability, pure risk reduction on already-shipped code. Lowest risk, do first.
2. **Phase 6 - Grouped/probabilistic scores** (`scoring/GroupedScores.ts`) - pure aggregation of already-computed features, no new external calls.
3. **Phase 9 delta - Expected Value / R:R** (`risk/ExpectedValue.ts`) - pure math, feeds `PositionSizing.ts` as an additional data point only.
4. **Phase 10 delta - per-strategy/per-regime backtesting** (`BacktestEngine.ts` new entry point) - the biggest single piece of new logic; benefits from Phases 1-3 already being real and tested.
5. **Phase 7 - AI contradiction analyzer** - depends on Phase 6's grouped scores existing to have something structured to hand the AI.
6. **Phase 8 - richer Chief Trader payload** - wires everything above into the existing consensus path; done last and most carefully, since it's the one change touching the live decision pipeline.
7. **Observability** - new read-only route + frontend panel, once there's something real worth displaying.

---

**Waiting for approval before implementing any of the above**, per instruction. My recommendation, if useful input for that decision: items 1-3 are safe enough to approve as a single batch (zero product-judgment calls, pure risk reduction plus pure math); items 4-6 involve real design choices (exact scoring weights, exact AI-contradiction prompt framing, exactly which new fields `CHIEF_APPROVED_IDEA` gains) worth a quick confirmation before I commit to specifics; item 7 is cosmetic and can follow whenever.
