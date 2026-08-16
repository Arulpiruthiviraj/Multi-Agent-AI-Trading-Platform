# ARGUS_MISSING_CAPABILITIES.md

Things that are **absent or unused**, not “files to duplicate.” Updated 2026-08-15.

## Genuinely absent (do not fabricate)

- Market breadth (A/D, % above SMA, new highs/lows) — MarketContext reports `available:false`.
- Options IV/greeks/GEX (no options feed).
- L2 / order-book imbalance (Alpaca IEX is top-of-book).
- Cointegration / pairs engine (correlation/beta exist; cointegration does not).
- TSI (not implemented; correlated with existing oscillators).
- Event-anchored VWAP (session VWAP, slope, reclaim/rejection exist in `computeVWAPContext`).
- Volume profile / HVN/LVN.
- CAD/USD FX feed, TMX holidays, point-in-time Canadian news.
- LangGraph checkpoint runtime (OMS crash recovery is a different, existing mechanism).
- Historical AI replay of past years without a point-in-time news/LLM corpus (`aiReplayAvailability.ts` = UNAVAILABLE).

## Implemented as features, not live BUY/SELL

- RSI/MACD **named divergence** (`isTradeSignal: false`).
- SMC liquidity / sweep / FVG / order block / trap-as-pattern (`isTradeSignal: false` on sweeps; trap `isIntentionalManipulation: false`).
- `TradeThesis` on Quant ideas; `NO_TRADE` reason catalog in JSON.
- Bull/Bear `parseResearchNote` — **not** in ChiefTrader until `QUANT_BULL_BEAR_ENABLED=true`.

## Implemented but not always-on

- Entire `src/server/quant/` stack (`QUANT_ENGINE_ENABLED`).
- `SMC_LIQUIDITY_SWEEP` (`QUANT_SMC_STRATEGY_ENABLED`; also backtestable via `findStrategy` without that flag).
- Expected value / Kelly (need ≥20 real closed strategy trades; this env has **zero** organic closed paper trades).
- `MarketRegimeAgent` LLM regime events are **not consumed** by ChiefTrader (distinct from `RegimeEngine`).
- `AdvancedQuantEngines` telemetry unused.

## Must not “fix” by turning everything on

NewsAgent 44.6% on 242 live predictions. Two walk-forward OOS checks on core quant combos failed. Enabling SMC or Bull/Bear in LIVE would increase false confidence.

**Current stance:** Quant off by default. SMC experimental. Bull/Bear parser off. Restricted real money **NO-GO**.
