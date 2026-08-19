# Argus Target Mission Engine — Implementation Plan

Read-only audit, per instruction. No code changed to produce this document. Companion to `ARGUS_ARCHITECTURE_PROTECTION.md` and `ARGUS_EXIT_INTELLIGENCE_PLAN.md`.

## 1. What this is (and isn't), precisely

An **observation layer**, not a trading mode. Its entire job is to watch the existing spine operate under an operator-declared objective (`$2,000 → $100`, "1 trading day") and produce forensic data about *how* Argus tried, not to change *how hard* it tries. This plan takes the spec's own §8 hard requirement completely literally: the target must be informational context only, never a input to RiskEngine, PositionSizing, or ChiefTraderAgent.

## 2. Current architecture this plugs into (verified)

Everything a Mission Engine needs to observe already emits real, traceable events: `TRADE_IDEA_GENERATED`, `CHIEF_CONSENSUS_STARTED/COMPLETED`, `AGENT_DISAGREEMENT`, `CHIEF_APPROVED_IDEA`, `RISK_ASSESSMENT_STARTED/COMPLETED`, `RISK_GATE_EVALUATED` (one per gate, all 24, every evaluation — `RiskEngine.ts`'s `recordGate()`), `ORDER_SUBMITTED/ACCEPTED/EXECUTED`, `POSITION_MONITORED`, `POSITION_RISK_CHANGED`, `TRADE_LIFECYCLE`, `DESK_NO_TRADE`, `CAPITAL_CHECK`. `EventStore.ts` already durably persists the ones in `PERSISTED_EVENTS` (now redacted at write time — see this session's defect-audit fixes) with `correlationId`/`transactionId` join keys already in place. **A Mission Engine's core job is aggregation and filtering of data that already exists, not capturing anything new** — this significantly reduces the actual build surface versus what the spec's 24-section scope might imply.

The one genuinely missing primitive: nothing today scopes this event stream to a *time window with a declared objective and starting capital snapshot*. That's the actual net-new concept.

## 3. Proposed architecture

```
Existing EventBus stream (unchanged - Mission Engine only listens)
    │
    ▼
MissionRecorder  [NEW - a pure listener, like EventStore.ts's own trackEvent pattern]
    │  filters the same events EventStore already durably persists, scoped to:
    │  (a) events whose traceId/transactionId trades/consensus_decisions rows show occurred
    │      after missionStartedAt and before missionEndsAt, AND
    │  (b) whose symbol/trace is attributable to real trading activity during the mission window
    ▼
mission_events / mission_snapshots tables  [NEW, additive]
    │
    ▼
MissionEngine.computeProgress(missionId)  [NEW, pure read/aggregation function]
    │  reads settings.budget delta, trades/fills for the window, existing CapitalAllocation.ts
    │  math (reused, not reimplemented) to report allocated/used/remaining exactly as RiskEngine
    │  itself sees it
    ▼
GET /api/v2/missions/:id  (dashboard) + ARGUS_MISSION_<id>.md (on completion)
```

**Nothing in this diagram touches the left-hand trading spine.** `MissionRecorder` is a listener only — same isolation class as `EventStore.ts`, `TransactionLifecycleTracker.ts`, and `pipelineAgentHealth.ts`, all of which already prove this pattern works cleanly in this codebase (pure `eventBus.on(...)` consumers with zero write-path back into trading logic).

## 4. Mission configuration & states

Matches the spec's own schema (`missionId, name, allocatedCapital, targetProfitAmount, targetReturnPercent, startTime, endTime/duration, mode: 'PAPER', status`) with one addition worth flagging: **`allocatedCapital` for a mission cannot be a second, competing budget number.** `RiskEngine`'s `argus_capital_allocation` gate only ever reads `settings.budget` (see `ARGUS_CAPITAL_AUDIT_REPORT.md`). A mission's `allocatedCapital` must therefore be **advisory/observational** — either (a) it must equal `settings.budget` at mission start (validated, not independently enforced), or (b) if an operator wants a mission scoped to less than the full budget, that requires actually lowering `settings.budget` for the mission's duration, which is a real, already-existing, already-safe operator action (not a new capability) — the Mission Engine should surface this clearly rather than pretend it has its own enforcement, which would either be fake (observational-only, silently not real) or a second budget-authority (explicitly forbidden by both this spec and `ARGUS_ARCHITECTURE_PROTECTION.md`). States (`CREATED/ARMED/RUNNING/TARGET_REACHED/TARGET_NOT_REACHED/STOPPED/EXPIRED/FAILED/CANCELLED`) are pure bookkeeping on the `missions` row, driven by a lightweight interval comparing `now` to `endTime` and current P&L to target — no new trading logic.

## 5. Target progress math (reuses existing modules, doesn't reinvent capital accounting)

```
missionPnl = Σ realized P&L (trades.profitLoss) for FILLED SELL trades in-window
           + Σ unrealized P&L (currentPrice - entryPrice) × quantity for still-open positions opened in-window
progress   = missionPnl / targetProfitAmount
remaining  = targetProfitAmount - missionPnl
peakPnl / drawdownFromPeak = running max/current delta over the mission's own snapshot history
```

