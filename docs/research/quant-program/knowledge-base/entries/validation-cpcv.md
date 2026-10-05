---
kind: method
family: risk
status: RESEARCHED
argus_status: MISSING_HIGH
argus_refs:
  - src/server/research/pbo.ts
  - scripts/run_vectorbt_wfo.py
  - python/argus_research/stats.py
sources:
  - { title: "Advances in Financial Machine Learning", authors: "Marcos López de Prado", year: 2018, url: "", license: "book (Wiley; verify ISBN before citing)" }
  - { title: "The Probability of Backtest Overfitting", authors: "Bailey, Borwein, López de Prado, Zhu", year: 2014, url: "", license: "academic (Journal of Computational Finance; verify DOI before citing)" }
evidence_quality: 80
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- RESEARCH FINDING: Standard K-fold cross-validation leaks in finance because financial returns are serially dependent: training samples adjacent to (or overlapping labels with) test samples share information, so CV overstates out-of-sample performance. This is not a subtle effect — it routinely manufactures tradable-looking Sharpe ratios from noise.
- RESEARCH FINDING: López de Prado (2018, Ch. 7) prescribes the fix: **purged** K-fold CV — drop from the training set every sample whose label interval overlaps a test sample's interval — plus an **embargo** — drop a further window after each test set to account for return autocorrelation and regime persistence.
- RESEARCH FINDING: Combinatorial Purged CV (CPCV) extends this: form all combinations of K folds into train/test splits (S = C(K,2) train sets of K−2 folds), generating many backtest paths per strategy so the *distribution* of OOS Sharpe (not one point estimate) can be tested — the input PBO needs.
- VERIFIED FACT: Argus has PBO (`src/server/research/pbo.ts`), DSR (`python/argus_research/stats.py`), and walk-forward checks (`run_vectorbt_wfo.py`) — but no purged/embargoed CV splitter. Any current K-fold-style evaluation without purging leaks through label overlap and autocorrelation.
- INFERENCE: This is the highest-leverage validation gap: Argus's 150+ strategy inventory is exactly the multiple-testing regime where unpurged selection promotes lucky noise. PBO/DSR correct for trial *count*; purging corrects for trial *contamination* — both are needed, neither substitutes for the other.

## Mathematics
Labels with horizon `h`: sample `i` uses information from `[t_i, t_i + h]`. Purge: for test fold `T`, remove from training every `j` with `[t_j, t_j + h] ∩ [min(T), max(T)] ≠ ∅`. Embargo: additionally remove samples with `t_j ∈ (max(T), max(T) + e]`, `e` = embargo length (e.g. 1% of sample, or the label horizon). CPCV: with K folds, each backtest path trains on K−2 folds and tests on 2; number of paths `φ(K,2) = C(K,2)`; collect OOS Sharpe per path per strategy → empirical distribution → PBO/DSR computed on *honest* OOS estimates.

## Economic rationale
No economics — pure statistical hygiene. The "who pays" is the researcher: unpurged CV pays for itself in false discoveries, each of which costs real investigation time and, if promoted, real capital.

## Argus mapping
MISSING_HIGH. Implement a purged/embargoed splitter as the *mandatory* CV primitive in the research pipeline (Python research env first, Java port when the Java backtester needs it): every strategy evaluation, parameter sweep, and ML model selection routes through it. Wire CPCV path-generation into the existing PBO computation so PBO finally gets honest OOS inputs at scale. Layer: risk/validation.

## Failure modes
(1) Embargo too short: autocorrelation longer than `e` still leaks — set `e` from measured return autocorrelation, not a rule of thumb. (2) Purging with tiny samples leaves nothing to train on — CPCV needs long histories; for short-history strategies, fewer folds. (3) Treating purged CV as promotion evidence by itself — it is still *selection* evidence; walk-forward and paper remain mandatory per the lifecycle.

## Verdict
PROMOTE to specified → implemented. This is validation hygiene, not alpha research: it can only *remove* false positives, never invent edge. Rank 1 on the infrastructure roadmap for that reason.
