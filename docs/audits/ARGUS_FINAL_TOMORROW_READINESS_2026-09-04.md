# ARGUS — Final Trader-Grade Tomorrow Readiness Audit

**Date:** 2026-09-04 (continuation of tonight's Trader-Grade Forensic Audit). This report focuses on genuinely new investigation — the two named open threads (5th silent death, `BELOW_CHANCE` methodology) plus one specific crash-safety scenario nobody had traced yet. Everything already verified earlier tonight (OMS idempotency, reconciliation mismatch detection, discovery wiring, memory telemetry, ChiefTrader consensus math, ETF concentration) is cited, not re-derived from scratch.

## 1. Executive Verdict

**READY WITH CONDITIONS.** Unchanged from tonight's earlier verdict, now on a stronger evidentiary base: two of tonight's specific new investigations (OMS restart-after-order-lost, prediction-grading pipeline) came back sound, and the one real new finding (evaluation-horizon mismatch, below) is a measurement-accuracy concern, not a safety defect — it could make Argus *understate* real edge, never *overstate* it into an unsafe trade.

## 2. New Investigation: The Fifth Silent Death

Re-investigated beyond last night's pass, specifically checking the concern the user named directly:

- **Widened the Windows Event Log search** (Application, System, WER-Diag/Operational, Resource-Exhaustion-Detector, SecurityCenter/antivirus) across a 30-minute window centered on the death. **Zero results in every log.** No crash report, no resource-exhaustion event, no antivirus action — a stronger negative result than last night's narrower window.
- **Directly verified the specific risk the user named**: whether `ArgusCoreBoot.test.ts` (or any other test file) could corrupt the real `data/.argus_runtime_session.json` the live engine depends on. Confirmed from source: `ArgusCoreBoot.test.ts` snapshots the production file *before* redirecting to a temp path specifically to prove it stays untouched, and calls `setSessionRecoveryPathForTests()` before any real session logic runs. `sessionRecovery.test.ts` does the same. Grepped the entire test suite for every caller of `beginRuntimeSession`/`bootArgusCore` — these two files are the only ones, and both are correctly isolated. **This specific hypothesis is ruled out, not just assumed safe.**
- **Conclusion: root cause remains `[UNVERIFIED]`.** This is a genuine evidence ceiling, not an unexamined lead — every forensic avenue available without new tooling (a crash-dump capture mechanism, deeper OS-level process monitoring) has now been checked. Recommendation unchanged from last night: watch closely during tomorrow's actual session; a recurrence during market hours is a materially more urgent signal than an overnight one.

## 3. New Investigation: The `BELOW_CHANCE` / `NO_EDGE_DETECTABLE` Methodology

Traced the actual grading pipeline (`PredictionOutcomeEvaluator.ts`) that produces the numbers `agent-edge` reports on, rather than trusting the statistic at face value.

**What's sound, verified from code:**
- Real point-in-time OHLCV bars (the same source the backtest engine and RiskEngine's correlation gate use), never fabricated — a prediction with no real bar history is left unevaluated, not guessed.
- No look-ahead: a prediction is never even attempted for grading until real wall-clock time has already passed its evaluation horizon.
- A previously-found and already-fixed double-counting bug (Kronos forecasts were being graded through two different tables — explicitly excluded now, citing its own prior forensic audit).
- Telemetry-pulse (UI demo) predictions explicitly excluded from grading.
- Idempotent inserts (`onConflictDoNothing`) prevent the same prediction being counted twice even under a race.

**The one real, substantive finding:** `evaluationHorizonMs` is a **single, uniform 60-minute window** applied to every non-Kronos source — TechnicalAgent, NewsAgent (in its `agent_predictions` path; the separate `news_predictions` ACTIVE_OBSERVE ledger does use its own per-item expected horizon), FundamentalAgent, MacroAgent, and every QuantEngine strategy (`MOMENTUM_BREAKOUT`, `PULLBACK_CONTINUATION`, `MEAN_REVERSION`, `TREND_FOLLOWING`, `RANGE_REVERSION`) alike, regardless of each one's own intended holding period. A macro or fundamental thesis is not designed to resolve favorably within an hour; grading it on that clock risks measuring noise relative to its actual intended horizon, not the thesis itself. This is a **plausible, evidence-based partial explanation for part of the measured `BELOW_CHANCE`/`NO_EDGE_DETECTABLE` picture** — it does not mean the agents definitely *do* have hidden edge, but it means the current measurement cannot yet distinguish "genuinely no edge" from "measured on the wrong clock" for the longer-horizon sources.

**Not fixed this pass, deliberately.** Changing evaluation horizons per-agent/per-strategy is a real methodology decision, not a formula bug — it needs its own grounded research (what horizon actually matches each strategy's real intended resolution time?) rather than a guessed number, and changing it retroactively would mix methodologies in the existing `prediction_outcomes` history. Recommended as the single highest-priority follow-up investigation, ahead of any further discovery-layer work.

## 4. New Investigation: OMS Crash Safety — "Order Submitted, Response Lost, Then Restart"

Traced `reconcileStaleOrders()` end to end, the exact scenario the mission asked about.

**Verified sound.** On boot (and periodically thereafter), it finds every trade row stuck `PENDING`/`REJECTED` with no `brokerOrderId` recorded, within a bounded lookback window, then does a **real broker-side lookup by the same `client_order_id`** used for order idempotency (verified last night). Three honest outcomes, never a guess: the broker genuinely has no record (safely marked `REJECTED`); the broker has it and it disagrees with local state (local state is corrected, fill progress recorded, the event bus notified, exactly as if the fill had been seen live); or the adapter doesn't support the lookup at all (explicitly does nothing rather than fabricate a result). No duplicate-order risk, no permanently stuck state, no blind retry.

## 5. Fixes Implemented This Pass

None. Every new investigation this round came back either confirming existing correctness (5th-death test-isolation hypothesis ruled out, OMS restart-recovery sound) or surfacing a measurement-methodology question that needs dedicated research before a responsible fix can be written (evaluation horizons), not a code change to make right now.

## 6. Trading Pipeline (cumulative status)

Unchanged from tonight's earlier audit: market data connected, discovery→allocation wiring fixed and live, ChiefTrader 0.75/2-agent gates untouched, RiskEngine's 24 gates untouched, OMS idempotency and crash-recovery both now independently verified sound, reconciliation mismatch detection verified sound with real enforcement teeth.

## 7. Strategy/Agent Quality

QuantEngine's overall real track record remains measured `BELOW_CHANCE`. The evaluation-horizon finding above (§3) means this number should be read as "the best current measurement, on a clock that may not fit every source," not as a final, unimprovable verdict on whether any agent has genuine edge.

## 8-11. Risk / Execution & Reconciliation / Runtime Reliability / Self-Improvement

Unchanged from tonight's Trader-Grade Forensic Audit (order idempotency, reconciliation, safety gates), with this pass's two additions (OMS restart-recovery, verified sound; evaluation-horizon question, flagged) layered on top.

## 12. Remaining Blockers

1. The 5th silent death's root cause, now searched more thoroughly and still `[UNVERIFIED]`.
2. The evaluation-horizon mismatch is not a blocker to paper trading itself (nothing about it makes a trade less safe), but it is a blocker to trusting *"agents have no edge"* as a final conclusion until it's addressed.

## 13. Tomorrow Preflight Checklist

Same as last night's Tomorrow Readiness report: confirm `PAPER_TRADING_ONLY`/`LIVE_NO_GO`, confirm Chronos single-instance healthy, confirm engine `RUNNING` with `TRADING_ENABLED` explicitly resumed if needed, confirm reconciliation clean.

## 14. Stop Conditions

Unchanged: any `CRITICAL` memory-telemetry sample, a reconciliation mismatch that doesn't clear within one cycle, or a repeat of the unexplained-death signature.

## Honest Answer to the Trust Question

Would I trust Argus to run autonomously tomorrow? **Yes, for paper trading, with the two conditions above watched actively** — not because every open question is resolved, but because the specific failure modes that would make autonomous operation *unsafe* (duplicate orders, silent capital divergence, corrupted crash-recovery state, blind retries) were each independently traced tonight and found to be correctly handled. The open questions that remain (the 5th death, evaluation-horizon accuracy) affect *reliability* and *measurement quality*, not the safety of what happens when Argus does act.
