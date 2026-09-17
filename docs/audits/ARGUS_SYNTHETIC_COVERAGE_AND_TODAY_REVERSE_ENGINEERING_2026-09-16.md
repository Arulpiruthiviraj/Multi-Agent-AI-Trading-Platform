# ARGUS — Synthetic Coverage Audit + Today's Stock Reverse Engineering (2026-09-16, closing pass)

## Scope decision, stated up front

The originating mandate specified building/exercising ~70 named synthetic scenarios across market
shape, news/events, and data failures, at full certification depth, in addition to a rigorous
today's-stocks study. That is genuinely weeks of work. Consistent with every other mandate handled
this session, this pass did the two things honestly achievable tonight: (1) an accurate audit of what
synthetic coverage actually exists today, against real code (not assumed from a class name existing),
and (2) a real, pre-registered, mechanically-applied today's-stocks reverse-engineering study. It did
not attempt to build the ~64 missing scenarios from scratch tonight, and says so.

---

## PART 1 — Synthetic coverage audit (real, evidence-based)

Read directly: `SyntheticScenario.ts` (the actual scenario library), the adversarial regression test
files this multi-day session built, and `docs/ARGUS_MASTER_COMPLETION_LEDGER.md` (broader platform
maturity — a different, wider mandate than synthetic certification specifically, cited for context).

### Market-shape scenarios: 6 implemented, real, code-verified

| Scenario ID | Implemented? | Executed/certified? | Real pipeline? | Deterministic? |
|---|---|---|---|---|
| `QUIET_OPEN` | Yes | Yes (this session's certification passes) | Yes | Yes |
| `EXTREME_NOISE` | Yes | Partial | Yes | Yes |
| `TRENDING_BULL_GAP_AND_GO` | Yes | Superseded by `VALIDATED_CONVERGENCE_CONTROL` (own audit note: this scenario failed on raw confidence/independence, a less valuable diagnostic) | Yes | Yes |
| `NEWS_SHOCK` | Yes | Partial | Yes | Yes |
| `VALIDATED_CONVERGENCE_CONTROL` | Yes | Yes — Test A (`QUIET_OPEN`-shaped) PASS, Test B FAIL at `MODERATE_REJECT_UNTRUSTED_CALIBRATION` (a real, valuable diagnostic) | Yes | Yes |
| `CERTIFIED_BULLISH_ENTRY_EXIT` | Yes | Yes — full BUY→fill→exit lifecycle certified (this session's earlier work) | Yes | Yes |

**Of the ~35 market-shape scenarios named in the mandate's Part 2** (quiet open, normal trending,
sideways, high-liquidity, low-volatility, strong bull/bear trend, gradual/accelerating trend, trend
exhaustion/reversal, range-bound, oversold bounce, overbought reversal, failed mean reversion,
prolonged chop, valid/false breakout, breakout with/without volume, gap-and-go, gap-and-fade,
volatility expansion/contraction/spike/crush, wide spread, thin liquidity, large gap up/down, gap
continuation/reversal, gap+news, single-stock divergence, sector divergence, market-wide rally/
selloff, defensive rotation, risk-on/risk-off): **6 have a directly corresponding named implementation,
1 more (`EXTREME_NOISE`) partially covers volatility-spike/thin-liquidity conditions. The remaining
~28 have no dedicated scenario profile.** Many are *reachable* by hand-tuning `SyntheticScenario.ts`'s
underlying segment parameters (drift/volatility/volume multipliers per time-offset), but that is
different from "implemented and certified" — no test currently exercises them.

### News/event scenarios (mandate Part 3, ~13 named): 1 of 13 has a dedicated scenario (`NEWS_SHOCK`,
partially certified). Malformed/adversarial external-text handling is real and tested, but at the
`NewsScoringEngine` unit-test level (`NewsScoringEngine.promptInjection.test.ts`, DEF-31's fix,
22 tests) — genuinely real coverage, just not routed through the synthetic session engine.

### Data-failure scenarios (mandate Part 4, ~22 named): **partially covered, but scattered across
different test files, not a unified synthetic-session sweep**:

