# ARGUS October 15 - consensus forensics addendum: the three "0.979" rounds (read-only, 14:35 ET)

Production untouched. Evidence: `consensus_evidence`, `consensus_decisions`, `transaction_traces`, `agent_predictions`, `agent_confidence_calibration`, `ohlcv_bars`, and a bounded tail of `event_traces` (150k rows, window 17:38-18:03Z, the first engine after the hotfix). Everything below is verified from those rows unless labelled.

## 1. The rounds
| Round | What the evidence rows show | Final decision | Classification |
|---|---|---|---|
| MRNA 13:38:54 | Quant BUY (raw 0.80, calibrated 0.979, weight 0.15); Kronos BUY arrived 6 s later (calibrated 0.556, weight 0.974); Macro HOLD (no LLM configured) | Two independent groups agreed; weighted **61.2%** < 75% | CORRECT_REJECTION. The `0.979` in `transaction_traces` is Quant's own number; the first terminal record (INSUFFICIENT_AGENT_PARTICIPATION) was an early snapshot and disagrees with the window-close decision row (2 groups) - a lineage inconsistency, see 5 |
| MCD 13:38:56 | Quant **SELL** 0.979; Kronos **BUY** 0.556; Macro HOLD | 41.6% | SIGNAL_DIRECTION_DISAGREEMENT (also a SELL with no position cannot trade) |
| MRNA 13:43:44 | Quant BUY + Macro HOLD only. A Kronos MRNA idea at 17:43:20 and a Technical MRNA idea at 17:44:16 were **dropped by the idea cap** (the latter 2 s before the round's window closed) | 1 group, 97.9% | RATE_LIMIT_STARVATION changed the label (the true reason would have been "below 0.75", see next row), not the outcome |
| MRNA 13:44:49 | **Quant, Kronos and Technical all BUY: 3 independent groups.** Calibrated 0.979 / 0.501 / 0.216, weights 0.15 / 0.974 / 0.25 | weighted **50.1%** < 75% | CORRECT_REJECTION under the current aggregation; exposes a design property, see 3 |

## 2. Why Quant shows 0.979 (it is not a probability)
* The idea is `TREND_FOLLOWING`, raw confidence 0.80 "from real multi-feature agreement", in **COLD_START** ("zero real closed trades, so no EV/stop/target backs this idea").
* Its calibration rows: bucket 0.8 = **49 wins / 0 losses -> 0.9746**; bucket 0.7 = **0 / 66 -> 0.0987**; bucket 0.9 = 32 / 19 -> 0.68. A perfect 49/0 next to a perfect 0/66 is the signature of a few clustered events counted many times, not independent evidence (67% of Quant ideas are repeats of the same symbol and side within 5 minutes; MRNA BUY recurred five times in seven minutes). Classification: CONFIDENCE_CALIBRATION_DEFECT / RESEARCH_LIMITATION (effective sample size is tiny; raw counts are used). Not changed.
* Kronos, with 3,569 graded predictions, is honest: calibrated ~0.50. TechnicalAgent 0.216 for a raw 0.578.

## 3. Consensus aggregation property (design finding, NOT_CHANGED)
Weighted confidence is the weighted **mean** of the agreeing agents' calibrated confidences: (0.979x0.15 + 0.501x0.974 + 0.216x0.25) / 1.374 = 0.501. Adding an agreeing but near-chance, high-weight agent therefore **lowers** the score; independent agreement can never raise it. With Kronos (weight 0.974, calibrated ~0.50) in almost every round, 0.75 is structurally unreachable unless every agreeing agent is well-calibrated above 0.75. This is a research and policy question for the owner, not a patch; no threshold or weight was touched.

## 4. Idea-cap effect (RATE_LIMIT_STARVATION: CONFIRMED, disproportionate)
Window 17:38-18:03Z (passed / dropped): Kronos 1,529 / 770 (33%), Macro 796 / 279 (26%), **Technical 420 / 241 (36%)**, **Quant 99 / 78 (44%)**, JavaCoreEnsemble 44 / 24 (35%). 72% of all idea traffic is a repeat of the same agent+symbol+side within 5 minutes (Kronos 81%, Macro 70%, Java 68%, Quant 67%, Technical 46%). Ideas arrive in synchronized bursts: at 17:43:14 the Technical, Macro, Java and Quant MCD ideas were all dropped in the same second after Kronos's passed. The valuable low-frequency voters are hit hardest. Remedy candidates (coalescing repeats before the cap; per-agent fair share) change how many votes reach ChiefTrader and need their own review: NOT implemented.

## 5. Defects and findings
| ID | Finding | Status |
|---|---|---|
| **Q1 (P1)** | **Quant's idea price is stale.** 84% of 672 recent rounds have Quant's `currentPrice` >1% from Kronos's (mean 3.74%); MRNA 216.25 (the **Oct 13** close) vs ~238.3 live; MCD 236.74 (Oct 13). Causes: daily bars are incomplete (Oct 14: 181 of ~262 symbols; Oct 15: 39) and `resolveQuantCurrentPrice` returned a *final bar from an earlier session* in preference to a valid live quote - its own test asserted that as intended behaviour. **RiskEngine sizes and checks notional from `proposal.currentPrice`**, so an approved Quant idea would be sized and notional-checked on a price up to ~10% off. No Quant idea has been approved, so no order was affected. | FIXED_AND_TESTED on the dev branch (regression fails before, passes after; 66 Quant test files / 1,035 tests pass); MERGED_TO_MAIN; **not deployed** (next release) |
| Q2 | Why Oct 14/15 daily bars are missing for many symbols (data-provider coverage) and whether Quant features computed on stale bars should fail closed | NOT_VERIFIED, open |
| L1 | Terminal reason in `transaction_traces` (first evaluation) and the window-close `consensus_decisions` row can disagree about the number of independent groups for the same round | NOT_VERIFIED lineage inconsistency, open |
| M1 | `SYSTEM_METRICS` is persisted as `{}` (sixth instance of the observability whitelist gap): heap, external and post-GC memory trends cannot be read from the database. Engine RSS rose from 440 MB to ~1,000 MB in 25 minutes after the restart (warm-up pattern seen on the previous engine; leak NOT established) | open |
| Macro | MacroAgent returns HOLD "no LLM is configured for a directional idea" (zero information, but it consumes cap budget) | known, research |

## 6. Verdict
Argus is **correctly abstaining**: in the one round where three independent groups agreed, the calibrated, weighted evidence was 50%, not 75%. No lost vote changed a decision; starvation changed one label. The real defects found are the stale Quant price (fixed on the branch), the cap's bias against Quant and Technical, and the missing metrics. The statistical weakness is that Quant's 0.979 rests on a handful of clustered events and that a weighted-mean aggregation cannot reward independent agreement. Neither is fixable by code in this session, and nothing here lowers a threshold or raises a confidence.
