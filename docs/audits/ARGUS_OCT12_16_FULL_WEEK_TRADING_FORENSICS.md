# Argus Oct. 12–16, 2026 PAPER trading forensics

**Scope:** U.S. regular sessions, America/New_York (EDT). This is a persisted Argus-ledger reconstruction using indexed `observability_events` windows and targeted primary-key/index lookups. It is not an authenticated IBKR statement. Historical runtime markers are stale today and are not evidence of a running engine.

## Week result

The Argus ledger contains four PAPER fills across two round trips: DDOG BUY 10 @ $289.01 and SELL 10 @ $287.31; S BUY 38 @ $25.82 and SELL 38 @ $23.90. Recorded gross realized loss is $89.96 and commissions total $4.078183, for approximately **-$94.04 net** if those commissions are deducted. The fills carry `broker_id=ibkr_gateway` and broker order IDs, but the authenticated IBKR blotter was not available; therefore the number of independently broker-confirmed trades is **NOT_VERIFIED**. No synthetic fills are included here.

| ET session | Argus ideas | Rate limited | Consensus terminals | Chief approvals | Risk completed | Argus order/fill evidence | First demonstrated blocker |
|---|---:|---:|---:|---:|---:|---|---|
| Mon Oct 12 | 26,576 | 8,730 | 15,803 | 28 | 28 | 3 fills (DDOG and S buys, DDOG sell) | Most rounds ended upstream at consensus; three orders were recorded |
| Tue Oct 13 | 30,011 | 7,047 | 18,133 | 0 | 0 | 0 RTH; S protective sell filled 09:19 ET premarket | RTH consensus; premarket exit was delayed by wide-spread policy then filled |
| Wed Oct 14 | 43,904 | 20,362 | 27,191 | 0 | 0 | 0 | Consensus; no RTH approval reached Risk |
| Thu Oct 15 | 35,230 | 17,801 | 22,749 | 0 | 0 | 0 | Consensus; zero approvals and zero Risk evaluations |
| Fri Oct 16 | 28,728 | 13,652 | 18,348 | 0 | 0 | 0 | Consensus after PAPER enable at 11:51:55 ET |

Counts above are exact regular-session event counts from bounded timestamp queries, except Oct. 16 which covers only the enabled interval 11:51:55–16:00 ET. They count events/attempts, not distinct opportunities. Unique opportunity counts and enabled duration on the other days are **NOT_VERIFIED** from this compact event extract. Oct. 13's S sale is deliberately classified as premarket, not RTH.

## Oct. 16 approval diagnosis

The enabled interval had 18,348 consensus terminal events: 18,242 `CONFIDENCE_BELOW_STRONG`, 59 `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE`, 38 `AGENT_DATA_UNAVAILABLE`, and 9 `AGENT_HOLD`. There were zero `CHIEF_APPROVED_IDEA`, `RISK_ASSESSMENT_COMPLETED`, `ORDER_SUBMITTED`, `ORDER_EXECUTED`, and `ORDER_FILLED` events. The highest calibrated consensus confidence was 0.681818, below the unchanged 0.75 threshold. The 59 near-threshold cases had only one independent directional evidence group. Macro HOLD was not agreeing confirmation. Strategy identifiers, complete source traces, and timing for every vote were not persisted, so a per-strategy explanation for every round cannot be reconstructed after the fact.

The largest observed high-confidence example was GM: Quant BUY, raw strength 0.708, calibrated confidence 0.681818, calibration sample size one and marked insufficient; Macro was HOLD. Other examples (BKNG, GOOG, IWM, LRCX, SCHW) also lacked two independent agreeing groups. This is evidence of correct fail-closed consensus under the stored fields, not proof that any of these should have traded.

Rate limiting affected 13,652 Oct. 16 idea events (Kronos 7,744; Macro 2,831; Technical 2,256; Quant 675; JavaCoreEnsemble 146). The historical event payload lacked candidate side/confidence/strategy/origin and a stable episode key. This establishes volume and source concentration, not that an independently useful confirmation was suppressed.

## Opportunity coverage and performance limits

Of the ten reviewed symbols PAYP, AA, CENX, FMX, MTDR, KRMN, CAVA, AR, DKS, and CRGY, bounded event searches found discovery-to-consensus progression for AR and CRGY. Both ultimately showed one-group, low-confidence SELL evidence (maximum 0.502455), not a BUY. The other eight had no matching events in the queried event families; missing ADV, spread, bars, subscription, and scheduler evidence prevents assigning their first blocker. Retrospective close returns are not point-in-time executable opportunities.

The enabled window contained 90 slow SQLite operations (mean 5.08 s; P95 10.5 s; max 13.45 s) and 64 slow synchronous persistence operations (mean 674 ms; P95 999 ms; max 10.335 s). These are performance risks. Available traces do not join them to a missed vote or decision deadline, so they are not established as the cause of zero approvals.

## Evidence boundary

Data was read from the local production database without writes, using `observability_events` indexes for time/event windows, then keyed lookups for individual orders and fills. No authenticated IBKR historical blotter, point-in-time full market snapshot, or exhaustive scheduler/subscription trace was available. See `ARGUS_OCT12_LIVE_FORENSIC_INTERIM_2026-10-12.md`, `ARGUS_OCT14_SESSION_FORENSIC_AUDIT.md`, `ARGUS_OCT15_END_OF_SESSION_REPORT.md`, and `ARGUS_OCT16_COMPLETE_TRADING_FORENSICS.md` for detailed day-specific evidence.

**Conclusion:** four Argus-recorded fills are visible for the week, all in two round trips with about $94.04 net loss after recorded commissions. Independent broker confirmation is not established. Oct. 14–16 RTH produced no approvals; on Oct. 16 the first recorded blocking stage was consensus, not RiskEngine or OMS. No consensus or risk threshold was changed.
