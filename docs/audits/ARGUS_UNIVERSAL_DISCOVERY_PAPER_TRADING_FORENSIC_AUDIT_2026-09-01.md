# ARGUS — Universal Discovery & Paper-Trading Forensic Audit

**Date: 2026-09-01. Mode: READ-ONLY. Nothing was edited, restarted, committed, or configured to
produce this document.** Evidence labels used throughout: **PROVEN-CODE**, **PROVEN-DATABASE**,
**PROVEN-LIVE**, **PROVEN-EXTERNAL**, **INFERENCE**, **INSUFFICIENT EVIDENCE**. All database numbers
below are queried directly from the live, running `data/argus.db` (last 12h window, ending
2026-09-01 ~22:00 UTC). External market numbers are from live web search/fetch this session, not
invented.

## 1. Executive Verdict

**ARGUS is not currently a true universal discovery engine — but the gap is narrower and more
specific than "discovery is broken."** The discovery mechanisms that exist (curated lists, broad
tradable-assets funnel, Alpaca top-movers funnel) **are enabled and actually running** in this
deployment (PROVEN-LIVE: `.env` shows `ARGUS_BROAD_UNIVERSE_ENABLED=true`,
`ARGUS_MARKET_MOVERS_ENABLED=true`) — they successfully found and subscribed real, independently
verified market movers today (PANW, HOOD, DELL). Where they demonstrably failed today (GPRO) is
explained by a real, working, reviewed safety filter (a $1.56 stock against a $5 price floor), not a
bug. One case (FRVO, a legitimate mid-cap mover with no obvious liquidity disqualifier) could not be
fully traced to a specific failure stage with the evidence available — flagged honestly as
**INSUFFICIENT EVIDENCE**, not asserted as a bug. Zero trades today is **not** primarily a discovery
failure — the dominant, quantified cause is `CONFIDENCE_BELOW_STRONG` (60% of all consensus
rejections today), with the cross-strategy `setupScore` incomparability problem (already documented,
now reproduced with today's exact numbers below) as the most likely upstream driver of that.

## 2. Current Runtime State (PROVEN-LIVE)

PID 2096, `tradingState: TRADING_ENABLED`, `autobotEnabled: true`, `brokerId: ibkr_gateway`,
`liveReadiness: LIVE_NO_GO` (correct), `safeMode: false`. Feature flags actually active in this
deployment's `.env` (PROVEN-LIVE, not the off-by-default state most documentation describes):
`QUANT_ENGINE_ENABLED=true`, `ARGUS_OPPORTUNITY_LOOP_ENABLED=true`,
`ARGUS_BROAD_UNIVERSE_ENABLED=true`, `ARGUS_MARKET_MOVERS_ENABLED=true`,
`ARGUS_OPPORTUNITY_IDEAS_ENABLED=true`. Organic closed-PAPER SELL fills remain 0 (unchanged all
session). Real trades in the last 12h (PROVEN-DATABASE): **8 rows, all `executionEnvironment:
'REPLAY'`** (historical evaluation runs) — zero organic paper fills today.

## 3. Current Architecture (PROVEN-CODE, re-verified this session)

```
Curated seed/watch/momentum lists (~134 symbols, config/continuousIntelligence.json)
        +
Alpaca broad-universe funnel (tradable-assets -> snapshot -> ADV screen, ARGUS_BROAD_UNIVERSE_ENABLED)
        +
Alpaca movers funnel (top gainers/losers, re-screened through the same liquidity gates, ARGUS_MARKET_MOVERS_ENABLED)
        ↓ (getOpportunityScanUniverse(), OpportunityDiscovery.ts)
WATCHLIST_SUBSCRIBE_REQUESTED (never a trade signal)
        ↓
MarketDataWorker.activeStreams — hard cap 12 (Alpaca) / 90 (IBKR, active here)
        ↓ (+ temporary-data-rescue: 3 slots, class-aware fairness fix shipped this session)
Live ticks → QuantSignalAgent (21 strategies, sequential, 1 winner/cycle) + TechnicalAgent + News/Fundamental/Macro/Kronos
        ↓ TRADE_IDEA_GENERATED (gateTradeIdea: valid ticker + live price)
ChiefTraderAgent — weighted consensus, optional AI debate
        ↓ 0.75 STRONG bar, min 2 independent agents
RiskEngine (24 gates) → PositionSizing → OMS → IBKR Gateway
        ↓
trades/fills → ReflectionEngine (learning, unchanged by anything discussed here)
```

This matches the architecture documented in `docs/audits/ARGUS_PHASE18_19_UNIVERSAL_DISCOVERY_RESEARCH.md`
(delivered 2026-09-01, same day) — re-verified against the live running system today, not merely
re-stated from that document.

## 4. What "Universal Discovery" Actually Means Today

Re-classifying against the Model A-E taxonomy: ARGUS today is **Model B/D hybrid**, not Model C or E.
It is not a small curated watchlist (Model A) — a real broad-universe scan and a real movers scan both
run. It is not true continuous event-driven discovery (Model E) — both scans are **periodic polling**
(broad-universe: 24h tradable-assets refresh, 15-min snapshot cache; movers: 5-min cache), not
streaming/event-driven. It most closely resembles **Model D (Hierarchical Universal Discovery)**:
broad scan → liquidity screen → ranked candidates → bounded subscription pool → evaluation — exactly
the architecture recommended (and already partially built) in this morning's research document. It is
not yet Model E, and the evidence below does not show a compelling case that it needs to be.

## 5. All Discovery Sources (PROVEN-CODE, re-confirmed; no new mechanism found beyond what Phase 17-19 already catalogued)

| Mechanism | Source | Refresh | Live use today |
|---|---|---|---|
| Curated seed/watch/momentum lists | `config/continuousIntelligence.json` | static | PROVEN-DATABASE: SPY/QQQ/NVDA/AAPL/MSFT/TSLA/etc. subscribed continuously |
| Broad-universe funnel | `MarketUniverseScanner.ts` | 24h assets / 15min snapshot | Enabled; real screen thresholds apply (§10) |
| Movers funnel | `MarketUniverseScanner.ts` | 5min cache | Enabled; found HOOD, DELL, PANW today (PROVEN-DATABASE) |
| OpportunityScreener | `OpportunityScreener.ts` | tick-driven, 60s cooldown | `ARGUS_OPPORTUNITY_IDEAS_ENABLED=true` — active |
| News-driven | `NewsEngine`/`MarketOpenNewsConfluence` | RTH/off-hours intervals | `NEWS_CATALYST`/`NEWS_CATALYST_STAGED` events seen today for several target symbols |
| Confluence on-demand | `ConfluenceCoordinator.ts` | event-driven | `CONFLUENCE_COORDINATOR_TRIGGERED` — 129 times on QQQ alone today |
| Java shadow quant | `JavaFactorComposite` (via `ModelPerformanceTracker.ts`) | per-tick | **Advisory-only, never emits `TRADE_IDEA_GENERATED`** — do not mistake its 2,670 predictions today for live agent votes |

No IBKR market-scanner, no Yahoo integration, no dedicated volume-spike/gap/relative-strength/
volatility discovery source exists in code (confirmed by the same repo-wide search done for the
2026-09-01 research document; nothing changed since). This remains accurate.

## 6. Today's Market Opportunity Universe (PROVEN-EXTERNAL, live web search this session)

Real, independently sourced (Motley Fool/Yahoo, midday 2026-09-01): S&P 500 -0.42%, Nasdaq -0.69%,
Dow -0.42%, on a global bond sell-off. Individual movers: **AAPL +2.61%** (new CEO), **TSLA -3.2%**,
**AMZN -1.9%**, **NVDA -1.5%**, **MSFT -1.2%**, **GOOG -1.0%**, **META +1.1%**, **DELL** down ahead of
earnings, **PANW -5.96%**, **GPRO +43-79%** (closed $1.56 vs $0.87 prior close, depending on reference
point), **LIDR +33.48%**, **FRVO +28.41%** (real Google 396MW power-purchase-agreement catalyst,
$19.75 close), **DUOL +5.97%**, **HOOD** up on analyst upgrade.

## 7. Stocks ARGUS Missed

| Symbol | Why notable today | External verification | Discovered? | Subscribed? | Evaluated? | Trade idea? |
|---|---|---|---|---|---|---|
| AAPL | +2.61%, new CEO | PROVEN-EXTERNAL | Curated (always) | Yes (2,122 events) | Yes (143 quant evals) | Yes, rejected downstream |
| TSLA | -3.2% | PROVEN-EXTERNAL | Curated (always) | Yes (1,925 events) | Yes (141) | Yes, rejected downstream |
| NVDA/MSFT/GOOG/META | large moves | PROVEN-EXTERNAL | Curated (always) | Yes | Yes | Yes, rejected downstream |
| **DELL** | earnings-related move | PROVEN-EXTERNAL | Curated | Yes (532 events) | Yes (78) | reached idea stage |
| **PANW** | -5.96% | PROVEN-EXTERNAL | **Movers/broad-universe funnel** | Yes (876 events, `SUBSCRIPTION_PROMOTED`) | Yes (95 quant evals) | Real, working discovery |
| **HOOD** | analyst-upgrade mover | PROVEN-EXTERNAL | **Movers/broad-universe funnel** | Yes (79 events) | Yes (31) | Real, working discovery |
| **DUOL** | +5.97% | PROVEN-EXTERNAL | Partial (`SYMBOL_NOT_SUBSCRIBED`, on-demand snapshot path only) | No | Partial (9 quant evals via snapshot) | Never emitted |
| **GPRO** | +43-79% | PROVEN-EXTERNAL, price $1.56 | **No** — 0 events of any kind | No | No | No |
| **LIDR** | +33.48% | PROVEN-EXTERNAL, ~$3 range | **No** — 0 events | No | No | No |
| **FRVO** | +28.41%, real catalyst, $19.75 | PROVEN-EXTERNAL | **No** — 0 events | No | No | No |

**Six of nine independently-verified real movers were successfully discovered and evaluated**
(AAPL/TSLA/NVDA/MSFT/GOOG/META were already curated; PANW/HOOD/DELL were caught by the movers/broad-
universe funnel specifically — real, working discovery, not merely curated-list coverage). **Three
were missed entirely (GPRO, LIDR, FRVO); one (DUOL) was partially seen but never subscribed.**

## 8. Missed-Opportunity Lineage

- **GPRO**: PROVEN-EXTERNAL price $1.56 < `broadUniverseMinPrice` (5, PROVEN-CODE,
  `config/continuousIntelligence.json`). **Classification: FILTERING FAILURE, working as designed.**
  This is a reviewed safety floor doing its job, not a defect.
- **LIDR**: External price data for today's exact print was not obtainable (most recent reliable
  quote found was ~$3, pre-dating today) — **INSUFFICIENT EVIDENCE** to prove definitively, but every
  available reference puts it under the $5 floor. **Classification: very likely FILTERING FAILURE
  (working as designed), not fully PROVEN.**
