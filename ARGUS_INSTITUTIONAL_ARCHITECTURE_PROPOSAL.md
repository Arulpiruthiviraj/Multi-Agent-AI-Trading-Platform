# ARGUS → Institutional-Grade Quant Platform
## Architecture Change Proposal

**Date:** September 29, 2026
**Status:** Proposed target architecture and staged migration plan — NOT YET IMPLEMENTED beyond what's explicitly marked as done in follow-up notes.
**Principle:** Extend and refactor the existing Argus architecture. Do not rewrite or bypass the protected trading spine.

### Purpose

Transform Argus from a well-engineered, single-process AI-assisted trading platform into a deterministic, reproducible, research-driven quantitative trading platform using structural patterns common in mature systematic trading systems.

The target is not to reproduce any specific vendor or platform. The relevant architectural ideas are those commonly seen in systems such as QuantConnect/LEAN, Zipline-style research environments, columnar historical-data stores, factor-risk platforms, and institutional OMS/EMS architectures.

This proposal is grounded in the current Argus implementation, including `server.ts`, SQLite/Drizzle persistence, `ChiefTraderAgent`, the RiskEngine gate ladder, `BacktestEngine`, `canonicalNextBarEngine`, `quant-core-java`, replay/PIT infrastructure, OMS/BrokerManager, and the existing observability and testing framework.

---

# 0. Core Architectural Principle

The most important transition is:

> **Deterministic quantitative logic must become the authority for trading decisions. AI/LLMs should become bounded advisory components rather than authoritative components of the order-generating path.**

Institutional systematic trading infrastructure places very high value on:

- deterministic decisions,
- reproducibility,
- point-in-time correctness,
- backtest/live parity,
- traceability,
- controlled execution,
- measurable risk,
- measurable transaction costs.

Argus already has many of the necessary foundations: deterministic strategies, Java quantitative engines, replay infrastructure, RiskEngine, OMS, strong auditability, and extensive testing.

The architecture should therefore **invert authority**, not replace the system:

```text
TODAY

Quant / Technical / Java / AI evidence
                 ↓
          ChiefTrader
                 ↓
          AI debate can
       influence live outcome
                 ↓
             RiskEngine
                 ↓
                OMS


TARGET

Market + PIT Data
       ↓
Deterministic Quant Evidence
       ↓
Deterministic Decision Engine
       ↓
Target Portfolio
       ↓
Portfolio / Risk Constraints
       ↓
OMS
       ↓
Execution

              AI / LLM
                 ↓
        advisory / explanation /
      research / anomaly review
```

Given identical point-in-time inputs and configuration, Argus should be capable of producing the **same quantitative decision repeatedly**.

That property is foundational to everything that follows.

---

# 1. Current Position vs Institutional Quant Architecture

| Capability | Institutional expectation | Argus today | Gap |
|---|---|---|---|
| Deterministic signals | Required for systematic production | Strong deterministic engines exist, but AI/LLM reasoning remains involved in the decision architecture | **Critical** |
| Research/live parity | Same strategy semantics across research, replay and production | Shared components exist, but multiple execution/fill assumptions remain | **High** |
| Point-in-time data | PIT-correct history, corporate actions, delistings, survivorship controls | SQLite OHLCV + partial PIT/replay infrastructure | **High** |
| Market-data storage | Purpose-built historical/time-series store | SQLite operational DB also carries historical data | **High at scale** |
| Portfolio construction | Portfolio-level allocation/optimization | Primarily fixed-dollar sizing; Java optimization engines remain research-oriented | **Medium–High** |
| Portfolio risk | Factor exposure, concentration, covariance, VaR/ES, scenario risk | Excellent pre-trade gate architecture, weaker continuous portfolio-risk model | **Medium–High** |
| Execution | Order-type intelligence + measured execution quality | OMS/BrokerManager are strong; execution intelligence remains limited | **High** |
| Transaction Cost Analysis | Explicit implementation-shortfall / cost attribution | Foundations exist in execution attribution | **Medium** |
| Alpha validation | OOS, WFO, PBO, multiple-testing defenses | Strong foundation already exists | **Good** |
| Deployment structure | Clear service/module ownership | Single Node process | **Medium / future scaling issue** |
| Observability | Full decision/order lineage | Strong event/trace architecture | **Strong** |
| Simulation clock | Deterministic simulated time | Replay clock exists | **Strong foundation** |
| Testing / safety | Extensive deterministic validation | Large test suite, architecture boundaries, fail-closed behavior | **Strong** |

