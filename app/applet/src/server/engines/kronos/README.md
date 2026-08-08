# Kronos Integration Module

This directory contains the integration bridge for the open-source **Kronos Financial Foundation Model** (https://github.com/shiyu-coder/Kronos).

## Components
- **`KronosModelManager`**: Manages the lifecycle, downloading, and health checks of the Kronos PyTorch model. Features auto-degradation if the local container lacks GPU/Torch support.
- **`KronosEngine`**: The main entry point used by Argus. Exposes `getPrediction(...)`.
- **`KronosInference`**: Formats raw OHLCV data and handles the interaction with the prediction layer.
- **`KronosTokenizer`**: Stub for the specialized K-line tokenizer used by Kronos.
- **`KronosMetrics`**: Connects to SQLite to record predictions and evaluate historical Hit Rate / RMSE.
- **`KronosPredictionCache`**: In-memory KV store to prevent redundant inferences for the same symbol/horizon.

## Usage
The `ChiefTraderAgent` automatically discovers and weights the Kronos engine based on its historical accuracy stored in `prediction_engine_weights`. 
