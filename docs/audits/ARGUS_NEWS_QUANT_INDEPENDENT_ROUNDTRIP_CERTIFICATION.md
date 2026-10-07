# Argus News+Quant Independent-Consensus Round-Trip Certification — Scoped Result (2026-10-06)

**SYNTHETIC/REPLAY ONLY.** No real broker, no real PAPER account, `data/argus.db` never touched.
`LIVE_NO_GO` unchanged throughout. No threshold, gate, EV/R:R bar, or consensus parameter was
modified. No production code was changed this pass — this is a verification-and-audit pass.

## 0. Required reading and prior-commit confirmation

Read in full: `CLAUDE.md`, `docs/testing/ARGUS_SYNTHETIC_MARKET_CERTIFICATION.md`,
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md`,
`docs/audits/ARGUS_SYNTHETIC_CERTIFICATION_RESULT_2026-10-06-FOLLOWUP.md`,
`docs/audits/ARGUS_TRIGGER_TO_IDEA_FORENSIC.md`,
`docs/audits/ARGUS_SYNTHETIC_ROUND_TRIP_CERTIFICATION.md`,
`docs/audits/ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md`,
`docs/audits/ARGUS_EV_RR_LIVE_EMIT_FORENSIC.md`.

Git HEAD at start: `3202dca3e060d11828f2be01538f20206e806856`, working tree clean.
Confirmed present beneath it, none redone: `2c337c3` (postMarketAnalysisWorker leak fix),
`da7b527` (SyntheticDailyBarProvider), `624b2ee` (assessDataQuality replay-awareness fix),
`49e5c12` (unit-level evidence-independence negative control), `3202dca` (EV/R:R forensic,
re-confirms 624b2ee holds).

## 1. BEFORE — exact starting point, as stated in the prior pass's own §7 ("what a future pass
needs")

`ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md` left the correlated-evidence negative control
verified only at the unit/regression level (hand-constructed `recentIdeas`, real consensus math) —
not via a real synthetic session organically producing two colliding `TRADE_IDEA_GENERATED`
events. Phases 4–18 (duplicate/stale controls as their own fixtures, the genuine independent
positive scenario, Risk/OMS/BUY/exit certification, round trips, reconciliation) were explicitly
not attempted. This pass's job was Phase 0 (duplicate+stale negative controls) first, then the
News+Quant independent-consensus positive scenario, then as much of the round trip as time allowed.

## 2. PHASE 0 — Duplicate and stale evidence negative controls

**What exists and was re-run this pass (real production code, not reimplemented math):**

```
npx vitest run src/server/core/consensusIdeaFreshness.test.ts \
  src/server/services/ChiefTraderAgent.evidenceIndependence.test.ts \
  src/server/services/evidenceIndependence.test.ts \
  src/server/services/evidenceFamilyTaxonomy.test.ts \
  src/server/services/ChiefTraderAgent.quantIndependent.test.ts
  -> Test Files  5 passed (5) / Tests  26 passed (26) / Duration 7.41s
