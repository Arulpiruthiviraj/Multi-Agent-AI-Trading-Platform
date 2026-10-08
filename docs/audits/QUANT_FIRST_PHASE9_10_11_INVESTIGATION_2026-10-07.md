# Quant-First Phases 9/10/11 — Read-Only Code Investigation
**Date:** 2026-10-07
**Repo:** `~/workspace/argus-trading`, branch `feat/quant-first-decision-architecture`, HEAD `008a98f`
**Scope:** Three audit questions for the Quant-First Decision Architecture (ChiefTraderAgent as policy router; deterministic QuantExecutionPolicy for validated quant strategies; AI failure must not block validated quant; PAPER-first, LIVE_NO_GO; Java 26 Engine Authority — no new quant math in TypeScript). No files modified.

---

## Q1 — Legacy QUANT_INDEPENDENT tier (mission Phase 9)

### (a) Exact conditions under which the QUANT_INDEPENDENT tier fires today

The tier fires inside `ChiefTraderAgent.evaluateConsensusSerialized()`'s approval ladder. Eligibility is computed at `src/server/services/ChiefTraderAgent.ts:925-928`:

```ts
const quantIndependentQualification = evidence.find(
  (e: any) => e.agent === 'QuantEngine' && e.side === result.side && e.quantDetail?.internalEnsemble?.qualifiesAsIndependent === true,
) as any;
const quantIndependentEligible = isQuantIndependentQualificationEnabled() && !!quantIndependentQualification;
```

and the approval branch is at `ChiefTraderAgent.ts:985-989` (`else if (!enoughIndependentVoices && quantIndependentEligible)`). **All** of the following must hold:

1. **Flag on.** `isQuantIndependentQualificationEnabled()` is true (`ChiefTraderAgent.ts:928`; defined `src/server/config/tradingSafety.ts:962-964`, env var `ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED=true`). Default is off (`.env.example`); no `.env` file exists in this checkout, so it is off here by default. Explicit 2026-09-09 operator override (see `tradingSafety.ts:95-111` doc comment and `AGENTS.md` Java 26 Engine Authority § "QuantEngine internal-ensemble independent qualification").
2. **A qualifying QuantEngine idea is in evidence.** An evidence entry with `agent === 'QuantEngine'`, `side === result.side` (the consensus-winning side), and `quantDetail.internalEnsemble.qualifiesAsIndependent === true` (`ChiefTraderAgent.ts:925-927`).
3. **The internal ensemble itself cleared its bar** (`src/server/quant/internalQuantEnsemble.ts`, `computeInternalEnsembleQualification()`): the correlation-adjusted ensemble's resolved side equals the idea's side (`rawSide === ideaSide`; a mismatch returns `qualifiesAsIndependent: false`, `sideMismatch: true`), `familyCount >= tradingSafety.minQuantIndependentFamilies` (3) distinct strategy families, and `effectiveIndependentCount >= tradingSafety.minQuantIndependentEffectiveCount` (2.5), computed by `QuantEnsembleEngine.java`. Fail-closed: returns `null` on Java bridge failure or zero votes, and the caller must treat `null` as "not qualified" (internalQuantEnsemble.ts doc, ~line 168).
4. **STRONG confidence bar still cleared.** `result.side !== 'HOLD'` and `result.confidence > CONSENSUS_APPROVAL_THRESHOLD` (0.75) — the tier is reached only on the STRONG-confidence path (`ChiefTraderAgent.ts:948`); the MODERATE-tier branch is only evaluated when STRONG already failed, so QUANT_INDEPENDENT never fires via MODERATE.
5. **Single-voice case.** `!enoughIndependentVoices` — fewer than `MIN_INDEPENDENT_AGREEING_AGENTS` (2) independent evidence groups agreed (`ChiefTraderAgent.ts:985`). With ≥2 groups the plain STRONG branch approves instead; with 1 group and no qualification, it is a NO_TRADE (`:977-978`).
6. **No hard vetoes.** No ConsensusDebate HOLD (`:979`), no bear-agent HOLD (`:981`), no AI contradiction (`:983`) — these veto branches are evaluated *before* the QUANT_INDEPENDENT branch.
7. **Not a risk-exit round.** The risk-exit branch (`:931-943`) takes precedence and approves unconditionally.

