# ARGUS_DATA_AVAILABILITY_SPEC.md

Statuses already used: AVAILABLE, STALE, MISSING, NOT_SUPPORTED, INSUFFICIENT_DATA, etc.

MarketContext.breadth, options, L2, volume profile, Canadian FX: **NOT_SUPPORTED** on the feature snapshot — `tradingBlocked: false` unless a RiskEngine gate already requires that data.

Implemented on `QuantitativeFeatureEngine` snapshots (`unavailable.*`) and `TradeThesis.missingEvidence`. Never fill zeros. Do not invent a numeric “confidence cap at 72%” unless it is added to `tradingSafety.json`.
