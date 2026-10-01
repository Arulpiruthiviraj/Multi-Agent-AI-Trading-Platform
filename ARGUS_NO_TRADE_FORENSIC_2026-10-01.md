# Argus — No-Trade Forensic, 2026-10-01

**NO TRADE OCCURRED BECAUSE: ChiefTrader's weighted consensus confidence never once reached the 0.75
approval threshold across 5,881 real consensus rounds in the measured 2-hour window — the maximum
confidence observed was 0.700, with a median of 0.451 — driven primarily by genuine, measurable
directional disagreement between the two most prolific evidence producers (TechnicalAgent heavily
BUY-skewed, KronosEngine heavily SELL-skewed), not by a code defect, a data-freshness problem, or an
independent-evidence-count shortfall (zero rounds failed on independence specifically).**

A secondary, real, measured bottleneck also exists: of 453 distinct discovery candidates admitted in
the window, only ~128 ever received a market-data subscription slot (IBKR's 90-line cap under real
contention), meaning roughly 325 admitted candidates were never evaluated at all. A targeted cross-check
against real gap/relative-volume mover flags found this capacity constraint's practical cost was small
— only 2 named symbols (SMTC, KD) that were genuinely flagged as movers were among the unevaluated set;
the bulk of what missed a slot was correctly lower-priority or outright illiquid/penny-stock material
that the liquidity screen would have rejected anyway.

**No code defect was reproduced that meets the "proven root cause, safe to fix" bar this investigation
required. No fix was implemented.** Everything found is either correct, conservative system behavior
(exactly what was asked to be preserved) or a real-but-architectural capacity/coverage limit that is an
operator decision, not a bug — both are reported honestly below rather than forced into a "fix."

---

## 1. Methodology and window

- **Window measured:** approximately the trailing 2 hours of real `observability_events`/`candidate_rankings`
  activity up to the time of this investigation (2026-10-01, ~16:20–18:20 UTC).