Effect: `decisionTier = 'QUANT_INDEPENDENT'` (`:987`), approval emitted via the normal `emitChiefApproval` → CHIEF_APPROVED_IDEA path. **The tier is consensus-internal labeling only**: `decisionTier` is never read by RiskEngine or OMS (verified by repo-wide grep — no consumer outside ChiefTraderAgent, consensusExplanation types, and observability). Downstream sees an approval identical to a STRONG one.

### (b) Can it fire for a UNTESTED/SHADOW/CANDIDATE strategy? Does it consult StrategyEmissionEligibility?

**Yes, it can — and no, it never consults StrategyEmissionEligibility.** Verified:

- `computeInternalEnsembleQualification()` (`internalQuantEnsemble.ts`) imports only `quantCoreBridge`, `tradingSafety`, strategy/family types, and observability. It has **zero imports from `StrategyEmissionEligibility`** and no lifecycle lookup of any kind. Its vote filter is: `side` is BUY/SELL, `familyForStrategyId(e.strategy)` returns a family, plus the 10 Java RESEARCH engine results (`JAVA_RESEARCH_STRATEGY_IDS`).
- The caller passes the **raw** evaluation list: `computeInternalEnsembleQualification(symbol, bars, strategyEvaluations, idea.side)` (`src/server/services/QuantSignalAgent.ts:732`), where `strategyEvaluations = evaluateAll(strategyContext)` (`QuantSignalAgent.ts:410`) — unfiltered. The lifecycle filter `filterQuarantinedStrategies` (from `StrategyEmissionEligibility`) is applied only to the top-1 *pick* pool (`emissionEligibleEvaluations`, `QuantSignalAgent.ts:487`), never to the ensemble input.
- Per `src/server/quant/strategies/StrategyEmissionEligibility.ts`'s own lifecycle doc (lines 14-37): only RETIRED and DEGRADED remove real-selection exposure. UNTESTED (the default when no row exists), SHADOW, CANDIDATE, ACTIVE_EXPLORATION, VALIDATED, CHAMPION are all *eligible*. Since the ensemble input is not lifecycle-filtered at all, even RETIRED/DEGRADED (quarantined) strategies' votes still count toward the family/effective-count bar.

So a QUANT_INDEPENDENT approval today can rest on ensemble votes from strategies whose lifecycle is UNTESTED/SHADOW/CANDIDATE — or even quarantined ones. The new QuantExecutionPolicy's "validated quant strategies" bar (VALIDATED/CHAMPION) is strictly stronger than what the legacy tier enforces (nothing).

### (c) Two competing AI-independent mechanisms? Recommendation

**Yes — keeping both creates two distinct AI-independent approval mechanisms with different validation standards:**

| | Legacy QUANT_INDEPENDENT | New QuantExecutionPolicy (planned) |
|---|---|---|
| Lane | Consensus-path-internal fallback | Deterministic policy lane bypassing consensus |
| AI involvement | Mechanism is LLM-free (deterministic TS/Java math); debate may still have run/vetoed earlier in `reviewIdea` | Deterministic by design |
| What it substitutes | Only the *second independent voice*; STRONG confidence (0.75), calibration, all hard vetoes, RiskEngine/OMS unchanged | Consensus entirely (for validated strategies) |
| Strategy validation bar | **None** — ensemble votes include UNTESTED/SHADOW/CANDIDATE and even quarantined strategies (see (b)) | "Validated quant strategies" (VALIDATED/CHAMPION lifecycle) |

The overlap is real: a QuantEngine idea could be approved either way, under two different definitions of "quant authority" — one of them weaker on lifecycle and invisible to the router (it lives inside consensus math, not in a lane assignment).

**Recommendation: (C) migrate into QuantExecutionPolicy.** Justification:

- The legacy mechanism's genuine asset is the correlation-adjusted qualification math (`minQuantIndependentFamilies` / `minQuantIndependentEffectiveCount` via `QuantEnsembleEngine.java`) — deterministic, tested, and reusable verbatim by the router with no new quant math (satisfies Java 26 Engine Authority). Migration preserves it.
- Migration *forces* the lifecycle fix from (b): the policy lane must restrict ensemble inputs to VALIDATED/CHAMPION (or at minimum exclude RETIRED/DEGRADED) strategies — the exact gap the legacy tier leaves open. Keeping the branch as-is ((A)) preserves that gap; deprecating ((B)) leaves a live-but-rotting trading-path branch; removing outright ((D)) destroys the family/effective-count qualification evidence before the new lane has proven it doesn't need it.
- The migration must be atomic: remove the consensus-internal branch (`ChiefTraderAgent.ts:925-928`, `985-989`, and the `QUANT_INDEPENDENT` decisionTier member at `:895`) in the *same* change that wires the policy lane, so the two mechanisms never coexist as competing authorities. `decisionTier` typing in `consensusExplanation.ts:23` should be updated accordingly.