### Interpretation

Argus should preserve its existing strengths:

**Risk controls, OMS ownership, observability, testing, replay infrastructure, fail-closed semantics and Java/Node separation.**

The primary architecture gaps are instead:

```text
determinism
        ↓
point-in-time data
        ↓
portfolio construction
        ↓
portfolio risk
        ↓
execution quality
        ↓
formal research lifecycle
```

---

# 2. Target Architecture

The long-term decision model should become **portfolio-target based** rather than simply “signal → order”.

```text
                 ┌─────────────────────┐
                 │ Market Data Service │
                 └──────────┬──────────┘
                            │
                 ┌──────────▼──────────┐
                 │ PIT / Feature Store │
                 └──────────┬──────────┘
                            │
              ┌─────────────▼─────────────┐
              │ Deterministic Signal Core │
              │ TS + Java Quant Engines   │
              └─────────────┬─────────────┘
                            │
                     QuantEvidence
                            │
              ┌─────────────▼─────────────┐
              │ Decision / Ensemble Layer │
              └─────────────┬─────────────┘
                            │
                     expected returns /
                       confidence /
                     uncertainty / costs
                            │
              ┌─────────────▼─────────────┐
              │ Portfolio Construction    │
              │ optimizer / risk budgets  │
              └─────────────┬─────────────┘
                            │
                      target portfolio
                            │
              ┌─────────────▼─────────────┐
              │ Portfolio Risk /          │
              │ Existing RiskEngine       │
              └─────────────┬─────────────┘
                            │
                    approved target delta
                            │
              ┌─────────────▼─────────────┐
              │ OMS / Execution Service   │
              └─────────────┬─────────────┘
                            │
                       BrokerManager
                            │
                    IBKR / other adapters


        LLM / AI Advisory Sidecar
                 │
                 ├─ explanation
                 ├─ news interpretation
                 ├─ research assistance
                 ├─ anomaly review
                 └─ shadow predictions

        NO DIRECT ORDER AUTHORITY
```

---

# 3. Staged Architecture Program

## Phase A — Determinism and Research/Production Parity

This is the highest-priority phase.

### A1. Remove LLM authority from the execution decision path

Keep the valuable deterministic parts of `ChiefTraderAgent`:

- evidence-family independence,
- confidence aggregation,
- calibration,
- disagreement handling,
- deterministic thresholds.

Refactor the final decision into something conceptually equivalent to:

```text
DeterministicVerdict {
    side
    confidence
    independentEvidenceGroups
    expectedReturn
    expectedCost
    netExpectedReturn
    uncertainty
    approve
    reasons[]
}
```

The output must depend only on:

```text
PIT market data
deterministic features
quantitative model outputs
persisted calibration state
versioned configuration
```

The LLM debate becomes:

```text
ADVISORY_ONLY
```

Its output may provide:

- explanation,
- anomaly warnings,
- research commentary,
- human-review flags,
- shadow predictions,
- disagreement analysis.

But it must not independently convert:

```text
REJECT → APPROVE
```

or:

```text
APPROVE → REJECT
```

in the systematic execution path.

This creates the fundamental guarantee:

> Given identical PIT inputs, configuration, model versions and portfolio state, Argus can reproduce the same quantitative decision.

---

## A2. One promotion-grade simulation/execution model

Keep quick smoke-test backtests if useful, but establish one canonical promotion-grade execution model.

`canonicalNextBarEngine` should become the reference semantics unless later evidence justifies another model.

Conceptually:

```text
signal formed at T
        ↓
order becomes eligible after information at T
        ↓
execution at T+1 using realistic execution assumptions
```

Backtests must never assume execution using information unavailable at decision time.

Research and production should differ primarily in:

```text
Simulated fill source
vs
Broker fill source
```

—not in strategy semantics.

Build a **parity harness**:

```text
historical PIT window
      ↓
live production decision code
      ↓
orders produced

COMPARE WITH

same PIT window
      ↓
canonical backtest
      ↓
orders produced
```

Differences must be explainable.

---

## A3. First-class deterministic clock

Generalize `ReplayClock` into an injected clock abstraction:

```text
Clock {
    now()
}
```

Implementations:

```text
LiveClock
ReplayClock
BacktestClock
SyntheticClock
```

Decision-critical code should not directly rely on `Date.now()`.

This enables deterministic:

```text
replay
backtesting
synthetic testing
failure reproduction
```

---

# Phase B — Institutional Data Plane

## B1. Separate operational persistence from historical market data

Keep SQLite/Drizzle for operational state:

```text
orders
fills
trades
portfolio state
configuration
decision traces
risk decisions
strategy registry
audit history
```

Move large historical market data away from the operational DB.

A practical single-machine first step:

```text
Parquet
  +
Arrow
  +
DuckDB
```

This provides:

- columnar compression,
- vectorized analysis,
- efficient historical scans,
- low-cost storage,
- easy Python/Java/Node interoperability.

Larger deployments could later move to:

```text
ClickHouse
TimescaleDB
ArcticDB
```

without changing strategy code.

Maintain an abstraction such as:

```text
HistoricalDataGateway
```

so callers do not know the physical storage engine.

---

## B2. Corporate actions and survivorship

Build explicit PIT handling for:

```text
splits
reverse splits
dividends
symbol changes
delistings
mergers
universe membership
```

Store both:

```text
raw historical price
adjustment metadata
```

and ensure backtests only use information known at the historical timestamp.

A 2023 simulation must not know a 2025 delisting outcome.

---

## B3. Versioned feature store

Formalize quantitative features into a versioned feature system.

Each feature should carry something equivalent to:

```text
featureName
featureVersion
definitionHash
calculationTimestamp
effectiveTimestamp
sourceDataVersion
```

A research experiment can then record:

```text
strategyVersion
featureVersions
dataVersion
configVersion
executionModelVersion
```

This makes experiments reproducible even after features evolve.

---

# Phase C — Portfolio Construction and Risk

## C1. Promote portfolio optimization from research

Argus already has Java quantitative portfolio components.

Promote them through the normal lifecycle:

```text
RESEARCH
   ↓
BACKTEST
   ↓
OOS
   ↓
WALK_FORWARD
   ↓
SHADOW
   ↓
PAPER
   ↓
VALIDATED
```

Do not immediately replace PositionSizing.

Instead evolve toward:

```text
Signals
   ↓
expected return / risk
   ↓
Portfolio Optimizer
   ↓
target weights
   ↓
PositionSizing / RiskEngine
   ↓
hard constraints
```

The optimizer proposes.

The existing safety architecture constrains.

---

## C2. Barra-inspired factor risk model

Do not attempt to reproduce proprietary MSCI Barra models.

Build a **Barra-inspired internal factor-risk framework** using transparent factors such as:

```text
market beta
size
value
momentum
volatility
sector
industry
liquidity
quality
```

Compute portfolio exposures continuously.

Add:

```text
covariance
marginal risk contribution
portfolio volatility
VaR
Expected Shortfall
concentration
factor contribution
```

Initially use these as:

```text
OBSERVABILITY / ADVISORY
```

Only promote a metric into a RiskEngine gate after sufficient validation.

---

## C3. Portfolio-level risk

Risk should evolve from:

```text
"Is this order safe?"
```

toward also answering:

```text
"What does this order do to the portfolio?"
```

For every candidate trade calculate:

```text
current portfolio risk
proposed portfolio risk
delta volatility
delta concentration
delta factor exposure
delta correlation
delta expected return
delta expected cost
```

The existing 25-gate architecture remains the protected safety boundary.

---

# Phase D — Execution and Transaction-Cost Intelligence

## D1. Execution algorithms

Keep OMS as the only order-authority path.

Introduce execution policies behind OMS:

```text
MARKETABLE_LIMIT
TWAP
VWAP
POV
PASSIVE_LIMIT
```

These do not need to be enabled immediately.

For small portfolios, sophisticated execution algorithms may provide little value, so promotion should be evidence-driven.

The purpose is establishing the architectural seam.

---

## D2. TCA as a feedback loop

Expand existing execution-quality infrastructure into full Transaction Cost Analysis.

Measure:

```text
decision price
arrival price
submitted price
fill price
spread
commission
slippage
market movement
implementation shortfall
```

Then estimate:

```text
expected transaction cost
```

