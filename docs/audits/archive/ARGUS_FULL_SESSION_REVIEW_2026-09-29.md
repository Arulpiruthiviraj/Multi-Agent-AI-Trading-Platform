# September 29, 2026 — full-session trading review

Analysis performed September 30, 2026. All narrative times are America/New_York (EDT). Read-only production-database investigation; no restart, resume, flag change, broker change or application-code edit. Current source inspected at HEAD `8fec14e`.

## Scope and result

Calendar-day query: September 29 00:00 to September 30 00:00 ET, exclusive end; UTC 2026-09-29T04:00:00Z to 2026-09-30T04:00:00Z. Regular session: 09:30–16:00 ET. `observability_events.ts` uses epoch milliseconds; trading/assessment timestamps use ISO strings. Queries used the appropriate representation for each table.

**No trades, fills or risk assessments were recorded in the date window.** No consensus approvals were recorded. This describes Argus's persisted records, not an independently fetched broker execution statement. Execution P&L cannot be inferred from hypothetical missed-stock gains.

The latest persisted observability record is September 29 23:09:22 ET. The runtime session file reports a last heartbeat at 23:09:13 and `cleanShutdown:false`. The cause of that endpoint was not established. Thus this is a full-date query over retained evidence, not proof of uninterrupted collection until midnight.

## Exact regular-session funnel

- Discovery admissions: 4,297 events, 436 distinct symbols.
- Quant assessments: 3,915 events/rows, 19 symbols; 929 emitted ideas.
- All sources: 10,870 idea events, 22 symbols.
- Idea producers: Kronos 4,936; Macro 2,964; Technical 1,817; QuantEngine 929; JavaCoreEnsemble 203; OpportunityScreener 21.
- Consensus terminal events: 5,517; approvals zero.
- Terminal reasons: CONFIDENCE_BELOW_STRONG 5,444; AGENT_HOLD 37; AGENT_DATA_UNAVAILABLE 33; MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE 3.
- Independent agreeing evidence groups: zero in 70 terminal events; one in 4,115; two in 1,179; three in 153.
- Persisted consensus decision rows: 3,217; approvals zero. These are distinct from terminal-event counts; do not sum or interchange them.
- Maximum terminal confidence: 0.681818. The strong threshold remains 0.75.
- Raw-signal shadow approval: 2,296 comparison events. These are diagnostic alternatives, not approved production ideas, risk approvals or profitable trades.
- Subscription planner promotions: 531 events across 22 symbols; not-promoted events 3,172 across 54 symbols. Promotions are not broker acknowledgments.
- AI_DEBATE_FAIL_CLOSED_EXCLUDED: 1,755 events.
- MARKET_DATA_DISCONNECTED: 93 events, each with reason `socket closed`. Duration and unique outage count were not established; do not describe 93 events as 93 proven prolonged outages.
- Reconciliation: 76 regular-session matches.

The immediate demonstrated stop was consensus, upstream of RiskEngine/OMS. Nothing in this audit justifies weakening those gates.

## Entire date window

- Discovery: 10,821 admissions across 576 symbols; 26,964 filter events across 1,265 symbols.
- Quant assessments: 5,235 events across 27 symbols.
- Ideas: 11,804 events across 23 symbols.
- Consensus terminal events: 6,150, all rejected. Reasons: confidence 5,763; unavailable data 331; HOLD 48; moderate independence 8.
- Consensus decision table: 3,710 rows, all rejected; maximum stored weighted confidence 0.613745. Terminal-event maximum is higher (0.681818); the two record types capture different stages, not contradictory measurements of one row.
- Quant abstention codes: EXPECTED_VALUE_TOO_LOW 2,923; NO_ELIGIBLE_STRATEGY 881; STALE_MARKET_DATA 467; INSUFFICIENT_EVIDENCE 55. Another 6,150 DESK_NO_TRADE events use the consensus reporting shape and lack the quant `code` field; they are not 6,150 missing-code quant defects.
- Alpaca reconciliation: 176 records, all `matches=1`.
- Java bridge outcome events: 1,003,357 total; SUCCESS 983,721; TIMEOUT 13,051; CIRCUIT_OPEN 6,585. These are recorded outcomes, not necessarily one unique user operation each. Endpoint mix, call fan-out, retry amplification and performance effect need measurement before attributing zero trades to them.

## Runtime changed during the day

First main runtime session: 08:28:36–15:34:27 ET. Trading enabled at 08:32:21, with an operator-requested start and Alpaca selected.

Second main runtime session: first events at 15:34:44 ET; persisted daemon start 15:35:00; trading re-enabled at 15:36:12. The state-transition reason says the production build was rebuilt/restarted at the operator's request.

This corrects any assumption that the engine never restarted yesterday. Exact source revision of the running build was not established. Commits `f2f01fa` (16:17 ET) and `dadc3d6` (16:38 ET) were created after the regular close; code can run before commit, so commit times alone do not identify deployed behavior. Persisted event changes provide stronger evidence for individual features.

## What actually improved after the restart

Before the second session, 3,642 regular-session assessments explicitly reported daily-only data for opening-range evaluation. After the restart, 228 regular-session assessments were persisted and none contained that daily-only reason.

Those 228 assessments instead included 218 opening-range RVOL-confirmation failures, 87 directional-regime failures, 61 above-VWAP failures, 81 below-VWAP failures and 17 above-opening-range failures. Multiple reasons can coexist. This is evidence of changed input/assessment behavior; it is not proof that every ORB feature or its time basis is correct. Current source still builds a daily primary context and passes minute bars specifically to opening-range support/resistance. Verify that breakout price, VWAP, volume, stop and target semantics are mutually compatible.