This is a **read-only rollup** over `trades`/`fills`/`portfolio`, the same tables `analyticsRoutes.ts` and `organicPaperSoakTracker` already query — no new source of truth, no shadow ledger (directly satisfying the spec's own §17 "do not duplicate existing trade/fill/risk ledgers").

## 6. Target-pressure detection (§8/§9) — the one place this needs real care

The spec is explicit and correct that **the target must never influence RiskEngine's decisions.** The implementation-time risk to watch for: it would be easy to accidentally build "target pressure" detection by having `MissionEngine` read RiskEngine's *inputs* (remaining capital, remaining risk budget) and describe *why* the target might be unreachable (`TARGET_UNACHIEVABLE_WITH_CURRENT_RISK_LIMITS`) — this is safe, because it's strictly downstream/read-only. It becomes unsafe the moment any code path lets a mission's existence change what `PositionSizing.ts` or `RiskEngine.ts` compute. **Concrete implementation rule for this plan: `MissionEngine` may read `CapitalAllocation.snapshotCapital()`'s output; `CapitalAllocation.ts`/`RiskEngine.ts`/`PositionSizing.ts` must never import anything from a `mission*` module.** This is the exact same one-directional-dependency shape already enforced for `multiAsset/`/`continuous/` (verified by `architecture.protection.test.ts` this session) and should get the identical regression-test treatment.

## 7. Counterfactuals (§13) — explicitly research-only, computed, never executed

"What if Argus had held instead of exiting" is answerable purely from already-persisted price history (`ohlcv_bars`, `historicalDataGateway`) replayed against an already-closed trade's actual exit time — the same NEXT_BAR_OPEN-safe historical data access `BacktestEngine.ts`/`canonicalNextBarEngine.ts` already use for research. This must reuse `historicalDataGateway`, not fetch live/duplicate data, and must be computed **after** the real trade already closed — never used to alter that trade's real outcome, only annotate it for the report.

## 8. Affected files

**New:** `src/server/services/MissionEngine.ts` (+ `.test.ts`), `src/server/services/MissionRecorder.ts` (+ `.test.ts`), `drizzle/00XX_missions.sql` (`missions`, `mission_events`, `mission_snapshots` — explicitly *not* `mission_opportunities`/`mission_decisions` as separate tables per the spec's own "do not duplicate existing ledgers"; opportunities/decisions are referenced by `traceId`/`transactionId` into the tables that already exist), `src/server/routes/missionRoutes.ts`, `src/components/MissionDashboard.tsx` (or a tab section, matching the existing Opportunity Feed's in-`App.tsx` pattern), `scripts/generate_mission_report.ts` (the `ARGUS_MISSION_<id>.md` generator).

**Unchanged:** every file in the protected execution spine, identical list to `ARGUS_EXIT_INTELLIGENCE_PLAN.md`'s §8, plus `CapitalAllocation.ts` (read from, never modified).

## 9. Failure handling

A mission with zero qualifying trades in its window is a **valid, complete result** (`TARGET_NOT_REACHED`, root cause `INSUFFICIENT_OPPORTUNITIES` or `NO_CONSENSUS` — both already directly answerable from this session's `ARGUS_CONSENSUS_RUNTIME_FORENSIC.md` classification work, which this engine should reuse rather than re-derive). `MissionRecorder`'s event listeners must never throw into the shared `EventBus` (same isolation already required of `EventStore.trackEvent` and `pipelineAgentHealth`'s hooks) — a bug in mission bookkeeping must never be able to affect the real event pipeline.

## 10. Test plan

Pure-function tests for `computeProgress()`/root-cause classification against synthetic trade sets (profitable, losing, zero-trade, one-lucky-trade-dominant). Event-listener tests proving `MissionRecorder` correctly scopes to a time window using a real temp-DB fixture (matching this session's established `failureInjectionSuite.test.ts`-style temp-SQLite pattern). One architecture-regression test: no `mission*` file is ever imported by `RiskEngine.ts`/`PositionSizing.ts`/`CapitalAllocation.ts`/`OrderManagement.ts`/`ChiefTraderAgent.ts` (extends `architecture.protection.test.ts`'s existing allowlist-checking pattern). Explicit test proving a mission's `allocatedCapital` never appears anywhere in a `RiskEngine.evaluateRisk()` call path (grep-based, same technique already used for the BrokerManager-import check).

## 11. Rollback plan

Fully additive, same shape as the Exit Intelligence plan: the dashboard/report generator can be removed independently of the recorder; the recorder can be unregistered (stop calling `eventBus.on(...)` at boot) with zero effect on any other subsystem, since it never writes back into trading state. No existing table, route, or behavior is modified by this feature at any implementation stage.

## 12. Recommended build order (not a runtime requirement — sequencing for review-ability)

1. `MissionRecorder` + schema (prove it durably captures a real window of existing events, nothing else).
2. `MissionEngine.computeProgress()` as a pure function over already-closed historical data (no live mission needed to test it).
3. Routes + dashboard (read-only surface).
4. Mission lifecycle (`CREATED→RUNNING→...`) and the report generator last, since they're the thinnest layer once 1–3 exist.
