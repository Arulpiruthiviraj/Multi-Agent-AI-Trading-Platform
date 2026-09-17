# ARGUS — Today's Missed-Winner Forensic Reverse-Engineering Audit (2026-09-16)

Read-only investigation against production (`data/argus.db`, opened `{ readonly: true }` throughout).
**No production trade, calibration, configuration, or code change was made.** No restart was
performed. This audit uses only information genuinely available to Argus's own subsystems at each
historical timestamp — external reporting (Reuters/Barron's, ~+5.6–5.7% INTC, SK Hynix partnership
reports) is used only to select the candidate and calibrate expectations, never as a substitute for
what Argus itself actually saw.

## 1. Candidate selected: INTC (Intel)

Chosen because it was independently reported as one of today's notable US movers. Per the mandate's
own instruction, INTC's data availability was verified first, before assuming it was a genuine miss.

## 2. Was INTC genuinely available to Argus?

**No — not on the primary, agent-voting data path.** Direct query of today's production data:

| Check | Result |
|---|---|
| IBKR real-time streaming subscription (`reqMktData`) | **Rejected all session** — 45 `IBKR_MARKET_DATA_ERROR` events, code 354 "Requested market data is not subscribed," first at 10:32 ET, last at 13:56 ET |
| `TechnicalAgent` evaluations | **0** |
| `KronosEngine` evaluations | **0** |
| `QuantEngine` evaluations | **0** |
| `JavaCoreEnsemble` evaluations | **0** |
| `JavaFactorComposite` evaluations (shadow only, Mission Control toggle off) | 10 (all stale, dated 2026-08-28 through 2026-09-08 — not today; this agent does not vote regardless) |
| `OpportunityScreener` evaluations | 0 |
| `NewsEngine` processing | Yes — see §10 |
| `TRADE_IDEA_GENERATED` for INTC | **0** |
| Consensus attempts (`transaction_traces`) for INTC | **0** |
| `ohlcv_bars` (canonical bar storage) for INTC today | **0 rows** |

**INTC never reached a single consensus attempt today.** This is not a rejection anywhere downstream
— it is a complete absence upstream of every real voting agent.

However, INTC was **not entirely invisible**: the broad-universe discovery scanner (a separate,
REST-snapshot-based code path, `MarketUniverseScanner.ts`, independent of the blocked streaming
subscription) polled real INTC prices/volumes throughout the session — see §3.

## MISSED OPPORTUNITY CLASS: DATA / UNIVERSE COVERAGE

- **First blocking stage**: `MarketDataWorker.subscribe('INTC')` → IBKR `reqMktData` → code 354.
- **Timestamp**: first rejection 2026-09-16T14:32:15.617Z (10:32:15 ET); recurring every ~5-7 minutes
  through 13:56 ET.
- **Affected agents**: every primary voting agent that requires live ticks/bars — TechnicalAgent,
  KronosEngine, QuantEngine, JavaCoreEnsemble.
- **Alternative real-time source**: none currently wired into the live agent path (see the same-day
  `ARGUS_SAME_DAY_READINESS_FIX_AUDIT_2026-09-16.md` for why a delayed-data or cross-broker fallback
  was deliberately not hot-patched).
- **Did this prevent Argus from seeing the move?** Yes, on the primary path. Partially, on the
  discovery/scanning path — see below.