before future trades.

The important decision variable becomes:

```text
netExpectedReturn
=
expectedReturn
-
expectedTransactionCost
```

A theoretically profitable signal whose expected edge is smaller than its expected cost should not be considered genuine alpha.

---

## D3. Broker-routing policy

Generalize `BrokerManager` into a configurable broker-routing layer.

Do **not** attempt to recreate exchange-level smart order routing if IBKR or another broker already performs it.

Argus routing should focus initially on:

```text
asset class
broker availability
cost
capabilities
jurisdiction/account eligibility
market-data availability
execution characteristics
```

For example:

```text
US Equities → IBKR
Crypto      → configured crypto-capable broker
Research    → InternalPaper
```

Broker identity remains immutable once an OMS order is created.

---

# Phase E — Service Decomposition

Do this late.

The current single-process architecture is not automatically a defect.

First enforce strong module boundaries around:

```text
Market Data
Signal Engine
Portfolio/Risk
Execution
Research
```

Then, only when operational or scalability evidence justifies it, extract services.

Possible future topology:

```text
MarketDataService
SignalService
PortfolioRiskService
ExecutionService
ResearchService
```

Communication could later move from the in-process EventBus to:

```text
NATS
Redis Streams
Kafka
```

depending on throughput and durability requirements.

Do not introduce distributed-system complexity before it buys something measurable.

---

## E2. Compute/orchestration split

Continue the existing pattern:

```text
Java
→ numerical / quantitative compute

TypeScript / Node
→ orchestration / APIs / events / broker integration / UI
```

That division is sensible.

Extend Java where workloads are genuinely:

```text
numerically intensive
parallelizable
portfolio mathematical
statistical
optimization-oriented
```

Do not move code to Java merely for architectural appearance.

---

# Phase F — Research Platform Maturity

## F1. Formal alpha research pipeline

Every strategy should follow one enforceable path:

```text
Hypothesis
   ↓
PIT Backtest
   ↓
Out-of-Sample
   ↓
Walk-Forward
   ↓
Robustness / Sensitivity
   ↓
Overfitting Tests
   ↓
Shadow
   ↓
Paper
   ↓
Validated
   ↓
Live eligibility
```

Argus already has important pieces.

Assemble them into a single lifecycle.

Add where justified:

```text
Deflated Sharpe Ratio
Combinatorial Purged Cross-Validation
Probability of Backtest Overfitting
parameter sensitivity
regime stability
cost stress
```

A strategy should not become execution-authoritative because someone changed a configuration flag.

Its validation evidence should authorize it.

---

## F2. Strategy lifecycle registry

Create one canonical strategy registry.

Example:

```text
Strategy {
    strategyId
    version

    state:
      RESEARCH
      BACKTEST_ONLY
      OOS_TESTING
      WALK_FORWARD_TESTING
      SHADOW
      PAPER
      VALIDATED
      LIVE_APPROVED
      REDUCED_INFLUENCE
      DISABLED
      RETIRED

    validationEvidence
    featureVersions
    modelVersion
    expectedPerformance
    observedPerformance
    driftState
}
```

This becomes the answer to:

> Why is this strategy allowed to influence trading?

---

# 4. Protected Architecture — Do Not Replace

These components should remain protected:

### RiskEngine

Keep the existing fail-closed gate architecture.

Extend it with new portfolio-risk evidence only after validation.

### OMS

OMS remains the sole order-authority path.

No:

```text
Java engine
Python service
LLM
strategy
agent
```

may directly place an order.

### BrokerManager

All broker execution continues through the broker abstraction.

### Reconciliation

Broker truth and internal state must remain continuously reconciled.

### Kill switch / trading-state machine

Remain authoritative.

### Observability and lineage

Continue investing heavily here.

Determinism becomes valuable only when the resulting decision can be reconstructed.

### Architecture-boundary tests

Expand them.

They should prove:

```text
strategies cannot execute
Java cannot execute
LLMs cannot execute
research cannot execute
replay cannot contaminate production
synthetic tests cannot reach LIVE
```

---

# 5. Recommended Sequencing

