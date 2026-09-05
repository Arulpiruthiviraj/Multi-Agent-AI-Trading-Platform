# Argus — Premarket Gap Analysis & Architectural Decision

**Phase 0 deliverable, part 2.** Builds on `ARGUS_SESSION_AWARE_TRADING_ARCHITECTURE.md` (the current-state audit). This document answers: given what already exists, what is actually missing, and which architecture (separate engine / same engine with session mode / hybrid) is correct — proven from the codebase, not assumed.

No code changes were made to produce this document.

---

## 1. The architectural decision (mission §28)

**Answer: Hybrid — but not the hybrid the mission brief sketched. The correct hybrid is: unify the two systems that already exist, don't build a third.**

The mission brief's proposed hybrid diagram (Discovery → session-aware orchestration → shared Java Quant → shared Agent Layer → shared ChiefTrader → session-aware Risk → shared OMS → Broker) is directionally right and nothing in this audit contradicts it. But it was written without knowing that `src/server/continuous/`'s Phase 4 series already *is* most of "Discovery / Intelligence" and "session-aware orchestration" — built 2026-08-26/27, already running in production, already producing a persisted thesis object with revalidation. Building a new premarket discovery/ranking/thesis system from scratch, as a naive reading of the mission brief might suggest, would be exactly the "second uncontrolled trading path" the mission explicitly forbids (§2), just built adjacent to the existing one instead of adjacent to ChiefTrader.

**The real architecture, stated precisely:**

```
                  SessionLifecycle (System A)
                  — session phase + app-state, single source of truth —
                              │
              ┌───────────────┴───────────────┐
              │                               │
   ComposableRanking (System B)      MissedOpportunityDetector (System B)
   + TradePlanBuilder (System B)     (reads System B's own telemetry)
   — reads SessionLifecycle's phase  
     instead of its own inline
     classifyMarketSession() call —
              │
              ▼
   Java Quant Engine (NEW component in ranking — does not exist today)
              │
              ▼
      Agent Confluence (existing agents, session-mode-aware)
              │
              ▼
   TRADE_IDEA_GENERATED  ← the ONLY new wire between System B and the
              │              protected spine; does not exist today, and
              │              per §5 below should not exist until specific
              │              preconditions are met
        ChiefTraderAgent (UNCHANGED)
              │
     Session-aware RiskEngine (extended, gate 12 + new
     ExtendedHoursExecutionPolicy check — everything else UNCHANGED)
              │
             OMS (extended: limit-order construction for extended-hours,
                   everything else UNCHANGED)
              │
        Broker (extended: real extended-hours order flags per adapter)
              │
        Reconciliation (UNCHANGED — already session-agnostic)
```

**Why not "separate premarket engine" (option A):** Rejected outright by evidence, not just principle. `ComposableRanking`/`TradePlanBuilder`/`MissedOpportunityDetector` already are a fully generic, session-agnostic scoring/thesis/revalidation system — they don't hardcode RTH, they take a `RankingInput` and produce a score regardless of when they're called. A separate premarket-only engine would duplicate this exact logic for no reason.

**Why not "same engine, just add a session mode" (option B) in the naive sense:** Also not quite right, because there isn't currently *one* engine — there are two, unaware of each other. "Add a session mode to the existing engine" presupposes a single existing engine to extend. The real first move is consolidation (§2), not mode-flagging.

**Why hybrid, precisely:** Discovery/ranking/thesis (System B) stays a shared, session-parameterized service — the same `ComposableRanking`/`TradePlanBuilder` code runs at 6am and 11am, with different *policy* (liquidity bar, confidence bar, execution eligibility) selected by session, not different *code*. It converges on the identical protected spine (ChiefTrader → RiskEngine → OMS → Broker → Reconciliation) that already exists and is already correctly protected. This matches the mission's own stated principle (§2) once you substitute "the systems that already exist" for "systems to be built."

---

## 2. Gap 1 (structural): two premarket systems, unintegrated

**Finding (from the audit doc, §10.4):** `SessionLifecycle` (System A) and the Phase 4 series (System B) never share state. `SnapshotScanner.ts` calls `classifyMarketSession()` directly instead of reading `SessionLifecycle`'s snapshot. `ApplicationSessionState`'s `PLAN_BUILDING`/`PLAN_READY`/`OPEN_REVALIDATION` values — which read as if designed for exactly what `TradePlanBuilder` does — are declared but never set.

**Gap:** No single source of truth for "what session/app-state is it," despite two systems that both need to know.

**Not a gap, already correct:** Both systems are independently, correctly isolated from the protected spine (enforced by `premarketArchitectureBoundary.test.ts` for System A, and governance comments + `architecture.protection.test.ts` for System B per `CLAUDE.md`).