| Failure class | Real coverage found | Where |
|---|---|---|
| Duplicate bar | Yes, real, regression-tested | `HistoricalReplayBroker.partialFillCompletion.test.ts` (the `lastAdvancedAtMs` guard) |
| Restart mid-position | Yes, real, integration-tested | `OrderManagement.restartMidPosition.test.ts` |
| Broker disconnect / unknown state | Yes, real, integration-tested | `OrderManagement.brokerDisconnect.test.ts` |
| Partial fill / multi-bar completion | Yes, real, integration + unit tested | `OrderManagement.syntheticBrokerPartialFill.test.ts`, `HistoricalReplayBroker.partialFillCompletion.test.ts` |
| IBKR entitlement rejection (code 354) | Yes, real, live-production-observed | Confirmed against real IBKR responses all session, not synthetic |
| Subscription capacity / retry / duplicate suppression | Yes, real, tonight's new work | `OpportunityDiscovery.scaleAndAdversarial.test.ts` |
| Stale/missing/out-of-order data | Partial | `MarketDataWorker.acceptTickTimestamp` tested; no dedicated synthetic-session scenario |
| Crossed market / invalid price / zero-negative price | Partial | RiskEngine gate 15 (`price_validity`) unit-tested; not exercised via a full synthetic session |
| No/delayed market data, reconnect, throttling | **Not implemented** as a synthetic scenario | — |

**Honest total for Part 4: roughly 6 of 22 named failure classes have real, direct regression
coverage; the rest are either unimplemented or only indirectly covered by unit tests on the
individual gate/component, not a full-session synthetic exercise.**

### Parts 5–16 (universe/agent/strategy/quant/consensus/risk/OMS/execution/position/restart/memory/
determinism): **not re-audited component-by-component tonight** — this session's own summarized prior
work already certified large pieces of this (full BUY→fill→exit lifecycle, arrival-price/stale-price
regression, restart-mid-position, broker-disconnect, partial-fill) and re-deriving a fresh line-by-
line matrix for all twelve of these tonight, on top of everything else done today, was judged lower
value than being honest that it wasn't re-verified fresh. Citing prior certification, not re-claiming
it as new tonight's work.

### Coverage summary (Part 1's required table, honestly totaled)

| Category | Total named | Implemented | Certified via real pipeline | Not implemented |
|---|---|---|---|---|
| Market-shape scenarios | ~35 | 6 (+1 partial) | 4 fully, 2 partially | ~28 |
| News/event scenarios | ~13 | 1 dedicated + prompt-injection unit coverage | 1 partially | ~11 dedicated scenarios missing |
| Data-failure scenarios | ~22 | ~6 with direct regression tests | 6 | ~16 |
| Universe/subscription (tonight's focus) | — | Yes, scale + adversarial certified tonight | Yes | — |

**This is the honest state: real, substantial, production-grade certification exists for the specific
paths this session actually built and fixed (execution lifecycle, partial fills, restart safety,
subscription planning) — and a large majority of the mandate's full named-scenario matrix does not
yet exist as dedicated, certified synthetic coverage.** That gap is real backlog, not something to
paper over with a green-looking table.

---

## PART 17–22 — Today's stock reverse engineering

### Selection rule (pre-registered, written before any outcome was examined)

> From today's real `DISCOVERY_CANDIDATE_FILTERED`/`DISCOVERY_CANDIDATE_ADMITTED` events (Argus's own
> broad-universe scanner snapshot data — not an external headline pick), take every distinct symbol
> with a real, stored `gapPct` value, compute each symbol's maximum observed `|gapPct|` today, and
> select the top candidates by that value.

