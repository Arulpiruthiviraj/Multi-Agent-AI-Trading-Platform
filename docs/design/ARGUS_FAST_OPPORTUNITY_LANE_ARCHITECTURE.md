# Argus Fast Opportunity Lane — Architecture

**Date:** 2026-10-05
**Status:** RESEARCH / PAPER ONLY. `FAST_OPPORTUNITY_LANE_ENABLED=false` by default.
**Mode:** Additive. The normal discovery lane is preserved untouched.

---

## Problem

October 5, 2026 forensic evidence showed Argus couples opportunity discovery
too tightly to scarce streaming-subscription allocation:

- PTC: catalyst ~08:16 ET → first challenger scoring ~10:37 ET (**141-minute gap**)
- MPWR: 2 admissions, 0 challenger appearances (lost in top-N truncation)
- Broad universe pool at 90/90 with 1 swap per cycle
- TSLA generated 2,162 ideas but consensus had weak independent confirmation

The 90-line subscription allocator answers "which symbols deserve scarce
streaming resources?" — but it was implicitly also answering "which symbols
can Argus evaluate?" Those are different questions and must be separated.

## Architecture

```
BROAD MARKET OBSERVATION (snapshots / bars / news / SEC)
        │
        ├─► NORMAL LANE: broad scanner → ranking → aging → 90-line alloc
        │
        └─► FAST LANE: NEWS_CATALYST / PRICE_ACCEL / RVOL_SPIKE / RS / OR
                │
                ▼
        OPPORTUNITY CANDIDATE (typed, no broker authority)
                │
                ▼
        FAST DATA TIER 1 (snapshot + bars, no streaming slot needed)
                │
                ▼
        STRATEGY / QUANT (existing engines)
                │
                ▼
        CHIEFTRADER → RISKENGINE → OMS (existing, untouched)
```

### Key separations

1. **Resource priority** ("should this symbol consume a streaming slot?") is decided
   by the existing 90-line scheduler. Unchanged.

2. **Trade eligibility** ("does this symbol satisfy a valid quantitative setup?")
   is decided by strategy evaluation against absolute contracts, fed by Tier-1
   data that does NOT require a streaming slot.

3. A symbol losing a streaming slot NEVER means Argus cannot evaluate it.

### Data tiers

- **Tier 0:** Broad observation (snapshots, news, periodic bars) — already have it
- **Tier 1:** Candidate interrogation (fresh single-symbol snapshot + recent bars)
- **Tier 2:** Temporary stream for serious candidate (1 of 90 slots, time-bounded)
- **Tier 3:** Protected stream (active setup / pending order / open position)

A candidate must NOT require Tier 2/3 residency merely to determine whether
it deserves evaluation. Tier 1 (implemented: `fetchTier1Snapshot()`) is
sufficient for preliminary strategy evaluation.

### Safety boundary

The fast lane terminates at the SAME protected spine. There is NO
FastOrderService, NO FastBrokerPath, NO DirectPlaceOrder, NO RiskBypass.
Architecture tests (`fastLaneArchitecture.test.ts`) enforce this.

### Feature flag

`FAST_OPPORTUNITY_LANE_ENABLED` (default `false`). PAPER/research only.
Fails closed for LIVE. Documented in `.env.example`.

## Components (implemented 2026-10-05)

- `fastlane/FastOpportunityCandidate.ts` — typed research object
- `fastlane/FastLaneManager.ts` — lifecycle with TTL expiration
- `fastlane/fastLaneConfig.ts` — flag with LIVE fail-closed
- `fastlane/fastLaneData.ts` — Tier-1 snapshot fetch
- `fastlane/fastLaneEventInjector.ts` — NEWS_CATALYST → candidate
- `fastlane/fastLaneObservability.ts` — 8 observability events
- `fastlane/replay/` — replay contract, runner, Oct 5 scenario

## Inventory findings

**Data:** Alpaca IEX snapshots production-proven. IBKR is execution-only
(no real-time entitlement). Delayed-data isolation correct and preserved.

**Strategies:** ORB is the only true intraday strategy (experimental).
Minutes-scale momentum, intraday RS, VWAP continuation, ATR breakout,
post-news momentum all need building in `quant-core-java/` per repo convention.
All experimental strategies are UNVALIDATED.

**Consensus:** QuantEngine ↔ JavaCoreEnsemble double-vote at 1.15 combined
weight. Five price-derived families = 2–3 effective voices, not 5.
News/Fundamental/Macro are genuinely orthogonal.

## Open work

1. Lane runner: detectors → candidate → strategy eval → ChiefTrader
2. Intraday strategies in Java (momentum, RS, VWAP, ATR, news-momentum)
3. Consensus weight fix (independence grouping in weighted math)
4. Historical validation across many sessions
5. Tier-2 temporary stream promotion

## What this does NOT do

- Does not replace the normal lane
- Does not bypass any safety gate
- Does not lower consensus threshold, evidence floor, or risk gates
- Does not claim profitability
