# Argus Two-Day Trading Forensic Audit

**Trading dates:** Thursday, October 1 and Friday, October 2, 2026
**Trading timezone:** America/New_York (EDT, UTC−04:00)
**Scope:** Read-only forensic audit. No code, configuration, settings, orders, fills, database rows, or logs were changed. No service was restarted and no test order was placed.
**Evidence cutoff:** Persisted records through Friday 2026-10-02 23:45:15Z (19:45:15 ET) for observability; portfolio/reconciliation snapshots through 20:44:12Z (16:44:12 ET).
**Verdict:** Confirmed P0 PAPER position-control incident. Friday's zero new fills were chiefly an upstream signal/consensus result, not an OMS, RiskEngine, or broker-execution rejection.

## Executive summary

Argus scanned and evaluated symbols on both days. On Thursday it made one organic PAPER round trip in OKTA, then made a second SELL that opened an unintended 14-share short. The first sell fill correctly deleted the local +14 position at 19:27:22.624Z. A later broker/local reconciliation snapshot at 19:28:29.947Z again showed +14 on both sides. RiskEngine reads activeBroker.portfolio() for sell_position_exists; it saw 14 on both sell approvals. At 19:31:37.393Z, the second 14-share SELL filled and the broker-backed position became −14. The account remained in PAPER, but the system violated the close-only position invariant. This is **P0 under the supplied severity definition**, and must be corrected and the remaining short reconciled before another supervised PAPER session. It does not authorize LIVE trading; LIVE remains NO-GO.

The strongest supported mechanism is stale broker position state being accepted after a local close. PortfolioReconciliation deliberately hydrates a broker-reported position when its local row is absent, and writes broker quantities over local quantities on drift. That policy is appropriate for ordinary recovery but unsafe when the broker response is stale relative to a just-confirmed fill. The persisted records prove the fill-to-flat, later +14 snapshot, second risk approval against 14, and final −14. They do not preserve the IBKR callback generation, response age, or ordering needed to distinguish a delayed callback from an adapter cache or a stale broker portfolio() response. That precise transport-level cause remains **UNKNOWN**.

Friday Argus processed 23,718 consensus terminal events across 124 symbols and generated many agent opinions, but it persisted zero risk assessments, submitted zero orders, and filled zero orders. The stored consensus decisions peaked at 0.70 against the unchanged 0.75 bar; none were approved. The terminal-event log attributes 22,963 rounds to CONFIDENCE_BELOW_STRONG, 445 to AGENT_HOLD, 269 to AGENT_DATA_UNAVAILABLE, and 40 to insufficient independence. Capacity pressure and data-rescue denials were real, and quant assessments fell sharply versus Thursday, but representative rising names such as CRDO and FCX were admitted, subscribed, received acknowledgements, and reached consensus. Available evidence therefore points primarily to calibrated signal weakness/disagreement and the required approval bar, with capacity reducing evaluation depth. It does not establish that a particular trade should have been taken.

The OKTA accounting is also wrong. The legitimate BUY 14 at $211.72 and first SELL 14 at $212.49 produced $10.78 gross realized, $2.061366 of entry and exit commissions, and $8.718634 net on that closed round trip. The first sell's profit_loss is NULL. The second SELL created a short but was assigned $11.46 P&L using the prior long's commission-inclusive basis. That is a separate **P1 accounting defect**. Friday's broker and Argus snapshots both retained −14 at $212.5341857 cost basis, but the snapshot's current price equals its average price and is not a verified mark; unrealized P&L is **UNKNOWN**, not zero.

The discussed $2,000 experimental allocation was not active in the persisted settings. Settings showed PAPER, IBKR Gateway, allocation budget $100,000, fixed-dollar sizing, and $3,000 maximum order notional. The 14-share BUY used about $2,964.08 at fill, plus $1.000042 commission. This is CONFIGURATION_NOT_ACTIVATED, not a code defect.

Evidence labels used below: **VERIFIED** means directly present in persisted DB/log/source evidence; **STRONGLY SUPPORTED** means multiple independent records agree but one mechanism detail is not recorded; **PLAUSIBLE** means consistent with evidence but not discriminated; **UNPROVEN/UNKNOWN** means required evidence is absent; **REFUTED** means raw evidence contradicts the proposition.

## Source of truth and limits

The 14.9 GB data/argus.db was opened in SQLite read-only mode with file-existence enforcement. Trading timestamps in the database are UTC; session splits below convert to America/New_York. Raw trades, fills, risk_assessments, consensus_decisions, risk_gate_results, observability_events, agent_predictions, quant_assessments, portfolio, portfolio_snapshots, reconciliation_events, and kill_switch_events were queried. Existing application and Java logs were read. Current source was consulted only to explain observed behavior.

The schema has no separate SQL orders table: OMS orders are represented in trades; /api/v2/runtime/orders is a read-only alias over recent trade-ledger rows. Replay rows were excluded from PAPER trading counts. Thursday had five trades rows total: three PAPER OKTA orders and two AAPL REPLAY fills. Friday had no trade or fill rows.

There is a material observability limitation: Thursday has 26,526 CONSENSUS_TERMINAL_REASON events but 16,513 persisted consensus_decisions; Friday has 23,718 terminal events but 15,923 persisted decision rows. These are not one-to-one. The terminal-event set is used for reason and independent-evidence analysis; the persisted table is used for weighted-confidence percentiles. Both independently show three approvals on Thursday and none on Friday. A complete row-by-row round-to-ledger join is not possible for every round.

agent_predictions captures producer opinions, including tracker/shadow rows; it is not a count of actionable, unique trade ideas. Events such as TRADE_IDEA_GENERATED include HOLD opinions and repeated cycles. They are therefore reported as event-level processing, with distinct-symbol counts, and not equated to orders.

No current runtime command was invoked to reproduce the user's reported ./argus orders timeout. The reported timeout has no request ID or captured response in the inspected evidence. The .argus_runtime_session.json file was absent. Existing logs have different final timestamps; the DB is authoritative for persisted trading evidence, while runtime uptime and watchdog health remain limited or unknown.

## Summary table