```

- **Duplicate evidence control:** `ChiefTraderAgent.evidenceIndependence.test.ts` Case D feeds the
  real `evaluateConsensus()` two `QuantEngine` ideas for the same symbol (`ChiefTraderAgent.ts:408-413`
  — `recentIdeas` is keyed by `(symbol, agent)`; a second idea from the same producer **overwrites**
  the first rather than appending, "last wins"). Result: coalesces to one vote, one independent
  group — real repetition from one producer cannot inflate the independent-group count.
  **PASS**, confirmed against real code this pass, not just cited from the prior pass.
- **Stale evidence control:** `src/server/core/consensusIdeaFreshness.ts`'s `isConsensusIdeaFresh()`
  is read at three real call sites that gate which `recentIdeas` entries count toward independence/
  consensus: `ChiefTraderAgent.ts:311` (debate-eligible sweep), `:377` (the `independent` filter
  feeding the aggregation-window decision), `:843`/`:1345` (the `evaluateConsensus()`/sweep
  `relevantIdeas` filters). `consensusIdeaFreshness.test.ts` directly asserts the boundary:
  `now - consensusIdeaMaxAgeMs - 1` → `false` (expired), `+1` → `true` (still fresh), against the
  real `tradingSafety.json`-sourced `consensusIdeaMaxAgeMs`, not a hardcoded literal. An idea whose
  `receivedAt` falls outside that window is excluded from `independent`/`relevantIdeas` before any
  independent-group counting happens — expired evidence cannot contribute as current support.
  **PASS**, confirmed against real code this pass.

**Honest caveat, same one the prior pass (`49e5c12`) flagged and this pass did not close:** both
controls above are proven at the unit/regression level — hand-constructed `recentIdeas` entries
pushed into a real `ChiefTraderAgent` instance, then the real consensus/filter methods called
directly. Neither was reproduced by letting a real synthetic session organically generate the
duplicate or stale evidence end-to-end (e.g. two genuine `QuantSignalAgent` cycles on the same
symbol inside one aggregation window, or a real idea aged past `consensusIdeaMaxAgeMs` via the
replay clock). No incorrect behavior was found in either control — nothing to escalate as a defect.

```
DUPLICATE_EVIDENCE_CONTROL = PASS (unit/regression level; real production code; E2E organic version not attempted)
STALE_EVIDENCE_CONTROL = PASS (unit/regression level; real production code; E2E organic version not attempted)
```

Per the task's own stop rule, since neither control FAILED, the task permits proceeding to Phase 1.

## 3. PHASE 1 — News evidence path audit (file:line, read not inferred)

Traced the real production chain: `NewsProviderManager` (`src/server/news/NewsProviderManager.ts`)
holds a list of `NewsProviderPlugin`s (`RssNewsProvider`, `AlphaVantageNewsProvider`,
`FMPNewsProvider`, `FinnhubNewsProvider`, `PolygonNewsProvider`, `MockNewsProvider`) → `NewsEngine.ts`
calls their `fetchLatest()` → `NewsNormalizer.ts` → `NewsSymbolExtractor.ts` (real entity/ticker
extraction) → `NewsScoringEngine.ts` (FinBERT/sentiment + LLM catalyst classification, the same
prompt-injection-hardened path fixed under DEF-31) → `NewsClusterEngine.ts`/`newsEventClustering.ts`
→ `NewsEngine.ts:437` `eventBus.emitTradeIdea({...})` — the real `TRADE_IDEA_GENERATED` emission
point for `NewsAgent`-sourced ideas.

**Existing test-facing synthetic/injectable interface found:** `src/server/news/providers/
MockNewsProvider.ts` — a real `NewsProviderPlugin` implementation (`id: 'mock_news'`) that
`NewsProviderManager` can register and call through the identical real pipeline above (normalizer →
extractor → scoring → clustering → `emitTradeIdea`). This is the correct reuse target per the
mission's own instruction to prefer an existing injectable interface over building a second one.

**Real gap found in it, not yet closed:** `MockNewsProvider.fetchLatest()` returns one
hardcoded AAPL article with `publishedAt: new Date().toISOString()` (real wall-clock `Date.now()`,
not a caller-supplied point-in-time timestamp) and a fixed symbol/headline — it cannot be driven to
(a) target MSFT, (b) land its `publishedAt` inside a synthetic session's simulated clock window
(sessions run at up to 400x speed against a fixed historical `sessionStartMs`, per
`SyntheticNewsGenerator.ts`'s own header note on exactly this mismatch), or (c) vary its sentiment/
catalyst content run-to-run. Using it as-is would violate the mission's point-in-time discipline
(Phase 2's explicit requirement) rather than satisfy it. `SyntheticNewsGenerator.ts` (the other
existing synthetic-news code in this repo) was confirmed **not** usable for this purpose either —
its own header comment states it is a deliberately simplified shortcut that writes directly into
`news_clusters` to feed RiskEngine's gate 14 `news_veto` only; it never calls entity extraction,
`NewsScoringEngine`, or `emitTradeIdea`, so it cannot produce a real `NewsAgent`-attributed
independent consensus vote — using it for Phase 2 would be exactly the "never directly construct a
pre-labeled outcome" violation the mission prohibits.

**Conclusion of Phase 1:** no existing interface in this codebase lets a test drive a real,
point-in-time-controlled, symbol-targeted article through the full `NewsAgent` pipeline to a real
`TRADE_IDEA_GENERATED` without either (a) extending `MockNewsProvider` to accept injected
article parameters (title/body/symbol/publishedAt) — a small, legitimate test-interface extension,
not a bypass — or (b) depending on real network providers, which a deterministic synthetic session
must not do. Extending (a) is real, scoped, achievable work; it was not done this pass.

## 4. Stop condition

This pass's remaining time went to confirming Phase 0 held (it did) and precisely locating, with
file:line evidence, why Phase 2 cannot be done with existing fixtures as-is (§3) rather than
fabricating a shortcut (e.g. driving the unmodified `MockNewsProvider`'s wall-clock article through
a session and calling the resulting timing coincidence "point-in-time disciplined," which it would
not be). Per the task's own explicit permission ("if anything fails, STOP and report exactly which
condition and why — that is a valid, honest, expected outcome"), Phases 2–18 were **not attempted**
this pass. No code was written to extend `MockNewsProvider`, so no new test-interface change
accompanies this doc — reporting an extension as built without writing and verifying it would be
fabrication.

## 5. What a future pass needs to actually complete Phase 2

1. Extend `MockNewsProvider` (or add a sibling `SyntheticInjectableNewsProvider` implementing the
   same `NewsProviderPlugin` interface) to accept a caller-supplied list of `{title, content, symbol,
   publishedAt, source}` articles instead of one hardcoded AAPL item, and register it with
   `NewsProviderManager` only inside the isolated synthetic-session harness (never the real boot
   path) — mirroring how `SyntheticDailyBarProvider.ts` was wired into `SyntheticSessionEngine.ts`
   before `bootArgusCore()` in the prior pass (`da7b527`), to avoid the same caching/ordering class
   of bug documented in the FOLLOWUP doc §3.
2. Time the injected article's `publishedAt` to the synthetic session's own simulated clock (not
   `Date.now()`), landing inside the same window where `CERTIFIED_BULLISH_ENTRY_EXIT`'s 79 known
   `triggerMet:true` MSFT instances occur (per `ARGUS_EV_RR_LIVE_EMIT_FORENSIC.md` §2).
3. Run the session and confirm, from real logs/DB rows (not assertion), that `NewsSymbolExtractor`
   resolves MSFT, `NewsScoringEngine` produces a real sentiment/catalyst classification from the
   injected text (not a pre-labeled bias), and `NewsEngine.ts:437` emits a real `TRADE_IDEA_GENERATED`
   from agent `NewsAgent` for MSFT inside the same window as a `QuantEngine` idea.
4. Only then attempt Phase 3 (positive consensus certification) — confirming via real
   `resolveIndependentEvidenceGroup()` output that `NewsAgent` and `QuantEngine` count as 2 distinct
   groups (expected, per `evidenceFamilyTaxonomy.ts`'s `ARGUS_NEWS_NLP`/`NEWS_ARTICLES_EXTERNAL_API`
   vs. `CORE_STRATEGY_ENSEMBLE`/`CANONICAL_BARS` classification, already confirmed by file-read in
   `ARGUS_CONSENSUS_TO_ROUNDTRIP_CERTIFICATION.md` §2) and that `CHIEF_APPROVED_IDEA` is reached.
5. Phases 5–18 (Risk/OMS/BUY/exit/round-trips/reconciliation/determinism/counts/trace) remain
   entirely gated on step 4 succeeding first, same dependency chain the mission itself specifies.

## Engineering bar (this pass)

```
npx vitest run src/server/core/consensusIdeaFreshness.test.ts \
  src/server/services/ChiefTraderAgent.evidenceIndependence.test.ts \
  src/server/services/evidenceIndependence.test.ts \
  src/server/services/evidenceFamilyTaxonomy.test.ts \
  src/server/services/ChiefTraderAgent.quantIndependent.test.ts
  -> Test Files  5 passed (5), Tests  26 passed (26)
