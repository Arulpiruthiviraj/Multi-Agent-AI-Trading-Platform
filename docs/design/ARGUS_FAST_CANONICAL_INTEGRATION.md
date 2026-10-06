# Argus — Fast Lane → Canonical Decision Spine Integration (Design)

**Status: `FAST_CANONICAL_INTEGRATION_PARTIAL`.** Shadow/research only. LIVE_NO_GO. No broker
submission. **This phase does not call `eventBus.emitTradeIdea()` anywhere** — see §10 for why that
boundary was drawn here deliberately, not from a missing feature.

## 1. The one canonical idea ingress (traced, not assumed)

Every legitimate idea source in this codebase reaches ChiefTrader through exactly one path:

```
producer -> eventBus.emitTradeIdea(idea) -> gateTradeIdea() [tradeIdeaContract.ts]
         -> TRADE_IDEA_GENERATED -> ChiefTraderAgent.recentIdeas -> evaluateConsensus()
```

`gateTradeIdea()` validates `symbol` (via `validateInstrumentSymbol`) and `currentPrice` (finite,
positive, falls back to `livePriceLookup`) before the idea is allowed to reach
`TRADE_IDEA_GENERATED` at all — a garbage symbol or missing price is rejected as
`TRADE_IDEA_REJECTED`, never silently dropped. The idea schema every producer builds is informal
but consistent: `{ traceId, symbol, side, confidence, reasoning, agent, strategy, timeframe,
currentPrice?, evidence? }` (see `JavaCoreEnsembleVoteService.ts` for the clearest existing
precedent). **Independence grouping** happens inside `ChiefTraderAgent.evaluateConsensus()`: each
agreeing idea's `agent` field is passed through `resolveIndependentEvidenceGroup()`
(`evidenceIndependence.ts`), and the resulting `Set` of groups (not raw agent names) is compared
against `MIN_INDEPENDENT_AGREEING_AGENTS`. This is the ONE authoritative mechanism; this phase adds
no second one.

## 2. The adapter (`fastCanonicalAdapter.ts`)

`convertFastEvaluationToCanonicalIdea(result, candidate)` — pure function, no side effects, never
calls `emitTradeIdea`. Gates, in order: `status === 'VALID_STRATEGY_EVIDENCE'` → candidate not
expired → a real `bestStrategy`/`direction`/`confidence` exist → confidence is finite → at least
one real triggered strategy (`validTriggers.length > 0`). `NO_VALID_SETUP`, `INSUFFICIENT_DATA`,
`ERROR`, `EXPIRED`, and `DATA_STALE` are all rejected before any other check — proven by a
parameterized test (`fastCanonicalAdapter.test.ts`) that runs every one of those five statuses
through the real function and asserts none produce an idea.

**Original strategy identity is always preserved** — `idea.strategy = result.bestStrategy` (e.g.
`'MOMENTUM_BREAKOUT'`), never a Fast-Lane-specific label. `agent: 'FastOpportunityLane'` is the
*only* Fast-Lane-specific field, and it exists purely so `resolveIndependentEvidenceGroup()` can
classify it — not as a new signal name. An architecture test asserts no file in this directory ever
hardcodes `strategy: 'FAST_LANE...'`.

**No confidence bonus** (§12): `idea.confidence = result.confidence` — the raw strategy confidence,
copied verbatim, never incremented. An architecture test asserts no fastlane file contains a
confidence-boosting expression.

## 3. Independence protection — the real, load-bearing mechanism

`evidenceIndependence.ts` now includes `'FastOpportunityLane'` in
`STRUCTURALLY_SAME_AS_CORE_QUANT_ENSEMBLE`, alongside `'QuantEngine'` and `'JavaCoreEnsemble'`. This
is backed by **real structural proof**, not suspicion: `fastLaneEvaluator.ts` calls
`quantSignalAgent.evaluateSymbol()` directly — the exact same function `QuantEngine`'s own live
cycle calls, which runs the exact same `evaluateAll(strategyContext)` over the exact same canonical
bars and picks via the exact same `bestStrategyIdea()`. There is no new feature computation and no
separate data path.

**This is the single most important test in this phase**, and it uses the REAL, unmodified
`ChiefTraderAgent` class inside its own pre-existing, fully-isolated test harness
(`ChiefTraderAgent.test.ts` — `eventBus`/`db`/`AIRouter` all mocked, zero connection to the live
running engine):

```
QuantEngine BUY (AAPL) + FastOpportunityLane BUY (AAPL, same idea)
  -> resolveIndependentEvidenceGroup collapses both to CORE_QUANT_ENSEMBLE
  -> emitChiefApproval NOT called (exactly like the single-agent case)

FastOpportunityLane BUY (AAPL) + NewsAgent BUY (AAPL, genuinely independent)
  -> two distinct groups
  -> emitChiefApproval called once
```

Both pass. Fast Lane cannot manufacture a second independent vote out of one underlying
computation, proven against the real consensus math, not a reimplementation of it.

## 4. Idempotency and collision classification (`fastCanonicalDedup.ts`)

**Idempotency:** `processFastEvaluationForCanonicalIdea()` caches by `evidenceFingerprint`
(strategy + symbol + side + `dataAsOf` rounded to the nearest minute — deliberately never a
volatile field like `candidateId`/`evaluatedAt`/`traceId`, which would make identical evidence look
spuriously unique). Proven: the same `FastEvaluationResult` delivered 10 times produces exactly one
cache entry and exactly one `FAST_CANONICAL_IDEA_CREATED` event (nine `FAST_CANONICAL_IDEA_DEDUPED`
events for the rest).