| Metric | Thursday Oct 1 | Friday Oct 2 |
|---|---:|---:|
| Engine uptime | UNKNOWN exact; processing evidenced during the date | UNKNOWN exact; persisted processing through 19:45 ET |
| Trading-enabled duration | 10h 07m 52s across recorded enabled intervals; initial overnight state not fully measurable | 14h 31m 47s from recorded transitions through midnight |
| Autobot enabled duration | UNKNOWN exact; enabled at the three OKTA orders | UNKNOWN exact; settings/user runtime view showed enabled |
| Market-data status | IBKR acknowledgements, data type 1 recorded; some no-ack/error/cap events | Acknowledgements across 139 symbols; no-ack, cap and rescue-denial events; not all symbols had fresh quote proof |
| Symbols scanned | 1,220 unique filtered; 607 admitted in full-day event set | 1,209 unique filtered; 524 admitted |
| Symbols subscribed | 164 subscription-outcome symbols; 150 had IBKR ACK events | 140 subscription-outcome symbols; 139 had IBKR ACK events |
| Symbols assessed | 129 with quant-assessment events (14,987 events) | 101 with quant-assessment events (1,345 events) |
| Trade ideas / opinion events | 43,781 TRADE_IDEA_GENERATED events, 138 symbols | 39,079 events, 126 symbols |
| Consensus rounds | 26,526 terminal events / 16,513 persisted decisions | 23,718 terminal events / 15,923 persisted decisions |
| Consensus approvals | 3 | 0 |
| Risk assessments | 12 total, including 9 REPLAY; 3 organic PAPER OKTA | 0 |
| Risk approvals | 5 total including REPLAY; 3 organic PAPER OKTA approvals | 0 |
| Orders submitted | 5 trade rows: 3 PAPER + 2 REPLAY | 0 |
| Orders filled | 5 trade/fill rows: 3 PAPER + 2 REPLAY | 0 |
| BUY fills | 2 total: 1 PAPER + 1 REPLAY | 0 |
| SELL fills | 3 total: 2 PAPER + 1 REPLAY | 0 |
| Closed round trips | 1 PAPER OKTA long round trip; replay AAPL is separate | 0 |
| Open positions EOD | OKTA −14 (broker and Argus snapshots) | OKTA −14 (broker and Argus snapshots) |
| Gross realized P&L | $10.78 on legitimate OKTA round trip; second short is unmarked | $0 from new executed orders; no new fills |
| Measured commissions | $3.122725 on all 3 PAPER fills; $2.061366 belongs to the closed round trip | $0 new-order commissions |
| Net realized P&L | $8.718634 on closed round trip; $7.657275 after also charging short-opening fee, before short mark-to-market | $0 from new orders; existing short unrealized P&L UNKNOWN |
| Largest unrealized exposure | OKTA short: 14 shares, $2,976.54 notional at fill; mark/P&L UNKNOWN | Same −14 position; latest saved cost basis $212.5341857, mark/P&L UNKNOWN |
| Confirmed defects | P0 stale-position re-use allowed unintended short; P1 incorrect P&L attribution | Same unresolved P0 position-control and P1 accounting defects carried forward |
| Operational incidents | Multiple restart-safety pauses/resumes; IBKR no-ack/rejection events | Two restart-safety pause/resume pairs; watchdog health UNKNOWN; orders CLI timeout reported but unverified |

Counts are event counts unless explicitly described as unique symbols or ledger rows. Discovery, quote, and signal counts do not assert that every symbol had a fresh usable quote in every cycle.

## Thursday timeline

All rows include New York time first and UTC in parentheses.

The exact Node process start and broker transport handshake are not represented by a single durable startup event. The first Thursday session-lifecycle record is 09:23:27 ET (13:23:27Z), PRE_MARKET/RESEARCHING; first reconciliation match is 09:23:38 ET, and the first saved IBKR market-data acknowledgement is 09:45:54 ET. Discovery/capacity events exist by 09:25 ET. Worker startup lines in argus-dev.log establish workers started at boot but do not give a consistent per-worker timestamp. Exact startup time is UNKNOWN. No timestamped SAFE_MODE transition or Autobot-toggle history was found; persisted settings later show Autobot enabled. SAFE_MODE status for the full session is UNKNOWN.

| ET time | Component / symbol | Event and outcome | Evidence |
|---|---|---|---|
| 09:23:26 (13:23:26Z) | RestartSafetyGuard | Persisted enabled state paused after unclean prior shutdown; explicit reactivation required. | kill_switch_events id 338 |
| 09:46:14 (13:46:14Z) | Operator / trading state | Explicitly resumed for market session. | id 339 |
| 10:30:22 (14:30:22Z) | RestartSafetyGuard | Another unclean-prior-shutdown pause. | id 340 |
| 10:31:07 (14:31:07Z) | Operator / trading state | Explicit reactivation. | id 341 |
| 14:17:40 (18:17:40Z) | gracefulShutdown | Shutdown drain paused orders. | id 342 |
| 14:18:51 (18:18:51Z) | Operator / trading state | Rebuild/restart with trading enabled. | id 343 |
| 14:30:00.666 (18:30:00.666Z) | OKTA / QuantEngine + TechnicalAgent | BUY idea and ChiefTrader approval; calibrated consensus 0.7954 against 0.75, two independent evidence groups. | transaction trace and consensus event |
| 14:30:01.930 (18:30:01.930Z) | RiskEngine / OKTA | BUY approved, maximum 14 shares. | risk assessment + 24/24 summary |
| 14:30:01.964 (18:30:01.964Z) | OMS / IBKR PAPER | BUY 14 submitted. | trade row / order events |
| 14:30:01.971 (18:30:01.971Z) | IBKR PAPER | Acknowledged. | trade row |
| 14:30:04.650 (18:30:04.650Z) | Fill ledger / OKTA | BUY 14 filled at $211.72; local holding created. | trade + fill |
| 15:26:30.145 (19:26:30.145Z) | PortfolioManager / OKTA | First TARGET_REACHED SELL risk-exit idea. | idea + trace |
| 15:26:30.153 (19:26:30.153Z) | ChiefTrader | Risk exit approved. Calibrated raw evidence 0.4268, one independent group; final exit confidence 0.85 under intentional exit path. | terminal reason + model comparison |
| 15:26:37.213 (19:26:37.213Z) | RiskEngine | SELL approved; gate saw 14 shares. | risk assessment + gate detail |
| 15:26:37.253 (19:26:37.253Z) | OMS / IBKR PAPER | SELL 14 submitted. | trade row |
| 15:27:22.624 (19:27:22.624Z) | Fill ledger / localPortfolioSync | SELL filled at $212.49; sync records prior 14, sold 14, remaining 0, deleted=true. | fill + observability event |
| 15:28:29.947 (19:28:29.947Z) | Reconciliation / OKTA | ARGUS and BROKER snapshots again both show +14; reconciliation id 5842 says matches=true. First saved proof of stale +14 after local close. | portfolio_snapshots / reconciliation |
| 15:31:32.380 (19:31:32.380Z) | PortfolioManager / OKTA | Second SELL idea, same TARGET_REACHED text and $212.29 target, about 4m10s after first fill. | idea + trace |
| 15:31:32.430 (19:31:32.430Z) | ChiefTrader | Same risk-exit exception approved; new transaction/trace, not a replay of the same OMS order. | terminal reason |
| 15:31:36.551 (19:31:36.551Z) | RiskEngine | Second SELL approved; active broker portfolio() position quantity again 14. | risk assessment + sell_position_exists detail |
| 15:31:36.576 (19:31:36.576Z) | OMS / IBKR PAPER | Second SELL 14 submitted. | trade row |
| 15:31:37.393 (19:31:37.393Z) | Fill ledger / OKTA | Second SELL filled at $212.61; broker position became −14. | fill + later broker/Argus snapshots |
| 19:24:54 (23:24:54Z) | RestartSafetyGuard | Persisted enabled state paused again after unclean shutdown. | id 344 |
| 19:28:52 (23:28:52Z) | Operator / trading state | Explicit resume after reviewing reconciliation. | id 345 |

