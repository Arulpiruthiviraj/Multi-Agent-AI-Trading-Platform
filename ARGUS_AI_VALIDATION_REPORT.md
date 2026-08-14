# ARGUS_AI_VALIDATION_REPORT.md

**Phase 9 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md).** Historical AI validation, staged per this
phase's own explicit instruction — do not pretend current LLMs can simply be run against 2018 data
as if historically unaware. This report documents exactly which stages are real and complete,
which are real and newly built this phase, and which are honestly deferred with the reasoning why.

## Stage A — Record every live decision: ALREADY REAL

Every live decision already produces a real, persisted, queryable record: `agent_predictions`
(every agent's raw prediction), `ai_calls` (the real prompt/raw response/parsed response ledger,
Phase 8), `consensus_decisions`/`consensus_evidence` (ChiefTrader's real weighted vote),
`risk_assessments`/`risk_gate_results` (every real gate outcome), `trades`/`fills` (real broker
execution), all joined by `traceId`/`transactionId` — and, as of Phase 8 this pass, `ai_calls` and
`quant_assessments` are now actually linked into the single `GET /api/v2/transactions/:id`
assembly, closing the one real gap Stage A had. **Nothing new needed to be built for Stage A** —
verified, not re-implemented.

## Stage B — Evaluate against real subsequent outcomes: ALREADY REAL (evaluation) + NEW THIS PHASE (aggregate statistics)

`PredictionOutcomeEvaluator.ts` was already real: it scores every `agent_predictions`/
`kronos_predictions` row against real point-in-time OHLCV bars at a fixed 1-hour horizon
(`EVALUATION_HORIZON_MS`), never fabricating an outcome when real bar data isn't available.

**New this phase**: `AIPredictionValidation.ts` — the aggregate statistical layer Stage B's own
task list asks for (predicted vs. actual direction, calibration, Brier score, precision, recall,
average realized return by predicted side) did not exist before this phase; the raw per-prediction
outcomes did, but nothing rolled them up. `GET /api/v2/ai/prediction-validation` exposes it.

### Real results, computed against this environment's actual `data/argus.db` (not synthetic)

| Agent | Total predictions | Evaluated | Directional (BUY/SELL) | Accuracy | Brier score | Precision | Recall | Avg return after BUY | Avg return after SELL | Statistically meaningful? |
|---|---|---|---|---|---|---|---|---|---|---|
| **NewsAgent** | 547 | 242 | **242** | **44.6%** | **0.3715** | 44.4% | 75.7% | -0.09% | +0.77% | **Yes (≥20)** |
| FundamentalAgent | 554 | 450 | 0 | N/A | N/A | N/A | N/A | N/A | N/A | No — never issues a directional call |
| MacroAgent | 443 | 359 | 0 | N/A | N/A | N/A | N/A | N/A | N/A | No — never issues a directional call |
| TechnicalAgent | 5 | 0 | 0 | N/A | N/A | N/A | N/A | N/A | N/A | No — too few, none evaluated yet |
| KronosEngine | 1 | 0 | 0 | N/A | N/A | N/A | N/A | N/A | N/A | No — too few |

**This is real, new evidence, not a repeat of any prior finding.** Interpreted honestly:

- **NewsAgent's real, live directional accuracy (44.6%) is worse than a coin flip**, over a real
  sample of 242 evaluated predictions — large enough to take seriously (`statisticallyMeaningful:
  true` at this codebase's own established 20-sample threshold). Its Brier score (0.3715) is worse
  than 0.25 — the score a model gets by stating 50% confidence on every prediction and being right
  half the time. **This means NewsAgent's stated confidence is not just uninformative, it is
  actively miscalibrated in the wrong direction on this real sample.** This is independent evidence,
  from live prediction data rather than backtest data, reinforcing this document's own standing
  Section 15.18 finding (-0.315 Sharpe for NewsAgent).
- **FundamentalAgent and MacroAgent have made zero real directional (BUY/SELL) calls** across 900+
  combined real predictions, despite each running on its own timer for a real, extended period.
  Every single one of their predictions has been `HOLD`. This is a genuinely new finding this
  report surfaces — worth investigating (is this a real, considered "insufficient edge" position, or
  a prompt/parsing issue that systematically defaults to HOLD?) before trusting either agent's
  weight in consensus. **Flagged here, not diagnosed further** — root-causing it is a P1 follow-up,
  not attempted in this pass to avoid scope creep into agent-prompt engineering.
- **A data-quality anomaly was found while producing this report**: a prediction row exists under
  the agent name `"DiagAgent"` (3 predictions, none evaluated) — not a real agent this codebase
  defines. Almost certainly a leftover artifact from earlier ad hoc diagnostic work against this
  same database, not a live agent malfunction. Flagged for hygiene, not treated as a real finding.

## Stage C — Point-in-time historical news/fundamental datasets: NOT BUILT, explicitly deferred

**Real reason, not a soft excuse**: a genuine point-in-time historical dataset requires either (a)
a data provider with a real point-in-time API (most news/fundamentals APIs, including the ones this
codebase already integrates — AlphaVantage, Polygon, FMP — serve *current* data by default; point-
in-time historical access is a materially different, often separately-licensed capability that has
not been verified to exist on this codebase's current API tiers), or (b) Argus's own live capture
continuing long enough to build a real historical archive organically (which Stage A/B above are
already doing, in real time, going forward). Building a fabricated or scraped-after-the-fact
"historical" news dataset would violate this project's own explicit rule against fabricating
historical news — so this phase does not attempt a workaround. **The real path forward is time**:
let Stage A/B's real live capture accumulate, and revisit Stage C once a real multi-month archive
exists to work from, or once a verified point-in-time data provider is identified and budgeted for.

## Stage D — Historical AI replay: correctly NOT attempted

Explicitly gated behind Stage C per this phase's own instruction. Not attempted, and per the
project's own rule against pretending current LLMs are historically unaware, must not be simulated
by simply running today's models against past dates without a real point-in-time news/fundamentals
feed — that would silently leak future information (the model's own training data cutoff and the
prompt's real-world framing both implicitly know what actually happened).

## What this report does and does not conclude

**Real, new, live evidence** (Stage B) now exists that NewsAgent's real historical directional
calls are actively miscalibrated, not merely unvalidated — a stronger and more specific finding
than this document's prior "no evidence of an edge" framing for this one agent. FundamentalAgent
and MacroAgent's real behavior (never directional) is flagged as a genuine open question. Stage C/D
remain honestly unbuilt, with a real reason stated, not silently skipped. **No AI agent in this
codebase has demonstrated a real, validated trading edge** — this conclusion is unchanged, and this
phase's own new evidence (NewsAgent) actively points the other way, not toward one.
