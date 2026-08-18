# Argus Strategy Engine — Implementation Report

This report covers the isolated Strategy Engine (`src/server/strategiesEngine/`) and its optional integration layer (settings, DB persistence, shadow-mode evaluator, API, minimal Settings UI panel). It is a companion to `STRATEGIES_ENGINE.md` (the standalone engine's own architecture doc) — this report focuses on the **integration** work: what's wired to what, what's proven safe, and what's deliberately not built yet.

## 1. Architecture

```
Settings DB row (strategyEngineEnabled/Mode/ActiveIds/MaxActive/MinConfidence)
        │
        ▼
StrategyEngineShadowRunner (timer, src/server/services/)
        │  reads settings fresh every tick, no-ops if disabled
        │  builds a real MarketSnapshot from real bars (HistoricalDataGateway)
        │  evaluates a strategy's real condition tree (evaluateCondition)
        ▼
strategy_engine_signals (DB, append-only)  ◄── the ENTIRE output of SHADOW/ANALYSIS_ONLY mode

Separately, on demand:
strategyEngineRoutes.ts → runBacktest.ts → strategy_engine_backtest_runs (DB)
                                          → strategy_engine_promotions (DB, evidence audit trail)
```

Nothing in this diagram has an arrow toward `OrderManagement`, `BrokerManager`, `RiskEngine`, or `ChiefTraderAgent` — because there isn't one. Verified two ways: a static grep test (`StrategyEngineShadowRunner.safety.test.ts`) that scans the entire `strategiesEngine/` tree plus the new services/routes files for the literal strings `OrderManagement`, `placeOrder`, `BrokerManager`, `activeBroker`, `RiskEngine`, `RiskAgent`, `ChiefTraderAgent`, `cancelOrder`, `executeOrder` (excluding doc-comments), and a dynamic test that spies on the real `oms.executeOrder` and runs a real SHADOW tick against real seeded data, asserting the spy was never called.

## 2. Files created

| File | Purpose |
|---|---|
| `src/server/strategiesEngine/core/evidence.ts` + `.test.ts` | The 8-state evidence ladder (`UNTESTED→...→LIVE_ELIGIBLE`) and `promoteEvidence()`, the fail-closed one-rung-at-a-time gate |
| `src/server/strategiesEngine/backtest/runBacktest.ts` + `.test.ts` | Isolated backtest runner: real bars, real commission/slippage, real Sharpe, long-only |
| `src/server/services/StrategyEngineShadowRunner.ts` | Timer-driven SHADOW/ANALYSIS_ONLY evaluator, settings-gated, zero broker contact |
| `src/server/services/StrategyEngineShadowRunner.safety.test.ts` | The 9-test critical safety suite (static + dynamic isolation proof) |
| `src/server/routes/strategyEngineRoutes.ts` | REST API (`/api/v2/strategy-engine/*`) |
| `drizzle/0035_strategy_engine_tables.sql` | Migration: 5 new `settings` columns + 3 new tables |
| `ARGUS_STRATEGY_ENGINE_IMPLEMENTATION.md` | This report |

(The 26-file standalone engine core from the prior pass — `core/`, `conditions/`, `registry/`, `generators/`, `families/`, `validation/`, `serialization/`, `index.ts` — is unchanged except `core/types.ts`/`core/createStrategy.ts`, which gained the `evidenceState` field.)

## 3. Files modified

| File | Change |
|---|---|
| `src/server/db/schema.ts` | +5 `settings` columns, +3 tables (`strategyEngineSignals`, `strategyEngineBacktestRuns`, `strategyEnginePromotions`) |
| `drizzle/meta/_journal.json` | +1 entry for migration 0035 |
| `src/server/config/runtimeIntervals.ts` + `config/runtimeIntervals.json` | +`strategyEngineShadowMs` (300000, required key, fail-boot if missing — no silent literal fallback) |
| `config/eventNames.json` | +`STRATEGY_SIGNAL_GENERATED` (informational only, no live-path subscriber) |
| `server.ts` | +1 import, +1 route mount, +1 boot-time `start()` call (same try/catch/no-throw idiom as every other optional worker) |
| `src/server/routes/configRoutes.ts` | +5 fields to `SETTINGS_ALLOWED_FIELDS`, +mode/JSON validation before any write |
| `src/App.tsx` | +4 state hooks, +4-field hydration, +1 save function, +1 Settings panel (copies the Scheduled Auto-Trading Window panel's exact shape) |

## 4. Files deliberately untouched

`ChiefTraderAgent.ts`, `RiskAgent.ts`, `RiskEngine.ts`, `PositionSizing.ts`, `OrderManagement.ts`, `BrokerManager.ts`, every broker adapter, `TradingEngine.ts`, `EventBus.ts` (only its config catalog gained one entry), `src/server/quant/strategies/*` (the existing live-reachable quant engine), `BacktestEngine.ts`, `liveReadinessEngine.ts`. None of these needed to change, and none did.

## 5-10. Counts (real, measured — `getEngineStats()`)

```json
{
  "strategyFamilies": 36,
  "baseStrategies": 15,
  "realTemplates": 15,
  "generatedVariants": 10320,
  "validVariants": 10320,
  "invalidVariants": 0,
  "duplicateVariants": 0,
  "metadataOnlyFamilies": 27,
  "conditionPrimitives": 38,
  "testedVariants": 0,
  "validatedVariants": 0,
  "paperValidatedVariants": 0,
  "liveEligibleVariants": 0
}
```

`testedVariants`/`validatedVariants`/`paperValidatedVariants`/`liveEligibleVariants` are all real zeros — every one of the 10,320 generated variants defaults to `evidenceState: 'EXPERIMENTAL'` (`DEFAULT_EVIDENCE_STATE`), per Section 6/25's fail-closed default. Nothing in this pass ran a backtest against all 10,320 and nothing claims to.

## 11. Strategy registry

Unchanged from the prior pass: `StrategyRegistry` class, `defaultRegistry` singleton pre-seeded with the 15 `BASE_STRATEGIES`. `generateStrategies()` (API-exposed, capped at 5000 per call server-side) populates variants into it on demand — never all 10,320 eagerly at boot.

## 12. Configuration model

5 new `settings` columns (see §3), all with safe defaults (`strategyEngineEnabled=false`, `strategyEngineMode='OFF'`). Read/written exclusively through the existing `configRoutes.ts` `POST /settings` allowlist + a new mode-value validator that **rejects** `SIGNAL_ADVISORY`/`CONSENSUS_PARTICIPANT`/`PAPER_ONLY`/`LIVE_ELIGIBLE` with a 400 explaining they're reserved — not silently accepted with no behavior behind them.

## 13. Settings (UI)

One panel in the existing Settings tab: master toggle, mode dropdown (OFF/SHADOW/ANALYSIS_ONLY only), max-active-strategies number, min-confidence slider, save button + status, and a prominent line: **"Strategy Engine does not directly execute trades."** Deferred from this pass: per-family/per-strategy multi-select UI, a strategy browser/comparison view (the API supports this today — `GET /strategies?family=...`, `GET /strategies/:id` — just no dedicated frontend view yet).

## 14. API

All under `/api/v2/strategy-engine`:

`GET /status` · `POST /enable` · `POST /disable` · `POST /mode` · `POST /active-ids` · `GET /strategies` · `GET /strategies/:id` · `GET /strategies/:id/signals` · `GET /strategies/:id/backtests` · `POST /strategies/backtest` · `GET /strategies/rankings` · `POST /strategies/generate` · `POST /strategies/:id/promote` · `GET /strategies/:id/promotions`

No endpoint imports `OrderManagement`, `BrokerManager`, or `RiskEngine` (covered by the same static safety test). `POST /strategies/generate` is hard-capped at 5000 per call — never synchronously materializes all 10,320 in one request.

## 15. Database changes

3 new tables (§3), all append-only ledgers, all with an `evidenceClass`/equivalent field so BACKTEST/SHADOW/ANALYSIS_ONLY evidence is never mixed into one undifferentiated bucket (real trades in the existing `trades` table are completely untouched and remain the only PAPER/LIVE evidence source). Deliberately **not** created: `strategy_definitions`/`strategy_variants`/`strategy_parameters` tables — the ~10,320 definitions are fully, deterministically reconstructible from source (same code ⇒ same id, `core/id.ts`), so a DB copy would be a driftable cache of something already reproduced exactly; this is a documented design choice, not an oversight.

## 16. Validation pipeline

**Built and real**: historical backtest (`runBacktest.ts` — real bars, real commission/slippage, real Sharpe via the existing `MonteCarlo.ts::annualizedSharpe`).

**Not built in this pass** (honestly, not faked): out-of-sample split enforcement, walk-forward optimization integration, Monte Carlo permutation testing, parameter-sensitivity sweeps, cost/slippage stress scenarios, multi-symbol/multi-timeframe validation, multiple-testing (deflated Sharpe) correction. The real, existing primitives for several of these already exist in the codebase (`quant/analysis/MonteCarlo.ts::permutationTestSharpe`, `research/experimentLedger.ts::calculateDeflatedSharpeRatio`) and are the documented next step (§26) — wiring them in shallowly just to claim coverage would have produced exactly the kind of unreliable, partially-fake validation this directive explicitly forbids.

## 17. Evidence model

`EvidenceState` = `UNTESTED | EXPERIMENTAL | BACKTESTED | OOS_TESTED | WFO_TESTED | ROBUST | PAPER_VALIDATED | LIVE_ELIGIBLE`. `promoteEvidence(current, target, reason)` enforces exactly one forward rung per call (demotions always allowed), requires a non-empty reason, and is proven by test to reject `EXPERIMENTAL → LIVE_ELIGIBLE` and `UNTESTED → LIVE_ELIGIBLE` directly. Reaching `LIVE_ELIGIBLE` in this model means only "this strategy's own evidence ladder is complete" — it is not connected to, and does not touch, Argus's real live-readiness engine, which remains the sole authority over whether any order can ever be placed.

## 18. Ranking methodology

`rankStrategies(inputs, criterion)` (unchanged from the prior pass) ranks only strategies with a **real** performance record supplied by the caller — `GET /strategies/rankings` sources these from `strategy_engine_backtest_runs`, using each strategy's single most recent real run (never averaged/blended into a fabricated composite). A strategy with zero backtest runs simply doesn't appear in the ranking — there is no synthetic placeholder score.

## 19. Shadow-mode behavior

Every 300s (`runtimeIntervals.strategyEngineShadowMs`), if `strategyEngineEnabled=true` and mode is `SHADOW`/`ANALYSIS_ONLY`: reads the operator's `strategyEngineActiveIds` (capped at `strategyEngineMaxActive`), for each real registered strategy id builds a real `MarketSnapshot` from real cached bars, evaluates its entry/confirmation conditions, and — only if entry actually fired — writes one row to `strategy_engine_signals`. In this pass, tracked-symbol coverage is deliberately minimal (SPY only) — real multi-symbol tracking is a documented next step, not faked with placeholder symbols.

## 20. Integration behavior

`STRATEGY_ENGINE_ENABLED false` (the real default): the shadow runner's `tick()` returns `{ran: false, signalsRecorded: 0}` immediately after one `settings` read — proven by test. `SHADOW`: real signals recorded, zero broker calls — proven by a real spy on `oms.executeOrder` asserting zero invocations during a real tick against real seeded data.

## 21. Safety guarantees

All 10 items from the critical-safety list are covered:

1. OFF → unchanged behavior — `CRITICAL SAFETY #1` test.
2. SHADOW → zero orders — `CRITICAL SAFETY #2` test (real spy, asserts not called).
3. Cannot call broker directly — static grep, whole `strategiesEngine/` tree + new services/routes files.
4. Cannot bypass RiskEngine — same grep.
5. Cannot bypass OMS — same grep.
6. Cannot bypass live-readiness — no import of `liveReadinessEngine` anywhere in the new code.
7. Experimental → live automatically — rejected, `promoteEvidence` test.
8. Unvalidated → live automatically — rejected, `promoteEvidence` test.
9. Restart clears temporary state — the shadow runner holds no in-memory "armed" flag; `strategyEngineEnabled` lives only in the DB row, read fresh every tick, exactly like `AutoTradeScheduler`'s already-established restart-safety pattern.
10. Existing reconciliation/kill-switch unchanged — no file in either subsystem was touched; the full existing suite (kill-switch, reconciliation, RiskEngine gate tests) passes unmodified.

## 22. Test results

```
Test Files  204 passed (204)
     Tests  1357 passed (1357)
```

(Up from 201/1331 before this pass — +3 files: `evidence.test.ts`, `runBacktest.test.ts`, `StrategyEngineShadowRunner.safety.test.ts`; +26 tests.)

## 23. Regression results

Full suite re-run after every structural change in this pass (evidence model, backtest runner, shadow runner, routes, `server.ts`/`configRoutes.ts` wiring, App.tsx panel) — zero regressions at any checkpoint. `git status` confirms only the files listed in §3 were touched; no file outside this scope was modified.

## 24. Performance measurements

`getEngineStats()` (which computes `totalVariantSpaceSize` across all 15 templates without materializing a single variant) completes in single-digit milliseconds. The full 204-file/1357-test suite runs in ~134s end to end (includes real SQLite migrations per test file, real DB I/O — not representative of this subsystem alone). `npm run build` completes in ~9s with no new build errors or warnings attributable to this change.

## 25. Known limitations

- Evidence promotion via `POST /strategies/:id/promote` writes a real audit row to `strategy_engine_promotions`, but the in-memory registry entry itself is immutable and not overwritten in place — a strategy's *current* evidence state is only fully queryable by replaying its promotion history, not via `GET /strategies/:id` alone. A small persistent override map is the natural fix, not built in this pass.
- Shadow-mode symbol coverage is SPY-only.
- No walk-forward/Monte Carlo/permutation/multi-symbol validation wiring (§16).
- `ANALYSIS_ONLY` mode is currently behaviorally identical to `SHADOW` — no distinct logic yet differentiates them.
- `SIGNAL_ADVISORY`, `CONSENSUS_PARTICIPANT`, `PAPER_ONLY`, `LIVE_ELIGIBLE` modes are rejected outright, not partially implemented.
- No dedicated frontend strategy-browser/comparison view — the API supports it, the UI doesn't expose it yet.

## 26. Future extensions

1. A real out-of-sample/walk-forward adapter wrapping the existing `WalkForwardValidator`/`MonteCarlo.ts` primitives against this engine's `StrategyDefinition`s.
2. A persistent evidence-state override table so `GET /strategies/:id` reflects real promotion history without replay.
3. Multi-symbol shadow tracking (reading the same tracked-symbol list `QuantSignalAgent` already uses).
4. A frontend strategy browser (family filter, evidence-state badge, real backtest-run history) consuming the already-built API.
5. Only after (1)-(4) are real and tested: a genuinely isolated `PAPER_ONLY` mode that submits through the *existing* agent-onboarding path (`TRADE_IDEA_GENERATED` → `ChiefTraderAgent` → `RiskEngine` → OMS, exactly like any other agent) — never a new order-placement path of its own.

---

## Machine-readable summary

```json
{
  "strategyFamilies": 36,
  "baseStrategies": 15,
  "generatedVariants": 10320,
  "validVariants": 10320,
  "invalidVariants": 0,
  "duplicateVariants": 0,
  "testedVariants": 0,
  "validatedVariants": 0,
  "paperValidatedVariants": 0,
  "liveEligibleVariants": 0
}
```