Per the mandate's own instruction, a second candidate should now be selected — one with real-time
data, inside the actual evaluated universe, actually processed by Argus. **That search came back
empty**: SPY (today's `sma20` range 754.9–760.8, **0.78%**), QQQ (707.4–711.4, **0.56%**), and GLD
(≈397–399, similarly tight) — the only three symbols with genuine real-time coverage and real agent
evaluation today — all had flat, rangebound sessions with no directional move approaching INTC's
reported size. There is no second "Argus saw it and missed it" candidate to construct today, because
nothing in the properly-covered universe moved enough to be a plausible miss. This is reported
plainly rather than manufactured — see §12 outcome classification.

## 3. Reconstructing INTC's day from what Argus itself actually recorded

`DISCOVERY_CANDIDATE_FILTERED`/`ADMITTED` events (`MarketUniverseScanner`'s broad-universe scan,
REST snapshots, roughly every 15 minutes) are the only real, timestamped INTC price observations
Argus has today. Full sequence (converted to ET):

| Time (ET) | Price | $ Volume | Gap % (vs prior close) | ADV screen result |
|---|---|---|---|---|
| 10:44:04 | **$103.52** | $41.1M | +2.19% | `ADV_BELOW_FLOOR` (advShares 396,921) |
| 10:59:45 | $101.26 | $65.8M | -0.04% | `ADV_DATA_UNAVAILABLE` |
| 11:14:41 | $101.685 | $77.5M | +0.38% | `ADV_DATA_UNAVAILABLE` |
| 11:29:49 | $101.82 | $86.9M | +0.51% | `ADV_DATA_UNAVAILABLE` |
| 11:44:55 | $101.43 | $95.5M | +0.13% | `ADV_DATA_UNAVAILABLE` |
| 11:59:54 | $101.66 | $104.8M | +0.36% | `ADV_DATA_UNAVAILABLE` |
| 12:15:15 | $101.595 | $111.3M | +0.29% | `ADV_DATA_UNAVAILABLE` |
| 12:30:09 | $102.07 | $117.3M | +0.76% | `ADV_DATA_UNAVAILABLE` |
| 12:44:55 | $102.165 | $121.9M | +0.85% | `ADV_DATA_UNAVAILABLE` |
| 12:59:51 | $102.28 | $132.7M | +0.97% | `ADV_DATA_UNAVAILABLE` |
| 13:14:52 | $102.17 | $137.4M | +0.86% | `ADV_DATA_UNAVAILABLE` |
| 13:29:55 | $102.43 | $141.8M | +1.12% | `ADV_DATA_UNAVAILABLE` |
| 13:54:43 | $101.585 | $145.8M | +0.28% | **`ADMITTED`** (advShares recomputed to 1,435,386) |

**The single highest price Argus observed all day, $103.52, was recorded at the very first snapshot
(10:44 ET).** Every subsequent observation for the next ~3 hours is *lower* than that first reading,
oscillating in a narrow $101.26–$102.43 band (≈1.1% range) before the candidate was finally admitted
into the discovery funnel at 13:54 ET — at a price *below* where the scanner first saw it, not a new
high.

## 4. Earliest objectively detectable opportunity

This is the central, non-hindsight finding: **by the earliest moment any Argus subsystem had
visibility into INTC today (10:44 ET), the price was already at its session peak as observed by
Argus.** The reported ~+5.6–5.7% move (per external reporting, presumably measured from a prior
close or premarket reference) had therefore already substantially or entirely completed before
Argus's first documented sight of the stock — this is true independent of the IBKR streaming outage,
because even the (separately-sourced, REST-snapshot) discovery layer's first data point is already
past the peak.

**Caveat, stated honestly**: this audit cannot rule out an even earlier, larger move (premarket or in
the first ~74 minutes of RTH, 9:30–10:44 ET) that no Argus subsystem recorded at all — there is no
Argus-internal data for that window. The claim here is bounded to what Argus's own records show, not
a claim about the absolute intraday high.

## 5–6. Agent behavior and first failure — combined (no per-agent retrospective replay run)

Because zero real ticks/bars ever reached any voting agent for INTC, there is no agent output to
retrospectively replay — `TechnicalAgent`, `KronosEngine`, `QuantEngine`, and `JavaCoreEnsemble` never
executed against INTC today at all (not "executed and produced weak signals" — never executed). The
mandate's Section 5 ("run Argus's actual agents retrospectively") does not apply here in its full
form: there is no historical bar series for INTC in `ohlcv_bars` to replay these agents against
using the real production code, and fabricating one would violate the "use only actually-available
information" and "do not synthesize data" constraints of this same audit.

**Exact first failure classification: `UNIVERSE_EXCLUSION`** (IBKR streaming entitlement, code 354),
compounded by a secondary, independently-real `UNIVERSE_EXCLUSION` factor on the discovery/broad-
universe path — see §7.

## 7. Counterfactual feature analysis — the ADV/liquidity screen

The discovery layer's own ADV (average daily volume) gate rejected INTC once on `ADV_BELOW_FLOOR`
(`advShares: 396,921` vs. the configured floor `broadUniverseMinAvgDailyVolumeShares: 500,000`) and
eleven more times on `ADV_DATA_UNAVAILABLE` (the ADV lookup returned nothing at all), before finally
succeeding with a materially different reading (`advShares: 1,435,386`) on the admitting scan.

**Root cause identified in code** (`MarketUniverseScanner.ts`'s `fetchAvgDailyVolumeShares()`): the
ADV lookup calls Alpaca's daily-bars endpoint with **`feed=iex`** — IEX-only reported volume, which
is a small, variable fraction (commonly low single-digit percent in recent years) of true US-equity
consolidated volume, not total market volume. For a stock like INTC that trades tens of millions of
shares per day across the full consolidated tape, an IEX-only 20-day average landing at ~397K–1.4M
shares is plausible for that specific (narrow) data source — it is not proof of a computation bug
(the math itself — real bars, real averaging, real fail-closed-on-missing-data handling — is sound
and was read directly). What is a genuine, real methodological concern: **using an exchange-specific,
narrow-venue volume figure as a proxy for a "is this stock liquid enough to trade" gate is a
different, weaker signal than true consolidated ADV, and its noisiness (396,921 on one scan vs.
1,435,386 minutes later for the same underlying stock) shows the gate's behavior can be unstable near
the floor** — this instability, not necessarily the specific number, is the real, reportable finding.

**Classification: `SHOULD_RESEARCH`, not `MUST_FIX`.** I could not confirm whether the 500,000-share
floor was deliberately calibrated assuming an IEX-only proxy (in which case this is a known,
accepted trade-off for a free/low-cost data tier) or was intended to approximate true consolidated
liquidity (in which case it is currently miscalibrated for the data source it actually reads).
Switching to a full consolidated (SIP) feed is an infrastructure/cost decision (a paid Alpaca SIP
subscription), not a code-only change — exactly the kind of decision this audit's own instructions
say should not be hot-patched tonight.

## 8. Existing-strategy test

Not applicable in a meaningful way: since no agent ever evaluated INTC, none of the five CORE
strategies (`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`,
`RANGE_REVERSION`) had a chance to fire on it either. The discovery-layer's own `gapMover`/`rvolMover`
tags (computed from the same snapshot data) both read `false` for every INTC observation today
(`gapPct` topped out at +2.19% on the first, already-past-peak reading — below
`gapMoverMinAbsPct`'s 5% bar; `rvol` read exactly `1` throughout, i.e. no relative-volume signal was
ever detected) — meaning even the lightweight, code-cost-free tagging layer never flagged INTC as
notable, consistent with the price action having already normalized by the time Argus was watching.

## 9. Anti-overfitting test

No rule is proposed from this candidate. There is no generalizable "detect this earlier" mechanism to
test, because the structural blocker (no streaming subscription) is not a feature/threshold problem —
no confidence floor, RVOL threshold, or gap threshold would have mattered when zero ticks ever
reached the agents in the first place. The ADV/IEX-feed finding (§7) is flagged for future research,
explicitly not proposed as a change tonight, and would itself need the full out-of-sample/cross-
symbol/regime validation this audit's own rules require before any threshold or data-source change.

## 10. News/event analysis

- `news_clusters` real row for INTC: **"Intel Stock Investors Should Pay Attention to This Potential
  SK Hynix Deal"**, `created_at: 2026-09-16T16:03:14.938Z` (12:03:14 ET), sentiment 0.946, impact 0.5,
  symbols `["INTC","SKHY","TSM"]`.
- The article's own summary text states Intel's **stock rose 4% on the news** — i.e., the article
  itself describes a move that had *already occurred* by the time it was published and ingested.
- Argus's `NewsEngine` processed this cluster at 12:03 ET — roughly **80 minutes after** the earliest
  discovery-layer price observation (10:44 ET) already showed the day's peak price. The news signal
  therefore arrived well after the move it was reporting on, both in the external world and in
  Argus's own ingestion timeline.
- No `news_veto` or gate-14 relevance here (INTC never reached RiskEngine at all), but for the
  record: even a perfectly-functioning news pipeline would have been confirming a move already
  priced in, not front-running it.
- **Conclusion: information latency does not explain a miss here — the structural data-universe gap
  does, and independently, the move itself appears to have preceded Argus's earliest possible
  visibility window regardless of news timing.**

## 11. Hypothetical trade — labeled, not inserted anywhere

**COUNTERFACTUAL RESEARCH TRADE (illustrative only, not a claim this was achievable):** if a
hypothetical BUY had been placed at Argus's *first* INTC observation (10:44 ET, $103.52) — the
earliest point *any* Argus subsystem had data — and held through the session, the position would have
been underwater by the next several observations and only marginally recovered by the final
(13:54 ET, $101.585) reading — a **-1.87% hypothetical result**, not a gain. This is the opposite of
"Argus missed a winner": using only Argus's own first-available data point as an entry, the naive
trade loses money. A trade entered later in the observed range (e.g. near the $101.26 low at
10:59 ET) would show a small hypothetical gain, but selecting that specific point as "the entry" after
already knowing the day's path is exactly the hindsight-fitting this audit's own rules prohibit — it
is not presented as a valid signal-driven entry, only as an illustrative bound. No position-sizing,
stop, or RiskEngine-gate walkthrough was performed, because no real signal ever authorized either
entry — this section is included only to satisfy the mandate's request, explicitly caveated as
non-actionable.

## 12. Recommended changes

**A. MUST FIX**: none identified.

**B. SHOULD RESEARCH**:
1. The ADV liquidity gate's reliance on IEX-only volume (`feed=iex` in `fetchAvgDailyVolumeShares()`)
   as a consolidated-liquidity proxy — determine whether `broadUniverseMinAvgDailyVolumeShares` was
   deliberately calibrated for this narrow data source, and whether its near-floor noisiness (396K vs
   1.4M for the same stock, minutes apart) causes inconsistent admission of genuinely liquid names.
   Any change requires cross-symbol, cross-regime, out-of-sample validation before touching the floor
   or the feed parameter — not proposed for implementation from this single case.
2. The broader IBKR real-time equity market-data entitlement question, already tracked from the
   same-day fix audit — an operator/account decision, not resolved by this pass.

**C. DO NOT CHANGE**: the 0.75 consensus threshold, independence requirements, RiskEngine gates, and
calibration — none of these were ever reached for INTC today, so none of them rejected anything;
there is nothing here to relax, and doing so would not have changed today's outcome regardless.

## 13. Historical validation / out-of-sample / effective-N / transaction costs / overfitting assessment

Not applicable — no rule is being proposed for validation (see §9). Recorded here per the mandate's
own deliverable structure, not omitted silently.

## 14. Production safety — confirmed

Entirely read-only. No production trade, position, calibration row, configuration value, or
RiskEngine threshold was modified. No restart was performed. No synthetic data was used or injected
— every number in this report comes from real `observability_events`/`agent_predictions`/
`news_clusters`/`agent_reasoning_logs` rows, or from source code read directly.

## Final classification

**DATA/UNIVERSE COVERAGE MISS** (INTC) — structurally excluded from every real voting agent by the
IBKR real-time streaming entitlement gap, with a secondary, independently-real discovery-layer
liquidity-screen factor (IEX-only ADV proxy) also contributing to its exclusion from the broader
funnel. Additionally and importantly: **NO ACTIONABLE MISS — HINDSIGHT ONLY**, layered on top of the
coverage finding — Argus's own earliest observation of INTC already shows the stock at its session
peak, and the properly-data-covered universe (SPY/QQQ/GLD) had no comparable move today at all. Fixing
the data-coverage gap would not retroactively have produced a winning trade on this specific case; it
would only restore the *opportunity to evaluate* names like INTC in the future, which is a
data-completeness argument, not an alpha-improvement argument, and should be decided on that basis.
