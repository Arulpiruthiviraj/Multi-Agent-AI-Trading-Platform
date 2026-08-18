# ARGUS continuous intelligence implementation report

Date: 2026-08-18. LIVE remains **NO-GO**. This overlay does **not** manufacture consensus, lower the 0.75 bar, or claim a trading edge. Continuous scanning is not continuous trading.

## 1. Architecture before / after

### BEFORE (unchanged spine)

```
Alpaca IEX (config/markets.json US.benchmarks: SPY, QQQ, IWM, DIA)
  → Agents (tick/timer ideas)
  → ChiefTrader (min 2 independent agents, consensusApprovalThreshold 0.75)
  → RiskAgent → RiskEngine (24 gates)
  → OMS → BrokerManager → Broker
```

PortfolioMonitor already ran every `runtimeIntervals.portfolioMonitorMs`, emitted PortfolioManager SELL ideas on TP/stop/thesis invalidation, and ChiefTrader already skipped entry quorum for that risk-exit agent. Holdings without a live tick were skipped. Nobody called `marketDataWorker.subscribe()`, so the IEX universe could not grow past the four benchmarks.

### AFTER (same spine; two intelligence loops around it)

```
OPPORTUNITY LOOP (flag OFF = idle)
  seedSymbols → cheap filters → bounded WATCHLIST_SUBSCRIBE_REQUESTED
  → MarketDataWorker.subscribe (cap + protected benchmarks)
  → existing Technical/Quant/News agents may now see those ticks
  → existing ChiefTrader → RiskEngine → OMS
  Scanner ideasEmitted is always 0.

PORTFOLIO LOOP (flag OFF = identity)
  SQLite holdings → request ticks for open names → TP/stop/thesis
  → HOLD / EXIT_CANDIDATE telemetry
  → executable SELL still emitTradeIdea(PortfolioManager)
  → ChiefTrader risk-exit skip → RiskEngine → OMS
```

## 2. Files changed

| Area | Files |
|---|---|
| Config | `config/continuousIntelligence.json`, `config/eventNames.json`, `.env.example` |
| Loader | `src/server/config/continuousIntelligence.ts` |
| Opportunity loop | `src/server/continuous/OpportunityDiscovery.ts` |
| Portfolio intel | `src/server/continuous/portfolioIntel.ts` |
| Market data | `src/server/services/MarketDataWorker.ts` |
| Portfolio monitor | `src/server/services/PortfolioMonitor.ts` |
| API | `src/server/routes/continuousIntelRoutes.ts`, `src/server/routes/v2System.ts` |
| Boot | `server.ts` |
| UI | `src/components/StrategyScanner.tsx`, `src/components/AutonomousMissionControl.tsx` |
| Tests | `src/server/continuous/continuousIntelligence.test.ts`, `MarketDataWorker.test.ts`, `PortfolioMonitor.test.ts` |

## 3. Services added

- `OpportunityDiscoveryWorker` — scheduled seed scan; subscribe requests only.
- `portfolioIntel` helpers — holding subscribe, exit-idea cooldown, HOLD/EXIT telemetry.
- `GET /api/v2/continuous-intelligence/status`

## 4. Existing services reused

MarketDataWorker, EventBus, `looksLikeListedTicker`, AssetClassifier, SafetyFilter, PortfolioMonitor, ChiefTrader `isRiskExit`, RiskEngine, OMS, PortfolioReconciliation (unchanged; still broker-truth for mismatches).

## 5. New EventBus events

| Event | Persist | Meaning |
|---|---|---|
| `WATCHLIST_SUBSCRIBE_REQUESTED` | yes | Request IEX subscribe. Not an order. |
| `OPPORTUNITY_SCAN_COMPLETED` | yes | Scan stats including `ideasEmitted: 0`. |
| `PORTFOLIO_DECISION_RECORDED` | yes | HOLD / WARNING / NO_PRICE / EXIT_CANDIDATE telemetry. |

## 6. Database

No new tables or columns. Decision traces still use existing `event_traces` / `transaction_traces` / `risk_assessments` once an idea actually enters the spine.

## 7. New configuration

`config/continuousIntelligence.json` (fail-boot if keys missing):

- Flags: `ARGUS_OPPORTUNITY_LOOP_ENABLED`, `ARGUS_PORTFOLIO_INTEL_ENABLED` (default not `'true'`)
- `opportunityScanMs` 120000
- `maxActiveSubscriptions` 32
- `maxNewSubscriptionsPerCycle` 4
- `exitIdeaCooldownMs` 300000
- `protectedSymbols` SPY/QQQ/IWM/DIA
- `seedSymbols` AAPL, MSFT, NVDA, AMZN, TSLA + the four ETFs

Intervals are reviewed JSON, not UI knobs. This file was used instead of expanding `runtimeIntervals.json` required keys.

## 8. Penny-stock handling

