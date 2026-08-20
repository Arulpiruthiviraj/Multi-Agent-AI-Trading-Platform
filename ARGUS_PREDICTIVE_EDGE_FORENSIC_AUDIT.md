# ARGUS Predictive-Edge Forensic Audit

Read-only stress test of the prior pass's claim (KronosEngine ~49.8% directional accuracy at
0.80–0.89 confidence, n=661–711; TechnicalAgent 41–50% across bands, n=512; PortfolioManager's
signal 30% correct at 0.80–0.89, n=30). Compiled 2026-08-20, shortly after the cited prior audit.
Market session 2026-08-20 was still in progress at compile time (last data point 2026-08-20T19:12Z /
~15:12 ET) — same interim-audit caveat as the prior report applies. All queries ran read-only
(`better-sqlite3`, `{ readonly: true }`) against `data/argus.db`; no source, config, or DB row was
modified. Throwaway query scripts used to produce these numbers were deleted after use (five
identically-named scratch files already tracked in git from the *prior* pass's careless commit were
restored to their committed state, not deleted, to avoid touching anything beyond this report).

Evidence tags: **CODE** (read from source), **DATA** (read from `data/argus.db`), **RUN** (n/a —
no process was started or restarted for this audit), **NOT VERIFIED** (out of scope / insufficient
time or data). Distinguish **OBSERVED** (directly queried) vs **INFERRED** (derived/reasoned) vs
**COUNTERFACTUAL** (what-if) vs **HYPOTHETICAL** (unverified explanation offered for completeness).

---

## 1. Executive verdict

# **MEASUREMENT-INVALID**

Not "NO-edge" and not "POSSIBLY-promising" — the raw-N statistics that produced both the prior
pass's numbers and this pass's independent recomputation of the *same* numbers are built on top of
a data-generation pipeline that writes the *same* underlying model decision into the ledger 2–3
times (Kronos) or fires the *same* underlying regime read thousands of times without the regime
changing (TechnicalAgent), and then evaluates every one of those near-identical rows as if it were
an independent trial. Once that autocorrelation is corrected for, every confidence bucket's 95%
Wilson interval widens to comfortably include 50% (DATA, below). The instrument cannot currently
distinguish "no edge" from "small edge" from "can't tell" — which is a different, prior problem to
"is there edge," and it must be fixed before the edge question is answerable at all.

---

## 2. Evidence scorecard

| Question | Prior pass's raw-N answer | This pass's finding | Confidence |
|---|---|---|---|
| Kronos 0.80–0.89 accuracy | 49.8% (n=661–711) | Reproduced: 46.2% (n=1,311, canonical `kronos_predictions` only) — RAW-N CI **excludes** 50% [43.5–48.9%] | DATA |
| ...but is n=1,311 independent? | Not checked | **No.** Same-symbol/direction 60-min-gap clustering → effective N ≈ 75. Corrected CI [35.8–57.8%] **includes** 50% | DATA + CODE |
| TechnicalAgent accuracy declining with confidence | Suggested, n=17/n=4 (too small) | Confirmed direction holds at larger raw N (43.7%→43.2%→45.4%→48.3% across buckets) but ALL raw-N CIs for the two dominant buckets exclude 50% on the low side | DATA |
| ...effective N for those buckets? | Not checked | 38 and 47 respectively (from 27,616 and 22,019 raw). Corrected CIs [30.1–60.3%] and [29.5–56.7%] — **include** 50% | DATA + CODE |
| PortfolioManager 30% at 0.80–0.89, n=30 | Reported at face value | Reproduced exactly (n=30, 30.0%) — but all 30 rows are **one NVDA position** re-graded every ~5 minutes. Effective N ≈ 1–2 | DATA |
| Kronos vs Technical structural disagreement (82% SELL vs 98% BUY) | Reported, not explained | Confirmed and **quantified**: paired agreement rate 16.5% (n=2,190), at or below the ~20% agreement expected from the marginals alone under pure independence — i.e., no evidence of informative (dis)agreement, just two oppositely-biased instruments | DATA |
| Quant cold-start | Not covered | **Confirmed structural deadlock, CODE-level**: `QuantSignalAgent` will never emit a strategy-sourced live idea until that exact strategy has ≥1 real closed trade (`computeLiveStrategyWinRate` returns `null` otherwise), and the only code path that could open that first trade without the check (`deriveIdeaFromRegime`) is dead code — defined, unit-tested, never called | CODE |

