# Argus Exit Intelligence Engine — Implementation Plan

Read-only audit, per instruction. No code changed to produce this document. Companion to `ARGUS_ARCHITECTURE_PROTECTION.md` (the immutability contract this plan is designed to respect).

## 1. Current exit architecture (verified against live code)

`src/server/services/PortfolioMonitor.ts` already runs a real, continuous exit loop, independent of the opportunity-discovery side:

- `PortfolioMonitorWorker.reviewPortfolio()` — `setInterval` on `runtimeIntervals.portfolioMonitorMs` (60s), with an in-flight guard (`isReviewing`) so a slow cycle never overlaps the next tick.
- For every open position, in priority order:
  1. **Quant strategy stop/target** (`trades.quantStopPrice`/`quantTargetPrice`, captured at entry) — `EXIT_CODE=TARGET_REACHED` / `EXIT_CODE=HARD_STOP`.
  2. **Thesis invalidation** — `evaluateLiveThesis()` re-pulls real daily bars and re-runs the same regime/volume/structure classification the entry used (`ThesisInvalidation.ts`), `EXIT_CODE=THESIS_INVALIDATION`.
  3. **Generic trailing-stop backstop** — still applies even under a quant stop/target, `EXIT_CODE=TRAILING_STOP`.
  4. **Generic settings-driven take-profit/stop** (`settings.takeProfitPct`/`trailingStopPct`) for any position without a quant stop/target/thesis.
