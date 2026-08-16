# 14 — Broker / OMS execution

```
CHIEF_APPROVED → RiskEngine → OMS insert trades → placeOrder (timeout) → ack/fill/partial → follow-up → cancel orphan or pause
```

Idempotency: unique `trades.traceId`; Alpaca `client_order_id`. Timeout unknown outcome: crash recovery + inbound ingest. Partial: incremental `fills`. Retry: GET/DELETE and marked-safe POST only.

| Adapter | Implemented | Paper | Live unattended | Tested | Notes |
|---|---|---|---|---|---|
| InternalPaperBroker | Yes | Simulator | No | Yes | ~$100k default |
| AlpacaBroker | Yes | Yes | Yes (software) | reliability tests | 15s abort, CB; **LIVE NO-GO** validation |
| InteractiveBrokersAdapter | Yes | DU* | **No** 2FA ~24h | Partial | WAF needs User-Agent; canadianEquities false; placeOrder does not call isCanadianListing |
| CoinbaseBroker | JWT real | **placeOrder refuses** | UNVERIFIED funded | Unit | `.env.example` may lag |
| QuestradeBroker | Read-only | Orders throw | No | Unit | Never active placer |

`PAPER_TRADING_ONLY` does **not** force BrokerManager paper (CLAUDE.md).

OMS boot: `reconcileStaleOrders` + `reconcileInboundBrokerOrders`. Cancel: `POST /api/v2/trading/cancel-order/:id`. Override execute: still RiskEngine.
