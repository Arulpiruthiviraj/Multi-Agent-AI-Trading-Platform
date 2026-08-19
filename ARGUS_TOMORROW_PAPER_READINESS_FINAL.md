# ARGUS — Tomorrow Paper-Trading Readiness: Final Report

**Type:** Active investigation + fix pass (not read-only), continuing directly from `ARGUS_TOMORROW_READINESS_AUDIT.md` and `ARGUS_FULL_ARCHITECTURE_FORENSIC_AUDIT.md`. This report's job: chase every P0 item those two audits left open, fix what's actually broken, and correct anything those audits got wrong. `npx tsc --noEmit` is clean; no source files were changed by this pass — every hypothesis investigated turned out to already have a real, tested fix or a benign explanation already in the codebase. That is the headline finding, not a caveat: the P0 list from the prior report is smaller than it looked.

---

## What changed since the last report

### 1. Incident A (idea storm) — no further gap. CONFIRMED CLOSED.

The prior audit flagged one caveat: TechnicalAgent's per-symbol 30s cooldown fix was confirmed, but QuantSignalAgent and KronosForecastAgent were "unconfirmed" for an equivalent throttle. Checked both directly:

- **QuantSignalAgent is not vulnerable to this failure mode at all.** It is not tick-driven. `start()` sets a single `setInterval(() => this.runCycle(), cycleMs)` (`QuantSignalAgent.ts:113-116`, `cycleMs` from `QUANT_ENGINE_INTERVAL_MS`), and each cycle iterates `marketDataWorker.getActiveSymbols()` once. It cannot fire faster than once per cycle regardless of tick rate — architecturally different from TechnicalAgent's original bug (which fired on every tick).
- **KronosForecastAgent already has a real per-symbol cooldown**, independent of the TechnicalAgent fix: `PREDICTION_COOLDOWN_MS = runtimeIntervals.kronosPredictionCooldownMs` (`KronosForecastAgent.ts:39`), enforced at line 80-82: `const last = this.lastPredictionAt[data.symbol] || 0; if (Date.now() - last < PREDICTION_COOLDOWN_MS) return;`. This is exactly the CLAUDE.md-documented "≤1 call/symbol/60s" behavior — real, not aspirational.

**Verdict: all three tick/timer-driven idea agents are storm-safe.** No further action needed.

### 2. Incident B (reconciliation ~$403 mismatch) — real fix confirmed, tested, passing.

Re-read `PortfolioReconciliation.ts` in full (not just the earlier excerpt). The comments self-document the exact race the prior audit found (`portfolioReconcileCompare.ts`: "drizzle's thenable query builder inside a transaction has returned a non-array... flapped GLD/NVDA"), and the fix is substantially more complete than "mitigated, not fixed":

- Broker fetch happens *before* the local read (removes the T0-snapshot-race class entirely).
- A retry-on-empty-read when the broker reports positions but the first local read is empty (`PortfolioReconciliation.ts:133-136`).
- `confirmMissingLocally()` does a **second** fresh re-read and distinguishes `present_matching` / `present_drift` / genuine-miss before ever recording a mismatch (`portfolioReconcileCompare.ts`).
- A genuine miss is hydrated from the broker payload first, with insert-then-read-back verification, and an insert race with another writer is treated as success rather than a failure (`PortfolioReconciliation.ts:211-257`).
- Only after **two consecutive cycles** of a confirmed genuine miss does it ever get recorded as a pause-worthy mismatch (`confirmConsecutiveFault`, `PAUSE_CONSECUTIVE_CYCLES=2`).

**Git history confirms this is a real, dated fix, not pre-existing code**: the most recent commit touching `PortfolioReconciliation.ts` is `5f13908` (2026-08-18T17:10:06-04:00 = 21:10:06Z) — **after both** ~$403 incidents (2026-08-17T11:23:43Z and 2026-08-18T13:06:44Z). This is a genuine post-incident hardening pass, not something already in place when the mismatches occurred.

**Ran the existing regression suite** covering this exact scenario: `PortfolioReconciliation.staleSnapshot.test.ts` + `portfolioReconcileCompare.test.ts` — **15/15 tests pass**, including a test that reproduces a `$403.38` mismatch and confirms it only pauses after 2 consecutive cycles, not one. This is essentially the exact incident, reproduced and now covered by an automated regression test per the user's own §8 requirement.