New no-trade reason behavior is also visible: EXPECTED_VALUE_TOO_LOW events belong to the earlier runtime session; NO_ELIGIBLE_STRATEGY appears in the later one. Do not interpret old generic EV labels as thousands of independently measured negative-expectancy trades.

Current source now includes sorted combined discovery candidates, propagated priority scores, symmetric planner scoring, removal of the already-bonused score fallback, and a revised causal integration test. These are no longer accurate open findings in their earlier form. Runtime closure still needs evidence.

## IOVA: request generation improved; evaluation still absent

- First observation: 09:34:05 at $12.95, filtered on recorded IEX dollar volume.
- First admission: 10:05:34 at $13.90.
- Full date: 87 admissions and 97 filter events.
- Seven SUBSCRIPTION_PROMOTED events and seven WATCHLIST_SUBSCRIBE_REQUESTED events appeared at 15:55:50, 15:56:27, 15:57:05, 15:57:41, 15:58:19, 15:59:21 and 15:59:59.
- Their reason was BROAD_UNIVERSE_HOT_SWAP; each request carried priority 7.640062597809081.
- No observed IOVA quant assessment or trade idea in the day window. No intervening persisted symbol-specific subscription outcome resolved why the repeated requests did not produce evaluation.
- A stored latest-trade observation at 15:59:59 was $14.45, approximately 3.96% above first admission and 31.54% above the stored previous close $10.985. The snapshot high was $15.30. These are observed data, not certified official closing prices, fills or realizable returns.

This is a materially more precise failure than the midday report: discovery reached the subscription-request stage late in the session, but the evaluation gap remained.

### Source-supported failure/observability mechanism to investigate first

`MarketDataWorker.ensureWatchlistListener()` passes symbol and score to `subscribe()` but does not pass `requestedBy`. `subscribe()` emits MARKET_DATA_CAPACITY_FULL only when `requestedBy` is present. Thus the production discovery event path can refuse a request with only a console warning and no structured capacity result.

`OpportunityDiscovery` plans against active dynamic symbols and its own priority rule. Actual eviction in `MarketDataWorker.rankEvictionCandidates()` additionally excludes protected symbols, dwell-protected symbols and active temporary rescues. The planner may therefore advertise a replacement that the worker cannot perform. This is a verified difference in eligibility rules, not a proven historical cause for every IOVA request.

During 15:55–16:01 there were 27 temporary-rescue grants across existing symbols and only one recorded eviction (AMD). This is consistent with capacity pressure, but the missing IOVA refusal outcome prevents a definitive attribution. Do not weaken dwell/rescue protection to force admission. Make planning honor canonical eligibility and record the actual outcome.

## Other observed movers

- CCL: 24 admissions, no observed quant assessment or idea. $24.835 at 09:34 versus $25.125 in the 15:50 snapshot: approximately +1.17% after first admission, versus +13.43% from the stored previous close. Most daily gain preceded admission.
- SDEV: 160 filter events; below the configured $5 minimum. A later stored trade observation was $3.05 at 16:30, compared with previous close $1.575. Deliberate price-policy exclusion, not an authorization to trade penny stocks.
- BKYI: 161 filter events under the price policy. The later $3.14 observation at 16:59 remained below its $3.37 open despite exceeding the $1.815 previous close.
- SSTI: 161 DOLLAR_VOLUME filters. Its $8.25 observation at 16:00 exceeded the $5.46 previous close but was below the $8.30 open. IEX coverage limits interpretation of whole-market liquidity.
- AVGO: 15 admissions, 132 not-promoted events; no observed quant assessment or idea. Its later stored price was below its opening price. Missing evaluation is not equivalent to missing a profitable BUY.

## Remaining work, ordered by evidence

1. Reproduce IOVA's repeated-request/no-assessment behavior using canonical full-capacity, dwell/rescue and event-listener paths. Persist definitive accepted/deferred/refused outcomes with request provenance. Make planner eligibility and actual eviction consistent without bypassing protections.
2. Distinguish planner promotion, request, broker acknowledgment, fresh quote and assessment. Record latency and terminal reasons. Bound retries and preserve generation safety through reconnects.
3. Investigate 93 socket-close events and Java bridge timeout/circuit activity with per-session endpoint/latency/queue evidence. Fix verified causes, not by raising timeouts or caps blindly.
4. Validate the entire ORB input contract, not just presence of minute bars. Use Java for new/changed calculations and preserve canonical integration boundaries.
5. Current source abstains from incompatible discovery RVOL; late-session runtime still recorded incompatible ratios. Verify deployment and operator-facing unavailable reasons. Do not conflate discovery RVOL with strategy RVOL without tracing their actual data sources.
6. Continue confidence/horizon/calibration governance work. Current provider-ambiguous calibration lookup remains. Protected formula, threshold and active-authority changes require a separately reviewed proposal. No evidence here makes raw shadow approvals safe trades.
7. Verify revised integration tests and full-suite results against the exact commit/build. Current architecture documentation reports a later full-suite result of 4,597/4,598 tests passing with one catalog-route timeout; isolated rerun passed. This audit did not rerun tests and does not label that full suite green.

No code fixes, deployment, tests, or market-data purchases were performed during this audit. The purpose is a date-scoped diagnosis and a concrete implementation handoff.
