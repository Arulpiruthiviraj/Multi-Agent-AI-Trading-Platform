# LangGraph Research Service

**LangGraph is NOT part of the live trading decision spine.** It is an isolated, off-by-default,
shadow-only advisory companion — the same architectural tier as `quant-core-java` and
`scripts/local_ai_service.py` (Chronos), not a new entry point into
ChiefTraderAgent/RiskEngine/OrderManagement/BrokerManager.

**Status: Phase 0-3 implemented and runtime-verified. Phases 4-5 are NOT implemented** (see "Known
limitations"). Phase 3 turned the Phase 0-2 recommendation into a proper human-reviewable artifact:
counter-evidence, a deterministic (non-LLM) evidence-strength/missing-evidence assessment, a
deterministic `humanReviewRequired` flag, a read-only Node API, and a read-only frontend panel. It
adds **zero** new write paths, **zero** new promotion authority, and **zero** new outbound calls —
every Phase 3 field is computed from data the Phase 0-2 workflow already had.

## The one-paragraph version

`langgraph-research/` is a standalone Python process (loopback-only, port 8090, default **off** —
`LANGGRAPH_RESEARCH_ENABLED=false`) that runs one real LangGraph `StateGraph` producing a
**strategy-graduation recommendation**: given a strategy id, it fetches that strategy's
already-computed evidence from Argus over one narrow read-only HTTP route, has a local LLM
(Ollama) interpret the evidence and draft a structured recommendation, deterministically validates
that recommendation against Argus's own real gate results, and returns a JSON envelope. Node
persists that envelope into `research_agent_runs` and returns it to the caller. It has **zero
broker imports, zero credentials, no SQLite access, and no `.placeOrder()` equivalent** — see
`langgraph-research/tests/test_safety_boundary.py` and
`src/server/langGraphArchitectureBoundary.test.ts` for the automated checks that enforce this.

## Why isolated (the architectural precedent, not a new idea)

| | quant-core-java | local_ai_service.py (Chronos) | langgraph-research |
|---|---|---|---|
| Process | separate, Java | separate, Python | separate, Python |
| Protocol | plain HTTP, loopback only | plain HTTP, loopback only | plain HTTP, loopback only |
| Broker credentials | none | none | none |
| Can place an order | no | no | no |
| Default | off (`QUANT_JAVA_CORE_ENABLED`) | on (companion assumed present) | **off** (`LANGGRAPH_RESEARCH_ENABLED`) |
| Failure mode | advisory unavailable, non-fatal | forecast unavailable, non-fatal | recommendation unavailable, non-fatal |

Off-by-default matches Java's polarity, not Chronos's, because this is a new, unvalidated,
shadow-only capability — not yet a normal expected companion.

## Phase 0 decision: which use case, and why

Two candidates came out of the read-only architecture assessment: (A) a semantic precedent/RAG
search, or (B) a strategy-graduation recommendation workflow. **B was chosen.**

- (A) would require **new infrastructure this codebase does not have and does not need for a first
  use case** — embeddings, a vector index, a real ingestion pipeline for historical decision text.
  The one prior attempt at "semantic memory" in this codebase (the `/api/v1/event-memory` route)
  was fabricated and is now permanently quarantined at HTTP 410 with a code comment admitting it
  invented similarity scores — repeating that mistake with a nominally "real" vector store was a
  much larger, riskier first step than justified.
- (B) requires **no new infrastructure**. `src/server/research/promotionEngine.ts` already computes
  exactly the structured evidence (`StrategyEvidence`, `deriveLifecycleStatus()`, `liveGoNoGo()`)
  this workflow needs — the only new surface is one read-only route
  (`GET /api/v2/research/strategy-evidence/:strategyId`) exposing what already exists. The gap it
  fills is real and documented: there is **no automated strategy-promotion pipeline at all** in
  Argus today (moving a strategy from `EXPERIMENTAL_STRATEGIES` to `CORE_STRATEGIES` requires a
  human hand-editing `StrategyEngine.ts`'s array literals and redeploying). This workflow produces a
  structured, evidence-grounded recommendation a human can read before doing that — it complements
  the existing promotion evidence ladder, it does not duplicate or replace it (the workflow never
  recomputes gate pass/fail itself; it only ever reads Argus's own already-computed answer).
- (A) is deferred, not rejected — it remains a legitimate second use case if a real embeddings
  pipeline is ever built as its own justified piece of work.

## HTTP contract

### Argus → LangGraph

`POST http://127.0.0.1:8090/v1/strategy-graduation-recommendation`

```json
// request
{ "strategyId": "MOMENTUM_BREAKOUT", "correlationId": "b1e8e3c8-..." }
```

```json
// response (COMPLETED)
{
  "runId": "...", "correlationId": "b1e8e3c8-...", "strategyId": "MOMENTUM_BREAKOUT",
  "graphVersion": "strategy-graduation-v2", "status": "COMPLETED",
  "result": {
    "lifecycleStatusAtRequest": "OOS_TESTING", "live": "NO-GO",
    "failedGatesAtRequest": ["MIN_PAPER_TRADES"],
    "recommendation": "NOT_YET_ELIGIBLE", "confidence": 0.3,
    "rationale": "...", "limitations": ["..."], "evidenceUsed": ["paperTrades"],
    "counterEvidence": ["Only 3 paper trades exist so far - well below a statistical sample."],
    "missingEvidence": ["No canonical dataset id is recorded for this strategy's evidence."],
    "evidenceStrength": "WEAK", "evidenceStrengthRationale": "3/22 Argus evidence gates currently pass.",
    "humanReviewRequired": true,
    "provenance": { "source": "argus_strategy_evidence_endpoint", "strategyId": "MOMENTUM_BREAKOUT", "fetchedAt": "..." },
    "modelGeneratedNarrative": "..."
  },
  "error": null, "durationMs": 4210.5, "nodesExecuted": ["fetch_evidence", "..."], "providerModel": "llama3.2:latest"
}
```

Phase 3 field semantics (each documented individually so the confidence-adjacent concepts below are
never collapsed into one number):

| Field | Source | Meaning |
|---|---|---|
| `confidence` | LLM self-reported | The model's own stated confidence in its narrative. **Not** a statistical confidence, **not** a validated win rate. |
| `evidenceStrength` / `evidenceStrengthRationale` | Deterministic (`nodes.py`'s `_derive_evidence_strength()`) | How many of Argus's own already-computed gate booleans are `true`, bucketed `NONE`/`WEAK`/`MODERATE`/`STRONG`. Never re-derives a gate; never influenced by `confidence`. |
| `live` / `failedGatesAtRequest` / `lifecycleStatusAtRequest` | Argus (`promotionEngine.ts`, read verbatim) | Lifecycle eligibility. The one hard invariant this whole workflow enforces: `validate_output_node` rejects any `PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW` recommendation when `live == "NO-GO"`. |
| `humanReviewRequired` | Deterministic (`validate_output_node`) | `true` unless `recommendation == "INSUFFICIENT_EVIDENCE"`. Never LLM-sourced. |
| `counterEvidence` | LLM, explicitly prompted ("what argues AGAINST advancing?") | May be empty, but the model is instructed to say so rather than omit silently - a quantitative research review, not a confirmation engine. |
| `missingEvidence` | Deterministic (`_derive_missing_evidence()`) | Real absence-of-evidence flags from actual `StrategyEvidence` fields (e.g. zero paper trades, no dataset id) - never an LLM guess. |

A `status: "FAILED"` response has `result: null` and a non-null `error` — Node's
`LangGraphResearchService.ts` validates every field before accepting either shape and rejects (never
coerces) anything malformed, missing, or echoing back a different `strategyId`/`correlationId` than
what was sent.

`GET /health` → `{ "status": "ok", "service": "langgraph-research", "version": "...", "capabilities": [...] }`.

No other endpoint exists. No arbitrary Python/SQL/shell execution, no filesystem access, no
database access is reachable through this API.

### LangGraph → Argus (the only outbound call Node data-wise)

`GET http://127.0.0.1:3000/api/v2/research/strategy-evidence/:strategyId` (`src/server/routes/researchRoutes.ts`)
— read-only, returns exactly one strategy's `StrategyEvidence` + derived lifecycle/go-no-go, never
a general query surface. 404 for an unrecognized strategy id.

### Human-review API (Phase 3) — browser → Node only, never browser → Python

Pure read routes over `research_agent_runs` (`src/server/research/researchRecommendations.ts`,
mounted in `researchRoutes.ts`). No route here mutates anything; every response is explicitly
labeled `disposition: "RESEARCH_RECOMMENDATION"`, `notATradingApproval: true`.

- `GET /api/v2/research/strategy-recommendations/:recommendationId` — one recommendation by id.
  404 `RECOMMENDATION_NOT_FOUND` if it doesn't exist.
- `GET /api/v2/research/strategy-recommendations?strategyId=X&limit=20` — most recent
  recommendations for one strategy, newest first (an immutable history, never "the current
  recommendation" overwriting a prior one). 404 `UNKNOWN_STRATEGY_ID` for an unrecognized id; `limit`
  is clamped to `[1, 100]`.

Both additionally surface, computed at **read time** (not generation time):

- `stale` / `evidenceAgeMs` — `true` once `result.provenance.fetchedAt` is older than
  `config/langGraphResearch.json`'s `researchRecommendationStalenessMs` (default 24h — see that
  file's own comment for the reasoning). Computed fresh on every read so a recommendation can never
  silently appear current forever; never baked into the persisted row.
- `failureReason` — re-derived from the existing `errorMessage` convention
  (`ResearchAgentRunner.ts` already writes `${reason}: ${detail}`) so `DISABLED` / `UNAVAILABLE` /
  `TIMEOUT` / `INVALID_RESPONSE` / a graph-side error code are never collapsed into one meaning,
  without any new DB column.

The one write action anywhere in the human-review surface is the pre-existing Phase 2
`POST /api/v2/research/strategy-graduation/:strategyId` — triggering a **new** research run (a new
row, never an edit of history), identical in effect to `argus-cli research-recommend`.

## Graph structure

```
fetch_evidence --(ok)--> check_gates --(evaluated)--> assess_risk_factors --(ok)--> synthesize_recommendation --(ok)--> validate_output --(passed)--> finalize_success --> END
     |(failed)                        |(not evaluated)        |(LLM failed)                |(LLM failed)                  |(violation found)
     v                                v                       v                             v                              v
finalize_error <---------------- insufficient_evidence -> finalize_success          finalize_error <----------------- finalize_error
     |                                                                                       ^
     +---------------------------------------------------------------------------------------+
     v
    END
```

Every branch is a real, distinct outcome: a brand-new strategy id with zero evidence takes the
`insufficient_evidence` shortcut and never calls an LLM; a real Argus or LLM failure at any stage
short-circuits to `finalize_error`; a recommendation that contradicts Argus's own `live == "NO-GO"`
result is caught by `validate_output` as a validation failure, never silently passed through. See
`langgraph-research/app/graph.py` and `nodes.py` for the implementation.

## State model

Explicit `TypedDict` sections (`langgraph-research/app/state.py`) — `request`, `evidence`,
`reasoning`, `validation`, `assessment`, `recommendation`, `error`, `metadata`. No unrestricted
arbitrary objects, no secrets (none exist in this workflow — Ollama needs no key). `assessment`
(Phase 3) is populated deterministically by `check_gates_node` on every path, including the
`insufficient_evidence` shortcut — it is never written by an LLM-touching node.

## Persistence / checkpointing

- **LangGraph's own checkpointer** (`MemorySaver`, in-process, never written to disk) exists only
  because LangGraph's `compile()` API expects one — this workflow completes in one bounded process
  lifetime and is never resumed mid-graph across a restart. It is **not** Argus's source of truth
  and is discarded when the process exits.
- **Argus's own persistence** (`research_agent_runs`, added via `drizzle/0055_natural_the_liberteens.sql`)
  is the durable record — written only by Node (`src/server/services/ResearchAgentRunner.ts`), after
  validating the Python response. The Python process never opens `data/argus.db` itself; there is no
  second SQLite writer.

| Column | Purpose |
|---|---|
| `id`, `correlation_id` | run identity, joins Node/Python logs |
| `kind`, `strategy_id` | e.g. `STRATEGY_GRADUATION_RECOMMENDATION` |
| `status` | `PENDING` / `COMPLETED` / `FAILED` / `UNAVAILABLE` |
| `result_json`, `error_message` | the outcome, exactly as validated |
| `graph_version`, `provider_model`, `duration_ms` | observability |

## Provider integration

Calls the **same local Ollama instance** Argus's Node side already uses
(`config/aiModels.json`'s `ollama.baseUrl`), over its OpenAI-compatible chat endpoint — deliberately
does not duplicate `AIRouter`'s full provider-abstraction/failover/HeavyModelMutex machinery, which
exists to route across 10 paid+local providers for the live trading path; this is one narrow,
local, free, advisory-only call. Handles connection failures, timeouts, rate-limits, and malformed
output explicitly (`llm_client.py`) with one bounded retry on transient errors only. A JSON-shaped
reply that arrives wrapped in a markdown fence or surrounding prose is still parsed correctly —
mirroring the exact `parseJsonFromLlmContent()` defensive-parsing discipline added to
`AIOutputValidator.ts` this same session. On any failure, the node returns an explicit error state;
nothing is ever fabricated as a fallback.

## Security boundary

- Binds `127.0.0.1` only.
- Zero broker credentials, zero `ALPACA_*`/`IBKR_*` env vars read anywhere in the service.
- Zero SQLite access — enforced by `langgraph-research/tests/test_safety_boundary.py` (Python-side
  static grep) and `src/server/langGraphArchitectureBoundary.test.ts` (Node-side, checks both the
  new TS files and the Python directory).
- Two-endpoint HTTP surface only; request bodies capped at 8KB.

## Shadow-mode / trading-safety boundary

A run here **cannot**: emit a live trade-idea or chief-approval event, call
RiskEngine/OrderManagement/BrokerManager, mutate `StrategyEngine.ts`'s strategy arrays, or promote
anything. Its output is advisory research a human may act on by hand — same posture as the existing
"Execute Override" human-in-the-loop path. This is enforced by automated tests, not merely
documented (see Testing below).

## Failure behavior

| Failure | Result |
|---|---|
| `LANGGRAPH_RESEARCH_ENABLED` unset | `DISABLED` — no network call made |
| Python process not running | `UNAVAILABLE` |
| Request exceeds `requestTimeoutMs` (Node, 45s) or `MAX_GRAPH_EXECUTION_S` (Python, 35s) | `TIMEOUT` / `GRAPH_EXECUTION_TIMEOUT` |
| Response fails schema validation | `INVALID_RESPONSE` — rejected, never coerced |
| Ollama unreachable/timeout/malformed | graph node fails closed, envelope `status: FAILED` |
| Any of the above | Argus's live trading engine is completely unaffected |

## Human-review UI (Phase 3)

`src/components/StrategyResearchRecommendations.tsx`, mounted in the existing `scanner` tab
directly below `ResearchLabPanel` (no new `AppTabId` was added — this is a small addition to an
existing research surface, not a new top-level tab). Read-only: a strategy-id selector, one
"Request New Recommendation" button (triggers the existing Phase 2 POST route — never a trading
action), and a list of past recommendations rendered from the Phase 3 read API, each explicitly
banner-labeled "RESEARCH RECOMMENDATION — NOT A TRADING APPROVAL". There is **no** Promote, Enable
Strategy, Live Trading, Risk Override, Place Order, or Approve Trade control anywhere in this file —
enforced by a static grep in `src/server/langGraphArchitectureBoundary.test.ts`, the same
belt-and-suspenders pattern already used for the Python/Node safety boundary.

## Observability

Every event (`langgraph-research/app/logging_setup.py`) is a JSON line with a `correlationId`
joining it to the Node-side request, which node ran, provider/model used, duration, and final
status — never a secret or full raw payload (long strings truncated).

## Configuration

`config/langGraphResearch.json` / `src/server/config/langGraphResearch.ts` — master flag
`LANGGRAPH_RESEARCH_ENABLED` (default unset/false), `baseUrl` (loopback-only, enforced), timeouts.
`langgraph-research/app/config.py` — same port via `LANGGRAPH_RESEARCH_PORT`, `OLLAMA_BASE_URL`,
`OLLAMA_MODEL`, retry/timeout bounds.

## Startup / launcher

Mirrors `chronosLauncher.ts`/`javaQuantCoreLauncher.ts` exactly: `scripts/lib/langGraphLauncher.ts`,
wired into `scripts/argus-engine.ts`, gated by `LANGGRAPH_RESEARCH_ENABLED=true` (off by default,
opt-in like the Java companion). Uses the same generalized duplicate-launch lock
(`scripts/lib/companionLaunchLock.ts`) as the other two companions.

```bash
# manual start (same as `npm run ai:serve` for Chronos)
python langgraph-research/app/server.py

# or let the engine daemon start it automatically
LANGGRAPH_RESEARCH_ENABLED=true npm run start:engine

# trigger a run manually
npm run argus-cli -- research-recommend --strategy=MOMENTUM_BREAKOUT
```

## Disable / remove

Unset (or never set) `LANGGRAPH_RESEARCH_ENABLED` — Argus behaves exactly as before this feature
existed. To remove entirely: delete `langgraph-research/`, `scripts/lib/langGraphLauncher.ts`,
`src/server/services/LangGraphResearchService.ts`, `src/server/services/ResearchAgentRunner.ts`,
`src/server/research/researchRecommendations.ts`, `src/components/StrategyResearchRecommendations.tsx`
(and its one mount line in `App.tsx`), `config/langGraphResearch.json`,
`src/server/config/langGraphResearch.ts`, the four new routes in `researchRoutes.ts`, the
`research-recommend` CLI command, and (optionally — it is purely additive and inert if left) the
`research_agent_runs` table.

## Testing

- `langgraph-research/tests/` — 58 pytest tests: every node independently (including Phase 3's
  deterministic evidence-strength/missing-evidence/counter-evidence/human-review-required
  behavior), full graph execution (success, insufficient-evidence shortcut, Argus/LLM failure
  short-circuits, conflicting-evidence rejection, strong-evidence bucketing, counter-evidence
  passthrough), HTTP contract (valid/invalid request, timeout, oversized payload, malformed JSON,
  concurrent isolated requests), and the Python-side safety-boundary static check.
- `src/server/services/LangGraphResearchService.test.ts` — 21 tests covering disabled/unavailable/
  timeout/malformed/mismatched-id/missing-or-invalid-Phase-3-field response rejection, health check.
- `src/server/research/researchRecommendations.test.ts` — the read/reshape layer against a real
  isolated test DB: id lookup, per-strategy history, distinct UNAVAILABLE-vs-FAILED failure reasons,
  read-time staleness computation, limit clamping, corrupt-JSON handling.
- `src/server/routes/researchRoutes.strategyGraduation.test.ts` /
  `researchRoutes.strategyRecommendations.test.ts` — the four HTTP routes.
- `src/server/langGraphArchitectureBoundary.test.ts` — the Node-side, cross-language safety-boundary
  check (mirrors `architecture.protection.test.ts`'s established pattern), extended in Phase 3 to
  cover `researchRecommendations.ts`, the frontend panel (no trading-control action, no fetch
  outside `/api/v2/research/*`), and the new routes' GET-only shape.
- No new frontend test framework was introduced (none exists yet anywhere in this SPA — a known,
  pre-existing gap, not something Phase 3 was asked to fix). Frontend safety is covered by the
  static architecture-boundary check above plus real runtime verification (see the Phase 3
  implementation report) rather than a new, unprecedented React Testing Library harness for one
  component.

## Known limitations (as of this implementation)

- Only reads one strategy's evidence; no cross-strategy comparison workflow yet.
- No cross-restart resumability — a run interrupted mid-graph is simply lost, never silently
  resumed with stale state (the correct fail-closed choice for a bounded advisory workflow).
- Depends on a local Ollama model being loaded; no fallback provider (by design — see "Provider
  integration" above).
- `recommendation`'s three-value enum (`PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW` /
  `NOT_YET_ELIGIBLE` / `INSUFFICIENT_EVIDENCE`) was kept unchanged from Phase 2 rather than expanded
  to the full taxonomy sketched in the Phase 3 brief (e.g. a separate `CONTINUE_TESTING` /
  `DO_NOT_ADVANCE`) — a deliberate minimal-churn choice, since the existing three values already
  satisfy the one hard requirement (never implying LangGraph itself promoted anything) and the new
  `counterEvidence`/`missingEvidence`/`evidenceStrength` fields carry the additional nuance instead.
- No frontend automated test coverage (React Testing Library or equivalent) — matches the rest of
  this SPA, which has none; see "Testing" above for what does cover this surface.
- Phases 4-5 of the original architecture assessment (wiring toward the existing promotion gate,
  closed-loop/autonomous learning) are explicitly **not** implemented here — this document now
  covers Phase 0-3 (isolated service, one real shadow-only workflow, and a human-reviewable
  recommendation with a read-only API/UI) only.
