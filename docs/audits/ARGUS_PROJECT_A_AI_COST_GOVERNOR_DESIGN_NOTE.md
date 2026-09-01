# ARGUS — Project A: AI Cost Governor — Design Note

**Status: DESIGN ONLY, delivered 2026-09-02. Zero files changed to produce this — no `AIRouter.ts`,
no schema, no config, no runtime behavior.** Everything below is either **PROVEN** (verified in-repo
by direct reads this session), **INFERRED** (a reasonable conclusion from that evidence), or
**RECOMMENDED** (a design choice offered for review — not authorized by this document alone).

Goal restated exactly as given: not "use the cheapest model," but **minimum inference cost subject to
acceptable validated quality, latency, and safety** — and never let the governor touch the protected
decision spine (ChiefTrader, RiskEngine, OMS, broker safety, consensus threshold, any risk gate,
`LIVE_ARM`, trading state).

---

## 0. Existing-infrastructure audit (PROVEN — read before proposing anything)

This is the mandatory first step: Project A must not duplicate what already exists. Three real,
already-working pieces of infrastructure change this design substantially from a from-scratch build.

### 0.1 AIRouter call paths, timeout, retry, concurrency

- **`routeTask(agentType, prompt, traceId)`** (`src/server/ai/AIRouter.ts`) — single-model routing used
  by News/Fundamental/Macro/ReflectionEngine/Bull/Bear/Explainability/QuantContradictionAnalyzer.
  Iterates `availableProviders` **sequentially** (a `for` loop, not parallel) — provider 2 is only
  tried after provider 1's whole attempt (including its own fallback-model chain) has failed. This
  matters for retry-amplification analysis in §Failure modes.
- **`routeConsensus(agentType, prompt, traceId)`** — used only by ChiefTrader's debate
  (`'ConsensusDebate'`) and Bull/Bear. Calls **multiple providers in parallel**
  (`selectConsensusProviders()`, capped at `tradingSafety.consensusMaxProviders`) and aggregates a
  weighted verdict — structurally an ensemble, not a single-model escalation ladder. **Out of scope
  for Phase A4–A6** (see §Rollout) — the governor's tiering concept does not map cleanly onto an
  ensemble that already queries several providers every time by design.
- **Timeout split (shipped this session, 2026-09-02):** `resolveHardCapMs(providerRow)` — local Ollama
  calls get `ollamaHardTimeoutMs` (25s), every remote/paid provider keeps `researchTimeoutMs` (8s).
  Per-route `timeoutMs` (the inner per-model-attempt budget, relevant when `fallbackModels` retries
  same-provider Ollama models) raised from 8000→20000 for the affected routes. The governor must
  compose with this, not replace it — its own escalation tiers sit *above* this existing timeout
  mechanic, never inside it.
- **Fallback:** same-provider model retry only (`fallbackModels`, Ollama-only, e.g.
  fingpt→plutus→llama3.2), each attempt getting its own fresh `AbortController` timer
  (`OpenAICompatibleProvider.ts:186-213`) — a real, already-fixed bug (attempts used to share one
  deadline and fail instantly in sequence).
- **Provider health / cooldown:** `filterRoutableProviders()`, `skipProviderTemporarily()`,
  `noteProviderSkipFromError()`, `disableProviderForAuthFailure()` — real, working cooldown machinery
  keyed by error classification (`ACCOUNT_SUSPENDED`/`QUOTA_EXCEEDED`/`RATE_LIMITED`/auth-failure, each
  with its own cooldown constant). The governor must call into this exactly as `routeTask` already
  does — never bypass it to "try a skipped provider anyway because the governor wants to."

### 0.2 Heavy-model mutex

