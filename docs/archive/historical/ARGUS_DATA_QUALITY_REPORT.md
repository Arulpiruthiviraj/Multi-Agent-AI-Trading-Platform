# ARGUS_DATA_QUALITY_REPORT.md

## Rule

Never silently substitute a fake number. If a feed or calculation is missing, emit a structured status.

## Already honest in QuantEngine

- `MarketContext.breadth.available: false` — no advance/decline source.
- Opening range / premarket on daily bars — `available: false` with reason.
- Quant contradiction AI — `available: false` when no provider.
- Historical AI replay — `UNAVAILABLE` with WHAT/WHY/IMPACT/FIX (`aiReplayAvailability.ts`).
- Live EV — refuses strategy ideas when win-rate sample is missing or EV ≤ 0.
- Thesis invalidation — missing RVOL/ADX/bars means that *rule* does not fire (no fabricated breach).
- Bull/Bear notes — invented numerics stripped; not treated as prices.

## New structured `NOT_SUPPORTED` records (feature snapshot)

Emitted on every `QuantitativeFeatureEngine` snapshot; `tradingBlocked: false` (omission reduces evidence, does not invent a gate):

| Key | Why |
|---|---|
| `marketBreadth` | No A/D, new highs/lows, % above SMA universe |
| `optionsAnalytics` | No options chain / IV |
| `orderFlow` | No L2; Alpaca IEX is top-of-book |
| `volumeProfile` | No volume-at-price store |
| `tsi` | Not implemented; correlated with existing oscillators |
| `anchoredVwap` | Session VWAP exists; event anchors do not |
| `pairsCointegration` | Correlation/beta exist; cointegration does not |
| `canadianCommoditiesFx` | No CAD/USD or commodity feed in MarketContext |

## Status vocabulary (target)

AVAILABLE, STALE, MISSING, INVALID, PROVIDER_ERROR, RATE_LIMITED, AUTH_ERROR, MARKET_CLOSED, NOT_SUPPORTED, CALCULATION_ERROR, INSUFFICIENT_DATA.

Divergence uses `kind: null` + `INSUFFICIENT_DATA` rather than a fake NONE when the series is too short.

## Impact on trading

These missing datasets **must not** be filled with zeros. They also **must not** be treated as automatic blocks unless a specific RiskEngine gate already requires that data (none of the new records do).