---

## 3. Agent leaderboard (canonical, de-duplicated sources only)

De-duplication rule: Kronos accuracy uses `prediction_outcomes` joined to `kronos_predictions` only
(`CAST(po.prediction_id AS INTEGER) = kp.id`), **never** combined with the `agent_predictions` rows
where `agent_name = 'KronosEngine'` — those are the *same* forecasts written a second/third time
(see §7, Finding M1). All Wilson intervals below are 95%.

| Agent | Raw N (directional, all-time) | Raw win rate | Raw 95% CI | Effective N (60-min-gap clustering) | Effective-N 95% CI | Excludes 50%? |
|---|---|---|---|---|---|---|
| KronosEngine (0.80–0.89 bucket, dominant) | 1,311 | 46.2% | [43.5%, 48.9%] | 75 | [35.8%, 57.8%] | Raw: yes (below). Corrected: **no** |
| TechnicalAgent (0.50–0.59 bucket) | 27,616 | 43.7% | [43.1%, 44.3%] | 38 | [30.1%, 60.3%] | Raw: yes (below). Corrected: **no** |
| TechnicalAgent (0.60–0.69 bucket) | 22,019 | 43.2% | [42.6%, 43.9%] | 47 | [29.5%, 56.7%] | Raw: yes (below). Corrected: **no** |
| TechnicalAgent (0.70–0.79 bucket) | 1,711 | 45.4% | [43.1%, 47.8%] | 28 | [29.5%, 64.2%] | Raw: yes (below). Corrected: **no** |
| TechnicalAgent (0.80–0.89 bucket) | 375 | 48.3% | [43.3%, 53.3%] | 20 | [29.9%, 70.1%] | No (either way) |
| PortfolioManager (0.80–0.89 bucket) | 30 | 30.0% | [16.7%, 47.9%] | ~1–2 (single NVDA position, re-graded) | not meaningful below n≈5 | Raw: yes. Corrected: **not computable — not an independent sample at all** |

**Reading this table honestly:** at raw N, three of the four largest buckets look like Argus's two
main directional agents are performing *worse than a coin flip* with tight statistical confidence.
That would itself be a striking, reportable finding if real. It is not real — see §7. Once corrected
for the measured autocorrelation, no bucket for any agent has a confidence interval that excludes
50% in either direction. **The honest current state is "cannot distinguish from random," not "proven
sub-random" and not "proven random" either** — the corrected intervals are wide enough to be
consistent with a real edge of a few points in either direction.

---

## 4. Confidence calibration table

Stated confidence vs realized win rate, canonical sources, raw N (with the caveat from §3 that raw N
overstates precision by roughly 1–2 orders of magnitude):

| Agent | Bucket | Stated confidence midpoint | Realized win rate | Calibration gap |
|---|---|---|---|---|
| KronosEngine | 0.70–0.79 | 0.745 | 60.5% (n=43) | +14.2pp (over-realized, but n=43 raw / ~10 effective) |
| KronosEngine | 0.80–0.89 | 0.845 | 46.2% (n=1,311) | **−38.3pp** |
| TechnicalAgent | 0.50–0.59 | 0.545 | 43.7% | −10.8pp |
| TechnicalAgent | 0.60–0.69 | 0.645 | 43.2% | −21.3pp |
| TechnicalAgent | 0.70–0.79 | 0.745 | 45.4% | −29.1pp |
| TechnicalAgent | 0.80–0.89 | 0.845 | 48.3% | −36.2pp |
| PortfolioManager | 0.80–0.89 | 0.845 | 30.0% (n=30, ~1 real position) | −54.5pp (not a real sample) |

