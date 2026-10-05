---
kind: architecture
family: architecture
status: RESEARCHED
argus_status: EXISTS_INCOMPLETE
argus_refs:
  - src/server/services/ChiefTraderAgent.ts
  - src/server/quant/internalQuantEnsemble.ts
sources:
  - { title: "Master Research: Decision Intelligence & Confluence", authors: "gangpanh4 (GitHub)", year: 2026, url: "https://github.com/gangpanh4/xauusd-algorithmic-trading-platform/blob/HEAD/docs/01_Market_Regime/Prompt%203%20—%20Master%20Research%20(Decision%20Intelligence%20&%20Confluence)/Master%20Research%20(Decision%20Intelligence%20&%20Confluence)%20duck%20ai.md", license: "public repo" }
evidence_quality: 60
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Institutional decision framing asks "what is the posterior probability this setup has positive expected value after costs, under the current regime?" — not "is there a setup (yes/no)?" Binary checklists are a retail failure mode.
- RESEARCH FINDING: The main failure mode of confluence systems is double-counting: two signals from the same information source (e.g., RSI and stochastic, both momentum) counted as two independent confirmations. Bayesian combination with dependence-aware weighting is the correct frame.
- INFERENCE: Argus's ChiefTrader consensus (0.75 weighted bar, min-2-agents) is a *voting* approximation of this. The upgrade path is: each agent emits a calibrated probability (not just side+confidence), combination uses correlation-adjusted weights (QuantEnsembleEngine already does this for quant), and the decision compares posterior edge vs. execution-adjusted cost threshold.
- HYPOTHESIS: Calibrated probabilities would also fix the "confidence = 0.35 + 4×return" style uncalibrated mappings wherever they still exist — a probability must mean something measurable.

## Mathematics
Posterior: P(edge>0 | signals) ∝ P(signals | edge>0) · P(edge>0). With dependence: use correlation-adjusted effective count n_eff = 1ᵀΣ⁻¹1 (already in QuantEnsembleEngine). Decision rule: trade iff E[return | signals] − E[cost | signals] > 0, i.e., posterior edge net of the transaction-cost model, not gross signal strength.

## Economic rationale
No alpha — this is decision hygiene. The same signals, combined correctly, produce fewer false positives and better sizing than the same signals double-counted.

## Argus mapping
EXISTS_INCOMPLETE. ChiefTrader has the voting machinery; QuantEnsembleEngine has correlation-adjusted math; what is missing: (a) calibrated per-agent probabilities (most agents emit heuristic confidences), (b) the cost term in the decision rule (expected cost is not subtracted from expected edge anywhere in the vote path), (c) regime-conditional priors (HMM regime exists but does not reweight the prior).

## Failure modes
Miscalibration is worse than no calibration (a confidently wrong probability); correlation matrix estimation error (use shrinkage); regime misclassification flipping the prior at the wrong time.

## Verdict
PROMOTE as an architecture evolution track, not a rewrite. Concrete steps: (1) calibrate each agent's confidence against its own paper outcomes (reliability curves); (2) add expected-cost subtraction to the ChiefTrader decision; (3) regime-conditional priors from HmmRegimeEngine. Each step is independently testable.
