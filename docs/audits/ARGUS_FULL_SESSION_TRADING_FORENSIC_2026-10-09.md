# Argus full-session forensic — October 9, 2026

Frozen before new repairs. SQLite cutoff **2026-10-09 18:44:42.883 ET** (22:44:42.883Z). Comparison covers retained October 8 evidence. All narrative times are America/New_York. No runtime restart, resume, broker operation or environment change was performed by this audit.

## Direct conclusion

**No trading occurred in the extracted ledgers.** Both days have zero Chief approval events, Risk assessments, trades and fills. Opportunities stopped upstream at coverage, selection, lifecycle authority and consensus. An organic approved idea never exercised the broker path; a fill failure does not explain this session.

This is a mixture of engineering problems, research/certification gaps and legitimate abstentions. A rising stock or `triggerMet=true` does not establish an executable positive-expectancy opportunity. Do not lower 0.75, fabricate lifecycle evidence or authorize LIVE.

## Evidence and limits

The extraction used direct read-only/query_only better-sqlite3, one consistent read transaction, and no application DB imports/migrations. **2,124,947 events** from October 8 00:00 ET through the cutoff matched the independent count exactly. Ten scoped ledger extractions completed. Private frozen evidence lives in `C:\Users\ithay\AppData\Local\Temp\argus-oct9-audit-extract-BxKBsa`; raw payloads/prompts/account fields must not be published. A partial full-DB backup was stopped and is invalid/unused.

Event timestamps use numeric milliseconds; ISO ledger dates are normalized to ET. Payload wrappers are unwrapped once. Events are not unique symbols, independent opportunities or executed trades. Working-tree SHA `2404ce5` is not retroactively assigned to old processes. Executed bundle hashes and historical effective config remain UNKNOWN unless deployment evidence supports them.

This covers the full retained window, **not a certified tick-by-tick replay**. There are no October 9 pre-open runtime events in this extraction. First boot evidence is 09:40:50; why the first ten RTH minutes lack runtime evidence is unverified. Current cached bars cannot prove historical receipt times. Captureable gain is NOT CERTIFIED.

## Funnel

October 8: 13,608 admission events; 552 promotions; 6,907 Quant completion events; 4,017 Quant evidence events; 43,405 ideas; 704 authorization checks/policy selections; 27,156 terminal rounds; zero Chief approvals.

October 9: **5,450 admissions; 640 promotions; 6,611 Quant completion events; 2,113 Quant evidence events; 29,259 ideas; 947 authorization checks/policy selections; 22,529 terminal rounds; zero Chief approvals.**

October 9 RTH specifically: 3,249 admissions, 453 promotions, 6,020 Quant completion events, 28,585 ideas, 900 authorization checks, 22,048 terminal rounds, zero approvals. Post-close: 2,201 admissions, 187 promotions, 591 completion events, 674 ideas and 481 terminal rounds.

Risk assessment, trade and fill ledgers each contain **zero rows** across the two-day extraction. Submitted-order events are absent. Exact completeness of all separate order tables remains unverified; do not confuse a trade ledger with every possible order record.

Quant ledger October 9 contains 6,614 rows versus 6,611 completion events: these asynchronous persistence streams are not assumed identical. Its 861 `emitted_trade_idea` flags are selection/emission-attempt state, not proof of 861 emitted ideas. Actual idea events: Technical 6,641; Macro 8,735; Kronos 12,936; QuantEngine 783; JavaCoreEnsemble 164.

## Process epochs

First/last retained event times are not OS process creation times. Exact epoch IDs, authority counts, state transitions and terminal reasons are in the companion evidence file.