**Is TechnicalAgent's "accuracy declines as confidence rises" pattern real?** Directionally it
reproduces at large raw N (43.7 → 43.2 → 45.4 → 48.3 is actually *rising* through the top three
buckets, only the lowest-vs-highest comparison inverts, and weakly). The calibration **gap** does
widen monotonically with stated confidence (−10.8pp → −21.3pp → −29.1pp → −36.2pp) — i.e.
TechnicalAgent is more overconfident, in raw calibration-gap terms, exactly when it is more
confident. That pattern survives at raw N. Whether it survives at effective N (each bucket's
effective N is 20–47) is **NOT VERIFIED** — too few effectively-independent points per bucket to
say the *trend* itself (as opposed to each bucket's point estimate) is more than noise.

---

## 5. Symbol breakdown

Per the task's own discipline: minimum N=30 before drawing a conclusion. Applied first to raw N,
then re-examined under effective N — and the effective-N pass changes the verdict completely.

**Raw-N view** (would nominally pass the n≥30 bar):

| Symbol | Kronos raw N | Kronos win rate | TechnicalAgent raw N | TechnicalAgent win rate |
|---|---|---|---|---|
| SPY | 170 | 41.8% | 10,781 | **25.6%** |
| QQQ | 202 | 46.0% | 22,944 | 47.8% |
| IWM | 159 | 44.7% | 9,278 | 53.8% |
| DIA | 128 | **64.1%** | 8,236 | 43.0% |
| NVDA | 110 | **31.8%** | 57 | 56.1% |
| META | 46 | **67.4%** | 27 (< 30) | 11.1% |

**Effective-N view** (60-min-gap clustering, same clustering method as §3, computed per symbol):

| Symbol | Kronos effective N | TechnicalAgent effective N |
|---|---|---|
| SPY | 6 | **9** (from 10,781 raw — a ~1,200× inflation) |
| QQQ | 7 | **8** (from 22,944 raw — a ~2,900× inflation) |
| IWM | 8 | 5 |
| DIA | 8 | 6 |
| NVDA | 8 | 3 |
| META | 7 | 1 |

**Verdict: no symbol, for either agent, has an effective sample size that clears any reasonable
minimum-N bar.** The raw-N table's apparent standouts (SPY 25.6% for Technical, DIA 64.1% and NVDA
31.8% for Kronos, META 67.4%/11.1%) are built from roughly 1–9 genuinely independent regime-reads
per symbol over the ~2–11 days of history each agent has. **None of these per-symbol numbers should
be read as evidence of symbol-specific edge or symbol-specific weakness.** This directly answers
Part 6's own instruction to only draw conclusions where N genuinely supports it: at the effective-N
standard, the answer for every symbol is "insufficient data," full stop — a materially different
conclusion than the raw-N table would suggest at a glance.

---

## 6. Consensus effectiveness

**NOT ENOUGH DATA** — with an explanation, not a shrug.

- Paired instances (Kronos + TechnicalAgent, same symbol, within 5 minutes, both directional):
  n=2,190 raw pairs. Agreement rate 16.5% (362 agree, 1,828 disagree).
- Kronos accuracy when Technical **agrees**: 55.3% (n=197 raw, effective N well under 30).
- Kronos accuracy when Technical **disagrees**: 44.9% (n=1,120 raw).
- Kronos accuracy when Technical has **no** nearby signal at all: 53.8% (n=39 raw).
- Combined confidence≥0.75 population (Kronos+Technical, canonical, no cross-table duplication):
  46.8%, CI [44.9%, 48.8%] at raw N — again, an interval that would look decisive until the same
  autocorrelation correction from §3 is applied, which was not re-derived per-population here for
  time reasons (flagged NOT VERIFIED at the population level, though the mechanism is identical).

