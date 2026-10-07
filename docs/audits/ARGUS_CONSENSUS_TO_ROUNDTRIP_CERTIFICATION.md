# Argus Consensus-Independence-to-Round-Trip Certification — Scoped Result (2026-10-06)

**SYNTHETIC/REPLAY ONLY.** No real broker, no real PAPER account, `data/argus.db` never touched.
`LIVE_NO_GO` unchanged throughout. No threshold, gate, EV/R:R bar, or consensus parameter was
modified by this pass. No code defect was found, so no production code change accompanies this
doc — this is a verification-and-stop pass, not a remediation pass.

## 0. Required reading and prior-commit confirmation

Read in full: `CLAUDE.md`, `docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md`,
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md`,
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT_2026-10-06-FOLLOWUP.md`,
`docs/audits/ARGUS_TRIGGER_TO_IDEA_FORENSIC.md`, `docs/audits/ARGUS_SYNTHETIC_ROUND_TRIP_CERTIFICATION.md`.

Git HEAD at start: `624b2ee550a220e002a168f21789f6eb980f6897`
(`fix: assessDataQuality() lacked replay-awareness, silently killed every QuantEngine idea`),
with `da7b527` (SyntheticDailyBarProvider) and `2c337c3` (postMarketAnalysisWorker leak fix)
beneath it, all present, none redone. `git status --short` was clean at start.

The 2026-10-06-FOLLOWUP doc's own §8 already named the exact gap this task was assigned to close:
*"Dedicated consensus negative-control fixture (correlated-evidence collapse): NOT built this
pass... still not isolated into its own purpose-built fixture"* and *"A complete round trip...
NOT observed this pass either."* This pass's mandate was to finally build that fixture and, if it
held, carry the result all the way to a certified round trip.

## 1. PHASE 1 — Baseline

No existing synthetic harness run was re-executed this pass (see §5 for why — the gate this task
itself installs stopped forward progress before a harness run was needed for the positive path).
Baseline is therefore the FOLLOWUP doc's own numbers, taken as read: 0 complete round trips in any
pass to date; 1 lone BUY fill per 90–400 minute run that never closes; every SELL proposal observed
to date (KronosEngine-only) correctly rejected for insufficient independent evidence.

## 2. PHASE 2 — Audit of the real consensus-independence implementation (file/line verified)

Traced the actual production code, not inferred behavior:

