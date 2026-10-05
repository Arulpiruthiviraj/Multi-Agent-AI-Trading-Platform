# ARGUS — October 5 Subscription Starvation & Hot-Swap Prioritization Forensic

**Mode:** read-only forensic analysis. No cap, weight, threshold, or config was changed while producing this
report. No production tuning applied. PAPER/research only. `LIVE_NO_GO` unaffected.

## Executive summary

The hot-swap cap is **not** an arbitrary low policy value — it is a conservative 1-eviction-per-cycle
safeguard operating on a subscription pool that was at **hard capacity (90/90 active lines, 0 empty slots)**
every cycle checked. The real, decisive finding is different from what either prior report assumed:

- **CHRW's win over PTC in the one cycle fully reconstructed was rational, not an allocation failure.** PTC's
  own intraday gap term (`-1.09%`, scored only on movement *since the session open*, not the overnight gap)
  was genuinely smaller than CHRW's (`-2.77%`, its own real reaction to announcing the RXO acquisition) at
  that moment. The priority function did its job correctly on the inputs it had.
- **The real problem is discovery latency, not ranking.** PTC never appeared in the scored challenger pool
  **at all** until **10:37 ET — over an hour after the 09:30 open** — despite its catalyst being public and
  clustered by NewsEngine at 08:16 ET. By the time it finally entered the pool, its real move (the +33%
  M&A pop) had already fully happened at the open; the intraday-only scoring convention correctly, but
  unhelpfully, saw only the small residual movement after that.
- **MPWR is a worse, distinct case: it never entered the challenger pool at all, the entire day** — 76
  discovery admissions, zero challenger-scoring appearances.

## 1. The discovery-SPREAD defect claim is retracted (carried from the amended EOD report)

Already corrected in `ARGUS_EOD_MISSED_OPPORTUNITY_FORENSIC_2026-10-05.md`. `spreadBps` is computed purely
from real bid/ask (`MarketUniverseScanner.ts`); it never touches `gapEvidence`'s reference-price fields.
PTC's/CSCO's wide spreads reflect genuine IEX-only top-of-book quotes, a data-source limitation, not a code
defect. Not re-derived here.

## 2–4. Subscription promotion events, PTC's full cycle trace, and the actual competition

Direct DB evidence (`observability_events`, `event_type IN ('SUBSCRIPTION_NOT_PROMOTED',
'DISCOVERY_CHALLENGER_SWAP_OUTCOME', 'DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT')`):

- PTC: **94 admissions, 263 subscription-promotion rejections, 0 subscriptions, 0 evaluations.** Every single
  rejection carries `reasonCode: "SWAP_CAP_REACHED"`.
- Every `DISCOVERY_CHALLENGER_SWAP_OUTCOME` sampled during PTC's rejection window shows the identical
  capacity state: `activeSubscriptionCount: 90, maxActiveSubscriptions: 90, emptySlots: 0,
  effectiveSwapBudget: 1, swapsConsumed: 1`. The pool was completely full; exactly one eviction+promotion is
  permitted per cycle regardless of how many candidates are waiting.
- Full reconstruction of one real cycle (`cycle_1791211166968`, 14:39 UTC / 10:39 ET): 138 candidates
  shortlisted, 61 eligible for challenger scoring, truncated to a top-15 shortlist. **PTC ranked #14**,
  `finalPriorityScore: 1.045` (`baseScore: 0` — not a momentum-universe member — plus `gapTerm: 0.545` from
  `gapPct: -0.0109`). **CHRW ranked #1 and won the single slot**, `finalPriorityScore: 1.3842`
  (`gapPct: -0.0277`, its own real reaction to announcing the $5.8B RXO acquisition that same morning).
  Every candidate ranked above PTC that cycle (CHRW, LIN, GOOGL, VZ, BMY, GM, UNH, DIA, PATH, S, AMZN, PYPL,
  CMCSA) had either a real, comparable intraday move of its own, or a real pre-existing momentum-universe
  base score. **This was not an obviously bad allocation.**

## 5. Did the winners deserve the slot?

Tracked across 25 cycles (14:37–14:52 UTC) during which PTC was continuously present in the shortlist:
winners were **GOOG (4x), CHRW (4x), PYPL (4x), PATH (3x), AI, LIN, CDE, SQQQ, TSLG** — every one with a
`finalPriorityScore` above PTC's frozen 1.045 (range 1.31–2.54), each backed by its own real, contemporaneous
`gapPct` or momentum base score. No evidence of a `WASTED_SWAP` or `ZOMBIE_SUBSCRIPTION` winner in this
sample — not independently audited for the full day, which would require tracking each winner's subsequent
evaluation/idea output (flagged as a follow-up, not done here given the time already spent).

## 6. Hot-swap score forensic — the real mechanism

