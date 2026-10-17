# Argus full-day forensic audit — Thursday, October 15, 2026

**Audit posture:** read-only evidence review. Trading thresholds and safety gates were not changed in this audit.
**Market session:** U.S. regular session, 09:30–16:00 America/New_York (EDT, UTC−04:00).
**Current deployment evidence:** checked-out/runtime source SHA `db14216b899a8881cc4dffda2ee22a5559c479af`; PAPER, `TRADING_PAUSED`, `SAFE_MODE`, LIVE_NO_GO at the post-market status check. The runtime reported PID 29024 and a 14:03 EDT core boot. The event ledger records the operator's deployment/resume decision at 13:38 EDT. No order was placed during this audit.

## Executive finding

Argus placed zero trades because no regular-session consensus round emitted `CHIEF_APPROVED_IDEA`. The first terminal order-path gate was therefore ChiefTrader consensus: **22,749 completed rounds, 0 approvals, 0 Risk assessments, 0 trades** in the database's RTH window. The chief reason was `CONFIDENCE_BELOW_STRONG` (22,516 rounds); 105 were `MODERATE_REJECT_CALIBRATION`, 79 `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE`, 37 `AGENT_DATA_UNAVAILABLE`, 11 `INSUFFICIENT_AGENT_PARTICIPATION`, and 1 `AGENT_HOLD`. These are repeated evaluations, not 22,749 distinct opportunities.

Zero orders are **technically consistent with the recorded policy**, not proof that every rejection was economically correct. In particular, strong Quant-only evidence was refused for lacking a second independent evidence group, as required. The audit cannot prove that any symbol was a genuinely profitable point-in-time entry: complete point-in-time quote/spread, eligible strategy, stop/target economics, and synchronized market bars are not available for each candidate.

The most material operational issue is separate from consensus: a disk-space drop triggered an entry pause, while the temporary guard's pause command failed and required manual intervention. The measured monitor samples show free space falling from 18.42 GB at 15:31:26 EDT to 10.43 GB at 15:32:51 EDT; the samples do not establish the reported 10-second duration or the allocation's cause. The guard's own log/source evidence is insufficient to claim that an official, tested pause guard is now reliable. A complete restorable database backup was not verified.

The October 15 protective-exit limiter defect had already been corrected in `db14216` and the event ledger records certification and resume after reconciliation. The production-equivalent D1 test in that commit exercises the real EventBus limiter and rejects spoofed exit seals. This establishes that this specific fix has a regression test; it does not certify the whole live path or profitability.

## Evidence and limits

Primary evidence is the local SQLite `observability_events` ledger, queried read-only with `query_only=ON` and bounded timestamps using `idx_observability_events_type(event_type, ts)`, plus the indexed trades/risk ledgers, the current CLI status, checked-out source, git commit history, and machine-local disk monitor files. Event timestamps are epoch milliseconds (UTC); ISO-text ledgers use a different representation. Database size was about 30.86 GiB and WAL was about 96 MB in this review. No database copy, unbounded aggregation, full integrity scan, or write was performed.

The audit could not independently reconstruct the exact production `.env` values or the state of every external provider/account entitlement without exposing secrets or changing runtime. Public daily market summaries are not tick-level point-in-time evidence. Local one-minute bars exist for some symbols but are incomplete for IP and their ingestion time/provenance is not sufficient to prove that Argus possessed each bar at its original timestamp. All per-symbol “miss” claims below therefore remain unproven unless explicitly stated otherwise.

## Timeline (EDT; UTC in parentheses)