- **29536:** 09:40:50–11:57:34. 9,797 ideas/346 Quant events. Boot paused; explicitly enabled at 09:43:57. Morning authority fields redacted. Historical executed SHA/config UNKNOWN.
- **32528:** 11:58:11–15:41:21. 17,922 ideas/5,354 Quant events. Boot paused; enabled 12:00:20. Authorized restart record associates the f3ec4d2 repair with this deployment, not an executed-byte attestation.
- **1020:** 15:42:54–16:06:51. 1,524 ideas/556 Quant events. Enabled 15:45:43. Controlled deployment record associates source 19ae895 and diagnostic patch a66e8e1. No independent byte attestation.
- **22412:** 16:07:33–17:49:27. Zero ideas/223 Quant events. Unclean restart detected, paused at 16:10:11. Source-development epoch; do not inherit production certification.
- **4324:** 17:49:57–18:01:53. Zero ideas/11 Quant events; unclean restart, SAFE_MODE/paused.
- **19232:** 18:02:23–18:12:56. Zero ideas/14 Quant events; unclean restart, SAFE_MODE/paused.
- **4184:** 18:13:11–18:44:37. 16 ideas/107 Quant events. Unclean restart, paused. Persisted **external operator resume at 18:41:02** occurred during this audit; this audit did not issue it.

A separate governor session ID has no engine phase evidence; do not invent a PID for it. Watchdog log corroborates three post-close restarts and durable STORM_LOCKOUT. Health intermittently recovered while lockout held: retaining the lockout is expected safety behavior, not a reason to weaken it.

## Authority and low confidence: causes, not only symptoms

October 9 authorization events: **755 NOT_AUTHORIZED / NO_LIFECYCLE_RECORD**, 145 REQUIRES_CONSENSUS / NO_STRATEGY_ID, 47 morning redacted fields. Every recorded policy selection was CONSENSUS. No organic QuantExecutionPolicy approval/rejection branch was observed.

The durable strategyEligibility ledger has one August 31 PULLBACK_CONTINUATION RETIRED record and no VALIDATED/CHAMPION records: **zero privileged PAPER Quant strategies**. The current 21-strategy inventory implies 20 missing records/one retired; exact old inventory requires historical build proof. Do not seed VALIDATED rows to force trading.

Missing lifecycle is terminal before consensus. JavaCoreEnsemble without a single strategy ID goes through consensus. Therefore all generated Quant ideas are not eligible policy evaluations or guaranteed consensus participants. The morning redaction defect was already repaired in f3ec4d2; later epochs retain the enum fields. Historical redacted values cannot be restored by changing current source.

October 9 consensus terminals: confidence 21,958; unavailable data 268; HOLD 282; insufficient independence 20; calibration 1. Independent groups: zero 551, one 20,575, two 1,403. **21,126 rounds lack two groups.**

Participant evidence explains much of confidence weakness. Kronos actual confidence 0.4167–0.4959 despite raw strength up to 0.85; 18,058 participant occurrences carried sufficient-calibration labels. Technical confidence 0.4365–0.949, 10,453 calibrated occurrences and only 16 uncalibrated. Macro uncalibrated, often HOLD, maximum 0.7. JavaCoreEnsemble 0.6075–0.7533, uncalibrated. These are repeated participant occurrences, not independent predictions. Weak historical reliability, disagreement and missing evidence groups can correctly prevent approval. Historical calibration grading itself is not certified here; endpoint corrections do not retroactively repair old outcomes.

## Trigger versus strategy eligibility

October 9 ledger: **137,697 strategy-result rows; 47,416 triggerMet=true outputs, including 23,275 BUY outputs.** All base assessment timeframes are 1Day; separate intraday context can still exist, so this alone does not prove every ORB/VWAP lacked minute inputs.

Late diagnostics: 913 selection events, 912 joined to exact assessment trace IDs, containing 6,373 triggered outputs. **169** belong to emission-eligible pools; **5,982** are excluded by adaptive selection; **222** were adapted but quarantined from emission. Pool membership does not prove cleared EV/R:R or execution authority. Full-day eligible-trigger count is UNKNOWN because this diagnostic was deployed late; do not extrapolate.

SNOW: 22 assessments/14 RTH, 153 triggered outputs, zero emission flags, 22 Quant NO_ELIGIBLE_STRATEGY events. Earlier MA_CROSSOVER BUY confidence 1.0 was outside the adaptive bullish/low-volatility selection pool. It was not rejected by Risk/broker. Hindsight does not justify changing selection to buy SNOW.

