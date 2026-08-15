# ARGUS_DATA_AVAILABILITY_SPEC.md

Statuses already used: AVAILABLE, STALE, MISSING, NOT_SUPPORTED, INSUFFICIENT_DATA, etc.

MarketContext.breadth, options, L2, volume profile, Canadian FX: **NOT_SUPPORTED** on the feature snapshot — `tradingBlocked: false` unless a RiskEngine gate already requires that data.

Never fill zeros. Cap confidence in the thesis `missingEvidence` list; do not invent a 72% cap in code unless it is added to `tradingSafety.json` later.
