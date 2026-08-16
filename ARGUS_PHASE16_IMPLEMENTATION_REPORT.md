# ARGUS Phase 16 implementation report

**Date:** 2026-08-16  
**Compiler:** `npx tsc --noEmit` — pass  
**Vitest:** **909/909** pass (`fileParallelism: false`; OpenAlice disabled in tests; Chronos/Ollama loopback isolated unless `ARGUS_TEST_ALLOW_*`)  
**LIVE:** NO-GO  
**PAPER:** CONDITIONAL GO (no edge claim)

This phase is additive. The live fill path remains EventBus → specialist agents → ChiefTrader → RiskAgent → RiskEngine → OMS → Broker.

---

## Must-fix (done)

| Item | Change |
|---|---|
| Fabricated event-memory | `GET`/`POST` `/api/v1/event-memory*` → **410** `EVENT_MEMORY_QUARANTINED`. UI shows **NO HISTORICAL DATA** (what / why / impact / how to fix). |
| Empty PIT ledger | `evaluatePitAiBuyGate([])` → `allowBuy: false`. Strategy backtests may opt in via `allowTechnicalWhenEmpty` (labeled, not AI consensus). |
| Quant regime fallback | Live emit uses **strategy idea only**. `deriveIdeaFromRegime` kept for unit tests, not live emit. No EV / min R:R → `DESK_NO_TRADE`. |
| OpenAlice/Chronos ECONNRESET | Health timeouts; `OPENALICE_ENABLED=false` in Vitest; Kronos auto-init skipped when `VITEST=true`; Chronos/Ollama URLs isolated in setup; **sequential file parallelism** so workers do not share half-open local sockets with in-process HTTP tests. |

---

## Features implemented (additive)

- EliteTraderDecision sourced scores (no invented probabilities; liquidity explicitly UNAVAILABLE).
- SetupEngine catalog (named setups; UNAVAILABLE detectors stay unavailable; SMC UNVALIDATED).
- ConfluenceEngine independence groups (oscillators collapsed).
- Model role consensus helper (no majority-vote orders).
- WAIT / expanded `noTradeReasons.json` codes.
- PortfolioMonitor `EXIT_CODE=*` prefixes; SELL still via pipeline.
- Overtrading RiskEngine gates from `tradingSafety.json`.
- StartupHealthRegistry + `GET /api/v2/system/startup-health`.
- Canadian readiness + `GET /api/v2/markets/canada` (CSE listed; live **NOT AVAILABLE**).
- Durable `trade_lifecycle_transitions` (drizzle `0027`) + `GET /api/v2/desk/lifecycle`.
- Broker snapshot: `available:false` + what/why/impact/fix when `portfolio()` throws.
- RegimeEngine `deskSession` (RTH clock + honest UNAVAILABLE breadth/risk-on).
- Data-quality extra channels (YELLOW when missing; RED still market-data stale for new trades).

---

## Intentionally not implemented (still honest gaps)

- Full 1m / 5m / 15m / 30m / 1h / daily **execution** MTF engine (would need a real multi-timeframe bar cache and would not be a second OMS).
- Live detectors for ORB, HOD/LOD, gap-and-go, earnings reaction, L2 liquidity score.
- New date-range Prediction Lab UI (existing PIT/`POST /api/v2/replay/historical` is the replay surface; it was not rebuilt).
- 30/50/100/250/500-trade automated paper lab with promotion to VALIDATED (sample still too small).
- Replacing ChiefTrader or adding WAIT as a RiskEngine-approved order type.
- Parallel unlimited model processes.
- Unlocking Canadian IBKR/Questrade routing.
- Claiming Argus is an elite discretionary trader.

---

## Tests added / updated

- `OvertradingGuards.test.ts`
- `EliteTraderDecision.test.ts` (confluence, setup unavailable, roles)
- `canadianReadiness.test.ts`
- `StartupHealthRegistry.test.ts`
- `PitReplay.test.ts` (empty ledger fail-closed)
- `QuantSignalAgent.test.ts` (no EV → no emit)
- `v2System.quantObservability.test.ts` (Canada, lifecycle empty, strategies catalog)
- `v2System.override.test.ts` (longer wait for extra RiskEngine queries)
- `vitest.setup.ts` / `vitest.config.ts` (isolation)

---

## Tests passed / failed

- Passed: **909**
- Failed: **0** (this run)

Prior full-suite failure: `GET /api/v2/quant/strategies` `read ECONNRESET` ~19s with Chronos up and OpenAlice enabled in `.env`. Isolated file run passed. Fixed by not opening those sockets from the test worker and by disabling file parallelism.

---

## Bugs discovered and fixed

1. Empty PIT `allowBuy: true` treated missing AI as technical approval.  
2. Quant live ideas without EV via `deriveIdeaFromRegime`.  
3. Event-memory 82% canned Trade War text.  
4. Vitest workers + live Chronos/OpenAlice sockets resetting in-process HTTP.  
5. Duplicate-signal gate would have failed sequential BUY tests if it counted rejected assessments — only **approved** BUYs count.  
6. Override integration test 1s wait too short after extra RiskEngine queries.

---

## Services (this environment)

| Service | Typical test-run status |
|---|---|
| OpenAlice | DISABLED in Vitest |
| Chronos/Kronos | Isolated from tests; auto-init off under VITEST |
| Ollama | Isolated from tests |
| Quant engine | DISABLED unless env flag |
| InternalPaperBroker | Default, usable |
| Alpaca | Keys may exist in `.env`; tests often delete them after dotenv |

Do not show READY for a service that was not probed successfully in production.

---

## Remaining blockers

See `ARGUS_REAL_MONEY_READINESS_PHASE16.md`. Edge readiness remains ~8%. LIVE NO-GO.

## Next recommended phase

Paper-only measurement: collect ≥ `minTradesForPaperValidation` organic closed trades, then walk-forward / Monte Carlo / permutation **without** touching the held-out test set. Keep QUANT and LIVE flags off until VALIDATED exists in evidence, not in code volume.

## Files touched (representative)

Config: `tradingSafety.json`, `riskGateOrder.json`, `noTradeReasons.json`, `markets.json`, `setupCatalog.json`, `confluenceIndependence.json`, `modelRoles.json`  
Code: RiskEngine, PitReplay, QuantSignalAgent, OpenAlice adapter/service, KronosEngine, EventStore, dataQuality, PortfolioMonitor, RegimeEngine, schema + drizzle 0027, v2System, server.ts event-memory, App.tsx, desk/* , OvertradingGuards, StartupHealthRegistry, TradeLifecycleStore, canadianReadiness, vitest setup/config  
Docs: this file, `ARGUS_REAL_MONEY_READINESS_PHASE16.md`
