# Argus midday zero-trade and missed-mover audit — September 29, 2026

This is a dated, read-only forensic snapshot, not a readiness certificate or an architecture change. Market and database evidence stops at **12:56 EDT (16:56 UTC), exclusive**. The regular-session window is 09:30–12:56 EDT; the date window starts at midnight EDT (04:00 UTC). Runtime health was separately checked at 12:56:51 EDT. This is not a full-day result.

## Direct answer

**No trades, fills, or risk assessments were recorded today before the cutoff.** Argus was enabled and receiving market data. The immediate blocker was upstream of RiskEngine and execution: no observed consensus round approved an idea. Separately, broad discovery found rising stocks that never reached streaming subscription and quantitative evaluation. IOVA is the clearest traced example.

This does not establish that buying those stocks would have produced executable profit. It establishes missing evaluation coverage, with timestamped market observations that make the gap worth fixing.

## Evidence and method

- Queried `data/argus.db` using a read-only SQLite connection, without importing application initialization or running migrations.
- Used persisted discovery, subscription, idea, quant-assessment, consensus-terminal, comparison, reconciliation and state-transition evidence. Distinguished event counts from unique symbols and decision records.
- Checked authenticated runtime readiness and pipeline-agent endpoints; reviewed source and configuration against observed behavior.
- Existing uncommitted broker, market-data, CLI and order-management work was preserved. No code, flags, accounts, trading state, broker selection or running processes were changed for this audit. Tests were not run: this was investigation, not implementation.
- An independent [StockTitan movers board](https://www.stocktitan.net/rankings/stock-movers-today/premarket), displaying September 29 at 12:10:11 ET when inspected, corroborated several movers. Its signed-out data can be delayed. The detailed prices below are Argus's own stored observations, at their specified times, rather than that earlier board.

## Runtime was enabled; yesterday's hold is not today's explanation

At 08:32:21 EDT the persisted state transition changed EMERGENCY_STOP to TRADING_ENABLED, with an operator-requested start and Alpaca selected. At the runtime check:

- Trading state was TRADING_ENABLED, autobot was on, entry generation was enabled, and the interrupted-session hold was false.
- The active broker was **Alpaca**, reported healthy; all **12 active symbols** had valid fresh quotes.
- Forty RECONCILIATION_MATCH events occurred during the regular-session window.
- Two of ten AI providers were healthy: Ollama and NVIDIA. Other providers reported quota, rate-limit, suspended or unavailable conditions.

The current evidence does not support attributing today's zero trades to an IBKR entitlement issue, a paused engine, missing crypto tables, or a global absence of prices. Freshness for 12 subscribed symbols does not prove coverage for the hundreds of other discoveries. Runtime `tradingReady` is a liveness/readiness diagnostic, not proof of profitable strategies.

## Regular-session funnel: 09:30–12:56 EDT

- Discovery: **1,849 admission events across 360 symbols**. Admission means passed this discovery stage, not approved to trade.
- Quantitative evaluation: **2,072 assessment events across 18 symbols**, with **474 emitted ideas**.
- All idea sources: **5,751 events across 21 symbols** — Kronos 2,610; Macro 1,558; Technical 982; QuantEngine 474; JavaCoreEnsemble 107; OpportunityScreener 20.
- Sides: 1,734 BUY, 2,459 SELL, and 1,558 HOLD. All observed Macro ideas were HOLD.
- Consensus: **3,006 terminal events, zero approvals**. Separately, the decision table contained **1,770 rows, zero approved**. These are different record types; terminal events are not unique orders or necessarily unique proposals.
- Terminal reasons: **2,986 CONFIDENCE_BELOW_STRONG**, 13 AGENT_DATA_UNAVAILABLE, 5 AGENT_HOLD, and 2 MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE.
- Risk assessments, trades and fills: **zero**, also confirmed over the entire date window.

For the entire date window, there were 5,985 idea events, 3,139 consensus terminal events and 1,853 decision rows, again with no approvals. The maximum observed terminal confidence was **0.681818**, below the configured **0.75** strong threshold. This makes consensus the demonstrated immediate stop, not an inferred OMS failure.

## Why ideas failed consensus

`src/server/services/ChiefTraderAgent.ts:734` maps raw confidence into stored agent/bucket calibration when available. A high raw signal does not retain that number as its decision confidence.

One persisted IWM example at 12:55:59 EDT had Kronos SELL raw confidence 0.85 calibrated to approximately 0.472119, while Technical proposed BUY with raw confidence approximately 0.601 calibrated to approximately 0.440014. Macro held. Opposing ideas plus their calibrated evidence yielded final confidence approximately 0.140506; it was not a strong agreeing coalition.

The highest observed round was ARM at 10:47:31 EDT, confidence 0.681818. The supporting screener calibration had only one sample and there was only one independent evidence group. It is not evidence of a safely executable trade narrowly missed by an arbitrary cutoff.

During regular hours, terminal events recorded one independent evidence group 2,246 times, two groups 680 times, three groups 62 times, and zero groups 18 times. Multiple agents do not automatically mean multiple independent agreeing sources. A premarket AAPL example grouped QuantEngine and JavaCoreEnsemble under the same CORE_QUANT_ENSEMBLE evidence group.

The existing `CONSENSUS_MODEL_COMPARISON` diagnostic is revealing: across 3,006 comparison events, legacy approval and calibrated shadow approval were both zero, while **raw-signal shadow approval was true 1,239 times**. See `ChiefTraderAgent.ts:1148`. These are shadow-model results, not approved real trades or completed risk checks. They support investigating calibration and confidence semantics; they do **not** justify replacing calibrated evidence with attractive raw scores or lowering the threshold.

AI availability is a contributing limitation: the window included 909 AI_DEBATE_FAIL_CLOSED_EXCLUDED and 39 AI_PROVIDERS_EXHAUSTED events. However, quantitative ideas still arrived and the terminal reasons above remain the authoritative observed outcomes. Provider failures alone do not explain every rejected round.

## Concrete coverage defect: discovery is disconnected from full-capacity rotation

The configured stream limit is 12. The configuration documents a prior larger allocation causing Alpaca symbol-limit disconnects, so increasing the cap blindly is not a repair.

`src/server/continuous/SnapshotScanner.ts:223` builds the momentum scan universe from configured seed, watch, campaign and momentum lists. Newly admitted broad-universe movers do not automatically enter that set.

`src/server/continuous/OpportunityDiscovery.ts:311` onward uses those momentum candidates for replacement planning. The later broad/mover shortlist top-up at lines 372–397 only has capacity when empty slots exist: at full occupancy, `capForCycle` is zero. Consequently, a newly discovered stock outside the static rotation universe can be repeatedly admitted and still never compete for an occupied slot.

There were **1,499 SUBSCRIPTION_NOT_PROMOTED events** during regular hours with the hot-swap-cap-one reason. That counter concerns candidates actually considered by the planner; it does not capture every broad-universe stock excluded before that planner. Likewise, a PROMOTED planner event is not proof of broker acknowledgment or fresh ticks.

### IOVA: detected, admitted, never evaluated

- First stored observation: 09:34:05 EDT, $12.95; filtered because recorded IEX dollar volume was approximately $0.989 million, below $5 million.
- First admission: **10:05:34 EDT at $13.90**, recorded dollar volume approximately $5.739 million, spread approximately 7.20 basis points.
- There were **43 admission events** through the cutoff, but no observed streaming promotion, quant assessment, trade idea or candidate-ranking row for IOVA in the investigated date window.
- Last stored discovery snapshot: **12:51:59 EDT**, latest trade approximately two seconds earlier, **$14.76**. The stored open was $12.78 and previous close $10.985.
- That is approximately **34.37% above the previous close**, **15.49% above the open**, and **6.19% above the first admission price**.

The 6.19% is a hindsight change between observed prices, not a simulated fill or net return. Nevertheless, Argus had a real, eligible discovery for almost three hours and produced no strategy evaluation for it. The source-level routing gap explains how that can happen. Discovery did not entirely fail; its handoff did.

### Other movers show why one explanation does not fit all stocks

- **CCL:** admitted at 09:34:05 EDT around $24.835; 12 admissions, no observed idea or quant assessment. A 12:46 snapshot was $24.875, about 12.30% above its $22.15 previous close, but only 0.16% above first admission. Most of the displayed daily gain was already present when discovered.
- **SDEV:** 39 PRICE-filter events. A 12:51 snapshot was $3.62 versus previous close $1.575 and open $1.64, approximately +129.84% and +120.73%. Argus found it but deliberately excluded it under the configured $5 minimum. That policy exclusion is not proof the filter malfunctioned.
- **BKYI:** 40 PRICE-filter events. Latest stored price $2.79 versus previous close $1.815 looked strong at +53.72%, yet it was approximately **17.21% below** the $3.37 open. A daily-gainer leaderboard is not an intraday buy signal; observed spread quality was also poor.
- **SSTI:** 40 DOLLAR_VOLUME filters. Latest stored price $8.215 versus previous close $5.46 was approximately +50.46%, but approximately 1.02% below the $8.30 open. Recorded IEX dollar volume was only about $0.682 million. The feed-scope issue below matters when interpreting that liquidity decision.
- **SMMT:** 10 admissions, no observed quant assessment or idea. Latest stored $16.32 was below its $18.865 open despite remaining above the $15.49 previous close. Again, finding a positive daily percentage would not by itself have identified a profitable entry.
- **AVGO:** eight admissions and 97 hot-swap-cap refusal events in the date window, with no observed quant assessment or idea. Unlike IOVA, it was in the configured momentum universe, but repeatedly lost access at subscription selection.

These counts are date-window case traces, not all restricted to the regular-session aggregate window above.

## Data-quality and strategy-input problems

### Volume provenance is inconsistent

`src/server/continuous/MarketUniverseScanner.ts:173` explicitly requests Alpaca snapshots with `feed=iex`. The liquidity filter uses price multiplied by that snapshot's daily volume. That measures observed IEX activity, not consolidated whole-market volume.

The historical ADV request at line 363 uses `feed=sip`, with an alternative historical provider fallback. `computeRvol` at line 235 divides the IEX snapshot volume by that historical ADV without aligning feed scope. Partial-session volume divided by full-day ADV is also not time-of-day-adjusted relative volume.

Verified defect: mismatched volume definitions can distort ranking and relative-volume interpretation. Verified limitation: a whole-market liquidity interpretation is not supported by IEX-only dollar volume. The exact number of candidates that would pass using an authorized consolidated feed was **not** measured; do not invent it. Consolidated subscription availability and licensing must be verified separately.

### Intraday strategy receives daily bars

`src/server/services/QuantSignalAgent.ts:73` sets `TIMEFRAME = '1Day'`. **2,027 of 2,072 regular-session assessments** explicitly recorded that the opening-range strategy could not run because only daily-granularity bars were available. An intraday discovery objective needs eligible intraday input data; a daily bar cannot describe the opening range faithfully.

There were 1,553 quant DESK_NO_TRADE events labeled EXPECTED_VALUE_TOO_LOW and 45 labeled INSUFFICIENT_EVIDENCE. The first label is broader than its wording: `QuantSignalAgent.ts` around lines 515–553 also uses it for missing qualifying strategy, insufficient outcome evidence and risk/reward failures. It is **not** proof that 1,553 independently measured trade expectations were negative. The reason reporting needs more precise subcodes.

## Recommended remediation order

1. **Repair discovery-to-evaluation coverage.** Extend the existing shortlist and rotation path so eligible broad discoveries can compete for bounded replacement slots even when all slots are occupied. Preserve protected holdings, anchors, provider limits, pacing, freshness, score-edge rules and the single protected trading spine. Test full-capacity admission, starvation, reconnect generations and real subscription acknowledgment. Do not introduce a second order path.
2. **Make every handoff measurable.** Persist a per-symbol trail from discovery through shortlist/rank, subscription requested/acknowledged/fresh, bars sufficient, quant assessed, idea emitted, consensus result and risk result. An admitted stock never evaluated should have an explicit reason and age. Track coverage and latency, not just total discovery events.
3. **Correct volume provenance.** Carry feed, venue scope, timestamp and session coverage with liquidity/volume features; compare compatible numerator and denominator data. Keep unavailable evidence explicit. If new or changed relative-volume calculations are needed, implement them in Java under the engine-ownership contract. Do not silently relax the existing filter or invent consolidated volume.
4. **Supply appropriate intraday bars through canonical providers.** Verify minute-bar availability, timestamps, regular-session boundaries, freshness and sufficient warmup for opening-range and other intraday strategies. Fix Java calculation paths if needed; TypeScript remains orchestration. Test no-lookahead behavior and fail-closed handling for missing bars.
5. **Audit confidence calibration before changing decisions.** Verify labels, forecast horizon, sample independence, out-of-sample calibration, strategy/regime relevance and bucket semantics against the actual decision objective. Investigate the raw-versus-calibrated shadow discrepancy. Preserve the 0.75 threshold and independence controls; raw scores are not demonstrated probabilities or alpha.
6. **Improve no-trade reason precision and provider diagnostics.** Separate missing expectancy evidence, adverse expectancy, insufficient reward/risk, absent strategy and provider unavailability. Preserve abstentions instead of replacing them with invented votes.
7. **Validate repaired coverage in isolated replay and supervised paper.** Show that IOVA-like eligible discoveries actually reach evaluation under full capacity, then measure organic outcomes, costs and drawdowns. More evaluations and trades are not proof of better returns. LIVE_NO_GO remains unchanged.

Any implementation must first reconcile the concurrent workspace changes and the applicable architecture contract. This report requests no automatic resume, flag activation, subscription purchase, lowered gate or live trade.

## Limits

This audit ends at midday; it makes no claim about later trades or closing prices. It did not run counterfactual strategy executions, prove buy/sell fills for missed movers, measure whole-market liquidity, establish causal contribution for every provider failure, or certify trading edge. Persisted evidence supports the immediate consensus stop and the identified coverage/data-input defects. It does not support a guaranteed daily profit target.
