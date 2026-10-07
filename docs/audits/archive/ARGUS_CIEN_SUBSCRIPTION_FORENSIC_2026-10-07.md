# CIEN subscription forensic — October 7, 2026

Read-only audit. Narrative times are America/New_York (EDT). The recorded CIEN window is
12:13–12:54 ET; this is not a completed-day assessment. Production DB, current source and isolated
synthetic DB evidence are kept separate. No restart, calibration run, trading-state mutation,
subscription mutation, historical repair or broker order was performed.

## Direct conclusion

CIEN was admitted twice and rejected for promotion six times, with zero recorded quant assessments
on October 7 through this evidence window. All six refusals were SWAP_CAP_REACHED. It survived
the top-N challenger cutoff in every captured cycle. Capacity was 90/90 and effective swap budget 1.
Every observed promotion went to a candidate with a higher recorded score. No ordering defect or
zero-score admission defect is established by these records. Persistent scheduling starvation
under a bounded greedy allocation policy is established over the captured cycles; whether CIEN
merited a trade, or ranked above every other incumbent, is not established.

## Cycle reconstruction

Snapshot candidate scores are rounded display values. Winner/incumbent values are full-precision
promotion-event values, abbreviated here. Promotion events were adjacent within five seconds of
each snapshot; they have no shared cycleId. This timestamp association is inferred, not an exact
cross-event join. The same records also carry CIEN's SWAP_CAP_REACHED reason.

- 12:17:11: CIEN score 1.5524, broad challenger rank 4. RBLX 2.7283 won, displacing NVDA 1.2992.
- 12:19:29: CIEN 1.5524, rank 2. ACN 1.8650 won, displacing MS 1.2864.
- 12:22:51: CIEN 1.5524, rank 2. PANW 2.1353 won, displacing AXP 0.8510.
- 12:25:48: CIEN 1.5524, rank 2 among broad challengers. Momentum-universe LCID 3.3876 won,
  displacing IWM 1.3383. Broad rank is not rank in the combined momentum+broad pool.
- 12:48:34: CIEN 1.7149, broad rank 3. Momentum-universe TXN 2.6894 won, displacing PATH 0.7054.
- 12:53:53: CIEN 1.7149, rank 2. PANW 1.9494 won, displacing TMO 1.1854.

All six snapshots: active 90, cap 90, swap budget 1; CIEN survived truncation.
These are six higher-ranked winners, not evidence that 90 stocks outranked CIEN. Pre-cycle weakest
incumbents scored below CIEN, but after the winner evicted one, the next incumbent's eligibility
and score are not persisted here. A second swap cannot be declared safe from this evidence alone.

## Available and missing evidence

- CIEN admission at 12:13:45: price $441.01, open $427.73, previous close $443.75,
  intraday return about +3.10% from open, IEX snapshot dollar volume $24.72m, spread 12.48 bps.
- Admission at 12:44:01: price $442.40, intraday return about +3.43% from open,
  snapshot dollar volume $27.57m, spread 27.77 bps.
- This is a recovery from the session open, not +3.43% versus previous close; price remained
  below the recorded previous close. Snapshot volume alone does not prove abnormal relative volume.
- Every captured scoring record: baseScore 0, composableScore null, mover bonus 0,
  isVerifiedMover false. The final priority score was entirely the intraday-return term.
- RVOL/provenance were unavailable in the admissions. No CIEN NEWS_CATALYST, NEWS_CATALYST_STAGED,
  NEWS_ANALYZED or FAST-prefixed observation was found for October 7 in the inspected DB window.
  This does not prove no relevant real-world news existed; it means no such evidence was recorded.
- Gap-evidence age in the snapshots ranged about 2.8–11.9 minutes. These are snapshot-cache ages,
  not proof of a fresh streaming quote. Source has no deferral-service priority in this planner.
- There is no evidence CIEN was rejected because it was below the challenger cutoff, pending,
  in cooldown, zero-scored or because all incumbents were protected. The logged reason is the cap.
