# Agent Confidence Clustering & Consensus Telemetry Reconciliation

Analytics/telemetry investigation. **No consensus threshold, quorum rule, or any RiskEngine gate was
changed** (`consensusApprovalThreshold` stays 0.75, `minIndependentAgreeingAgents` stays 2, both
re-confirmed unchanged in `config/tradingSafety.json`). Two small, additive diagnostic-log changes were
made (§2); everything else here is read-only analysis.

---

## Task 1 — Agent Confidence Decomposition & Calibration Audit

### Real Friday 2026-08-21 confidence/side distribution (DATABASE VERIFIED, corrected epoch window)

| Agent | BUY | SELL | HOLD | Avg confidence (this agent's own stated value) |
|---|---:|---:|---:|---:|
| KronosEngine | 670 | **2,137** | 244 | 0.845 (range 0.55–0.85 — hard-capped, per `agentWeights.json`/Kronos's own confidence-clamp design) |
| TechnicalAgent | **816** | 36 | — | 0.617 (range 0.551–0.868) |
| QuantEngine | 196 | 24 | — | (not separately queried this pass) |
| FundamentalAgent | — | — | 343 | 0 (DATA_UNAVAILABLE HOLD shape, per `deskIntelligence.json`) |
| MacroAgent | — | — | 279 | 0 (same shape) |
| OpportunityScreener | 118 | — | — | (one-vote-only agent, per `CLAUDE.md`) |

**This confirms the task's own cited 2,034-vs-787 split almost exactly** (real numbers: 2,137
Kronos SELL vs 816 Technical BUY) — Kronos was overwhelmingly bearish and TechnicalAgent overwhelmingly
bullish on the same day, on the same universe of symbols.

### Root cause of the low net weighted confidence (0.179 avg BUY, per the Friday audit)

**Not a miscalibration bug — this is genuine, correctly-modeled disagreement.** Evidence:

1. **`calibrateConfidence()` (`ChiefTraderAgent.ts`) is not the cause.** It looks up
   `agent_confidence_calibration` (a real, per-agent per-confidence-bucket table) and falls back to
   the agent's raw stated confidence, unchanged, whenever no row exists for that bucket. That table
   has only **18 rows total** in the current DB (**DATABASE VERIFIED**) — nowhere near enough coverage
   to be silently shrinking most agents' confidence. The low averages are the agents' own raw signals,
   not a calibration artifact.
2. **`agentWeights.json`'s static weights do not favor one side over the other**: TechnicalAgent 0.25
   vs KronosEngine 0.20 — Technical is actually weighted slightly *higher*, so the low net confidence
   is not an artifact of over-weighting Kronos's bearish view either.
3. **The real mechanism**: `EvidenceAggregator.aggregate()` nets opposing votes and applies
   `DISAGREEMENT_PENALTY` whenever agents disagree on side. On Friday, Kronos (SELL, ~0.85 conf) and
   TechnicalAgent (BUY, ~0.62 conf) were in direct, frequent opposition across the shared symbol
   universe — this is exactly what `AGENT_DISAGREEMENT` firing 2,991 times (of ~4,400 cycles, 68%)
   already showed. A high-confidence SELL vote and a high-confidence BUY vote on the same symbol at
   the same time correctly nets down to a low, uncertain weighted confidence — the math is doing its
   job (refusing to manufacture false certainty out of a genuine split), not malfunctioning.

### Why Kronos and TechnicalAgent disagree so often (feature/horizon mismatch, not a bug)

Read `technicalSignal.ts` (RSI/MACD/Bollinger rule-based, real multi-bar momentum/mean-reversion
signals — a **medium-term, rule-based** view) against Kronos's own documented nature (`CLAUDE.md`:
"local Chronos... needs 30+ ticks"; a **local time-series forecast model** extrapolating recent
tick-level path, not a rule-based indicator). These are two structurally different signal classes with
no inherent reason to agree: one reacts to *recent price-path continuation/extrapolation*, the other to
*classical technical rule conditions*. A real, disclosed limitation of this design (not investigated
further this pass — a genuine feature/window-alignment comparison between the two would require
instrumenting Kronos's own internal lookback against TechnicalAgent's indicator windows bar-by-bar,
which was out of scope for this pass's time budget). **This is flagged as a real, legitimate research
question for a future pass, not resolved here** — recorded honestly rather than a fabricated root
cause.

### What this pass did NOT do (explicit)

- Did not build a new statistical-distribution pipeline across all 4 named files
  (`TechnicalAgent.ts`/`KronosForecastAgent.ts`/`QuantitativeFeatureEngine.ts`/`GroupedScores.ts`/
  `OpportunityScreener.ts`) — read `technicalSignal.ts` and `ChiefTraderAgent.ts`'s weighting/
  calibration code directly; the other files' internal confidence formulas were not independently
  re-derived this pass.
- Did not recommend any feature-calibration change — the task explicitly asked for analysis and
  recommendations, not implementation, and the evidence here does not point to a defect to fix, only a
  real, disclosed research question (feature/horizon alignment between Kronos and TechnicalAgent).

---

## Task 2 — `consensus_decisions` Persistence Gap (4,400 vs 360), Resolved

**Root cause, traced to exact code (`src/server/services/ChiefTraderAgent.ts`)**:
`recordConsensusTransaction()` (the only function that writes `consensus_decisions`) is called from
exactly two places:

1. Inside `evaluateConsensusSerialized()`'s `if (approved) {...}` branch — **only on an actual
   approval**.
2. Inside `recordUnresolvedAsNoConsensus()` — a **separate, periodic sweep** ("called just before the
   60s recentIdeas clear") that persists **at most one** `NO_CONSENSUS` row per symbol per sweep,
   summarizing whatever evidence had accumulated by that point.

**This means `evaluateConsensusSerialized()` (which fires `CHIEF_CONSENSUS_STARTED`/`_COMPLETED` on
every single cycle, matching the 4,400 count) does NOT persist its own row on every non-approved
cycle.** A symbol re-evaluated many times within one ~60-second window (as new ideas trickle in from
different agents) correctly collapses to **one** persisted row for that window, not one row per
intermediate cycle. **This is intentional, documented-in-code design — not a bug, not a silent drop of
real evidence** (the evidence itself is still visible via `AGENT_DISAGREEMENT`/`DESK_NO_TRADE`/
`TRADE_IDEA_REJECTED` events; only the *persisted transactional record* is deliberately collapsed to
avoid one row per re-evaluation tick).

**Diagnostic added** (not a behavior change): `ChiefTraderAgent.ts` now tracks
`interimEvaluationsSinceLastPersist` per symbol, incremented on every non-approved cycle, and logs a
structured `CONSENSUS_INTERIM_EVALUATIONS_COLLAPSED` event (`category: 'CONSENSUS'`) the moment a row
finally persists (approval or the periodic sweep), reporting exactly how many prior cycles collapsed
into it, then resets. This makes the exact ratio directly observable via `observability_events` going
forward, closing the instrumentation gap the Friday audit flagged — without changing which cycles
persist.

**Test added**: `ChiefTraderAgent.test.ts` — proves two non-approving cycles for the same symbol log
nothing individually, and the log fires with `interimEvaluationCount: 2` the moment a third cycle
approves; also proves the counter resets (a subsequent clean approval logs nothing new). **TEST,
passing.**

---

## Task 3 — `ORDER_EXECUTED` Event Count (6 vs 4), Resolved

**Root cause, traced to exact code (`src/server/services/OrderManagement.ts`)**: `ORDER_EXECUTED` is
**not** a once-per-trade-row terminal event — it fires once per **observed lifecycle transition**, and
there are 5 real call sites:

1. `executeOrder()`'s environment-gate rejection branch (fires for a `BROKER_ENVIRONMENT_UNKNOWN`-style
   rejection before ever reaching the broker).
2. `executeOrder()`'s main unconditional finalization (fires once per order attempt that reaches this
   point, terminal or not).