| Time | Evidence and operational state |
|---|---|
| 07:50:48 (11:50:48Z) | `RUNTIME_SESSION_STARTED`, PID 25116. This is the initial session recorded before the regular open. Exact loaded-image SHA is not embedded in that event. |
| 09:30–12:30 | Entries enabled until the owner-directed pause. 19,838 ideas generated, 10,035 rate-limited, 13,337 completed consensus rounds, 8,799 Quant evaluation finishes, 0 approvals. Repeated events and symbols are counted repeatedly. |
| 12:30:27 (16:20:27Z) | `TRADING_ENABLED → TRADING_PAUSED`, owner reason: protective exits competed with the global 120/min research idea cap; cap was reported saturated at 118/120 and there were no broker-side stops. The pause was for new entries; monitoring/exits remained active. |
| 13:32:12 (17:32:12Z) | Shutdown drain recorded while paused. |
| 13:33:42 (17:33:42Z) | Runtime PID 29184 started. |
| 13:38:20 (17:38:20Z) | Entries resumed in PAPER after the `db14216` protective-exit fix was reported certified and reconciliation matched. 2,892 ideas, 1,392 rate-limited, 1,770 consensus rounds, 1,332 Quant finishes, 0 approvals through 14:03. |
| 14:02:50–14:03:59 | Shutdown drain then PID 29024 starts at 14:03:26; entries resume at 14:03:59 after the Jev shadow configuration restart and reconciliation match. |
| 14:03–15:32 | 10,281 ideas, 5,190 rate-limited, 6,281 consensus rounds, 4,642 Quant finishes, 0 approvals. |
| 15:31:26–15:32:51 | Disk monitor samples fall from 18.42 GB to 10.43 GB. The recorded 15:32 pause event reports a 7.5 GB/10-second fall to 10.4 GB, but the independently available monitor cadence only brackets an approximately 8.0 GB fall over 85 seconds. Cause remains unknown. |
| 15:32:10 (19:32:10Z) | Entries paused. The pause reason states the automatic guard's pause call failed and the owner paused manually. |
| 15:38:37 | A second pause-state event says `AUTO_disk_floor_17.7GB_below_500GB`. The temporary guard source defaults to a 15 GB floor but permits `GUARD_FLOOR_GB` override. The 500 GB value conflicts with the expected floor and indicates a configuration/process ambiguity requiring investigation. |
| 15:41:29 | Entries resumed after free space was reported at 17.8 GB, reconciliation matched, and book was flat. 17.8 GB is above the script default floor of 15 GB; the resume event does not establish adequate reserve against the observed multi-gigabyte swing, and no guard hysteresis/reliability proof was obtained. |
| 16:00 | Regular market close. Final 19 minutes show 2,204 ideas, 1,184 rate-limited, 1,351 consensus rounds, 941 Quant finishes, 0 approvals. |
| Post-market status check | Current runtime still reports PAPER and `TRADING_PAUSED`, `SAFE_MODE`, LIVE_NO_GO, database connected, $20,000 saved allocation, and no fresh market-hours quote readiness. UI is disabled/headless. This is not a recommendation to resume. |

Runtime session starts were recorded at 07:50:48, 13:33:42, and 14:03:26 EDT. Logs available to this review do not establish each process's exact stop time or image hash independently; the 13:38 event explicitly names the hotfix SHA, and the current checkout is that SHA. Do not merge these sessions into one uninterrupted runtime.

## Decision funnel

| Stage / event | RTH count | Meaning and limit |
|---|---:|---|
| `WATCHLIST_SUBSCRIBE_REQUESTED` | 2,683 (189 symbols) | Requests, not provider acknowledgments or fresh quotes. |
| `SUBSCRIPTION_PROMOTED` | 711 (181 symbols) | Promotion events, not proof all streams delivered fresh data simultaneously. |
| `SUBSCRIPTION_NOT_PROMOTED` | 10,456 (220 symbols) | Rejections across repeated cycles; event payload did not expose a reason field in the audited rows. |
| `QUANT_SYMBOL_EVAL_FINISHED` | 17,067 (188 symbols) | All recorded as `ASSESSED`; not unique candidates. |
| `TRADE_IDEA_GENERATED` | 35,230 (187 symbols) | Ideas from agents; repeated ideas/symbols count repeatedly. |
| `IDEA_RATE_LIMITED` | 17,801 (188 symbols) | Research ideas suppressed at the EventBus cap; 50.5% of generated-event count. This does not imply 50.5% of viable opportunities. |
| `CHIEF_CONSENSUS_COMPLETED` | 22,749 (187 symbols) | Completed decision rounds; repeated per-symbol rounds. |
| `CHIEF_APPROVED_IDEA` | 0 | No idea authorized past ChiefTrader. |
| `RISK_ASSESSMENT_COMPLETED` | 0 | No Chief approval reached RiskEngine. |
| `ORDER_SUBMITTED` / trades / fills | 0 | No order/fill evidence in the RTH trade ledger. |