**Premarket:** 5 admissions across 3 symbols, 40 subscription requests across 22 symbols, one quant assessment.
**Regular session:** 3,923 admissions / 566 symbols; 10,594 filtered / 1,174 symbols; 2,118 subscription requests / 143 symbols; 7,340 quant assessments / 120 symbols; 15,069 consensus terminal events / 132 symbols; 3 organic RiskEngine assessments and 3 PAPER submissions/fills.
**After-hours:** 2,748 admissions / 224 symbols; 7,524 quant assessments /111 symbols; 11,392 consensus terminal events /112 symbols. AAPL REPLAY orders/risk assessments are not PAPER trading.
**Overnight/restarts:** safety pauses are listed above. Exact process uptime and watchdog heartbeat are unavailable.

## Friday timeline

There is no single durable process-start event. First saved quant assessment is 09:22:36 ET (13:22:36Z), first IBKR acknowledgement 09:22:51 ET, and first reconciliation match 09:23:33 ET. The kill-switch rows below provide exact trading-state transitions. No timestamped SAFE_MODE or Autobot-toggle history was found; the later displayed runtime status supplied in the request showed SAFE_MODE=false and Autobot enabled, but it is not a historical event log. Exact process start and watchdog state are UNKNOWN.

| ET time | Component | Event and outcome | Evidence |
|---|---|---|---|
| 09:22:35 (13:22:35Z) | RestartSafetyGuard | Paused persisted enabled state after unclean prior shutdown. | kill-switch id 346 |
| 09:23:41 (13:23:41Z) | Operator | Explicit PAPER startup resume. | id 347 |
| 09:34:20 (13:34:20Z) | RestartSafetyGuard | Second unclean-shutdown pause. | id 348 |
| 09:38:52 (13:38:52Z) | Operator | Resumed after checking positions, orders, broker, and reconciliation. | id 349 |
| 09:30–16:00 | Discovery / market data / agents | 4,752 admissions / 475 symbols; 1,306 IBKR acknowledgements / 137 symbols; 312 rescue denials / 92 symbols; 326 capacity-full events / 91 symbols; 1,138 quant assessments / 100 symbols; 20,720 consensus terminal events / 124 symbols. | SQLite observability |
| 09:30–16:00 | RiskEngine / OMS | Zero risk assessments, orders, or fills; no decision reached OMS. | risk_assessments / trades / fills |
| 16:44:12 (20:44:12Z) | Reconciliation / OKTA | ARGUS and BROKER snapshots both retain −14. Current price equals cost basis and is not a current mark. | reconciliation id 5844 / snapshots |
| Through 19:45:15 (23:45:15Z) | Agent / consensus | Persisted event processing continued after RTH; no Friday PAPER trade/fill appears. | max observability_events.ts |

**Premarket:** 4 admissions / 4 symbols, 58 subscription requests / 30 symbols, 45 quant assessments / 15 symbols, 60 consensus terminal events /17 symbols; no order.
**Regular session:** 4,752 admissions /475 symbols; 12,313 filtered /1,153 symbols; 2,210 subscription requests /138 symbols; 1,138 quant assessments /100 symbols; 20,720 consensus terminal events /124 symbols; zero approvals and zero RiskEngine assessments.
**After-hours:** 649 admissions /224 symbols; 162 quant assessments /82 symbols; 2,938 consensus terminal events /107 symbols; no orders/fills.
**Overnight/restarts:** no persisted watchdog heartbeat or exact service uptime. Friday's explicit resume after reconciliation and broker snapshots are verified; watchdog health is not.

## Thursday funnel

Discovery and analysis were active. Full-day raw counts include repeated symbol cycles: 9,150 admitted-candidate events (607 distinct symbols), 22,060 filter events (1,220 symbols), 4,254 watchlist subscription requests (164 symbols), 2,046 IBKR acknowledgements (150 symbols), 1,272 no-ack events (61 symbols), 14,383 temporary-rescue grants (148 symbols), 158 rescue denials (77 symbols), and 171 capacity-full events (78 symbols). These establish market coverage, not fresh quote coverage for every name.

Quant assessment logged 14,987 times across 129 symbols. Technical analysis completed 73,818 times across 138 symbols; Kronos forecasts completed 29,903 times across 136 symbols. TRADE_IDEA_GENERATED was emitted 43,781 times across 138 symbols, followed by 26,526 consensus terminal events across 136 symbols. Only three organic PAPER cases reached RiskEngine, all three approved and filled in OKTA. Nine additional risk assessments and two fills were REPLAY and are excluded from PAPER.

## Friday funnel

Argus actively scanned and evaluated Friday. Full-day discovery recorded 5,405 admission events /524 symbols and 13,706 filtered events /1,209 symbols. Subscription observability recorded 2,496 requests /140 symbols, 1,442 IBKR acknowledgements /139 symbols, and 57 no-ack events /40 symbols. There were 13,484 rescue grants /119 symbols, 395 denials /100 symbols, and 409 capacity-full events /99 symbols. Quant assessment recorded 1,345 events /101 symbols. Technical analysis completed 66,646 times /128 symbols; Kronos completed 32,315 times /129 symbols. Agent opinions led to 23,718 consensus terminal events /124 symbols.

The downstream break was decisive: **0 consensus approvals in 15,923 persisted decisions; 0 RiskEngine rows; 0 OMS submissions; 0 fills.** Terminal reasons: 22,963 CONFIDENCE_BELOW_STRONG, 445 AGENT_HOLD, 269 AGENT_DATA_UNAVAILABLE, 40 MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE, and 1 MODERATE_REJECT_CALIBRATION. There is no evidence of a downstream broker rejection or failed execution because nothing reached RiskEngine or OMS.

The event counts are not unique-candidate conversion rates: symbols can be admitted, subscribed, analyzed, and decided repeatedly. Event and decision-table persistence are not one-to-one.

## Thursday trade reconstruction

### PAPER BUY 14 OKTA