When `ARGUS_MULTI_ASSET_ENABLED` and `ARGUS_PENNY_STOCK_ENABLED` are both `'true'`, penny/micro seed names are filtered through `evaluateAssetSafety`. Unknown spread, excessive spread, poor liquidity, and MARKET-unfit remain **BLOCK**. Blocked names are not subscribed. They never get a scanner-generated trade idea. RiskEngine 24 gates are not bypassed. OMS remains MARKET-only.

## 9. Opportunity scanning behavior

Default **OFF**. When on: scan the JSON seed (not a 5,000-name tape — Alpaca IEX is a bounded subscription). Cheap filters first. Rank/shortlist. Emit at most `maxNewSubscriptionsPerCycle` subscribe requests, never past the cap. **Never** `TRADE_IDEA_GENERATED`. Overlapping scans skip. `NO_ACTION` is a valid outcome.

## 10. Portfolio monitoring behavior

Default **OFF** = previous PortfolioMonitor identity (still emits risk-exit SELLs). When on: request ticks for held names so unmanaged-no-price is less common; record HOLD/WARNING/NO_PRICE; cooldown duplicate exit ideas. Missing price still does **not** fabricate a SELL.

## 11. Entry decision flow

Unchanged: idea agents → ChiefTrader min-2 + 0.75 → RiskEngine → OMS. The scanner only expands who can tick. It does not lower consensus to “make more trades.”

## 12. Exit decision flow

Unchanged executable path: PortfolioManager SELL idea → ChiefTrader risk-exit skip (no entry quorum) → RiskEngine → OMS. Hard exits (stop / TP / thesis invalidation) do not wait for a 2-agent BUY-style debate. Overlay cooldown only suppresses duplicate **ideas**, not a broker flatten.

## 13. RiskEngine integration

No new gates. No scanner-specific bypass. No portfolio-manager-specific bypass. Executable BUY/SELL still require `RISK_ASSESSMENT_COMPLETED` after persist-then-emit.

## 14. OMS integration

OMS remains the sole production `.placeOrder(` caller (`phase21.invariants.test.ts`). Scanner and portfolio intel do not import OMS or BrokerManager.

## 15. Reconciliation behavior

Unchanged. Broker truth remains `PortfolioReconciliation`. Material mismatch still fail-closes via existing kill-switch / pause. This overlay does not auto-flatten or auto-resume.

## 16. Failure behavior

| Unavailable | Behavior |
|---|---|
| Opportunity flag off | Idle; 4-ETF universe unchanged |
| Market data / no tick | HOLD/NO_PRICE; no fabricated SELL |
| News / fund / macro / AI | Scanner does not call them; does not invent confidence |
| Penny spread unknown | BLOCK subscribe/candidate when penny flags on |
| Scan overlap | Skip |

`DATA_UNAVAILABLE` is never converted into BUY.

## 17. Tests added

- Opportunity idle / bounded subscribe / `ideasEmitted === 0` / overlap skip / invalid ticker / penny spread+liquidity BLOCK / no AI/news/fundamentals imports
- Portfolio intel identity vs cooldown / HOLD telemetry
- Isolation: no `placeOrder` / BrokerManager / OMS in `src/server/continuous`
- Consensus 0.75 and min-2 unchanged
- MarketDataWorker: union benchmarks, protected unsubscribe, cap, watchlist event, EventBus.subscribe mock
- PortfolioMonitor: no SELL without live price

## 18. Test results

`npx vitest run`: **253 files passed, 1618 tests passed**.

## 19. Build results

- `npx tsc --noEmit`: pass
- `npm run build`: Vite SPA + `dist/server.cjs` pass (existing large-chunk warning only)

## 20. Remaining limitations

- This is **not** a 5,000-name universe. IEX subscriptions are capped at 32.
- Seed is JSON, not a full tape scanner with live dollar-volume for every NYSE/NASDAQ name.
- Fundamental/Macro agents remain on their existing hardcoded symbols and can still be AlphaVantage-limited.
- No live bid/ask spread on the IEX quote used here for non-penny names; penny BLOCK uses SafetyFilter when the overlay is on.
- OMS is still MARKET-only. Penny MARKET remains unfit.
- PortfolioMonitor still reads SQLite `portfolio`; broker divergence is still Reconciliation’s job.
- Entry consensus is unchanged — new names can still fail 2-agent quorum (Technical vs Kronos HOLD/SELL). That is not “fixed” by this overlay on purpose.
- No profitability, soak, or LIVE claim.

## 21. Execution path not bypassed

Confirmed: no `placeOrder` from OpportunityDiscovery, portfolioIntel, or continuousIntelRoutes. Executable SELL still `emitTradeIdea` → ChiefTrader → RiskEngine → OMS.

## 22. LIVE remains disabled

`PAPER_TRADING_ONLY`, `LIVE_ARM`, LIVE confirmation, Canadian live block, and `evaluateLiveReadiness()` were not modified. New flags default false. No live orders are part of this work.

## Operator enable (paper only)

Both flags must be the string `true` in `.env`. Enabling them does not arm LIVE and does not lower ChiefTrader thresholds.

```
ARGUS_OPPORTUNITY_LOOP_ENABLED=true
ARGUS_PORTFOLIO_INTEL_ENABLED=true
```