Event-ledger counts differ from the bounded recent-row query of `transaction_traces` (32,119 rows, 20,492 with `CONFIDENCE_BELOW_STRONG`, 11,404 with null terminal code, 75 independence rejections, 101 calibration rejections, and other reasons). These ledgers are not interchangeable; the discrepancy is unresolved and the trace query was deliberately bounded to recent rowids. This audit uses the event-ledger consensus funnel for exact session totals and reports the trace ledger as a lineage/data-quality gap.

### Consensus terminal reasons

| Terminal reason | Rounds |
|---|---:|
| `CONFIDENCE_BELOW_STRONG` | 22,516 |
| `MODERATE_REJECT_CALIBRATION` | 105 |
| `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` | 79 |
| `AGENT_DATA_UNAVAILABLE` | 37 |
| `INSUFFICIENT_AGENT_PARTICIPATION` | 11 |
| `AGENT_HOLD` | 1 |

The primary failure point was policy selection at consensus: no round cleared the approval rules. No case can be attributed to RiskEngine, OMS, broker rejection, or fill processing because none of those stages was reached.

## Agent activity and decision quality

RTH prediction rows by agent and direction were: Kronos 21,755 SELL / 7,033 BUY / 2,069 HOLD; TechnicalAgent 5,662 BUY / 75 SELL; MacroAgent 9,114 HOLD; QuantEngine 788 SELL / 497 BUY; JavaCoreEnsemble 521 SELL; JavaFactorComposite 124 BUY / 43 SELL. These are prediction rows, not independent opportunities. The skew is observed; the cause is not established by those counts alone. Technical and Kronos produced materially different directional distributions, while Macro added mostly HOLD/no-directional evidence.

Generated ideas were rate-limited by source: TechnicalAgent 3,016, Kronos 9,874, MacroAgent 3,689, QuantEngine 867, JavaCoreEnsemble 355. This shows the shared first-come cap suppressed every emitting source. A rate-limited vote could delay corroboration; the ledger does not establish which drops changed a final decision. MRNA at 13:44:16 EDT is one concrete TechnicalAgent vote dropped under `MAX_TRADE_IDEAS_PER_MINUTE`, but a later independent BUY round at 13:44:49 ended at 0.442 calibrated consensus. No causal missed profitable entry is proven.

Calibration was consequential in individual rounds. For example, at 13:44:49 EDT on MRNA, Kronos raw 0.85 mapped to 0.5005 reliability (N=3,663), Technical raw 0.578 mapped to 0.2157 (N=41), and consensus was 0.4423 despite two independent groups agreeing BUY. This is an observed calibration output, not proof that the mapping is correct or incorrect for the day's regime. The appropriate next step is calibration audit by time bucket and outcome provenance, not relaxing the 0.75 gate.

### MRNA and MCD high-confidence examples

At 13:38:54 EDT MRNA produced a Quant BUY with raw signal strength 0.8; Chief recorded 0.97857 confidence and one group (`CORE_QUANT_ENSEMBLE`), with calibration sample size 60. Macro contributed HOLD with zero confidence. Chief rejected it as `INSUFFICIENT_AGENT_PARTICIPATION`; the 0.75 score did not replace the two-group requirement.

At 13:38:56 EDT MCD produced a Quant SELL with the same 0.8 raw strength and 0.97857 calibrated/reported consensus confidence, again one `CORE_QUANT_ENSEMBLE` group, sample size 60, while Macro was HOLD. Chief rejected for the same reason. MCD's SELL was not a long-entry opportunity, and no short path is inferred.

