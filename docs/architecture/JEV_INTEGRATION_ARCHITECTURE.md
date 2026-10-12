# Jev Integration Architecture — Certification (2026-10-11)

**Status:** point-in-time certification artifact (Worker C, Argus October 8–9 defect-closure
mission). This is a dated certification snapshot, not a competing living reference: the living
architecture reference remains `docs/architecture/ARGUS_ARCHITECTURE.md`. Audited at commit
`3edf5bc` on branch `mission/oct8-oct9-closure` (sibling Worker A had uncommitted edits to
`src/server/services/ChiefTraderAgent.ts` at audit time — see §11).

**Safety posture:** PAPER ONLY, `LIVE_NO_GO`. Nothing in this document enables live trading or
weakens any gate.

## 1. Verdict

Jev (TypeSafe AI's "System One" structured-decision model) is **certified as optional,
event-driven, advisory-only intelligence** with the following state at audit time:

- **Implementation present:** yes — provider adapter, typed decision provider, bounded call
  governor, news-triage/shadow/escalation consumers, advisory service, calibration ledger.
- **API key configured:** **NO** (`JEV_API_KEY`/`TYPESAFE_API_KEY` unset in this environment;
  `.env.example` carries only a `<redacted>` placeholder). Every Jev call path short-circuits
  before any network attempt. The integration is **effectively INERT** until an operator
  configures a key in the deployment `.env`.
- **One defect found (Medium):** `NewsEngine.tryJevFirstAnalysis` (Phase 2 escalation) calls
  Jev **directly**, bypassing `AICallGovernor` — see §12.
- **External smoke:** NOT_CERTIFIED (no key; no external call attempted or faked).

## 2. Component inventory (all paths verified in source)

| Component | File | Role |
|---|---|---|
| Wire adapter | `src/server/ai/providers/JevProvider.ts` | `POST {base}/v1/systemone`; typed `noul`/`choice`/`score` Q&A; strict answer validation; chat/stream/embeddings/vision/image **fail closed by design** |
| Typed decision facade | `src/server/ai/JevDecisionProvider.ts` | `decide()` / `discoverModels()` (smoke helper); `JevError` taxonomy (NO_API_KEY/AUTH/RATE_LIMIT/OVERLOAD/SERVER/NETWORK/TIMEOUT/VALIDATION/ABORTED/BILLING/UNKNOWN); key redaction on every error path |
| Bounded governor | `src/server/ai/AICallGovernor.ts` | Central gate for ALL optional AI calls; 13-step check order; budgets, cache, singleflight, cooldowns, circuit breaker |
| Governor config | `config/aiCallGovernor.json` + `src/server/config/aiCallGovernor.ts` | `aiGovernorEnabled: true`, `jevEnabled: true`; `jevTimeoutMs: 8000`, `jevMaxInFlight: 4`, `jevQueueLimit: 32`, `jevCallsPerMinute: 20`, circuit threshold 5 / cooldown 120s / half-open 2 probes; env overrides `ARGUS_AI_CALL_GOVERNOR_ENABLED`, `ARGUS_JEV_ENABLED` |
| Advisory service | `src/server/ai/AiAdvisoryService.ts` | Fire-and-forget, never-throws; sinks are observability + in-memory note cache only |
| News triage (shadow) | `src/server/news/JevNewsTriage.ts` | Phase 1: `kickOffJevShadowScoring` → governor `STRUCTURED_DECISION`, kind `jev_news_shadow_scoring`, write-only ledger |
| Escalation policy | `src/server/news/JevEscalation.ts` | Phase 2: pure decision logic — Jev confident ⇒ skip LLM; else existing path |
| Shadow ledger | `src/server/news/JevShadowLedger.ts` | `jev_shadow_scores` table; agreement + calibration queries; never read by trading |
| Classification contract | `src/server/news/JevClassificationTask.ts` | Extension interface for future tasks (none registered); shadow-first discipline |
| Shared types | `src/server/news/JevNewsTypes.ts` | `JevNewsScore` + validated mappings |
| Consumer | `src/server/news/NewsEngine.ts` | Calls advisory service (per new article), shadow scoring, and Phase 2 `tryJevFirstAnalysis` (flag-gated) |
| Consumer | `src/server/services/ChiefTraderAgent.ts` | Reads advisory note (recorded-only input to `QuantExecutionPolicy`); fires post-decision advisory |
| Policy sink | `src/server/quant/QuantExecutionPolicy.ts` | `aiAdvisoryNote`: recorded on decision, never consulted by any check |
| AIRouter hook | `src/server/ai/AIRouter.ts` (~L147, ~L793) | Provider-creation switch for names containing `jev`/`typesafe`; `chat()` throws ⇒ can never join `routeConsensus`/`routeTask` debates |
| Calibration surface | `src/server/routes/observabilityRoutes.ts` (`GET /jev-calibration`), `scripts/argus-cli.ts` | Read-only ledger views; human threshold review only |

## 3. Call-site inventory (production, non-test)

Every production Jev call site found by source search:

1. `src/server/news/JevNewsTriage.ts:347` — `kickOffJevShadowScoring` → `AICallGovernor.request({capability:'STRUCTURED_DECISION', kind:'jev_news_shadow_scoring', …})`. Fire-and-forget; SKIPPED/FAILED ⇒ observation dropped, never blocks news cycle.
2. `src/server/news/NewsEngine.ts:207` — `aiAdvisoryService.considerNewsCatalyst(...)` once per genuinely-new article (past normalize + dedup + cluster persistence). Fire-and-forget.
3. `src/server/news/NewsEngine.ts:239` — `tryJevFirstAnalysis(...)` **only when `ARGUS_JEV_ESCALATION_ENABLED=true`** (default false). **DEFECT: bypasses the governor** (see §12).
4. `src/server/services/ChiefTraderAgent.ts:1517` — `aiAdvisoryService.getAdvisoryNote(symbol)`; passed into `evaluateQuantExecutionPolicy` as recorded-only input.
5. `src/server/services/ChiefTraderAgent.ts:1733` — `aiAdvisoryService.considerQuantCandidateAdvisory(...)` **after** the quant policy decision is recorded; observability only.
6. `src/server/ai/AiAdvisoryService.ts` — `runNewsCatalystTriage` / `runQuantCandidateAdvisory` → governor `STRUCTURED_DECISION` (kinds `news_catalyst_triage`, `quant_candidate_advisory`).

No other production call sites exist. `JevDecisionProvider.decide()` is reachable only via the
governor (`AICallGovernor.invokeJev`); `JevProvider.evaluate()` directly only from
`scoreArticleWithJev` (site 3) and `runClassificationTask` (no registered callers).

## 4. Role definition — what Jev may and may not do

**Jev is OPTIONAL intelligence. Verified boundaries (code citations):**

Jev does NOT (each verified by source inspection + tests):
- Calculate deterministic indicators (RSI/MACD/ATR/VWAP): the closed question sets are
  news relevance/sentiment/impact/surprise/contradiction/urgency (`JevNewsTriage.buildJevNewsQuestions`),
  catalyst classification/materiality (`AiAdvisoryService.buildNewsTriageQuestions`), and
  thesis-support/material-risk (`runQuantCandidateAdvisory`). No indicator, EV, R:R, P&L, or
  position-size computation exists in any Jev module.
- Bypass RiskEngine / submit orders / write to OMS: no Jev file imports or references
  `RiskEngine`, `BrokerManager`, `OrderManagementService`, `ChiefTraderAgent`,
  `PositionSizing`, `.placeOrder(`, `emitTradeIdea(`, or `CHIEF_APPROVED_IDEA` — proven by
  `src/server/services/jevCannotCauseOrder.test.ts` (15 tests) and the pre-existing
  `quantAiIndependence.test.ts` spine scan.
- Grant lifecycle authorization or self-certify a strategy: lifecycle authority lives in
  `ChiefTraderAgent`/authorization resolver; Jev has no path to it.
- Override kill switch, reconciliation, or stale-data protection: `protectiveExitAiIndependence`
  and `riskAndReconciliationAiIndependence` suites prove exits/risk/reconciliation never consult AI.

Jev MAY (bounded):
- Catalyst/regime/conflicting-evidence interpretation (news triage questions; advisory only).
- Candidate prioritization advisory (`quant_candidate_advisory`, post-decision, observability only).
- Post-trade research (governor kind `post_trade_research`, LOW materiality allowed).
- Structured decision assistance via typed `noul`/`choice`/`score` answers — never prose parsed
  for execution.

## 5. Event-driven only (no per-tick calls)

- `hotPathProhibition.test.ts` (6 tests): `MarketDataWorker` tick/quote/websocket handlers
  contain zero Jev/governor/advisory references — file-level and handler-body-level scans, plus a
  coverage guard that fails if a new tick-handler file appears.
- Governor materiality gate (`MIN_MATERIALITY_BY_KIND`): `news_catalyst_triage` MEDIUM,
  `quant_candidate_advisory` MEDIUM, `regime_change` HIGH, `jev_news_shadow_scoring` LOW,
  `post_trade_research` LOW; unknown kinds default MEDIUM (fail closed).
- Material fingerprint: `stableStringify({capability, kind, model, schemaVersion, symbol, parts})`
  hashed to 16 hex chars; wall-clock/traceId excluded so identical material ⇒ identical
  fingerprint ⇒ cache hit / singleflight join / dedup.
- `AiAdvisoryService` adds its own bounded `FingerprintMemory` (5,000 entries, oldest-10%
  eviction) for duplicate suppression ahead of the governor.

## 6. Governor bounds (all verified in `AICallGovernor.ts`)

Check order: `DISABLED → STALE_EVENT → DEADLINE_TOO_CLOSE → NOT_MATERIAL → CACHE_HIT →
DUPLICATE (singleflight) → SYMBOL_COOLDOWN → GLOBAL_BUDGET → PROVIDER_BUDGET →
PROVIDER_UNHEALTHY (NO_API_KEY) → CIRCUIT_OPEN → QUEUE_FULL → SHOULD_CALL`.

- **maxInFlight:** `jevMaxInFlight: 4` (queue capacity = 4 + `jevQueueLimit: 32` = 36; beyond ⇒
  `SKIPPED/QUEUE_FULL`, never an unbounded queue).
- **Timeout:** `jevTimeoutMs: 8000`; provider-level per-attempt timeout 15s default;
  race-based, abort-propagating.
- **Singleflight:** `inFlight` map keyed by fingerprint; registration is synchronous before any
  await, so concurrent duplicates join instead of duplicating.
- **Dedup/cache:** fingerprint cache, TTL per kind (`jev_news_shadow_scoring`: 1h,
  `news_catalyst_triage`: 1h, `quant_candidate_advisory`: 2m, `regime_change`: 15m,
  `premarket_enrichment`: 30m, `post_trade_research`: 24h); LRU-capped at
  `aiStateCacheMaxEntries: 500`.
- **Cooldown:** per-symbol `aiPerSymbolCooldownMs: 300000`; per-symbol `4/min`; symbol maps
  bounded at 2,000 buckets with oldest-eviction.
- **Budgets:** global `30/min` optional-AI; Jev `20/min`; generative `10/min` (sliding windows).
- **Circuit breaker:** trips at 5 consecutive tripping failures
  (TIMEOUT/RATE_LIMIT/OVERLOAD/SERVER/NETWORK/BILLING/UNKNOWN); AUTH/VALIDATION/NO_API_KEY mark
  provider unhealthy instead (cheap skip, no breaker churn). Half-open after 120s with max 2
  probes; success closes and emits `AI_PROVIDER_RECOVERED`.
- **Deadline-aware skip:** `STALE_EVENT` past `decisionDeadlineMs`; `DEADLINE_TOO_CLOSE` when
  < 2000ms lead remains.
- **No failover, ever:** a failed `STRUCTURED_DECISION` is never retried as
  `GENERATIVE_ANALYSIS` (and vice versa) — each capability fails independently; callers get
  `FAILED`, never a surprise LLM bill. Proven by `jevFailureSemantics` ("NO FAILOVER") and the
  chaos suites.

## 7. Failure semantics

`JevError` kinds map: 401→AUTH, 429→RATE_LIMIT, 529→OVERLOAD, 402→BILLING (never retried —
only the operator topping up fixes it), 422→VALIDATION, 5xx→SERVER, timeout→TIMEOUT,
network→NETWORK, malformed→VALIDATION. Retry policy: only RATE_LIMIT/OVERLOAD/SERVER/NETWORK/
TIMEOUT are retryable, with capped full-jitter backoff honoring `Retry-After` (max 30s).

Consequences verified by tests (`jevFailureSemantics.test.ts`, 3 tests;
`AICallGovernor.test.ts`, 38 tests):
- Any failure ⇒ governor returns `FAILED` (never throws); Jev decision = unavailable.
- Validated-quant policy outcome is **identical** across Jev-healthy and every failure mode
  (TIMEOUT, 429, 500, circuit OPEN, NO_API_KEY) — parity proven on the real governor + policy.
- AI-originated ideas with all AI down fail closed (`DESK_NO_TRADE`, no `CHIEF_APPROVED_IDEA`).
- Protective exits: risk-exit SELL approved with governor circuit OPEN, never consulting the
  governor (`protectiveExitAiIndependence`, runtime test).
- RiskEngine and reconciliation never consult AI (`riskAndReconciliationAiIndependence`).
- Quant modules never import the AI layer, one dependency-level deep
  (`quantAiIndependence`).

## 8. Structured output

- `JevProvider.evaluate()`: every requested question key MUST return a well-formed,
  type-matching answer or it throws `JevAnswerValidationError` (fail-closed). Validates:
  `noul` ∈ [0,1] finite; `choice` ∈ declared criteria with finite probabilities;
  `score` finite with finite probabilities. Never synthesizes a probability.
- `JevDecisionResult`: `{answers, model, inputTokens, latencyMs}` — typed, no prose parsing
  for execution-critical decisions.
- News mapping (`mapJevAnswersToNewsScore`, `mapJevScoreToAnalysisFields`) clamps through the
  same `AIOutputValidator` clamps the LLM path uses; unknown sentiment coerces to neutral.

## 9. Provenance (non-secret, bounded)

- Governor emits structured events persisted to `observability_events` (via `StructuredLogger`,
  `redactSecrets()` applied): `AI_CALL_CONSIDERED/SKIPPED/STARTED/COMPLETED/FAILED`,
  `AI_CACHE_HIT`, `AI_SINGLEFLIGHT_JOINED`, `AI_PROVIDER_CIRCUIT_OPENED/HALF_OPEN/RECOVERED`,
  `JEV_DECISION_COMPLETED` (model, inputTokens, latency). Only kind/symbol/fingerprint-hash/
  latency/reason flow — **request state bodies, questions, and keys are never logged**
  (`AICallGovernor.emit` docstring + code).
- Shadow ledger `jev_shadow_scores`: model, scores, confidences, latency, tokens, LLM
  comparison, agreement, timestamp, traceId — no secrets.
- No secret is persisted: `SecretRedaction` covers `JEV_API_KEY`/`TYPESAFE_API_KEY` (name +
  value redaction, `Bearer`/`Basic`/JWT/query-secret patterns); `JevDecisionProvider.redactKey`
  strips key occurrences from error messages defense-in-depth.

## 10. Startup independence

`server.ts` contains **zero** references to Jev (case-insensitive search). `NewsEngine`
lazy-imports Jev modules only inside the flag-gated escalation path; `AiAdvisoryService`
lazy-imports the governor on first advisory work. Boot succeeds with Jev unavailable — the
governor's `NO_API_KEY` / `DISABLED` skips are the steady state. **PASS.**

## 11. All-down independence (mechanism certification, not alpha proof)

Simulated 2026-10-11 with Jev + all AI unavailable (no key in env; governor deny-all and
no-key paths exercised; no generative executor registered):

| Check | Result |
|---|---|
| `JevDecisionProvider.isConfigured()` | `false` |
| Governor `STRUCTURED_DECISION` (deny-all) | `SKIPPED / DISABLED`, never throws |
| Governor `STRUCTURED_DECISION` (enabled, no key) | `SKIPPED / NO_API_KEY`, never throws |
| `AiAdvisoryService` advisory note | `null` (no-op) |
| Authorized TEST-only quant fixture → `evaluateQuantExecutionPolicy` (zero AI) | Decision on quant checks only: `QUANT_INSUFFICIENT_SUPPORT`, `aiAvailability: 'NOT_CONSULTED'` |

Per-link independence is proven by passing suites: `quantAiIndependence` (17),
`protectiveExitAiIndependence`, `riskAndReconciliationAiIndependence`, `jevFailureSemantics`.
**Caveat:** the full mechanical chain
Quant → authorization → QuantExecutionPolicy → ChiefTrader → RiskEngine → PositionSizing →
OMS → simulated PAPER broker was **not** re-driven end-to-end in this audit: Worker A had
**uncommitted** edits to `src/server/services/ChiefTraderAgent.ts` (the QUANT_EXECUTION
consensus-bypass remediation) at audit time, so the ChiefTrader link was in flux. The
remediated behavior (consensus gate enforced on the QUANT_EXECUTION path) must be re-verified
end-to-end after Worker A commits — re-run the chain with AI fully down and assert the order
reaches the simulated paper broker through the normal gates, with `JEV_API_KEY` unset.

## 12. Defects found

### D1 (Medium): `NewsEngine.tryJevFirstAnalysis` bypasses `AICallGovernor`
- **Location:** `src/server/news/NewsEngine.ts:595,608-611`
- **What:** Phase 2 escalation constructs `new JevProvider()` with the raw key and calls
  `scoreArticleWithJev(provider, state, { timeoutMs: 8000 })` directly — no governor budget,
  no maxInFlight bound, no circuit breaker, no singleflight/dedup, no cache, no cooldown.
- **Impact if triggered:** requires operator to set `ARGUS_JEV_ESCALATION_ENABLED=true` AND
  configure `JEV_API_KEY`; then a news flood spawns one unbounded Jev request per article
  (the exact failure-storm shape the governor was built to prevent; the Phase 1 shadow path
  was already migrated onto the governor in c991233, this path was missed).
- **Mitigations in place:** default OFF flag; key required; 8s timeout; fail-closed try/catch
  → `null` → existing FinBERT→LLM path unchanged; never influences a trading decision beyond
  news analysis.
- **Recommended fix:** route `tryJevFirstAnalysis` through `AICallGovernor.request` as
  `STRUCTURED_DECISION` (kind `news_catalyst_triage`), like `kickOffJevShadowScoring`.
- **Tests:** no test pins the bypass (verified by search); the new
  `jevCannotCauseOrder.test.ts` asserts the function cannot reach the order spine, which still
  holds.

### Non-defect notes
- `config/aiCallGovernor.json` (`aiGovernorEnabled: true`, `jevEnabled: true`) was added
  after the Oct 6 INERT snapshot (commits `3a70d3f`, `c991233`). With no key configured this
  changes nothing observable — all `STRUCTURED_DECISION` requests still skip at `NO_API_KEY`.
  If a key is ever configured, these flags mean the governor is live (deny-by-budget, not
  deny-all); `ARGUS_JEV_SHADOW_SCORING_ENABLED` and `ARGUS_JEV_ESCALATION_ENABLED` remain
  default-OFF in `.env.example`.
- `JevProvider` registers in `AIRouter` only if an operator configures a provider whose name
  contains `jev`/`typesafe`; its `chat()/stream()` throw by design, so it can never cast a
  consensus vote or join a debate (`routeConsensus` calls `provider.chat(...)`).

## 13. Test evidence (all run 2026-10-11, commit 3edf5bc)

| Suite | Tests | Result |
|---|---|---|
| `ai/AICallGovernor.test.ts` | 38 | PASS (incl. 1000-event failure storm → bounded, circuit OPEN, zero generative fallback) |
| `ai/JevDecisionProvider.test.ts` | 20 | PASS (429/500/529/network → typed errors) |
| `ai/providers/JevProvider.test.ts` | 16 | PASS |
| `ai/AiAdvisoryService.test.ts` | 11 | PASS |
| `ai/jevCallReduction.test.ts` | 4 | PASS (provider down + 1000 events → bounded, circuit opens) |
| `ai/jevAiValue.test.ts` | 4 | PASS |
| `ai/hotPathProhibition.test.ts` | 6 | PASS |
| `ai/jevFailureSemantics.test.ts` | 3 | PASS (parity across all failure modes; no failover; AI ideas fail closed) |
| `ai/quantAiIndependence.test.ts` | part of 17 | PASS |
| `ai/protectiveExitAiIndependence.test.ts` | part of 17 | PASS |
| `ai/riskAndReconciliationAiIndependence.test.ts` | part of 17 | PASS |
| `news/JevNewsTriage.test.ts` + `.governor.test.ts` + `JevShadowLedger.test.ts` + `JevEscalation.test.ts` + `JevClassificationTask.test.ts` + `core/SecretRedaction.test.ts` | 65 | PASS |
| `ai/AIRouter.providerResilience.test.ts` | 13 | PASS |
| `fault-injection/ChaosMatrix.test.ts` + `FaultInjectionGate.test.ts` + `InjectorIsolation.test.ts` (`ARGUS_FAULT_INJECTION=1`) | 27 | PASS |
| **New:** `services/jevCannotCauseOrder.test.ts` | **15** | **PASS** |

Total: **243 tests passed, 0 failed** across the Jev/governor/AI-safety surface.

## 14. Certification summary

Jev is certified as **optional, event-driven, advisory-only intelligence** that cannot directly
cause an order, cannot bypass RiskEngine, cannot grant lifecycle authority, and degrades to
neutral-unavailable under every failure mode without pausing authorized quant, blocking
protective exits, blocking RiskEngine/OMS, or launching fallback-provider storms. The
integration is INERT without a configured key. One Medium defect (governor bypass on the
Phase 2 escalation path) is documented in §12 with a recommended fix. External smoke:
NOT_CERTIFIED (no key configured; no external call made or faked).