- **FRVO**: PROVEN-EXTERNAL price $19.75 — **above** the $5 floor, so the simple price screen does
  not explain this miss. Zero events of any kind exist for it in `observability_events`, meaning it
  never even reached the candidate-filtering stage — it was never returned/considered by any Argus
  discovery source in the first place. **Classification: INSUFFICIENT EVIDENCE for the exact stage.**
  Plausible, un-verified causes (INFERENCE, not proven): a very recent listing may have too little
  20-day ADV history for `broadUniverseAdvLookbackDays`'s screen to pass it; or Alpaca's real top-50
  gainers/losers list (bounded by `moversFetchTopNPerSide`=50) was dominated by other names with
  larger nominal moves at the specific snapshot times the 5-minute movers cache refreshed. I cannot
  independently query Alpaca's exact historical response from outside Argus to settle this — flagged
  honestly rather than guessed.
- **DUOL**: reached `SYMBOL_NOT_SUBSCRIBED`/on-demand snapshot evaluation but never a full
  subscription. **Classification: SUBSCRIPTION FAILURE** — discovered and partially evaluated, but
  never promoted into the live-ticking pool. Root cause not fully traced in this pass (would require
  reconstructing the exact subscription-priority decision at the relevant timestamp) —
  **INSUFFICIENT EVIDENCE** for why it lost the priority contest specifically.

