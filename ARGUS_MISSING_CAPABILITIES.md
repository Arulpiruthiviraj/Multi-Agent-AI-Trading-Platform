# ARGUS_MISSING_CAPABILITIES.md

Things that are **absent or unused**, not “files to duplicate.”

## Genuinely absent (do not fabricate)

- Market breadth (A/D, % above SMA, new highs/lows).
- Options IV/greeks/GEX (no options feed).
- L2 / order-book imbalance (Alpaca IEX is top-of-book).
- Cointegration / pairs engine.
- TSI, anchored VWAP (session VWAP exists in quant volume module).
- RSI/MACD **named divergence** now exists as a feature (`isTradeSignal: false`); still not a live BUY/SELL.
- Volume profile / HVN/LVN.
- CAD/USD FX feed.
- TMX holidays.
- Point-in-time Canadian news.

## Implemented but not always-on

- Entire `src/server/quant/` stack (`QUANT_ENGINE_ENABLED`).
- Expected value / Kelly (need ≥20 real closed strategy trades; this env has **zero** organic closed paper trades).
- `MarketRegimeAgent` LLM regime events are **not consumed** by ChiefTrader (distinct from `RegimeEngine`).
- `AdvancedQuantEngines` telemetry unused.

## Must not “fix” by turning everything on

NewsAgent 44.6% on 242 live predictions. Two walk-forward OOS checks failed. Enabling more strategies in LIVE would increase false confidence.

P0 this session: QuantitativeFeatureEngine facade + divergence feature + regime eligibility listing. No new live strategies. No LIVE promotion. Quant still off by default.