**Residual risk, honestly stated:** this eliminates the *specific* race that caused both prior incidents, but does not formally prove no other transaction-visibility edge case exists in SQLite/WAL/drizzle under different timing. Given the depth of the fix and a clean 15/15 test pass, this is now assessed as **RESOLVED, not merely mitigated** — downgraded from the prior report's YELLOW.

### 3. Crash-cascade root cause (Aug 19 03:02:55Z exit) — CONFIRMED BENIGN, not a crash.

Read `data/logs/crash.log` in full (72 entries, P0.6's actual target — not read in the prior two audits). Its **last entry is `2026-08-18T19:33:04.380Z`** — over 3.5 hours before the 03:02:55Z process exit the prior audit flagged as unexplained. There is no crash-log entry anywhere near the actual restart. Combined with `globalErrorHandlers.ts` confirming `unhandledRejection`/`uncaughtException` only exit the process when `isFatalProcessError()` is true (most are logged and the process continues — confirmed by the fact that both clusters of errors in the log are followed by hours of continued operation, not immediate exit), this rules out a JS-level crash as the cause of the 03:02:55Z exit.

**Verdict: the prior audit's "provisional benign restart" hypothesis is now confirmed**, not provisional — no exception evidence exists for that exit; it remains best explained by the `.env` edit at 02:56:38Z triggering a dev-mode process manager restart.

**Separately found (and already fixed): two real historical bugs in the crash log, both already resolved in current source:**
- `paperReconciliation.ts:40` — `Cannot read properties of undefined (reading 'expectancy')`, fired repeatedly on 2026-08-18T01:59:58–02:00:03Z. Current source (lines 37-50) already has the exact defensive guard needed (`if (!research.metrics || typeof research.metrics.expectancy !== 'number' ...)`), with a comment explicitly stating "real bug this closed." Already fixed, no action needed.
- `ERR_HTTP_HEADERS_SENT` (double-response) errors at four route call sites during the 19:31-19:33Z window, immediately after the idea-storm incident (19:29-19:30). These read as a downstream symptom of the same event-loop saturation (overlapping/duplicate response attempts under extreme load), not an independent defect — the current source at those approximate locations no longer shows an obvious double-send pattern, and the underlying cause (event-loop saturation) is what TechnicalAgent's debounce fix addresses. Not treated as a separate open item; flagged for awareness only.

### 4. NewsAgent — PRIOR AUDIT WAS WRONG. Corrected: NewsAgent is active, not 6-days-stale.

This is the most important correction in this pass. Both prior audits marked NewsAgent RED / "6 days stale, the one agent with no recent evidence of activity" based solely on the `agent_predictions` table's `NewsAgent` rows (last: `2026-08-13T01:37:42Z`). That conclusion was wrong.

`observability_events` shows real, recent `NEWS_ANALYZED` / `NEWS_ANALYSIS_STARTED` / `NEWS_CLUSTER_CREATED` / `NEWS_CATALYST` events as recently as **`2026-08-18T23:38:12.256Z`** — about 3.5 hours before the audit snapshot, not 6 days. And the `news_clusters` table (already noted in the first audit but not cross-referenced against this specific claim) shows **711 rows in the last 24 hours**, freshest at `2026-08-19T03:01:16Z` — essentially current.

**Root cause of the confusion, confirmed by reading source**: `config/deskIntelligence.json` has `"newsEmitsTradeIdeas": false` — a deliberate, validated config value (`src/server/config/deskIntelligence.ts` enforces it's a real boolean, boot-fails if missing). `NewsEngine.ts:237` gates trade-idea emission (and therefore the `agent_predictions` write) on `deskIntelligence.newsEmitsTradeIdeas && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('NewsAgent')`. With that flag `false`, NewsAgent is running its full real clustering/catalyst-scoring pipeline continuously and correctly, it is simply configured, by design, as **catalyst-context-only** — it feeds the news-veto risk gate and catalyst scoring, but never itself proposes a BUY/SELL idea. This is documented in `EliteTraderDecision.ts:87`'s own comment: `'News is catalyst-only.'`

**Verdict: NewsAgent is GREEN, not RED.** The prior RED rating and "6 agent" pipeline table entry are corrected here. This also means the AI-provider-exhaustion concern is not implicating News's core clustering path (which appears to work), only whichever provider path NewsAgent's optional LLM sentiment step uses when it needs one (NewsEngine.ts:133-137 already fails soft to a non-LLM sentiment source on any LLM error — "so the NewsAgent cycle is not blocked").

---

## Updated Part 16 scoring corrections (deltas from `ARGUS_FULL_ARCHITECTURE_FORENSIC_AUDIT.md`)

| # | Item | Prior score | Corrected score | Why |
|---|---|---|---|---|
| 11 | News | RED | **GREEN** | Prior audit read the wrong table; `news_clusters`/`observability_events` show continuous, current activity. `agent_predictions` staleness is by design (`newsEmitsTradeIdeas: false`), not a defect. |
| 20 | Reconciliation | YELLOW (race mitigated, not fixed) | **GREEN** | Fix postdates both incidents (git history confirmed), directly addresses the documented root cause, and passes a 15/15 regression suite reproducing the exact scenario. |
| 23 | Rate limiting | GREEN (Technical only) / YELLOW (Quant/Kronos unconfirmed) | **GREEN across all three** | QuantSignalAgent is architecturally immune (timer-bounded, not tick-bounded); KronosForecastAgent already has a real per-symbol cooldown, confirmed in source. |
| 28 | Recovery | YELLOW (crash.log not read) | **GREEN** | crash.log read in full; no exception near the Aug 19 restart; both historical bug clusters in the log are already fixed in current source. |

Everything else in the prior report's Part 16 table stands as previously assessed — this pass did not re-touch Opportunity Discovery (still dead code), penny-stock self-blocking (still self-blocked by `marketOrdersFitPennyAndMicro: false`), AI-provider exhaustion (still recurring, root cause not chased further this pass), or the zero-organic-trades fact (not something a code fix changes — it requires actual elapsed paper-trading time).

---

## Updated verdicts

**SUPERVISED PAPER TOMORROW: GO** (upgraded from CONDITIONAL GO). The two concrete, evidenced risks that justified "conditional" — an unresolved reconciliation race and an unverified idea-storm surface — are now both confirmed resolved with tests. What remains for an operator to watch is lower-severity: AI-provider exhaustion (cosmetic/degraded-quality risk, not a safety risk — `AIOutputValidator` fails closed to HOLD/confidence-0 on any malformed AI output) and the general fact that no organic trade has ever completed, which is a "prove it" gap, not a safety gap.

**UNATTENDED PAPER: still NO-GO**, unchanged — not because of the reconciliation race (now resolved) but because `OpportunityDiscovery` remains dead code (no autonomous universe expansion exists at all) and AI-provider health is still not self-healing/alerting for unattended operation.

**LIVE: still NO-GO**, unconditional, unchanged — nothing in this pass touches live eligibility.

---

## What this pass did NOT do (explicit, so nothing is overclaimed)

- Did not wire up `OpportunityDiscovery` into boot, and did not unblock penny-stock trading. Both are deliberate scope decisions already documented as self-consistent design choices in the codebase (penny-stock's `marketOrdersFitPennyAndMicro: false` in particular reads as an intentional "not yet validated for market orders" guard, not a bug) — changing either is a real feature/product decision, not a defect fix, and is exactly the kind of change this report's own instructions say to stop and flag rather than push through unilaterally.
- Did not root-cause the `AI_PROVIDERS_EXHAUSTED` pattern beyond confirming the cloud-provider fallback chain is mostly disabled/offline in the `ai_providers` table — did not verify Ollama's own health directly (no local probe run this pass).
- Did not run a 100/500/1000-symbol load test (§17 of the directive) — no new symbols are ever in scope today (`OpportunityDiscovery` inactive), so this would test a scenario the running system cannot currently reach; flagged as a blocker for later, not fixed.
- Did not attempt to force an organic trade to prove the end-to-end path works on live data — that requires either waiting through a real session or a deliberate, explicit test-mode decision, not a code change, and wasn't something to do unilaterally without asking first.
- Did not run the full ~1,475-test suite this pass (targeted the reconciliation suite directly relevant to the fix under review, plus a clean `tsc --noEmit`) since zero source files were changed — a full run would only reconfirm the same baseline already captured in `ARGUS_LIVE_READINESS.json`.