`HeavyModelMutex.run(model, fn)` (`src/server/ai/HeavyModelMutex.ts:26-44`) — gates only models listed
in `aiModels.heavyModels` (`qwen2.5:14b`, `deepseek-r1:14b`) to `maxConcurrentHeavyModels` (1)
concurrent, queue depth `maxQueueDepth` (10). **On overflow it throws** a real `Error` — it does not
return a fake HOLD or block indefinitely; the caller's existing fail-closed handling is expected to
catch it. Non-heavy models pay zero cost here. **Design implication:** this exact
throw-on-overflow/queue contract is the direct precedent to reuse for any governor-side
concurrency/rate-limiting need (§Failure modes, escalation storms), rather than inventing a second
mutex primitive.

### 0.3 Token/cost/latency instrumentation — already fully present

`ai_usage` and `ai_calls` tables (`src/server/db/schema.ts`) already record, per call: `provider`,
`model`, `agent`, `promptTokens`/`completionTokens`, `latency`, `cost` (via each provider's own
`estimateCost()` — real per-provider pricing, `$0` for Ollama, confirmed live this session: Mistral
alone shows 13,216 requests / $7.30 real cumulative cost in `ai_providers.cost`). **Section E (cost
accounting) requires zero new instrumentation** — it's 100% aggregation over data that already exists.

### 0.4 Confidence calibration — a real, working mechanism already exists (the single most important finding)

This directly changes the shape of Project A. Two real pieces already exist:

- **`agent_confidence_calibration`** table (`schema.ts:492-509`) — Beta-Binomial posterior calibration
  **per (agentName, stated-confidence bucket)**, written only by `ReflectionEngine` from real
  `prediction_outcomes`. Its own header states the exact problem this design must not re-solve from
  scratch: *"NewsAgent's 80–90%-stated bucket resolving to ~34% real accuracy — a calibration failure
  a flat per-agent weight cannot see or correct."* This is **already** "don't trust self-reported
  confidence" — just at the (agent, bucket) granularity, not yet (agent, provider, bucket).
- **`calibrationMaturity.ts`** — read-only report over the above, using a real Wilson lower bound
  (`effectiveInterval.lower`, computed via `CalibrationCandidateBuilder.ts`'s autocorrelation-corrected
  effective sample size). Maturity ladder: `UNVALIDATED` (zero graded outcomes) → `LEARNING`
  (effectiveN below `championChallengerMinSampleSize`) → `CALIBRATED` (enough sample, but Wilson lower
  bound ≤ `moderateCalibrationTrustMinWilsonLowerBound`, config value **0.5**) → `TRUSTED` (Wilson
  lower bound above that floor). **As of the last forensic pass, all 12 live champions sit below 0.5
  (max 0.471) — nothing is `TRUSTED` today.** This is a real, load-bearing caution for this design: the
  existing calibration infrastructure has not yet certified *anything* as trustworthy, at agent
  granularity alone. A governor escalation policy leaning on calibrated quality needs to expect thin,
  unproven evidence for a long time, especially once a *provider* dimension is added on top (see §C).
- **`ModerateTierEvaluator.ts`** is the live-gating twin (`evaluateModerateTierEligibility()`, gated by
  `CONSENSUS_MODERATE_TIER_ENABLED`, default off) — calls the exact same
  `isAgentBucketCalibrationTrustworthy()` function `calibrationMaturity.ts` also calls, so the report
  can never disagree with what a live gate would decide. **Section D's calibration mechanism should be
  the exact same pattern, one dimension wider** (agent × provider × bucket, not just agent × bucket),
  not a new statistical approach.

### 0.5 `agent_performance_stats` / ReflectionEngine

`currentWeight` (`schema.ts:464-487`) is a flat per-agent scalar, computed from
**effective** (autocorrelation-cluster-corrected) win rate via `agentWeightUpdate()` /
`boundedStep()` (`agentWeightPolicy.ts`) — never snaps instantly, moves at most
`maxWeightAdjustmentPerCycle` per cycle. Gated on `evidenceStatus` (`INSUFFICIENT_EVIDENCE` /
`LEARNING_ELIGIBLE`), itself gated on `tradingSafety.minSampleSizeForTrust` applied to the *effective*
N. **Crucially: `agent_predictions` rows already carry `provider`, `aiCallId`, and `latencyMs`
columns** (`ReflectionEngine.logPrediction()` already writes them from `idea.provider`/`idea.aiCallId`/
`idea.latencyMs`) — the raw per-provider dimension already exists in the data; only the aggregation is
missing.

