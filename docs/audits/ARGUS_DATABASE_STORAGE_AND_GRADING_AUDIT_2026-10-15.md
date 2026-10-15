# ARGUS database storage and prediction-grading audit (October 15, 2026)

Read-only analysis of the Oct 14 post-close snapshot (`argus_oct14_postclose`, SHA-256 verified, 24.85 GB). Nothing was run against the live database: no VACUUM, no DELETE, no retention change. Scripts: `scripts/forensic/` and the audit evidence folder. PAPER only; LIVE_NO_GO.

## 1. What occupies the database (dbstat, one pass over every b-tree)
| Table | Size | Share | Rows | Avg row | Notes |
|---|---|---|---|---|---|
| observability_events | 7.07 GB | 28.4% | 11.18M | 632 B | 4.84 GB table + 2.22 GB indexes; 14-day retention |
| quant_assessments | 6.38 GB | 25.7% | 224,927 | **28.4 KB** | widest columns: `strategy_evaluations` 17 KB, `market_context` 7.7 KB; 30-day retention |
| decision_provenance | 4.12 GB | 16.6% | 69,270 | **59.4 KB** | `bar_evidence_json` 24.6 KB, `evaluations_json` 17.5 KB, `strategy_context_json` 14 KB; **90-day retention** |
| event_traces | 2.98 GB | 12.0% | 2.53M | 1.2 KB | permanent decision record by design |
| agent_reasoning_logs | 1.11 GB | 4.5% | 685k | 1.6 KB | `indicators_snapshot` 8.6 KB |
| candidate_rankings | 0.65 GB | 2.6% | 698k | 0.9 KB | 14-day retention |
| trade_lifecycle_transitions | 0.60 GB | 2.4% | 839k | 0.7 KB | |
| pit_decision_ledger | 0.39 GB | 1.6% | 912k | 0.4 KB | |
| agent_predictions | 0.31 GB | 1.3% | 681k | 0.5 KB | |
| ai_calls | 0.29 GB | 1.2% | 207k | 1.4 KB | |
| kronos_predictions | 0.19 GB | 0.8% | 309k | 0.6 KB | |
| ohlcv_bars | 0.10 GB | 0.4% | 625k | 0.2 KB | market data is **not** a storage problem |

* The top five tables are 87% of the file; the top three are 70.7%. Orders, fills, positions, risk and reconciliation are negligible by comparison.
* **It is not slack space.** Snapshot free pages 1,348 (5 MB); live database (Oct 15 08:00) 29.22 GB with 29 MB free pages and `auto_vacuum=0`. A VACUUM would reclaim almost nothing: the file is live data.
* The hypothesis "observability + predictions + market data" is partly wrong: predictions (0.5 GB) and bars (0.1 GB) are small; the volume is two wide-JSON tables (`quant_assessments`, `decision_provenance`, 42%) plus the event log.

## 2. Growth is accelerating
| Day | observability_events | decision_provenance (rows / payload) | quant_assessments (rows / payload) | event_traces |
|---|---|---|---|---|
| Oct 12 | 0.89M | 12,268 / 0.73 GB | 12,268 / 0.33 GB | 140k |
| Oct 13 | 1.43M | 23,075 / 1.28 GB | 23,075 / 0.63 GB | 206k |
| Oct 14 | **2.63M** | **33,927 / 1.88 GB** | **33,927 / 0.91 GB** | 299k |

On Oct 14 the two wide-JSON tables alone added roughly **2.8 GB in one day**. The live file grew by about 4.4 GB between the Oct 14 post-close snapshot and Oct 15 07:43. With 29 GB free and a 15 GB safety floor, at Oct 14 rates the headroom is **roughly three to five trading days**. This is the most urgent operational finding of the audit: the 90-day retention on `decision_provenance` (about 59 KB per Quant evaluation) cannot be sustained on this disk.

## 3. Retention versus grading (the data-lifecycle defect): CONFIRMED
Retention windows (config/runtimeIntervals.json): `agent_predictions` and `kronos_predictions` 30 days, `quant_assessments` 30, `prediction_outcomes` 90, `observability_events` 14. The retention sweeps **do** delete (earliest raw prediction in the snapshot is 2026-09-14 = 30 days before the snapshot).