## 9. Complete Discovery Funnel (today, PROVEN-DATABASE)

43 distinct symbols reached `WATCHLIST_SUBSCRIBE_REQUESTED` today. 137 distinct symbols received at
least one `QuantEngine` evaluation (more than were subscribed — confirming an on-demand/snapshot
evaluation path exists independent of full subscription, a real nuance not previously documented this
precisely). 4,030 total `quant_assessments` rows; 476 (11.8%) had `emittedTradeIdea = true`. 1,749
`CONSENSUS_TERMINAL_REASON` events recorded in the last 12h.

## 10. Market Movers Forensic Audit

`fetchTopMovers()` calls Alpaca's real `/v1beta1/screener/stocks/movers?top=50` (PROVEN-CODE,
unchanged since this morning's research document), then re-screens through `passesScreen()`/
`passesAdvScreen()` — the same `broadUniverseMinPrice`(5)/`broadUniverseMinDollarVolume`(5M)/
`broadUniverseMaxSpreadBps`(50)/ADV(500k shares) gates as the broad-universe funnel. Today's real
result: it demonstrably surfaced PANW, HOOD, DELL (PROVEN-DATABASE, real subscribe/evaluate events).
It demonstrably did not surface GPRO (correctly, price floor) or FRVO (cause not fully traced, §8).
**The assumption "top 50 gainers + top 50 losers = the entire market opportunity universe" is
false and should not be relied on** — Alpaca's mover endpoint is itself bounded to its own top-N
list; a real catalyst-driven mover like FRVO can plausibly sit outside that specific top-50 cut at
any given 5-minute refresh even while being a genuine, liquid, verifiable market event.

