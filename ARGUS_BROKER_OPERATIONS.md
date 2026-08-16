# ARGUS_BROKER_OPERATIONS

## Selection

`BrokerManager` default: InternalPaperBroker. Alpaca is the only fully unattended US-equity path in this codebase. IBKR needs local Gateway + 2FA. Coinbase refuses paper `placeOrder`. Questrade cannot place orders.

## PAPER vs LIVE

- `settings.tradingMode` and `brokerConnections.paperMode` **must agree**.
- LIVE + paperMode true → OMS **rejects** (`BROKER_ENVIRONMENT_UNKNOWN`).
- Confirmation phrase: `ENABLE LIVE TRADING`.
- Restricted-live caps apply only when mode is LIVE (ceilings, not edge).

## Clock / data

Alpaca clock: if keys exist and HTTP fails, session is **not** treated as open (fail-closed). No keys: market_hours skip.

## Canada

Automated live routing **NOT AVAILABLE**. Do not “fix” by flipping capability flags.
