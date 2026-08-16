# ARGUS_EXECUTION_AUDIT

## Production fill path

OMS `executeOrder` → `assertBrokerEnvironmentAllowsOrder` → `activeBroker.placeOrder({ clientOrderId: local UUID })`.

## Entry points that are not a second OMS

| Source | Hits RiskEngine? |
|---|---|
| ChiefTrader `CHIEF_APPROVED_IDEA` | Yes |
| `POST /api/v2/trading/execute-override` | Yes (skips consensus) |
| PipelineFlatten SELL | Yes |
| HTTP `closePosition` | **None** (invariant) |
| Research / Python / UI | No |

## Idempotency / recovery

Unique `trades.trace_id`. Alpaca retries only when `client_order_id` present. Crash recovery must not blindly POST.

## Operator DB

Six PENDING diagnostic BUYs left in place (forensic). Not organic paper.

## Execution model mismatch

Live/paper: market orders now. Research promotion: NEXT_BAR_OPEN. `BacktestEngine`: SAME_BAR_CLOSE. Do not mix PnL.