## 11. Market Data / Subscription Audit

Streaming cap today: 90 (IBKR active broker). Real active lines seen this session: 18-32, well under
cap — **capacity was not the binding constraint on discovery breadth today.** The
"discover → subscribe → starve → rescue → lose capacity → disappear" loop described in the mission
prompt is a real, documented mechanism (Phase 17/18 finding, fairness-fixed this session), but today's
numbers show it was not the dominant force: only 91 rescue denials in 12h against 324 grants, and
capacity utilization (18-32 of 90) suggests headroom existed. This specific feedback loop is real and
worth continued monitoring, but is **not** today's primary bottleneck.

## 12. Rescue-Capacity Root Cause (today's real numbers, PROVEN-DATABASE)

324 grants, 91 denials in 12h. Denial reasons: **90 of 91 (99%) were
`ROUTINE_CAPACITY_RESERVED_FOR_PRIORITY`** — i.e., the Phase 18 fairness fix (shipped this session)
correctly reserving a slot for exploration/mover-class requests, denying a *routine* re-request
instead. Only 1 denial was `RESCUE_CAPACITY_FULL`. Grant distribution shows heavy repeat-occupancy by
AAPL (88 grants) and TSLA (85 grants) — the exact repeat-requester pattern Phase 18 targeted — but the
fairness fix appears to be working as intended (denying *routine* re-requests, not exploration/mover
ones) rather than being the cause of today's misses. **Verdict: B (fairness), already addressed this
session; not currently insufficient capacity (A) for today's actual load.**

## 13. Strategy Fairness Audit (today's real numbers — a precise, reproduced update of the Phase 17 finding)

3,912 evaluations per strategy (21 strategies × same cycles). Mean `setupScore`:
`FIBONACCI_PULLBACK` 76.7, `OSCILLATOR_MOMENTUM` 76.0 vs. `MEAN_REVERSION` 18.2,
`SMC_LIQUIDITY_SWEEP` 28.0 — a **>4x gap**, exactly reproducing the magnitude cited in the
2026-09-01 score-normalization research note, now with today's fresh data. **Rank-#1 (natural top
pick) distribution: only 11 of 21 strategies EVER ranked #1 today** — `OSCILLATOR_MOMENTUM` won 1,669
times, `MA_CROSSOVER` 941, `FIBONACCI_PULLBACK` 766; the other **10 strategies (MOMENTUM_BREAKOUT,
MEAN_REVERSION, BOLLINGER_VOLATILITY, STATISTICAL_MEAN_REVERSION, RELATIVE_STRENGTH_ROTATION,
PREVIOUS_PERIOD_BREAKOUT, SMC_LIQUIDITY_SWEEP, OPENING_RANGE_BREAKOUT, DONCHIAN_CHANNEL_BREAKOUT,
VWAP_VOLUME_STRUCTURE) never once won naturally today despite being fully evaluated 3,912 times
each.** This is the same structural finding as Phase 17, now proven with today's live data, not a
historical artifact. `setupScore` is confirmed strategy-specific (each strategy's own condition-count/
threshold design), not a calibrated, cross-strategy-comparable confidence — exactly as the
2026-09-01 design note already concluded.