At 13:43:45–13:43:48 EDT MRNA again had a Quant BUY around 0.979 and one independent group; the completed result was again `INSUFFICIENT_AGENT_PARTICIPATION`. A subsequent 13:44:49 BUY round did have two independent groups (Kronos and Technical), but was 0.4423 and rejected below 0.75. The ledger proves those specific outcomes and that macro HOLD was not an agreeing vote. It does not prove which applicable agents should have participated, that a provider outage caused the missing group, or that the signal was economically actionable.

## Providers and Jev

The regular-session ledger records 73 `AI_PROVIDERS_EXHAUSTED` events. Samples show Mistral 429 responses, an 8-second timeout, and a “no routable AI providers” response that explicitly failed closed. The sample records are not a complete provider-by-provider health inventory. Because those failures were in optional research/debate agents and the consensus ledger still has quantitative/technical votes, provider failures did not mechanically disable Chief consensus. They could reduce contextual evidence; the data does not prove they caused zero approvals.

Jev produced 229 `JEV_DECISION_COMPLETED` events across the day, but there were **zero `jev_shadow_scores` rows** in the audited date window. The restart/resume event at 14:03 says it enabled shadow news scoring, yet later completed-event counts and an empty shadow ledger mean shadow-write effectiveness is not demonstrated. No Jev votes appear in `agent_predictions`; Jev was advisory/shadow-only and had no authority to satisfy consensus independence. No historical evidence supports claiming it would have approved MRNA/MCD or any winner.

## Reliability incidents and defects

| Finding | Classification | Evidence / disposition |
|---|---|---|
| Protective exits shared the global 120/min idea cap | `VERIFIED_PRODUCTION_DEFECT`; fixed and tested in `db14216` | Owner pause at 12:30 states cap saturation and no broker-side stops. Commit changes the EventBus/rate limiter, includes `D1_protectiveExitUnderIdeaSaturation.test.ts`, checks same-tick exit delivery under >cap load, rejects single-key spoofs, and preserves thresholds. Certified/resumed per event at 13:38 after reconciliation. Not a claim that October 15 had an open position needing an exit. |
| Disk pause call failed | `VERIFIED_PRODUCTION_DEFECT` in the temporary operational guard path | Pause event says guard call failed; manual pause was performed. Temporary script uses `cmd.exe /c` to execute a concatenated command and its floor is environment-overridable; later event shows 500 GB threshold while monitored free space was 17.7 GB. No repository-owned, argument-safe replacement or pass/fail fault-injection test was verified. |
| Disk fell by ~8 GB | `INSUFFICIENT_EVIDENCE` on cause | Independent samples bracket a fall 18.42→10.43 GB in 85 seconds. Temporary log does not identify owning process, file, or allocation. WAL samples were around 51 MB near recovery; this is not enough to attribute a multi-GB fall to SQLite. |
| Event-loop/storage latency | `PERFORMANCE_BOTTLENECK` / incomplete diagnosis | RTH recorded 42 `EVENT_LOOP_LAG_WARN` and 3 `STALL_DETECTED` events; a prior bounded report measured 11 RTH lag warnings (max 16.466 s), 1 stall (39.593 s), and 118 slow SQL warnings (max 36.757 s). Definitions/sample scope differ, so preserve both as separate counters. No blocked stack trace proves the root call. |
| D9 retention fix | `NOT_VERIFIED` against this production load | D9 changes exist in recent history and synthetic tests, but no production-faithful 30 GiB replay/load benchmark with before/after latency was run in this audit. |
| Database backup/recovery | Operational risk | DB ~30.86 GiB, WAL ~96 MB at review; maintenance state reported `SKIPPED_DISK`. No complete restorable backup verified. No integrity scan or copy was attempted. |
| Runtime monitor/CLI lifecycle | `NOT_VERIFIED` | Three runtime starts are visible. No complete monitor identity transition/restart audit or watchdog restart proof was performed. Current CLI is read-only status; current status shows paused SAFE_MODE and stale quote health outside market hours. |

## Direct answers