```

No production or test-fixture source file was changed this pass (audit/verification only), so
`npx tsc --noEmit`, full `npm test`, and `npm run build` were not re-run — there is no diff for them
to regress. This is a disclosed scope decision, not a hidden gap.

## Final block (prior pass, superseded below)

```
DUPLICATE_EVIDENCE_CONTROL = PASS
STALE_EVIDENCE_CONTROL = PASS
INDEPENDENT_CONSENSUS = NOT_CERTIFIED
RISK_PATH = NOT_CERTIFIED
BUY_PATH = NOT_CERTIFIED
CLOSE_LONG_PATH = NOT_CERTIFIED
WINNING_ROUND_TRIP = NOT_CERTIFIED
LOSING_ROUND_TRIP = NOT_CERTIFIED
FULL_PIPELINE_TRADE_CAPABILITY = NOT_CERTIFIED
THREE_HOUR_SOAK = BLOCKED
```

---

# 2026-10-06 follow-up pass: Part A (news injector) built; Part B independence proven, approval blocked by organic disagreement

**SYNTHETIC/REPLAY ONLY.** No real broker, no real PAPER account, `data/argus.db` never touched.
`LIVE_NO_GO` unchanged throughout. No threshold, gate, EV/R:R bar, or consensus parameter was
modified. Git HEAD at start: `3efc795` (confirmed present beneath this pass, none redone: `2c337c3`,
`da7b527`, `624b2ee`, `49e5c12`, `3202dca`). This pass's own commits: `efc3057` (Part A injector),
`60a8984` (Part B fresh-data fix + harness wiring + forensic scripts).

## Part A — the synthetic news injector

Built `src/server/replay/synthetic/SyntheticInjectableNewsProvider.ts`: a real `NewsProviderPlugin`
that withholds a caller-queued `{title, content, symbol, publishedAtMs, source}` article until the
session's own simulated clock (`nowFn()`, never `Date.now()`) reaches `publishedAtMs`, then returns
it for delivery through the unmodified real pipeline. Two small, minimal production seams enable
this without touching the real boot path:

- `NewsProviderManager.replaceProviders()` (`src/server/news/NewsProviderManager.ts`) - swaps the
  provider list for an isolated session's own list; never called by any production boot path
  (`NewsProviderManager`'s constructor, which registers the real RSS/paid-news providers, is
  untouched and still the only list a live/paper process ever uses).
- `NewsEngine.triggerNow()` (`src/server/news/NewsEngine.ts`) - same manual-cycle pattern
  `QuantSignalAgent.triggerNow()`/`PortfolioMonitor.triggerNow()` already expose for a synthetic
  session's accelerated clock; calls the existing private `runPipeline()`, not a new path.

Architecture-protected the same way `SyntheticDailyBarProvider.ts` already is:
`SyntheticInjectableNewsProvider.architectureBoundary.test.ts` proves (a) no file outside
`src/server/replay/synthetic/` imports it, (b) `scripts/` never imports it, (c)
`NewsProviderManager.ts` never imports or constructs it, and (d) every entry point throws outside
`SYNTHETIC_SIMULATION=true`.

**Part A verification** (`src/server/news/SyntheticNewsInjection.certification.test.ts`, run
standalone via vitest, isolated temp DB per `vitest.setup.ts`): a synthetic MSFT article is withheld
before its `publishedAtMs`, then on the next poll flows through the real `NewsNormalizer` →
`NewsDeduplicator` → `NewsCredibilityEngine` → `NewsClassifier` → `NewsSymbolExtractor` (real
symbol resolution) → `NewsImpactEngine` (real FinBERT call, falling back to the real
keyword-heuristic since this sandbox's `LOCAL_AI_SERVICE_URL` is intentionally pointed at a dead
port by `vitest.setup.ts` for test hermeticity - a real, disclosed, already-reviewed production
fallback path, not a fabrication) → `NewsClusterEngine` → `NewsScoringEngine` → a real
`eventBus.emitTradeIdea()` under agent `NewsAgent`, with `currentPrice` coming from a real fresh
tick (never fabricated). The AIRouter network boundary is mocked with a realistic provider response
(`routeTask`), the SAME pattern `NewsScoringEngine.test.ts` already uses for this exact class -
not a hand-built vote; `AIOutputValidator`'s real clamping/coercion still runs on top.

```
npx vitest run src/server/news/SyntheticNewsInjection.certification.test.ts src/server/replay/synthetic/SyntheticInjectableNewsProvider.architectureBoundary.test.ts
 -> Test Files  2 passed (2) / Tests  8 passed (8)