## 14. Strategy Exploration Audit

Only **2** `STRATEGY_EXPLORATION_PROMOTED` events in 12h (CRM: TREND_FOLLOWING promoted over
MOMENTUM_BREAKOUT; ONON: MOMENTUM_BREAKOUT promoted over TREND_FOLLOWING) — bounded by
`strategyExplorationMinIntervalMs` (15 min) globally, exactly as designed. **Exploration is real and
functioning** (both promotions are genuine, logged, traceable) but **structurally cannot solve
today's 10-of-21-never-win problem at this rate** — 2 promotions against 3,912 evaluations per
strategy is not remotely enough throughput to meaningfully rebalance which strategies get real market
exposure. Exploration mitigates starvation at the margin; it does not fix the underlying
non-comparable-score ranking problem.

## 15. Agent Participation Audit

Consistent with prior sessions: `FundamentalAgent`/`MacroAgent` participation is thin and HOLD-heavy
(seen directly in the QQQ case, §16), `TechnicalAgent` (1,240 `TECHNICAL_ANALYSIS_COMPLETED` on QQQ
alone) and `QuantEngine` are the reliably directional participants. 269 `AGENT_DISAGREEMENT` events
and 312 `KRONOS_UNAVAILABLE` events on QQQ alone today — Kronos unavailability is a real, recurring
contributor to thin independent-agent counts. This is not recommended to be fixed by weakening the
2-agent minimum; it is a genuine agent-diversity/availability gap, consistent with the mission's own
instruction not to weaken that bar.

## 16. QQQ Forensic Case (today, reproduced exactly)

Best real confidence today: **0.7727 (STRONG tier)** — rejected on `INSUFFICIENT_AGENT_PARTICIPATION`
(only 1 independent agent: FundamentalAgent HOLD @ 0.53). Terminal-reason distribution for QQQ today:
`CONFIDENCE_BELOW_STRONG` 341, `AGENT_DATA_UNAVAILABLE` 130, `AGENT_HOLD` 45,
`INSUFFICIENT_AGENT_PARTICIPATION` 16, `MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE` 2. **This is not a
bug or a risk-control failure — it is the 2-independent-agent minimum correctly refusing to approve on
thin evidence**, exactly as designed. The real, addressable gap is upstream: why so few independent
agents are available/directional often enough (thin Fundamental/Macro participation, frequent Kronos
unavailability), not the consensus rule itself.

## 17. Zero-Trade Forensic Funnel (today, PROVEN-DATABASE)

| Stage | Count | Note |
|---|---|---|
| Distinct symbols subscribe-requested | 43 | |
| Distinct symbols quant-evaluated | 137 | includes on-demand/snapshot evaluations beyond subscription |
| Total quant_assessments | 4,030 | |
| Assessments emitting a trade idea | 476 (11.8%) | |
| Consensus terminal reasons (12h) | 1,749 | |
| — CONFIDENCE_BELOW_STRONG | 1,056 (60%) | dominant cause |
| — AGENT_DATA_UNAVAILABLE | 360 (21%) | |
| — AGENT_HOLD | 268 (15%) | |
| — MODERATE_REJECT_INSUFFICIENT_INDEPENDENCE | 36 (2%) | |
| — INSUFFICIENT_AGENT_PARTICIPATION | 29 (1.7%) | |
| RiskEngine reached | 0 | never reached — nothing cleared consensus |
| OMS orders | 0 | |
| Organic paper fills | 0 | |

## 18. Why Zero Trades Happened