- **Lifecycle:** QuantEngine emitted BUY; TechnicalAgent independently agreed. Consensus recorded raw/final confidence 0.7954296, 2 independent groups (TechnicalAgent and CORE_QUANT_ENSEMBLE), and approval over 0.75. Trace contributors also include RiskAgent and MacroAgent context. The QuantEngine strategy was TREND_FOLLOWING in BULLISH_TREND, but the source explicitly labels it cold-start with zero real closed trades and no realized EV/stop/target. The idea used operator-enabled cold-start bootstrap.
- **Risk/sizing:** RiskEngine approved 14 maximum shares. Persisted summary reports 24/24 applicable BUY gates passed. order_notional_cap constrained order size to the $3,000 per-order ceiling; Argus allocation was $100,000; fixed-dollar sizing was active. Broker equity/buying power were $1,001,768.61 / $3,339,228.70, separate from Argus allocation. Fill notional was $2,964.08.
- **Execution:** submitted 18:30:01.964Z / 14:30:01.964 ET, acknowledged seven milliseconds later, filled 14 at $211.72 at 18:30:04.650Z. Arrival $211.62; adverse arrival shortfall $0.10/share, $1.40 total. Commission $1.000042.
- **Market evidence:** contemporaneous bid/ask/spread is not persisted in the trade row. Stop/target fields on the order row are NULL. Quote spread and order-level stop/target are therefore UNKNOWN.
- **Assessment:** Formally valid under encoded PAPER rules: two independent groups, consensus >0.75, RiskEngine passed, and size stayed below configured cap. It does not establish a validated profitable edge; its quant setup was cold-start.

### First PAPER SELL 14 OKTA

- **Origin and rationale:** PortfolioManager emitted EXIT_CODE=TARGET_REACHED Campaign intraday ATR Target-1 ($212.29, 1.25x ATR) — bank scalp toward daily goal. This is a risk-exit idea. Argus deliberately permits PortfolioManager risk exits to skip the entry-only two-agent quorum; source and unit test confirm this policy. The exit still traverses ChiefTrader, RiskEngine, OMS, and BrokerManager.
- **Confidence:** PortfolioManager producer confidence 0.85; calibrated raw consensus evidence was 0.4268293 with one independent group. ChiefTrader's risk-exit-specific path approved at 0.85. This is an explicit risk-exit exception, not normal two-agent entry approval.
- **Risk/sizing:** RiskEngine approved maximum 14; sell_position_exists saw 14. All 21 applicable SELL gates passed; capital sizing gates that do not apply to a reduction were skipped/BUY-only. Broker equity/buying power were $1,001,780.88 / $3,331,826.09.
- **Execution:** submitted 19:26:37.253Z, acknowledged 19:26:37.271Z, filled at $212.49 at 19:27:22.624Z. Arrival $212.87; adverse shortfall $0.38/share, $5.32 total. Commission $1.061324. Immediate local sync deleted the +14 row.
- **Assessment:** The sell closed the recorded +14 position and exceeded its $212.29 target; the order itself was consistent with exit policy. Later stale-state reconciliation made the long appear open again.

### Second PAPER SELL 14 OKTA

- **Origin and rationale:** A second PortfolioManager TARGET_REACHED decision with the same $212.29 target text, a new trace and order ID. It was a repeated decision based on state still claiming the long existed, not a duplicate transmission of the first OMS order.
- **Risk/sizing:** RiskEngine approved 14; sell_position_exists detail is existingQuantity=14. It queried the active IBKR broker's portfolio() response. It does not require proof the first sell has not consumed the long; SELL bypasses BUY-only cooldown/duplicate gates. Exact broker callback/cache origin of stale 14 is not recorded.
- **Execution:** submitted 19:31:36.576Z, acknowledged 19:31:36.583Z, filled 19:31:37.393Z at $212.61. Arrival $212.785; adverse shortfall $0.175/share, $2.45 total. Commission $1.061359. The broker position became −14.
- **Assessment:** Not correct for close-long intent. SELL was an unrestricted broker order, so IBKR opened a short after the long was already closed. sell_position_exists verified stale positive quantity but no reduce-only/close-quantity invariant protected the broker from a stale approval.

## OKTA double-sell incident

### Millisecond reconstruction

| Required point | ET / UTC | Finding |
|---|---|---|
| T1 first SELL decision | 15:26:30.145 ET / 19:26:30.145Z | PortfolioManager TARGET_REACHED. |
| T2 first SELL risk evaluation | 15:26:37.213 / 19:26:37.213Z | Approved; gate recorded position 14. |
| T3 first SELL submitted | 15:26:37.253 / 19:26:37.253Z | OMS trade 971b…f8b70. |
| T4 first SELL acknowledged | 15:26:37.271 / 19:26:37.271Z | IBKR accepted; trade row later FILLED. |
| T5 first SELL fill | 15:27:22.624 / 19:27:22.624Z | 14 shares at $212.49. |
| T6 local fill received | 15:27:22.624 / 19:27:22.624Z | ORDER_FILLED and fill-ledger event. |
| T7 local quantity became zero | 15:27:22.624 / 19:27:22.624Z | Sync: prior 14, sold 14, remaining 0, deleted=true. |
| T8 IBKR broker quantity became zero | UNKNOWN; no saved zero snapshot | Next saved paired snapshot at 15:28:29.947Z shows +14. Later saved state shows −14. |
| Broker/local reappearance | 15:28:29.947 / 19:28:29.947Z | ARGUS and BROKER both +14; reconciliation id 5842 matches=true. |
| T9 second SELL idea | 15:31:32.380 / 19:31:32.380Z | New PortfolioManager TARGET_REACHED idea with same rationale. |
| T10 second SELL risk evaluation | 15:31:36.551 / 19:31:36.551Z | Approved. |
| T11 quantity RiskEngine saw | 15:31:36.551 / 19:31:36.551Z | 14 from active broker portfolio() response. |
| T12 second SELL submitted | 15:31:36.576 / 19:31:36.576Z | OMS trade b89b…dd274. |
| T13 second SELL filled | 15:31:37.393 / 19:31:37.393Z | 14 at $212.61. |
| T14 broker position −14 | Paired snapshots at 15:33:32.149Z / 19:33:32.149Z | ARGUS and BROKER both −14; second local sync deleted the assumed +14 long. |

The active broker's portfolio() response is the authoritative input RiskEngine consumed for sell_position_exists in this assessment; the gate finds the proposal symbol in that returned position list and caps sell quantity to its positive quantity. It is not reading the local portfolio table directly at that point. The saved snapshot at 15:28 shows local materialization and broker response in agreement at +14 despite the local fill-sync deletion. The evidence supports stale broker state accepted back into Argus's reconciled state.

**Why the second SELL passed:** PortfolioReconciliation hydrates a broker-reported position when its local row is absent and writes broker quantity over local quantity on drift. These rules have no observed fill watermark, snapshot-age bound, or broker-position generation check. Separately, sell_position_exists only requires quantity >0 and caps to that quantity. same_symbol_cooldown, daily_trade_limit, and duplicate_signal are explicitly skipped for SELL in OvertradingGuards.ts; there is no durable close-long quantity reservation and no broker reduce-only semantics.

This permits: fill confirms flat → stale broker response resurrects +14 → another risk exit is generated and approved → unrestricted SELL opens −14. It is not simultaneous duplicate submission; the second order was placed 4m13.952s after the first fill.

