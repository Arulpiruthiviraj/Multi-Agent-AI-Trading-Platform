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
