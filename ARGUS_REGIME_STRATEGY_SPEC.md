# ARGUS_REGIME_STRATEGY_SPEC.md

## Existing (keep)

- `RegimeEngine.classifyRegime`: BULLISH_TREND / BEARISH_TREND / SIDEWAYS_RANGE (+ volatility/structure on the result).
- `StrategyEngine.evaluateAll` **discounts** off-regime confidence (`regimeMismatchConfidenceMultiplier` in `tradingSafety.json`).
- `regimeStrategyEligibility` lists eligible vs ineligible without treating regime as a trade.
- High-vol position cuts belong in RiskEngine / RestrictedLive — not a new parallel limiter.

## Not added this pass

A learned 4×4 “strategy sleeping” matrix. That requires a real closed-trade sample. This environment has **zero** organic closed paper trades. Shipping a matrix of invented win rates would be fake edge.

## Config

Strategy applicability remains on each strategy module’s `applicableRegimes`. Do not hardcode strategy names in RegimeEngine.
