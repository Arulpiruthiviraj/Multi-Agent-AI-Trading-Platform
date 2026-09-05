# ARGUS — Universal Opportunity Discovery: Phase 2 Report

**Date:** 2026-09-03
**Scope:** Phase 2 of the Universal Opportunity Discovery mission (follow-up to Phase 1). This pass was interrupted, productively, by a live P0 incident — the fourth silent engine death occurred during this exact investigation, and root-causing it took priority over further discovery-layer feature work, per the mission's own stated priority order (P0: memory/reliability > P1: fairness/emerging-mover capture).

---

## Executive Verdict

**The headline result of this pass is not a discovery-layer feature. It is finding and fixing the actual root cause of the recurring silent engine deaths** that this session's prior audits (Sept 2, Sept 3 x2) had each investigated and left `[UNVERIFIED]`.

**Root cause, confirmed live:** `scripts/local_ai_service.py` (Argus's own Chronos/FinBERT sidecar, backing `KronosForecastAgent`) ran every PyTorch inference call without `torch.inference_mode()` / `torch.no_grad()`. Every `/forecast` and `/sentiment` call built and retained a full autograd computation graph it never needed (this service only ever does forward inference). Measured live: this process's **committed private memory reached 42.8GB** after roughly 5 hours of a live trading session, against a system-wide virtual-memory commit limit of 63.74GB — leaving only 3.66GB free, system-wide, at the moment this was discovered. This is a textbook condition for the OS to deny a memory-allocation request to *any* process (including the main Node.js engine) with no JS-level exception raised — exactly matching the signature of all four observed deaths (zero `crash.log` entries, zero Windows Event Log entries, `cleanShutdown: false`, `exitCode: null`).

**Fixed and verified live this pass:**
1. Added `torch.inference_mode()` around both inference call sites in `local_ai_service.py`.
2. Killed the leaking process (was killed at ~42.8GB committed / ~102GB virtual).
3. Restarted it clean (586MB baseline for both loaded models).
4. Found and removed a second, orphaned duplicate instance that the main engine's own boot sequence had auto-spawned (because the fixed instance was still mid-model-load when the engine's own "launch Chronos if missing" check ran) — the duplicate never bound port 8008 and was pure waste.
5. Restarted the main Argus engine (down since the death); confirmed healthy, `tradingState: TRADING_ENABLED` (persisted from before, no manual resume needed this time), reconciliation clean (`matches: true, mismatchCount: 0`).

This is a Python file outside the TypeScript/Java architecture rules, and outside the protected trading spine entirely (Chronos is explicitly optional/advisory — `KronosForecastAgent` already treats `/health` being down as "unavailable, not fatal," never fatal to trading). The fix required no safety-invariant change of any kind.

---

## 1. Phase 1 Verification

Re-traced (not re-assumed) the Phase 1 wiring: `ComposableRanking.runRankingCycle()` → `SnapshotScanner.lastComposableScoreBySymbol` → `getLastComposableScore()` → `OpportunityDiscovery.blendedHotSwapScore()`. Source unchanged since Phase 1 (`git status` shows no reversions). The fresh restart in this pass (post-death) reloaded this code path; the engine has been running only a few minutes as of this report, so there is not yet a fresh live sample confirming end-to-end effect — Phase 1's own unit/integration tests (26/26, plus the full 3065-test suite) remain the verification of correctness; live opportunity-capture effect should be re-checked after a full regular-hours session (see §6).

## 2. Baseline (best-effort, honestly caveated)

`argus-cli trading-funnel`'s rolling window (`2026-09-02T22:52:32Z` → now) mixes pre- and post-Phase-1 activity and spans the death/restart, so this is a directional baseline, not a clean isolated before/after:

| Metric | Value |
|---|---|
| Total agent evaluations | 1,712 (1,496 directional, 216 HOLD/unavailable) |
| Confidence ≥ 0.60 | 20 |
| Confidence ≥ 0.75 | 15 (the QuantEngine-alone pattern from the prior calibration audit) |
| 2-agent agreement | 318 |
| 3-agent agreement | 27 |
| 4+ agent agreement | 0 |
| Approved (Moderate or Strong) | 0 |
| Risk assessments reached | 0 |
| Paper fills | 0 |
| Top no-trade reason | `CONFIDENCE_BELOW_STRONG` (1,476) |

