---
strategy: "Risk-managed (volatility-scaled) time-series momentum"
family: "momentum"
source: { paper: "Momentum Has Its Moments", authors: "Barroso, Santa-Clara", year: 2015, url: "https://doi.org/10.1016/j.jfineco.2014.07.003", license: "academic" }
status: RESEARCHED
argus_status: MISSING_HIGH
evidence_quality: 80
last_reviewed: 2026-10-05
---

## Economic rationale
Behavioral (underreaction/delayed overreaction — same as plain momentum) plus a risk-mechanical insight: momentum crashes are volatility events. Scaling exposure inversely to recent realized variance cuts exposure exactly when crash risk is highest, converting a negatively-skewed strategy into a better-behaved one. No new alpha source is claimed — the same premium, harvested with crash insurance priced by realized vol.

## Mathematical definition
Let `r_t` be the month-`t` return of a base momentum portfolio (WML cross-sectional or TSMOM time-series). Realized variance estimate: `σ̂²_{t-1} = Σ_{d∈month t-1} r²_d` (daily squared returns, no centering). Scaled return: `r*_t = (σ_target / σ̂_{t-1}) · r_t`, with `σ_target` a constant (B&S use 12% annualized). Position scale applied with a one-period lag — never contemporaneous. Optional: unconstrained vs capped scaler; B&S report both.

## Signal construction
1. Build the base momentum signal exactly as the existing Argus TSMOM (12-1 formation, sign of trailing return).
2. Estimate trailing 21-day realized volatility of the *strategy's own return series* (or of the underlying basket).
3. Scale the position: `w_t = w_base,t · (σ_target / σ̂_{t-1})`, capped to `[0.25, 2.0]`.

## Entry / Exit / Position sizing
Entry: base TSMOM entry rules (existing Java strategies). Exit: base TSMOM exit rules. Sizing: the vol scaler multiplies the base size; the scaler is recomputed monthly (B&S) — weekly recomputation is a research variant, not the paper spec.

## Required data & frequency
Daily OHLCV only. Monthly rebalance of the scaler.

## Transaction-cost sensitivity
MEDIUM. The scaler changes turnover vs unscaled momentum (scales up in calm markets, down in volatile ones). Net effect on costs is ambiguous ex ante — must be measured with the cost-aware backtest, not assumed.

## Expected capacity
MEDIUM. Same universe as TSMOM; scaling doesn't change the footprint much. Fine for Argus's size.

## Regime dependence
Designed for regime turns: cuts exposure into volatility spikes (2009-style crash protection is the headline result). Underperforms unscaled momentum in long, calm trends (pays an insurance premium — leverage capped below what unscaled would take).

## Known weaknesses
- The vol forecast is backward-looking; a crash that arrives *without* a vol warning (overnight gap on news) is not hedged.
- Scaler whipsaw: vol spikes then mean-reverts → sells low, rebuys higher.
- Parameter `σ_target` and cap bounds are judgment calls.

## Academic evidence
Barroso & Santa-Clara (2015, JFE): vol-scaled WML roughly doubles Sharpe vs plain WML 1927–2011 and eliminates the 2009 crash; also applied to TSMOM, value, and BAB with similar improvement. Daniel & Moskowitz (2016) independently document the crash dynamics this exploits.

## Post-publication evidence
Vol-scaling of momentum is now industry standard (CTA programs, AQR-style implementation) — which validates the idea and simultaneously raises crowding concerns. No published replication has overturned the crash-mitigation result, but forward Sharpe of scaled momentum post-2015 is lower than the 1927–2011 backtest (consistent with both crowding and the general post-publication decay pattern).

## Crowding risk
MEDIUM-HIGH. The technique is no longer proprietary — every CTA does some version. The remaining edge is in *Argus-specific* calibration (which vol estimator, which caps, which rebalance frequency), not in the idea itself.

## Complexity
LOW. One additional computation (realized vol of the strategy return) on top of existing TSMOM.

## Argus relevance
9/10 — signal layer. Argus already has two TSMOM variants in Java; this is a thin, well-specified overlay on top of them. Directly addresses the #1 documented failure mode of the strategies Argus just wired to paper (momentum crashes).

## Confidence
65% that a correctly implemented version improves risk-adjusted OOS performance vs unscaled TSMOM on Argus's universe. What would change it: a cost-aware walk-forward on Argus data showing the scaler's turnover cost exceeds the crash protection, or evidence the vol estimator lags too far at daily-bar granularity.

## Verdict
RESEARCH FURTHER — highest-priority strategy card. Implement in Java as a portfolio-level overlay on the existing TSMOM strategies (not a new strategy), then cost-aware walk-forward vs the unscaled baseline. Promote only if net-of-cost OOS Sharpe improves with statistical significance (DSR).