### 0.6 `ModelPerformanceTracker.ts` — a false lead, but an important precedent

This file **already exists** and is worth checking (and was checked) precisely because its name
suggests it might already do what §C needs. It does not — it segments Java quant SHADOW predictions by
market **regime**, not by AI provider. But its own header states the exact right philosophy to copy for
this design: *"reusing the EXISTING, already-running agent_predictions / prediction_outcomes /
PredictionOutcomeEvaluator / ReflectionEngine pipeline... rather than building a second, parallel
prediction ledger."* Its `getRegimeSegmentedStats()` function is a direct structural template —
**§C's provider-quality ledger should be `getProviderSegmentedStats(agentName)`, grouping the exact
same `agent_predictions` × `prediction_outcomes` join by the already-present `provider` column instead
of `regime`.** This means **no new write-side table is required for the core quality signal** — a real
simplification versus a from-scratch `provider_task_performance` table.

### 0.7 AIOutputValidator — the reusable validation primitive layer

`src/server/ai/AIOutputValidator.ts` — `coerceEnum`, `clampScore`, `normalizeConfidence01` (handles a
0–100-scale answer, not just clamps it to 1.0), `coerceString`/`coerceStringArray`,
`looksLikeListedTicker`, `rejectIfPriceDisagrees`. Already used by FundamentalAgent, MacroAgent,
NewsScoringEngine, QuantContradictionAnalyzer. **If the governor itself ever needs to parse a
structured LLM response (e.g. a lightweight classifier call deciding "is this routine"), it must reuse
these primitives, not write new ad hoc validation** — this is the established single place in this
codebase for "AI proposes, deterministic code coerces."

### 0.8 Feature-flag convention

One canonical primitive: `isRuntimeFlagEnabled(key: string): boolean`
(`src/server/config/effectiveRuntimeConfig.ts:147-151`), precedence DB override → `process.env` →
catalog default, **read live on every call**, not memoized at boot. Preferred pattern (Variant A, used
by `isOpportunityLoopEnabled()`, `isBroadUniverseEnabled()`, `isConsensusModerateTierEnabled()`): the
env-var *name* lives as a string field inside a typed config object, wrapped by a dedicated
`isXxxEnabled()` helper. **§K follows this exactly.**

### 0.9 Shadow mode — a real, working pattern already exists (reuse verbatim)

"Evidence-Aware Consensus" shadow mode (`EvidenceAwareVote.ts`, `ConsensusModelComparison.ts`,
call site `ChiefTraderAgent.ts:839-856`): computes a parallel alternative decision from the *same*
evidence the real decision already gathered, logs agreement/divergence via
`structuredLogger.info('consensus_model_comparison', {...})` into the **existing** `observability_events`
table (event type `CONSENSUS_MODEL_COMPARISON`) — **no new table** — wrapped in `try/catch` so a shadow
bug can never affect the real decision, surfaced via a read-only `GET /consensus/shadow-comparison`
route and `./argus consensus-shadow` CLI command. The identical idiom is reused by
`QuantCoreBridge.ts`'s parity comparator (`QUANT_CORE_PARITY_DIVERGENCE` events, `GET /quant-core/parity`).
**§J follows this exact idiom byte-for-byte** — new `eventType`, no new table, new read-only route +
CLI command.

---

## A. AI request classification