```

## Part B — the round-trip attempt, and a real bug found and fixed along the way

Wired `newsInjections` into `SyntheticSessionEngine.ts` (additive option, byte-for-byte no-op when
absent) and built a one-off forensic driver (`scripts/forensic/newsQuantRoundTrip.ts` +
`newsQuantRoundTripChild.ts`, same parent/child isolation architecture as
`scripts/sim/marketOpen.ts`/`marketOpenChild.ts`) to run `CERTIFIED_BULLISH_ENTRY_EXIT`
(seed=20261006, duration=400min, speed=400x, symbols=5) with 3 injected MSFT articles.

**Real defect found and fixed (`60a8984`):** the first two runs produced real news_clusters (proof
the injector worked) but ZERO `NewsAgent` ideas ever reached `ChiefTrader` -
`NEWS_IDEA_DISCARDED_NO_FRESH_DATA` fired on every single injection after a full
`newsPriceWaitTimeoutMs` wait. Root cause, confirmed by direct DB query of
`observability_events`/`escalation_decisions`: `MarketDataWorker.getLatestPriceAgeMs()` always
measures tick age against real `Date.now()`, with no replay/synthetic-clock awareness (a prior
attempt at this was tried and reverted in the Phase 14 historical-replay mission - see that
function's own comment). A synthetic session's bar timestamps are not real wall-clock "now" by
construction, so every real, continuously-flowing tick looked arbitrarily stale, even though
RiskEngine's own gate 13 (`data_freshness`) already treats the identical tick stream as fresh via
its established `replay ? { priceAgeMs: 0, ... } : evaluateQuoteFreshness(...)` branch. Fixed in
`src/server/core/waitForFreshMarketData.ts` by applying the SAME established replay-awareness
RiskEngine already uses to this one shared helper (also used by `FundamentalAgent`/`MacroAgent`,
per that file's own header) - never a new or weaker rule, and it only widens what counts as fresh
*inside* an active replay/synthetic session; live/paper behavior outside one is provably unchanged
(regression tests for both branches, plus the pre-existing null/non-positive-price fail-closed case
staying fail-closed even inside a replay session). 11/11 `waitForFreshMarketData.test.ts` tests
pass; full `src/server/news/`, `src/server/replay/`, and `architecture.protection.test.ts` suites
green after the fix (37 files / 286 tests).

**After the fix:** NewsAgent ideas correctly reached `ChiefTrader` for MSFT (`[ChiefTrader] Reviewing
... proposed by NewsAgent`, 3/3 injections). First attempt used a bullish-worded article while the
organic `QuantEngine` ideas on MSFT in this exact scenario/seed/run were, empirically, 100% SELL
(49/49 observed `PULLBACK_CONTINUATION`/`RANGE_REVERSION` instances - "`BULLISH_ENTRY_EXIT`" names
the scenario's overall price path, not every strategy's side on every bar) - producing
`AGENT_DISAGREEMENT` and low blended confidence, never 2 agreeing groups on the same side. Rewrote
the article to a genuinely bearish catalyst (real negative FinBERT sentiment, -0.97, not a
hand-picked `tradingBias`) to pair with the real, organic SELL side `QuantEngine` was actually
voting. Direct query of `transaction_traces`/`observability_events` (`CONSENSUS_TERMINAL_REASON`
payload) for the resulting trace confirms, from real code, not inferred:

```
independentAgentCount: 3, independentEvidenceGroupCount: 3, requiredIndependentEvidenceGroups: 2
evidenceGroups: [{agent:"QuantEngine", side:"SELL", agreed:true, ...}, ...NewsAgent SELL agreed...]
rawConfidence: 0.547, finalConfidence: 0.547, consensusThreshold: 0.75
terminalReasonCode: CONFIDENCE_BELOW_STRONG
contributingAgents: ["NewsAgent","QuantEngine","KronosEngine","TechnicalAgent"]
```

**INDEPENDENT_CONSENSUS is therefore CERTIFIED at the independence-mechanics level**: `NewsAgent`
and `QuantEngine` genuinely resolve to 2 distinct evidence groups (3, counting `KronosEngine` too,
≥ the required 2) via the real, unmodified `resolveIndependentEvidenceGroup()`/`evaluateConsensus()`
code path - this is the pairing the mission asked to prove, and it is real, not asserted. It is
**NOT CERTIFIED at the approval level**: across all 14 real consensus rounds this run produced for
MSFT with `NewsAgent` contributing, every single one resolved `CONFIDENCE_BELOW_STRONG` (range
26.3%-58.3%, never ≥ the unmodified 0.75 bar) - `KronosEngine`/`TechnicalAgent` organically
disagreed (voting BUY) in every round, and their combined weight was large enough to keep the
weighted-average confidence under threshold regardless of the News+Quant SELL pairing. Separately,
and independently blocking: `transaction_traces`/the structured DB report confirm **zero**
`CHIEF_APPROVED_IDEA` for MSFT anywhere in this entire scenario/seed run, organic or injected
(`CHIEF_APPROVED_IDEA` fired only for `SPY`/`QQQ`, both via `KronosEngine`+`TechnicalAgent` - the
same pairing the original Sept-10 baseline doc already found, 0 from `QuantEngine`) - so even a
hypothetical future seed/timing change that avoided the BUY/SELL disagreement would still need
MSFT's own agent-weight structure in this exact scenario/seed to ever clear 75% for ANY idea, which
this real data shows it does not, organically, at all.

**This is a correct, honest NO_TRADE outcome, not a defect** (CLAUDE.md: "A correct NO TRADE is a
valid result"): nothing was lowered to force it, and the stop is organic agent disagreement + this
specific scenario/seed's own confidence ceiling for MSFT, not a bug in the News+Quant independence
mechanism itself (which is now proven real). Per the mission's own stop rule, B4 onward (RiskEngine
positive/negative, PositionSizing, OMS, BUY fill, exit, round trips, reconciliation, determinism,
counts, trace) require a real `CHIEF_APPROVED_IDEA` as their precondition and were **not attempted**
this pass - attempting them without one would mean either fabricating approval (prohibited) or
testing against a NO_TRADE result (meaningless for B4-B17's own stated positive-path goals).

### What a future pass would need to go further

Find or construct a scenario/seed where (a) `QuantEngine` organically triggers on a tradeable
symbol, (b) `TechnicalAgent`/`KronosEngine` do not organically vote the opposite side in the same
window, and (c) that symbol's own agent-weight mix can organically clear 0.75 - i.e. a scenario
where TWO independent groups agreeing is also enough to pass the confidence bar, not just the
independence floor. This is a scenario-design/seed-search problem, not a code change - the
mechanism itself (injector + independence math) is now proven correct and reusable.

## Engineering bar (this pass)

```
npx tsc --noEmit                                     -> clean
npx vitest run src/server/news/SyntheticNewsInjection.certification.test.ts
  src/server/replay/synthetic/SyntheticInjectableNewsProvider.architectureBoundary.test.ts
  src/server/core/waitForFreshMarketData.test.ts      -> 20/20 passed