## Scheduling and stale historical inputs

First admission per process-symbol → first subsequent Quant completion: **1,789 admitted pairs, 231 matched, 1,558 unmatched/censored**. Matched p50 12.92 min, p95 63.70 min, maximum 193.00 min. This is completion latency, not queue-start latency, stays within each epoch, excludes assessments before admission and can include fast-lane assessments. It is not an unbiased SLA estimate for all candidates. Slowest matched names include COHR, SMCI, BAC, MS, GS, SBUX and ABBV.

Completed cycle at 12:16 took 17.11 min. Later completed cycles reached **21.07 min at 16:48 and 41.09 min at 17:34**. These post-close observations prove recurrence, not an executable RTH missed trade. Earlier missing start telemetry means UNKNOWN, not zero cycles. Detailed symbol/cycle events are retained privately.

Late telemetry: **972 bar-input records, 508 with latest timestamp more than seven calendar days old**. First diagnostic cycle examples: SPY last September 30, QQQ September 23, NVDA August 26. Current quote freshness cannot make historical indicators current.

**Verified canonical data-handling defect:** HistoricalDataGateway.ensureBars declares the cache sufficient using minimum row count or aggregate coverage and returns without checking the requested-window tail. An old but large cache can indefinitely suppress provider refresh. This is not proof every strategy abstention resulted from it. Repair cache refresh scheduling using canonical provider routing/pacing and real data; preserve research/replay windows, failure semantics and safety gates.

## Movers and controls

Earlier IEX SESSION_OPEN-relative observations (not final-day prior-close/full-market rankings): MRNA +8.09%, RBLX +6.33%, PCVX +5.06%, SNAP +4.45%, CRCL +3.28%, MRK +2.96%, TSLG +2.90%, CF +2.68%, SNOW +2.64%, PBR +2.45%, T +2.32%, IBB +2.31%, UBER +2.23%, CPNG +2.23%, PBR.A +2.03%. Full-window traces for these names and SGOV/DUK/MS/VCSH/IGSB controls are in the companion evidence/canvas. These returns are retained midday observations, **not independently certified closing returns**. No captureable P&L is assigned.

MRNA admitted 10:27:41, promoted 10:29:49, first assessed **17:14:09**, 6h46m28s later across epochs. Two post-close assessments/15 triggers, zero ideas. **Zero RTH Quant coverage is verified.** CRCL admitted 11:14:34, promoted 11:21:15, still zero persisted assessments at cutoff. Exact scheduling/provider/eviction state at every missed chance remains partly unobserved; neither case proves a profitable BUY should have happened.