- **Important confound, disclosed upfront:** partway through this window, the operator requested a
  rebuild + restart of the engine (to deploy the day's accumulated defect fixes). The engine that was
  running for most of this window is **not the same continuous process** for its entire span — there was
  a brief (~90 second) gap around the restart. All DB-level counts below span both the pre-restart and
  post-restart instance, since the database itself is continuous; only in-memory state (per-symbol
  cooldowns, dwell timers, consecutive-failure counters) reset at the restart. This is noted because a
  mid-window restart is itself a minor confound on any "throughput" interpretation, though it does not
  change any of the structural findings below (confidence ceiling, subscription capacity, agent toggles).
- All findings are from direct, read-only queries against the live `data/argus.db` (never a destructive
  operation) and one live pipeline-agent status check via the authenticated API. No agent was asked to
  "guess" — every number below is a real count or a real distinct-value computation.

---

## 2. IBKR real-time data status (Section 1 of the request)

**Confirmed genuinely LIVE, not delayed, for the full window.**

- **532 of 532** `IBKR_MARKET_DATA_SUBSCRIPTION_ACKNOWLEDGED` events in the window carried
  `marketDataType: 1` (IBKR's own code for real-time/live data). **Zero** were `2` (FROZEN), `3`
  (DELAYED), or `4` (DELAYED_FROZEN).
- Explicitly verified for all 5 required benchmark symbols — each shows a real, recent
  `marketDataType: 1` acknowledgment in the window:
  - AAPL: tickerId 35, generation 2
  - MSFT: tickerId 36, generation 2
  - NVDA: tickerId 34, generation 2
  - SPY: tickerId 31, generation 2
  - QQQ: tickerId 32, generation 2
- Stale-quote incidence was small and real: 59 `DESK_NO_TRADE` events in the window carried
  `code: STALE_MARKET_DATA` (about 0.76% of all no-trade events), with observed staleness ages from
  386s to 702s against a 300s threshold — genuine, occasional gaps, not a systemic freshness failure.

**Conclusion: IBKR real-time data is genuinely active in the production pipeline for this window.** The
market-data provenance fix from earlier today is holding. This rules out "the feed is actually still
delayed" as an explanation for zero trades.

---

## 3. Full 2-hour funnel (Section 2 of the request)

```text
DISCOVERED (admitted)        1,806 events  /  453 distinct symbols
  → FILTERED (rejected)      4,025 events  /  713 distinct symbols  (liquidity/price/spread/ADV screen)
  → SUBSCRIBED                3,942 outcome events / ~128 distinct symbols ever held a slot
      (capacity churn: 3,069 temporary-rescue grants, 57 denials, 488 slot evictions —
       consistent with real rotation through a 90-line cap under real contention)
  → QUANTITATIVELY EVALUATED  2,774 QUANT_ASSESSMENT_COMPLETED / 96 distinct symbols
                                 809 QUANT_EVIDENCE_PRODUCED / 91 distinct symbols
  → DIRECTIONAL IDEAS         9,621 TRADE_IDEA_GENERATED / 117 distinct symbols
  → CONSENSUS ROUNDS          5,881 started, 5,881 completed (1:1 — no stuck/hung rounds)
  → APPROVED                  0
  → RISK ASSESSED              0  (RiskEngine was never invoked — correct consequence of 0 approvals)
  → SIZED                      0
  → ORDER SUBMITTED             0
  → FILLED                      0
```

**First stage where volume structurally collapses to zero: CONSENSUS → APPROVED.** Every stage before
that has real, substantial throughput. Every stage after that is correctly empty as a direct
consequence (RiskEngine/PositionSizing/OMS cannot act on an idea that was never approved — this is the
protected spine working exactly as designed, not evidence of a problem in those systems).

**Secondary volume drop, real but smaller in practical impact:** DISCOVERED (453 distinct) →
SUBSCRIBED (~128 distinct) is a large raw percentage drop, but see §6 for why its practical cost on
genuine opportunities appears limited.

---

## 4. Consensus analysis (Section 3 of the request)

- **5,881 consensus rounds completed in the window. 0 approved.**
- **Independent-evidence-group count was never the limiting factor**: zero rounds' terminal reason
  referenced an independent-evidence-group shortfall. The `MIN_INDEPENDENT_AGREEING_AGENTS` floor was
  not what blocked approval this window.
- **Confidence distribution across the 5,831 confidence-bearing no-trade events:**

  | Statistic | Value |
  |---|---|
  | Minimum | 0.000 |
  | p25 | 0.141 |
  | Median | 0.451 |
  | p75 | 0.472 |
  | p90 | 0.472 |
  | **Maximum observed** | **0.700** |
  | Required threshold | 0.750 |
  | Rounds ≥ 0.75 | **0** |
  | Rounds ≥ 0.60 | 25 |
  | Rounds ≥ 0.50 | 252 |

  The confidence ceiling (0.700) never once reached the approval bar across nearly 6,000 real rounds.
  This is a genuine, measured calibration/signal-strength finding, not a single unlucky round.

- **Terminal reason code breakdown (7,798 total `DESK_NO_TRADE` events — more than consensus rounds
  because some symbols accumulate multiple no-trade diagnostics per cycle from different producers):**

  | Reason code | Count | % | Meaning |
  |---|---|---|---|
  | (confidence-text, no distinct code) | 5,806 | 74.4% | `[NO TRADE] Confidence N% did not clear 75%.` |
  | `NO_ELIGIBLE_STRATEGY` | 1,838 | 23.6% | QuantEngine found no CORE strategy whose own setup-confidence threshold cleared this cycle — see §5 |
  | `STALE_MARKET_DATA` | 59 | 0.76% | Real, occasional tick-age gaps (see §2) |
  | `INSUFFICIENT_EVIDENCE` | 6 | 0.08% | No qualifying bars/data this cycle |

**Is this calibration correctly suppressing weak signals, or is IBKR-fixed data failing to translate
into strong signals?** The evidence supports the former: a real, measurable mechanism for the low
ceiling was found (not just "confidence is low, cause unknown") — see §5.

---

## 5. Why confidence stayed low: real cross-agent directional disagreement

Per-agent idea breakdown for the window (`TRADE_IDEA_GENERATED`, by producing agent):

| Agent | Total ideas | BUY | SELL | HOLD |
|---|---|---|---|---|
| KronosEngine | 3,630 | 681 | **2,949** | 0 |
| MacroAgent | 2,873 | 45 | 0 | 2,828 |
| TechnicalAgent | 2,197 | **2,186** | 11 | 0 |
| QuantEngine | 745 | 560 | 185 | 0 |
| JavaCoreEnsemble | 26 | 0 | 26 | 0 |
| OpportunityScreener | 2 | 2 | 0 | 0 |

**TechnicalAgent is overwhelmingly BUY (2,186:11) while KronosEngine — the single most prolific
producer — is overwhelmingly SELL (2,949:681).** When two of the three highest-volume evidence sources
frequently point in opposite directions on the same underlying price action, the weighted vote
mathematically compresses toward the center regardless of how "confident" either individual agent felt
— this is a direct, mechanical explanation for a 0.700 ceiling that never reaches 0.75, and it is
exactly the kind of outcome the system is supposed to produce when real evidence genuinely disagrees.
This is **not** a code defect — the weighted-consensus math (`EvidenceAggregator.ts`, verified by source
read earlier today) is doing precisely what it's designed to do.

`QuantEngine`'s 1,838 `NO_ELIGIBLE_STRATEGY` results were traced to source
(`QuantSignalAgent.ts:622-636`): this code fires specifically when `bestStrategyIdea()` finds **no**
CORE strategy (MOMENTUM_BREAKOUT/PULLBACK_CONTINUATION/MEAN_REVERSION/TREND_FOLLOWING/RANGE_REVERSION)
whose own setup-confidence threshold cleared that cycle — distinct from, and emitted before, any
EV/R:R check (`EXPECTED_VALUE_TOO_LOW`/`POOR_RISK_REWARD`/`EXPECTED_VALUE_UNCOMPUTABLE` are separate,
much rarer codes not seen in this window's top patterns). In plain terms: **the quant engine correctly
declined to manufacture a signal when the price action didn't match any of its five defined setups.**
This is exactly the conservative, non-forcing behavior the investigation explicitly asked to preserve.

---

## 6. Discovery / evaluation bottleneck (Section 5 of the request)

- **453 distinct symbols admitted** by the liquidity/price/spread/ADV screen in the window.
- **~128 distinct symbols** ever received a live market-data subscription slot.
- **~325 admitted candidates were never subscribed at all** — never reached quantitative evaluation,
  never had a chance to produce a directional idea.
- Root cause: real capacity contention against the IBKR 90-line cap (`ibkrConnection.maxMarketDataLines`),
  evidenced by heavy churn — 3,069 temporary-rescue grants, 57 denials, 488 slot evictions in the same
  window. This is the hot-swap/ranking system actively rotating candidates through a bounded resource,
  not a static or stuck allocation.
- **Targeted check: did this capacity constraint cost Argus genuine opportunities?** Cross-referencing
  admitted-but-never-subscribed candidates against real gap-mover/relative-volume-mover flags (the same
  flags `MarketUniverseScanner.ts` already computes at zero extra API cost): only **2 distinct symbols**
  (SMTC, KD) that were admitted and genuinely flagged as real movers never received a subscription slot.
  Separately, of the 928 *filtered* (never even admitted) candidates that carried a mover flag, the
  overwhelming majority were rejected for `PRICE` (penny stocks, OTC-adjacent names) or `DOLLAR_VOLUME`
  (illiquid) — correct, appropriate liquidity-screen behavior, not missed real opportunities. Several of
  the filtered "movers" were warrant tickers (e.g. `ARBEW`, `XRPNW`) — not common equity at all.

**Conclusion: the subscription-capacity bottleneck is real and measurable (≈72% of admitted candidates
never evaluated), but its practical cost in named, genuine missed opportunities this window was small
(2 symbols) given the ranking system's real prioritization of movers for the limited slots.** This is
reported as a secondary, real constraint worth an operator decision (see §13), not as the cause of zero
trades — even if SMTC and KD had been fully evaluated, there is no evidence either would have cleared a
0.75 consensus bar that nearly 6,000 real rounds for *admitted* symbols failed to clear.

---

## 7. Agent health (Section 6 of the request)

Live pipeline-agent status, checked via the authenticated API at investigation time:

| Agent | Enabled | Health | Note |
|---|---|---|---|
| TechnicalAgent | true | STARTING | 0 consecutive failures |
| KronosEngine | true | **FAILED** | 1 consecutive failure — see below |
| QuantEngine | true | STARTING | 0 consecutive failures |
| MacroAgent | true | RUNNING | 0 consecutive failures |
| JavaCoreEnsemble | true | IDLE_WAITING_FOR_MARKET_DATA | 0 consecutive failures |
| TradePlanBuilder | true | IDLE_WAITING_FOR_MARKET_DATA | 0 consecutive failures |
| **NewsAgent** | **false** | OFFLINE | **Disabled by Mission Control config, not a defect** |
| **FundamentalAgent** | **false** | OFFLINE | **Disabled by Mission Control config, not a defect** |
| **JavaFactorComposite** | **false** | OFFLINE | **Disabled by Mission Control config, not a defect** |

**KronosEngine showing `healthLabel: FAILED` with 1 consecutive failure is worth noting but not alarming**
— it is simultaneously the single most prolific idea producer in the window (3,630 ideas), so this
reflects a single recent/transient tick failure, not a sustained outage. Not investigated further this
pass (would require correlating the exact failing tick's timestamp against Kronos sidecar logs — a real,
bounded next step if it recurs).

**NewsAgent, FundamentalAgent, and JavaFactorComposite producing zero ideas in the window is fully
explained by their Mission Control toggle being off — not a bug.** This is a legitimate finding worth
surfacing as a recommendation, not a defect: with three of the roster's evidence producers disabled,
the independent-evidence pool is smaller than it could be, which plausibly contributes to the
TechnicalAgent/KronosEngine disagreement dominating the weighted vote unchallenged by other
perspectives. Re-enabling any of them is an operator decision with real tradeoffs (API cost, rate
limits, provider reliability) that this investigation does not make unilaterally.

No engine in the roster is "enabled but producing zero usable evidence" except by explicit
configuration choice — this specific defect class (asked for in §6 of the request) was not found.

---

## 8. DATA_UNAVAILABLE vs real HOLD (Section 7 of the request)

Verified by source read earlier today (not re-queried live this pass, since no code changed in this
path between then and now): `EvidenceAwareVote.ts` provides a real typed `evidenceState:
'DATA_UNAVAILABLE'` with `reasonCode: 'DATA_UNAVAILABLE_CALIBRATION_OVERRIDE_IGNORED'`, confirmed
genuinely imported and used by `ChiefTraderAgent.ts` (not an orphan module). Existing tests
(`EvidenceAwareVote.test.ts`) explicitly prove a DATA_UNAVAILABLE vote is excluded from the weighted
denominator, not counted as dissent. **No defect found in this area — already correctly implemented.**
One residual, minor fragility noted (not fixed, as it is not proven to be causing any problem in this
window): the typed state is still *derived* by matching reasoning text against 3 known string markers,
so an agent whose exact phrasing drifts from those markers would not be classified as DATA_UNAVAILABLE.

---

## 9. RiskEngine (Section 8 of the request)

**Zero RiskEngine evaluations occurred in the window** (`RISK_ASSESSMENT_STARTED`: 0). This is the
direct, correct, structurally-guaranteed consequence of zero `CHIEF_APPROVED_IDEA` events — RiskEngine
is only ever invoked after ChiefTrader approval. There is nothing to analyze here because nothing
reached it; this is not itself a finding of a problem in RiskEngine.

---

## 10. Position sizing (Section 9 of the request)

Not reached — no idea was ever approved to size. The earlier-today capital-allocation fail-open fix
(gate 23 now correctly recognizes `entryPrice` and fails BUY closed on an unresolvable price) remains in
place and deployed in the current build, but had no occasion to be exercised this window.

---

## 11. OMS / broker (Section 10 of the request)

**Zero orders reached OMS.** `ORDER_SUBMITTED`/`ORDER_ACCEPTED`/`ORDER_EXECUTED`/`ORDER_FILLED` are all
0 for the window. Since `CHIEF_APPROVED_IDEA` is also 0, this is the correct, expected, consistent
chain — **not** the "consensus approvals > 0 but OMS orders = 0" failure pattern the investigation
specifically asked to check for. That failure mode was not observed.

---

## 12. External opportunity benchmark (Section 11 of the request)

**Honest limitation:** the investigation date (2026-10-01) is beyond general knowledge available for an
external news/market-data search, and fetching real third-party market-mover data for this exact date
was not reliable. Instead, Argus's own real captured market data was used as the external-proxy ground
truth (see §6): real gap-percentage and relative-volume flags computed directly from live bars at zero
additional cost, cross-referenced against every admitted-but-unevaluated candidate. This is a more
rigorous proxy than a generic news search would have been, though it is not identical to an independent
third-party benchmark. Result: only 2 named symbols (SMTC, KD) were both genuinely-flagged real movers
and never evaluated — see §6 for full reasoning. No evidence was found of a broad class of obvious,
large movers that Argus systematically ignored.

---

## 13. Defects found

**None met the bar required to fix this pass** (reproduced + root-caused + does not weaken
risk/consensus + preserves protected architecture + testable). Specifically:

- The 0.700 confidence ceiling is explained by real, measured cross-agent disagreement — correct
  calibration behavior, not a defect.
- The subscription-capacity constraint is a real, architectural, bounded-resource limit (IBKR's 90-line
  cap) already governed by an existing, reviewed hot-swap/ranking mechanism — not a coding defect.
- `NO_ELIGIBLE_STRATEGY` is confirmed-correct conservative non-emission, traced to source.
- DATA_UNAVAILABLE handling is already correctly typed and excluded from positive evidence.
- No RiskEngine/PositionSizing/OMS defect was found because none of those systems was ever exercised
  this window (nothing to find).

**No fix was implemented.** Per the investigation's own explicit instruction, lowering
`consensusApprovalThreshold`, lowering `minIndependentAgreeingAgents`, bypassing RiskEngine, forcing a
trade, or manufacturing evidence were all correctly out of scope and none were done.

---

## 14. Tests added

None — no code was changed this pass (investigation only; see §13).

---

## 15. Remaining bottlenecks / recommendations (operator decisions, not unilateral fixes)

1. **Evidence diversity**: NewsAgent, FundamentalAgent, and JavaFactorComposite are currently disabled.
   Re-enabling any of them would add independent perspectives that could either corroborate or
   meaningfully challenge the TechnicalAgent/KronosEngine disagreement currently dominating the weighted
   vote — a real lever for *more genuine evidence*, not weaker standards, matching the investigation's
   own stated goal. This is an operator cost/reliability tradeoff, not something to flip unilaterally.
2. **Subscription capacity**: ~72% of admitted candidates never get evaluated under the current 90-line
   cap. The targeted mover cross-check found this cost only 2 named opportunities this window, but a
   sustained pattern across more sessions would be worth re-examining — specifically, whether the real
   IBKR account entitlement supports more than 90 concurrent lines (the same kind of real, bisected
   measurement that previously set Alpaca's 12-line ceiling, not a guess).
3. **KronosEngine's single recent consecutive failure** — not investigated further this pass; worth a
   closer look only if it recurs or escalates.

---

## Final summary

- **PRIMARY BOTTLENECK:** Consensus — weighted confidence never reached the 0.75 approval threshold
  (max observed 0.700), driven by real, measured directional disagreement between TechnicalAgent
  (BUY-skewed) and KronosEngine (SELL-skewed).
- **SECONDARY BOTTLENECK:** Discovery/evaluation capacity — ~72% of admitted candidates never received
  a subscription slot under the real IBKR 90-line cap, though the practical cost in named missed
  opportunities this window was small (2 symbols).
- **DATA PIPELINE HEALTH:** Healthy. IBKR real-time data confirmed genuinely live (100% of
  acknowledgments LIVE, 0% delayed/frozen) for all required benchmark symbols and broadly across the
  window.
- **SIGNAL PIPELINE HEALTH:** Healthy and active, but internally divided — high volume of real ideas
  from multiple independent producers, with a measured, genuine directional split between the two
  highest-volume producers.
- **CONSENSUS HEALTH:** Healthy and correctly conservative — functioning exactly as designed, never
  once compromising the threshold, never blocked by the independence floor specifically.
- **RISK PIPELINE HEALTH:** Not exercised this window (nothing reached it) — no finding either way.
- **EXECUTION PIPELINE HEALTH:** Not exercised this window (nothing reached it) — no finding either way.

**Classification: MULTIPLE_BOTTLENECKS** (SIGNAL_QUALITY/CONSENSUS primary, OPPORTUNITY_CAPTURE
secondary) — not `HEALTHY_NO_VALID_OPPORTUNITY` (a real, measurable capacity constraint exists and is
worth an operator decision) and not `EXECUTION_DEFECT`/`RISK_CONFIG_BOTTLENECK`/`CODE_DEFECT` (nothing
in those categories was found or reached). Zero trades over this 2-hour window is consistent with the
system working correctly under genuinely mixed/disagreeing evidence — not proof by itself that
something is broken, and not proof by itself that nothing could be improved.
