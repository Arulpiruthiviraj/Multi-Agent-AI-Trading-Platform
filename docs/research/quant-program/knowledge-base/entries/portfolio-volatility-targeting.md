---
kind: concept
family: risk
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - quant-core-java/src/main/java/io/argus/quantcore/strategy/institutional/VolScaledMtfMomentumStrategy.java
  - src/server/engines/PositionSizing.ts
sources:
  - { title: "Momentum Has Its Moments", authors: "Pedro Barroso, Pedro Santa-Clara", year: 2015, url: "https://doi.org/10.1016/j.jfineco.2014.07.003", license: "academic" }
evidence_quality: 75
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Volatility targeting — scaling exposure to `σ_target / σ̂_t` — is standard institutional practice (risk-parity funds, CTA trend programs): it stabilizes portfolio risk through regimes instead of letting position risk ride the market's volatility.
- RESEARCH FINDING: Barroso & Santa-Clara (2015) show that scaling a momentum portfolio by its recent realized variance (targeting constant vol) roughly doubles the Sharpe and largely eliminates momentum crashes — the crash is a volatility event first, a return event second.
- VERIFIED FACT: Argus already vol-scales *signals* (`VolScaledMtfMomentumStrategy` expresses momentum in Sharpe-like units) but has no *portfolio-level* volatility target — total portfolio heat still floats with market volatility (verified by repo review 2026-10-05).
- INFERENCE: Portfolio-level vol targeting is the natural complement to the existing signal-level vol scaling: one normalizes the *signal*, the other normalizes the *book*. Both are needed for the "constant risk through regimes" property institutions actually implement.
- HYPOTHESIS: For Argus's concentrated book, a portfolio vol target (e.g. scale gross exposure so predicted portfolio vol ≈ target) would cut the dominant realized risk — correlated positions ballooning in volatile markets — more than any new signal would add in return.

## Mathematics
Position-level: `w_{i,t} = (σ_target / σ̂_{i,t}) · s_{i,t}` (`s` signal weight). Portfolio-level: `W_t = W_raw,t · (σ_target / σ̂_{p,t})`, `σ̂_{p,t} = √(W'_{raw} Σ̂_t W_{raw})` with shrunk Σ̂ (see `portfolio-covariance-shrinkage`). Barroso–Santa-Clara form: `r*_{t} = (σ_target / σ̂_{t-1}) · r_t` applied to the strategy return series — note the *lag*: scale by last period's vol estimate, never contemporaneous. Floor/cap the scaler (e.g. [0.25, 2.0]) to avoid absurd leverage in dead markets or zero exposure in panics.

## Economic rationale
Risk-based: volatility is the one moment of returns that is forecastable (GARCH effects), so targeting it converts a forecastable quantity into stable risk-taking. It does not create alpha — it stops the portfolio from accidentally doubling its risk exactly when diversification fails.

## Argus mapping
EXISTS_INCOMPLETE. Signal-level scaling exists; the portfolio-level target belongs in the RISK layer (PositionSizing/RiskEngine), applied to gross exposure after sizing, before OMS. Needs: a portfolio vol estimator (shrunk covariance + current weights) and a configured target with scaler caps in `config/`. Layer: risk.

## Failure modes
(1) Vol targeting *increases* turnover — scaling moves with σ̂; without rebalance bands it churns. (2) In a volatility spike, the scaler cuts exposure into the panic — correct for risk, but it locks in the inability to benefit from the rebound; this is risk control, not return enhancement, and must be framed that way. (3) Target picked from a calm sample underestimates crisis σ̂ — calibrate the target on a full-cycle sample.

## Verdict
RESEARCH FURTHER → specify portfolio vol targeting with shrunk-covariance input and capped scaler as a RiskEngine-adjacent overlay. Pairs naturally with the risk-budget work in `portfolio-risk-parity`.
