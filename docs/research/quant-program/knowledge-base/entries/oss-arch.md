---
kind: infrastructure
family: volatility
status: RESEARCHED
argus_status: EXISTS_GOOD
argus_refs:
  - quant-core-java/src/main/java/io/argus/quantcore/institutional/  # GARCH/EGARCH/DCC-GARCH engines per AGENTS.md inventory
sources:
  - { title: "arch: Autoregressive Conditional Heteroskedasticity models in Python", authors: "Kevin Sheppard (bashtage)", year: 2013, url: "https://github.com/bashtage/arch", license: "NCSA" }
evidence_quality: 80
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- VERIFIED FACT: `arch` is Kevin Sheppard's NCSA-licensed Python package for ARCH/GARCH-family volatility modeling (ARCH, GARCH, EGARCH, GJR-GARCH, HAR-RV via realized measures) plus a `bootstrap` module with multiple-comparison procedures: SPA (Hansen), Reality Check (White), StepM, and MCS (Hansen–Lunde–Nason) — confirmed via upstream metadata and conda-forge records, Oct 2026.
- RESEARCH FINDING: Its multiple-comparison bootstrap suite is the reference implementation of the exact procedures the quant literature uses to correct for data-snooping across many candidate strategies — directly applicable to Argus's 150+ strategy inventory.
- VERIFIED FACT: Argus already implements GARCH/EGARCH/DCC-GARCH natively in Java (per the AGENTS.md institutional inventory) — the volatility-modeling half of `arch` is redundant with existing capability.
- INFERENCE: The *non-redundant* half is the bootstrap multiple-testing suite (SPA/StepM/MCS): Argus has DSR and PBO for snooping bias, but no StepM/SPA-style procedure that identifies *which* strategies survive after correcting for the full search — a genuine gap in the validation layer.
- HYPOTHESIS: Reimplementing the stationary bootstrap + StepM in Java (clean-room, from the published papers — Hansen 2005, Romano-Wolf 2005) is feasible and would give Argus a "which of my 150 strategies are real" procedure its current gates lack.

## Mathematics
GARCH(1,1): `σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}`, `α + β < 1`. SPA test (Hansen 2005): null `H_0: max_k E[d_{k,t}] ≤ 0` over relative performance series `d_{k,t}`; stationary-bootstrap distribution of `T_n = max_k √n·d̄_k / ω̂_k`; consistent critical values under the null. StepM (Romano-Wolf 2005): stepwise multiple testing controlling familywise error while identifying *all* outperforming models, not just rejecting the joint null.

## Economic rationale
Volatility clustering (Engle 1982; Bollerslev 1986) is among the most replicated facts in finance — RESEARCH FINDING, evidence quality ~95. The bootstrap half addresses the complementary fact that searching 150 strategies guarantees lucky winners; without multiple-testing correction, Argus's inventory *will* promote noise.

## Argus mapping
EXISTS_GOOD for volatility models (Java GARCH family exists). MISSING_MEDIUM for the multiple-comparison bootstrap suite — DSR/PBO answer "is this one result lucky given K trials"; SPA/StepM answer "which of these K are real." Layer: risk/validation.

## Failure modes
(1) Treating GARCH forecasts as tradable alpha — volatility forecasts inform *sizing and risk*, not direction. (2) Bootstrap misuse: block length must respect return autocorrelation or the bootstrap destroys the dependence it should preserve. (3) Copying `arch` code into the repo — NCSA is permissive, but the Java authority and clean-room rule still apply; reimplement from the papers.

## Verdict
**Classification: C (research only) for the package; PROMOTE the idea.** Keep `arch` as a research-side reference for GARCH parity checks. Spec a Java StepM/SPA multiple-testing procedure from the primary papers as a validation-layer upgrade — it fills the one gap DSR/PBO leave open.