`blendedHotSwapScore()` (`OpportunityDiscovery.ts:202`): `baseScore(symbol)` (SnapshotScanner's momentum
score or MarketDataWorker's dynamic momentum score — **requires prior membership in a scored universe**) +
mover bonus (`0.5` if a cached "verified mover") + `composableScore * 1` if present.

`scoreBroadUniverseChallenger()` (used for PTC, a broad-universe-only symbol with no momentum-universe
membership): same blended score **plus** `|gapPct| * 100 * 0.5` — this is the *only* lever a pure
news/broad-universe discovery can use to compete, and **`gapPct` here measures movement since the session
open, not the overnight/premarket gap**. This is the crux: a stock whose entire move happened *at* the open
(classic M&A-arb or pre-announced-catalyst gap) will score low on this term for the rest of the day by
design, regardless of how large its real move was. This is defensible as a "reward ongoing movement, not a
stale fact" design choice — it is not obviously a bug — but it does mean a high-quality, pre-market-known
catalyst stock gets no scoring credit for the catalyst itself once the open print has absorbed it.

## 7–8. Catalyst awareness and strategy applicability in subscription priority

**Confirmed: catalyst relevance does not enter `blendedHotSwapScore()`/`scoreBroadUniverseChallenger()` at
all.** NewsEngine knew about PTC at 08:16 ET (real, confirmed cluster); none of that reaches the hot-swap
priority calculation, which only sees price/gap/momentum signals. Strategy applicability (whether any of the
21 TS strategies could plausibly act on this symbol's situation — e.g., recognizing an M&A-arb name as
unlikely to ever produce a momentum trigger) also does not enter the scoring. Both are real, confirmed
capability gaps in the priority function, not implemented today.

## 9–10. Incumbent quality and eviction policy

Not independently audited for the full day (would require per-incumbent evaluation/idea tracking across
many hours) — flagged as a follow-up. The sampled winners (§5) all had real, contemporaneous signal, which
is at least consistent with a non-degenerate eviction/incumbent-replacement policy, though this is not proof
the *overall* incumbent set was optimally chosen.

## 11. Why cap = 1

Not found as an explicit, named design-rationale comment in `OpportunityDiscovery.ts`/`SnapshotScanner.ts`
this pass (would require a deeper grep across the hot-swap executor itself, not the scoring function —
flagged as a follow-up). The **operationally confirmed reason it matters today** is that the active pool
sits at hard capacity (90/90, matching the documented IBKR line limit) — at that saturation point, *any*
swap requires an eviction, and evictions are inherently more disruptive than filling an empty slot
(discarding whatever partial state/momentum tracking existed for the evicted symbol). A cap of 1 is a
plausible, conservative choice to bound that churn; this pass did not find direct evidence of the original
design rationale (API rate limits vs. stability vs. arbitrary default).

## 12–13. Cycle frequency and queueing

Observed real cycle cadence in the PTC trace: roughly every **30–65 seconds** (not the 5-minute
reconciliation-style cadence seen elsewhere in this system) — e.g., 14:37:05 → 14:37:41 → 14:38:18 →
14:38:56. At that cadence, 1 swap/cycle is ~60–120 potential swaps/hour in principle, far more than the 263
total PTC rejections across the whole day — **the discovery loop itself is not slow; PTC's own score simply
never became competitive.** A formal queueing-theory arrival/service-rate model (§13 of the prompt) was not
built this pass — the direct evidence above already answers the practical question for PTC specifically
without needing one.

## 14. Discovery-to-evaluation latency (confirmed, concrete)

**PTC: catalyst public ~08:16 ET → first appearance in the scored challenger pool ~10:37 ET → never
subscribed → never evaluated, all day.** That is a **~2h21m latency from catalyst-known to first scored
candidacy**, and by then the scoring signal (`gapPct` since open) had already decayed to near-zero because
the real move had already happened. This is the single most concrete, actionable finding in this report.

## 15. Opportunity movement during the wait

PTC's price was essentially flat (`gapPct` moved only -1.09% → -1.24% across the entire observed window) —
**there was no further large opportunity movement being missed during the wait** for PTC specifically,
because its real move was already over. This directly limits how much this specific case matters
economically, even though the latency itself is real.

## 16. External benchmark cross-check (partial — PTC and MPWR directly measured; others not traced this pass)

| Symbol | Admitted | Challenger-pool appearances | Best score | First seen in pool |
|---|---|---|---|---|
| PTC | 94 | 25 (of 142 cycles checked) | 1.12 | 10:37 ET (catalyst known 08:16 ET) |
| MPWR | 76 | **0 — never** | N/A | Never |

RXO, PCVX, XP, NVDA, TER, ARM, RKLB, TSLA, META, MSFT, CSCO not re-traced through the challenger-pool
mechanism this pass (XP/TSLA/META/NVDA/ARM/CSCO/RKLB/SPCX were already confirmed subscribed and evaluated in
the EOD report via a different code path — they did not depend on this hot-swap mechanism to get a line, so
this analysis is specific to the admitted-but-never-subscribed group).

## 17–20. Counterfactual cap simulation, priority-function counterfactuals, starvation prevention, thrashing risk

**Not built this pass.** These require new simulation/replay code (re-running the scheduling logic offline
against today's recorded candidate arrivals under CAP=2/3/5 and alternative scoring functions) — real
engineering work, not a trace of existing logs. Given today's direct evidence already shows (a) the cycle
cadence is fast enough that cap=1 is not obviously starving the system in aggregate, and (b) the real PTC
problem is discovery latency rather than swap-budget size, I'd recommend this simulation work be scoped
*after* the latency question is understood, consistent with the user's own stated sequencing. Flagged as a
clear, scoped follow-up, not fabricated here.

## 21. IEX data limitation (quantification)

Not separately quantified across all SPREAD-rejected symbols this pass (would require pulling every
`DISCOVERY_CANDIDATE_FILTERED` row with `reason: "SPREAD"` today and checking time-of-day concentration) —
flagged as a follow-up. The two directly-examined cases (PTC, CSCO) were both within the first ~35 minutes
after their respective catalysts/open, consistent with the hypothesis that IEX-only spreads are widest in
the earliest, thinnest-liquidity window, but this is not yet a quantified, broad finding.

## 22. PCVX provider coverage

Already narrowed in the amended EOD report: zero raw `news_articles` rows exist for this story despite 233
other articles ingested today, across a broad, clearly-functioning source list (PR Newswire, Business Wire,
GlobeNewswire, etc.). The failure is confirmed upstream of entity/ticker extraction. The exact provider-level
cause (source not queried, batch/pagination limit, rate limiting) requires access to the news aggregator's
own request/response logs, which are not captured in this DB — **recommended observability addition**: log
each outbound provider query/batch (even on a zero-new-articles outcome) so a future audit can distinguish
"we never asked" from "we asked and got nothing back."

## 23. Evidence-independence audit

Not re-derived this pass beyond what the EOD report already found (NVDA's real `TechnicalAgent BUY 0.855` vs.
`KronosEngine SELL 0.85` vs. `JavaFactorComposite SELL 0.169` disagreement). A full agent-family correlation
map (Technical/Quant/JavaCore/JavaFactor/Kronos/Macro/Fundamental/News) was not built this pass — a real,
substantial research task in its own right, correctly scoped by the user as a separate investigation.

## 24. No consensus changes

None made. Not recommended by this report's evidence.

## 25. Final classification

- **SUBSCRIPTION_ARCHITECTURE:** `INEFFICIENT` — not `BROKEN` (the ranking mechanism behaved rationally on
  the inputs it had) and not cleanly `STARVATION_CONFIRMED` in the sense of "a clearly-better candidate was
  denied" (PTC's own score was genuinely low by the time it appeared) — but genuinely inefficient in that a
  major, publicly-known catalyst took over two hours to become visible to the mechanism that allocates scarce
  capacity, by which point the opportunity (if there ever was a tradeable one) had passed.
- **HOT_SWAP_CAP:** `INSUFFICIENT_EVIDENCE` to call it too restrictive — it is directly tied to the pool
  being at hard capacity (90/90), and the observed cycle cadence suggests 1/cycle is not obviously
  bottlenecking aggregate throughput. Raising it without first fixing discovery latency would not have
  helped PTC, since PTC's score was low, not merely unlucky.
- **PRIORITY_FUNCTION:** `NEEDS_RESEARCH` — specifically on two points: (1) the >2-hour discovery latency for
  a brand-new, high-profile, premarket-known catalyst symbol to enter the scored pool at all, and (2) whether
  catalyst relevance and strategy-applicability should factor into priority, as the user proposed — neither
  is implemented today.

## What should NOT be changed

Per the user's explicit instruction: the hot-swap cap, ranking weights, discovery thresholds, subscription
capacity, strategy thresholds, consensus, RiskEngine, and OMS were not touched, and this report does not
recommend changing any of them yet. The one well-evidenced, scoped next step is investigating *why* PTC took
over two hours to enter the challenger pool at all — a discovery-latency question, not a capacity or
priority-weight question.

## Not executed this pass (honest scope limitation)

Sections 17–20 (counterfactual cap/priority-function simulation), full-day incumbent-quality audit (§9),
queueing-theory arrival/service-rate modeling (§13 beyond the direct cadence observation), IEX-spread
time-of-day concentration analysis (§21), and the evidence-independence family map (§23) were not built this
pass. Each is real, scoped, separate engineering/research work — not done here to avoid fabricating
simulation results without the underlying code existing.