**Other mechanisms:** duplicate OMS submission/idempotency of one trace is REFUTED (distinct orders/traces). Two independent strategy agents producing these exits is REFUTED (both originate from PortfolioManager). Missing first local fill sync is REFUTED. Stale broker position accepted after local close is STRONGLY SUPPORTED; exact callback/cache mechanism UNKNOWN. Pending SELL reservation is not the direct trigger because first SELL was already filled, although reservation remains important for partial/in-flight orders. Broker behaviorally opened short from the second SELL; order intent lacks an enforced close-long vs open-short distinction.

## Friday no-trade root cause

Friday's principal no-trade cause was upstream of RiskEngine: zero consensus approvals, so no risk decision could occur. Persisted decisions peaked at 0.70, below 0.75. Median was 0.472119; p25 0.440014; p75 and p90 0.472119. Thresholds 0.50/0.60/0.70/0.75 were cleared by 101/31/0/0 persisted decisions. Event-level evidence-group counts were 0 groups: 714; 1 group: 21,201; 2 groups: 1,773; 3 groups: 30. The high single-group share is a quality limitation, not a reason to lower the quorum.

Terminal reason CONFIDENCE_BELOW_STRONG dominates. Agent disagreement and HOLD/unavailable cases contribute. Friday's repeated Kronos outputs had published median confidence 0.85, but representative terminal payloads show historical reliability around 0.472 and confidence below the approval bar. TechnicalAgent often leaned BUY while Kronos leaned SELL. Exact directional overlap by unique symbol-round is not fully recoverable because event rows and consensus-table rows are not one-to-one.

AI provider exhaustion/rate-limit events occurred (79 AI_PROVIDERS_EXHAUSTED, 909 AI_RATE_LIMITED, 6,373 AI_DEBATE_FAIL_CLOSED_EXCLUDED). Consensus continued without an AI debate vote; no fabricated HOLD from unavailable providers is evidenced. AI degradation may have removed debate context, but did not create the primary blocker. There is no evidence of an approved decision vetoed by broker, OMS, or RiskEngine.

The carried OKTA short is real exposure and a recovery concern. No Friday risk assessment was generated, so there is no evidence it directly caused a rejection or materially changed a specific decision. Its prospective BUY risk impact is UNPROVEN.

## Signal quality

Counts below are agent_predictions rows; confidence is producer-published before consensus calibration. Counts are repeated opinions, not trades. Cell format: BUY / SELL / HOLD.

| Source | Thu counts; median/max confidence | Fri counts; median/max confidence | Interpretation |
|---|---|---|---|
| TechnicalAgent | 8,196 / 49 / 0; 0.584 / 0.922 | 7,175 / 77 / 0; 0.586 / 0.936 | Predominantly BUY; often conflicts with Kronos SELL. |
| QuantEngine | 2,733 / 1,115 / 0; 0.800 / 1.000 | 206 / 63 / 0; 0.800 / 1.000 | Much lower Friday volume; producer confidence is not calibrated consensus confidence. |
| KronosEngine | 5,980 / 22,185 / 1,738; 0.850 / 0.850 | 5,599 / 25,139 / 1,577; 0.850 / 0.850 | SELL-biased; historical reliability calibrates down in terminal decisions. |
| MacroAgent | 332 / 0 / 12,952; 0.000 / 0.700 | 581 / 0 / 12,137; 0.000 / 0.800 | Mostly HOLD/context, often no usable calibration data. |
| JavaCoreEnsemble | 0 / 190 / 0; 0.635 / 0.700 | 0 / 17 / 0; 0.635 / 0.635 | Sparse SELL output; own quality gates apply. |
| JavaFactorComposite | 61 / 78 / 0; median 0.049 / max 0.568 | 11 / 15 / 0; median 0.053 / max 0.398 | Sparse, low-confidence votes. |
| OpportunityScreener | 14 / 0 / 0; median 0.430 / max 0.499 | 4 / 0 / 0; median 0.419 / max 0.468 | Very low volume and below approval-quality evidence. |
| PortfolioManager | 0 / 2 / 0; 0.850 / 0.850 | 0 / 0 / 0 | Thursday's two exit ideas were the OKTA sells. |
| NewsAgent / FundamentalAgent | No rows for these names | No rows | Do not infer they should have been enabled. FundamentalAgent was explicitly disabled on some cycles; news scoring is not a NewsAgent vote. |

No adequate forward outcome sample for every Friday symbol/agent round was established; agent forward performance is UNKNOWN. Historical strategy edge remains unestablished.

## Consensus analysis

| Measure | Thu event-led rounds | Fri event-led rounds |
|---|---:|---:|
| Terminal events | 26,526 | 23,718 |
| Distinct symbols | 136 | 124 |
| 0 / 1 / 2 / 3 independent groups | 825 / 21,564 / 3,937 / 200 | 714 / 21,201 / 1,773 / 30 |
| Confidence below strong | 25,540 | 22,963 |
| Agent HOLD | 312 | 445 |
| Agent data unavailable | 513 | 269 |
| Insufficient independence | 154 | 40 |
| Approved | 3 | 0 |

Persisted consensus_decisions stats: Thursday n=16,513, max 0.922, median 0.472119, p25 0.282701, p75 0.472119, p90 0.472119; 1,072 ≥0.50, 176 ≥0.60, 4 ≥0.70, 4 ≥0.75, 3 approved. Friday n=15,923, max 0.70, median 0.472119, p25 0.440014, p75/p90 0.472119; 101 ≥0.50, 31 ≥0.60, none ≥0.70 or ≥0.75, no approvals.

The three Thursday approvals align with the OKTA BUY and two PortfolioManager exits. The exits intentionally bypass entry quorum; their final confidence does not negate the position-state defect. No evidence supports lowering the consensus threshold.

## RiskEngine analysis

Thursday had 12 total risk assessments: three organic PAPER OKTA assessments (BUY+SELL+SELL, all approved) and nine REPLAY assessments (two approvals and seven allocation rejections). Thus the seven argus_capital_allocation rejections were replay research, not missed organic paper candidates. Friday had zero risk assessments.

The BUY trace reports 24/24 applicable gates passed. Both SELL traces report 21/21 applicable gates passed. This is consistent with side-conditional gates being skipped; it should not be confused with every side running an identical 25-gate set. Relevant SELL values: emergency stop false; trading state TRADING_ENABLED; Autobot true; market open; data ages 9,581 ms and 5,984 ms; valid prices $212.87/$212.785; no news veto; sell_position_exists 14. Cooldown, daily trade limit, duplicate signal, notional, and daily BUY notional were skipped for SELL by policy.

For the second SELL the individual boolean gates passed against stale input. This is a false approval at system safety level even though each gate reports passed. Market-hours, freshness, capital allocation, and broker submission did not cause the incident.

## Position / reconciliation analysis