**Recommendation:** Phase 1 work (see §7) should make System B read `SessionLifecycle`'s snapshot instead of calling `classifyMarketSession()` inline, and should actually assign `PLAN_BUILDING`/`PLAN_READY`/`OPEN_REVALIDATION` from real System B state transitions. This is consolidation, not new architecture — `SessionLifecycle` already has the right shape to be the shared `SessionContext`; it just isn't consumed by the system that most needs it.

---

## 3. Gap 2 (structural): no `SessionContext` object with the fields the mission wants

**Finding:** `SessionLifecycleSnapshot` = `{ marketSession, appState, tradingDate, evaluatedAt }`. The mission wants `sessionId, tradingDate, phase, market, isTradingDay, isExtendedHours, minutesToOpen, minutesSinceOpen, minutesToClose`. None of the latter five numeric/boolean fields exist anywhere as named fields on any object today (audit doc §2.4).

**Gap:** `minutesToOpen`/`minutesSinceOpen`/`minutesToClose` require either (a) computing from the fixed minute-table already in `replaySafety.json` (cheap, but inherits the no-holiday-awareness limitation of every existing representation), or (b) consuming Alpaca clock's `next_open`/`next_close` fields, which are fetched by `readMarketClock()` but currently discarded (only `is_open` is read) — a **real, currently-unused source of holiday-aware timing data already available with zero new API surface**.

**Recommendation:** Extend `SessionLifecycleSnapshot`, not replace it. Add `sessionId` (derive from `tradingDate`), `isExtendedHours`/`isTradingDay` (derivable from existing `MarketSession` value), and `minutesToOpen/SinceOpen/ToClose` sourced from Alpaca's already-fetched clock payload when available (holiday-correct), falling back to the fixed-minute-table math the rest of the codebase already uses when Alpaca is unconfigured (matching gate 12's own `unconfigured → skip` philosophy, applied honestly rather than silently).

---

## 4. Gap 3 (session-representation fragmentation): nine competing enums

**Finding:** §2.2 of the audit doc. Two of the nine (`RegimeEngine.classifyDeskSession()`, `SnapshotScanner.isSnapshotScannerRth()`) are fully independent reimplementations, not derivations — meaning a future bug fix to session-boundary logic (e.g. adding holiday awareness) would have to be applied in at least three separate places to actually take effect everywhere.

**Recommendation:** Not "delete the other eight" — several serve genuinely different purposes (mobile UI labels, desk-session subdivision for regime classification) and forcing them all through one enum would be its own kind of premature unification. But the **two fully-independent reimplementations** (#5, #6) should be refactored to call `classifyMarketSession()` rather than re-deriving weekday/minute-of-day math a second and third time. This is a pure refactor with no behavior change if done correctly (same thresholds, same config source) — worth a dedicated, narrowly-scoped PR before any premarket feature work, so that a later holiday-awareness fix (§3) doesn't need to hunt down three call sites.

---

## 5. Gap 4 (the big one): no path from System B to the protected spine, and specific reasons not to build one yet

**Finding:** `TradePlanBuilder.ts`'s own header states wiring a `VALID` plan into `TRADE_IDEA_GENERATED` is *"a SEPARATE, deliberately NOT-yet-made decision."* This mirrors exactly the pattern already established elsewhere in this codebase this week for the Java institutional-engine activation (`docs/architecture/JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md`'s Phase 3, gated on "a real multi-week window... no shortcuts on calendar time" of clean shadow tracking before any Java-sourced signal may vote) — the same discipline should apply here, for the same reason: `TradePlanBuilder`'s thesis text and confidence score have never been evaluated against real graded outcomes at all. There is no `agent_performance_stats`-equivalent evidence for "TradePlan-sourced ideas are reliable."

**This is not a reason to avoid building the wiring — it's a reason the wiring, once built, should default OFF and require the same evidence discipline as everything else in this codebase before being turned on.** Concretely:

1. Emitting `TRADE_IDEA_GENERATED` from a `VALID`/revalidated `TradePlan` is architecturally identical to any other new idea agent (mission §10's own diagram is exactly right here) — it does not require touching `ChiefTraderAgent`, `RiskEngine`, or `OMS` at all, per the existing, sanctioned "Adding a new agent" pattern this codebase already documents. It becomes one more independent vote.
2. It should be flag-gated off by default (matching every other experimental capability in this codebase's convention), and should run in shadow/observability mode first — record what it *would have* emitted, grade those predictions via the existing `ReflectionEngine`/`PredictionOutcomeEvaluator` pipeline, and only enable live emission once there's real evidence, exactly like the Java factor-composite precedent.
3. `MissedOpportunityDetector`'s taxonomy (audit doc §10.3) should gain a `THESIS_INVALIDATED` classification tied to `tradePlans.status`, closing the mission's §19 requirement, before any live wiring — so there's a real answer to "why didn't we act on this thesis" from day one of shadow mode, not bolted on after.

---

## 6. Gap 5: Java quant engine has no path into ranking or thesis-building at all

**Finding:** `ComposableRanking.ts`'s 7 components (`momentum, relativeVolume, rangeExpansion, gap, liquidity, newsCatalyst, agentConfidence`) are pure TypeScript arithmetic on snapshot fields — none call `quant-core-java`. This directly contradicts the mission's §4/§5 requirement that quantitative calculations "MUST come from the Java Quant Engine."

**What already exists that's directly reusable (per this session's own recent work and the Java engine inventory):**
- `FactorAlphaEngine.java`'s 5-factor composite (momentum, mean-reversion, volume/liquidity, volatility, OHLC order-flow proxy) — already real, tested, and already exposed via `QuantCoreBridge.fetchInstitutionalFactors()`.
- `GarchEngine.java`/`quantCoreBridge.fetchInstitutionalVolatility()` for a real volatility/regime read.
- `StrategyRegistry.java`'s registration pattern (`CORE`/`INSTITUTIONAL` maps) is the correct place to add a `PREMARKET` map for any of the mission's named strategies (`PremarketGapContinuation` etc.) — reusing `MovingAverages`/`Volatility`/`RollingStatistics`, not reimplementing them.

**Recommendation:** Add an 8th `ComposableRanking` component, `javaQuantScore`, sourced from `quantCoreBridge.fetchInstitutionalFactors()`'s `composite` field (already computed, already Z-scored, already available for any symbol with ≥60 daily bars per `JavaQuantAdvisoryService`'s own floor) — marked `available: false` with a clear reason when the Java core is disabled or the symbol lacks history, matching every other component's honesty convention. This is additive to the existing 7-component weighted sum, not a rewrite, and directly satisfies the mission's Java-authority requirement without duplicating any indicator math in TypeScript.

New premarket-specific strategies (`PremarketGapContinuation`, etc.) should be built only if a demonstrated need survives Phase 2 (discovery-only) — the mission's own §22 ("do not optimize the system for more orders... do not tune it merely to make the demo look successful") argues against building six new strategies speculatively before knowing whether the existing 5 CORE + institutional factor composite already capture premarket gap/momentum behavior adequately.

---

## 7. Gap 6: extended-hours execution — nothing exists yet, by design, and should be built last

Per the audit doc §4-§6: no broker adapter that's actually in use has genuine extended-hours order support; OMS hardcodes `MARKET` orders (incompatible with extended-hours order-type requirements for every broker); gate 12 is RTH-binary live; no `ExtendedHoursExecutionPolicy` exists anywhere.

**This is the correct state for a system that is `DISCOVERY_ONLY` today (mission §20), and should stay unbuilt until Phases 2-4 (discovery, Java integration, thesis) are shipped and validated.** Building execution capability before the discovery/thesis layer has any track record would invert the mission's own explicit phase ordering.

When this phase is reached, the concrete gaps to close, in dependency order:
1. **OMS**: add limit-order construction (currently hardcoded to `MARKET`) — a prerequisite for *any* broker's extended-hours order type, not premarket-specific by itself.
2. **`ibkr_gateway`** (the actually-active broker): add the `outsideRth` flag to the constructed IB `Order` object — currently absent entirely.
3. **`AlpacaBroker`**: add the `extended_hours` flag, contingent on (1) since Alpaca requires `type: 'limit'` for it to be honored.
4. **Gate 12**: extend the live path to consume `classifyMarketSession()` (already exists, already used in replay) instead of Alpaca's bare `is_open`, so `PRE_MARKET`/`AFTER_HOURS` can be distinguished from `CLOSED` — and fix the Alpaca-unconfigured skip-pass gap (audit doc §7.1) as part of the same change, since both involve the same function.
5. **New `ExtendedHoursExecutionPolicy`**: a new, additive RiskEngine-adjacent check (spread threshold, min liquidity, fresh-quote requirement, position-size cap) that runs *in addition to* the existing 24 gates for extended-hours orders specifically — never replacing or loosening any existing gate, matching the mission's explicit §11 instruction.

---

## 8. Gap 7: `MarketDataWorker`'s 12-slot/3-rescue allocator has zero session awareness

**Finding confirmed with code, not just hypothesis** (audit doc §8): the same static `maxActiveSubscriptions=12`/`maxConcurrentTemporaryDataRescues=3` caps serve premarket discovery and RTH discovery identically. Every premarket-active discovery source (movers, broad universe, opportunity scan) competes through this one pool.