- Every exit is emitted via `emitRiskExit()` → `eventBus.emitTradeIdea({..., agent: 'PortfolioManager', side: 'SELL'})`. `ChiefTraderAgent.isRiskExit()` recognizes this exact agent+side combination and skips the debate/quorum requirement (capital preservation isn't a vote) but **always** still runs `evaluateConsensus()` → RiskEngine's full 24-gate ladder → OMS → BrokerManager. No direct broker call anywhere in this file.
- `src/server/continuous/portfolioIntel.ts` (flag-gated, `ARGUS_PORTFOLIO_INTEL_ENABLED`) already adds: `ensureHoldingSubscribed()` (guarantees live ticks for every held position), `canEmitPortfolioExitIdea()` (5-minute per-symbol cooldown on exit ideas), `recordPortfolioDecision()` (structured telemetry for every review cycle — HEALTHY/WATCH/WARNING/EXIT_CANDIDATE/NO_PRICE — independent of whether an idea was actually emitted).

**What genuinely doesn't exist today:** momentum-deterioration detection independent of price level, partial-profit-taking, ATR/volatility-adaptive trailing distance, session-time awareness, an explicit exit-evidence/score model, and a persisted decision trail comparable to what RiskEngine's gates get.

## 2. Proposed architecture

A new, isolated module — **not** a rewrite of `PortfolioMonitor.ts` — that `PortfolioMonitor` calls into for one additional opinion alongside the checks it already runs:

```
PortfolioMonitor.reviewPortfolio()  [unchanged: still the only continuous position loop]
    │  (existing: quant stop/target, thesis invalidation, generic trailing/target checks — all preserved)
    ▼
ExitIntelligenceEngine.evaluatePosition(holding, marketSnapshot)  [NEW, pure function, no side effects]
    │  returns: { decision: HOLD | PARTIAL_TAKE_PROFIT | TAKE_PROFIT | TRAIL | EXIT | EMERGENCY_EXIT,
    │             exitScore, evidence[], confidence, reasoning }
    ▼
PortfolioMonitor decides whether to call the EXISTING emitRiskExit() — same as today
    ▼
eventBus.emitTradeIdea({agent: 'PortfolioManager', side: 'SELL', ...})  [unchanged]
    ▼
ChiefTraderAgent.isRiskExit() bypass (unchanged) → RiskEngine (unchanged, all 24 gates) → OMS → BrokerManager (unchanged)
```

`ExitIntelligenceEngine` never emits an event, never imports `EventBus`, `RiskEngine`, `OrderManagement`, or `BrokerManager` — it is a pure evaluation function `PortfolioMonitor` calls and acts on, matching the same isolation pattern already proven in `src/server/multiAsset/` (classify/filter modules that only ever return a verdict, never act on it). This mirrors the directive's own instruction (§3): "It must NOT directly place orders. It produces an EXIT DECISION / SELL IDEA that enters the existing protected execution path."

## 3. Event flow / data flow

No new EventBus event types are required for the core decision — `TRADE_IDEA_GENERATED` (SELL, `agent: PortfolioManager`) already carries a `reasoning` string; today that's a single sentence. Two additive changes:

- Extend the existing `reasoning` string to embed the exit score/evidence summary (already how quant stop/target/thesis reasons are communicated — `EXIT_CODE=...` prefix convention already exists and should be extended, not replaced, e.g. `EXIT_CODE=PARTIAL_TAKE_PROFIT`).
- Add one new observability-only event, `EXIT_EVALUATION_RECORDED` (added to `config/eventNames.json` first, per this repo's own "new EventBus types: add to config/eventNames.json first" rule), emitted for **every** evaluation (HOLD included) — this is the equivalent of `recordPortfolioDecision()` in `portfolioIntel.ts`, extended with the richer evidence shape. Reuses that existing telemetry pattern rather than inventing a second one.

**Persistence:** a new table, `exit_evaluations` (own migration, additive — never touches `trades`/`fills`/`risk_assessments`), one row per evaluation (not per trade), holding: `symbol`, `holdingId`/reference to the position, `decision`, `exitScore`, `evidenceJson`, `confidence`, `entryPrice`, `currentPrice`, `peakPrice`, `unrealizedPnlPct`, `holdingDurationMs`, `createdAt`. This answers the directive's §21 observability requirement ("every decision must be reconstructable") without duplicating `trades`/`fills` (§17's explicit instruction) — an approved SELL still references the same `traceId` the resulting `TRADE_IDEA_GENERATED` → `RISK_ASSESSMENT_COMPLETED` → `ORDER_EXECUTED` chain already uses, so a `exit_evaluations` row and the eventual fill are joinable, not duplicated ledgers.

## 4. Interfaces (proposed, illustrative — not final until implementation)

```ts
// src/server/services/ExitIntelligenceEngine.ts
export type ExitDecision = 'HOLD' | 'PARTIAL_TAKE_PROFIT' | 'TAKE_PROFIT' | 'TRAIL' | 'EXIT' | 'EMERGENCY_EXIT';

export interface ExitEvaluationInput {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  peakPriceSinceEntry: number;
  quantity: number;
  openedAt: string;               // for holding-duration / time-based evaluation
  assetClass: string;             // from multiAsset/AssetClassifier — adaptive params by class
  atr: number | null;
  bars: OHLCVBar[];                // for momentum/RSI/ADX/structure — reuses existing indicator functions
  bid: number | null; ask: number | null; averageDollarVolume: number | null;  // execution-reality checks
  sessionPhase: 'PRE_MARKET' | 'OPEN' | 'MIDDAY' | 'POWER_HOUR' | 'AFTER_HOURS' | 'CLOSED';
}

export interface ExitEvaluation {
  decision: ExitDecision;
  suggestedSellFraction: number | null;   // e.g. 0.25 for a 25% partial - null unless PARTIAL_TAKE_PROFIT
  exitScore: number;                      // 0-100, weighted sum of the components below
  components: Record<string, number>;     // named, documented weights - not arbitrary
  evidence: string[];
  confidence: number;                     // 0-1
  reasoning: string;
}

export function evaluateExit(input: ExitEvaluationInput): ExitEvaluation;
```

Reuses, does not duplicate: `src/server/quant/indicators/{trend,momentum,volatility,volume,supportResistance}.ts` for RSI/MACD/ADX/ATR/VWAP/RVOL math (the same functions `RegimeEngine.ts` and the CORE strategies already call), `src/server/multiAsset/AssetClassifier.ts` + `SafetyFilter.ts` for asset-class-adaptive parameters and spread/liquidity execution-reality checks (§16/§17 of the spec), `src/server/quant/analysis/ThesisInvalidation.ts`'s existing regime-based invalidation (already wired, left untouched).

## 5. Failure handling

Missing/thin data (e.g. `bars.length` below an indicator's minimum) must produce `decision: 'HOLD'` with `evidence: ['INSUFFICIENT_DATA: ...']`, never a fabricated score — matching this codebase's repeated "UNKNOWN, not invented" convention (`AssetClassifier.ts` prefers `UNKNOWN` over guessing; `PortfolioMonitor.evaluateLiveThesis()` already returns `null` rather than fabricate an invalidation on thin data). `PortfolioMonitor`'s existing per-cycle `try/catch` and `isReviewing` guard already isolate one symbol's evaluation failure from the rest — `ExitIntelligenceEngine.evaluateExit()` should itself never throw (wrap internals, return a `HOLD`+`INSUFFICIENT_DATA` result on any internal error) so a bug in the new scoring logic degrades to "no opinion, defer to the existing checks" rather than aborting a review cycle.

## 6. Safety boundaries (hard constraints, unchanged from `ARGUS_ARCHITECTURE_PROTECTION.md`)

- `ExitIntelligenceEngine` never imports `EventBus`, `RiskEngine`, `OrderManagement`, or `BrokerManager`.
- It never calls `.placeOrder(` anywhere, directly or indirectly.
- `consensusApprovalThreshold` / `minIndependentAgreeingAgents` are not read or referenced by this module — exits already bypass entry-quorum by design (`isRiskExit()`), and that bypass is not being widened.
- Every exit this engine recommends still becomes a normal `TRADE_IDEA_GENERATED` SELL that RiskEngine evaluates in full (all 24 gates, including `sell_position_exists`) — the new module changes *when/why* Argus proposes a SELL, never *whether RiskEngine gets to say no*.
- `PARTIAL_TAKE_PROFIT` is explicitly scoped to "implement the decision model first; only wire real partial execution where OMS already supports it safely" (§8 of the spec) — see §7 below for what that actually means in this codebase.

## 7. Partial-fill reality check (important finding from this audit)

**OMS does not currently support partial-exit submission as a distinct concept — but it doesn't need new capability to approximate one.** `OrderManagement.executeOrder()` takes an explicit `quantity` parameter already; a `PARTIAL_TAKE_PROFIT` decision can submit a normal SELL order for `Math.floor(holding.quantity * suggestedSellFraction)` shares through the *exact same* path a full exit uses — RiskEngine's `sell_position_exists` gate already clamps to held quantity and doesn't require selling the whole position. **This is not new OMS capability, just a smaller quantity on an ordinary SELL `TRADE_IDEA_GENERATED`.** What doesn't exist and is explicitly out of scope per §8's own instruction: OMS-side partial *fills* of a single order (i.e., a broker partially filling one order and Argus tracking the remainder as still-open) — that facility already exists too, incidentally (`OrderManagement.ts`'s `PARTIALLY_FILLED` status handling, `recordFillProgress`), so no gap here either. Net: partial profit-taking is achievable entirely through the existing spine at a smaller share count — no OMS change required, contrary to what the spec assumed might be needed.

## 8. Affected files

**New:**
- `src/server/services/ExitIntelligenceEngine.ts` (+ `.test.ts`)
- `drizzle/00XX_exit_evaluations.sql` + schema addition (`exitEvaluations` table)
- `config/exitIntelligence.json` (weights for `exitScore` components, ATR-multiplier trailing parameters per asset class, session-phase behavior) + `src/server/config/exitIntelligence.ts` loader — matching this repo's own "no hardcoded thresholds in TypeScript" rule.

**Extended (not rewritten):**
- `src/server/services/PortfolioMonitor.ts` — one new call site per holding, feeding `ExitIntelligenceEngine`'s opinion into the existing decision tree (after quant stop/target/thesis, before the generic fallback — or as an additional signal alongside them; exact ordering is an implementation-time decision, not a plan-time one).
- `config/eventNames.json` — add `EXIT_EVALUATION_RECORDED`.

**Unchanged:** `ChiefTraderAgent.ts`, `RiskEngine.ts`, `OrderManagement.ts`, `BrokerManager.ts`, `PositionSizing.ts`, `CapitalAllocation.ts`, `TradingEngine.ts`, reconciliation, kill-switch, every existing quant strategy, `ThesisInvalidation.ts`'s own logic (reused, not replaced).

## 9. Test plan

Extend `PortfolioMonitor.test.ts`'s existing fixture style (already covers: strategy-own stop/target, generic fallback, thesis invalidation, in-flight guard). New `ExitIntelligenceEngine.test.ts` covering, as pure-function unit tests (no DB/EventBus needed, matching the quant-strategy test pattern already used for `dmiNullGuard.test.ts`/`candlestickReversal.test.ts` this session): profitable + strong momentum → HOLD; profitable + momentum deterioration → PARTIAL_TAKE_PROFIT; profitable + reversal → EXIT; losing position + capital-protection case → EXIT (loss); insufficient bars → HOLD + INSUFFICIENT_DATA; penny-stock wide spread → execution-reality-blocked EXIT (report but flag unrealizable); session-phase near-close behavior. Integration-level: one test proving a `PARTIAL_TAKE_PROFIT` decision still produces a real `RISK_ASSESSMENT_COMPLETED`/`sell_position_exists` pass at the smaller quantity, and one architecture-regression test (extending `architecture.protection.test.ts`) asserting `ExitIntelligenceEngine.ts` never imports `BrokerManager`/`OrderManagement`/`RiskEngine`, matching the existing pattern for `multiAsset/`/`continuous/`.

## 10. Rollback plan

Entirely additive and easy to revert in stages: (1) `PortfolioMonitor.ts`'s one new call site can be reverted independently, restoring exactly today's behavior; (2) the new table/config are inert if unused; (3) no existing behavior changes unless the new call site is wired in, so there is no flag needed for an initial "build but don't wire" stage — wiring itself is the single point of behavior change and the single revert point.