| Time (UTC) | Argus local snapshot | Broker snapshot | Fill-derived expectation | Meaning |
|---|---:|---:|---:|---|
| After 18:30:04.650 BUY fill | +14 | +14 | +14 | Position opened; average basis $211.79143155 includes BUY commission. |
| 19:27:22.624 first SELL fill/sync | 0 (row deleted) | UNKNOWN | 0 | Verified local sync; no broker zero snapshot persisted. |
| 19:28:29.947 reconciliation | +14 | +14 | 0 | Stale broker/local state; marked match and available to RiskEngine again. |
| 19:31:37.393 second SELL fill | 0 after sync deletion | −14 fill-derived | −14 if broker accepts unrestricted SELL | Short created. |
| 19:33:32.149 through 20:44:12.404 | −14 | −14 | −14 | Paired snapshots/reconciliation. |
| Friday 20:44:12.404 | −14 | −14 | −14 | Position persisted into Friday. |

Existing application log later records reconciliation hydration of broker −14 when no local row remained. Friday's resume reason says PAPER positions/orders/broker/reconciliation were verified; paired snapshots confirm −14 on both sides. This is recovery of the accounting record, not a return to flat.

There is no persisted per-callback IBKR position-generation timeline. Current reconciliation writes broker quantity on drift and hydrates broker-only names. PortfolioReconciliation.staleSnapshot.test.ts tests local upsert during broker read and broker-only hydration; it does not test an older broker snapshot resurrecting a just-closed quantity. A delayed callback could plausibly do the same; exact ordering is UNKNOWN. Partial SELL fills or cancel/fill race may also be exposed to this stale-snapshot rule, but were not demonstrated here.

## Market data analysis

IBKR had real acknowledgements, not just a connected socket. Thursday recorded 2,046 acknowledgement events /150 symbols and 1,272 no-ack events /61 symbols. Friday had 1,442 acknowledgements /139 symbols and 57 no-ack events /40 symbols. One Friday acknowledgement payload reports marketDataType=1 (LIVE). These do not prove continuous fresh quotes for every candidate. Friday had 395 rescue denials and 409 capacity-full events.

Market data was not wholly absent: CRDO, FCX, SMCI, RKLB, IREN, TSLA, RIOT, and HOOD had discovery, acknowledgements, agent opinions, and consensus records. Contemporaneous order bid/ask/spread is not persisted. Existing application logs show an IBKR 10197 “No market data during competing live session” rejection for OKTA later Thursday; it occurred after both sells and does not explain them.

## Discovery / capacity analysis

The IBKR line cap was 90. Friday RTH had 326 MARKET_DATA_CAPACITY_FULL events across 91 symbols and 312 rescue denials across 92 symbols, material capacity pressure. Thursday had 90 RTH capacity-full events /53 symbols and 86 rescue denials /52 symbols. Counts are repeated events, not unique lines or lost trades.

Quant assessments fell from 7,340 in Thursday RTH to 1,138 in Friday RTH, and from 129 full-day distinct symbols to 101. This is a throughput/depth regression to investigate. Yet Friday symbols reached consensus; the cap alone cannot explain zero risk/OMS. A complete per-cycle lineage from each filtered candidate through fresh quote and assessment is not persisted, so symbols never subscribed or evaluated cannot be exhaustively identified.

## AI provider analysis

Friday recorded 19,604 AI_CALL events, 909 AI_RATE_LIMITED, 79 AI_PROVIDERS_EXHAUSTED, and 6,373 fail-closed debate exclusions. The mutable provider table at last Friday update shows degraded/offline providers and failures, but it is not a per-decision historical snapshot. Exact healthy/auth-cooldown/quota/timeout counts by minute are UNKNOWN.

Provider degradation was real. It was non-blocking as an architecture capability: deterministic agent/quant inputs continued into consensus without fabricated AI votes. The no-trade record is explained by terminal outcomes and absence of approved rows, not a downstream AI-created HOLD. Whether debate would have changed any individual outcome is unproven.

## P&L / accounting analysis

### Correct first long round trip

- Gross: 14 × ($212.49 − $211.72) = **$10.78**.
- BUY commission $1.000042 + first SELL commission $1.061324 = **$2.061366**.
- Net realized on the legitimate closed long = **$8.718634**.
- First SELL row stores profit_loss=NULL; the ledger omitted calculable closed-trade P&L.

### Second SELL and open short

- Second SELL proceeds before commission: $2,976.54; commission $1.061359. This is short entry, not realized profit.
- Stored profit_loss=11.46 matches (212.61 − 211.79143155) ×14, where $211.79143155 is the initial BUY's commission-inclusive average basis. It assigns the prior long basis to the second SELL even though the first SELL closed that long.
- **$11.46 is incorrect realized P&L for the second SELL.** The second order opened −14 short; its P&L remains unrealized pending cover and valid mark.
- Total PAPER commissions were $3.122725. After legitimate round-trip P&L and all three commission expenses, cash result before marking the open short is $7.657275. This is not total broker equity P&L because the short mark is absent.
- Latest paired snapshot has current_price == average_price == 212.5341857 and unrealized P&L 0. That is not a verified current quote. Unrealized short P&L is **UNKNOWN**.

Arrival-price shortfall: $1.40 BUY, $5.32 first SELL, $2.45 second SELL; total adverse arrival shortfall $9.17. It is reported separately and not subtracted twice from fill-to-fill gross P&L.

## Budget / sizing analysis

Persisted settings show PAPER, IBKR Gateway (Socket), budget=$100000, max_trade_size=$3000, FIXED_DOLLAR sizing, auto_bot_enabled=1, trading_state=TRADING_ENABLED. The persisted daily_target_amount was $100; it is a configured objective, not guaranteed income. RiskEngine BUY allocation was $100,000; at the OKTA BUY it had $100,000 allocated and $2,965.08 used including commission basis. Position size was 14, limited by the $3,000 order ceiling at about $211.62 assessment price. Broker equity/buying power are separate figures.

No persisted setting or trade evidence shows the discussed $2,000 experimental allocation being activated. Classification: **CONFIGURATION_NOT_ACTIVATED**. The order was consistent with active fixed-dollar/max-order settings but exceeded a $2,000 total allocation. No code defect follows from an inactive plan.

## Operations / watchdog analysis

Restart-safety guard pauses on both dates required explicit resumes; no automatic resume is inferred. Friday's final resume reason says positions, orders, broker connection, and reconciliation were checked. Reconciliation matches do not prove freshness, as the Thursday +14 stale snapshot demonstrates.

Watchdog running state and heartbeat age are UNKNOWN. The runtime-session marker was absent; no durable heartbeat series was found in inspected files. Event processing through 19:45 ET Friday proves processing at least then, not full-session uptime. Operational restarts are separate from Friday's consensus no-trade outcome.

## Orders-endpoint timeout

CLI orders calls /api/v2/runtime/orders. That endpoint returns up to 100 recent trade-ledger rows via argusApplication.recentTrades; its code comment says Argus has no separate OMS order book on the alias. It does not call broker.orders() or placeOrder. A timeout affects operator visibility on this route, not the execution path. No request trace, duration, or captured error was found to distinguish CLI wait, API latency, DB contention, network, or server cause; exact cause is UNKNOWN.