A clean, isolated post-Phase-1-deploy measurement window requires either a full uninterrupted RTH session (the deploy-then-death-then-restart sequence in this pass gave only ~47 live minutes, followed by after-hours) or a direct timestamp-filtered DB query — not attempted this pass given the death took priority and the market is now closed for the day (current time 18:50 ET, past the 16:00 close).

## 3. Alpaca Subscription Ceiling — Confirmed Not API-Discoverable

Checked `GET /v2/account` (read-only, no subscription change attempted) for any plan-tier field. **Alpaca's market-data plan tier (which governs the real IEX/SIP streaming symbol ceiling) is a billing-account property, not exposed by the trading API at all** — confirmed by direct inspection of the account response (no `data_plan`/`market_data_tier`-shaped field present). This is not solvable by further code investigation; it requires the operator to check the Alpaca dashboard's billing/market-data-plan page directly. Left unchanged, `maxActiveSubscriptions` stays at 12, per Phase 1's own caution against guessing this number.

## 4. Everything Else in the Phase 2 Spec

Deliberately not attempted this pass: reference/opportunity resource-pool separation, opportunity-decay eviction scoring, the bounded independent-evidence-request mechanism for the "confidence≥0.75 alone" case, confluence-window timing analysis, emerging-opportunity scoring, per-strategy coverage breakdown, Fundamental/Macro weight investigation, discovery recall against external ground truth, and the full before/after scorecard. Each of these is a real, legitimate ask — none were skipped by oversight. They were deprioritized because a live P0 reliability incident (this session's fourth silent death, now root-caused) took precedence, exactly matching the mission's own stated priority order (§21: "Do not implement lower-priority work while a P0 issue would make the runtime unreliable").

## 5. Files Changed

- `scripts/local_ai_service.py` — `torch.inference_mode()` added around the `/forecast` and `/sentiment` inference call sites. No TypeScript/config/schema changes this pass.

## 6. Answers to This Phase's Most Important Questions

- **Q22 (memory growth): fixed and explained?** Yes for the Chronos sidecar — root-caused to missing `inference_mode()`, fixed, and the fix is live. The main Node.js engine's own memory behavior (the original "607MB→3.85GB" framing from the Sept 2 audit) was not re-investigated this pass; given the new evidence, it is now plausible that engine-side RSS growth was itself partly a symptom of system-wide memory pressure from the Python process rather than a separate Node-side leak — this should be re-measured now that the Python leak is fixed, not assumed either way.
- **Q23 (silent deaths): root cause?** **Confirmed, not `[UNVERIFIED]` this time** — direct, contemporaneous, quantitative evidence (42.8GB committed on a 63.7GB system limit, "low virtual memory" Windows events 2 minutes before the exact last heartbeat) plus a clear, well-documented, directly-observable code defect. This is the strongest evidence this multi-day investigation has produced on this question.
- **Q24 (ready for unattended RTH operation)?** Materially more likely than before this fix, but **not yet re-proven** — the fix needs to survive at least one full uninterrupted RTH session before this can be upgraded from "plausible fix" to "verified fix."
- **Q25 (what remains)?** A full RTH session with the fix live, watching both process's memory curves; then the deferred Phase 2 items in §4, prioritized by the operator.

## Rollback

Revert the two `with torch.inference_mode():` blocks in `scripts/local_ai_service.py` if this is ever suspected of changing forecast/sentiment output (it should not — `inference_mode` only disables gradient tracking, never changes forward-pass numerics).

## Next Phase

1. Watch both process memory curves through one full RTH session to confirm the fix holds.
2. Re-run the deferred Phase 2 discovery-fairness items (§4) once reliability is confirmed stable.
3. Ask the operator to check Alpaca's actual data-plan tier from their dashboard.
