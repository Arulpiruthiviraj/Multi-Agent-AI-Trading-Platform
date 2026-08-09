# Argus - README

Welcome to the README documentation for the Argus Autonomous Trading Terminal.

## Overview
This document provides high-level context, constraints, and operational guidelines for future developers and AI agents working on Argus.

## Core Principles
1. **Self-Documenting Code**: All modules must declare inputs, outputs, side-effects, and dependencies.
2. **Provider Agnostic**: AI features must route through the `AIRouter` layer.
3. **Event-Driven**: Decoupled communication using the EventBus and WebSockets.

For specific implementation details, refer to the `/skills` directory.

## Optional: Local AI Stack

Argus can offload cheap, high-frequency inference to models running on your
own machine (Ollama + FinBERT/Chronos/XGBoost) instead of a paid cloud LLM on
every tick and headline. See [docs/LOCAL_AI_SETUP.md](docs/LOCAL_AI_SETUP.md)
- entirely optional, `npm run setup:ai` to install.