Caveat: the legacy tier also still requires STRONG consensus confidence and honors debate/bear/AI vetoes. If the policy lane is meant to be a *pure* deterministic bypass, the router implementer must consciously decide whether those vetoes carry over — the current code gives no guidance, so this is a design decision to record, not an inference.

---

## Q2 — Fast Lane (mission Phase 10)

### (a) Does any Fast Lane idea reach ChiefTrader today, and with what agent name/fields?

**No. Zero Fast Lane ideas reach ChiefTrader today.** Verified end to end:

- `src/server/fastlane/fastCanonicalAdapter.ts` header (lines 1-10): "shadow/research only, NO live emission. This module does NOT call `eventBus.emitTradeIdea()` anywhere — that live wiring is deliberately left for a later, separately-authorized phase."
- `src/server/fastlane/fastCanonicalDedup.ts`: same — "Still never calls emitTradeIdea."
- `src/server/fastlane/fastLaneEvaluator.ts` header (lines 1-17): "Deliberately NOT wired to emitTradeIdea/ChiefTrader in this phase."
- `processFastEvaluationForCanonicalIdea()` has **zero production callers** (repo-wide grep) — only its own definition and the two test files (`fastCanonicalAdapter.test.ts`, `fastCanonicalDedup.test.ts`).
- `FastLaneManager.ts` contains no `emitTradeIdea`/`emit(` calls at all; all methods no-op unless `FAST_OPPORTUNITY_LANE_ENABLED=true` (which is also fail-closed against `TRADING_MODE=LIVE`, `fastLaneConfig.ts:21`).
- `fastLaneEvaluator.evaluateFastCandidate()` calls `quantSignalAgent.evaluateSymbol()` (`QuantSignalAgent.ts:312`), which returns the evaluation bundle **without emitting** — the only `emitTradeIdea` in QuantSignalAgent is in the live `runCycle()` (`:787`), agent `'QuantEngine'`. So Fast Lane evaluation cannot indirectly emit either.

The *shape* a future emission would carry (per `CanonicalIdeaFromFastLane`, `fastCanonicalAdapter.ts:22-53`): agent name `'FastOpportunityLane'`; fields `traceId` (`fastlane_${result.id}`), `symbol`, `side`, `confidence` (raw strategy confidence — "no Fast Lane bonus"), `reasoning`, `strategy` (**note: `strategy`, not `strategyId`** — the original strategy identity preserved verbatim, e.g. `'MOMENTUM_BREAKOUT'`), `timeframe: 'intraday'`, `currentPrice?`, and `evidence: { origin: 'FAST_OPPORTUNITY_LANE', candidateId, fastEvaluationId, detectionSource, catalyst, detectedAt, dataAsOf, evaluatedAt, marketDataType, validUntil, evidenceFingerprint }`. No `quantDetail`, no `strategyId`.

### (b) If a Fast Lane idea carried a strategyId, could it gain quant authority under a naive origin-based router?

**Yes — and that is exactly the hazard.** Under a naive router rule like `evidence.origin === 'FAST_OPPORTUNITY_LANE' && idea.strategyId → quant-authority lane`, a Fast Lane idea would get deterministic approval without consensus despite four verified problems:

1. **It is the same evidence as QuantEngine's, not a second opinion.** `evidenceIndependence.ts:66` registers `'FastOpportunityLane'` in `STRUCTURALLY_SAME_AS_CORE_QUANT_ENSEMBLE` alongside `'QuantEngine'`/`'JavaCoreEnsemble'` (group `CORE_QUANT_ENSEMBLE_EVIDENCE_GROUP`), with the explicit rationale: "fastLaneEvaluator.ts calls the identical `quantSignalAgent.evaluateSymbol()` … Fast Lane is a latency/transport difference … never an independent signal." Granting it a policy lane would approve the *same market fact twice* through two lanes.
2. **The strategy identity would be unverified.** `fastLaneEvaluator` picks `bestStrategyIdea()` from `evaluateSymbol()`'s **raw** `strategyEvaluations` (`QuantSignalAgent.ts:410` → returned at `:909`) — which never passes `filterQuarantinedStrategies` (`:487`) or the live EV/R:R gates. The carried strategyId could therefore be UNTESTED/SHADOW/CANDIDATE — or even RETIRED/DEGRADED (quarantined), which the live path deliberately excludes from its own pick.
3. **No quant authority payload.** The canonical shape carries no `quantDetail` (no `internalEnsemble`, no `strategyEvaluation`, no EV evidence). A router that required those fields would fail closed; a naive origin+strategyId check would not.
4. **Origin tags are self-asserted, not verified.** `evidence.origin` is set by the emitter (`fastCanonicalAdapter.ts:125`); nothing in the spine validates it against a registry. Any producer could stamp `FAST_OPPORTUNITY_LANE`.

### (c) Recommendation: the origin tag Fast Lane emitters must use, and why it must resolve to REQUIRES_CONSENSUS

Keep the existing tag verbatim — `evidence: { origin: 'FAST_OPPORTUNITY_LANE' }` (`fastCanonicalAdapter.ts:125`) — but in the router's origin registry it must map to **REQUIRES_CONSENSUS, never to a quant-authority/policy lane**. Reasons:

- Fast Lane is, by its own documented design, "a transport/latency difference, never a new alpha source" (`fastCanonicalAdapter.ts:17-18`). Routing identical evidence into a deterministic lane would create a second, less-gated order path for the same underlying calculation — violating the standing invariant that opportunity discovery and position intelligence "feed the same protected spine" and "never become a second order path" (`AGENTS.md`).
- The consensus path is the *only* routing where the existing independence protection actually applies: `resolveIndependentEvidenceGroup('FastOpportunityLane')` already collapses it into QuantEngine's group, so it can never manufacture a second independent voice, and the 0.75 threshold, hard vetoes, and RiskEngine apply unchanged.
- If a future separately-authorized phase wires live emission, it must arrive as agent `'FastOpportunityLane'` via `TRADE_IDEA_GENERATED` into consensus — never the policy lane.
- Router design rule this implies: quant authority must be keyed on **verified strategy lifecycle (VALIDATED/CHAMPION via StrategyEmissionEligibility) plus presence of real `quantDetail` evidence** — fail closed when absent — never on a bare `strategyId` string or an `origin` tag.

---

## Q3 — Protective exits (mission Phase 11)

### (a) Agent name and fields of PortfolioMonitor exit ideas

