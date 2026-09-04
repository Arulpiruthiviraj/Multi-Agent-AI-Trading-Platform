# ARGUS — Universal Opportunity Discovery: Final Consolidated Report

**Date:** 2026-09-03. Consolidates Phase 1, Phase 2, and this closing investigation round into one reference document, per operator request ("do all discovery and audit complete and provide last file url").

---

## Executive Summary

Three rounds of work, in order:

1. **Phase 1** — forensically verified that most of the requested discovery/ranking infrastructure already existed (built Aug 26–Sep 2, before this investigation began), then found and fixed the one real gap: `ComposableRanking`'s 7-component evidence-aware score was computed every cycle but had zero path into actual market-data slot allocation. Fixed, tested (26/26 targeted, 3065/3065 full suite), deployed live.
2. **Phase 2** — a live P0 incident interrupted planned feature work: the engine died silently a fourth time, mid-session. Root-caused it, for the first time with real evidence: `scripts/local_ai_service.py` (Argus's own Chronos/FinBERT sidecar) leaked memory because its PyTorch inference calls never used `torch.inference_mode()`, reaching 42.8GB committed against a 63.7GB system-wide limit — precisely the condition that would silently kill any process, including the main engine, with zero JS-level exception. Fixed, verified, both services restarted clean.
3. **This closing round** — investigated the two remaining planned builds (an "independent evidence request" mechanism for lone strong QuantEngine signals, and an opportunity-decay mechanism) before writing either. **Neither is justified by the evidence.** This section is the most important new content in this report.

**Net new code this entire mission:** one discovery-layer scoring fix (Phase 1) and one Python inference-mode fix (Phase 2). Nothing else was built, because nothing else survived verification against real evidence — which is itself the correct, disciplined outcome, not an incomplete one.

---

## Closing Investigation: Why the Two Remaining Planned Builds Were Not Built

### 1. The "independent evidence request" mechanism — not built, and here is the evidence why

The mission asked for a bounded mechanism: when QuantEngine clears 0.75 confidence alone (the 15-case pattern from the prior calibration audit), request a second independent agent's evaluation before rejecting, rather than rejecting outright for lack of independence.

Before writing this, `argus-cli agent-edge` was run — a real, already-built, rigorous calibration-maturity tool using Wilson confidence intervals on *effective* (independence-adjusted) sample sizes, not raw counts. Its result:

```
Eligible (agent, bucket) pairs: 0 / 35
...
QuantEngine   (overall)   N=1012  EffN=52   WinRate=0.346  WilsonLo=0.232  Status=BELOW_CHANCE
```

**QuantEngine's overall, real, measured track record is statistically BELOW chance** — its Wilson upper bound doesn't clear 0.5. This is not "unproven," it is "measured negative." Building a mechanism whose entire purpose is to make it *easier* for QuantEngine's lone signals to survive the independence gate would mean spending real engineering effort helping a currently sub-chance signal source get more chances to place paper trades. That is the opposite of "opportunity quality over opportunity count." **The independence gate rejecting those 15 signals looks, on this evidence, like it was doing exactly its job — not an artifact of orchestration/resource starvation to be engineered around.**

This also revises the prior calibration audit's framing: that report correctly declined to say "ChiefTrader correctly declined to trade" as settled fact, and left the 0.75-alone question open. This round's evidence moves it substantially further toward "the gate looks right" than the prior report could support — though it's worth noting `PULLBACK_CONTINUATION__COLD_START_BOOTSTRAP` (QuantEngine's most active strategy tag, 667 samples) is *also* `BELOW_CHANCE` at Wilson-lo 0.097, reinforcing rather than contradicting this.

**Recommendation:** do not build the evidence-request mechanism until QuantEngine's own calibration improves to at least `NO_EDGE_DETECTABLE` (not proven negative). Revisit if/when `agent-edge` shows a different picture.

### 2. Opportunity-decay eviction scoring — not built, and here is the evidence why

The mission assumed stale candidates might monopolize market-data slots because their priority score never decays. Traced the actual code path (not assumed): `blendedHotSwapScore()` is called fresh every ~30s cycle via `planSnapshotHotSwap()`, and its base score comes from `getLastSnapshotScore()` — which is repopulated for the *entire scanned universe* every single `refreshSnapshotRanks()` cycle, including already-subscribed symbols. So a symbol that won a slot on rising momentum and then goes quiet is **already** re-scored honestly on the next cycle and can already lose its slot to a fresher, higher-scoring candidate — real, working decay-by-rescoring, not frozen priority.

