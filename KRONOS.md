# Kronos Forecasting Engine
The Kronos Foundation Model acts as a sophisticated predictive node for generating multi-horizon price forecasts within Argus.

## Responsibilities
- Predict next candles, direction, volatility, trend continuation, reversals, and support/resistance using OHLCV candlestick data.
- Participate as a collaborative agent (via `KronosForecastAgent`), sending signals to the `ChiefTraderAgent`.
- Operates asynchronously to avoid blocking the system, utilizing a caching layer to reuse predictions.

## Architecture
- **KronosEngine**: Main interface wrapping the inference model.
- **KronosInference**: Handles data preparation and inference calls.
- **KronosForecastAgent**: Listens to market data, requests forecasts, and pushes trade ideas to the `ChiefTraderAgent`.
- **KronosDashboard**: A dedicated UI visualizing prediction accuracy, system health, and configurations.

## Event Flow
- Subscribes to `MARKET_DATA_UPDATED`.
- Publishes `KRONOS_FORECAST_READY`, `KRONOS_HIGH_CONFIDENCE`, `KRONOS_REVERSAL`, etc.
- Emits `TRADE_IDEA_GENERATED` to the Chief Trader for consensus weighted evaluation.
