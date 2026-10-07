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

## Final block

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
