# ARGUS Phase C — Look-Ahead Audit (MODE B)

**Date:** 2026-08-20  
**Scope:** `FullArgusReplayEngine` + replay adapters + `HistoricalReplayBroker`  
**Claim:** No zero-look-ahead certificate — mitigations documented with tests where present.

| Vector | Location | Risk | Mitigation | Test |
|--------|----------|------|------------|------|
| Future bars in decisions | `FullArgusReplayEngine.processTimestamp` | HIGH | `visible = bars.filter(b => b.timestamp < t)` + `InformationCutoff.assertNotFuture` | `InformationCutoff` tests, phase18 |
| Future fill price | Broker `nextFillPrice` from bar at `t` (NEXT_BAR_OPEN) | HIGH | Fill bar not in decision `visible` set | HistoricalReplayBroker tests |
| Discovery future volume | `replayDiscoveryAdapter.rankCandidatesByDollarVolume` | HIGH | Only bars `< asOfMs` | `replayDiscoveryAdapter.test.ts` |
| Live tick cache pollution | Former `marketDataWorker.cacheObservedQuote` | MEDIUM | `HistoricalReplayMarketDataContext` isolated cache | `replayMarketDataIsolation.test.ts` |
| Missed-opportunity feedback | `MissedOpportunityAnalysis` | HIGH | Post-run only; no EventBus/placeOrder | `missedOpportunityArchitecture.test.ts` |
| Live EventBus ideas | Replay loop | HIGH | Session-local `emit()` only; no `emitTradeIdea` | architecture.protection |
| `Date.now()` in decisions | RiskEngine replay branch | LOW | Uses `replay.clock.now()` for gate time | RiskEngine replay branches |
| `Date.now()` wall-clock in replay | `FullArgusReplayEngine` persist/diagnostics | LOW | Not used for bar selection or fills | Code review |
| Fundamental/Macro/News future | N/A | N/A | Agents marked UNAVAILABLE / CATALYST_ONLY; not fabricated | agentAvailability in summary |
| LLM non-determinism | AI modes | MEDIUM | Default `aiMode: DISABLED` | config + phase18 |
| Concurrent LIVE replay | create/start | MEDIUM | Refused when `tradingMode === LIVE` | createReplayRun guard |

## Residual risks

- Shared SQLite during paper+replay (replay traces prefixed; not a look-ahead vector but operational coupling).
- Static discovery pool is not point-in-time **membership** (only point-in-time **liquidity** within pool).
- Alpaca real-data RUN-VERIFIED blocked in this environment (`fetch failed` — network/provider).

## Evidence grade

Look-ahead mitigations for bar/discovery paths: **TEST-VERIFIED**  
Full MODE B zero-look-ahead: **NOT VERIFIED** (residual static-universe + shared DB coupling)