The 55.3% vs 44.9% split (agree vs disagree) is suggestive on its face, but every one of these
populations inherits the same duplication/autocorrelation problem documented in §3 and §7 at a
scale that has not been separately re-measured for this specific sub-population. Given that the
*aggregate* effective N collapses by 10–2,900× once corrected, a raw n=197 "agreement" bucket should
be assumed to represent on the order of 10–20 real independent instances, not 197. **Verdict: too
little real data to say whether agreement helps.** Separately, CLAUDE.md and the prior pass both
note that essentially all of today's real ChiefTrader approvals were the risk-exit
(`PipelineFlatten`/liquidate) shortcut, not a graded multi-agent consensus vote — so there is
currently no meaningful population of *actual* ChiefTrader-approved ideas to grade at all. This
question cannot be answered with the current data regardless of statistical technique.

---

## 7. Measurement integrity findings (Part 1 + Part 2)

### M1 — CONFIRMED BUG (architecture-level double/triple counting), the single most important finding

**Every Kronos forecast call is written into the outcome-eligible ledger 2–3 times, under two
different `source_table` labels, and each copy is independently graded by `PredictionOutcomeEvaluator`
as if it were a separate trial.**

Evidence (CODE): `src/server/engines/kronos/KronosMetrics.ts::recordPrediction()` inserts one row
into `kronos_predictions` *and then unconditionally inserts a second row into `agent_predictions`*
(`agentName: 'KronosEngine'`, no `traceId`) — the comment literally reads "Dual-write into
agent_predictions so ReflectionEngine / prediction_outcomes / dashboard metrics can join on the same
agent ledger." Separately, `src/server/services/ReflectionEngine.ts` constructor subscribes to the
EventBus `TRADE_IDEA_GENERATED` event and writes a **third** row into `agent_predictions` (this time
*with* a real `traceId`) whenever the same forecast clears the bar to become an actual trade idea.

Evidence (DATA): of 2,459 `kronos_predictions` rows, 1,858 have exactly one matching
`agent_predictions[agent_name='KronosEngine']` row (same symbol/prediction/confidence, timestamp
within 1 second — typically within 3–158ms), and 454 have **two** matching rows — one with
`trace_id IS NULL` (the unconditional `KronosMetrics` dual-write) and one with `trace_id` set (the
`ReflectionEngine` `TRADE_IDEA_GENERATED` listener), 454/454 exactly matching that pattern. Only 147
(all `HOLD`) have zero matches. Net effect: **every BUY/SELL Kronos forecast exists as 2 or 3 rows
across two tables**, each evaluated independently against the *identical* future price window
(same symbol, same ~3ms-apart timestamps, same fixed 60-minute horizon) — producing 2–3
near-guaranteed-identical WIN/LOSS labels from one real decision.

