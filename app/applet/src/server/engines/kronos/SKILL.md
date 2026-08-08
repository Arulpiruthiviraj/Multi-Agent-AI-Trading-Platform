---
name: kronos-financial-model
description: Guidelines and documentation for integrating and extending the Kronos Financial Foundation Model within Argus.
---

# Kronos Financial Foundation Model

## Overview
Kronos is a family of decoder-only foundation models pre-trained on 12 billion K-line records (OHLCV), treating market data as a distinct language. Within the Argus Autonomous Trading Terminal, Kronos acts as a sophisticated predictive node for generating multi-horizon price forecasts.

## Integration Architecture
Kronos is deeply integrated into the Argus multi-agent ecosystem:

1. **Market Data Injection**: `KronosInference` reads 1m/5m/15m/1h/1d OHLCV candles from the Market Data Engine.
2. **Tokenizer**: Translates raw candles into Kronos-compatible discretized tokens using BPE-like strategies (simulated in the TS layer).
3. **Inference Pipeline**: Sends the tokens to the underlying model (local GPU or API) to predict the next `N` candles.
4. **Chief Trader Consensus**: Outputs are fed into `ChiefTraderAgent` as another voting node. Kronos is dynamically weighted based on its historical accuracy.
5. **Performance Tracking**: `KronosMetrics` records every prediction into SQLite (`kronos_predictions`), allowing the Reflection Engine to measure RMSE/MAPE against actual future candles.

## Graceful Degradation
Because Kronos requires a heavy Python ML environment (PyTorch, Transformers), the TypeScript manager (`KronosModelManager`) attempts to locate the environment on startup. If unavailable, it gracefully fails:
- Status becomes "Warning: Kronos unavailable"
- `isAvailable` flag is set to false
- The `ChiefTraderAgent` automatically routes around it and relies on Technical, Macro, Fundamental, Quant, and News agents.

## Schema
- **`kronos_predictions`**: Stores symbol, forecast horizon, expected move, support/resistance, and prediction timestamp.
- **`prediction_engine_weights`**: Stores dynamic Win Rate, Accuracy, and Drawdown Contribution for all agents, including Kronos.