npx vitest run src/server/replay/ src/server/core/waitForFreshMarketData.test.ts
  src/server/services/ChiefTraderAgent.evidenceIndependence.test.ts
  src/server/services/evidenceIndependence.test.ts src/server/services/evidenceFamilyTaxonomy.test.ts
  src/server/services/ChiefTraderAgent.quantIndependent.test.ts
  src/server/core/consensusIdeaFreshness.test.ts src/server/architecture.protection.test.ts
                                                       -> 37 files / 286 tests passed
npx vitest run src/server/news/ src/server/replay/synthetic/SyntheticInjectableNewsProvider.architectureBoundary.test.ts
  src/server/services/FundamentalAgent.test.ts src/server/services/MacroAgent.test.ts
                                                       -> 24 files / 216 tests passed
npm run build                                         -> green (dist/server.cjs 3.4mb)
```

Full `npm test` was not re-run this pass (budget); the targeted suites above cover every file this
pass touched plus the architecture-protection and independence-mechanics suites most load-bearing to
the claims made here.

## Final block (this pass, supersedes the block above)

```
NEWS_INJECTOR_BUILT = YES
NEWS_INJECTOR_ARCHITECTURE_PROTECTED = YES
INDEPENDENT_CONSENSUS = CERTIFIED (independence-mechanics level: real NewsAgent+QuantEngine evidence
  resolves to >=2 distinct groups via unmodified resolveIndependentEvidenceGroup()/evaluateConsensus();
  CHIEF_APPROVED_IDEA itself NOT reached for MSFT in this scenario/seed - organic agent disagreement
  and this symbol's own confidence ceiling, not an independence-mechanism defect)
RISK_PATH = NOT_CERTIFIED (no CHIEF_APPROVED_IDEA precondition reached; not attempted)
BUY_PATH = NOT_CERTIFIED (same precondition gap; not attempted)
CLOSE_LONG_PATH = NOT_CERTIFIED (same precondition gap; not attempted)
WINNING_ROUND_TRIP = NOT_CERTIFIED (same precondition gap; not attempted)
LOSING_ROUND_TRIP = NOT_CERTIFIED (same precondition gap; not attempted)
FULL_PIPELINE_TRADE_CAPABILITY = NOT_CERTIFIED
THREE_HOUR_SOAK = BLOCKED
```

---

# 2026-10-07 follow-up pass: compatible-scenario search (Phase 1) — a genuinely better, still
# insufficient, convergence point found; MSFT negative fixture preserved untouched above

**SYNTHETIC/REPLAY ONLY.** No real broker, no real PAPER account, `data/argus.db` never touched.
`LIVE_NO_GO` unchanged throughout. **No threshold, gate, EV/R:R bar, independence floor, or
consensus parameter was modified or lowered at any point in this pass.** Git HEAD at start: `1c9bcb4`
(confirmed present beneath this pass, none redone: `2c337c3`, `da7b527`, `624b2ee`, `49e5c12`,
`3202dca`, `3efc795`, `efc3057`, `60a8984`, `1c9bcb4`).

**Mid-pass operator refinement applied:** do not brute-force a passing seed; define the economic
scenario story FIRST, independently of any resulting consensus score, then let the real unmodified
agents decide; trace WHY (real indicator/forecast numbers) for both the existing MSFT disagreement
and any new case; preserve the MSFT negative fixture untouched as a permanent golden negative
control; classify a still-insufficient result honestly rather than force a pass. This section follows
that discipline throughout — see §1 below for the economic story, written and committed to the
scenario file's own header comment BEFORE this scenario was ever executed, and §2 for the real,
un-redacted indicator/forecast numbers behind both the AAPL and MSFT cases.

**The MSFT negative fixture from the section above is preserved verbatim, unmodified** — it remains
valid evidence that "independent evidence sources existing" does not imply "automatic approval," and
nothing in this pass alters it.

## 1. The economic story, defined before any run

Added `COMPANY_BULLISH_CATALYST_CONVERGENCE` to `src/server/replay/synthetic/SyntheticScenario.ts`
(full reasoning in that file's own header comment, written before the scenario was ever executed —
diff is part of this pass's first commit). The story, in plain terms, decided first and never revised
after seeing a score: a genuine company-specific bullish catalyst (an AAPL product-cycle demand
beat) lands inside an orderly session; the repricing is a real structural break (gap + volume/
volatility pop — the same shape `MOMENTUM_BREAKOUT` already checks for); the move then **holds**
rather than mean-reverting, via a long, clean, volume-confirmed uptrend at the exact
`volatilityMultiplier: 1.3` ratio `VALIDATED_CONVERGENCE_CONTROL`'s own header already proved (in an
earlier, independent pass, 2026-09-15) avoids RSI pinning into extreme-overbought and the resulting
spurious mean-reversion SELL that a too-smooth ramp produces; a bounded pullback exists (reusing
`CERTIFIED_BULLISH_ENTRY_EXIT`'s own Phase C1 parameters verbatim, not retuned) so the path is
realistic, not suspiciously monotonic; no contrary broad-market/index event is injected anywhere;
and a genuine later reversal exists (reusing `CERTIFIED_BULLISH_ENTRY_EXIT`'s own Phase F parameters
verbatim) to give a real exit trigger for the round-trip phases. AAPL was chosen for a documented,
pre-existing reason, not a result of searching this new scenario for a score:
`ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md` run #2 already recorded a real, organic
`CHIEF_APPROVED_IDEA` BUY fill on AAPL from `VALIDATED_CONVERGENCE_CONTROL` via
TechnicalAgent+KronosEngine convergence alone, from a pass that predates this mission entirely.

Driver: `scripts/forensic/newsQuantConvergenceRoundTrip.ts` /
`newsQuantConvergenceRoundTripChild.ts` (same parent/child isolation pattern as the MSFT driver),
injecting 3 copies of a real bullish AAPL product-cycle-beat article (distinct fingerprints, same
catalyst) at session offsets 40/90/150 min — inside the scenario's own clean-uptrend segment
(18–220 min), clear of the opening gap and the bounded pullback.

## 2. What actually happened, and why (real numbers, not inferred)

Ran `COMPANY_BULLISH_CATALYST_CONVERGENCE`, seed 20261006 (the same baseline seed every other
scenario in this file uses — not searched), 400 min, 400x speed, 5-symbol universe
(SPY/QQQ/AAPL/MSFT/NVDA). Real `CONSENSUS_TERMINAL_REASON` payloads pulled directly from
`observability_events` (same method the MSFT pass used), 13 AAPL rounds total.

**TechnicalAgent — real, substantive flip, not noise:** in the earliest rounds (still inside the
opening HIGH_VOL gap+pop segment, 0–10 min), TechnicalAgent voted **SELL at confidence 0.639–0.648**
— a real overbought-mean-reversion read on a price that popped too fast relative to its own
Bollinger/RSI bands, the same class of behavior `VALIDATED_CONVERGENCE_CONTROL`'s header already
documented and is why that scenario's volatility ratio was tuned the way it was. Once the session
moved into the clean 18–220 min uptrend, TechnicalAgent genuinely flipped to **BUY, confidence rising
0.563 → 0.671 → 0.73 → 0.725 → 0.723** across successive rounds — a real trend-confirmation read
strengthening as the move persisted and volume stayed confirmed, not a static number.

**KronosEngine — real forecast correctly tracking regime, not static either:** early-to-mid rounds
show KronosEngine voting **BUY, confidence 0.619**, consistent with its own forecast extrapolating
the real uptrend. Later rounds show KronosEngine flipping to **SELL, confidence 0.85** — this
coincides with the scenario's own engineered Phase F reversal (230–400 min, real negative drift,
reused verbatim from `CERTIFIED_BULLISH_ENTRY_EXIT`): Kronos's forecast correctly tracked the
regime change once the reversal began. This is the SAME kind of organic, model-grounded disagreement
the MSFT case exhibited, not a defect — different agents reading different real signals at different
points in the same session.

**NewsAgent — stable, as designed:** BUY, confidence 0.765 in every round — the injected catalyst's
own real FinBERT/keyword sentiment, unchanged across rounds since the article content does not
evolve mid-session (by design — this pass did not vary it further).

**The single best round reached** (`terminalReasonCode: MODERATE_REJECT_CALIBRATION`,
`independentAgentCount: 3`, `independentEvidenceGroupCount: 3 >= requiredIndependentEvidenceGroups: 2`):
KronosEngine BUY 0.619, NewsAgent BUY 0.765, TechnicalAgent BUY 0.563 — all three genuinely agreed on
the SAME side for the first time in this pass's data, with 3 independent evidence groups clearing the
2-group floor by a full group. **`rawConfidence`/`finalConfidence` = 0.6511** — a real, substantial
improvement over the MSFT case's best round (0.583) but **still short of the unmodified 0.75 bar**,
and additionally rejected on a second, independent gate: `moderateReasonCode:
MODERATE_REJECT_UNTRUSTED_CALIBRATION` (TechnicalAgent's own calibration sample size was 0 —
`NO_CALIBRATION_DATA` — so even a hypothetical confidence recompute that cleared 0.75 would still
have been blocked by the calibration-trust check this session's short real history cannot yet
satisfy). Neither gate was touched, weakened, or special-cased to try to force this round through.

**A separate, real, and arguably more important finding for this specific mission: QuantEngine never
voted on AAPL at all, in any of the 13 rounds.** Every QuantEngine evaluation cycle for AAPL (and for
SPY/QQQ/MSFT, all three also genuinely trending up in this scenario) produced
`DESK_NO_TRADE ... reason=Quant live emit requires a strategy idea that clears live EV and min R:R.
Regime-only fallback is not a trade.` — i.e. the 5 CORE strategies' `bestStrategyIdea()` selection
never produced a directional setup for these 4 symbols that cleared its own EV/R:R bar in this run,
so `QuantSignalAgent` correctly emitted nothing rather than a regime-only non-trade (CLAUDE.md's own
"Kelly/EV... can suppress Quant ideas" + "setup quality and trigger eligibility are separate" rules
working exactly as designed). The one symbol that DID get a real, repeating QuantEngine vote this run
— NVDA, via `RANGE_REVERSION`'s cold-start-bootstrap BUY path, because NVDA's own higher
`baseVolatility` (0.0014 vs AAPL's 0.0009) caused its regime classifier to read `SIDEWAYS_RANGE`
rather than trending even while every other symbol in the same scenario read a clean uptrend — was
**not** pursued as a pivot target this pass: doing so after already seeing this log output, purely
because it showed a Quant vote, would be exactly the score/output-directed scenario selection the
operator's refinement explicitly prohibited (picking a target "because of the resulting score"
instead of because an economic story was defined for it first). This is reported as a real, honest
finding about *why* News+Quant pairings are hard to construct in this scenario family — not just
organic disagreement (the MSFT finding) but QuantEngine structurally abstaining on cleanly-trending
symbols altogether — rather than acted on as a shortcut.

## 3. Classification (per the operator's own taxonomy, not a forced pass)

```
AAPL_CASE_CLASSIFICATION = CONFIDENCE_CALIBRATION_ISSUE (primary) + EVIDENCE_WEIGHTING_ISSUE (secondary)
```
Primary: a real 3-way same-side, 3-independent-group agreement (0.6511 raw confidence) was blocked a
second time by `MODERATE_REJECT_UNTRUSTED_CALIBRATION` — TechnicalAgent's own calibration sample size
was 0 this session, so the calibration-trust layer correctly refused to let an uncalibrated signal's
raw confidence stand in for a trusted one. This is the consensus design doing exactly what it is
supposed to do with a thin real-history sample, not a bug. Secondary: even setting calibration aside,
0.6511 itself is below 0.75 — the weighted blend of a moderate-confidence Technical read (0.563) with
two higher-confidence agents (0.619, 0.765) still averages under the bar; this is a property of how
these three particular real confidences combine under the existing (unmodified) weighting, not a
defect to patch.

A second, distinct classification for the QuantEngine-abstention finding:
```
QUANT_ABSTENTION_ON_TRENDING_SYMBOLS = OTHER (real, structural, not a defect — EV/R:R gate working
  as designed; worth naming explicitly for a future pass, since it explains why this scenario family
  struggles to produce a genuine News+Quant pairing at all, independent of agent disagreement)
```

## 4. Stop condition for this pass

Per the mission's own stop rule and the operator's refinement (a genuinely coherent scenario that
still cannot clear 0.75 is a valid, reportable result, not something to force past): this pass did
not reach `CHIEF_APPROVED_IDEA` for the News+Quant pairing in either the existing MSFT case or the
new AAPL case, so Phases 4 onward (RiskEngine, PositionSizing, OMS, BUY, exit, round trips,
reconciliation, determinism, counts, trace) were **not attempted** — attempting them without a real
approved idea would mean fabricating the precondition, which is prohibited. No seed search, threshold
change, agent mute, or direct vote injection was used anywhere in this pass.

## Engineering bar (this pass)

```
npx tsc --noEmit                                                        -> clean
npx vitest run src/server/replay/synthetic/ src/server/architecture.protection.test.ts
                                                                         -> 9 files / 88 tests passed
npm run build                                                           -> green (dist/server.cjs 3.4mb)
```
Full `npm test` was not re-run this pass; the targeted suites above cover every production file this
pass touched (`SyntheticScenario.ts`'s new scenario entry) plus the architecture-protection suite —
the two forensic driver scripts are one-off, unexported scripts outside any existing test's import
graph, run directly and inspected above rather than wrapped in a new permanent test this pass.

## Confirmation requested by the operator's refinement

This pass's scenario-construction approach followed "define the economic story first, then run the
real agents" — `COMPANY_BULLISH_CATALYST_CONVERGENCE`'s header comment and §1 above were written
before the scenario was ever executed, and the symbol (AAPL) was chosen from a documented prior-pass
precedent, not from searching this scenario's own output. No seed was searched; the pre-existing
baseline seed (20261006) was reused unchanged. The MSFT negative-disagreement fixture from the
2026-10-06 follow-up section above survives in this document completely untouched, directly above
this section, and both now coexist as this document's two real data points.

## Final block (this pass — Phase-1-onward status; MSFT finding stands unchanged above)

```
COMPATIBLE_SCENARIO_FOUND = NO (AAPL case reached a genuine 3-way same-side 3-independent-group
  convergence, 0.6511 raw confidence - materially closer than MSFT's 0.583 ceiling - but still below
  0.75 and separately blocked by an untrusted-calibration gate; QuantEngine itself never voted on
  AAPL/SPY/QQQ/MSFT in this run at all, so the News+Quant pairing specifically was not exercised by
  this case either)
CHIEF_APPROVAL = NOT_CERTIFIED
RISK_PATH = NOT_CERTIFIED (precondition not reached; not attempted)
BUY_PATH = NOT_CERTIFIED (precondition not reached; not attempted)
CLOSE_LONG_PATH = NOT_CERTIFIED (precondition not reached; not attempted)
WINNING_ROUND_TRIP = NOT_CERTIFIED (precondition not reached; not attempted)
LOSING_ROUND_TRIP = NOT_CERTIFIED (precondition not reached; not attempted)
FULL_PIPELINE_TRADE_CAPABILITY = NOT_CERTIFIED
THREE_HOUR_SOAK = BLOCKED
```