- **Agent name:** `agentWeightConfig.riskExitAgent` = **`"PortfolioManager"`** (`config/agentWeights.json:13`). Note the naming mismatch: the emitting module is `PortfolioMonitor.ts`; the agent name on the wire is `PortfolioManager`.
- **Predicate** (`ChiefTraderAgent.ts:344-346`): `isRiskExit(idea) = idea.agent === RISK_EXIT_AGENT && idea.side === 'SELL'`.
- **Fields** (`PortfolioMonitor.ts:451-475`, `emitRiskExit` → `eventBus.emitTradeIdea` at `:468`): `{ traceId: randomUUID(), symbol, side: 'SELL', confidence, currentPrice, reasoning, agent: 'PortfolioManager' }`. **No `strategyId`, no `quantDetail`, no `timeframe`.** (Zero occurrences of `strategyId` in `emitRiskExit`'s body — verified.) Confidence comes from `tradingSafety.quantStopExitConfidence` / `quantExitIdeaConfidence` / `thesisInvalidationExitConfidence` / ExitIntelligence's own confidence. Reasoning always carries an `EXIT_CODE=` prefix.
- **All exit triggers funnel through this one function**: EOD flatten (`:275-290`), campaign ATR Target-1 / breakeven stop (`:307-327`), quant-strategy target/stop from the opening trade's `quantTargetPrice`/`quantStopPrice` (`:344-364`), thesis invalidation via `evaluateLiveThesis` (`:365-375`), generic take-profit/trailing-stop (`:377-392`), and ExitIntelligence `TAKE_PROFIT`/`EXIT`/`EMERGENCY_EXIT` (`:656-664`). One exit shape, one agent name.

### (b) Full path of a risk-exit idea: emitTradeIdea → ChiefTrader → RiskEngine. Any LLM/debate/consensus math?

Traced end to end — **no LLM/AI provider, no debate, and no consensus math gates the exit anywhere**:

1. `PortfolioMonitor.emitRiskExit` → `eventBus.emitTradeIdea` (`PortfolioMonitor.ts:468`) → `gateTradeIdea` (`tradeIdeaContract.ts:55` — symbol/price validation only, no AI) → `TRADE_IDEA_GENERATED`.
2. `ChiefTraderAgent` constructor handler → `reviewIdea`:
   - `ChiefTraderAgent.ts:521`: `if (!isLiveIdeaGenerationEnabled() && !this.isRiskExit(idea)) return;` — risk exits are **exempt from the Autobot-off drop** ("capital preservation is not an entry vote").
   - `ChiefTraderAgent.ts:530-533`: `if (this.isRiskExit(idea)) { this.scheduleConsensusEvaluation(idea.symbol, idea.traceId, true); return; }` — returns **before** the debate/AI block (which starts at `:535`). No `AIRouter` call, no multi-model debate, no bull/bear research, no learned-rules/Java-context prompt. The exit never touches an LLM.
3. `evaluateConsensus` → per-symbol promise-chain mutex → `evaluateConsensusSerialized`:
   - `:837-840`: `if (this.debatePending(symbol)) return;` — a risk exit arriving while an *unrelated* debate is in flight is **deferred, not dropped**; the debate's output is never consulted for the exit.
   - `:848`: risk-exit ideas filtered; `:931-943`: `approved = true; approvedSide = 'SELL'; approvedConfidence = exitIdea.confidence;` — **unconditional**. `EvidenceAggregator.aggregate()` still runs (`:851`) for telemetry/`CHIEF_CONSENSUS_COMPLETED`, but its result cannot veto the exit; the hard-veto branches (debate/bear/AI-contradiction, `:979-984`) live in the `else` branch and don't apply.
4. `emitChiefApproval` (`:1263`) → `CHIEF_APPROVED_IDEA` → `RiskAgent.assessRisk` (`RiskAgent.ts:27-32`, thin forwarder) → `riskEngine.evaluateRisk()` (25 deterministic gates, no LLM) → `RISK_ASSESSMENT_COMPLETED` → OMS → `BrokerManager.placeOrder`.

### (c) Exit-like emitters that are NOT risk exits

**Explicit non-finding first:** the question's premise ("quant thesis invalidation, trailing-stop ideas that go through normal consensus") does **not** match current code. PortfolioMonitor's thesis invalidation (`PortfolioMonitor.ts:365-375`) and trailing-stop (`:343-351`) both emit via `emitRiskExit` → agent `'PortfolioManager'` → they **are** risk exits. ExitIntelligence's `PARTIAL_TAKE_PROFIT`/`TRAIL` decisions are recorded as telemetry only, never emitted (`PortfolioMonitor.ts:611-624` — because RiskEngine's SELL sizing clamps to full quantity, a partial exit cannot be expressed safely today).

Exit-like-but-not-risk-exit emitters, and required router treatment:

1. **SELL-side directional entry ideas through normal consensus** — these are strategy-direction votes (including potential shorts), not protective exits, and the router must preserve their current consensus routing (quant lane only if the strategy is validated): `TechnicalAgent` SELL signals (momentum/mean-reversion/overbought, `TechnicalAgent.ts:282/304/321`), `QuantEngine` strategy SELL ideas with `strategyId` (`QuantSignalAgent.ts:787`), `NewsAgent` sell-the-news (`newsFinBertPulse.ts:57-68`), `JavaCoreEnsembleVoteService.ts:113`, `JavaQuantAdvisoryService.ts:256`, `QuantCoreBridge.ts:1404` (agent `QuantCoreJava`), `InstitutionalStrategyVoteService.ts:258`, `TradePlanBuilder.ts:388`, `KronosForecastAgent.ts:253`, Macro/Fundamental SELLs. None may be reclassified as risk exits by side alone — side `SELL` ≠ exit; the discriminator is `agent === 'PortfolioManager'`, exactly as `isRiskExit` defines it.
2. **`PipelineFlatten` / `PortfolioRebalance`** (`PipelineFlatten.ts:20-56`): emit `CHIEF_APPROVED_IDEA` directly with agent `'ManualOverride'`, bypassing ChiefTrader consensus entirely (still through RiskEngine/OMS). They never emit `TRADE_IDEA_GENERATED`, so the new policy router — which sits on the idea→ChiefTrader path — has no jurisdiction over them. Router must leave this path untouched.