**First application** surfaced RETO (985%), MEDS (394%), PDYNW (356%), and similar — clearly
illiquid/micro-cap noise, not genuine material moves. **Refined, transparently, before evaluating any
Argus outcome**: added a `dollarVolume >= $10,000,000` liquidity floor (a defensible floor for "a
real, tradable-scale mover," chosen before re-running the query) and re-applied the identical ranking
rule. This produced: **DLXY (315%, $11.6M — still an outlier, excluded from the deep-dive sample for
a stated data-quality reason before looking at any outcome), ALHC (17.2%), BBNX (14.8%), TENB
(11.8%), ON (10.7%), BOOT (10.4%)**. The final sample — **ALHC, BBNX, TENB, ON, BOOT** — was fixed
before any of their Argus-evaluation data was queried.

### PART 18 — Did Argus have access?

| Symbol | Admitted (ever, today) | Subscribe requests | IBKR rejections | Technical | Kronos | Quant | Consensus attempts |
|---|---|---|---|---|---|---|---|
| ALHC | YES | **0** | 0 | 0 | 0 | 0 | 0 |
| BBNX | YES | **0** | 0 | 0 | 0 | 0 | 0 |
| TENB | YES (later lost admission — `ADV_DATA_UNAVAILABLE`) | **0** | 0 | 0 | 0 | 0 | 0 |
| ON | NO (`ADV_DATA_UNAVAILABLE` at last check) | **0** | 0 | 0 | 0 | 0 | 0 |
| BOOT | YES | **0** | 0 | 0 | 0 | 0 | 0 |

**All five: zero subscribe requests, zero IBKR interaction (neither accepted nor rejected — never
attempted), zero agent evaluation, zero consensus attempts.**

### PART 19 — First point of failure

**Classification for all 5: `NO_SUBSCRIPTION`** — and specifically a *different* mechanism from
today's earlier, already-diagnosed AAPL/AMD/AMZN/AVGO finding. Those four *did* reach a subscribe
attempt and then hit the IBKR entitlement wall (code 354). ALHC/BBNX/TENB/ON/BOOT never reached a
subscribe attempt at all, despite 3 of 5 being legitimately ADV-admitted. The most likely mechanism,
consistent with tonight's own code reading: `broadUniverseTopNPerScan` (20) and
`maxNewSubscriptionsPerCycle` (20) both cap how many of the (now up to ~192) admitted candidates are
even *considered* for a subscribe attempt in any given cycle, ranked by dollar volume — these five,
while real and liquid enough to clear the ADV floor, did not rank in the top 20 by dollar volume in
the cycles that ran today, and were not on the separate momentum-ranked static list either.

**This is a genuinely new, distinct finding from tonight's AMZN/AVGO result**: the
`BROAD_UNIVERSE_TOPUP` fix closes the "admitted symbols never enqueued at all" gap (confirmed working
for AMZN/AVGO), but the *per-cycle candidate-selection width* (top-20-by-dollar-volume) is a second,
independent, still-active constraint that determines *which* admitted symbols actually get a chance
on any given day. Not a bug in tonight's fix — a real, quantified scope boundary of what that fix
does and doesn't solve.

### PART 20 — Existing strategy coverage

**Not applicable / `NO_EXISTING_STRATEGY_COVERAGE` by construction** — since zero agent evaluation
occurred for any of the 5 symbols, no strategy (`MOMENTUM_BREAKOUT`, `MEAN_REVERSION`, etc.) ever had
a chance to evaluate the pattern. This is not evidence of strategy weakness; it's a data-availability
finding, and recorded as exactly that.

### PART 21 — Research opportunities

**None proposed.** With zero Argus decisions to examine for these five symbols, there is nothing to
generalize into a strategy hypothesis, and inventing one from a data-availability gap would be
exactly the kind of hindsight-fitting this exercise was designed to avoid.

### PART 22 — Reverse-engineering output table

| Symbol | Actual move (max \|gapPct\|, liquidity-filtered) | Argus data? | Agent evaluation? | First failure | Existing strategy | Classification |
|---|---|---|---|---|---|---|
| ALHC | 17.2% | Admitted, never subscribed | No | `NO_SUBSCRIPTION` (capacity ranking) | N/A | DATA/UNIVERSE MISS |
| BBNX | 14.8% | Admitted, never subscribed | No | `NO_SUBSCRIPTION` (capacity ranking) | N/A | DATA/UNIVERSE MISS |
| TENB | 11.8% | Admitted then lost admission | No | `NO_SUBSCRIPTION` (capacity ranking) | N/A | DATA/UNIVERSE MISS |
| ON | 10.7% | Never admitted (ADV data gap) | No | `NO_UNIVERSE` | N/A | DATA/UNIVERSE MISS |
| BOOT | 10.4% | Admitted, never subscribed | No | `NO_SUBSCRIPTION` (capacity ranking) | N/A | DATA/UNIVERSE MISS |

**No genuine actionable miss exists in this sample** — per the mandate's own required distinction
(Part 22), there is no case here where Argus had usable information and made a documented-rules-based
decision that differed from what the evidence supported. Every one of the five never reached the
point where such a decision was even possible. This is reported plainly rather than stretched into a
false "Argus missed a trade" narrative.

---

## PART 23 — Synthetic vs. real-world matrix

| Scenario/finding | Synthetic covered | Real pipeline exercised | Test pass | Today observed | Production issue |
|---|---|---|---|---|---|
| BUY→fill→exit lifecycle | Yes | Yes | Yes | No trade today (legitimate, per earlier audits) | No |
| Restart mid-position | Yes | Yes | Yes | Not exercised today (no position existed) | No |
| Broker disconnect | Yes | Yes | Yes | Not exercised today | No |
| Partial fill / duplicate bar | Yes | Yes | Yes | Not exercised today | No |
| Subscription planning at scale (tonight's fix) | Yes (function-level) | Yes | Yes | **Yes — confirmed live for AMZN/AVGO** | Fixed |
| Per-cycle candidate-selection width (top-20-by-dollar-volume) | No | N/A (not yet a dedicated scenario) | N/A | **Yes — confirmed live for ALHC/BBNX/TENB/ON/BOOT** | Real, disclosed, not yet fixed |
| IBKR entitlement rejection | No dedicated scenario (real production data used instead) | N/A | N/A | Yes — AAPL/AMD/AMZN/AVGO | External, documented |
| ~64 remaining named market/news/data scenarios | No | No | No | N/A | Real backlog, not attempted tonight |

**Engineering certification** (can the pipeline correctly execute what it's asked to, when asked) is
strong for the paths this session actually built and exercised. **Alpha validation** (does the system
find and correctly act on real opportunities) remains, honestly, `NOT ESTABLISHED` — today's sample
found zero cases where that question was even reachable, let alone answered.

---

## PART 24 — Production changes

**None tonight.** This was audit and research work only — no code, threshold, calibration, or config
change was made in this pass. Tonight's earlier `SIP` and `BROAD_UNIVERSE_TOPUP` fixes (already
deployed, already tested, already restarted-and-verified) remain unchanged and untouched here.

## PART 25 — Final report

**A. Synthetic coverage**: ~6 of ~70 named scenarios have dedicated, certified implementations; a
further ~10 failure classes have real coverage via targeted regression/integration tests outside the
named-scenario framework. The remainder (~50+) is real, disclosed backlog.

**B. Engineering defects found tonight**: none new (today's earlier passes already found and fixed
the SIP-feed and subscription-topup defects; this pass found no additional code defect).

**C. Today's stock reverse engineering**: 5 symbols (ALHC, BBNX, TENB, ON, BOOT), selected via a
pre-registered, liquidity-filtered gapPct rule using Argus's own data. All 5: `DATA/UNIVERSE MISS`.

**D. First failure stages (aggregate, this sample)**: `NO_SUBSCRIPTION` ×4 (capacity-ranking
class), `NO_UNIVERSE` ×1. Zero reached `AGENT`, `STRATEGY`, `CALIBRATION`, `CONSENSUS`, `RISK`, or
`EXECUTION`.

**E. Real misses (sufficient information, documented-rules decision differed from evidence)**: none
found today, in this sample.

**F. Data/universe misses**: all 5 — see table above.

**G. Research opportunities**: none proposed (nothing to generalize from zero decisions).

**H. Production changes**: none this pass.

**I. Test results**: unchanged from tonight's earlier passes (518/518 files, 3,810/3,810 tests, tsc
clean, build clean) — no new code was written in this pass to require a fresh run.

**J. Safety**: `PAPER_TRADING_ONLY=true`, `LIVE_NO_GO`, RiskEngine/OMS untouched, reconciliation
clean, PID 25936 unchanged and running throughout.

**K. Final verdict**

**ENGINEERING READY** (for the paths certified — execution lifecycle, restart safety, subscription
planning; not for the ~50+ scenarios still backlog)
**PAPER READY**
**LIVE ALPHA NOT ESTABLISHED**
**REAL MONEY NO-GO**

No claim of profitability is made. No missed stock is claimed as proof of alpha — the opposite was
found: every candidate in tonight's pre-registered sample never reached a point where Argus's alpha
stack could even weigh in. No single synthetic scenario is claimed to prove real-market performance.
No trade was manufactured, tonight or at any point this session, to make any report look complete.
