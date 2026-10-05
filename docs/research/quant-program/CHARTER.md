# Argus Global Quant Research, Strategy Discovery & Implementation Program

**Charter date:** 2026-10-05
**Status:** Active — initial mission (broad survey + roadmap) in progress
**Owner directive:** Evidence-driven evolution of Argus into a serious quantitative research and trading platform. Knowledge accumulation first; implementation only for ideas that survive rigorous evaluation.

## Principles (binding)

1. **Do not invent alpha.** No strategy is profitable until independently tested. Popularity, publication, backtests, and ML complexity are not evidence.
2. **Label epistemic status.** Every claim is one of: VERIFIED FACT / RESEARCH FINDING / HYPOTHESIS / ASSUMPTION / INFERENCE / EXPERIMENTAL RESULT / UNSUPPORTED CLAIM.
3. **Additive, reversible changes.** Do not alter working Argus behavior without a demonstrated defect, mathematical incorrectness, material risk, or strong evidence.
4. **No mock data** as evidence. Real historical/live data only; mocks for isolated unit tests.
5. **No blind copying.** Understand the math, check licenses, reimplement cleanly, record source + license.
6. **All quant math in Java** (`quant-core-java/`), per the Java 26 Engine Authority (AGENTS.md). TS is the application shell.
7. **Strategy lifecycle is mandatory:** RESEARCHED → MATHEMATICALLY_SPECIFIED → IMPLEMENTED → UNIT_TESTED → BACKTEST_ONLY → OOS_TESTING → WALK_FORWARD_TESTING → PAPER_TESTING → VALIDATED → LIVE_APPROVED. A failed stage blocks promotion.
8. **Architectural layering:** DATA → FEATURES → ALPHA SIGNALS → FORECASTS → STRATEGY → PORTFOLIO CONSTRUCTION → RISK → EXECUTION → BROKER → PERFORMANCE ATTRIBUTION. Never mix layers.

## Directory layout

```
docs/research/quant-program/
  CHARTER.md                  # this file
  roadmap/
    ROADMAP.md                # ranked TOP 50/25/20/10 + research queue
  knowledge-base/
    schema.md                 # knowledge-base record schema
    entries/                  # one file per researched concept/strategy
  research-cards/
    template.md               # research card template (Phase 5)
    <strategy>.md             # completed cards
```

## Continuous research loop

DISCOVER → VERIFY SOURCE → EXTRACT IDEA → EXTRACT MATHEMATICS → IDENTIFY ECONOMIC RATIONALE → CHECK ARGUS → FORM HYPOTHESIS → DESIGN EXPERIMENT → IMPLEMENT IN RESEARCH ENV → BACKTEST → ROBUSTNESS → WALK-FORWARD → COMPARE WITH BASELINE → REJECT OR PROMOTE → RECORD FINDINGS

Failed strategies are recorded as valuable negative results, never discarded silently.

## Standing research questions (ask for every discovery)

1. Why should this make money? Who is paying this return?
2. Why hasn't competition arbitraged it away? Is it alpha or risk compensation?
3. Does it survive transaction costs? Out-of-sample? Different markets/regimes?
4. Was it data-mined? Did it weaken post-publication? One-period wonder?
5. Can Argus obtain the required data reliably? Does Argus already do this?
6. Does it diversify or duplicate? Could a simpler version work?
7. What are the operational failure modes? How fast could it decay?
8. What evidence would convince us to reject it?

## Relation to existing Argus systems

- Strategy lifecycle states map to the existing promotion/validation infrastructure (`docs/architecture/ARGUS_ARCHITECTURE.md`, Java Quant Core §).
- PAPER_TESTING uses the paper-trading spine (never live) via the established vote-service pattern (`eventBus.emitTradeIdea` → ChiefTrader → RiskEngine → OMS), one independent vote per strategy, all existing gates unchanged.
- The knowledge base prevents re-discovering the same ideas across sessions.