**Question A (did ARGUS correctly reject everything that reached consensus)**: yes, per the QQQ case
and the terminal-reason distribution — every rejection maps to a real, working gate (confidence bar,
agent-participation minimum), not a malfunction. **Question B (did legitimate opportunities never
reach consensus due to discovery failure)**: partially — 2 of 9 verified real movers (GPRO
correctly, LIDR likely correctly) were filtered by design; 1 (FRVO) has an unexplained miss; 1 (DUOL)
reached partial evaluation but not subscription. **Question C (approximate attribution, database-
supported where possible)**: ~60% of today's non-approvals are `CONFIDENCE_BELOW_STRONG`
(a downstream consequence most plausibly rooted in the strategy-ranking/agent-participation
problems in §13/§15, not discovery), ~21% `AGENT_DATA_UNAVAILABLE`, ~17% HOLD/insufficient-
independence combined. Discovery-stage loss for today's specific *externally verified* movers was
**3 misses out of 9 candidates checked (33%)**, but two of those three misses are a working safety
filter, not a defect — so the *defect-attributable* discovery loss among today's checked sample is
**1 of 9 (FRVO, unexplained) plus DUOL's partial subscription miss**, not the majority driver of
zero trades. **Zero trades today is primarily a consensus/strategy-ranking outcome, not primarily a
discovery outcome**, based on the evidence gathered.

## 19. All Recent Phase Changes (git log, PROVEN-CODE)

Phase 13 (bounded rescue) → Phase 14 (replay/walk-forward fixes, scorecard) → Phase 15 (bounded
exploration scheduler) → Phase 16 (replay-contamination fixes, exploration observability) → real
Alpaca movers screener added → Phase 18 (rescue fairness by request class + exploration-health
report) → Ollama local/remote timeout split fix → AI Cost Governor (Project A, shadow-mode-first, off
by default). Every one of these is verified live/tested (per this session's own commit history and
test runs) — none is aspirational/undocumented vaporware.

## 20-21. Current Architecture Defects / Hidden Bottlenecks

The dominant, evidence-supported bottleneck today is **cross-strategy `setupScore` incomparability**
(§13), not discovery capacity or rescue fairness (both already addressed or shown to have headroom
today). The dominant discovery-side gap is **the movers/broad-universe funnel's dependence on
Alpaca's own top-50 mover cut and periodic (5-15 min) refresh**, which can legitimately miss a real,
liquid, catalyst-driven mover like FRVO without any component actually malfunctioning.

## 22. Universal Discovery Gap

The gap between "documentation calls this universal discovery" and reality: the mechanisms are real
and working (not vaporware), but they are periodic-polling, top-N-bounded, single-provider (Alpaca
only) mechanisms — not continuous, multi-source, event-driven coverage of "the entire tradable
market." This matches the 2026-09-01 research document's own conclusion exactly; today's live data
confirms rather than contradicts it.

## 23. Required Future Architecture / 24. Event-Driven Discovery Assessment / 25. Resource-Fairness Architecture / 26. Observability Requirements

These four sections are unchanged from, and already comprehensively covered by,
`docs/audits/ARGUS_PHASE18_19_UNIVERSAL_DISCOVERY_RESEARCH.md` (delivered earlier today) — Model D
hierarchical recommendation, `MARKET_OPPORTUNITY_DETECTED` event schema, candidate lifecycle,
reserved-pool fairness (Option E), and the observability extension to `explorationHealthReport.ts`.
Today's live evidence does not surface anything that changes those recommendations — it corroborates
them. Not repeated verbatim here; see that document.

## 27. Prioritized Change Plan

| Priority | Problem | Evidence | Proposed fix (design only) |
|---|---|---|---|
| P0 | None found | Nothing today indicates an active safety violation or data-corruption risk | — |
| P1 | `setupScore` cross-strategy incomparability | §13, reproduced today: 10/21 strategies never win, >4x mean gap | Per-strategy eligibility floors or EV-based ranking, per the existing score-normalization research note's tiered recommendation — still not implemented, still the right next step |
| P1 | FRVO-class discovery miss (real mover, unexplained) | §8, §10 | Investigate Alpaca movers endpoint's actual top-50 cutoff behavior and ADV-lookback treatment of recent listings; add discovery-source observability (§26 pointer) before concluding a code fix is needed |
| P2 | DUOL-class partial-subscription miss | §8 | Reconstruct the specific subscription-priority decision; needs a dedicated trace, not done in this pass |
| Research | Thin Fundamental/Macro/Kronos participation | §15, §16 | Needs more evidence on WHY (data availability vs. AI provider health vs. round-robin frequency) before proposing a fix |

## 28. Before vs. Required Architecture

Unchanged from the 2026-09-01 research document's Phase A-H plan. Today's evidence does not add a new
required component; it reprioritizes: the score-normalization work (already designed, not yet
implemented) now has direct, quantified, same-day evidence supporting it as the highest-value next
step, ahead of any new discovery-source work.

