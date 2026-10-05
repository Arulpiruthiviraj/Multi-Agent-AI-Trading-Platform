---
kind: concept
family: execution
status: RESEARCHED
argus_status: MISSING_MEDIUM
argus_refs:
  - src/server/engines/backtest/Slippage.ts
  - src/brokers/AlpacaBroker.ts
sources:
  - { title: "Algorithmic Trading and DMA (industry standard reference)", authors: "Barry Johnson", year: 2010, url: "", license: "book (verify ISBN/DOI before citing)" }
evidence_quality: 75
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: TWAP (time-weighted average price) and VWAP (volume-weighted average price) are the two baseline execution schedules in institutional trading: TWAP slices an order into equal pieces over equal time intervals; VWAP weights slices by the historical intraday volume profile.
- RESEARCH FINDING: VWAP beats TWAP on implementation cost *when* the volume profile is predictable and the order is small relative to volume — because trading with the volume curve minimizes temporary impact. For small orders (Argus's size), both are dominated by spread-crossing cost, and the schedule choice is second-order.
- VERIFIED FACT: Argus has no execution scheduling — orders go as immediate market orders via OMS/BrokerManager; slippage is modeled in backtest (`Slippage.ts`) but not *managed* in execution (verified by repo search for TWAP/VWAP execution logic, 2026-10-05).
- INFERENCE: At Argus's current size (small fraction of ADV per trade), a TWAP/VWAP scheduler is a cost-measurement and discipline tool, not a cost-saving tool — the savings are basis points, but the *audit trail* (scheduled vs realized) is the foundation for implementation-shortfall accounting.
- HYPOTHESIS: The realistic Argus execution ladder is: (1) measure implementation shortfall vs arrival price on every paper fill; (2) add a simple TWAP splitter for orders above a participation threshold; (3) VWAP only if intraday volume profiles prove stable for Argus's names. Step 1 alone is most of the value.

## Mathematics
Order of `X` shares over `[0, T]`, `N` slices. TWAP: `x_k = X/N`, trade at times `t_k = kT/N`; benchmark `P_TWAP = (1/N)Σ_k P_{t_k}`. VWAP: `x_k = X·(v_k/V)` with historical volume profile `v_k`, `V = Σv_k`; benchmark `P_VWAP = Σ_k (v_k/V)·P_k`. Participation rate: `ρ_k = x_k / V_k` (own volume / market volume in slice k) — the control knob for market impact; keep `ρ ≤ 5–10%` as a rule of thumb for small-cap names.

## Economic rationale
Microstructure: splitting reduces temporary price impact (the market absorbs small pieces at the spread) at the cost of timing risk (price drifts during execution) and opportunity cost. The schedule trades impact cost against variance — the same frontier Almgren–Chriss formalize (see `execution-market-impact`).

## Argus mapping
MISSING_MEDIUM. Belongs in the EXECUTION layer: an `ExecutionScheduler` between OMS and BrokerManager that splits orders above a configurable participation threshold, emitting child orders on a timer. Must not bypass OMS accounting — children reconcile to the parent order. Paper-first: run the scheduler against the paper broker and measure shortfall before any live consideration. Layer: execution.

## Failure modes
(1) Scheduler bugs are *order-path* bugs — a stuck child-order loop over-trades; needs kill-switch integration and max-child guards from day one. (2) VWAP on a bad volume profile is worse than TWAP — profile staleness must be monitored. (3) Over-engineering: for Argus's size, a TWAP is 90% of the benefit; adaptive "smart" schedules add failure modes without measurable savings.

## Verdict
RESEARCH FURTHER, in order: shortfall measurement first (no new order path), TWAP splitter second (paper only), VWAP third (only with evidence). Never let the scheduler bypass OMS/RiskEngine accounting.