| Measure (snapshot, Oct 14 20:07Z) | Value |
|---|---|
| Kronos predictions pending (no outcome) | **307,041 of 308,635 (99.5%)**, oldest 30.1 d |
| Technical pending | 76,869 (oldest 30.1 d); Macro 128,788; Quant 19,921; JavaCoreEnsemble 3,978 |
| Generation per day (Oct 14) | ~35,840 agent + 45,935 Kronos = **~82k predictions/day** |
| Graded per day (Oct 14) | 457 agent + 1,604 Kronos = **~2,061/day (2.5% of generation)** |
| Age of what the grader is reaching | agent predictions graded on Oct 14 were **29.5-30.1 days old (avg 29.6)**; Kronos 27.6-30.1 days (avg 28.6) |
| Expiring within 24 h, ungraded | 1,244 agent + 753 Kronos |
| Expiring within 7 days, ungraded | 6,106 agent + 5,103 Kronos |
| Graded history | outcomes were written Sep 4-9, then **none for agent predictions from Sep 10 to Oct 12**; grading resumed Oct 13-14 at the retention edge |
| Do outcomes survive raw deletion? | **Yes**: 73,337 of 73,657 agent outcomes (99.6%) and 8,246 of 9,840 Kronos outcomes have no raw prediction left; outcomes live 90 days |

Mechanism: the grader walks pending predictions **oldest-first**, re-fetching old 1-minute windows through a serialized, preemptible historical-data queue, at about 2k rows/day against about 82k/day arriving. Everything it grades is therefore the oldest remaining row, which is within a day or two of its 30-day deletion; everything younger waits and, at this throughput, is deleted ungraded. Calibration is thus built from 30-day-old evidence, and the evidence for the most recent month never reaches it. Because graded outcomes survive raw deletion, calibration does not need the raw rows kept: it needs the grader to reach them in time.

**Deleted-ungraded count:** not directly measurable (the raw rows are gone). Bound: predictions created Sep 14-Oct 14 are 99.5% ungraded at day 0-30; at 82k/day generation versus ~2k/day grading, about 97% of each day's predictions will have been deleted ungraded unless grading throughput changes.

**Calibration impact:** Technical's stored calibration rests on 67 graded predictions (effective 5) from one afternoon (Sep 14); Quant's on 59 (effective 3; one GLD event); Kronos' on 1,496 (effective 111) from Sep 14-16. See `ARGUS_DISCOVERY_AND_CONSENSUS_FORENSICS.md`.

## 4. What this does not establish
* It does not show that recent-first grading would raise confidence: out-of-sample, none of Kronos, Technical or Quant shows skill; honest calibration would sit near 0.45-0.55.
* It does not show that observability growth is "wasteful": event_traces is the permanent decision record by design. The measured problem is the per-row width of `quant_assessments` and `decision_provenance` and the 90-day provenance window.

## 5. Proposed (not implemented; needs review, isolated database, certification)
1. **Grading** (`dev/calibration-grading`): grade newest-first or cluster-sampled using locally stored bars; bounded queue use; one representative per symbol x 10-minute cluster; never grade past retention.
2. **Retention-before-grading guard**: never delete a raw prediction that is inside the grading horizon and still ungraded without recording its disposition (aggregate counter), and size retention to grading throughput.
3. **Retention policy for the wide tables**: shorten `decision_provenance` (90 days -> days, config change) and `quant_assessments` (30 days), and/or store `bar_evidence_json` by reference (it duplicates 1-minute bars that already exist in `ohlcv_bars`); keep trades, fills, risk, lifecycle and calibration evidence permanent. A config-only retention change needs a restart; the batched sweeper already avoids long locks.
4. **Disk**: continuous free-space alerting (pause-only guard is running), and a verified off-session full backup target of at least 64 GB or a compressed backup directory.
5. Nothing here touches the running engine; no mass DELETE, VACUUM or schema change is proposed during trading.
