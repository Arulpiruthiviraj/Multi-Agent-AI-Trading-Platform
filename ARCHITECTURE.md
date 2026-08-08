# Argus - ARCHITECTURE

Welcome to the ARCHITECTURE documentation for the Argus Autonomous Trading Terminal.

## Overview
This document provides high-level context, constraints, and operational guidelines for future developers and AI agents working on Argus.

## Core Principles
1. **Self-Documenting Code**: All modules must declare inputs, outputs, side-effects, and dependencies.
2. **Provider Agnostic**: AI features must route through the `AIRouter` layer.
3. **Event-Driven**: Decoupled communication using the EventBus and WebSockets.

For specific implementation details, refer to the `/skills` directory.

## Autonomous Trading Bot Framework
The trading engine orchestrates a distributed multi-agent system.
Agents act as specific expert committees:
- **TechnicalAgent**: Evaluates oscillators and moving averages.
- **NewsAgent**: Parses global news for sentiment shifts.
- **MacroAgent**: Reviews interest rates and economic metrics.
- **FundamentalAgent**: Examines intrinsic company values.
- **KronosEngine**: Generates forward-looking candlestick predictions using Foundation Models.
- **RiskAgent**: Verifies maximum position sizes and dynamically adjusts stops based on ATR.

The **ChiefTraderAgent** receives all inputs, applying dynamic historical weighting to each agent to formulate a final consensus (BUY, SELL, HOLD).

## EventBus Implementation
The entire system interacts asynchronously over an EventBus.
For example, market data streams trigger `MARKET_DATA_UPDATED`, prompting `KronosForecastAgent` to publish `TRADE_IDEA_GENERATED`, which `ChiefTraderAgent` evaluates.

## Database & Persistence
The architecture uses SQLite (Drizzle ORM) for localized persistence, storing:
- `kronos_predictions`: To evaluate Kronos foundation model hit-rates and metrics (MAE, RMSE).
- `prediction_engine_weights`: Continuous adaptive weighting for each AI agent in the consensus.
