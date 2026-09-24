# QuantEvidence Capability Matrix (Milestone B, 2026-09-23)

Honest, conservative producer x field matrix for `src/server/quant/QuantEvidence.ts`. This is the
deliverable that keeps the `QuantEvidence` contract from looking richer than the underlying Java
engines actually are today. Every cell reflects what the adapters in
`src/server/quant/quantEvidenceAdapters.ts` actually emit — this file is a description of that code,
not an aspiration.

Labels: **REAL_VALUE** (direct engine output), **DERIVED** (deterministic transform of real fields,
computed and documented at the adapter), **NULL_NOT_SUPPORTED** (no field, no honest derivation),
**NOT_YET_CALIBRATED** (conceptually possible, no real calibration evidence backing it yet).

This milestone does not change any vote/consensus authority — see `QuantEvidence.ts`'s header and
the parity tests in `QuantEvidence.test.ts` for the byte-for-byte-unchanged-behavior proof.

## Live-wired producers (have an adapter, have a real HTTP consumer today)

| Field | JavaFactorComposite | JavaCoreEnsemble |
|---|---|---|
| `strategyId` | NULL_NOT_SUPPORTED (composite, no single constituent id) | NULL_NOT_SUPPORTED (ensemble spans 5 strategies) |
| `rawScore` | REAL_VALUE (`rawAvgConfidence`) | REAL_VALUE (`score`) |
| `normalizedScore` | NULL_NOT_SUPPORTED (no distinct 0-1 field beyond confidence) | DERIVED (`effectiveIndependentCount / strategyCount`) |
| `confidence` | REAL_VALUE (`adjustedConfidence`, post regime/vol multiplier) | REAL_VALUE (`confidence`) |
| `predictedReturn` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `predictedVolatility` | NULL_NOT_SUPPORTED (composite is Z-score-like, not a vol forecast) | NULL_NOT_SUPPORTED |
| `downsideRisk` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `upsidePotential` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `probabilityUp` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `probabilityDown` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `probabilityFlat` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `uncertainty` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `calibrationStatus` | NOT_YET_CALIBRATED (real calibration lives in `agent_confidence_calibration`, resolved outside this pure mapper) | NOT_YET_CALIBRATED (same) |
| `calibrationSampleSize` | NOT_YET_CALIBRATED | NOT_YET_CALIBRATED |
| `regime` | REAL_VALUE (`regime`, real HMM label) | REAL_VALUE when Java returns a non-null `regime` string, else NULL_NOT_SUPPORTED |
| `estimatedTransactionCostBps` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `netExpectedReturn` | NULL_NOT_SUPPORTED | NULL_NOT_SUPPORTED |
| `costQuality` | NOT_APPLICABLE | NOT_APPLICABLE |
| `dataFreshness` | NULL_NOT_SUPPORTED (checked separately, downstream, against live tick cache) | NULL_NOT_SUPPORTED (same pattern) |
| `inputCompleteness` | NULL_NOT_SUPPORTED | DERIVED (`agreeingCount / strategyCount`) |

Non-provenanced identity fields (always populated, not a measured quantity):

| Field | JavaFactorComposite | JavaCoreEnsemble |
|---|---|---|
| `methodologyFamily` | `FACTOR_MODEL` | `TECHNICAL_ENSEMBLE` |
| `dataDependency` | `CANONICAL_BARS` | `CANONICAL_BARS` |
| `timeHorizon` | `DAILY` | `INTRADAY` |
| `direction` | from `rawSide` (`NEUTRAL` mapped to `HOLD`) | from `direction` (already `BUY`/`SELL`/`HOLD`) |

## Not-yet-wired producers (~124 RESEARCH-status engines, `config/engineOwnership.json`)

Every other engine catalogued in `quant-core-java/institutional/` (GARCH/EGARCH standalone,
DCC-GARCH, stat-arb, PCA, decision tree/random forest/gradient boosting/KNN, linear SVM,
AR/VAR/ARMA/ARIMA/SARIMA, Kalman filter, mean-variance/risk-parity optimizers, dynamic factor model,
and the rest) is **NOT_YET_WIRED**: zero HTTP endpoint consumer today, so there is no real response
shape for an adapter to map from. Building a `QuantEvidence` adapter for one of these would require
either fabricating fields from nothing (explicitly disallowed) or wiring a live consumer first, which
is out of scope for this milestone (see "What NOT to do" in the Milestone B mandate). Note also that
the 3 SHADOW-status engines with a real endpoint but no vote wiring yet (`garch`, `hmm_regime`,
`market_data_quality`/`feature_pipeline`/`volatility_engine` per `engineOwnership.json`) are consumed
today only as **debate-context text** inside `ChiefTraderAgent.loadJavaInstitutionalDebateContext()`,
not as a `TRADE_IDEA_GENERATED` vote — they are visible to Argus, but through a different mechanism
than the two adapters above, and are also left NOT_YET_WIRED in this matrix rather than force-fit
into a `QuantEvidence` adapter this pass didn't build or test.

## Judgment calls made (flagged explicitly per the mandate)

- `normalizedScore` for `JavaCoreEnsemble` and `inputCompleteness` for `JavaCoreEnsemble` were the
  closest calls between DERIVED and REAL_VALUE. Both are simple divisions of two fields Java itself
  reports (`effectiveIndependentCount`, `strategyCount`, `agreeingCount`) — the division itself is
  not something Java's response computes and returns as a named field, so the more conservative
  label (DERIVED, not REAL_VALUE) was used.
- `calibrationStatus`/`calibrationSampleSize` are `NOT_YET_CALIBRATED` at the **adapter** level for
  both producers, meaning "this pure mapping function does not look up calibration data" — not a
  claim that `agent_confidence_calibration`/`ModelPerformanceTracker` calibration evidence doesn't
  exist elsewhere in the system. A future, DB-aware wrapper around these adapters could resolve a
  real `CALIBRATED` status from that table; this pass intentionally kept the adapters pure
  (no DB/network access) per the mandate's "pure mapping functions" instruction.
- `regime` for `JavaCoreEnsemble` is conditionally REAL_VALUE vs. NULL_NOT_SUPPORTED depending on
  whether Java itself returned a non-null string for that specific evaluation — this is a per-call
  runtime distinction, not a fixed per-producer cell, and the matrix table above reflects both
  branches for honesty.