One narrower, lower-priority staleness *was* found: `MarketDataWorker`'s own internal fallback pruning path (`pruneLeastActiveWatchSymbols`, used for cap-overflow/oversized-set recovery — a secondary safety net, not the primary hot-swap decision) reads `dynamicMomentumScores`, a field only updated via `subscribe()` calls, which are never issued for already-active symbols. This path could theoretically use a stale score for a long-held incumbent. It is real but narrow (a fallback path, not the primary allocation mechanism) and was not fixed this pass — noted as a minor, optional future item, not urgent.

**Recommendation:** no opportunity-decay system needed. The primary allocation path already decays correctly by construction.

### 3. Observability gaps named in the mission (`TRADE_IDEA_REJECTED`, `AI_PROVIDERS_EXHAUSTED`) — already adequate

Re-verified by reading `EventBus.ts` and `AIRouter.ts` directly (not assumed from the mission's premise that these were broken):
- `TRADE_IDEA_REJECTED` payloads already carry `reason`, `symbol`, `agent`, `traceId` — confirmed in Phase 1, reconfirmed here.
- `AI_PROVIDERS_EXHAUSTED` payloads already carry `agentType`, `providersAttempted` (the actual list tried), `lastError`, and a real skip-reason breakdown (`skippedAuthCooldown`/`skippedTemporary`/`skippedDisabledInDb`) via `countUnroutableReasons()`. Not a perfect enum of TIMEOUT/RATE_LIMIT/AUTH categories, but materially more than "nothing" — not worth new code this pass.

---

## Full Timeline of Fixes Made

| # | Fix | File(s) | Verified |
|---|---|---|---|
| 1 | Wire `ComposableRanking.finalScore` into real market-data slot allocation | `SnapshotScanner.ts`, `OpportunityDiscovery.ts`, `config/continuousIntelligence.{ts,json}` | 26/26 targeted tests, 3065/3065 full suite, `tsc` clean, live-deployed |
| 2 | Fix unbounded PyTorch memory growth in the Chronos/FinBERT sidecar (root cause of 4 silent engine deaths) | `scripts/local_ai_service.py` | Live-verified: leaking process (42.8GB committed) killed, restarted clean (586MB), stable at ~640MB after ~30 min post-fix |

## What Remains Genuinely Open (not built, not resolved, honestly listed)

1. **A full RTH session with the Chronos fix live**, to confirm the memory fix holds for a complete trading day, not just ~30 minutes of after-hours idle time.
2. **The main Node engine's own memory curve**, re-measured now that the dominant external pressure (the Python leak) is removed — not yet re-profiled.
3. **Alpaca's real data-plan subscription ceiling** — confirmed this round to be *not* discoverable via any API call (`GET /v2/account` has no such field); requires the operator to check their Alpaca dashboard directly.
4. **Discovery recall against external ground truth**, per-strategy coverage breakdown, confluence-timing/cadence-mismatch analysis — all require either live RTH data or an explicit decision to bring in a new external data dependency; not attempted, not silently dropped.
5. The narrow `dynamicMomentumScores` staleness in `MarketDataWorker`'s fallback pruning path (§2 above) — real, minor, not fixed.

## Safety Statement

Across all three rounds: `PAPER_TRADING_ONLY`, `LIVE_NO_GO`, the 0.75 threshold, the 2-agent independence rule, and every RiskEngine gate were never touched, never proposed to be touched, and this round's own evidence (QuantEngine `BELOW_CHANCE`) is itself an argument for leaving them exactly as they are.

## Rollback

- Discovery wiring (Phase 1): set `composableRankingHotSwapWeight` to `0` in `config/continuousIntelligence.json`.
- Chronos fix (Phase 2): revert the two `with torch.inference_mode():` blocks in `scripts/local_ai_service.py` if ever suspected of changing output (it will not — `inference_mode` only disables gradient tracking).

## Recommended Next Step

Let the engine run a full, uninterrupted RTH session with both fixes live. Re-run `argus-cli agent-edge` and the Sept-2/3-style admission/participation query after that session to get a real, clean before/after — the honest next data point, not a further round of speculative building.