## Missed opportunity analysis

The DB has Alpaca/IBKR 1-minute Friday bars, but representative names inspected have only the opening 50 minutes or fewer, not full-session coverage. Figures below are retrospective over stored bars from the 09:30 open through each symbol's last early-session bar. They are not an ex-ante ranking or proof of an executable edge. Window high occurs after open; no look-ahead claim is made.

| Symbol | Stored bars | Open-to-last-close | Open-to-window high | Argus stage evidence |
|---|---:|---:|---:|---|
| CRDO | 50, through 10:19 ET | +5.59% | +7.53%, high timestamp 10:04 ET | 41 admission events, 21 IBKR acknowledgements, 5 quant assessments, 189 consensus terminal events. Reached consensus; no risk approval. First admission 10:05 ET, after saved high timestamp. |
| FCX | 51, through 10:20 ET | +4.24% | +4.33% | 22 admissions, 15 acknowledgements, 6 assessments, 219 consensus events; no risk approval. |
| SMCI | 50, through 10:19 ET | +4.11% | +4.14% | 27 admissions, 7 acknowledgements, 3 assessments, 251 consensus events; no risk approval. |
| RKLB | 38, through 10:07 ET | +3.74% | +4.69% | 21 admissions, 2 acknowledgements, 4 assessments, 8 consensus events; thin coverage. |
| IREN | 50, through 10:19 ET | +3.72% | +4.92% | 19 admissions, 10 acknowledgements, 17 assessments, 212 consensus events. |
| TSLA | 51, through 10:20 ET | +3.58% | +3.75% | 22 admissions, 11 acknowledgements, 19 assessments, 295 consensus events. |
| RIOT | 42, through 10:11 ET | +3.52% | +4.64% | 18 admissions, 22 acknowledgements, 17 assessments, 192 consensus events. |
| HOOD | 50, through 10:19 ET | +1.85% | +5.05% | 2 admissions, 6 acknowledgements, 18 assessments, 293 consensus events. |

These leaders reached Argus at different stages; CRDO is evidenced CONSENSUS_REJECTED, not NOT_DISCOVERED. Bar coverage is partial, quote spread/orderability at decision time unavailable, and names are selected using a later window high. It is UNKNOWN whether any was profitable or should have been bought. Full-day gap, unusual volume, sector/ETF leadership and >10% opportunity audit cannot be established from these partial bars.

## Confirmed defects

### P0 — stale broker position can reopen close-long quantity and create unintended short

- **Defect:** Fill closes local position, but stale positive broker position is accepted into reconciled state; RiskEngine uses that state for sell_position_exists. SELL has no close-only/reduce-only invariant enforced at broker boundary.
- **Consequence:** Second OKTA SELL opened −14; position remained Friday.
- **Why tests missed it:** Tests cover local full-close deletion, CAS fill races, restart hydration from a synthetic broker, and reconciliation during local writes. They do not model an older broker portfolio result after a newer confirmed fill and then run the second SELL through RiskEngine/OMS. Synthetic positions are immediately consistent.
- **Test class:** Cross-service async state-machine test with delayed/out-of-order broker snapshots, fill watermark, repeated exit and real RiskEngine+OMS+broker; property that cumulative close quantity cannot exceed current long and cannot cross zero absent explicit OPEN_SHORT authorization.
- **Classification:** CONFIRMED_DEFECT; **P0**, blocks another PAPER session.

### P1 — short-opening sale was attributed as long realized profit

- **Defect:** $11.46 was assigned to second SELL from now-closed long basis; first SELL P&L was NULL.
- **Consequence:** Ledger misstates short entry as profitable close, corrupting win/loss and learning metrics.
- **Why tests missed it:** OMS tests cover one SELL against one long, not close then stale-state repeat SELL with lifecycle-aware attribution.
- **Test class:** Signed inventory/lot accounting with explicit entry/exit commissions, close/open split and realized P&L only for quantity reducing existing opposite exposure.
- **Classification:** CONFIRMED_DEFECT; **P1**.

### P2 — Friday evaluation depth / capacity pressure

- **Defect/limit:** Friday RTH had fewer quant assessments and heavy capacity/rescue-denial counters.
- **Consequence:** Reduced breadth/depth or delayed evaluation; not a demonstrated OMS/broker rejection.
- **Why prior audit may miss:** Cycle counts and ACKs can look healthy while unique fresh/evaluated coverage falls; no complete candidate-time join.
- **Test/measurement:** Per-cycle lineage, fresh quote coverage, time-to-assessment, and no-ack/rescue-denial distributions under 90-line cap.
- **Classification:** CAPACITY_LIMIT plus observability gap; **P2**, not proof of missed profit.

### P2/P3 — incomplete lineage and timeout observability

Consensus event/table count mismatch, missing quote spread snapshots tied to orders, and no request trace for /runtime/orders limit diagnosis. Timeout cause UNKNOWN; route read-only. Classify as decision-lineage observability P2 and this diagnostic timeout P3, not proven execution defect.

## Refuted defects

- Friday engine completely failed to scan: **REFUTED** by discovery, subscription, technical, Kronos, quant, and consensus activity.
- Friday no-trade caused by RiskEngine or broker rejection: **REFUTED**; no Friday risk rows/submissions.
- AI outage fabricated HOLD: **REFUTED** by fail-closed exclusion evidence.
- First SELL local sync failed: **REFUTED**; event confirms deleted=true.
- Three OKTA sells were independent alpha trades: **REFUTED**; two SELLs are repeated PortfolioManager exits.
- Replay AAPL fills were organic PAPER: **REFUTED** by REPLAY environment.
- $2,000 profile was active: **REFUTED** by persisted $100,000 budget / $3,000 max order.

## Expected conservative behavior

The 0.75 threshold and independent evidence requirement remain valid. Friday's zero approvals are not by themselves a defect. Rejecting weakly calibrated, single-family signals, excluding unavailable AI debate instead of inventing votes, and holding cash are expected conservative behavior. Disabled agents should not be enabled to force trades. Improve coverage without weakening consensus or risk gates.

Thursday's risk exit is an intentional single-agent exception for position protection. The incident is not that PortfolioManager was permitted to close a valid long. It is that stale positive broker quantity later made the already-closed long sellable again, without close-only broker-side protection.

## Why tests missed the defect