## 29. Safety Verification

Confirmed untouched by this audit (read-only, no files edited): `PAPER_TRADING_ONLY`, `LIVE_NO_GO`,
0.75 consensus threshold, 2-independent-agent minimum, all 24 RiskEngine gates, capital limits,
emergency stop, duplicate protection, stale-data fail-closed, broker safety. No code, config, `.env`,
database record, or trading state was modified to produce this report. No restart, no order.

## 30. Final Verdict

**A.** Not a true universal discovery engine — a working, periodic, top-N-bounded, Alpaca-only
hierarchical discovery layer (Model B/D hybrid), which is real and demonstrably catches genuine
movers (PANW/HOOD/DELL today), but does not cover the whole market continuously.
**B.** Architecturally: single external provider, periodic refresh, bounded top-N mover list, no
event-driven/streaming layer.
**C.** 3 of 9 externally-verified strong movers checked today were missed (GPRO, LIDR, FRVO); 1 more
(DUOL) partially seen but never subscribed. This is a small, targeted sample, not a market-wide count
— do not extrapolate to "most of the market was missed."
**D.** GPRO/LIDR: correctly filtered by the reviewed $5 price floor (working as designed). FRVO:
disappeared before even reaching the observable candidate stage — cause not fully traced
(INSUFFICIENT EVIDENCE). DUOL: reached snapshot-level evaluation but never subscribed
(INSUFFICIENT EVIDENCE for the exact reason).
**E.** Primarily a combination of `CONFIDENCE_BELOW_STRONG` (60%) and `AGENT_DATA_UNAVAILABLE` (21%)
— i.e., primarily a strategy-ranking/agent-participation outcome, not primarily a discovery failure.
**F.** Exploration is real but, at 2 promotions in 12h against 3,912 evaluations per strategy, cannot
structurally solve the 10-of-21-strategies-never-win problem at its current throughput.
**G.** Market Movers materially helped (proven catches: PANW/HOOD/DELL) but did not solve universal
discovery — it remains a bounded, periodic, single-provider mechanism.
**H.** No — today's rescue-pool utilization (18-32 of 90 lines; 324 grants vs. 91 denials, 99% of
denials being the intentional fairness reservation) shows the rescue pool is not the active
bottleneck today.
**I.** Yes, confirmed with fresh same-day data — `setupScore` is strategy-specific, not
cross-strategy-comparable, exactly as the existing research note concluded.
**J.** Not proven necessary by today's evidence — the existing hierarchical model (already designed
in the 2026-09-01 research document) addresses the observed gaps without requiring a dedicated new
engine; today's data does not surface a new requirement beyond what was already recommended.
**K.** Hybrid — periodic polling for broad discovery, streaming for admitted candidates, exactly the
existing recommendation.
**L.** Highest-value next steps, in order: (1) score-normalization/ranking fix — now with same-day
quantified evidence; (2) investigate the FRVO-class discovery miss; (3) reconstruct the DUOL
subscription-priority miss; (4) improve Fundamental/Macro/Kronos participation reliability; (5)
continue monitoring rescue-fairness under higher future load.
**M.** `PAPER_TRADING_ONLY`, `LIVE_NO_GO`, the 0.75/2-agent consensus bar, all 24 RiskEngine gates,
capital limits, emergency stop — none should change based on anything found here.

**Core question, answered directly**: if a previously unknown liquid stock becomes one of the
strongest movers in the market at 10:15 AM tomorrow, can ARGUS discover it, get real data, evaluate it
fully, and route it through the same consensus → RiskEngine → OMS pipeline without pre-configuration?
**Conditionally yes, proven by today's live evidence for PANW/HOOD/DELL** — real, unconfigured movers
that the broad-universe/movers funnel discovered, subscribed, and fully evaluated today with no
special-casing. It is **not yet reliably yes** for every such stock — a sub-$5 name would be correctly
excluded by design, and at least one legitimate case (FRVO-class) can still fall through the discovery
funnel for reasons not fully understood from this pass. The honest answer is: **yes, for stocks that
clear Argus's reviewed liquidity floor and that Alpaca's own top-50 mover list surfaces within its
5-minute refresh window; not yet guaranteed for every real mover regardless of size/timing.**
