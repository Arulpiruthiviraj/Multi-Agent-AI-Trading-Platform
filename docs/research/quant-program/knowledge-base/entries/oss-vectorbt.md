---
kind: infrastructure
family: architecture
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - scripts/run_vectorbt_wfo.py
  - python/argus_research/cli.py
  - python/argus_research/stats.py
sources:
  - { title: "vectorbt", authors: "Oleg Polakow (polakowo)", year: 2020, url: "https://github.com/polakowo/vectorbt", license: "Apache-2.0 + Commons Clause" }
evidence_quality: 70
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- VERIFIED FACT: vectorbt is a Python/Numba vectorized backtesting library, Apache-2.0 **with Commons Clause** (confirmed by third-party license audits, Oct 2026) — the Commons Clause is not OSI-approved and restricts *selling* the software; internal research use is unaffected.
- VERIFIED FACT: Its core trick is vectorization: entire parameter grids are backtested as array operations (Numba-compiled), making thousand-combination sweeps interactive-speed rather than overnight jobs.
- VERIFIED FACT: It supports next-bar fills with configurable slippage/commission, and ships an official walk-forward-optimization example notebook.
- VERIFIED FACT: Argus's Python research environment already probes for vectorbt as an optional installed capability (`python/argus_research/cli.py` reports `vectorbt.installed`) and ships its own local WFO+DSR implementation (`scripts/run_vectorbt_wfo.py`, `python/argus_research/stats.py`).
- INFERENCE: vectorbt's real value to Argus is as a *research accelerator* (parameter-sensitivity tables, quick strategy triage) — never as a decision path; the Java engine stays the authority and the TS BacktestEngine stays the system of record.
- HYPOTHESIS: Vectorized sweeps would materially speed up Argus's strategy-triage loop (currently TS-engine sweeps), at the cost of maintaining a Python research stack whose results must be parity-checked against Java before any promotion.

## Mathematics
Vectorized backtest: given signal matrix `S (T x P)` (T bars, P parameter combos) and return vector `r (T)`, portfolio returns `R = S ⊙ r` computed as one broadcast operation; metrics (Sharpe, drawdown) reduce along the time axis — O(T·P) with Numba, no Python loop. The math is identical to the event loop; only the execution strategy differs.

## Economic rationale
Speed of the research loop is an economic input: faster triage means more hypotheses tested per unit of researcher time, and parameter-sensitivity surfaces (not point estimates) are the correct output of a sweep. Speed does not create edge; it only prices discovery.

## Argus mapping
EXISTS_INCOMPLETE. The capability probe exists; vectorbt is not a declared research dependency and no parity harness ties its outputs to the Java/TS engines. Any vectorbt result used beyond casual triage must pass the same parity discipline as the existing Python research env (deterministic inputs, `verify_*_parity.py` pattern). Layer: research infrastructure.

## Failure modes
(1) Treating vectorbt's fast, simplified fills (next-bar, no intrabar) as promotion-grade evidence — it is triage-grade only. (2) Parameter-sweep overfitting: a 10,000-combo grid *will* find a lucky Sharpe; every sweep must be followed by DSR/PBO accounting for the trial count (Argus already has DSR; see `validation-cpcv`). (3) Commons Clause: never build a commercial or hosted offering on vectorbt itself.

## Verdict
**Classification: B (useful concept/tool, not now as a core dependency).** Keep it as an optional, explicitly triage-grade accelerator in the Python research env; add a parity-check harness before any sweep result influences a promotion decision. Do not route any decision path through it.
