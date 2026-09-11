# ARGUS — Java Quant Authority: Architecture Decision Record & Target Design (2026-09-10)

**Status:** DECISION RECORD + PROPOSED DESIGN. No production code changed in this pass. Builds
directly on `docs/audits/ARGUS_QUANT_FORENSIC_AUDIT_COMPLETE_2026-09-09.md` (referred to below as
"the Forensic Audit") — that document is not repeated here except where a fact is load-bearing for
a decision. Every claim below is tagged `VERIFIED` (read the code this pass), `VERIFIED (prior
pass)` (confirmed by the Forensic Audit, not re-read here), `INFERRED` (reasoned from structure,
not confirmed), `PROPOSED` (a new design choice, not yet implemented), or `UNVERIFIED` (a real gap
in this pass's evidence). Per `CLAUDE.md`, this file lives under `docs/audits/` (a dated
decision/audit record), not `docs/architecture/` — that directory holds exactly one living
reference (`ARGUS_ARCHITECTURE.md`), which gets a short pointer addendum in the same change as this
file, not a duplicate architecture doc.

---

## 0. New finding this pass, not in the 2026-09-09 audit: the feature-pipeline adapter gap

This matters enough to lead with, because it changes the shape of the recommended first move (§21).

`VERIFIED` — two separate, disconnected Java representations of "the feature set a strategy needs"
exist in `quant-core-java/` today:

