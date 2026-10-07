# October 6, 2026: zero-trade forensic audit

Analysis performed October 7. Times below are America/New_York (EDT).
Read-only evidence from `data/argus.db` and current source. This report does not authorize
position recovery, historical accounting changes, resume, LIVE activation or a gate reduction.
Historical runtime and current source/settings are distinct evidence scopes.

## Direct finding

Zero orders were recorded for October 6 (00:00–24:00 ET). The principal operational blocker
was an unresolved broker short in OKTA. The engine resumed before the open, then reconciliation
paused it before 09:30. Discovery and assessment continued while new entries were blocked.
No consensus decisions or trade-idea/order events were found in the regular-hours funnel.
This was upstream of order execution; it is not evidence that OMS rejected submitted orders.

## Timeline

- 08:22:36: unclean prior-session shutdown detected.
- 08:23:01: runtime session started with `entryRecoveryHold:true`.
- 08:24:07: runtime became RUNNING with effective SAFE_MODE, Autobot enabled and trading paused.
  Reconciliation recorded OKTA `SHORT_POSITION_UNMONITORED`, localQty sentinel 0, remoteQty −14,
  approximate position dollar impact $2,975.48. This is exposure, not a measured loss.
- 08:24:18: `argus-cli start --enable-trading` changed TRADING_PAUSED to TRADING_ENABLED.
- 08:27:58: reconciliation changed TRADING_ENABLED back to TRADING_PAUSED and emitted an emergency halt.
- 09:30–16:00: no recorded state transition back to enabled; 78 reconciliation checks continued
  reporting the short. Of these, 33 also reported ACCOUNT_VALUATION_UNAVAILABLE; 45 reported only
  the short. A working socket/Autobot toggle did not clear the entry gate.
- 16:41:10: a new runtime session started with entryRecoveryHold:false, after the regular close.
  An absent restart hold does not imply TRADING_ENABLED or resolved short exposure.

## Regular-session funnel (09:30–16:00 ET)

- 6,828 discovery admission events, representing 411 distinct symbols. Events are not unique stocks.
- 253 quant assessments across 137 symbols; 118 of the 411 admitted symbols also had an assessment
  in this window (28.7% same-window overlap, not a causal per-admission conversion rate).
- 253 DESK_NO_TRADE records: 217 NO_ELIGIBLE_STRATEGY, 35 IDEA_GENERATION_GATED,
  one INSUFFICIENT_EVIDENCE. These are desk abstentions, not failed consensus rounds.
- Zero recorded consensus decisions and zero order submissions/fills in the event-trace funnel.
- 1,384 subscription evictions. This indicates substantial churn; correlation with poor coverage
  is observable, but its marginal causal contribution has not been measured.
- Of 253 quote-evidence records, 252 contained a positive observed price and positive bid/ask;
  213 had price age at most 60 seconds. That 60-second bucket is descriptive, not a new freshness gate.
  Bid/ask presence alone does not establish their freshness or pass every risk gate.

Full ET calendar day: 2,270 quant assessments and 2,270 desk abstentions, 186 mismatch observations,
4,405 historical-data errors, 51 malformed Java responses, 75 AI-provider exhaustion observations.
Much activity occurred outside regular hours; do not substitute these totals for the session funnel.

## Secondary issues and requested changes

### P0: supervised short recovery and truthful readiness

The short prevented trading before the market opened. Argus's production SELL is CLOSE_LONG,
and its portfolio/reconciliation path does not provide an authorized short-management path.
Do not delete the short, suppress the mismatch or treat a baseline watermark as closing exposure.
Prepare a separately reviewed PAPER recovery/close plan, preserve broker execution evidence, then
require actual broker/ledger reconciliation before an explicit operator resume.
Before accepting an enable request, show the unresolved reconciliation reason and whether entries
can actually generate. Preserve the existing protected state machine and interfaces.