Concretely reproduced: recomputing the 0.80–0.89 Kronos bucket from `kronos_predictions` alone gives
n=1,311, 46.2%. Naively also including the `agent_predictions[KronosEngine]` rows (a mistake a
future analyst could easily make, since the task instructions for this very audit say "using both
`prediction_outcomes` sources") inflates it to n=2,622, 47.3% — a different number, from the same
underlying decisions, purely from double-counting. **This audit used `kronos_predictions` alone as
the canonical Kronos source throughout §3–§6 specifically to avoid reproducing this bug.**

This is not a bug in `PredictionOutcomeEvaluator.ts` itself — its per-row join and its
`(predictionId, sourceTable)` unique-index guard against re-evaluating the *same* row are both
correct (see M4, NO ISSUE). The bug is upstream, in how many independent writers populate the ledger
for one real event.

### M2 — CONFIRMED BUG, low magnitude: FLAT outcome always scores as LOSS

Evidence (CODE): `PredictionOutcomeEvaluator.ts` line ~112: `const correct = isLong ? finalPrice >
entryPrice : finalPrice < entryPrice;` — strict inequality both ways. When `finalPrice === entryPrice`
(`actual_direction = 'FLAT'`), `correct` is `false` for **both** BUY and SELL predictions.

Evidence (DATA): of 293 `FLAT`-outcome rows, 290 are graded `LOSS` (the other 3 are `HOLD`-side,
correctly `N_A`). Magnitude is small (290/54,709 directional outcomes ≈ 0.53%) and symmetric across
BUY/SELL (a genuine no-move tax on both sides, not a directional bias), so it nudges every agent's
reported win rate down by roughly half a point — not large enough to explain the overall ~44–48%
figures, but a real, fixable defect: a true push should be `N_A`, not an automatic loss.

### M3 — CONFIRMED, severe pseudo-replication (autocorrelation) inflating apparent N

Evidence (DATA): clustering same-agent/same-symbol/same-direction predictions with a 60-minute gap
threshold (matching `tradingSafety.evaluationHorizonMs = 3,600,000`, i.e., predictions less than one
evaluation-horizon apart share overlapping outcome windows and are not independent draws):

| Agent | Raw N (all-time) | Effective N (60-min-gap) | Inflation factor |
|---|---|---|---|
| Kronos (`kronos_predictions`) | 2,459 | 119 | ~21× |
| TechnicalAgent | 52,385 | **68** | **~770×** |
| PortfolioManager | 49 | **2** | ~25× (and it's one symbol) |

TechnicalAgent's SPY figure alone: 10,781 raw rows collapse to an estimated 9 independent regime
reads over the whole history. This single fact should recalibrate how every large-N TechnicalAgent
statistic in this document (and the prior pass's report) is read: **the "n" is a tick-driven
re-firing count of a slowly-changing deterministic indicator state, not a count of independent
trials.** The clustering threshold (60 minutes) is a defensible but not unique choice — it was
picked to match the evaluation horizon itself, which is the most principled anchor available; a
15-minute threshold gives similar qualitative results (157/257/6 respectively — still 1–2 orders of
magnitude below raw N).

### M4 — NO ISSUE FOUND: same-row double-evaluation guard

Evidence (CODE + DATA): `prediction_outcomes` has a unique index on `(prediction_id, source_table)`
(`src/server/db/schema.ts` line 837), and `PredictionOutcomeEvaluator.evaluatePending()` additionally
pre-filters already-evaluated `(sourceTable, id)` keys in memory before attempting an insert, with
`.onConflictDoNothing()` as a second layer. Verified this is correctly scoped per source table (no
risk of `kronos_predictions.id` integer values colliding with `agent_predictions.id` UUID strings,
since the two id spaces never share a `source_table` value). A single real row cannot be evaluated
twice.

### M5 — MEASUREMENT RISK: fixed 60-minute evaluation horizon applied uniformly to non-uniform natural signal horizons

Evidence (CODE): `EVALUATION_HORIZON_MS = tradingSafety.evaluationHorizonMs` = 3,600,000ms (60
minutes) is the *only* horizon used for both `agent_predictions` and `kronos_predictions` — Kronos's
own `forecast_horizon` field (`config/quantThresholds.json` `kronosHorizon: 5`, in units of
`kronosTimeframe: "tick"` — i.e., a 5-*tick*-ahead forecast, plausibly on the order of seconds to at
most a couple of minutes of wall-clock time at typical tick rates) is stored on every
`kronos_predictions` row but is **never read by the evaluator**. Kronos is asked to predict ~5 ticks
ahead and is then graded on where price sits a full 60 minutes later — two structurally different
questions. This is a plausible, code-confirmed contributor to Kronos's apparent lack of edge
independent of any duplication issue: even a genuinely-informative 5-tick forecast has no reason to
predict a 60-minute-later price. Classified MEASUREMENT RISK rather than CONFIRMED BUG because
`EVALUATION_HORIZON_MS` may be an intentional design choice (grading "would this have been a good
60-minute swing trade" rather than "was the micro-forecast literally correct") — but if so, it is an
undocumented one, and it directly undermines using Kronos's own confidence score (which is derived
from the tightness of its 5-tick quantile spread) as a predictor of a 60-minute outcome.

### M6 — MEASUREMENT RISK: entry-price convention is close-of-next-bar, not next-bar-open

Evidence (CODE): `entryPrice = bars[0].close` where `bars[0]` is the first 1-minute bar with
`timestamp >= predictionTimeMs` (bar timestamp = bar OPEN time per `ohlcvBars` schema comment). This
is not lookahead (the bar used is the first one that opens at-or-after the signal), but it is a
different convention from the "NEXT_BAR_OPEN" standard CLAUDE.md documents as the only
promotion-adjacent fill model (`canonicalNextBarEngine.ts`). Entering at the *close* of the bar that
opens right after the signal, instead of the *open* of that bar, embeds roughly one extra minute of
price drift into the "entry" that a NEXT_BAR_OPEN methodology would not. Low materiality at a
60-minute horizon, but worth flagging since it means `prediction_outcomes`-based accuracy figures are
not directly comparable to anything computed via the canonical backtest fill model.

### M7 — MEASUREMENT RISK: test/diagnostic rows contaminate the same production ledger

Evidence (DATA): five `TechnicalAgent` rows in `agent_predictions` carry synthetic symbols
(`DIAGTEST...`, `DIAGPIPE...`, `DIAGORDER...`, `DIAGCHAIN...`), one row each, clearly diagnostic
harness artifacts rather than real market symbols. Immaterial at n=5 out of 52,385 and automatically
excluded from every real-symbol analysis in this report, but it means `agent_predictions` is not a
purely-organic ledger — a future analyst filtering by symbol regex rather than an explicit allowlist
could be misled.

### M8 — NO ISSUE FOUND: HOLD predictions correctly excluded from directional scoring

Evidence (CODE): `isDirectional = side === 'BUY' || side === 'SELL'` — any other value (`HOLD`)
leaves `outcome = 'N_A'` and is correctly excluded from every win-rate calculation in this report and
(per `ReflectionEngine.ts` line 114) from Argus's own live weight-update logic.

---

## 8. TradingAgents (TauricResearch) — concrete learning opportunities

Skimmed read-only from `C:\WorkProjects\TradingAgents` (separate directory, nothing copied or
touched). Structure: `agents/analysts/*` (market/news/fundamentals/sentiment/social), `agents/
researchers/{bull,bear}_researcher.py` + `agents/managers/research_manager.py` (debate + resolution
— conceptually close to Argus's already-audited-as-failed BullResearcher/BearResearcher under
`deepseek-r1:14b`/`HeavyModelMutex` contention), `agents/risk_mgmt/{aggressive,conservative,
neutral}_debator.py` (three-way risk debate), and `agents/utils/memory.py` (append-only markdown
per-ticker decision/reflection log with alpha-adjusted outcome tracking). No dedicated backtesting
engine was found in the skim — it appears to be a live/paper decision framework, not a backtester.

| Idea | Source concept | What Argus does today | Difference | Benefit | Risk | Complexity | Value |
|---|---|---|---|---|---|---|---|
| Grade predictions against benchmark-relative (alpha) return, not raw direction | `memory.py::update_with_outcome` stores both `raw_return` and `alpha_return` per decision | `PredictionOutcomeEvaluator` grades WIN/LOSS purely on the symbol's own raw price direction (§1 of this audit) | Argus cannot currently tell "the market moved and dragged this symbol with it" from "the agent called it" | Directly relevant to this audit's own question — separates real stock-picking skill from beta exposure, and would make the calibration table in §4 far more informative | Low — additive column on `prediction_outcomes`, needs a benchmark price series (SPY/QQQ already tracked) | LOW-MEDIUM | **HIGH** |
| Per-decision holding horizon instead of one global fixed horizon | `update_with_outcome`'s `holding_days` is decision-specific | One `evaluationHorizonMs` (60 min) applied to every agent regardless of its own natural signal horizon (M5, §7) | Directly addresses the horizon-mismatch finding in this audit | Would let Kronos be graded on something closer to its actual 5-tick forecast question, and let slower-signal agents (Fundamental/Macro) be graded on a horizon that matches their own cadence | Medium — touches the evaluator's horizon selection logic, needs care not to let agents pick their own grading window post-hoc (that would be gameable) | MEDIUM | **HIGH** |
| Per-symbol historical decision+outcome context injected into agent/debate prompts | `memory.py::get_past_context` — same-ticker history (n=5) + cross-ticker lessons (n=3) formatted into the next prompt | ChiefTrader's debate prompt already injects truncated `learned_rules` text (`debateLearnedRulesCount`/`debateLearnedRuleMaxChars`), but not each agent's own recent per-symbol track record | Argus's mechanism is coarser (global learned-rule text) vs TradingAgents' per-ticker specific memory | Could sharpen agent self-correction on symbols it has been consistently wrong about, without any architecture change (still feeds `TRADE_IDEA_GENERATED` the same way) | Low-medium — prompt-construction change only, no path change | MEDIUM | MEDIUM |
| Three-way (aggressive/conservative/neutral) risk debate before sizing | `risk_mgmt/{aggressive,conservative,neutral}_debator.py` | Argus's 24-gate `RiskEngine` is deterministic and fail-closed by design (CLAUDE.md: protected, must not be replaced or weakened) | This is a genuinely different paradigm (LLM debate deciding risk posture vs a fixed deterministic gate ladder) | None that doesn't conflict with the explicit architecture contract | Would mean an LLM debate influencing risk sizing — directly against "do not bypass RiskEngine" | High to do safely, and arguably impossible to do *safely* here | **NOT RECOMMENDED** |

---

## 9. Top blockers to demonstrating real edge, ranked by evidence strength

1. **(D) Duplicate/correlated samples inflating apparent sample size — STRONGEST, CODE+DATA
   confirmed.** M1 (Kronos 2–3x table duplication) and M3 (autocorrelation collapsing raw N by
   21×–770×) together mean essentially every statistic anyone has computed from this ledger so far —
   in the prior pass and largely reproduced in this one — has overstated its own precision by one to
   three orders of magnitude. This is the precondition problem: it must be fixed before any of the
   others can be evaluated honestly.
2. **(C) Outcome-measurement methodology — MEASUREMENT RISK, CODE confirmed, lower magnitude.** M5
   (horizon mismatch: Kronos's 5-tick forecast graded against a 60-minute future price) and M6
   (close-of-next-bar vs next-bar-open entry convention) are real, but their effect size is smaller
   and harder to bound than M1/M3 without a controlled re-run.
3. **(H) Insufficient real trading data — CODE+DATA confirmed, structural.** Zero organic closed
   PAPER FILLED SELL trades ever (per CLAUDE.md and re-confirmed by §7's Kelly/QuantSignalAgent
   findings) means there is no ground truth for *actual trade* P&L at all — only prediction-vs-price
   proxies, which is what this whole audit has been forced to analyze instead.
4. **(J) Cold-start architecture problem — CODE confirmed, but scoped to Quant only.**
   `QuantSignalAgent`'s strategy-sourced idea path (`src/server/services/QuantSignalAgent.ts` lines
   243–246) requires `computeLiveStrategyWinRate()` to return non-null, which requires ≥1 real closed
   trade already tagged with that exact `quantStrategyId` — and the only code path that could open
   that bootstrapping trade without the check, `deriveIdeaFromRegime()`, is dead code (defined,
   unit-tested in isolation, zero call sites in production). This is a genuine permanent deadlock for
   Quant specifically, not a "resolves with more soak time" problem — it does not, on its own,
   explain the Kronos/Technical numbers analyzed above, which come from a completely separate code
   path.
5. **(G) Agent-independence illusion — DATA confirmed, but explains disagreement, not accuracy.**
   Kronos and TechnicalAgent's opposite skew (82–85% SELL vs 97–98% BUY) is real and structural
   (§2, §6), but it is a finding about *why consensus rarely triggers*, not a finding that either
   agent's own accuracy is worse than chance — that would need (D) and (C) resolved first to know.
6. **(A) Predictions genuinely near random — UNKNOWN, cannot currently be distinguished from (D).**
   This is the question the audit was asked to answer and could not: after correcting for (D), every
   corrected interval in §3 comfortably includes 50%. That is consistent with "near random" but
   equally consistent with "a real few-point edge that 20–75 effectively-independent samples per
   bucket simply cannot resolve." No conclusion is possible here yet.
7. **(B) Confidence miscalibration — WEAK evidence, plausible but not separable from (D) at present.**
   The calibration gap widening with stated confidence (§4) is suggestive but was only checked at raw
   N; effective-N recomputation of the *trend itself* (not just each point) was NOT VERIFIED.
8. **(F) Strategy/regime mismatch, (I) selection bias from consensus/risk filters, (K) other data
   quality — NOT VERIFIED / insufficient time.** (I) is partially addressed by §6's finding that
   there is essentially no real graded-consensus population to compare against; (F) and (K) beyond
   M7 were not separately investigated this pass.
9. **(E) Horizon mismatch — folded into item 2 above (C) rather than ranked separately**, since M5 is
   itself an instance of measurement methodology, not a separate root cause.

---

## 10. Recommended next experiment (in required order — no step skips ahead to live trading)

1. **Measurement fixes (do this first, before recomputing anything else):**
   - Stop scoring FLAT as an automatic LOSS (M2) — trivial, low-risk, immediate correctness fix to the
     WIN/LOSS derivation.
   - Deduplicate the Kronos ledger for accuracy purposes: either canonicalize on `kronos_predictions`
     only for scoring (as this audit did) and document that `agent_predictions[agent_name=
     'KronosEngine']` exists for ReflectionEngine/dashboard joins *only*, never for accuracy stats; or
     stop the redundant writes entirely if nothing else actually needs three copies.
   - Add a decision-specific (or at minimum, per-agent-type) evaluation horizon instead of one global
     60-minute constant, so Kronos's own `forecast_horizon`/`kronosTimeframe` is actually consulted
     (M5) — directly informed by the TradingAgents `holding_days`-per-decision pattern in §8.
   - Consider adding benchmark-relative (alpha) return alongside raw return on `prediction_outcomes`
     (§8) — this alone would make every future accuracy report far more informative.
2. **Offline validation:** once the above are fixed, re-run this exact confidence-bucket/Wilson/
   effective-N analysis against the corrected pipeline on the existing historical
   `prediction_outcomes` data (or freshly regenerated outcomes if the horizon/entry-price logic
   changes enough to require re-evaluation) before trusting any new number.
3. **Shadow predictions:** run agents in shadow (no `TRADE_IDEA_GENERATED`, pure logging) over a
   period long enough to accumulate genuinely independent samples at the *effective*-N standard
   established here (tens, not thousands, per bucket) — e.g., target ≥30 effectively-independent
   (60-minute-gap-clustered) observations per confidence bucket per agent before drawing any
   conclusion, not ≥30 raw rows.
4. **Paper trading:** only after shadow predictions clear that effective-N bar, resume supervised
   paper soak toward the existing `researchSafety.json` floors (30 trades / 10 sessions / 30 calendar
   days / PF≥1.2 / expectancy>0) — these floors are about real fills, and remain the correct next gate
   regardless of the prediction-ledger findings above.
5. **Longer soak testing:** extend paper soak duration specifically to let `QuantSignalAgent`'s
   cold-start deadlock (§7, §9 item 4) be manually broken by an operator-supervised first trade per
   strategy if that path is ever prioritized — out of scope to fix here, flagged for awareness only.

No step above involves lowering `consensusApprovalThreshold` or `minIndependentAgreeingAgents`,
weakening RiskEngine or `news_veto`, or enabling LIVE trading. This audit's conclusion is that the
*ruler* needs fixing before anyone measures with it again — not that the trading bar should move.