1. **`io.argus.quantcore.features.*`** (`RegimeEngine.java`, `MarketContext.java`,
   `TrendFeatures.java`, `VolatilityFeatures.java`, etc.) — ported 2026-09-04, parity-tested against
   captured real TS ground truth (`Phase2FeatureParityTest`, 9/9 passing per
   `ARGUS_ARCHITECTURE.md`'s Java Quant Core section), and **live-wired** as of 2026-09-05 — but
   only into `QuantCoreBridge.compareRegimeParity()`, a **regime-label-only** shadow comparison.
   `ARGUS_ARCHITECTURE.md` already discloses this scope honestly ("MarketContext/full feature-set
   comparison was deliberately not wired (regime-only, by design)").
2. **`io.argus.quantcore.strategy.types.StrategyContext`** — the record type the 5 CORE strategy
   classes (`strategy/core/*.java`) actually consume. Read directly this pass
   (`strategy/types/StrategyContext.java:1-114`): it defines its **own, separate, nested** record
   types (`StrategyContext.TrendFeatures`, `.MomentumFeatures`, `.VolatilityFeatures`, etc.) that
   are structurally similar to but a different Java type from `features.TrendFeatures` etc. Its own
   header (unchanged since the earlier migration-status audit) still says the upstream feature
   computation "is NOT ported here."
3. **`grep` confirms zero imports of `io.argus.quantcore.features.*` anywhere under `strategy/`**,
   and the only non-test constructor of `StrategyContext` is `server/StrategyContextCodec.java`,
   which **decodes it from a JSON HTTP body** — a payload TS would have to POST to
   `/api/v1/evaluate`. Per the Forensic Audit (§5, re-confirmed, not re-derived this pass): nothing
   in `src/` ever calls that route.

**Conclusion:** the already-ported, already-parity-verified `features/*` package cannot today feed
the 5 CORE Java strategies even if a caller wired `/api/v1/evaluate` — there is no adapter between
`features.RegimeEngine`'s output shape and `strategy.types.StrategyContext`'s nested records. This
is a small, well-scoped, concrete gap (one mapper class + one real caller), not a "build a
FeatureEngine from scratch" problem — the expensive part (porting and parity-verifying the actual
feature math) is already done. See §21 for why this is the recommended first move.

---

## 1. Executive architectural verdict

### A. Should Java Quant become the primary quantitative authority?

**Not yet, as a wholesale claim — but yes, directionally, and partially already true.** The
principle itself (deterministic quant foundation, AI as optional evidence) is architecturally sound
and matches how the codebase's own newest work (the two 2026-09-09 overrides, below) is already
pointed. But "primary authority" requires three things that do not exist yet:

1. Canonical, guaranteed-consistent market data delivery to Java (§6) — today `POST /api/v1/ticks`
   is fire-and-forget with no ack/ordering guarantee (`VERIFIED (prior pass)`, Forensic Audit §6),
   which is the confirmed root cause of real, persistent RSI/MACD shadow-parity divergence.
2. A real adapter connecting the already-ported `features/*` package to `strategy.types.
   StrategyContext` (§0) plus a live caller for `/api/v1/evaluate` — neither exists.
3. Real-bar (not synthetic-fixture) parity evidence for the 5 CORE strategies, and a shadow-soak
   period before any vote authority — the same precondition this codebase's own migration blueprint
   already states and that the operator has twice explicitly chosen to override early for narrower
   mechanisms (below).

**Important, unresolved tension to name directly, not gloss over:** two 2026-09-09 operator
overrides (`JavaQuantAdvisoryService.emitJavaQuantVoteIfEligible()` → a real `JavaFactorComposite`
vote, and `ChiefTraderAgent.ts`'s `isQuantIndependentQualificationEnabled` → a real
independence-floor substitute) already give Java Quant Core two narrow, live paths into production
paper-trading consensus decisions — **before** the canonical-data-parity problem in §0/§6 was fixed
and **before** any multi-week clean-divergence soak ran, which is exactly the precondition both
overrides explicitly bypassed. I would not have recommended enabling either ahead of §0/§6 being
closed — the RSI/MACD divergence figures (Forensic Audit §6: ~80% of shadow comparisons diverge
>5%, ~56% diverge >20%) are evidence that Java's view of "the same market" can differ substantially
from TS's, and `factor_composite`/the internal-ensemble mechanism consume Java-side calculations
built on that same unreliable tick delivery. This is not a safety-gate violation (both overrides are
additive, fail-closed, explicitly gated, and were knowingly authorized) — it is a data-quality risk
the operator should see named plainly: **the vote and the independence-substitute may be
Quantitatively real but observationally miscalibrated until §6 is fixed.** Recommendation: keep both
overrides live (an explicit operator decision I won't unilaterally reverse), but treat §6's fix as
the true P0, and consider temporarily raising `javaQuantVoteMinConfidence` / requiring a wider
`minQuantIndependentEffectiveCount` margin until §6 lands — `PROPOSED`, operator's call.

### B. Should all 200+ (123 cataloged `quantModels`, ~142 by this session's own broader inventory)
Java engines participate in trading?

**No.** `VERIFIED (prior pass)`: 117 of 123 `quantModels` entries are `RESEARCH` status — unit-tested
against synthetic data only, zero backtest/OOS/paper evidence. A large fraction (this session's own
inventory: 26 options + 8 FX + 8 volatility-adjacent + 7 fixed-income + 4 commodities + 4 futures +
3 CDO/structured = ~60 engines) are pure calculators for asset classes **Argus has no live data feed
for at all** (options, FX, commodities, futures, fixed income, CDO/credit derivatives) — they cannot
participate in any real trading decision today regardless of promotion status, full stop, not a
maturity question. Only equity/ETF-applicable engines with real bar data are even candidates for the
promotion funnel in §9: the 5 CORE strategies, the 16 experimental TS strategies, their prospective
Java ports, the 6 `SHADOW` institutional engines, and the "Two-Sigma-style" cross-sectional/technical
catalog (time-series momentum, Donchian, MA crossover, ADX, RSI(2)/MACD/Bollinger mean-reversion
variants, etc. — added this session, `RESEARCH` status, real formulas, zero real-bar evidence yet).

### C. Should strategy agreement determine BUY/SELL by vote count?

**No — and, encouragingly, it mostly doesn't today.** `VERIFIED` this pass
(`QuantSignalAgent.ts:280-287,531-533`): all 21 TS strategies (5 CORE + 16 experimental) are
evaluated via `evaluateAll(strategyContext)`, reduced to one winner via `bestStrategyIdea()`, and
emitted as **exactly one** `eventBus.emitTradeIdea()` call under **one agent identity,
`'QuantEngine'`**. ChiefTrader's `EvidenceAggregator` (`VERIFIED`,
`src/server/services/EvidenceAggregator.ts:45-51`) counts one vote per **agent name**
(`coalesceEvidenceByAgent`) — so today, no matter how many of the 21 TS strategies agree, ChiefTrader
only ever sees one "QuantEngine" vote. **The "5 correlated strategies = 5 independent votes"
fallacy the request describes does not exist at the cross-agent ChiefTrader level today.**

It does matter in two places that are real and should be addressed, not assumed fine:

1. **Inside `bestStrategyIdea()`'s own selection logic** (`src/server/quant/strategies/
   StrategyEngine.ts`, not re-read line-by-line this pass — `UNVERIFIED` whether it already
   discounts for multiple agreeing-but-correlated strategies, or just takes whichever has the
   highest raw `setupScore`). This is the first place a correlation-aware aggregation should be
   verified/applied, before it matters anywhere else.
2. **The `internalQuantEnsemble.ts` / `QuantEnsembleEngine.java` path** already uses real
   correlation-adjusted math (§3) for the Java `JAVA_RESEARCH_STRATEGY_IDS` subset — this is the
   piece to extend, not duplicate.

**Aggregation mechanism (reuse, do not rebuild):** `QuantEnsembleEngine.java`, read in full this
pass, already implements the correct, standard statistical tool for this — a generalization of the
Kish design effect / Grinold-Kahn "breadth" concept:

```text
N_eff = (Σ wᵢ)² / Σᵢ Σⱼ (wᵢ · wⱼ · ρᵢⱼ)
```

`effectiveIndependentCount(weights, correlationMatrix)` (lines 64-78) is a real, disclosed,
config-declared-assumption implementation (`DEFAULT_SAME_FAMILY_CORRELATION = 0.75`,
`DEFAULT_CROSS_FAMILY_CORRELATION = 0.15` — explicitly documented in the class header as a reviewed
assumption pending real measured model-to-model correlation, not fabricated precision).
`combine()` (lines 106-153) restricts the correlation submatrix to *agreeing* votes only (a BUY and
a SELL are never "correlated agreement" with each other) and resolves ties to `NEUTRAL`, never an
arbitrary side. **This is exactly the right foundation — extend it, do not build a second one**, per
the request's own instruction.

Worked example, using the engine's real math (not invented for this doc):

```text
10 strategies agree, all same family (ρ=0.75), weight 1.0 each:
  N_eff = (10)² / (10·10·0.75 + 10·1·0.25[diagonal 1.0 vs 0.75 off-diag]) ≈ (100) / (90·0.75 + 10·1.0)
        ≈ 100 / 77.5 ≈ 1.29 effective independent signals

3 strategies agree, from 3 distinct families (ρ=0.15 cross-family), weight 1.0 each:
  N_eff = (3)² / (3·1.0[diag] + 6·0.15[off-diag]) = 9 / (3 + 0.9) = 9 / 3.9 ≈ 2.31 effective
        independent signals
```

Ten correlated votes are worth barely more than one independent one; three genuinely diversified
families are worth more than double that, close to their raw count. This is precisely the intuition
the request asks for, and the codebase already computes it correctly.

### C.1 Addendum — independence counting confirmed at the exact call site (background verification)

`VERIFIED`, `ChiefTraderAgent.ts:714-717`:

```ts
const uniqueIndependent = new Set(
  result.agreements.filter(e => e.agent !== 'ConsensusDebate').map(e => e.agent)
);
const enoughIndependentVoices = uniqueIndependent.size >= MIN_INDEPENDENT_AGREEING_AGENTS;
```

Confirms §1.C precisely: independence is a `Set` over distinct `agent` name strings, nothing more.
A repo-wide grep for `isAiDependent|requiresAi|aiFree|deterministicAgent|aiIndependent` returns
**zero matches** — there is no existing concept anywhere in the codebase of "this agent is
AI-independent," which means two purely deterministic agents (`TechnicalAgent`, `QuantEngine` —
both confirmed zero-`AIRouter`-dependency by direct read) already satisfy
`minIndependentAgreeingAgents` today without any AI involvement. This is a real, already-working
property, not something that needs to be built — it falls out of the existing by-name counting plus
the fact that `TechnicalAgent`/`QuantSignalAgent`/`PortfolioMonitor`/`OpportunityScreener`/
`TradePlanBuilder`/`JavaFactorComposite` are all confirmed AI-free agent identities.

### D. Should AI be required for a trade?

**No — and the codebase already mostly agrees, with one real inconsistency worth fixing.**
`VERIFIED` this pass, `ChiefTraderAgent.ts:455-473`: when the adversarial debate would trigger
(`idea.confidence > tradingSafety.debateTriggerConfidence`, currently `0.6` per
`config/tradingSafety.json:75`) but **zero AI providers are routable at all**
(`!hasAnyRoutableProvider()`), the debate call is **skipped entirely** — ChiefTrader evaluates
consensus on the independent agents' own evidence only, explicitly **not** injecting a fabricated
fail-closed HOLD. The code comment names this a "Zero-Trade Forensic Audit follow-up" — a real,
deliberate prior fix for exactly the failure mode this request worries about.

**The gap:** if debate *is* attempted (some providers routable) and it fails or returns zero usable
verdicts, `pushDebateFailClosed()` still casts a real HOLD vote from agent `'ConsensusDebate'`
(`ChiefTraderAgent.ts:515-517,538-539,541-543`) — which can veto or drag down confidence for a
high-confidence idea. **This means ARGUS is currently more resilient to total AI outage than to
partial AI degradation** — backwards from best practice. `PROPOSED` fix (§10): extend the same
`hasAnyRoutableProvider()`-style pre-check to also skip (not fail-closed-HOLD) when the *specific*
attempted providers are known-degraded (auth-failed/quota-exhausted/rate-limited, per
`AIProviderHealthCheck.classifyError()` — `VERIFIED (prior pass)`, cited in `CLAUDE.md`), reserving
`pushDebateFailClosed()` for the case where providers *were* routable and genuinely returned no
usable verdict (a real signal, not an artifact of a known outage).

**What AI should contribute, going forward:** reasoning-context enrichment (already the pattern for
`loadJavaInstitutionalDebateContext()`), adversarial "reasons not to trade" review when confidence
already clears the bar on deterministic evidence, and Bull/Bear HOLD-veto research — never a
required ingredient for the deterministic evidence itself to reach ChiefTrader.

### E. What should happen if all AI providers are unavailable?

`PROPOSED`, formalizing behavior that partially already exists (§10 has the full state machine):
skip debate/Bull-Bear entirely (already true for total outage, `VERIFIED`). Per-agent behavior on
AI failure, `VERIFIED` this pass (background investigation, direct file reads):

- **NewsEngine.ts is local-first, not AI-dependent by default** — FinBERT sentiment is computed
  locally; `decideEscalation()` only escalates to an LLM when FinBERT is genuinely undecided, capped
  by `tradingSafety.newsLlmMaxCallsPerCycle`. On LLM failure/cap it falls back to
  `buildLocalFirstNewsAnalysis()` (tagged `[Local-First]`) rather than emitting nothing — closer to
  "degrades to a cheaper deterministic signal" than "goes silent."
- **FundamentalAgent.ts and MacroAgent.ts are genuinely AI-dependent** and fail closed to a real
  `HOLD` vote (`emitHold`) on no routable provider, empty content, or unparseable JSON — confirmed
  at the exact call sites, not inferred. A `HOLD` from these agents only matters if they are also
  in `agentWeightConfig.consensusHardVetoAgents` (not confirmed either way this pass); otherwise
  `EvidenceAggregator`'s own doc comment says non-hard-veto `HOLD`s "do not block Technical+Quant
  consensus."
- **KronosForecastAgent.ts fails closed to no idea at all** (not a HOLD) when its local Chronos
  service is down — explicitly documented in its own code comment as never fabricating a
  BUY/SELL when Chronos is unavailable. (Chronos is a local time-series model, not an AIRouter/LLM
  provider — a separate dependency from the AI-availability question, but worth naming since it's
  easy to conflate the two.)

ChiefTrader evaluates consensus on TechnicalAgent + QuantEngine
(+ `JavaFactorComposite` if that override is enabled and Java is up) only, with **no change** to
`consensusApprovalThreshold` (0.75) or `minIndependentAgreeingAgents` (2). Fewer sources means
`NO_TRADE` more often for symbols that would have needed a 3rd/4th agent's confirmation — never an
automatically-approved trade. Emit a new `AI_UNAVAILABLE` observability event (does not exist today
under this name — `PROPOSED`, §17).

### F. What should happen if Java Quant is unavailable?

`VERIFIED` (this pass + Forensic Audit §5): `QuantCoreBridge`'s ~10 `fetch*`/`compare*` methods all
check `isQuantJavaCoreEnabled()` + circuit-breaker state before calling, and fail closed (return
`null`/skip) on the flag being off, the breaker being open, a non-2xx response, or any thrown error
— confirmed across every method, never fail-open. Concretely, Java being fully down means:

- The 6 `SHADOW` engines stop contributing debate-context text — zero observable trading impact
  (text-only today).
- Both 2026-09-09 overrides degrade to "contributes nothing" (`JavaFactorComposite` emits no vote;
  the independence-qualification substitute is simply unavailable, falling back to requiring a real
  second independent agent) — **not** a fabricated stand-in.
- **Critically, `VERIFIED` this pass** (`QuantSignalAgent.ts:270-287`): the `strategyContext` that
  feeds the 5 CORE + 16 experimental TS strategies is built entirely from TS-native indicator
  modules (`computeTrendFeatures`, `computeMomentumFeatures`, `computeVolatilityFeatures`, etc.) —
  **zero dependency on the Java process being up.** `QuantEngine`'s vote keeps functioning
  completely normally.

**Net effect:** Java going down degrades ARGUS from "Technical + QuantEngine + possibly
JavaFactorComposite, up to 3 independent-capable sources" to "Technical + QuantEngine, 2 sources" —
**not to zero quantitative capability.** This is a genuinely important design property, and it
directly informs a disagreement with the request's own target diagram (§2 below).

---

## 2. A direct disagreement with the request's target diagram

The request's target architecture shows a single funnel: `Java Quant Engine → 200+ Quant Models →
... → Quant Candidate → ChiefTrader`, implying TS's own `StrategyEngine` becomes, eventually, just a
client of Java. **I would not implement this.** Keep `src/server/quant/strategies/StrategyEngine.ts`
(the 5 CORE + 16 experimental TS strategies) as a **permanently independent, permanently supported**
deterministic evidence source feeding `QuantEngine`'s vote — not a legacy shim scheduled for removal
once Java matures.

Reasoning: §1.F shows this redundancy is exactly what keeps ARGUS's deterministic-evidence capacity
alive when the Java process itself is down, restarting, or degraded — a real operational risk for a
standalone companion process with its own JVM, its own memory/GC behavior, its own crash modes,
none of which TS's in-process strategy evaluation shares. A Java-only quant path would make ARGUS's
entire deterministic evidence supply a single point of failure it does not need to have. The correct
end-state (§4, §5) is **two independent, genuinely-uncorrelated deterministic evidence sources**
(TS StrategyEngine and Java Quant Ensemble), each capable of operating alone, combined through the
same correlation-aware ensemble math either could use standalone — not one subsuming the other.

---

## 3. Correlation / independence design (reuse, don't duplicate)

Already covered in §1.C. Summary of what to build vs. reuse:

| Component | Action |
|---|---|
| `QuantEnsembleEngine.effectiveIndependentCount()` / `.combine()` | **Reuse as-is.** Real, correct, tested math. |
| `defaultFamilyCorrelationMatrix()` (0.75 same-family / 0.15 cross-family) | **Reuse as the interim default**, but flag explicitly (as its own header already does) that this is a reviewed assumption, not measured data — a real historical per-model outcome ledger (a future `ModelPerformanceTracker`, per the class's own header) should eventually replace it. `PROPOSED`, not built. |
| `internalQuantEnsemble.ts` | **Extend**, not replace — it is the one live, real caller of the Java ensemble math today (`JAVA_RESEARCH_STRATEGY_IDS` subset). The natural place to widen scope as more Java engines reach `PRODUCTION_CANDIDATE` (§9). |
| `bestStrategyIdea()` selection inside TS `StrategyEngine.ts` | `UNVERIFIED` whether it needs a correlation adjustment of its own — read this before assuming it's fine, §21 Phase 1. |
| A **new**, second correlation system | **Do not build.** Everything needed already exists in `QuantEnsembleEngine.java`. |

---

## 4. Quant Ensemble contract — first production version

`PROPOSED` schema, building directly on `QuantEnsembleEngine`'s existing `ModelVote`/`EnsembleResult`
records (extend, don't replace):

```java
// Extends the existing QuantEnsembleEngine.ModelVote — additive fields only.
public record StrategyAssessment(
    String symbol,
    String strategyId,        // e.g. "MOMENTUM_BREAKOUT" or a Java quantModels key
    String strategyVersion,   // PROPOSED: not tracked anywhere today — needed for the decision record (§8)
    String family,            // matches QuantEnsembleEngine.ModelVote.family — MOMENTUM/TREND/MEAN_REVERSION/...
    Side direction,           // BUY | SELL | HOLD | DATA_UNAVAILABLE — HOLD and DATA_UNAVAILABLE are NOT the same (request §9, agreed)
    double score,             // 0-100, e.g. setupScore
    double confidence,        // 0-1
    String reason,
    String regime,            // from RegimeEngine/features.RegimeEngine
    String dataQuality,       // PROPOSED enum, see §16
    long dataTimestamp,
    long evaluationTimestamp,
    long latencyMs
) {}

// Ensemble output — extends QuantEnsembleEngine.EnsembleResult with the fields needed to answer
// "why did Quant say BUY?" end to end.
public record QuantEnsembleDecision(
    String symbol,
    Side direction,
    double ensembleScore,
    double confidence,
    int strategyCount,
    int agreeingStrategyCount,
    double effectiveIndependentCount,
    Map<String, Double> familyScores,
    String regime,
    String dataQuality,
    long timestamp,
    Map<String, String> modelVersions,   // strategyId -> version, PROPOSED
    String reason
) {}
```

`DATA_UNAVAILABLE` as a distinct direction (not folded into `HOLD`) is a real, useful change — today
TS strategies return `BUY`/`SELL` only (`StrategyEvaluation` has no `HOLD`/`DATA_UNAVAILABLE` case,
confirmed by `src/server/quant/strategies/types.ts:45-57` read this pass — `side: 'BUY' | 'SELL'`
only) and `bestStrategyIdea()` presumably treats "no qualifying strategy" as silence, not an
explicit `DATA_UNAVAILABLE` record. `PROPOSED`: adding a real `DATA_UNAVAILABLE` case would let the
ensemble distinguish "this strategy looked and saw no edge" from "this strategy couldn't evaluate at
all" — useful for the effective-independent-count math (a `DATA_UNAVAILABLE` vote should never be
silently dropped from the denominator context the way a below-threshold `HOLD` might be).

Thresholds are explicitly not invented here without evidence, per the request's own instruction.
Where a number is needed to ship a first version, it is marked:

- Minimum `effectiveIndependentCount` to treat the ensemble as one qualified vote: **PROPOSED,
  reuse the existing `minQuantIndependentEffectiveCount` (2.5) and `minQuantIndependentFamilies`
  (3) from `config/tradingSafety.json` — already real, already reviewed, already in production use
  for the narrower internal-ensemble path.** Do not invent a second number for the same concept.

---

## 5. ChiefTrader integration — Model A vs Model B

Request's Model A: `200+ strategies → Quant Ensemble → one Quant signal → ChiefTrader`.
Request's Model B: `Independent Quant Families → ChiefTrader` (each family votes separately).

**Decision: Model A, with the §2 caveat that "Quant Ensemble" itself has two genuinely independent
internal sources (TS StrategyEngine, Java quant catalog), not one.**

Reasoning:

- **Independence semantics:** Model B (each family votes separately into ChiefTrader) would make
  `EvidenceAggregator.coalesceEvidenceByAgent()`'s one-vote-per-agent-name logic (§1.C) the *only*
  thing preventing double counting — fragile, because it silently depends on families always being
  registered as distinctly-named agents forever. Model A keeps the correlation-aware math (§3, §4)
  as the actual mechanism preventing double counting, with `EvidenceAggregator` doing what it does
  today (one vote per agent) on top of an already-correct single number.
- **Double counting:** Already avoided today for TS strategies (§1.C) by construction (one
  `QuantEngine` agent identity). Model A extends this same pattern to the Java catalog rather than
  introducing a second, parallel voting shape ChiefTrader has to reason about.
- **Confidence / observability:** One `QuantEnsembleDecision` record per symbol (§4) is a strictly
  better decision-record shape than N per-family HOLD/BUY/SELL rows ChiefTrader would have to
  reconcile itself — simpler to trace, simpler to test, matches `EvidenceAggregator`'s existing
  one-vote-per-source design.
- **Failure behavior:** A single `QuantEnsembleDecision` either exists (real evidence) or doesn't
  (fails closed, §16) — cleaner than partial-family-failure semantics leaking into ChiefTrader's own
  consensus loop.
- **Scalability:** Adding a new Java engine or promoting one from `RESEARCH` to `PRODUCTION_CANDIDATE`
  (§9) only changes what feeds the ensemble internally — zero change to ChiefTrader, RiskEngine, or
  the agent-weight config. Model B would require touching `config/agentWeights.json` and
  `consensusHardVetoAgents` semantics every time a new family is promoted.

**How the ensemble counts toward `minIndependentAgreeingAgents` (request §11):** one
`QuantEnsembleDecision` (spanning both TS and Java sources) = **one** independent evidence source,
exactly like `QuantEngine` today. It can substitute for the "second independent agent" slot **only**
when it clears `effectiveIndependentCount >= minQuantIndependentEffectiveCount` AND spans
`>= minQuantIndependentFamilies` distinct families — i.e., exactly the existing
`isQuantIndependentQualificationEnabled` mechanism (§1.A), extended in scope as more of the Java
catalog is promoted, not replaced. `consensusApprovalThreshold` (0.75) and
`minIndependentAgreeingAgents` (2) stay unchanged, per the request's explicit instruction and my own
agreement with it.

---

## 6. Canonical data architecture

`VERIFIED (prior pass, re-confirmed this pass)` root cause: `POST /api/v1/ticks`
(`QuantCoreBridge.sendTick()`) is fire-and-forget — no delivery guarantee, no ordering guarantee,
no ack. Java's `SymbolState.java` accumulates its own independent tick ring buffer from this
unreliable stream. Because RSI/MACD use recursive smoothing, one dropped or reordered tick makes the
two arrays diverge **permanently**, not just transiently — this is the confirmed, root-caused
explanation for the ~80%/>5% and ~56%/>20% divergence figures.

`PROPOSED` fix — do not widen tolerances (explicitly forbidden by the request, and correctly so):

1. **Sequence-numbered, acknowledged delivery.** Every tick TS sends to Java carries a monotonic
   per-symbol sequence number. Java tracks the last-applied sequence per symbol and rejects/logs a
   gap rather than silently accepting an out-of-order or missing tick. This directly answers the
   request's "ordering / duplicates / gaps" requirements.
2. **Periodic full-array resync, not just incremental ticks.** On a bounded interval (or on gap
   detection from #1), TS pushes its own authoritative `priceHistory[symbol]` array wholesale — the
   same array TS's own RSI/MACD read — so a Java restart or a missed-tick window self-heals within
   one resync cycle instead of diverging forever. This is the direct fix for "Java process restart
   must not silently create incorrect indicator state" (request §23) and "resynchronize from
   canonical market data" (request §33).
3. **Session-boundary and timestamp alignment.** `UNVERIFIED` this pass whether TS and Java already
   agree on session-boundary semantics (America/New_York day boundaries, per `CLAUDE.md`'s
   `getTradingDateStr` convention) — a real, bounded follow-up to check before or alongside #1/#2,
   not assumed fine.

This is a genuine, deliberate cross-language protocol change, exactly as the request asks — not
rushed, and explicitly the P0 architectural item (§21) precisely because everything downstream
(FeatureEngine parity, the 5 CORE strategies, any future Java vote) inherits this problem if it goes
unfixed.

**A real, unresolved conflict between two of this repo's own prior audits, surfaced this pass, not
silently picked one side of:** `ARGUS_ARCHITECTURE.md`'s Java Quant Core section has a
**2026-08-26**-dated "root cause... not an algorithm defect" note claiming the shadow-parity
divergence was caused by TS and Java comparing **different-length rolling tick histories** (TS
capped at 52 ticks, Java at 200) and was fixed by `tradingSafety.quantJavaCoreLocalHistoryCap`
(`VERIFIED` this pass: `config/tradingSafety.json:153`, value `200`, the config key genuinely
exists). The Forensic Audit's divergence figures (~80% >5%, ~56% >20%) come from
`observability_events` spanning **2026-08-24 → 2026-09-04** — a window that starts *before* and
mostly *after* the claimed 08-26 fix, aggregated as one figure with no before/after breakdown.
**I cannot tell from existing evidence whether the window-length fix already resolved most of the
divergence and the aggregate figure is dominated by pre-fix samples, or whether the
fire-and-forget/no-ack tick-delivery issue (§6 above) is a second, still-live, compounding cause.**
Both problems are independently real (the config key's existence doesn't prove the delivery-ordering
issue is fixed, and vice versa) — do not assume either audit fully explains the other's numbers.
**PROPOSED, cheap, and should happen before any other Phase 1 work**: a fresh, date-segmented count
of `QUANT_CORE_PARITY_DIVERGENCE`/`QUANT_CORE_REGIME_PARITY_DIVERGENCE` events, split at the 08-26
fix boundary, to determine which root cause (or both) is still live today. This was already named as
a bounded follow-up in the Forensic Audit (§7 P2.5) — elevate it to a Phase 1 prerequisite, not a
P2, given this newly-found conflict.

---

## 7. FeatureEngine — what's needed, from the actual `StrategyContext` (not assumed)

`VERIFIED` this pass, `src/server/quant/strategies/types.ts:22-38` — the real, current interface:

| Feature | TS module (owner) | Java equivalent | Status | Priority |
|---|---|---|---|---|
| `trend` | `quant/indicators/trend.ts` | `features.TrendFeatures` (ported, unconnected — §0) | Ported, orphaned | P0 (adapter) |
| `momentum` | `quant/indicators/momentum.ts` | **No `features.MomentumFeatures` file found** — `StrategyContext.java`'s own `MomentumFeatures` nested record has no upstream computation class at all | `UNVERIFIED` — not confirmed this pass; the `features/` package listing (§0) shows no separate `MomentumFeatures.java` | P0 (confirm/port) |
| `volatility` | `quant/indicators/volatility.ts` | `features.VolatilityFeatures` (ported, unconnected) | Ported, orphaned | P0 (adapter) |
| `volume` | `quant/indicators/volume.ts` | `features.VolumeFeatures` (ported, unconnected) | Ported, orphaned | P0 (adapter) |
| `priceAction` | `quant/indicators/priceAction.ts` | `features.PriceActionFeatures` (ported, unconnected) | Ported, orphaned | P0 (adapter) |
| `supportResistance` | `quant/indicators/supportResistance.ts` | `features.SupportResistanceFeatures` (ported, unconnected) | Ported, orphaned | P0 (adapter) |
| `regime` | `quant/RegimeEngine.ts` | `features.RegimeEngine` (ported, **live-wired** for regime-only shadow compare) | Ported, partially wired | P0 (extend wiring) |
| `marketContext` | `quant/MarketContext.ts` | `features.MarketContext` (ported, unconnected to strategies) | Ported, orphaned | P0 (adapter) |
| `smc` (optional, SMC/ICT) | `quant/indicators/smc.ts` | None found | Not ported | P2 — only feeds `SMC_LIQUIDITY_SWEEP`, itself flag-gated and `UNVALIDATED` |
| `assetClass` (optional overlay) | `config/multiAsset.json`-driven | N/A | Config-only | N/A |

**Real finding, not assumed:** the expensive work (porting and parity-testing the actual feature
math) is **already done** for 7 of 9 fields. What's missing is (a) confirming/porting `momentum`
specifically, and (b) the adapter + live wiring connecting `features.*` to
`strategy.types.StrategyContext` and a real `/api/v1/evaluate` caller. This reframes "build a Java
FeatureEngine" from a multi-week clean-room port into a bounded integration task — see §21 Phase 1.

---

## 8. Five CORE strategies — migration order

`VERIFIED` (Forensic Audit + this pass): all 5 (`momentumBreakout`, `pullbackContinuation`,
`meanReversion`, `trendFollowing`, `rangeReversion`) have TS originals (production-authoritative),
Java ports (`strategy/core/*.java`, registered, `REGISTERED_BUT_UNREACHABLE`), synthetic-fixture
decision-logic parity tests (`StrategyParityTest.java`, 9 tests, real evidence the *decision logic*
matches given identical inputs — not real-bar evidence), and zero real-bar/runtime/backtest-parity
evidence. No feature-dependency differences between the 5 — they share the same `StrategyContext`
shape, so migration order is not driven by per-strategy feature gaps but by **risk and diagnostic
value**:

1. **`momentumBreakout`** first — request's own consistent example strategy, simplest feature
   dependency (`trend`, `momentum`, `volume` primarily), highest existing test coverage
   (`momentumBreakout.test.ts` confirmed). Best candidate to prove the full pipeline (adapter → real
   caller → shadow-comparison → divergence measurement) end-to-end before repeating for the other 4.
2. **`meanReversion`** and **`rangeReversion`** next — shorter holding periods (per
   `STRATEGY_TYPICAL_HOLDING_PERIOD`, `types.ts:83-105`) mean faster accumulation of real
   shadow-comparison samples for the same wall-clock soak window.
3. **`pullbackContinuation`** and **`trendFollowing`** last — longer holding periods, slower signal
   generation, slower evidence accumulation; also `trendFollowing`'s "no fixed target, open-ended"
   design (per its own doc string) makes shadow-comparison harder to score cleanly.

**Do not delete any TS implementation at any point in this sequence** — matches the request's
explicit instruction and this codebase's own established Stage A→D discipline (§9 below).

---

## 9. Promotion funnel

`PROPOSED`, reusing this codebase's existing status vocabulary (`config/engineOwnership.json`
already uses `RESEARCH`/`SHADOW`) rather than inventing a parallel one:

```text
RESEARCH        → real formula, unit-tested vs synthetic/deterministic fixtures only. (117 of 123
                  quantModels sit here today.)
        ↓ requires: real-bar validation (not synthetic fixtures) — feed real historical Bar[] through
          the engine, confirm no NaN/off-by-one/look-ahead defects on real data shapes
VALIDATED       → real-bar execution confirmed correct; historical backtest run (mechanism only, no
                  profitability claim); OOS/walk-forward attempted
        ↓ requires: OOS/walk-forward does not fail outright (CLAUDE.md's own ground truth: existing
          checked TS strategy combos already failed walk-forward OOS — a real, not hypothetical, bar)
SHADOW          → live HTTP endpoint + a real consumer that logs/compares output against something,
                  zero decision influence (matches the existing 6-engine SHADOW definition exactly)
        ↓ requires: a real, dated, multi-week clean-divergence soak — "no shortcuts on calendar time"
          (this codebase's own stated precondition, twice explicitly overridden this session for
          narrower mechanisms, not lightly re-invoked)
PAPER-ELIGIBLE  → eligible to cast one real emitTradeIdea vote (or contribute to the
                  QuantEnsembleDecision) in PAPER mode only — same shape as the existing
                  `JavaFactorComposite` override, never LIVE
        ↓ requires: real organic PAPER outcome evidence accumulates (profit factor / expectancy per
          config/researchSafety.json's existing floors — reused, not reinvented)
PROMOTED        → counted toward `minIndependentAgreeingAgents` without a stricter qualification bar
                  (i.e., graduates out of the "narrower, stricter-than-normal" override shape into a
                  normal independent agent)
```

`DEPRECATED` and `EXPERIMENTAL` are separate axes, not funnel stages: `DEPRECATED` marks an engine
explicitly superseded (none identified this pass); `EXPERIMENTAL` marks intentionally
unvalidated/exploratory work not yet claiming even `RESEARCH`-grade completeness (matches the
existing TS `EXPERIMENTAL_STRATEGIES` convention already in use for the 16 non-CORE TS strategies).

**Do not claim profitability from unit tests. Do not let a compiling Java class imply readiness.**
Every stage transition above requires new evidence, not new code.

---

## 10. AI / Quant availability state machine

`PROPOSED` (formalizes what today exists as scattered per-agent behavior, §1.D/E):

```text
AI_HEALTHY       — hasAnyRoutableProvider() true, no elevated error rate on attempted providers
AI_DEGRADED      — some providers routable, but recent attempts show elevated
                   auth/quota/rate-limit errors (AIProviderHealthCheck.classifyError(), VERIFIED
                   prior pass, exists today) — PROPOSED: extend the existing hasAnyRoutableProvider()
                   pre-check to also treat "the specific providers about to be tried are
                   known-degraded" as a skip-not-fail-closed case (closes the §1.D gap)
AI_UNAVAILABLE   — !hasAnyRoutableProvider() — already real, already skips debate (§1.D)

QUANT_HEALTHY    — TS StrategyEngine always healthy (in-process, no external dependency);
                   Java Quant Core additionally healthy if isQuantJavaCoreEnabled() and circuit
                   breaker closed
QUANT_DEGRADED   — Java circuit breaker open / elevated error rate, TS StrategyEngine still healthy
                   — PROPOSED, not a distinct state today; Java's fail-closed-to-null behavior
                   already approximates "degrade gracefully," just not labeled
QUANT_UNAVAILABLE — Never true in the "no quantitative candidate at all" sense the request's matrix
                   implies, because TS StrategyEngine has no external dependency (§1.F) — the
                   closest real analog is "TS StrategyEngine itself throws," which is a code defect,
                   not an availability state, and should fail closed the same way any other agent
                   crash does today (UNVERIFIED whether QuantSignalAgent already wraps evaluateAll()
                   in a try/catch that fails closed rather than crashing the process — worth
                   confirming, not assumed)
```

Decision matrix (`PROPOSED`, reflecting the corrected reality that Quant is structurally almost
never "unavailable" the way the request's matrix assumes):

| Quant | AI | Behavior |
|---|---|---|
| TS healthy, Java healthy | healthy | QuantEngine vote + JavaFactorComposite vote (if enabled) + AI debate/research context |
| TS healthy, Java healthy | degraded | Same quant evidence; debate/research skipped only for the specific degraded providers, not a fabricated HOLD |
| TS healthy, Java healthy | unavailable | Same quant evidence; debate/Bull-Bear skipped entirely (already real, §1.D) |
| TS healthy, Java degraded/down | any | QuantEngine vote only; JavaFactorComposite/independence-substitute unavailable, fails closed (already real, §1.F) — AI behavior unchanged by Java's state |
| TS itself throws (code defect) | any | `PROPOSED`: fail closed for that symbol/cycle only — log, do not emit a vote, do not crash the process. Confirm today's actual behavior before assuming this (see `QUANT_UNAVAILABLE` row above). |

No AI-unavailable state should ever auto-generate a trade. No Quant-degraded state should ever
lower `consensusApprovalThreshold` or `minIndependentAgreeingAgents` to compensate — the correct
response to reduced evidence is a higher `NO_TRADE` rate, never a lowered bar.

---

## 11. Risk / OMS boundary

`VERIFIED (prior pass, unchanged)`: zero broker imports, zero `.placeOrder()`-equivalent calls
anywhere in `quant-core-java/`, by design and by repeated audit. Nothing in this design changes that
boundary. `QuantEnsembleDecision` (§4) is a candidate, never an authorization — it reaches
ChiefTrader exactly the way `QuantEngine`'s vote does today (`eventBus.emitTradeIdea`), then RiskEngine's
25 gates, then OMS, unchanged.

---

## 12. Backtest / replay ownership

`VERIFIED (prior pass)`: no Paper=TS/Backtest=Java mismatch exists today — `argusStrategyReplay.ts`
and `BacktestEngine.ts` both use the exact same TS strategy source the live paper path uses.
`JavaBacktestEngine.java` is a third, standalone, unwired, uncross-validated implementation — a
dead-code/duplication risk, not a parity risk, because nothing consumes its output as comparable
evidence today. `PROPOSED`: either (a) wire it with a real parity test against `BacktestEngine.ts`
before treating its output as evidence, or (b) mark it explicitly `DEPRECATED`/research-archive-only
in its own header so nobody mistakes future silence for readiness. Do not remove it without one of
those two outcomes — matches the request's explicit instruction.

---

## 13. Performance / tiered execution

`UNVERIFIED` this pass — no p50/p95/p99 latency measurement exists for any Java Quant Core route
(confirmed as an explicit gap in the Forensic Audit §10, not re-measured here). The request's
suspected funnel shape (cheap filters → candidate ranking → smaller universe → expensive models) is
**directionally correct and already partially implemented**, not merely a good guess:
`ComposableRanking.ts`'s `javaQuantScore` component (`VERIFIED (prior pass)`, cited in `CLAUDE.md`'s
Premarket section) is deliberately bounded to the top `javaQuantScoreCandidateLimit` (20) candidates
per day, specifically to avoid paying Java HTTP + computation cost for the whole scan universe.
`PROPOSED` tiers, using the actual repository's own real categories rather than an invented scheme:

```text
Tier 0 — Data quality gate      : market_data_quality (SHADOW today) — cheapest, must run first
Tier 1 — Cheap TS screening     : existing TechnicalAgent RSI/MACD/BB (already live, in-process, no
                                   Java round-trip)
Tier 2 — Core quant models      : the 5 CORE strategies (TS today; Java once §21 Phase 1-3 land) +
                                   the 16 experimental TS strategies, flag-gated
Tier 3 — Specialized/regime     : garch, hmm_regime, factor_composite, volatility_engine — already
                                   SHADOW, already bounded to the candidate-limited premarket path
Tier 4 — Research/asset-class   : the ~117 RESEARCH-status engines, most with no live data feed at
                                   all (§1.B) — never run inline on the hot path; exist for
                                   asset-class capability that doesn't exist yet or for future
                                   promotion-funnel work
```

Do not run all 123 `quantModels` per symbol per cycle — most structurally cannot (no data feed) and
the rest have no promotion evidence yet (§9). Real p50/p95/p99 measurement is a named, bounded
follow-up before any tier boundary becomes a hard performance claim — not done here.

---

## 14. Failure matrix

| Failure | Behavior |
|---|---|
| Market data unavailable | `VERIFIED (prior pass)`: RiskEngine gate 13 `data_freshness` fails closed on null tick age — existing, unchanged |
| Stale market data | Same gate, `stalePriceThresholdMs` — existing, unchanged |
| Java Quant Core fully unavailable | `VERIFIED` this pass (§1.F): fails closed across all `QuantCoreBridge` methods; TS StrategyEngine unaffected |
| Java timeout | `VERIFIED (prior pass)`: every bridge call wrapped in `quantJavaCoreRequestTimeoutMs`; circuit breaker opens on repeated failure |
| Java partial failure (one engine errors, others fine) | `UNVERIFIED` — whether one bad engine response can take down a whole `/api/v1/institutional/strategy/{id}/{symbol}` batch or fails independently per-id; worth confirming before §21 Phase 2 |
| Individual TS strategy failure/throw | `UNVERIFIED` — see §10's `QUANT_UNAVAILABLE` row; confirm `evaluateAll()`'s own error handling before assuming per-strategy isolation |
| Feature computation failure | `PROPOSED`: should produce `DATA_UNAVAILABLE` (§4), not a silent `HOLD` |
| Correlation engine failure | `VERIFIED`: `QuantEnsembleEngine.effectiveIndependentCount()` returns the raw (unscaled) count on a non-positive denominator — never fabricates a number the math doesn't support (line 76) |
| Ensemble failure | `PROPOSED`: should fail closed to "no `QuantEnsembleDecision`," equivalent to today's "Quant just doesn't vote" |
| AI unavailable | `VERIFIED` (§1.D): skips debate, no fabricated HOLD, for total outage; `PROPOSED` fix for partial degradation |
| ChiefTrader/RiskEngine/OMS/broker unavailable | Out of scope for this design — protected spine, `CLAUDE.md`'s existing invariants apply unchanged |

---

## 14.1 A real, previously-undocumented gap: AI health exists but isn't wired to agent health

`VERIFIED` (background investigation, direct file reads): `src/server/ai/AIProviderHealthCheck.ts`
already implements a real, richer-than-binary per-**provider** health state —
`HEALTHY | AUTH_FAILED | CONFIG_MISSING | PROVIDER_UNAVAILABLE | MODEL_UNAVAILABLE | RATE_LIMITED |
QUOTA_EXCEEDED | ACCOUNT_SUSPENDED | TIMEOUT | UNKNOWN` — exposed via
`GET /api/v2/runtime/ai/providers/health`, folded into `GET /api/v2/runtime/health`, and consumed by
`AIProviderManagement.tsx`. A second, separate view (`providerHealthMatrix.ts`,
`ACTIVE | AUTH_DISABLED | SKIPPED`) also exists, DB/routing-snapshot based.

**But `src/server/core/pipelineAgentHealthLabel.ts`** — the function that actually produces each
agent's operational health label for Mission Control (`ENV_OFF | OFFLINE | NOT_ARMED | STARTING |
IDLE_WAITING_FOR_MARKET_DATA | RUNNING | DEGRADED | UNAVAILABLE | FAILED | GATED`) — has a
`chronosAvailable` input specifically for `KronosForecastAgent`, but **no equivalent field for
AIRouter/LLM availability**, confirmed by reading the full function body. `FundamentalAgent`'s,
`MacroAgent`'s, and `NewsEngine`'s AI-degraded state is invisible to their own Mission Control health
label today. §10/§15's `AI_DEGRADED`/`AI_UNAVAILABLE` events are the right fix — **route them through
the existing `AIProviderHealthCheck.ts` state, do not build a third parallel health enum.** This is a
smaller, more concrete task than it first appears: the hard part (real per-provider health
detection) already exists and is already exposed via API; what's missing is threading it into
`pipelineAgentSnapshot.ts`'s `resolvePipelineAgentHealthLabel` call the same way
`resolveChronosAvailableForAgent()` already does for Kronos.

## 15. Observability

`PROPOSED` new structured events (none of these exist under these exact names today —
`UNVERIFIED`/confirmed-absent by the request's own list not matching any grep hit this pass, not
independently re-verified per-event):

```text
QUANT_EVALUATION_STARTED
QUANT_FEATURES_READY
QUANT_STRATEGY_EVALUATED
QUANT_STRATEGY_FAILED
QUANT_ENSEMBLE_COMPLETED
QUANT_CANDIDATE_GENERATED
QUANT_DATA_UNAVAILABLE
QUANT_JAVA_UNAVAILABLE
QUANT_PARITY_MISMATCH        (rename candidate for the existing QUANT_CORE_PARITY_DIVERGENCE /
                               QUANT_CORE_REGIME_PARITY_DIVERGENCE — VERIFIED prior pass, these
                               already exist; do not create a duplicate event name for the same
                               concept, extend/rename deliberately if unification is wanted)
AI_DEGRADED
AI_UNAVAILABLE
```

Every event should carry `traceId` (the existing `generateTraceId(symbol)` correlation key per
`CLAUDE.md` §4) so a `QuantEnsembleDecision` is joinable end-to-end through
`ChiefTraderAgent` → `RiskEngine` → OMS via the existing 7-table decision-trace reconstruction
(`getDecisionTrace(traceId)`) — reuse, do not build a second tracing mechanism.

---

## 16. Data quality

`PROPOSED` enum (referenced in §4/§14, not implemented today):

```text
FRESH        — tick age within stalePriceThresholdMs, sequence-verified (once §6 lands)
STALE        — tick age exceeded threshold but engine still evaluated (should generally not occur —
                RiskEngine gate 13 already blocks downstream on this; Quant-side check is
                belt-and-suspenders, not a new authority)
GAP_DETECTED — sequence gap found (once §6's sequence numbers exist) — resync pending
UNAVAILABLE  — no data at all for the requested window
```

---

## 17. Architecture Decision Record (concise form)

**Question:** Why should deterministic Java Quant become the quantitative foundation of ARGUS, with
AI as optional evidence rather than authoritative?

**Decision:** Yes, directionally — deterministic, reproducible, versioned quantitative evidence
should be the primary signal-generation layer, with AI restricted to reasoning-context enrichment
and adversarial review, never a required ingredient for a deterministic candidate to reach
ChiefTrader. This is already the direction the codebase's own most recent work points (the two
2026-09-09 overrides, the `hasAnyRoutableProvider()` fail-open-on-total-AI-outage fix). **Java**
specifically becomes *a* deterministic foundation alongside TS's own `StrategyEngine`, not the sole
one (§2) — because TS StrategyEngine's in-process, zero-external-dependency nature is itself a real
resilience property Java's standalone-process design cannot match, and giving that up for a
single-funnel architecture would trade determinism-of-computation for a new single point of failure.

**Why AI is optional, not authoritative:** LLM providers are external, unreliable dependencies
(auth failures, billing limits, timeouts, rate limits — all real, all previously observed and
documented in `CLAUDE.md`'s own AI routing section). A deterministic quantitative signal's validity
does not depend on whether Claude/Gemini/Mistral/Kimi/Ollama happen to be reachable this millisecond.
AI's real value — synthesizing qualitative context (news, macro, fundamentals) and adversarial
review — is complementary evidence, not foundational computation.

**Rejected alternatives:**

- *Java as sole quant authority, TS strategies removed once Java matures* — rejected, §2: gives up a
  real resilience property for no offsetting benefit; nothing in the request or the evidence
  requires TS's removal, only that it not be the *only* deterministic source forever.
- *Model B (per-family ChiefTrader voting)* — rejected, §5: reintroduces double-counting risk that
  today's single-agent-identity pattern structurally avoids, and complicates ChiefTrader/agent-weight
  config on every future engine promotion.
- *A second, independent correlation/ensemble system* — rejected, §3: `QuantEnsembleEngine.java`
  already implements the correct math; duplicating it would create exactly the "silent TS/Java fork
  computing the same thing two different ways" `CLAUDE.md`'s Java Quant Authority rule 7 already
  forbids.
- *Widening shadow-parity tolerances to make current divergence "pass"* — rejected outright, per the
  request's own explicit instruction and this document's own principle: the tolerance is not the
  problem, the tick-delivery protocol is (§6).

---

## 18. Implementation plan — staged, not a single change

**Phase 1 — canonical data + adapter (the real P0, per §0/§6):**
Files: `QuantCoreBridge.ts` (`sendTick`, add sequence numbers + a resync method),
`SymbolState.java` (track last-applied sequence, reject/log gaps), a new
`FeaturesToStrategyContextAdapter.java` (maps `features.*` records into
`strategy.types.StrategyContext`'s nested records — the concrete gap found in §0), confirm/port
`features.MomentumFeatures` if genuinely missing (§7). No ChiefTrader/RiskEngine/OMS files touched.

**Phase 2 — real shadow caller for the 5 CORE strategies:**
A new TS caller (mirroring `compareRegimeParity()`'s existing pattern) that, for `momentumBreakout`
first (§8's order), builds the real `StrategyContext` JSON payload TS already has in memory and
POSTs it to `/api/v1/evaluate`, logging divergence the same way indicator/regime parity already
does. Zero live-decision impact — purely observational, matching every prior shadow-wiring step in
this codebase.

**Phase 3 — repeat Phase 2 for the remaining 4 CORE strategies**, in the §8 order, only after
Phase 2's real-bar divergence data for `momentumBreakout` is reviewed (not assumed clean).

**Phase 4 — `QuantEnsembleDecision` (§4) as a real, callable Java endpoint**, consuming
`StrategyAssessment[]` from both the (now real-bar-validated) Java CORE strategies and, via
`internalQuantEnsemble.ts`'s existing pattern, the `JAVA_RESEARCH_STRATEGY_IDS` subset — extending,
not replacing, the live mechanism that already exists.

**Phase 5 — promotion funnel tooling (§9)**: real-bar validation harness, OOS/walk-forward wiring
reusing existing `researchSafety.json` floors, before any engine's status changes in
`config/engineOwnership.json`.

**Phase 6 — AI availability state formalization (§10)**: the `hasAnyRoutableProvider()` extension
for partial degradation, plus the `AI_DEGRADED`/`AI_UNAVAILABLE`/`QUANT_*` observability events
(§15).

**Tests required at every phase:** real-bar fixtures (not only synthetic), a Phase-1
sequence-gap/resync test suite, Phase-2/3 divergence-logging tests (mirroring
`ParityComparator`'s existing tests), Phase 4 ensemble tests covering correlated vs. independent
families and conflicting-family scenarios (§3's worked examples as literal test cases), Phase 6
AI-degraded-mode tests (healthy/degraded/unavailable × Java healthy/down, per §10's matrix).

**Runtime validation required:** a real, dated, multi-week clean-divergence soak before Phase 4's
`QuantEnsembleDecision` gets anywhere near vote/independence-substitute eligibility — the same
precondition this codebase's own migration blueprint already states, not a new bar invented here.

**Rollback:** every phase is additive and flag-gated (`QUANT_JAVA_CORE_ENABLED` and friends already
established as the pattern) — disabling the relevant flag reverts to current behavior with zero code
rollback needed, matching every prior Java Quant Core rollout in this codebase's history.

---

## 19. Remaining risks (explicit)

- Both 2026-09-09 overrides are live in production paper trading ahead of the canonical-data fix
  (§1.A) — a real, named risk, not a hypothetical one.
- `momentum` feature's Java-side computation status is `UNVERIFIED` (§7) — must be confirmed before
  Phase 1 is called complete.
- `bestStrategyIdea()`'s internal correlation-awareness is `UNVERIFIED` (§1.C, §3) — a real gap in
  this pass's evidence, not assumed fine.
- No p50/p95/p99 performance measurement exists anywhere in Java Quant Core (§13) — a real gap
  before any tier boundary becomes a hard claim.
- Session-boundary/timestamp alignment between TS and Java is `UNVERIFIED` (§6.3).
- 117 of 123 `quantModels` remain `RESEARCH` with zero real-bar evidence — none should be treated as
  more mature than that status says, regardless of how many equations their doc comments cite.

---

## 20. What I recommend doing first

**Phase 1 only** (§18): the adapter connecting `features.*` to `strategy.types.StrategyContext`,
plus the sequence-numbered tick delivery fix. This is the smallest, most concrete, most
evidence-backed next step — it closes the actual root cause behind the RSI/MACD divergence figures
that have been sitting in this codebase's own audits for weeks, and it is the hard precondition
every later phase (real 5-CORE shadow parity, any future Java vote authority, the full Quant
Ensemble) depends on. It requires zero ChiefTrader/RiskEngine/OMS changes, is fully reversible via
existing flags, and produces real, measurable evidence (a fresh
`QUANT_CORE_PARITY_DIVERGENCE`/`QUANT_CORE_REGIME_PARITY_DIVERGENCE` count, before vs. after) rather
than another round of synthetic-fixture tests.

Do not start Phase 4 (`QuantEnsembleDecision`) or any promotion-funnel work (§9) before Phase 1's
real-bar evidence exists — that would repeat the exact "implemented but not wired, tested only
against synthetic fixtures" pattern the 2026-09-09 Forensic Audit already found across the current
5 CORE Java strategies.