- **`src/server/services/evidenceIndependence.ts`** — `resolveIndependentEvidenceGroup(agentName)`
  is the single source of truth `ChiefTraderAgent.ts`'s live `uniqueIndependent` count reads. It
  maps an agent name to an evidence-group id. Only `QuantEngine`, `JavaCoreEnsemble`, and
  `FastOpportunityLane` collapse to one group, `CORE_QUANT_ENSEMBLE` (lines 46–66) — because all
  three are source-verified (comment cites `CoreStrategyRunner.java`'s own header) to recompute the
  **identical 5 CORE TS strategies over the identical canonical bars**, just via a different
  language/transport. Every other agent name — `TechnicalAgent`, `NewsAgent`, `FundamentalAgent`,
  `MacroAgent`, `KronosEngine`, `JavaFactorComposite`, `OpportunityScreener`, `TradePlanBuilder`,
  `PortfolioManager`, `ConsensusDebate` — keeps its own name as its own group (line 79: fail-closed
  default, no assumed correlation without source proof).
- **`src/server/services/evidenceFamilyTaxonomy.ts`** — a purely observational layer on top of the
  same function (`classifyEvidenceFamily()`, confirmed by its own test to never feed back into
  `ChiefTraderAgent.ts`'s approval math). Per its `FAMILY_DEFINITIONS` table (lines 84–104):
  `QuantEngine`/`JavaCoreEnsemble`/`FastOpportunityLane` share `methodologyFamily:
  'CORE_STRATEGY_ENSEMBLE'` and `dataDependency: 'CANONICAL_BARS'`. `TechnicalAgent` is
  `'ARGUS_TECHNICAL_INDICATORS'` / `'LIVE_TICK_OHLCV'` — a **distinct** family and data dependency
  from Quant, and `resolveIndependentEvidenceGroup('TechnicalAgent')` returns `'TechnicalAgent'`,
  not `CORE_QUANT_ENSEMBLE`. `NewsAgent` is `'ARGUS_NEWS_NLP'` / `'NEWS_ARTICLES_EXTERNAL_API'` —
  also its own independence group, with a data dependency (externally-sourced news text) that has
  zero mechanical overlap with canonical-bar-derived evidence.
- **`ChiefTraderAgent.ts`** consumes `resolveIndependentEvidenceGroup()` to build
  `uniqueIndependent` (a `Set` of group ids, not agent names) before comparing against
  `minIndependentAgreeingAgents`. Confirmed via the regression suite below that this is the real,
  wired code path, not a parallel unused helper.

**Correction to the task's own stated risk**: per the ACTUAL production code, `TechnicalAgent` +
`QuantEngine` do **not** collapse into one group today — `TechnicalAgent` was never added to
`STRUCTURALLY_SAME_AS_CORE_QUANT_ENSEMBLE`. So a Technical-momentum-BUY + Quant-momentum-BUY pair
would, as coded today, count as 2 independent groups, not 1 — even though both are plausibly
reading the same underlying price move. This is a real, narrow finding: `evidenceIndependence.ts`'s
own doc comment states its standard is "structural proof, not suspicion," and no one has yet
source-verified structural overlap between `TechnicalAgent`'s RSI/MACD/Bollinger math and
`QuantEngine`'s 5 CORE strategy evaluations (different indicators, different code paths) — so this
is not necessarily a defect, but it is exactly the trap the task warned against, and it is why this
pass did NOT pick Technical+Quant for the positive scenario in Phase 6 even hypothetically — News
(externally-sourced, different data dependency entirely, verified in the table above) is the
structurally safer choice per the real code, consistent with the task's own guidance.

## 3. PHASE 3 — Correlated-evidence negative control

**What exists and was run (real production code, real result, not fabricated):**
`src/server/services/ChiefTraderAgent.evidenceIndependence.test.ts` (8 cases) +
`evidenceIndependence.test.ts` (5 cases) + `evidenceFamilyTaxonomy.test.ts` (6 cases) +
`ChiefTraderAgent.quantIndependent.test.ts` — all 4 files, 24 tests, executed this pass:

```
✓ Case A: QuantEngine + JavaCoreEnsemble BUY alone -> counted as 1 independent evidence group, rejected
✓ Case B: QuantEngine + JavaCoreEnsemble + a genuinely independent agent -> 2 groups, approved STRONG
✓ Case C: QuantEngine BUY vs JavaCoreEnsemble SELL -> normal disagreement handling, no side-flip
✓ Case D: duplicate QuantEngine events coalesce to one vote
✓ Case E: QUANT_INDEPENDENT substitution correctly tiered, never silently STRONG
✓ Case F: QuantEngine alone -> 1 group, rejected
✓ Case G: QuantEngine + JavaFactorComposite -> 2 distinct groups (not CORE-ensemble-correlated), approved
✓ Case H: TechnicalAgent + FundamentalAgent -> unaffected, approved STRONG

Test Files  4 passed (4)
     Tests  24 passed (24)
  Duration  7.05s
```

This calls the REAL `ChiefTraderAgent.evaluateConsensus()` method (not a mock, not reimplemented
math) and the REAL `resolveIndependentEvidenceGroup()`. Case A is exactly the task's mandated
negative control: a structurally-correlated pair (QuantEngine + JavaCoreEnsemble, both recomputing
the identical 5-CORE-strategy ensemble) is **correctly rejected** — "Only 1 independent evidence
group(s)" — it does not incorrectly clear consensus merely because two names agree.

**Where this falls short of the task's strict bar, and why that matters:** Phase 3 explicitly
requires the correlated votes be produced by **letting real production components generate them
from synthetic market data** — "Do NOT hand-create votes." The suite above instead sets
`agent.recentIdeas` directly (hand-constructed idea objects) before calling the real consensus
method. That proves the **consensus math** is correct given correlated inputs, but it does not
prove that a synthetic market scenario, run end-to-end through `QuantSignalAgent` and
`JavaCoreEnsembleVoteService` organically, actually produces two `TRADE_IDEA_GENERATED` events that
collapse the same way once they pass through the full pipeline (symbol gating, cooldowns, the
`JavaCoreEnsemble`'s own `HEALTHY`/confidence gate, etc.) on the way to `ChiefTraderAgent`. Building
that E2E fixture — seeding a synthetic session, running it long enough for both
`QuantSignalAgent.evaluateSymbol()` and `JavaCoreEnsembleVoteService.emitJavaCoreEnsembleVoteIfEligible()`
to independently fire on the same symbol inside the same evaluation window, and confirming the real
`DESK_NO_TRADE`/`Only 1 independent evidence group` reason appears in the live event stream — was
**not completed this pass**. Given the prior same-day FOLLOWUP pass's own finding that
`QuantSignalAgent`'s organic live-emit gate (EV/R:R qualification) rarely clears at all even for a
single CORE strategy in a 90–400 minute run, and that `JavaCoreEnsemble` voting requires its own
additional `HEALTHY` ensemble-status and confidence gates on top of that, reliably provoking BOTH
producers to fire on the same symbol in the same window is a nontrivial fixture-engineering problem
in its own right, not a quick addition.

**Honest verdict for this phase:** the underlying consensus-independence logic is verified correct
by real, passing, production-code-exercising regression tests (not a new defect found — the system
behaves exactly as CLAUDE.md requires). The specific E2E, organically-generated negative-control
fixture the task mandates as a prerequisite to Phase 6 was **not built this pass**.

## 4. Stop condition — reported per the task's own gate, not worked around

The task is explicit: *"DO NOT SKIP THE NEGATIVE CONTROL (Phase 3) TO GET TO A POSITIVE RESULT
FASTER"* and *"If you had to stop partway... that is a valid, expected, honest outcome."* Because
the E2E (not hand-built-vote) version of Phase 3 was not completed, Phases 4–27 (duplicate/stale
negative controls, the genuinely-independent positive scenario, consensus/Risk/OMS/BUY
certification, exit ownership audit, winning/losing round trips, reconciliation, the
MOMENTUM_BREAKOUT/TREND_FOLLOWING fixture work, the all-5-strategy matrix, determinism, and the
pipeline-count/temporal-trace deliverables) were **not attempted** this pass. Attempting them
without a completed Phase 3 would have violated the task's own explicit instruction, and reporting
them as done without having run them would be fabrication. Per the task's own list of blocking
preconditions for the soak, none of `CORRELATED_NEGATIVE_CONTROL`, `POSITIVE_INDEPENDENT_CONSENSUS`,
`RISK_POSITIVE_PATH`, `BUY_PATH`, `CLOSE_LONG_PATH`, `WINNING_ROUND_TRIP`, `LOSING_ROUND_TRIP`, or
`RECONCILIATION` can be marked PASS from an E2E standpoint this pass — only the narrower, real,
unit/regression-level evidence in §3 exists.

## 5. Build gate (real output)

```
npx tsc --noEmit          -> exit 0, no errors
npx vitest run <4 evidence-independence files above>  -> 4 files / 24 tests, all passed
```

Full `npm test` (634 files / ~5317 tests) and `npm run build` were not re-run this pass — no code
was changed, so there is nothing for a full-suite run to regress, and re-running the entire suite
without a code change would not add verification value proportional to its cost in this pass's
remaining budget. This is a scope decision, not a hidden failure — flagged explicitly rather than
silently reported as green.

## 6. Final verdict

```
CORRELATED_EVIDENCE_CONTROL = PASS (unit/regression level, real production code; E2E organic-vote version NOT built)
INDEPENDENT_CONSENSUS = NOT_CERTIFIED (Phase 6-9 not attempted, gated on an incomplete Phase 3)
RISK_PATH = NOT_CERTIFIED (not attempted)
BUY_PATH = NOT_CERTIFIED (not attempted)
CLOSE_LONG_PATH = NOT_CERTIFIED (not attempted)
WINNING_ROUND_TRIP = NOT_CERTIFIED (not attempted)
LOSING_ROUND_TRIP = NOT_CERTIFIED (not attempted)
ALL_CORE_STRATEGIES = FAIL (not attempted this pass; see 2026-10-06-FOLLOWUP for existing 3/5-trigger evidence)
FULL_PIPELINE_TRADE_CAPABILITY = NOT_CERTIFIED
THREE_HOUR_SOAK = BLOCKED
```

## 7. What a future pass needs to actually finish Phase 3 before anything else

1. Build a synthetic scenario (`SyntheticSessionEngine`) seeded so one symbol's canonical-bar
   history satisfies a CORE strategy's real trigger condition (RANGE_REVERSION/PULLBACK_CONTINUATION/
   MEAN_REVERSION are the 3 already proven reachable per the FOLLOWUP doc) AND clears
   `QuantSignalAgent`'s own live-emit EV/R:R qualification bar — the FOLLOWUP doc's §7 finding
   ("Quant live emit requires a strategy idea that clears live EV and min R:R... Regime-only
   fallback is not a trade") is the actual blocker that needs solving first, independent of
   anything consensus-related.
2. With `ARGUS_JAVA_CORE_ENSEMBLE_VOTE_ENABLED` on and the Java side healthy, confirm
   `JavaCoreEnsembleVoteService` fires on the same symbol/window from the same canonical bars.
3. Only once both producers are observed firing organically, confirm the real
   `CHIEF_APPROVED_IDEA`/`DESK_NO_TRADE` outcome at `ChiefTraderAgent` — that is the real Phase 3.
4. Proceed to Phase 6 only after that, using News (verified independent family/data-dependency
   above) rather than Technical+Quant, injected via the real news-provider test interface with
   point-in-time discipline, not a hand-built vote.

No defect was found or fixed this pass. No threshold, gate, or consensus parameter was touched.