[Nasdaq's October 1 announcement](https://ir.nasdaq.com/node/111076/pdf) independently confirms MRNA joined Nasdaq-100 before the October 9 open. This proves public catalyst availability, not Argus ingestion or point-in-time delivery.

## Providers, resources and unexercised execution

Provider-level counts/latency and failures appear in companion evidence. Success and error ledger rows are distinct from governor considerations/attempts. Large actual latencies can reflect queue/event-loop delay; they do not independently prove a defective timeout timer. **322 IBKR historical errors carry code 200**, not 354: do not relabel them entitlement failures. News failures 2,998; malformed Java bridge responses 61. ACK telemetry exists in later/full-window evidence; an ACK does not certify continuously fresh quotes.

Recurring stalls/restarts are verified, but attribution among SQLite, Java, AI queues, reflection, stdout and memory is **NOT CERTIFIED** without matched profiling. A 17 GB DB is a concern, not alone a causal diagnosis. October 8 persisted a memory-critical pause at 16:56:12. October 9 post-close failures must not be treated as proof of an earlier RTH outage.

Risk, sizing, OMS and broker were **NOT_REACHED** by approved organic ideas. Synthetic round trips prove mechanics under fixture conditions; they do not prove timely real discovery, earned authority, historical-input recency, provider service reliability or trading edge.

Premarket influence is UNKNOWN: no October 9 pre-open runtime evidence; 46 two-day plan rows are not proof plans affected decisions. Exact PIT bars/receipt times/config, executed-byte identity, full-day eligibility, all order-table records and profitable counterfactuals remain unverified.

## Classification and required changes

1. Verified engineering defect: stale-tail cache sufficiency. Repair canonical refresh policy, test stale/current tails, failure and isolated historical windows.
2. Operational coverage defect: long cycles/late assessments. Existing isolated b3e5f6 cooperative scheduler/deadline work is default-off and not deployed/soak-certified; it does not guarantee every mover assessment under shared-process stalls.
3. Authorization/research gap: zero privileged strategies. Complete real research and reviewed lifecycle decisions; do not auto-promote.
4. Historical observability defect: morning enum redaction, already repaired. No retroactive history repair.
5. Evidence gap: bounded input capture/build manifest work is isolated/default-off, not provider publication-time or executed-byte attestation.
6. Resource defect unresolved: profile an isolated equivalent runtime; retain watchdog limits and explicit resume.

## Requested 31 answers

1. No trade: upstream coverage/selection/authority/consensus; no approved organic idea.
2. First universal execution barrier: Chief approval absent. Earlier per-symbol barriers vary.
3. Mixture of engineering gaps and correct abstentions.
4. Some movers admitted early; executable awareness not certified.
5. Timely Quant coverage not sustained; MRNA only post-close, CRCL absent.
6. Matched p50 12.92/p95 63.70/max 193.00 min; censored pairs disclosed above.
7. Yes, long cycles repeated and reached 41.09 min.
8. MRNA/CRCL; slow matched examples listed above, not guaranteed missed BUYs.
9. MRNA assessed 17:14:09 and 18:35:30, both post-close.
10. CRCL never assessed in ledger through cutoff.
11. SNOW continued abstaining: 22 assessments, no emitted flag.
12. 47,416 triggered outputs/23,275 BUY, not independent opportunities.
13. Full-day eligible count UNKNOWN; late exact join 169/6,373.
14. 755 missing-lifecycle idea refusals; 222 quarantined trigger results in late subset, different denominators.
15. Zero privileged PAPER Quant strategies.
16. No organic QuantExecutionPolicy branch observed.
17. No authorized Quant counterfactual exists to establish AI caused its rejection.
18. Low measured reliability, disagreement/HOLD and missing independent groups.
19. No persisted Risk assessment or Chief approval.
20. No Risk rejection, because no assessment reached it.
21. No trades; all separate order-table completeness unverified.
22. No submitted-order event observed.
23. No observed organic fill problem; broker was not reached.
24. Stale historical inputs verified late; intraday absence must be trace-specific.
25. Material premarket-plan effect UNKNOWN.
26. Resource stalls/restarts verified; exact hot function UNKNOWN.
27. Coverage/cache handling are engineering misses; executable profitable miss NOT CERTIFIED.
28. Retired/unqualified/policy-excluded/weak/conflicting evidence can correctly abstain.
29. Research gaps: validation, strategy coverage, PIT evidence and reliable outcome calibration.
30. Repair stale cache; certify bounded admission/provider operation under soak; earn/review lifecycle authority.
31. Gateway stale-tail/provider failure tests; real-clock arrival-during-cycle/rotation/freshness tests; real lifecycle controls; multi-hour provider/resource fault soak.

## Frozen verdict

TRADING_OCCURRED=NO. ORGANIC_FILLS=0. REALIZED_FILL_PNL=0 (no trading, not profitability). AUTHORIZED_PAPER_QUANT_STRATEGIES=0. QUANT_POLICY_ORGANICALLY_USED=NO. RISK/OMS/BROKER_EFFECT=NOT_REACHED. TRUE_FILL_PROBLEM=NO_OBSERVED_EVIDENCE. CAPTUREABLE_GAIN=NOT_CERTIFIED. **NEXT_SESSION_READINESS=NO_GO_FOR_UNATTENDED_VALIDATION; LIVE_NO_GO.**

No new code fixes preceded this freeze. Subsequent isolated fixes belong in a separate repair record; this dated diagnosis is immutable. Exact historical replay and several requested phase certificates remain unavailable rather than claimed complete.