1. **Why zero trades?** All 22,749 completed RTH consensus rounds failed before approval; 22,516 were below 0.75 confidence and the remaining rounds failed calibration, independent-evidence, participation, data-availability, or HOLD decisions. Thus no Risk assessment/order was created. The owner also paused entries from 12:30–13:38 and 15:32–15:41 for protective-exit and disk-safety incidents.
2. **Technically correct?** Yes, based on recorded gates and evidence. Whether some missed corroboration was avoidable is unresolved; no gate should be weakened on this evidence.
3–5. **Were market winners missed and why?** TTD (+7.8% daily), IP (~+6.8–6.9%), CSGP (~+6–7%), and LLY (+3.54% to +3.55%) are verified as daily movers from public close data. Local records show mixed discovery/evaluation coverage; full point-in-time entry economics are unavailable. See the companion opportunity report. A close-to-close gain alone is not a buy signal.
6. **Confirmed defect-caused missed profitable opportunities:** 0 proven. This means unknown, not none.
7. **Research/independence limitation:** 90 rounds had an explicit terminal independence/participation rejection combined; 37 were unavailable and many others failed confidence. Unique eligible opportunities cannot be inferred from repeated rounds.
8. **Limiter effect:** 17,801 of 35,230 event-recorded ideas (50.5%) were rate-limited, by agent counts above. The removed useful-opportunity count is unknown.
9. **Agent disagreement:** observed asymmetric distributions (Technical predominantly BUY, Kronos predominantly SELL, Macro HOLD-heavy); no single causal explanation was proven. Calibration and differing data/methods are candidates for deeper matched-signal analysis.
10. **Provider outages:** 73 exhaustion events; optional AI research failed in examples, but no direct causal chain to all 22,749 consensus outcomes exists.
11. **Jev:** 229 completed events, zero persisted shadow-score rows, no consensus vote. Predictive value and independence remain unproven.
12. **Synthetic testing:** the known protective-exit failure escaped because prior certification disabled Macro and did not run Kronos at production rate, so the 120/min shared cap was not saturated; an exit oracle tolerated a 15-minute grace. D1 now directly tests saturation and spoof rejection. Other listed incidents need test-run-specific verification; see the synthetic testing report.
13. **Reproduced/corrected:** protective-exit exemption, per-agent drop attribution, D1 load replay and mutation changes are present in `db14216`; deployment/resume event names the SHA. The disk guard failure remains uncorrected/uncertified at repository level.
14–16. **Unresolved and next:** disk allocation cause and guard reliability (P0), backup/recovery and database/latency limits (P0/P1), cross-ledger trace mismatch and provider/quant scheduling lineage (P1), strategy coverage/calibration/out-of-sample edge (P3 research).
17. **Oct 16 supervised PAPER:** **NO_GO for automated entries based on this post-market snapshot.** Current engine is paused and SAFE_MODE; the multi-GB disk event remains unexplained; the guard command/config is not proven safe; no complete restorable backup exists; current market-hours quote and reconciliation readiness must be rechecked before any owner-authorized supervised session. LIVE remains NO_GO.

## Source references

- Runtime code at audited SHA: `src/server/core/EventBus.ts`, `src/server/core/pipelineRateLimit.ts`, `src/server/certification/productionFailureReplay/D1_protectiveExitUnderIdeaSaturation.test.ts`.
- SQLite tables/columns: `src/server/db/schema.ts` (`observability_events`, `agent_predictions`, `ohlcv_bars`, `trades`, `risk_assessments`, `jev_shadow_scores`).
- Temporary machine-local logs used: `%TEMP%/J/disk_monitor.log`, `%TEMP%/J/disk_floor_guard.log`, `%TEMP%/J/disk_floor_guard_v3.cjs`. These are operator artifacts, not repository-owned production controls.
- Market close sources: [AP market wrap for Oct. 15](https://apnews.com/article/f0a4f8aa60a6a24237c419aba38f31fd), [S&P 500 movers and close changes](https://quant500.com/sp500-gainers-losers), [LLY daily range](https://www.marketbeat.com/stocks/NYSE/LLY/chart/).
