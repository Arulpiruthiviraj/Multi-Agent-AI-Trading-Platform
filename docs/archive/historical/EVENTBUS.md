# Argus EventBus

Argus utilizes an in-memory PubSub system (`EventBus`) to decouple agent workflows and enforce true asynchronous operation.

## Core Events

### Market Events
- `MARKET_DATA_UPDATED`: Fired when a new OHLCV tick arrives. (Used by Kronos, Technical Agent).

### Agent Ideation Events
- `TRADE_IDEA_GENERATED`: Fired by any expert agent proposing a position (e.g. KronosForecastAgent, NewsAgent). Contains confidence and reasoning.
- `KRONOS_FORECAST_STARTED` / `KRONOS_FORECAST_COMPLETED`: Tracks the lifecycle of foundation model inferences.
- `KRONOS_REVERSAL` / `KRONOS_BREAKOUT`: Specialized alerts for structural shifts detected by Kronos.

### Consensus & Execution
- `CHIEF_APPROVED_IDEA`: Fired by ChiefTraderAgent when the weighted consensus crosses the approval threshold.
- `RISK_ASSESSMENT_COMPLETED`: Fired by RiskAgent, indicating whether an idea passed or failed ATR/sizing limits.
- `ORDER_EXECUTED`: Fired by the Broker Engine upon successful position entry.

### Reflection
- `LEARNED_NEW_RULE`: Fired by the Memory Engine after analyzing a closed trade, updating the `memory_rules` database and dynamically altering agent weights.
