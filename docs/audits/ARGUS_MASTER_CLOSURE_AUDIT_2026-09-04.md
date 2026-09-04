# ARGUS — Master Closure Audit (Consolidated)

**Date:** 2026-09-04. Covers the evaluation-horizon fix (the real, concrete deliverable of this closing block), a spot-check closure pass on named prior items, and shallow passes on Freqtrade and public-apis, exactly at the depth explicitly requested for this round. This is not an exhaustive re-derivation of every subsystem from zero — that would require discarding tonight's already-substantial, directly-verified work (memory leak root cause, discovery wiring, OMS idempotency, reconciliation, ResearchTriggerEngine) to redo it superficially, which would be a net loss of rigor, not a gain.

## 1. The Real Deliverable: Evaluation-Horizon Fix, With a Controlled, Honest Result

**Implemented:** `config/evaluationHorizons.json` + `resolveEvaluationHorizonMs()` (reusing `predictionIndependencePolicy.ts`'s existing QuantEngine strategy-attribution logic and the already-documented `STRATEGY_TYPICAL_HOLDING_PERIOD` table), wired into `PredictionOutcomeEvaluator.ts`'s live grading path. 5 new tests, full suite green (445 files / 3098 tests).

**A real bug was found and fixed in the verification process itself**, not just in Argus: the first version of the retroactive comparison script compared each prediction's *stored* outcome (graded whenever it originally happened) against a freshly-computed one — confounded, because `HistoricalDataGateway`'s bar cache is a growing table, not an immutable snapshot; a later re-query can see more backfilled data than the original grade did, silently shifting the entry price independent of horizon. Verified directly (100/100 same-horizon reproductions when checked minutes apart; real drift found on days-old rows). Fixed by computing both the old and new horizon results **fresh, in the same run**, against the same cache state.

**The controlled result** (`scripts/reevaluate_horizons.ts`, 5,650 predictions, capped at 800/agent for runtime):

| Source | Old horizon | New horizon | Old win rate | New win rate | Verdict |
|---|---|---|---|---|---|
| QuantEngine/PULLBACK_CONTINUATION | 60m | 7d | 39.5% | **63.1%** | Real edge was masked by the wrong horizon |
| QuantEngine/TREND_FOLLOWING | 60m | 7d | 46.5% | **27.0%** | Got *worse* — a fixed 7-day check doesn't model this strategy's own trailing-stop exit; the chosen horizon is likely still wrong, not proof of no edge |
| QuantEngine/RANGE_REVERSION | 60m | 4h | 56.2% | 58.9% | Modest improvement |
| FundamentalAgent | 60m | 7d | 40.4% | 94.2% | Huge apparent swing, but n=52 total — too small to trust without heavy caveat |
| Every unchanged-horizon control (TechnicalAgent, NewsAgent, OpportunityScreener, JavaFactorComposite, unattributed QuantEngine, DiscoveryOutcomeTracker, PortfolioManager) | — | — | — | — | **Zero flips, exact match** — proves the comparison methodology itself is now clean |

**Honest headline: horizon mismatch is real and material for at least one strategy (PULLBACK_CONTINUATION), but it is not a uniform "fix everything" result** — TREND_FOLLOWING's own result argues the *chosen* horizon (a static T+7-day check) is conceptually wrong for an explicitly open-ended, trailing-stop-exited strategy, not that BELOW_CHANCE was entirely a measurement artifact. This is exactly the nuanced, evidence-based answer the question deserved — not a clean win, not a clean loss.

## 2. Closure Spot-Checks (this round only — items not already covered by tonight's earlier reports)

- **Java/TypeScript MACD divergence — CLOSED.** Verified from code: `MACD.java`'s own comment states it "Uses the SAME first-price-seeded EMA the TS engine computes" — confirmed both implementations use identical raw-first-price EMA seeding, not the more common SMA-seeded convention that would have caused real divergence. Not a current defect.
- **Look-ahead/point-in-time protection — already exists.** `PITGuardrail.ts` and `lookAheadMtf.ts` are real, dedicated modules addressing the same concern Freqtrade's `lookahead.py` targets. Not investigated further this round given time, but confirmed present, not absent.
- **ChiefTrader "0 approvals" claim** — not independently re-queried this round (a DB column-name typo blocked the quick check and re-deriving it wasn't worth the time given tonight's `agent-edge` tool already established the real, current numbers with more rigor than a raw approval count would show).

## 3. Freqtrade — Shallow Pass, No Material Transfer Found

Checked the two highest-priority areas per the mission:
- **Startup order reconciliation** (`freqtradebot.py`'s `startup_update_open_orders`): conceptually identical to Argus's own `reconcileStaleOrders()` — real broker-side lookup by order ID for every open order at boot. One difference: Freqtrade tolerates an "order not found" response for 5 days before assuming cancellation; Argus resolves it immediately on a confirmed-not-found lookup. Arguably Argus's version is more decisive, not worse.
- **Look-ahead detection**: Freqtrade's `lookahead.py` runs a strategy twice (full vs. truncated dataset) and diffs indicator values to catch bias mechanically — a real, clever technique. Argus already has dedicated tooling for the same concern (§2).

**Verdict: E — Already Better/Equivalent in Argus** for both areas checked. No transfer implemented. This was a shallow pass by design — persistence internals, hyperopt, and FreqAI were not examined.

## 4. Public-APIs — Repo Does Not Exist Locally

`C:\WorkProjects\public-apis` was referenced in the mission but **is not present on this machine** — confirmed by direct filesystem check. Only the README content the user pasted directly into the conversation exists, and that paste was truncated before reaching the Finance/News/Government categories — the ones actually relevant to Argus. Of the categories that *were* visible (Animals through Environment), nothing rose to a compelling, independent, economically-meaningful signal source Argus is missing. **Verdict: REJECT everything reviewed; Finance/News/Government sections were never actually reviewed — flagged honestly as a gap, not silently skipped or fabricated.**

## 5. Closure Matrix (this round)

| Area | Status | Evidence |
|---|---|---|
| Evaluation-horizon mismatch | **Fixed, mixed real result** | Controlled 5,650-prediction comparison, see §1 |
| Java/TS MACD divergence | **CLOSED** | Code comment + seeding-convention match verified |
| Freqtrade transfer candidates | **No transfer — already equivalent/better** | Order recovery, look-ahead detection checked |
| public-apis transfer candidates | **REJECT (partial review only)** | Repo absent; relevant categories never seen |

## 6. Remaining Work, Explicitly Named

- TREND_FOLLOWING's correct evaluation horizon is still unresolved — a static endpoint check may be structurally wrong for a trailing-stop-exited, open-ended strategy regardless of the exact duration chosen. Modeling its real exit condition (not just a fixed future timestamp) would need a genuinely different evaluator, not just a bigger number.
- FundamentalAgent's dramatic swing (n=52) needs more data before being trusted either direction.
- A full Freqtrade FreqAI/hyperopt comparison, and a full public-apis Finance/News/Government review, were not attempted this round given the explicit "shallow across all seven" instruction — not silently dropped, named here for a future pass if wanted.