Current October 7 source distinguishes ledger-agreed `UNMANAGED_SHORT_POSITION` from a true quantity
conflict. The latest ledger watermark is −14; the latest saved reconciliation agrees −14/−14 but
still classifies the short as unmanaged. This improves reporting; it does not remove the blocker.
Yesterday's localQty 0 was a sentinel for non-hydration, not proof the broker was flat.

### P1: reduce historical-data work before increasing concurrency

Only two completed quant-cycle observations landed during regular hours. Durations were
7,547,107 ms (125.8 minutes) and 9,635,471 ms (160.6 minutes); each attempted/completed 90 symbols.
They are cycle durations, not per-symbol CPU times; unfinished cycles may span the window.

Source verifies `IbkrSocketSession.requestHistoricalBars` serializes through histChain, and the
duration formula requests at least 30 D even for 1-minute bars. A narrow intraday fetch therefore
requests a much wider interval and later filters the response. Quant symbol concurrency is 1 in
current config. These are credible sources of wasted work, not a complete latency attribution.
Instrument request queue wait, provider response, cache/DB reads, strategy/Java calls and optional AI
separately. Use timeframe-appropriate provider windows, completed-bar cache coverage, coalesced
requests and bounded scheduling. Preserve SDK pacing, quote freshness and authoritative calculations.
Do not simply raise concurrency against the same serial broker queue.

### P1: qualify symbols and isolate diagnostic history

Regular hours recorded 1,856 historical-data errors, all provider code 200, across 77 symbols.
Examples: DIAGTEST (234), DIAGTEST1786368993694 (52), UNKNOWN (67), NONE (47), NULL (25).
These are security-definition/contract failures, not evidence that all quotes lacked entitlements.
Diagnostic-name requests are verified, but no same-window discovery admission/subscription event
for DIAG-prefixed symbols was found. Trace their producer; do not blame discovery without lineage.
Use canonical instrument qualification, quarantine known diagnostic artifacts in the correct scope,
and avoid retrying permanent contract failures every cycle. Preserve the history for forensics.

### P1: expose selection exclusions and strategy-specific data provenance

252 of 253 assessments contained at least one raw trigger, yet no idea emitted. Raw triggers are
not executable trades: strategy focus, adaptive regime routing, quarantine, confidence, EV and the
entry gate still apply. Current source filters by focus/regime/quarantine before bestStrategyIdea.
Persist each excluded strategy's reason and the exact retained candidate, so NO_ELIGIBLE_STRATEGY
can be traced rather than interpreted as 'nothing moved'. Do not arbitrarily widen eligibility.

All 253 assessment records have base timeframe 1Day. That does not prove supplemental intraday
bars were absent: source fetches these when OPENING_RANGE_BREAKOUT is enabled. Record the actual
per-strategy bar timeframe, count, session anchor, age and provenance. Intraday strategies must
fail closed on unavailable intraday inputs. New quant calculations belong in Java.

### P2: bound subscription churn and repair Java response semantics

Measure admitted/requested/acknowledged/fresh/assessed coverage by source, dwell and eviction reason;
retain useful incumbents until challenger evidence justifies replacement within existing capacity.
The 51 full-day malformed Java responses included null unconditionalVariance rejected as a finite
number. Review the Java/TS contract: a null should mean explicit unavailable/unstable computation
when justified, not a fabricated number. Do not accept every null as a healthy calculation.
Provider exhaustion affected optional QuantContradictionAnalyzer observations; no consensus was
reached, so there is no evidence an AI consensus/debate failure was the principal order blocker.

## Current checks and limitations

The October 7 CLI status request timed out after 20 seconds. This is a current responsiveness
problem, not proof the engine was down yesterday. Current saved allocation is $10,000 with a
$3,000 order ceiling, not the requested $2,000; it is not a dated October 6 configuration snapshot.
Do not apply a profile while trading prerequisites are unknown.
No broker order, settings mutation, accounting repair, resume or code deployment was performed.
No profit/loss opportunity estimate or claim of strategy edge follows from this audit.
Retain consensus, independence, freshness, risk, accounting and LIVE_NO_GO safeguards.