### (d) Router ordering: risk-exit check before authorization — confirmed

**Recommended ordering in the new policy router (and preserved in `ChiefTraderAgent.reviewIdea`):**

1. **`isRiskExit(idea)` check FIRST** — before strategy authorization, before any LLM-availability-gated lane, before the quant/consensus lane split. On match: today's behavior (force-immediate evaluation, no debate, no AI, unconditional SELL approval into RiskEngine).
2. Everything else → strategy authorization / lane assignment.

Why, grounded in today's code:

- **Risk exits carry no strategyId/quantDetail** (`PortfolioMonitor.ts:451-475` — verified zero `strategyId`). A strategy-authorization gate applied before the risk-exit check would fail or misroute them — there is no strategy to authorize; the idea is identified by `agent + side`, not by strategy identity.
- **Capital preservation must not depend on LLM availability.** Today's design already skips the debate for risk exits (`ChiefTraderAgent.ts:530-533`) and skips the debate entirely when no AI provider is routable. Routing an exit through an LLM-gated lane would reintroduce the exact failure mode those mechanisms closed — a stop-loss waiting on an API key.
- **Autobot-off exemption must survive.** With Autobot off, entry ideas are dropped but risk exits still flow (`ChiefTraderAgent.ts:521`). If the router's first check were an authorization/LLM gate rather than `isRiskExit`, an operator stopping entries would silently also stop stop-losses.
- **Preserve the deferral, not a drop.** Keep `evaluateConsensusSerialized`'s `:837` behavior: a risk exit arriving mid-debate waits for the debate to end, then evaluates — the router must not convert that wait into a rejection.

In short: under the new router, a protective CLOSE_LONG-style exit must never require strategy authorization (it has no strategy identity to authorize) nor LLM availability (no AIRouter call exists on its path today). The risk-exit check is the router's highest-precedence rule, exactly as it is the earliest branch in `reviewIdea` today.

---

## Recommendations for the router implementer

1. **Lane precedence (highest first):** (1) `isRiskExit(idea)` (`agent === 'PortfolioManager' && side === 'SELL'`) → immediate risk-exit lane, no debate, no AI, no strategy auth, Autobot-off-exempt; (2) validated-quant policy lane — keyed on **verified** lifecycle (`VALIDATED`/`CHAMPION` via `StrategyEmissionEligibility`) **plus** presence of real `quantDetail` evidence, fail closed when absent — never on a bare `strategyId` string or an `evidence.origin` tag; (3) everything else → `REQUIRES_CONSENSUS`.
2. **`FAST_OPPORTUNITY_LANE` origin → `REQUIRES_CONSENSUS`, permanently.** Fast Lane is the same underlying computation as QuantEngine's (already grouped in `evidenceIndependence.ts:66`); a policy lane for it would double-count one market fact through two lanes.
3. **Migrate, don't duplicate, QUANT_INDEPENDENT** (option (C) from Q1): move the family/effective-count qualification math into the policy lane with lifecycle-gated inputs, and remove the consensus-internal branch (`ChiefTraderAgent.ts:925-928`, `985-989`, `QUANT_INDEPENDENT` at `:895`, `consensusExplanation.ts:23`) in the same change. Decide explicitly whether debate/bear/AI vetoes carry into the policy lane — current code gives no guidance.
4. **Do not reclassify by side.** `side === 'SELL'` alone never identifies an exit (short-direction entry ideas exist across agents). The exit discriminator stays `agent === 'PortfolioManager'`; `PipelineFlatten`'s `ManualOverride` `CHIEF_APPROVED_IDEA` path stays outside router scope.
5. **Keep today's two fail-closed properties:** risk exits never touch `AIRouter` (no new LLM dependency on the exit path), and a risk exit deferred by an in-flight debate (`ChiefTraderAgent.ts:837`) waits — it is never dropped or vetoed by consensus math.

*Ambiguities / limits:* (i) No `.env` file exists in this checkout, so `ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED`'s live deployment value could not be confirmed here — `AGENTS.md` asserts it is on in the deployment's `.env`; default is off. (ii) Whether the policy lane should inherit the legacy tier's debate/bear/AI vetoes is a design decision the code does not answer. (iii) The `strategy` vs `strategyId` field inconsistency between Fast Lane's canonical shape and QuantEngine's live ideas should be normalized before any router keys on it.
