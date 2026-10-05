---
kind: method
family: ml
status: RESEARCHED
argus_status: MISSING_HIGH
argus_refs: []
sources:
  - { title: "Advances in Financial Machine Learning", authors: "Marcos López de Prado", year: 2018, url: "https://www.wiley.com/en-us/Advances+in+Financial+Machine+Learning-p-9781119482086", license: "book (Wiley)" }
evidence_quality: 75
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: De Prado (AFML ch. 3) argues ML should NOT predict direction from scratch — it should *meta-label* an existing rule-based strategy's signals: primary model generates side (long/short), secondary ML model predicts P(outcome is profitable | features), and position size scales with that probability.
- RESEARCH FINDING: Meta-labeling changes the ML problem from "predict returns" (low signal-to-noise, dominated by noise) to "predict whether this setup works" (a classification problem conditioned on a real entry trigger). This dramatically reduces the overfitting surface vs end-to-end ML.
- RESEARCH FINDING: Bet sizing via the S-curve: z = (p − 0.5)/√(p(1−p)), size = 2·N(z) − 1, where N is the standard normal CDF. Conservative near p=0.5, ramps only at high conviction, prevents over-betting on marginal signals (AFML ch. 10).
- INFERENCE: This is the correct ML shape for Argus: keep the Java rule-based strategies as the primary signal generators, train classifiers only on "was this signal profitable after costs" labels.
- HYPOTHESIS: Meta-labels trained on Argus's own paper-trading outcomes (real fills, real costs) would be more honest than meta-labels trained on backtest outcomes.

## Mathematics
Primary: signal s_t ∈ {−1, +1} from rule-based strategy (existing Java strategies).
Meta-label: y_t = 1{trade profitable after costs}, features X_t (volatility, regime, spread, signal strength, time-of-day, etc.).
Secondary model: p_t = P(y_t = 1 | X_t) via calibrated classifier (logistic, random forest, XGBoost — with purged CV).
Sizing: z_t = (p_t − 0.5)/√(p_t(1−p_t)); w_t = 2·Φ(z_t) − 1; position = w_t × base_size. Note w_t → 0 as p_t → 0.5, w_t → ±1 as p_t → {0,1}.

## Economic rationale
No new alpha claimed — this is a *risk/return shaping* technique. The edge comes from the primary strategy; ML only decides how much to bet. Even a weakly predictive meta-model improves risk-adjusted returns by cutting size on low-probability setups.

## Argus mapping
MISSING_HIGH. Argus has: rule-based Java strategies (primary signals) ✓, paper-trading outcome logging ✓, cost data ✓. Missing: the meta-label training loop, the calibrated classifier, the S-curve sizing integration into PositionSizing. The `recordPrediction`/`PredictionOutcomeEvaluator` pipeline is the natural label source.

## Failure modes
Meta-model overfits to a regime and mis-sizes (mitigate: purged CV, embargo, walk-forward); label noise from small samples; calibration drift (recalibrate on rolling windows).

## Verdict
PROMOTE to research queue as the #1 ML project. Lower overfitting surface than any end-to-end price-prediction ML. Requires the paper-trading outcome stream to be flowing first (labels need real outcomes).
