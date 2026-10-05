# Implementation: Meta-Label Feature Capture (2026-10-05)

## Status
IMPLEMENTED - training-data capture only. No meta-model built or activated.

## What was built
- `src/server/research/MetaLabelStore.ts` - `recordMetaLabelFeatures()`, `countLabeledRows()`
- `meta_label_features` table (drizzle/0085)
- Hook in `InstitutionalStrategyVoteService.emitVoteIfEligible()` - captures on triggerMet=true,
  BEFORE confidence/price gates (avoids selection bias)
- traceId join: features.trace_id -> agent_predictions.trace_id -> predictionOutcomes

## Feature schema v1
strategy_id, symbol, signal_score, signal_confidence, regime (deterministic classifier),
decision_price, bar_count, conditions_met/failed (JSON), feature_timestamp, schema_version=1,
evidence_source (PAPER/BACKTEST/REPLAY/LIVE - never mix)

## What's NOT built
- The meta-model itself (requires sufficient PAPER labels first)
- Any consumption of features for sizing or filtering
- Calibration of the meta-model

## Evidence boundary
`countLabeledRows()` is the gate: it reports how many (features -> graded outcome) rows exist
per strategy per evidence source. Training must not begin until this count is sufficient,
and PAPER/BACKTEST/REPLAY labels must never be mixed.
