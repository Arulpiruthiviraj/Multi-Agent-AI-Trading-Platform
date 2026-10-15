# ARGUS production trading capability proof (October 15, 2026)

Three separate questions, three separate evidence classes. PAPER only; LIVE_NO_GO. Nothing here is alpha, organic paper evidence, or a statement about future profitability.

## Q1. Can Argus trade mechanically, with production components? **PASS (synthetic, labeled)**

Full-size session, 500 hidden symbols, 90 occupied IBKR-style lines, 37 routine rescue renewals per minute, Date.now bound to the simulated clock; only the external Alpaca REST boundary and the broker are simulated.

| Evidence | Result |
|---|---|
| Test B discovery -> BUY -> monitor -> SELL | Two oracle-valid hidden opportunities (LAMO, LAHP) discovered by the production allocator (recall 0.63, 1 trap promoted), bought, monitored and sold; 13 fills; 65 approved consensus rounds |
| Accounting / Risk / Exit oracles | 0 mismatches / 0 hard violations / 0 violations (2 stop breaches, both handled) |
| Timeline invariants, simulated-time integrity | 0 violations; 99.99% of 250k persisted events inside the simulated window |
| Caveat | Approvals used the labeled synthetic calibration fixture `POSITIVE_CAPABILITY_BROAD` (160W/40L in buckets 0.6-1.0 for four agents) and the UNTESTED baseline lifecycle (no authority). It proves the pipeline, not the agents. |

## Q2. Can the *current PAPER configuration* approve trades? **Not on the production calibration. FAIL (as a capability), correct as a decision**

Real 1-minute bars and real prior daily history read from the Oct 14 post-close production snapshot; the real Technical, Kronos and Quant agents, ChiefTrader, RiskEngine and OMS decide against a synthetic broker. 12 symbols per day, selected by Argus' own idea volume among symbols with >= 330 complete minute bars (Oct 14 itself has only one such symbol because most of its minute bars were not collected). Lifecycle = the planned production baseline (CORE UNTESTED, PULLBACK_CONTINUATION RETIRED).

| Day | Calibration | Rounds | Approved | Max decision confidence | Rounds >= 0.75 | BUY fills |
|---|---|---|---|---|---|---|
| 2026-10-13 | production table (Oct 14 snapshot) | 158 | **0** | 0.594 | 0 | 0 |
| 2026-10-13 | labeled positive fixture | 153 | 12 | 0.802 | 36 | 6 |
| 2026-10-09 | production table | 201 | **0** | 0.792 | 1 (blocked: one independent evidence group) | 0 |
| 2026-10-09 | labeled positive fixture | 213 | 30 | 0.802 | 99 | 12 BUY, 1 SELL |

Same real bars, same agents, same ideas: the only variable is whether the calibration table says the agents are reliable. Real Technical and Kronos signals do coincide (the fixture runs approve on them); with the production table the calibrated confidence is 0.4-0.6. QuantEngine contributed 3-6 ideas per day (live EV and minimum R:R filter); `UNTESTED` grants no authority.

**Answer:** after the planned baseline, the actual configuration can still only demonstrate approval capability inside a calibration fixture. Tomorrow can legitimately be another zero-trade day with no software defect.

## Q3. Are the signals trustworthy (do confidence scores reflect reliability)? **FAIL: no out-of-sample skill; calibration table stale**

See `ARGUS_DISCOVERY_AND_CONSENSUS_FORENSICS.md` section 1-2. Summary: chronological and recent-window hold-outs show Kronos, Technical and Quant at coin-flip reliability (win rates 0.43-0.53 at their grading horizons); Kronos' stored 0.51 is correct; Technical's and Quant's stored values are stale and wrong in both directions because the grader works oldest-first through a backlog (calibration built from Sep 14-16 data on Oct 14) and clustered counts are treated as independent samples. Recalibrating would make the numbers honest (about 0.45-0.55), not high.

## What would change the answer (not done tonight)
1. A genuinely independent, validated strategy with out-of-sample evidence (chronological split, cost-aware); CORE strategies currently have only SAME_BAR_CLOSE daily backtests, which are non-promotable.
2. Grading that keeps pace (recent-first / cluster-sampled grading from locally stored bars), then letting calibration reflect recent reliability.
3. Owner decision on STRONG-tier calibration sufficiency (removes the thin-sample approval path).

Evidence: `oct14_evidence/historical_probes/*.summary.json`, generator `scripts/sim/historicalSession.ts` (fix branch), `oct14_evidence/*oos*.json`.