- CIEN DID receive real quote/quant evidence on October 6. Do not generalize today's zero
  assessments to its entire historical record.

## Source interpretation

OpportunityDiscovery merges and sorts momentum and broad challengers, then planSnapshotHotSwap
caps occupied-stream replacements at one, regardless of a larger requested maxSwaps. At full
capacity it selects from the canonical evictable dynamic pool, preserving core/dwell/rescue
protection and the existing hysteresis edge. The explainer checks exhausted budget before
considering later candidates. Higher-scoring arrivals can indefinitely delay a consistently
strong runner-up. This is a service/fairness limitation, not proof of incorrect score sorting.

The scoring asymmetry also warrants research: previously assessed/static candidates can carry
snapshot and composable evidence, while a new broad-only candidate may have only its gap term.
The zero base/composable values are observed; the extent to which missing-data asymmetry biases
selection requires controlled comparisons. Do not invent a catalyst or volume score to fill it.

The current Fast Lane injector responds to meaningful NEWS_CATALYST events. No corresponding CIEN
event was found. Its presence in the source does not imply every broad price mover enters it,
or that it reserves/preempts subscription capacity.

## Recommended next implementation, subject to normal architecture rules

1. Extend existing candidate/subscription lifecycle telemetry with cycleId on each decision,
   deferral count/first-deferred timestamp, full combined rank, evictable incumbent score/protection,
   promotion acknowledgment and assessment outcome. Keep unknown components explicit.
2. Prototype a bounded first-assessment opportunity for eligible repeatedly deferred candidates
   through existing scheduling/Fast Lane/temporary data-rescue infrastructure. Search and reuse
   canonical services; do not build a second subscription ledger, voting path or broker interface.
   Require real bars and fresh executable quotes. It may assess and correctly abstain.
3. Bound age/fairness by freshness, expiry, broker pacing and existing resource budgets. Compare
   greedy scheduling against this policy in deterministic replay; do not reward stale waiting
   candidates without evidence or let a deferral counter authorize a trade.
4. Test six cycles with continuously higher-scoring arrivals, negative zero/stale/expired candidates,
   core/dwell/rescue protection, provider rejection, dedup and real downstream assessment. Measure
   time-to-first-assessment, missed coverage and churn, not raw trade count.
5. Do not merely raise the swap cap or grant Fast Lane unrestricted preemption. More swaps may
   increase churn and still never evaluate CIEN. New quant calculations go to Java; scheduling is
   control-plane work. Preserve the protected trading spine and update the living architecture
   only when an implementation changes it.

## Independent synthetic round-trip verification

Read-only isolated DB:
`%TEMP%/argus_synthetic_sim_calibration_multiday_cold_20261007.db`.

- Entry consensus 0.7710714285714287, approved, three agreeing records: KronosEngine 0.85,
  TechnicalAgent 0.714, NewsAgent 0.765.
- Approved BUY and SELL risk rows, max quantity 11, no recorded rejection gate.
- AAPL BUY 11 @ 254.35252, SELL 11 @ 241.664912, both FILLED.
- Fill watermark 11 then 0; closing realized P&L −139.56368800000013.
- Both orders classify execution_environment as REPLAY. Simulated timestamps are September 15;
  the artifact was inspected October 7. Do not relabel this as October 7 organic PAPER trading.

This verifies the reported ledger/consensus/risk/round-trip records. It does not independently
certify every fixture generation/hard-stop trigger or prove organic calibration, live broker
execution, a three-hour wall-clock soak or real-world alpha. A losing fixture is useful evidence
of accounting behavior; loss alone does not make a fixture stronger or unbiased.

CEG and CTVA each had one recorded regular-hours assessment and one NO_ELIGIBLE_STRATEGY abstention
through 12:54 ET. The claim of repeated assessments is not supported in this specific window.
Research their focus/regime/quarantine/data/strategy exclusions separately; do not lower EV/R:R.
Warm calibration, cold-vs-warm certification, all-five-CORE fixtures, multi-hour soak and replay
corpus completion were not audited or run in this pass. They remain unverified here.
