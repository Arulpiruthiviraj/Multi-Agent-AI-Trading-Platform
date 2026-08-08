# Argus AI Agent Architecture

The Argus system is a true multi-agent network relying on asynchronous consensus.

## Agent Roster
1. **Chief Trader Agent**: The orchestrator. Receives all generated trade ideas, applies dynamic, historically-backed weights to the emitting agents, and executes trades that pass consensus limits.
2. **Kronos Forecast Agent**: A specialized time-series foundation model agent. It exclusively evaluates OHLCV strings to predict future candle shapes, price targets, and directional probabilities.
3. **News Agent**: Reads unstructured web and broker news to score real-time sentiment impact.
4. **Technical Agent**: Quantifies standard indicator states (RSI, MACD, Bollinger Bands).
5. **Macro / Fundamental Agents**: Evaluates long-term regime states and intrinsic valuations.
6. **Risk Management Agent**: A hard-coded mathematical engine acting as an ultimate veto. Uses ATR to determine precise position sizing and stop losses.

## Interaction Flow
- **Data Ingestion**: Agents subscribe to `MARKET_DATA_UPDATED`.
- **Ideation**: Agents asynchronously publish `TRADE_IDEA_GENERATED` with custom reasoning and confidence.
- **Consensus**: The Chief Trader calculates the weighted average.
- **Veto/Approval**: The Risk Agent evaluates approved ideas for strict account constraints.
- **Execution**: The Broker Engine fires the trade to Alpaca/Paper.
- **Reflection**: The Reflection/Memory Engine scores the trade post-closure and adjusts Agent Weights.
