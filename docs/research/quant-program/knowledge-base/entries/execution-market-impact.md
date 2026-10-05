---
kind: paper
family: execution
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - src/server/engines/backtest/Slippage.ts
sources:
  - { title: "Optimal Execution of Portfolio Transactions", authors: "Robert Almgren, Neil Chriss", year: 2000, url: "", license: "academic (Journal of Risk 3(2); verify DOI before citing)" }
  - { title: "Direct Estimation of Equity Market Impact", authors: "Almgren, Thum, Hauptmann, Li", year: 2005, url: "", license: "academic" }
evidence_quality: 80
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Almgren–Chriss (2000) formalize optimal execution as a mean–variance tradeoff: minimize `E[C] + λ·Var[C]` over liquidation trajectories, where `C` is execution cost — yielding an "efficient frontier" of execution strategies parameterized by risk aversion `λ`, from patient (low impact, high timing risk) to aggressive (high impact, low timing risk).
- RESEARCH FINDING: Their impact model splits price impact into *permanent* (information-driven, linear in total quantity: `γ·X`) and *temporary* (liquidity-driven, linear in trading rate: `η·v`) components — a decomposition still used by institutional TCA two decades later.
- RESEARCH FINDING: Almgren et al. (2005) estimate market impact directly from institutional trades: impact grows roughly with the *square root* of order size relative to volume — the "square-root law" later confirmed across markets (Bouchaud et al.): `MI ≈ Y·σ·√(Q/V)`, `Y ≈ 0.5–1`.
- VERIFIED FACT: Argus's `Slippage.ts` already implements dynamic, volatility/participation-scaled slippage in backtest — the *temporary-impact intuition* is present, but there is no permanent-vs-temporary decomposition, no execution frontier, and no empirical impact calibration from Argus's own fills.
- INFERENCE: At Argus's participation rates (small fraction of ADV), expected market impact is a few basis points — the square-root law says Argus is on the flat part of the curve. The model's value here is *knowing that rigorously* and having the formula ready if size grows, not optimizing today's pennies.

## Mathematics
Liquidate `X` shares over `[0,T]`, holdings trajectory `x(t)`, rate `v = −ẋ`. Price dynamics: `S̃(t) = S(t) + γ·(X − x(t))` (permanent), execution price `Ŝ(t) = S̃(t) − η·v(t)` (temporary). Cost: `C = XS_0 − ∫_0^T v(t)Ŝ(t)dt`. Optimal trajectory for risk aversion `λ`: `x(t) = X·sinh(κ(T−t))/sinh(κT)`, `κ = √(λσ²/η̃)` — aggressive when `κ` large (front-loaded). Square-root law (empirical): `E[MI] = Y·σ·√(Q/V)`, `Q` order size, `V` daily volume, `σ` daily vol.

## Economic rationale
Microstructure: impact compensates liquidity providers for inventory risk and adverse selection. Permanent impact reflects information leakage (the market learns something from your trade); temporary impact reflects walking the book. The square-root law's robustness across venues and decades suggests a near-universal liquidity scaling.

## Argus Mapping
EXISTS_INCOMPLETE. The backtest slippage model captures temporary-impact scaling; what's missing: (1) calibrating `η, γ` (or the square-root `Y`) from Argus's own paper fills instead of fixed heuristics; (2) a pre-trade cost *estimate* surfaced to the operator ("this order is expected to cost N bps"); (3) the execution-frontier framing for any future scheduler. Layer: execution.

## Failure modes
(1) Calibrating impact on tiny orders: at Argus's size the signal is mostly noise — calibration needs hundreds of fills and honest confidence intervals, or it manufactures precision. (2) Applying institutional impact parameters to retail flow without recalibration. (3) Letting a cost *estimate* become a trading gate before the calibration is validated — estimates inform, gates decide.

## Verdict
RESEARCH FURTHER. Near-term: keep the existing slippage model, add pre-trade cost estimates from the square-root law with Argus-plausible `Y`, and log predicted-vs-realized cost per fill — the calibration dataset builds itself. Full Almgren–Chriss trajectory optimization is deferred until order sizes make it material.