**Recommendation, matching the mission's explicit instruction not to just raise the numbers (§14/§23):** This needs measurement before a fix, not a number change. Before any premarket discovery volume increase ships, instrument: subscription utilization, candidate wait time, fresh-data denial rate, candidate-to-evaluation latency, split by session (premarket vs RTH) using the `SessionContext` from §3. Only then decide whether premarket needs its own reserved-slot class (mirroring the existing `rescueReservedSlotsForPriorityClasses` mechanism for `EXPLORATION`/`MARKET_MOVER`) or whether the existing pool, once actually measured under premarket load, turns out to be adequate. This is explicitly a config-tuning decision requiring real data, not something to guess at in this document — and per this session's own established precedent, exactly the kind of change to make deliberately, off-hours, with monitoring, not reactively.

---

## 9. Non-gaps — already correct, explicitly confirmed, do not touch

- **Reconciliation**: already session-agnostic, fixed interval, works correctly premarket (audit §9).
- **Emergency stop / kill-switch**: already session-agnostic, always the first gate evaluated (audit §9).
- **Gate 8 (`daily_loss`)**: day boundary already uses real NY-calendar midnight, already correctly includes premarket activity in the right day's baseline (audit §7.4). No change needed.
- **`AutoTradeScheduler`**: the HH:MM window comparator already supports an arbitrary window including premarket hours; no code change needed to *express* a premarket schedule, only to make gate 12 actually honor extended hours once that's built (§7 above).
- **`MissedOpportunityDetector`'s core classification logic**: correct, recently bug-fixed (lifecycle-status check, not row-existence), directly extensible (§5 above) rather than needing replacement.

---

## 10. Recommended phase sequencing (revising the mission's own Phase 0-7 given what actually exists)

| Mission phase | Original scope | Revised scope given findings |
|---|---|---|
| Phase 0 | Forensic audit | **Done** — this document + the companion audit |
| Phase 1 | Session model | Consolidate System A/B onto one `SessionContext` (§2), extend `SessionLifecycleSnapshot` with the missing fields (§3), refactor the two independent session reimplementations to call the shared function (§4). **No new discovery/ranking code** — it already exists. |
| Phase 2 | Premarket discovery | **Mostly not needed as new code.** `ComposableRanking`/`TradePlanBuilder` already do this. Real work: session-parameterize their *policy* (liquidity bar, confidence bar) rather than building new discovery. |
| Phase 3 | Java quant integration | New work, genuinely absent: add `javaQuantScore` component (§6), decide whether any premarket-specific Java strategy is actually needed after Phase 2 data exists. |
| Phase 4 | Premarket thesis | **Mostly not needed as new code.** `TradePlanDraft`/revalidation already exist. Real work: split confidence/confluence (§5.1 in audit's TradePlanBuilder section), add structured catalyst fields, add `THESIS_INVALIDATED` to `MissedOpportunityDetector`. |
| Phase 5 | Premarket paper execution | Build in the dependency order in §7 above — OMS limit orders first, then per-broker extended-hours flags, then gate 12 extension, then the new `ExtendedHoursExecutionPolicy`. Gated OFF by default, shadow-mode first (§5). |
| Phase 6 | RTH handoff | **Already built and running** (`revalidateTradePlan()` gated to `marketSession === 'REGULAR'`). Real work: verify it end-to-end with the consolidated `SessionContext`, add tests for the specific scenarios in mission §21. |
| Phase 7 | Missed-opportunity analytics | Extend existing taxonomy per §5 above, not a new system. |

**This resequencing is the single most important output of this gap analysis**: roughly half of the mission's originally-scoped "build" work (discovery, thesis, RTH handoff) is consolidation and extension of real, running code, not new construction. The genuinely new work is: the Java quant-score component, extended-hours execution (deliberately last), and the session-representation consolidation that makes everything else coherent.

---

## 11. What this document does NOT claim

- It does not claim the existing System B code is bug-free or production-hardened for premarket volume — only that it exists, runs, and matches most of the mission's requested shape.
- It does not claim Java-authority integration (§6) is a small change — `FactorAlphaEngine`'s composite is a 5-factor score, not a premarket-specific signal; whether it's a good *premarket* discriminator is an empirical question Phase 3 work should measure, not assume.
- It does not recommend a specific premarket resource-allocation fix (§8) — only that one must be measured before it's built, per the mission's own instruction.
- It does not address the mission's UI requirements (§27) — those depend on the `SessionContext`/`TradePlan` shape being finalized first.

*Companion document: `docs/architecture/ARGUS_SESSION_AWARE_TRADING_ARCHITECTURE.md` (current-state audit).*
