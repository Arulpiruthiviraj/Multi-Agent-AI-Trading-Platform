# Argus - API REFERENCE

Welcome to the API REFERENCE documentation for the Argus Autonomous Trading Terminal.

## Overview
This document provides high-level context, constraints, and operational guidelines for future developers and AI agents working on Argus.

## Core Principles
1. **Self-Documenting Code**: All modules must declare inputs, outputs, side-effects, and dependencies.
2. **Provider Agnostic**: AI features must route through the `AIRouter` layer.
3. **Event-Driven**: Decoupled communication using the EventBus and WebSockets.

For specific implementation details, refer to the `/skills` directory.