**Collision classification** (`classifyEvidenceCollision`) is **purely observational** — it does
not gate anything; the real protection is §3's evidence-group registration. Honestly scoped:
confidently distinguishes `SAME_STRATEGY_SAME_EVIDENCE`, `SAME_STRATEGY_NEWER_EVIDENCE`, and
`GENUINELY_INDEPENDENT_EVIDENCE` (different symbol, or same strategy/symbol with opposite sides —
a real disagreement, not a duplicate). Deliberately does **not** claim to detect
cross-strategy factor correlation (the mandate's own `DIFFERENT_STRATEGY_SAME_FACTOR` category) —
renamed to `DIFFERENT_STRATEGY_UNKNOWN_CORRELATION` because no source-verified correlation matrix
exists for arbitrary TS strategy pairs in this codebase (the one place such a matrix exists,
`QuantEnsembleEngine.java`'s `defaultFamilyCorrelationMatrix()`, is itself a reviewed *assumption*,
not a measured value). Grouping requires proof, not suspicion — the same standard
`evidenceIndependence.ts` already holds itself to.

## 5. Horizon alignment (§9) — honest limitation, not invented

Traced `ChiefTraderAgent.ts` for existing horizon-comparison logic beyond simple recency/TTL
windows (`recentIdeas`, cooldowns). **None was found.** The mandate's own instruction — "reuse
existing horizon logic if present... do not create Fast-Lane-specific consensus semantics" — means
the correct action here is to **not invent one**. This is a real, pre-existing gap in the canonical
consensus mechanism (a 5-minute Fast Lane momentum read and a 1-day TS trend-following strategy
could in principle "agree" with no explicit horizon check), not something Fast Lane introduces or
should patch around on its own. `CanonicalIdeaFromFastLane.evidence.validUntil` is preserved
(`candidate.expiresAt`) so any future horizon-aware consensus logic has the data it would need.

## 6. Observability (§13)

`FAST_CANONICAL_IDEA_CREATED` / `_DEDUPED` / `_REJECTED` are wired and tested.
`FAST_CANONICAL_IDEA_REPLACED_STALE` and `FAST_CANONICAL_CONSENSUS_ENTERED` are defined
(`fastLaneObservability.ts`) for a later phase that actually distinguishes a stale-evidence
replacement from a fresh duplicate, and that actually wires live emission — neither is called
anywhere in this phase's code, honestly, since neither scenario currently occurs (no live emission
exists yet to "enter consensus").

## 7. Architecture safety (tested, not assumed)

`fastLaneArchitecture.test.ts` extended to prove, by reading the real source:
- `fastCanonicalAdapter.ts`/`fastCanonicalDedup.ts` never call `emitTradeIdea`, never reference
  `ChiefTrader`, never import `EventBus` at all.
- No fastlane file hardcodes a Fast-Lane-specific strategy label or a confidence bonus.
- (Pre-existing, still green) no `BrokerManager`/`placeOrder`/OMS/RiskEngine-mutation reference
  anywhere in the directory — the broad sweep automatically covers every new file added here too.

## 8. RiskEngine shadow handoff (§20) — correctly stopped, not skipped

Section 20's own fallback: *"If safe separation does not exist: stop at ChiefTrader approval. Do
not weaken architecture to achieve this test."* **Safe separation does not exist for ChiefTrader
itself in this running process** — `ChiefTraderAgent`'s constructor subscribes directly to the
real, shared `eventBus` singleton (`eventBus.on('TRADE_IDEA_GENERATED', ...)`), so instantiating
even a "shadow" instance in the live engine would be a second real ChiefTrader listening to live
production events — exactly what the mandate's own DO-NOT list forbids. The only safe way to
exercise `ChiefTraderAgent`'s real logic is the pre-existing, fully-mocked test harness, which
produces no real `CHIEF_APPROVED_IDEA` to hand off to RiskEngine at all. **This phase correctly
stops at the ChiefTrader-approval boundary** — there is nothing to shadow-hand-off to RiskEngine,
by design, not because RiskEngine itself is unreachable (its own constructor is private/stateless
and does not subscribe to the live bus; it was never the blocker).

## 9. What was NOT built (honest scope)

- No live wiring to `eventBus.emitTradeIdea()` anywhere.
- No forward paper shadow session (§25) — that requires a live market session with the real flag
  wiring built, which this phase deliberately did not build (§10).
- No cross-strategy correlation matrix for `DIFFERENT_STRATEGY_UNKNOWN_CORRELATION`.
- No horizon-aware consensus semantics (§5 — a real, pre-existing gap, not newly introduced).

## 10. Why live emission was not wired tonight

The production Argus engine was actively running with `TRADING_ENABLED` during this work (a real,
separate operational fact, not a hypothetical). Wiring a new idea producer into
`eventBus.emitTradeIdea()` — even behind a default-`false` flag — in the same process as a live
paper-trading session is exactly the kind of change that should get a dedicated, isolated
verification window, not be shipped mid-session. The adapter/dedup/independence-grouping logic is
real, tested, and ready to be called from a live-wiring module in a future, separately-authorized
pass; this phase deliberately stops one step short of that call.

## Final verdict

**`FAST_CANONICAL_INTEGRATION_PARTIAL`** — not `READY_FOR_FORWARD_SHADOW` (no live wiring exists
yet to run a forward session against) and not `UNSAFE` (every safety boundary holds, proven by
architecture tests reading real source and by the real `ChiefTraderAgent` class in its own isolated
harness, not by assumption).