- localPortfolioSync.test.ts proves full close deletes, partial close decrements, concurrent local CAS updates preserve deltas, and BUY/SELL fill writers do not lose writes. This incident's sync succeeded; later absolute broker state reappeared.
- paperSpineInternalPaper.test.ts exercises one BUY then one real SELL and confirms close. It never injects stale broker position after close or issues a second close.
- OrderManagement.restartMidPosition.test.ts uses a synthetic broker that preserves its position synchronously through simulated restart; it tests cache-loss recovery, not stale broker snapshot after a newer fill.
- PortfolioReconciliation.staleSnapshot.test.ts covers local write during broker read and broker-only hydration. It does not age the broker snapshot against a newer fill before rehydrating.
- ChiefTraderAgent.test.ts proves PortfolioManager SELL risk exit can be approved without a second agent. That is expected exit policy, not stale inventory safety.
- OvertradingGuards.ts intentionally skips cooldown/duplicate/daily-trade gates on SELL so exits are not blocked. Those checks do not prove close-only inventory safety.

The blind spot was causal integration: tests proved local module contracts but did not preserve broker eventual consistency while exercising fill sync → delayed position response → reconciliation → next exit → RiskEngine → broker execution. Synchronous synthetic fills made broker position immediately current. Line coverage would not expose the missing state transition; a cross-generation cumulative-fill invariant would.

## Why previous audits missed the defect

Earlier reviews examined position reconciliation and local fill races, but stale-snapshot tests addressed concurrent local writes and missing-position hydration. They did not ask whether a fully closed local row could be resurrected by older broker quantity and sold again. “Reconciliation matched” was treated as consistency without freshness relative to latest fill. Correlating fill/sync, paired snapshots, RiskEngine's active broker input, repeated exit, and −14 broker truth reveals the chain.

## Required future tests

1. OMS BUY 14 → SELL 14 fill/sync to zero → delayed broker snapshot +14 → second PortfolioManager exit. Assert stale snapshot cannot recreate sellable quantity and broker cannot cross short.
2. Partial SELL with delayed pre-fill broker quantity; repeated exits must cap cumulative close quantity to remaining long across pending and filled orders.
3. Out-of-order callback generations and restart between fill and position update; persisted fill watermark must dominate older snapshots.
4. Cancel/fill race and duplicate fill callback with cumulative-watermark idempotency; quantity and P&L once only.
5. Explicit CLOSE_LONG versus OPEN_SHORT intent and broker-boundary reduce-only enforcement; short entry separately authorized.
6. Reconciliation with stale snapshot older than local fill watermark; result should fail closed/visible stale state, not silently match or overwrite.
7. Closed round trip then second SELL accounting test; second order opens short with no realized long P&L; first exit receives proper realized P&L/fees.
8. End-to-end candidate lineage under 90-line cap with quote freshness, AI outage, and all downstream stages.

## Remediation priority

1. **P0 — contain and reconcile position truth before next PAPER session.** Review the existing broker-backed −14 using the operator's normal reconciliation procedure; this audit did not flatten or modify it. Preserve LIVE_NO_GO. Do not authorize another session until state and account intent are explicitly reviewed.
2. **P0 — generation-aware position invariant.** Confirmed cumulative fill is newer than any broker snapshot fetched before it. Reconciliation must not overwrite/hydrate a consumed long from older/unversioned response; if freshness/order cannot be proved, close-long approvals fail closed. Enforce close quantity at broker boundary.
3. **P1 — correct realized P&L semantics.** Attribute only fills that reduce exposure; keep unclosed short P&L unavailable until trusted mark. Repair historical rows only under a separately authorized audited accounting process.
4. **P2 — candidate/data observability.** Persist per-symbol/per-cycle discovery→ack→fresh quote→assessment→consensus→risk→OMS→fill lineage and quote source/age/bid/ask. Measure unique coverage under cap.
5. **P3 — orders diagnostic latency.** Add request correlation/duration to the read-only endpoint.

No remediation was applied in this audit.

## Final verdict

1. **Operationally healthy Thursday?** Active and processing real PAPER data/orders, with restart pauses and partial feed/capacity issues. **Not trading-safe** due P0 unintended short.
2. **Operationally healthy Friday?** Active through persisted after-hours processing; reconciliation matched and explicit PAPER resume occurred. Watchdog health and exact uptime UNKNOWN. Overall **not ready for another PAPER session** while P0/P1 remain unresolved.
3. **Actively searched both days?** Yes, verified.
4. **Valid Thursday trades?** BUY met encoded gates but used cold-start bootstrap and proves no edge. First SELL was a valid target risk exit on +14. Second SELL was invalid for close-long intent and opened unintended short.
5. **Why no Friday trades?** No consensus approvals; mostly calibrated confidence below 0.75, many rounds with <2 independent groups, plus HOLD/unavailable/disagreement. Nothing reached RiskEngine/OMS. Capacity reduced evaluation depth but is not the primary demonstrated blocker.
6. **Second SELL a safety defect?** Yes. Stale broker quantity made a closed position sellable and unrestricted SELL opened −14. **P0.**
7. **Why tests missed it?** They prove local close, local-writer races, broker-only restart hydration, and one BUY→SELL spine, not older broker state after a newer fill followed by second close through full stack.
8. **Recovered −14 Friday?** Yes, broker and Argus snapshots agree at −14 through 16:44 ET Friday; position was carried, not flattened.
9. **Did short affect Friday?** Real $2,976.54 notional exposure at entry; impact on a specific Friday risk decision is unproven because there were no risk assessments.
10. **Strong opportunities missed?** Partial bars show early movers. CRDO, FCX, SMCI, and others reached funnel stages through consensus; no approvals. That is a consensus-rejected candidate path, not proof of executable profit. Full-day/>10% opportunity audit is unavailable from stored minute-bar coverage.
11. **$2,000 profile active?** No; $100,000 allocation / $3,000 max order. CONFIGURATION_NOT_ACTIVATED.
12. **Is $11.46 correct?** No; misattributed to second SELL. First round-trip net is $8.718634; short unrealized P&L unknown.
13. **Safe to continue supervised PAPER?** No, not before position-control remediation and explicit review/reconciliation of −14. Keep LIVE NO-GO.
14. **Before next PAPER session:** generation-aware broker position handling, close-only quantity enforcement at execution, signed-position/P&L accounting. Do not lower consensus or force trade frequency.

## Evidence references

- src/server/engines/RiskEngine.ts — active broker portfolio read and sell_position_exists gate.
- src/server/services/PortfolioReconciliation.ts — broker drift write and missing-local hydration.
- src/server/services/localPortfolioSync.ts — immediate SELL-fill decrement/delete.
- src/server/services/OrderManagement.ts — incremental fill persistence, local sync, P&L attribution.
- src/server/services/PortfolioReconciliation.staleSnapshot.test.ts — existing but narrower stale-snapshot tests.
- src/server/integration/paperSpineInternalPaper.test.ts — one BUY then one SELL integration coverage.
- src/server/services/OrderManagement.restartMidPosition.test.ts — synthetic restart/reconcile coverage.
- src/server/services/ChiefTraderAgent.test.ts — explicit PortfolioManager risk-exit quorum exception.
- src/server/routes/v2Runtime.ts — read-only orders alias over recent trade rows.
- scripts/argus-cli.ts — orders CLI route call.

