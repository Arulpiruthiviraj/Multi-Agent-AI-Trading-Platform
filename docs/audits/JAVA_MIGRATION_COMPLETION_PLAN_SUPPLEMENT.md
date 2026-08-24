# Java 26 Migration Completion Plan — Supplement

This is a **supplement**, not a third full re-audit. Everything already covered by
`docs/audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md` (2026-08-21) and
`docs/audits/JAVA_QUANT_ENGINE_ARCHITECTURE_CORRECTION_AUDIT.md` (this session — capability matrix,
per-arrow runtime proof, safety PASS/FAIL) is **not repeated here** — read those first. This document
adds exactly the two things the latest request asks for that aren't already in either: a **hidden
engine-logic sweep** (Phase 5's ask — calculations embedded in files not named `*Engine*`/`*Strategy*`)
and a **file/function-level migration item list** in the requested template. CLAUDE.md/README.md's
Java-authority sections were already added earlier this session — not re-added a third time.

---

## 1. Executive Verdict

**NODE/TS ENGINE MIGRATION: PARTIAL — same verdict as the prior audit, not revised.** No new evidence
this pass changes that. The hidden-logic sweep below found two additional real, deterministic
calculations outside the already-known set, both **reporting/observability math over already-decided
trades, not pre-trade decision logic** — they do not change the "is Java authoritative for anything
live" answer (still no).

## 2. Hidden Engine Logic Sweep (Phase 5)

Grepped `src/server/services/*.ts`, `src/server/agents/*.ts`, `src/server/core/*.ts` for statistical/
scoring vocabulary (`Score`, `riskRewardRatio`, `expectedValue`, `winProbability`, `stdDev`,
`variance`) outside files already named for it. Two real hits, both read in full:

| File | Calculation | Classification | Migration relevance |
|---|---|---|---|
| `src/server/services/AgentSynergy.ts` | Real Pearson correlation between agents' directionally-signed confidence, aligned by (symbol, day), `MIN_OVERLAPPING_DAYS`-gated (null below threshold, never fabricated) | **C. MIXED** — real deterministic math, but read-only reporting over already-persisted `agent_predictions`, not a pre-trade decision | Low-frequency, small-N, not a throughput bottleneck — **not** a migration candidate under Phase 8's own "do not migrate simply because Java is faster; measure the bottleneck" rule |
| `src/server/services/PaperTradingValidation.ts` | Win rate, profit factor, expectancy, Sharpe — real, computed from real closed `trades` rows, sample-floor-gated (null below threshold) | **A. CONTROL PLANE ONLY** (observability/reporting surface, explicitly carved out of Java's charter by this task's own Phase 8 rule) | Not a migration candidate |

`technicalSignal.ts` (live TechnicalAgent's real RSI/MACD/BB rule math) and `QuantSignalAgent.ts`
(the real strategy/regime/EV orchestration) were already fully covered in the prior audit's capability
matrix — re-confirmed present, not re-tabulated here. No other hidden deterministic engine logic was
found in this sweep beyond what both prior audits already identified.

## 3. Migration Item List (the one confirmed real gap)

Only one gap changes the "is Java authoritative" answer for anything: the upstream feature-computation
pipeline. Everything else already parity-tested (indicators, statistics, 5 CORE strategies' decision
logic, Kelly/EV) has no further migration item — it's done, just unwired to live traffic pending this
one dependency.

```
ID: JMIG-001
CURRENT TS FILE: src/server/quant/RegimeEngine.ts, trend.ts, volume.ts, priceAction.ts,
                 supportResistance.ts, MarketContext.ts
CURRENT FUNCTION/CLASS: classifyRegime(), computeTrendFeatures(), computeVolumeFeatures(),
                 computePriceActionFeatures(), computeSupportResistanceFeatures(), getMarketContext()
EXACT RESPONSIBILITY: Compute the StrategyContext feature bundle (trend/volatility/priceAction/
                 momentum/volume/supportResistance/regime/marketContext) the 5 CORE strategies'
                 already-ported Java decision logic needs to run against real bars
JAVA TARGET PACKAGE: io.argus.quantcore.strategy.types / a new io.argus.quantcore.features package
JAVA CLASS: (not yet created)
INPUT CONTRACT: Bar[] (already the shared type both TS and Java use)
OUTPUT CONTRACT: StrategyContext (already ported as a Java data-shape record; only the computation
                 that fills it is missing)
RUNTIME CALLER: QuantSignalAgent.ts (live), FullArgusReplayEngine.ts (replay) - both would need to
                 call the Java bridge instead of the TS functions once this exists
PARITY REQUIREMENT: Byte-for-byte against real historical bars, same pattern as the existing
                 indicator/strategy parity tests (StrategyParityTest.java)
TEST REQUIREMENT: New Java unit tests + a TS-vs-Java parity suite before any live wiring
ROLLBACK STRATEGY: Trivial - TS remains the only wired path until parity is proven; Java version
                 stays shadow-only (QUANT_JAVA_CORE_ENABLED=true, QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED
                 stays false) for a real soak period before consideration
LEGACY TS REMOVAL CONDITION: Never removed until Java parity is proven AND a documented shadow-soak
                 period has run - matching the migration blueprint's own Phase 2→3 gate
PRIORITY: P2 (core strategy migration) - not P0/P1, since nothing is broken; this is the one
                 dependency blocking further live-authoritative migration, not a safety defect
```

No other migration items are warranted this pass — introducing new Java modules for the two
reporting-only hidden calculations (§2) would be scope creep with no measured performance justification,
which Phase 8's own rule explicitly forbids ("do not migrate simply because Java is faster").

## 4. Final Verdict Block (as requested)

```
HAS ALL ELIGIBLE NODE/TS ENGINE LOGIC MIGRATED TO JAVA 26?  NO
  GAP: JMIG-001 (feature-computation pipeline) - the only gap that blocks further live-authoritative
       migration. AgentSynergy.ts/PaperTradingValidation.ts (§2) are correctly TS-only reporting
       surfaces, not gaps.

CAN NEW ENGINE LOGIC BE ADDED TO TYPESCRIPT AFTER THIS POLICY?  NO (per CLAUDE.md's "Java 26 Engine
  Authority" section, added earlier this session)
CAN TYPESCRIPT ORCHESTRATION/CONTROL CODE STILL CHANGE?  YES
CAN JAVA BYPASS THE EXISTING TRADING SAFETY SPINE?  NO (re-confirmed: zero placeOrder/broker imports
  anywhere under quant-core-java/, unchanged from the prior audit)
ONE AUTHORITATIVE ENGINE OWNER PER CAPABILITY?  PASS (see the prior audit's capability matrix - no
  live duplicate-signal risk exists while both Java gating flags default false)

FULL TEST SUITE:  PASS (349 files / 2217 tests, this session's last full run)
JAVA TESTS:  PASS (128/128, this session)
PARITY TESTS:  PASS (all existing indicator/strategy/stats parity tests green)
TYPECHECK:  PASS
BUILD:  PASS
```
