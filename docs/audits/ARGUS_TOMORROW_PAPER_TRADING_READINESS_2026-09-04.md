# ARGUS — Tomorrow Paper-Trading Readiness Report

**Date:** 2026-09-04 (prepared night of 2026-09-03 for the next RTH session)

## Executive Verdict: READY, WITH ONE OPEN RELIABILITY QUESTION

The engine is deployed, tested, and healthy as of this report. `PAPER_TRADING_ONLY`, `LIVE_NO_GO`, the 0.75 threshold, and the 2-agent rule are all unchanged and reconfirmed. **The one honest caveat**: a fifth silent engine death occurred live, during this very readiness pass, with a signature that does NOT match the already-fixed Chronos memory leak (system memory was healthy at the time). Root cause is `[UNVERIFIED]` — this is disclosed prominently, not minimized, because the mission explicitly requires it.

## Changes Made Tonight

| # | Change | File(s) | Verified |
|---|---|---|---|
| 1 | Duplicate-sidecar guard: `local_ai_service.py` now checks `/health` before loading either model, so any invocation path (not just the two already-guarded TS launchers) exits cleanly if a healthy instance already exists | `scripts/local_ai_service.py` | Manually tested live: correctly detected the running instance and exited without loading models |
| 2 | Durable memory telemetry: a new, coarse (5-min), persisted sample of Node RSS/heap + best-effort Chronos sidecar RSS, classified NORMAL/WARNING/CRITICAL against evidence-labeled config thresholds. Closes the gap where the in-memory `processTelemetry` ring is lost on process death | `src/server/observability/processTelemetry.ts`, `src/server/config/observability.ts`, `config/observability.json` | 8 new unit tests, full suite green, confirmed live-emitting real samples post-deploy |

## Changes NOT Made, and Why

- **No auto-restart watchdog.** The mission's own escape hatch ("if too risky, don't implement, document recovery instead") was invoked deliberately — an auto-restart mechanism is real, added complexity with its own failure modes, and the existing `cleanShutdown`/`exitCode` marker already correctly refuses to mislabel an unexplained death as graceful (verified by direct code read of `sessionRecovery.ts` — `cleanShutdown` defaults `false` and only flips `true` via the real graceful path). **Manual recovery procedure**: `npm run argus-cli -- status` (or a browser hit to the health endpoint) to confirm down, then `npm run argus-cli -- start`, then confirm `tradingState`/reconciliation as done throughout this report.
- **No independence-escalation mechanism for QuantEngine.** Per the mission's own Section 12 and the prior closing-investigation report, QuantEngine's real measured edge is `BELOW_CHANCE` (Wilson upper bound < 0.5) — building infrastructure to help it pass the independence gate more easily was already rejected on evidence and remains rejected.
- **No opportunity-decay system, no confluence-window architecture, no new discovery provider.** All three were investigated in the prior closing-investigation report and found either already-handled (decay-by-rescoring) or unsupported by evidence to justify new complexity. Not re-litigated tonight.
- **Alpaca subscription ceiling.** Confirmed again: not exposed by any API. `maxActiveSubscriptions` stays at 12. `OPERATOR_VERIFICATION_REQUIRED` against the Alpaca dashboard, as instructed.

## Safety Verification

- `PAPER_TRADING_ONLY=true` — confirmed in `.env`.
- `LIVE_NO_GO` — confirmed via `GET /api/v2/live-readiness`.
- `0.75` confidence threshold — unchanged; not touched by any file in this pass.
- `minIndependentAgreeingAgents=2` — unchanged; not touched.
- RiskEngine — unchanged; no file under `src/server/core/RiskEngine*` or the 24-gate catalog was touched.
- `tradingState: TRADING_ENABLED`, `tradingMode: PAPER`, `safeMode: false`, broker `ibkr_gateway` authenticated, reconciliation `matches: true, mismatchCount: 0`.

## Reliability

