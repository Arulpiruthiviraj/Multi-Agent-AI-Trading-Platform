---
kind: infrastructure
family: architecture
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - src/server/replay/
  - src/server/engines/backtest/BacktestEngine.ts
  - src/server/engines/backtest/HistoricalDataGateway.ts
sources:
  - { title: "LEAN Algorithmic Trading Engine", authors: "QuantConnect", year: 2015, url: "https://github.com/QuantConnect/Lean", license: "Apache-2.0" }
evidence_quality: 70
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- VERIFIED FACT: LEAN is an open-source event-driven algorithmic trading engine (C# core, Python/C# algorithms) under Apache-2.0 (confirmed via upstream license and multiple third-party license audits, Oct 2026).
- VERIFIED FACT: LEAN's core design promise is that the same algorithm code runs in backtest and live trading — backtest/live parity by construction.
- RESEARCH FINDING: LEAN ships configurable fill and slippage models, corporate-action-adjusted data, and official documentation covering walk-forward analysis with explicit look-ahead-bias warnings.
- INFERENCE: The transferable ideas for Argus are architectural patterns (event parity, fill-model transparency, corporate-action safety, universe selection), not code — LEAN is a C# system and Argus's quant authority is Java.
- VERIFIED FACT: Argus already implements the central LEAN idea independently: Argus Historical Evaluation (MODE B, `src/server/replay/`) runs real historical bars through the real ChiefTrader vote-math, RiskEngine, and OMS against `HistoricalReplayBroker`.
- VERIFIED FACT: Argus's backtest engine uses SAME_BAR_CLOSE fills by default with NEXT_BAR_OPEN for promotion, dynamic volatility/participation-scaled slippage (`Slippage.ts`), and a real corporate-action detection check (`HistoricalDataGateway.checkForUnadjustedCorporateActions`).

## Mathematics
Not a mathematical discovery — an architecture. The portable quantitative content is LEAN's fill-model discipline: every fill price `P_fill` is an explicit function `P_fill = f(P_bar, side, quantity, volatility, volume)` with the function and its parameters recorded per trade, so backtest realism is auditable rather than assumed.

## Economic rationale
Backtest/live parity exists to kill the most expensive bias in retail quant: a backtest that cannot lose because its fills, data, and execution assumptions are fictional. The economic value is entirely in avoiding false confidence, not in generating alpha.

## Argus mapping
EXISTS_INCOMPLETE. Argus already has: event-driven replay parity (MODE B), fill-model transparency (per-trade `slippagePct`), corporate-action detection, dynamic slippage. What's missing vs the LEAN checklist: (1) no borrow-cost/short-availability modeling in backtest (moot while shorting is unavailable, but the hook should exist); (2) no official walk-forward *documentation* pattern with lookahead warnings — the Python WFO exists but the discipline is tribal knowledge; (3) no universe-selection API equivalent (Argus discovery funnels are ad-hoc per scanner). Layer: architecture/research-infrastructure.

## Failure modes
Adopting LEAN as a dependency would fork the stack (C# vs Java engine authority, Docker/live-node machinery Argus doesn't need) and import a second order path — a direct violation of the protected-spine contract. Blindly copying its default fill models without Argus's own measurement would substitute one fiction for another.

## Verdict
**Classification: B (useful concept, not now as a dependency).** Learn the checklist, don't vendor the engine. Concrete takeaways for the roadmap: (a) a written backtest-realism checklist (corporate actions, fill timing, borrow, delisting/survivorship) enforced by tests; (b) walk-forward discipline documented next to the WFO scripts; (c) keep the MODE B parity guarantee as the architectural crown jewel. AGPL/GPL backtesters (backtesting.py AGPL-3.0, backtrader GPL-3.0) are **D — unsuitable** on license grounds alone; zipline-reloaded (Apache-2.0) is unmaintained and adds nothing over Argus's own engine.