**Recommendation: reuse `agentType` as the primary classification key — do not invent a separate
"task" taxonomy.** Every current `routeTask()` caller already has exactly one task shape per agent
(FundamentalAgent always does "assess this symbol's fundamentals," never a second distinct task type).
Inventing a finer-grained task dimension now would be exactly the premature abstraction CLAUDE.md
already warns against — build it only if a single `agentType` is later found to span genuinely
different-difficulty requests.

## B. Task-specific escalation policies

**Not** a global "escalate if confidence < 0.7." A new config file, `config/aiCostGovernor.json`,
matching `config/aiModels.json`'s existing shape, with one policy object per `agentType`:

```json
{
  "aiCostGovernorEnabledEnvVar": "AI_COST_GOVERNOR_ENABLED",
  "policies": {
    "ReflectionEngine": { "tiers": ["LOCAL"], "qualityFloor": 0.0 },
    "ExplainabilityAgent": { "tiers": ["LOCAL"], "qualityFloor": 0.0 },
    "NewsAgent": { "tiers": ["LOCAL"], "qualityFloor": 0.55 },
    "FundamentalAgent": { "tiers": ["LOCAL", "ECONOMICAL"], "qualityFloor": 0.55 },
    "MacroAgent": { "tiers": ["LOCAL", "ECONOMICAL"], "qualityFloor": 0.55 },
    "BullResearcher": { "tiers": ["LOCAL", "ECONOMICAL"], "qualityFloor": 0.55 },
    "BearResearcher": { "tiers": ["LOCAL", "ECONOMICAL"], "qualityFloor": 0.55 },
    "QuantContradictionAnalyzer": { "tiers": ["LOCAL", "ECONOMICAL"], "qualityFloor": 0.55 }
  }
}
```

`ConsensusDebate` (ChiefTrader) is **deliberately absent** — its ensemble path is out of scope for
Phase A4–A6 per §0.1. `qualityFloor` is the minimum **calibrated** (never raw self-reported) quality
required to accept a tier's answer before escalating — see §D. An agent with `tiers: ["LOCAL"]` can
never escalate regardless of quality signal, matching the table you specified (Reflection/Explainability
stay local-only).

## C. Provider/model quality ledger

**No new write-side table.** Per §0.6, add one new read aggregation function,
`getProviderSegmentedStats(agentName)` in a new file `src/server/services/ProviderPerformanceTracker.ts`
(sibling to `ModelPerformanceTracker.ts`, same join pattern), grouping the existing
`agent_predictions` (already carrying `provider`) × `prediction_outcomes` join by `provider` instead of
`regime`. Output shape:

```ts
interface ProviderBucketStats {
  provider: string;      // matches ai_providers.id / 'ollama' local sentinel
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturn: number;
  effectiveN: number;    // reuse effectiveSampleSize.ts's clustering, same as agent_performance_stats
  wilsonLower: number | null;  // reuse the SAME Wilson calculation calibrationMaturity.ts already uses
}
```

This is deliberately the *exact same* statistical machinery as §0.4/§0.5 — one more `GROUP BY`
dimension, not a new method. Cost/latency per bucket come from joining `ai_usage`/`ai_calls` by
`aiCallId` (already on `agent_predictions`) — no new instrumentation, per §0.3.

## D. Confidence calibration

Five distinct concepts, kept structurally separate as required — conflating any two of these is the
single biggest risk in this whole design:

| Concept | Source | Trust level |
|---|---|---|
| Model self-reported confidence | The raw JSON field the LLM returned | **Never trusted directly** |
| Calibrated confidence | `agent_confidence_calibration`'s Beta-Binomial posterior (§0.4), extended with a `provider` column | Trusted, shrinks to prior under thin samples |
| Provider reliability | `ai_providers.successRate`/`health` (§0.1) | Protocol-level: did the call complete at all, unrelated to answer quality |
| Task quality | Schema validity (§0.7) + evidence grounding (new, see below) + agreement with a second cheap-tier check where the policy allows one | Per-attempt, immediate |
| Downstream trading outcome | `prediction_outcomes.outcome` (WIN/LOSS), the slowest signal | Ground truth, delayed by the evaluation horizon |

