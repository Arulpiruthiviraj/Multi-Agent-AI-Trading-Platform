---
kind: concept
family: execution
status: RESEARCHED
argus_status: MISSING_HIGH
argus_refs:
  - src/server/engines/backtest/Slippage.ts
  - src/server/engines/PositionSizing.ts
sources:
  - { title: "The Implementation Shortfall: Paper vs. Reality", authors: "André Perold", year: 1988, url: "", license: "academic (Journal of Portfolio Management 14(3); verify DOI before citing)" }
evidence_quality: 80
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Perold (1988) defined implementation shortfall (IS): the difference between a paper portfolio's return (decisions executed instantly at decision prices, no frictions) and the real portfolio's return — decomposed into explicit costs (commissions, fees, taxes) and implicit costs (market impact, timing/delay, opportunity cost of unfilled orders).
- RESEARCH FINDING: IS is measured against the *arrival price* (mid-quote when the decision was made), not against the close or the next open — the benchmark choice determines what the number means. Arrival-price IS is the industry standard for execution quality.
- VERIFIED FACT: Argus measures slippage per fill in backtest (`Slippage.ts`, dynamic volatility/participation-scaled) but has no implementation-shortfall accounting on the live/paper path — no arrival-price benchmark, no explicit-vs-implicit decomposition, no per-agent/per-strategy cost attribution (verified by repo search, 2026-10-05).
- INFERENCE: This is the missing feedback loop between the EXECUTION layer and the STRATEGY layer: a strategy with gross Sharpe 1.0 and 0.4 of IS drag is a 0.6 strategy, and Argus currently cannot tell its strategies apart on this dimension in paper trading.
- HYPOTHESIS: Recording `arrivalMid` at `TRADE_IDEA_GENERATED` time and comparing to realized fill prices would give Argus its first true total-cost number per strategy — the input every cost-aware gate (DSR with costs, synthesis certification) is currently missing.

## Mathematics
For a buy of `X` shares decided at `t_0` with arrival mid `P_0`, executed in fills `(x_j, P_j)`: `IS = X·P_0 − Σ_j x_j·P_j − explicit_costs` (signed so positive = cost). Decomposition: `IS = delay_cost + impact_cost + opportunity_cost + explicit`, where `delay = X·(P_0 − P_firsttrade)` (price moved before you started), `impact = Σ_j x_j·(P_firsttrade − P_j)`-style execution drag, `opportunity = (X − Σx_j)·(P_0 − P_T)` for the unfilled remainder vs the end-of-horizon price.

## Economic rationale
Microstructure + arithmetic: every strategy's paper return is gross of the frictions that scale with its own trading. IS accounting is how you learn which strategies survive contact with the market — it converts "the backtest says 15%" into "the strategy keeps 9% after its own footprint."

## Argus mapping
MISSING_HIGH. Implementation: stamp `arrivalPrice`/`arrivalTs` on the idea envelope at `TRADE_IDEA_GENERATED` (quote snapshot already flows through the pipeline), persist per-fill, and compute IS in the fill-processing path. Pure measurement — no order-path change, no safety implications. Feeds: per-strategy cost ledgers, the DSR-with-costs gate, execution-quality summaries (which already partition organic/paper/replay — extend them with IS). Layer: execution → performance attribution.

## Failure modes
(1) Arrival-price staleness: if the quote at idea time is stale, IS misattributes; reuse the existing freshness gates. (2) Benchmark gaming: arrival price must be captured *before* any execution information leaks into it — capture at idea emission, not at OMS. (3) Analysis paralysis: IS is a diagnostic, not a veto — don't gate trading on it until the measurement has months of history.

## Verdict
PROMOTE to specified → implemented as measurement-only. The single most valuable execution-layer addition: zero safety risk, and it produces the cost numbers every downstream validation gate is currently forced to assume.