| Order | Phase | Reason |
|---|---|---|
| **1** | **A — Determinism & parity** | Nothing else can be trusted fully until the same PIT input produces reproducible decisions. |
| **2** | **B — Data plane** | Reproducible decisions are still wrong if historical inputs contain lookahead, survivorship or corporate-action errors. |
| **3** | **C — Portfolio & risk** | Once signals/data are trustworthy, turn individual signals into rational portfolio allocations. |
| **4** | **D — Execution/TCA** | Protect measured alpha from spread, slippage, commissions and market impact. |
| **5** | **F — Research maturity** | Enforce a rigorous strategy-validation and promotion lifecycle. |
| **6** | **E — Service decomposition** | Split processes only when scale/reliability requirements justify operational complexity. |

The critical path is:

```text
DETERMINISM
     ↓
POINT-IN-TIME DATA
     ↓
VALIDATED SIGNALS
     ↓
PORTFOLIO CONSTRUCTION
     ↓
RISK
     ↓
EXECUTION COST
     ↓
MEASURED REAL-WORLD EDGE
```

---

# 6. Definition of the Target Argus

Argus should eventually be better described as:

> **A deterministic quantitative research, portfolio-construction, risk-management and execution platform with AI-assisted research and interpretation.**

rather than:

> an AI multi-agent trading bot.

AI remains useful, but its appropriate role becomes:

```text
research
news interpretation
hypothesis generation
explanation
anomaly analysis
post-trade analysis
developer assistance
shadow predictions
```

The actual trading authority should increasingly come from:

```text
data
statistics
validated models
portfolio optimization
risk constraints
execution economics
```

---

# 7. Success Criteria

The architecture transformation is successful when Argus can answer, reproducibly:

```text
What data did this decision see?

What version of every feature was used?

Which strategy generated the signal?

What was its validated historical evidence?

What independent evidence supported it?

What was the expected return?

What was the uncertainty?

What were expected transaction costs?

Why was this target position selected?

What portfolio risk did it add?

Why did RiskEngine approve it?

Why was this execution method selected?

What actually filled?

What did the trade cost?

Was realized behavior consistent with research expectations?

Has the strategy's edge degraded?
```

And the same historical decision can be reconstructed later from persisted PIT state.

---

# 8. Explicit Non-Goals

This program is **not** intended to:

- generate more trades by weakening standards,
- lower the consensus threshold to manufacture activity,
- create guaranteed returns,
- maximize win rate,
- replace RiskEngine,
- replace OMS,
- create an alternate Java execution path,
- turn Argus into premature microservices,
- use complexity as a substitute for alpha.

Architecture exists to make real edge **measurable, reproducible and survivable**.

---

# 9. Final Architectural Principle

The long-term Argus loop should become:

```text
DATA
 ↓
FEATURES
 ↓
ALPHA MODELS
 ↓
CALIBRATION
 ↓
EXPECTED RETURN / RISK / UNCERTAINTY
 ↓
PORTFOLIO CONSTRUCTION
 ↓
RISK CONSTRAINTS
 ↓
EXECUTION
 ↓
TCA
 ↓
REALIZED OUTCOME
 ↓
ATTRIBUTION / DRIFT / LEARNING
 ↓
RESEARCH
```

with AI operating around that loop rather than controlling it.

### Final caveat

This architecture does **not create alpha**.

What it creates is something more fundamental: the ability to distinguish real alpha from noise.

A mature Argus should be capable of determining whether a strategy's apparent edge survives:

```text
point-in-time data
out-of-sample testing
market regime changes
transaction costs
slippage
portfolio interaction
execution
live/paper drift
```

That is the real transition from **“AI trading application”** to **“quantitative trading platform.”**

---

## Implementation log (appended as work proceeds — this proposal document itself stays as originally written above)

- **2026-10-01**: Proposal received and saved. Before implementing, surveyed existing infrastructure
  for overlap (Clock abstractions, strategy lifecycle/promotion registries, TCA/execution-quality) to
  avoid rebuilding what already exists — real, concrete findings below, from reading actual source
  files, not from CLAUDE.md summaries.

### A3 (deterministic clock) — IMPLEMENTED, narrowly