**"Independently calibrated" gate** (never self-reported alone) = schema validity (reuse
`AIOutputValidator`) **AND** evidence grounding (new, lightweight: does the response reference data
actually present in the prompt — a cheap deterministic heuristic, not a second LLM call) **AND** the
task-specific `qualityFloor` from §B **AND** the historical `wilsonLower` from §C for this exact
(agent, provider) pair, when that pair has enough effective sample to be past `LEARNING` maturity (§0.4)
— otherwise fall back to a safe default (today's current routing, never an unproven escalation
shortcut).

**Extend `agent_confidence_calibration` with a `provider` column** (additive migration, existing rows
get a `'ALL'` sentinel default — no backfill required, no existing consumer breaks) rather than a
parallel table, since the Beta-Binomial math is identical, just one more grouping key.

## E. Cost/latency accounting

Already fully instrumented (§0.3). §C's ledger surfaces it per (agent, provider); no new columns, no
new tables, no new write path.

## F. Local-model preference

Default policy (§B) already encodes this: agents whose task is naturally within Ollama's reach
(News classification, sentiment, Reflection, Explainability) default to `["LOCAL"]` only, or `LOCAL`
first with a high bar to escalate — matching your own table exactly.

## G. Remote escalation (economical tier)

Requires classifying *which registered providers count as "economical"* — this is an operator/config
decision, not something the governor should infer. **Recommendation:** a new `costTier` field per
provider **name** in `config/aiCostGovernor.json` (`{"Mistral": "ECONOMICAL", "Gemini": "ECONOMICAL",
"Claude": "STRONG", "NVIDIA": "ECONOMICAL", ...}`), reviewed config (matches CLAUDE.md's "no
operational thresholds hardcoded in TS" rule), not a DB column — this is a policy classification, not
telemetry, so it belongs in a file an operator reviews, not a runtime-mutated row.

## H. Strong-model escalation

Final tier, reached only when both LOCAL and ECONOMICAL failed the independently-calibrated quality
gate (§D) for an agent whose policy includes `"STRONG"` — none do, in the initial policy set in §B,
matching your explicit "escalate only when evidence indicates" instruction and keeping the first
rollout conservative.

## I. Provider health interaction

The governor **composes with**, never bypasses, `filterRoutableProviders()`/`skipProviderTemporarily()`
(§0.1). If a tier's only candidate provider is in cooldown, the governor selects the next available
provider within the *same* tier (multiple providers can share a `costTier`) before ever escalating a
tier purely because of a transient cooldown — escalation must be about *quality*, never a proxy for
"the cheap provider happened to be down right now."

## J. Shadow mode

Follow §0.9 exactly: compute what the governor *would* have selected (tier, provider, model, predicted
cost) alongside the real `routeTask()` call, log via `structuredLogger` into `observability_events`
as a new `AI_COST_GOVERNOR_SHADOW_COMPARISON` event — no new table — expose via
`GET /ai-cost-governor/shadow-comparison` and `./argus ai-governor-shadow`, mirroring
`/consensus/shadow-comparison` structurally. Wrapped in `try/catch` exactly like the consensus shadow
call site — a shadow-mode bug must be structurally incapable of affecting the real call.

## K. Feature flags

Follow §0.8 Variant A: `aiCostGovernorEnabledEnvVar: "AI_COST_GOVERNOR_ENABLED"` in
`config/aiCostGovernor.json`, `isAiCostGovernorEnabled()` helper. A second flag,
`aiCostGovernorShadowOnlyEnabledEnvVar`, lets Phase A5 run shadow-only even after the master flag is on
for instrumentation, decoupling "is the governor computing decisions" from "is it allowed to act on
them" — this is the safest way to reach Phase A6 gradually per agent (§B's per-agent `tiers` array
already gives natural per-agent rollout without a second flag axis; a real per-agent enable list is
unnecessary complexity on top of that).

