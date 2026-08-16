# 05 — Trading lifecycle (one share BUY / SELL)

## BUY — what must happen

1. **Price** — Alpaca IEX WS (`MarketDataWorker`) emits `MARKET_DATA` / `MARKET_DATA_UPDATED`. No live price → RiskEngine refuses. Stale > `stalePriceThresholdMs` (300000) fails `data_freshness`.
2. **Candidate** — At least one voter emits `TRADE_IDEA_GENERATED` `{traceId, symbol, side, confidence, reasoning, agent, currentPrice?}`.
   - Technical: after ~50 ticks, RSI/MACD/BB (`TechnicalAgent.ts`). **On even if Autobot off.**
   - News/Fund/Macro: Autobot timers; AlphaVantage + AIRouter.
   - Quant: if `QUANT_ENGINE_ENABLED=true`; daily bars; EV gate may suppress.
   - Kronos: if Chronos `/health`.
3. **ChiefTrader** — window of ideas; weights from `agent_performance_stats` / `agentWeights.json`; min **2** independent agents; bar **0.75**; debate if confidence > 0.6 (`AIRouter`, temp 0.2, timeout 20s abort). HOLD / Bear HOLD / Quant disagreement → NO TRADE.
4. **Thesis** — Quant may attach `quantDetail.tradeThesis` (numbers from engines only). Does not change approval math.
5. **OpenAlice** — fire-and-forget if enabled; **does not block**.
6. **RiskEngine** — all gates recorded; first failure reported; needs finite live price; AI cannot override.
7. **Sizing** — `PositionSizing.ts` whole shares `Math.floor`; default FIXED_DOLLAR `maxTradeSize`; stop assumption 5% not ATR; `argus_capital_allocation` vs `settings.budget`; `daily_buy_notional`.
8. **OMS** — insert `trades` (idempotent `traceId` unique); `placeOrder` with timeout; poll; fills rows; follow-up; crash ingest on boot.
9. **Broker** — InternalPaper or Alpaca. Events `ORDER_SUBMITTED/ACCEPTED/FILLED`, `ORDER_EXECUTED`.
10. **Recon** — 5 min vs broker positions; mismatch event; ≥$100 → `TRADING_PAUSED`.
11. **UI** — WS wildcard → React. Observatory from `transactions` assembly.

**DB writes:** trades, fills, risk_assessments, risk_gate_results, consensus_*, event_traces, possibly ai_calls.

**Not this path:** `GET /api/v1/signals` → `portfolio.json`.

## SELL

Same path. Extra gate `sell_position_exists`. Sources: agents, **PortfolioMonitor** (~60s, agent `PortfolioManager`, risk-exit skips min-2/debate), thesis invalidation, quant stop. Liquidate-all: `PipelineFlatten` emits `CHIEF_APPROVED_IDEA` ManualOverride (**still RiskEngine**). Rebalance: **501**.

## Timeouts / retries

Alpaca: 15s abort, retries only `idempotentRetrySafe`, circuit breaker. AI: 20s abort. OMS follow-up min age ~6s; max age 30 min then cancel/pause.