**Found:** `ReplayClock.ts` already exists but is narrower than the proposal assumes — its real job
is a look-ahead-bias assertion (`assertNotFuture`), not a general time source. `SyntheticMarketClock`
already extends it correctly (good prior art for the "one hierarchy, multiple implementations"
pattern). No general `interface Clock` existed anywhere; live code just calls `Date.now()` directly.
Decision-critical `Date.now()` call counts found: `RiskEngine.ts` 7 (one already replay-aware at line
307, one deliberately NOT replay-aware at line 554 for a real reason — an SQL query bound against a
wall-clock `created_at` column), `ChiefTraderAgent.ts` 11 (zero replay-aware — cooldowns/TTLs/
throttles run on real wall-clock time even inside a replay), `OrderManagement.ts` 6 (zero
replay-aware), `PositionSizing.ts` 0 (pure math, clock-independent).

**Implemented:** `src/server/core/Clock.ts` — minimal `interface Clock { now(): number }` +
`LiveClock` (trivial `Date.now()` wrapper). `ReplayClock` now explicitly `implements Clock` (a
non-breaking type annotation — it already had `now()`). `SyntheticMarketClock` satisfies `Clock`
automatically via its existing inheritance. 4 new tests (`Clock.test.ts`), all passing; full
`backtest/` + `SyntheticMarketClock.test.ts` suites (106 tests) re-run green, confirming zero
behavior change.

**Deliberately NOT done this pass:** retrofitting the 18 combined `Date.now()` call sites in
`ChiefTraderAgent.ts`/`OrderManagement.ts` to accept an injected clock. That's materially larger and
riskier than the interface itself (those sites drive live cooldown/TTL/timeout semantics, and
RiskEngine's own mixed real/simulated-time handling shows "always inject the simulated clock" isn't
even uniformly correct) — real future work, not a quick extension.

### F2 (strategy lifecycle registry) — NOT attempted; genuinely riskier than the proposal assumes

**Found:** THREE independently-evolved, overlapping lifecycle vocabularies already exist, not one:
(1) `strategiesEngine/core/evidence.ts`'s `EvidenceState` (persisted to `strategy_engine_promotions`),
(2) `research/promotionEngine.ts`'s `StrategyLifecycleStatus` (near-verbatim the proposal's own state
list — likely what the proposal's author actually read — purely derived, feeds the platform-wide
LIVE go/no-go gate via `liveReadinessEngine.ts`), (3) `quant/strategies/StrategyEmissionEligibility.ts`'s
*own*, differently-named `StrategyLifecycleStatus` (persisted via `learning_versions`, wired into
real-time idea generation via `QuantSignalAgent.ts`'s `filterQuarantinedStrategies`). Plus a 4th/5th
status column on `strategy_candidates` (`lifecycleStatus` mirroring #2, plus an orthogonal
`championStatus`). (2) and (3) are BOTH genuinely load-bearing in different parts of the live
pipeline — unifying them is a real migration touching ~15 combined consumer files, not a
"low-risk Phase A" change. **Not implemented. Recommend a dedicated, separately-scoped task if this
is wanted**, starting from extending (2) (the most central) rather than inventing a 4th system.

### D2 (TCA / netExpectedReturn) — NOT wired in; the wiring step has an explicit prior "wait" instruction in the source

**Found:** the proposal's entire D2 ask — measure real execution quality, estimate expected cost,
feed `netExpectedReturn = expectedReturn - expectedTransactionCost` back into decisions — is
**already built**, end to end, as a deliberately SHADOW/observability-only pipeline:
`executionQuality.ts` (real arrival price, slippage, fill latency, cancel rate) →
`canonicalCostModel.ts` (real commission + worst-of cost quality) → `forecastEngine.ts`'s
`resolveExpectedCost()`/`netExpectedReturn` (real computation, gated on `MEASURED` cost quality only).
Confirmed via grep: zero imports of `forecastEngine.ts` in `ChiefTraderAgent.ts`/`RiskEngine.ts`/
`PositionSizing.ts`/`OrderManagement.ts` — nothing in the decision path consumes it today. Critically,
`forecastEngine.ts`'s own header comment states this was an **explicit, named prior operator
instruction**: *"do not let ChiefTrader, RiskEngine, PositionSizing, or OMS consume the new fields
yet."* **Not wired in this pass** — reversing that explicit instruction needs its own fresh
go-ahead, not an inference from "implement as much as possible" on a much broader proposal. Also
worth deciding before wiring it in regardless: `resolveExpectedCost()` is currently a single global
rolling average across all strategies/symbols, not per-symbol/per-strategy — likely too blunt for
real decision-time use as-is.