## L. Failure/fallback semantics

**The governor must fail OPEN to exactly today's `routeTask()` behavior on any internal error** — never
introduce a new failure mode. If governor logic throws, is misconfigured, or its ledger query fails,
`routeTask()` proceeds exactly as it does today (ignore the governor, use the existing default route).
This is not optional — a selection-layer bug must never become an availability bug.

## M. Observability

New CLI command `./argus ai-cost-governor` (mirrors `strategy-scorecard`'s combined-report pattern):
per-(agent, provider) ledger table, current policy, shadow-mode agreement rate, estimated savings if
shadow decisions had been live. Matches the observability-CLI family already documented in
`ARGUS_CLI.md` (§4).

## N. Database/schema changes, if actually necessary

Minimal, additive only:
1. New column `provider TEXT DEFAULT 'ALL'` on `agent_confidence_calibration` (§D). Existing rows
   unaffected; existing consumers (`ModerateTierEvaluator.ts`, `calibrationMaturity.ts`) keep working
   unchanged by treating `'ALL'` as "no provider breakdown" — **explicitly not required to change
   those files in Phase A1-A3**, only to add the column.
2. **No new tables.** §C's ledger is a read aggregation (§0.6 pattern); §J's shadow mode reuses
   `observability_events` (§0.9 pattern).
3. One new drizzle migration file, next sequential number after `0053_superb_fat_cobra.sql`, following
   the existing auto-generated naming convention.

## O. Tests required

- **Feature-flag-off invariant (the most important test):** with `AI_COST_GOVERNOR_ENABLED` unset/false,
  `routeTask()`'s behavior, provider selection, and timing must be byte-for-byte identical to before
  this change — this is the test that proves Phase A1–A3 shipped zero behavior change.
- Beta-Binomial provider-dimension calibration math (extend `agent_confidence_calibration`'s existing
  test pattern with a `provider` column case).
- `getProviderSegmentedStats()` — mirrors `ModelPerformanceTracker.test.ts`'s existing
  `getRegimeSegmentedStats()` test shape exactly, grouping by provider instead of regime.
- Shadow-mode: governor decision logged, real routing provably unaffected (assert the real call's
  provider/model choice is identical whether or not shadow computation ran or even threw).
- Tier-selection policy: given a config policy + ledger state, correct tier chosen; thin-sample
  (`LEARNING`-maturity or below) pairs must fall back to today's default route, never an
  unproven escalation.
- Fail-open: a thrown/misconfigured governor must not change `routeTask()`'s outcome at all.
- Escalation-storm rate limit (§Failure modes below).

## P. Migration/rollback strategy

Every change here is additive: one new nullable-defaulted column, zero new tables, a new file, a new
flag defaulting off. Rollback = flip `AI_COST_GOVERNOR_ENABLED` back to false (already the default) —
zero data loss, zero schema rollback needed, no existing consumer of any touched table changes
behavior.

---

## Explicit failure-mode analysis (required before any implementation recommendation)

- **Weak local model falsely claiming high confidence:** solved structurally by §D — self-reported
  confidence is never the gate; only the calibrated `wilsonLower` for that exact (agent, provider) pair
  is, and it starts untrusted (§0.4 shows *nothing* is `TRUSTED` today even at the coarser agent-only
  granularity) until real effective sample size accumulates.
- **Provider disagreement:** a true "does the cheap tier agree with local" check costs a second real
  call, partially offsetting savings — recommend using it only when the policy's `qualityFloor` is
  borderline for that specific attempt, never universally, and never for agents whose policy is
  `LOCAL`-only.
- **Malformed structured output:** an `AIOutputValidator` failure counts as "this attempt failed," not
  as negative evidence against the model's reasoning quality — but repeated parse failures for the same
  (agent, provider) do accumulate against that pair's ledger over time (a real, distinct failure class).
- **Stale evidence:** explicitly out of scope — that's `data_freshness`'s job (a RiskEngine gate). The
  governor must never be asked to judge data freshness, only response quality.
- **Provider outage:** already handled by `filterRoutableProviders`/`skipProviderTemporarily` (§0.1);
  the governor composes with it (§I), never replaces it.
- **Timeout:** already handled by the local/remote split shipped this session; the governor's tiers sit
  above this, unchanged.
- **Retry amplification:** reuse the existing "no fallback multiplier stretch past hardCap" philosophy
  (§0.1) — total attempts across all governor tiers combined must stay inside one outer budget ceiling,
  never 3x today's worst-case latency/cost. Tier 2/3 should only be attempted if tier 1 failed *fast*
  (schema/moderate-confidence-fail), not after tier 1 already burned its full timeout budget.
- **Escalation storms:** if a systematic local-model degradation (e.g. Ollama crashes) makes every
  request "uncertain," a naive governor would 3x total AI spend/latency system-wide at once. Recommend
  a `HeavyModelMutex`-style bounded counter (§0.2 precedent) capping escalations per time window; on
  overflow, **structured-log an alert and fail open to today's default routing** rather than let cost
  balloon silently.
- **Heavy-model queue saturation:** the governor must check `HeavyModelMutex` queue depth (§0.2) before
  treating a heavy local model as a "free" escalation option — it must not make an already-deep queue
  worse by preferring a heavy local retry over an available economical remote provider.
- **Circular learning:** the ledger (§C) must only update from real, `PredictionOutcomeEvaluator`-graded
  `prediction_outcomes` — never from the governor's own accept/escalate decision. This is the same
  discipline `agent_confidence_calibration` already enforces; the governor must not grade its own
  homework.
- **Insufficient outcome labels:** reuse `evidenceStatus`/effective-sample-size floor (§0.4/§0.5)
  exactly — a thin (agent, provider) pair defaults to today's current routing, never an unproven
  shortcut.
- **Survivorship bias:** a real, only partially solvable risk — if the governor stops sending 95% of
  FundamentalAgent traffic to the strong tier, that tier's ledger sample stops growing, so the system
  can't easily re-discover if it's ever needed again (e.g. after a regime shift). **Recommend a small,
  randomized exploration carve-out** — a tiny percentage of calls bypass the governor's shortcut and go
  to a higher tier anyway, purely to keep the ledger honest — explicitly modeled on
  `StrategyExplorationScheduler.ts`'s own bounded-exploration rationale (Phase 15), not a new idea.
- **Changing market regimes:** same exploration carve-out, plus weighting recent outcomes more in the
  ledger (a recency decay), consistent with how calibration data should not be treated as
  permanently valid.
- **Quality degradation from aggressive cost optimization:** the stated non-goal up front — the quality
  floor is per-agentType (§B), never global, and Phase A5's shadow mode exists specifically to measure
  this *before* any real behavior change, with Phase A6 enabling only on the lowest-stakes agents first,
  leaving ChiefTrader's ensemble path untouched in this initial rollout.

---

## Implementation phases (as specified)

- **Phase A1 — Instrumentation.** Add `getProviderSegmentedStats()` (§C) as a pure read function.
  Zero behavior change, zero new tables.
- **Phase A2 — Task/provider quality ledger.** Surface §C via the new CLI command (§M). Still read-only.
- **Phase A3 — Calibration.** Add the `provider` column to `agent_confidence_calibration` (§N); extend
  `ReflectionEngine`'s existing calibration write path to populate it. Still no routing change.
- **Phase A4 — Governor.** Implement the tier-selection logic (§B–§I) behind `AI_COST_GOVERNOR_ENABLED`
  (default false).
- **Phase A5 — Shadow mode.** Flip the flag on with `shadowOnly` forced true (§K) — compute and log,
  never act. Run until enough (agent, provider) pairs clear `LEARNING` maturity to trust a real decision.
- **Phase A6 — Enable for selected agents.** News/Fundamental/Macro/Reflection first, per your own
  ordering — never ChiefTrader's `ConsensusDebate` path in this phase.
- **Phase A7 — Adaptive routing.** Only after A6 has real outcome data, let historical quality/cost/
  latency actually influence tier order within a `costTier`, not just gate escalation.

---

## Final deliverable (as requested)

**1. Recommended architecture:**
```
AI request (agentType, prompt, traceId)
        |
        v
AI Cost Governor (NEW — additive layer inside routeTask(), flag-gated)
        |
   policy lookup (config/aiCostGovernor.json, per agentType)
        |
   tier 1: LOCAL (Ollama) --------- accept if independently-calibrated quality >= floor
        |                                   |
        | (uncertain/invalid)               v
        v                                RETURN (existing routeTask path, unchanged)
   tier 2: ECONOMICAL (if policy allows) --- accept if calibrated quality >= floor
        |                                   |
        | (uncertain, policy allows STRONG) v
        v                                RETURN
   tier 3: STRONG (only if policy allows) ---> RETURN
        |
        v
   existing routeTask() provider-health / fallback / timeout machinery (UNCHANGED, §0.1)
        |
        v
   AI result -> existing agent (FundamentalAgent/MacroAgent/etc, UNCHANGED)
        |
        v
   TRADE_IDEA_GENERATED -> ChiefTrader -> RiskEngine (24 gates, UNCHANGED) -> OMS
```

**2. Exact files/modules that would need modification:**
- New: `config/aiCostGovernor.json`, `src/server/config/aiCostGovernor.ts` (loader, matches
  `aiModels.ts` pattern), `src/server/ai/AICostGovernor.ts` (tier-selection logic),
  `src/server/services/ProviderPerformanceTracker.ts` (§C, sibling to `ModelPerformanceTracker.ts`).
- Modified (additive only): `src/server/ai/AIRouter.ts` (call the governor before the existing provider
  loop, Phase A4+ only), `src/server/db/schema.ts` (+1 column, §N), `ReflectionEngine.ts` (populate the
  new column, Phase A3), `ARGUS_CLI.md`/`scripts/argus-cli.ts` (new observability command, §M).
- **Not modified at all:** `ChiefTraderAgent.ts`, `RiskEngine.ts`, `OrderManagementService.ts`,
  `BrokerManager.ts`, any of the 24 gate implementations, `tradingSafety.json`'s consensus/threshold
  fields, `config/agentWeights.json`.

**3. Proposed feature flags:** `AI_COST_GOVERNOR_ENABLED` (master, default false),
`AI_COST_GOVERNOR_SHADOW_ONLY` (default true when the master flag is on, forces Phase A5 behavior until
explicitly turned off per the rollout plan).

**4. Proposed metrics:** per-(agent, provider) `effectiveN`/`wilsonLower`/win-rate/avg-cost/avg-latency
(§C), shadow-mode agreement rate (§J), escalation rate and escalation-storm counter (§Failure modes),
estimated-vs-actual cost delta once live.

**5. Test plan:** §O in full — flag-off invariant is the load-bearing test.

**6. Rollout plan:** §Implementation phases A1→A7, each phase gated on the previous one's evidence, no
phase skips to "enable for ChiefTrader" at any point in this design.

**7. Explicit list of things that must NOT change:** `ChiefTraderAgent`'s consensus math,
`consensusApprovalThreshold` (0.75), `minIndependentAgreeingAgents` (2), any of the 24 RiskEngine gates,
`PositionSizing`, `OrderManagementService.placeOrder()`, `BrokerManager`, `PAPER_TRADING_ONLY`,
`LIVE_ARM`, `tradingState`, the kill switch, and `routeConsensus`'s parallel-fan-out ensemble behavior
for `ConsensusDebate` (explicitly out of scope for this entire design, not merely deferred).
