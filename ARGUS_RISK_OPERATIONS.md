# ARGUS_RISK_OPERATIONS

## Gates (24)

See `config/riskGateOrder.json`. First failure is the reported rejection; all recorded.

Includes: emergency_stop, autobot_enabled, cooldowns, daily trade limit, duplicate signal, invalid_account_equity, daily_loss, consecutive_loss, portfolio_drawdown, order_rate_limit, market_hours, data_freshness, news_veto, price_validity, sizing/concentration/correlation, sell_position_exists, argus_capital_allocation, daily_buy_notional.

## Kill switches

Do **not** add a second master switch. `emergency-stop` / `TRADING_PAUSED` already exist. Autobot-off is not a duplicate kill switch; it blocks new BUY only.

## Capital

`settings.budget` is Argus allocation. Broker equity must be real and positive or `invalid_account_equity` fails. No placeholder LIVE equity.

## Stops

Live sizing uses `stopLossAssumptionPct` (config), **not** ATR, unless a versioned model is promoted later.