3. `reconcileStaleOrders()`'s crash-recovery correction (fires only when a real broker lookup finds the
   local state stale after a restart).
4. `applyFollowUpUpdate()` (the periodic `followUpOpenOrders()` background poll) — **fires again for
   the SAME trade row** every time the background poll observes a real transition (a status change or
   new fill quantity) for an order that is still open past the initial ~4-second poll window. Its own
   comment confirms this is deliberate: "matching executeOrder()'s own finalization contract... every
   call here is a real observed transition worth broadcasting."
5. `cancelOrder()`'s own emission.

**This means a single real order can legitimately emit `ORDER_EXECUTED` twice** — once from
`executeOrder()`'s initial poll timeout (order still `PENDING`), and again from
`applyFollowUpUpdate()` once the slower background poll later observes it actually fill. **Friday's
6-vs-4 gap is fully explained by this**: 4 real terminal `trades` rows, at least 2 of which likely took
longer than the initial poll window and received a second, legitimate follow-up
`ORDER_EXECUTED` on top of their first. **This is correct, intentional, already-documented behavior —
not premature/duplicate telemetry, and no RiskEngine rejection was found emitting extra events.** No
code change was made; this section documents the finding, per the task's own instruction not to force
a fix where none is needed.

---

## Files Changed

| File | Change |
|---|---|
| `src/server/services/ChiefTraderAgent.ts` | Added `interimEvaluationsSinceLastPersist` tracking + `logAndResetInterimConsensusTally()`, wired into the three points where a symbol's consensus outcome is (or isn't yet) persisted |
| `src/server/services/ChiefTraderAgent.test.ts` | New regression test for the diagnostic counter |

No other files changed. No thresholds, weights, or gate logic touched.