- **Chronos/FinBERT sidecar**: single healthy instance (no duplicates), 436MB RSS post-restart — stable, well below both new thresholds. The `torch.inference_mode()` fix from the prior session remains in place and verified genuinely wrapping both inference call sites (not just a nearby comment — read the actual code).
- **Node engine memory**: the *previous* engine instance (before tonight's redeploy) showed 2632–2707MB RSS after ~2.3 hours of uptime, with two readings 2.5 minutes apart showing a *decrease*, not monotonic growth — consistent with normal GC sawtooth, not conclusive evidence of a leak either way over such a short window. **This needs to be watched through a full RTH session** with the new durable memory-telemetry sampler now live to actually capture the trend if the engine survives that long — the previous instance did not survive long enough to answer this question conclusively.
- **A fifth silent death occurred live, during this pass, at approximately 2026-09-04T01:09:51–01:10:25 UTC** (last heartbeat to confirmed-unreachable). Investigated with the same rigor as the prior four:
  - `crash.log`: zero new entries (same signature as all four prior deaths).
  - Windows Event Log (System, 01:05–01:11 UTC window): no low-memory events this time (unlike the Chronos-leak deaths) — one `Microsoft-Windows-Kernel-Power` `SessionUnlock` event landed within the window, temporally close but **not established as causal** — flagged `[UNVERIFIED]`, not asserted.
  - System memory at time of investigation: 7.87GB free RAM, 25.35GB free virtual — healthy, ruling out a repeat of the exact Chronos-leak mechanism.
  - This death happened shortly after a targeted (not full-suite) test run was executed **without first stopping the live engine** — a deviation from this session's own established practice of always stopping the engine before any test run. Whether that contributed is `[UNVERIFIED]`, but it is now treated as a confirmed risk factor going forward: **tests will not be run against a live engine again, regardless of scope.**
  - Root cause: **`[UNVERIFIED]`**. Not attributed to the Chronos leak (already fixed, and memory was healthy). Not attributed with confidence to anything else either.

## Discovery, Resource Allocation, Agent Coverage, ChiefTrader, Risk, Paper Trading

Unchanged from the prior three reports (`ARGUS_UNIVERSAL_OPPORTUNITY_DISCOVERY_{IMPLEMENTATION,PHASE2,FINAL}_REPORT_2026-09-03.md`) — the market has been closed the entire duration of this pass, so no new live discovery/ChiefTrader/Risk/trade data exists to report. Tomorrow's RTH session is the first opportunity to measure these with tonight's fixes live.

## Missed Opportunities (A–I)

Not applicable — no market activity occurred during this pass to classify.

## Before / After

| | Before Universal Discovery | Phase 1 | Phase 2 | Tonight |
|---|---|---|---|---|
| Discovery→allocation wiring | Disconnected | Fixed | — | Unchanged, live |
| Chronos memory | Unmonitored | Unmonitored | Root-caused, fixed | Duplicate-guarded, still healthy |
| Silent deaths | 3 (Sept 2–3) | — | 4th (root-caused) | **5th (unexplained)** |
| Durable memory telemetry | None | None | None | **Built, live** |

## Final Go/No-Go Answers

1. Stable enough for a full RTH session? **Provisionally yes** — every known, fixable defect is fixed; the 5th death is a new open question, not a known unaddressed one.
2. Python memory leak fixed under sustained inference? Fixed and code-verified; not yet proven over a full multi-hour session under real load (market was closed).
3. Python memory at session start: **436MB**.
4. Node memory at session start: to be re-measured — the engine was just redeployed; a fresh baseline reading should be taken at tomorrow's open.
5. Actual subscription capacity known to ARGUS: 12 (`maxActiveSubscriptions`), IBKR Gateway reports `maxMarketDataLines: 90` (currently the active broker — a materially higher ceiling than the previously-discussed Alpaca figure, worth noting since `ibkr_gateway` is the live-configured broker per tonight's health check, not Alpaca).
6. What requires operator dashboard confirmation? Alpaca's data-plan tier (moot right now since `ibkr_gateway` is the active broker, but relevant if the broker selection ever changes back).
7. Dynamic opportunity slots: 12 total minus 3 protected (SPY/QQQ/GLD) = 9, under the Alpaca-cap framing; under the currently-active IBKR Gateway, the effective cap is `hardCapOverride` up to 90 — this materially changes the "ETF monopolization" math from the prior reports, which assumed the Alpaca 12-cap. **Worth flagging: the prior Sept 2–3 ETF-concentration findings should be re-examined under whichever broker is actually active during the analyzed session.**
8–13. Unchanged from the prior three reports; no new evidence this pass to revise them.
14. QuantEngine trustworthy enough for independence escalation? **No** — `BELOW_CHANCE`, unchanged.
15–19. **NO** to all — 0.75, 2-agent, RiskEngine, and no live-path enablement; no safety gate was touched to make a trade more likely.
20. Can ARGUS naturally execute a paper trade tomorrow if a genuinely qualifying setup appears? **Yes**, if the full pipeline holds up — which is exactly what tomorrow's session will test.

## Rollback

- Duplicate-guard: revert the added `_already_healthy()` check block in `local_ai_service.py` (purely additive, safe to remove).
- Memory telemetry: set `memoryTelemetryPersistIntervalMs` very high or remove the `startProcessTelemetry()` wiring block to disable; no schema/DB change was made (reuses `observability_events`).

## Remaining Limitations

- The 5th death's root cause is unresolved. If it recurs tomorrow during market hours, that is a much more urgent signal than a recurrence overnight, and should immediately halt further feature work in favor of dedicated forensics.
- The broker-dependent subscription-cap discrepancy (Alpaca 12 vs. IBKR Gateway up to 90) noted in Q7 above was not fully reconciled against the prior reports' analysis — flagged for the next audit, not resolved tonight.
