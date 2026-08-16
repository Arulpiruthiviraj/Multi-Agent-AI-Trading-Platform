# 19 — Error handling

| Failure | Detection | Handling | Trading impact |
|---|---|---|---|
| Alpaca hang | Abort 15s | Retry if idempotent-safe; circuit open | Fail order / recovery ingest |
| LLM hang | Abort 20s | Failover; circuit pause | No debate; idea may stall |
| Chronos down | /health | Honest unavailable | Kronos not voter |
| News APIs | Provider errors | Skip / N/A | Weaker consensus |
| No market data | Worker idle | No ticks | Technical silent |
| Broker down | placeOrder throw | REJECTED / recovery | No fill or unknown → recon/OMS |
| DB | better-sqlite throw | Request fail | Process may die |
| WS drop | client reconnect | UI stale until reconnect | Backend continues |
| Stale price | age ms | Gate fail | No new order |
| Invalid price | finite check | Gate fail | No order |
| Order timeout | OMS poll + follow-up | Cancel/pause at 30m | Pause if cannot cancel |
| Partial fill | fills aggregate | Cancel remainder at max age | |
| Duplicate traceId | unique index | Second insert abort | One broker call |
| Recon mismatch | $ impact | TRADING_PAUSED | New orders blocked |
| AI hallucination numerics | parseResearchNote null | inventedNumericFieldsRejected | Cannot invent entry/stop |
| Missing bars | evaluate conditionsFailed | No idea | |

Alerts: AlertingService cooldown `alertingCooldownMs`. User messages: diagnostics catalog. Recovery: resume tradingState after human review.
