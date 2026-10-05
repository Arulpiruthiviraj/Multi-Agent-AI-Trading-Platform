---
kind: infrastructure
family: feature-engineering
status: RESEARCHED
argus_status: NOT_APPROPRIATE
argus_refs: []
sources:
  - { title: "Qlib: An AI-oriented Quantitative Investment Platform", authors: "Microsoft", year: 2020, url: "https://github.com/microsoft/qlib", license: "MIT" }
evidence_quality: 60
data_requirements: [daily-OHLCV]
feasibility_daily_bars: true
last_reviewed: 2026-10-05
---

## Claim inventory
- VERIFIED FACT: Qlib is Microsoft's MIT-licensed AI-oriented quant platform: data server with point-in-time discipline, expression-based feature engine, model zoo, and a vectorized portfolio simulator with commission/slippage modeling.
- VERIFIED FACT: Its default universe is China A-shares; US-equity support requires external data plumbing.
- RESEARCH FINDING: Its strongest design idea is the *point-in-time database*: every feature value is stored with the timestamp at which it was knowable, making lookahead bias structurally impossible rather than conventionally avoided.
- RESEARCH FINDING: It ships built-in rolling (walk-forward) retraining for ML models — train/predict windows roll forward on a fixed schedule.
- INFERENCE: Importing Qlib wholesale would graft a second data layer, second feature engine, and second backtester onto Argus — a second system of record, forbidden by the architecture contract. The platform is not adoptable; its disciplines are.
- INFERENCE: Argus's closest existing analog is `HistoricalDataGateway` (point-in-time bars) plus the Java `FeaturePipeline` — both lack Qlib's explicit "as-known-at" timestamping on *derived features*.

## Mathematics
Point-in-time discipline formalized: a feature `f_i(t)` used in a decision at time `t` must satisfy `knowledge_time(f_i(t)) <= t` for all `i`. Qlib enforces this in storage; most retail systems (including Argus today) enforce it by convention in code. The failure mode is fundamental restatements and as-reported-vs-as-known earnings — identical values, different knowledge times.

## Economic rationale
Lookahead bias is the highest-ROI bug class in quant research: it manufactures Sharpe out of nothing and is invisible in a single backtest. Structural prevention (storage-level) beats code-review prevention (convention-level) because conventions decay under schedule pressure.

## Argus mapping
NOT_APPROPRIATE as a platform; the *discipline* maps to the DATA → FEATURES layers. Concrete gap: Argus features carry bar timestamps but not knowledge timestamps — fine for OHLCV-derived features, insufficient the moment fundamentals/earnings/restated data enter (see `pead` research card). Layer: data/feature-engineering.

## Failure modes
(1) Adopting Qlib as a dependency = second system of record. (2) Copying its expression-engine DSL without the point-in-time store gives the syntax of rigor with none of the semantics. (3) Its model zoo tempts ML-before-evidence: no model in the zoo has demonstrated edge on *Argus's* data, costs, and universe.

## Verdict
**Classification: C (research only).** Do not adopt the platform. Adopt two disciplines when fundamentals enter the pipeline: (a) knowledge-timestamp every non-OHLCV feature; (b) rolling retrain schedules for any ML model with frozen, versioned artifacts. Both are roadmap items, gated on fundamentals data actually arriving.
