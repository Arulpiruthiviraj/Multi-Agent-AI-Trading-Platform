# ARGUS_PRODUCTION_READINESS_REPORT

**Date:** 2026-08-16  
**LIVE was not enabled. No real orders. No fabricated paper/OOS/WFO.**  
**Authoritative machine-readable status:** `ARGUS_READINESS_MATRIX.json`

## A. Executive summary

Argus remains a **fail-closed paper-capable terminal** with one OMS fill path. This increment made **unknown quote age fail closed**, made sizing gates report **CLAMPED/FAIL/UNKNOWN**, excluded **diag-** traces from organic paper, and **stopped logging the dev token**.

It did **not** create an edge. **LIVE NO-GO. Trading edge 8/100. Organic paper 0.**

| | Score / verdict |
|---|---|
| Software readiness | **70/100** |
| Trading-edge readiness | **8/100** |
| Paper | **CONDITIONAL GO** |
| LIVE | **NO-GO** |
| Unattended 30-day | **NO-GO** |

## B. Architecture map

Single Node process: `server.ts` + SPA + `ws`. Sacred path: TRADE_IDEA_GENERATED → ChiefTrader → RiskAgent → RiskEngine → OMS → BrokerManager → adapter. Research `canPlaceOrders: false`.

## C–E. Order path and risk

Production `.placeOrder(`: OMS + `src/brokers/*` only (CI invariant). HTTP routes do not call `closePosition`. Override/flatten emit `CHIEF_APPROVED_IDEA` (skip consensus, **not** RiskEngine). 24 RiskEngine gates. `data_freshness` uses `evaluateQuoteFreshness`: **null age = UNKNOWN = FAIL**. LIVE `failClosedUnknownInputs` fails skipped correlation/unmapped sector.

## F–H. Strategies / brokers / research

CORE 5 **UNTESTED**. SMC + experimental family **UNVALIDATED**, env-gated. Brokers unchanged (Alpaca code-complete; Questrade throws; Coinbase paper refuses; IBKR 2FA). Canonical research NEXT_BAR_OPEN; BacktestEngine SAME_BAR_CLOSE = **ENGINE_MISMATCH**. Costs 0/0/0 still **block promotion**.

## I–P. Dependencies and research methods

External: Alpaca, optional news/LLM keys, Chronos, IBKR Gateway. Warehouse `data/research` **MISSING** = **BLOCKED — EXTERNAL EVIDENCE REQUIRED**. OOS/WFO/robustness/statistics pipelines exist; **no GREEN REAL_MARKET_DATA artifacts**. Live sizing model: `config/sizingModels.json` FIXED_DOLLAR + 5% stop assumption; ATR **NOT_LIVE**.

## Q–S. Paper / recon / recovery

`data/argus.db`: 6 PENDING diagnostic BUYs **preserved**. Organic FILLED SELL P&L: **0**. Recon mismatch → `TRADING_PAUSED`. OMS unique `traceId` + crash recovery. Do not blindly retry.

## T–V. Security / UI / Canada

Production refuses unauthenticated boot. Dev token **not printed**. Canadian live routing **BLOCKED**. UI still mixed `AwaitingSignal`; `GET /api/v2/live-readiness` is LIVE_NO_GO.

## W. Tests

- `npx tsc --noEmit` PASS  
- `npx vitest run` **1018/1018**, 155 files  
- `npm run build` PASS (CJS `import.meta` warnings on config path)

## X–Z. Scores and blockers

See matrix JSON. Remaining: GREEN warehouse, organic paper, non-zero reviewed costs, NEXT_BAR OOS/WFO/robustness, legal routing, funded broker, human LIVE phrase.

## AA. Commands

`npx tsc --noEmit`; `npx vitest run`; `npm run build`

## AB. Files changed (this increment)

`src/server/core/marketDataQuality.ts` (+ test), `src/server/core/dataQuality.ts`, `src/server/engines/RiskEngine.ts` (+ tests), `src/server/engines/PositionSizing.ts` (+ test), `src/server/services/MarketDataWorker.ts`, `src/server/core/AuthConfig.ts` (+ test), `src/server/research/organicPaper.ts`, `src/server/research/phase21.invariants.test.ts`, `src/server/core/liveReadinessEngine.ts`, `config/sizingModels.json`, integration/restricted-live/gates/override/recon tests, this report set.

## AC–AE. PASS / FAIL / BLOCKED

PASS: order-path scan; unknown freshness fail; sizing honesty tests; tsc/vitest/build.  
FAIL: CORE UNTESTED; paper 0; zero-cost promotion; LIVE_NO_GO.  
BLOCKED: warehouse, OOS/WFO/robustness evidence, Canadian live, 30-day paper ops, funded LIVE account.
