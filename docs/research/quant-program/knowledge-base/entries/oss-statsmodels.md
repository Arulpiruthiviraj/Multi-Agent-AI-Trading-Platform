---
kind: infrastructure
family: architecture
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - quant-core-java/src/main/java/io/argus/quantcore/institutional/math/OlsRegression.java
  - quant-core-java/src/main/java/io/argus/quantcore/stats/
  - python/argus_research/
sources:
  - { title: "statsmodels", authors: "Skipper Seabold, Josef Perktold et al.", year: 2010, url: "https://github.com/statsmodels/statsmodels", license: "BSD-3-Clause" }
evidence_quality: 75
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- VERIFIED FACT: statsmodels is a BSD-3-Clause Python library for statistical modeling and econometrics: OLS/GLM, ARIMA/SARIMAX, VAR, cointegration tests, Markov regime-switching, and full inference (standard errors, p-values, diagnostic tests) — confirmed via upstream metadata and the Seabold & Perktold (2010) JSS paper.
- VERIFIED FACT: Unlike scikit-learn (prediction-oriented), statsmodels is inference-oriented: every fit returns coefficient tables, confidence intervals, and residual diagnostics — the correct tool for asking "is this effect real?" rather than "what's the forecast?".
- VERIFIED FACT: Argus's Java core already reimplements the needed primitives natively (`OlsRegression`, `RollingStatistics`, AR/VAR/ARIMA/SARIMA engines) — the Java engine authority forbids routing inference through Python in production.
- INFERENCE: statsmodels' proper role is the *research-side second opinion*: when a Java test says a factor is significant, reproducing the regression in statsmodels with full diagnostics is a cheap, independent verification of the math — the same parity discipline Argus already uses between TS and Java.
- RESEARCH FINDING: Its `tsa.stattools` (ADF, KPSS, coint, acf/pacf) and `tsa.regime_switching` (MarkovRegression/MarkovAutoregression) cover stationarity and regime tests Argus's research pipeline will need for any serious time-series validation.

## Mathematics
The portable content is textbook inference, e.g. OLS `β̂ = (X'X)^{-1}X'y` with `Var(β̂) = σ²(X'X)^{-1}`, ADF test regression `Δy_t = α + βt + γy_{t-1} + Σδ_i Δy_{t-i} + ε_t` testing `γ = 0`, and Johansen cointegration — all standard, all reimplementable from the documentation without copying code.

## Economic rationale
Inference discipline is what separates "the backtest Sharpe is 1.2" from "the effect is distinguishable from noise after accounting for trials." statsmodels exists to answer the second question; Argus's promotion gates (DSR, PBO, CPCV) are the same question asked at the strategy level.

## Argus mapping
EXISTS_INCOMPLETE. Java owns the production math; the Python research env (`python/argus_research/`) is the right home for statsmodels as a verification tool. Missing: a documented "second-opinion" step in the research loop (Java result → statsmodels reproduction → sign-off) for any claimed statistical significance. Layer: research infrastructure.

## Failure modes
(1) p-hacking with better tooling: full diagnostic tables make it *easier* to fish for a significant specification — every statsmodels result must be pre-registered (hypothesis first) per the charter's experiment discipline. (2) Using in-sample inference statistics (AIC, p-values) as promotion evidence without OOS confirmation. (3) Non-stationarity ignored: regressing prices instead of returns — the ADF check must be a habit, not an afterthought.

## Verdict
**Classification: C (research only).** Keep in the Python research env as the independent verification tool for Java inference; document the second-opinion step in the research loop. Never in the decision path.
