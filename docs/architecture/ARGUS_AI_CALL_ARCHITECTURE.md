# Argus AI-Call Architecture — Jev / TypeSafe Integration

**Status:** Implemented 2026-10-07 on `feat/quant-first-decision-architecture` (pending
review/merge). **PAPER-first. LIVE_NO_GO.** Canonical summary lives in
`docs/architecture/ARGUS_ARCHITECTURE.md` § "2026-10-07: Jev / TypeSafe AI integration";
this document is the full design reference.

**§0 — Why this doc exists as a separate file.** The mission required a named design
deliverable. The repo rule ("one living architecture reference") is honored by keeping the
authoritative summary in `ARGUS_ARCHITECTURE.md`, written in the same change. This file
carries the deep reference: contracts, diagrams, failure semantics, and test evidence
pointers. If the two ever disagree, `ARGUS_ARCHITECTURE.md` wins.

---

## 1. Quant-first principle (non-negotiable)

Argus is a quantitative trading system that can use AI when AI adds value — not an AI
trading bot with quant features. Concretely:

- Validated quantitative strategies must be capable of operating with **zero** AI
  providers available (Jev, Ollama, OpenAI, Gemini, Mistral, OpenRouter, NVIDIA, all).
- AI may enrich news, macro, research, context, catalyst interpretation, and post-trade
  analysis. It is never execution authority.
- AI-originated ideas (news/macro/AI-research/experimental) remain **fail-closed** when
  required AI evidence is unavailable.
- AI availability must NEVER control whether an authorized validated quant strategy is
  allowed to reach RiskEngine.

The default state of the entire AI subsystem is **NO AI CALL**. A price tick is never a
reason to call AI. A material event is a reason to *consider* calling AI.

## 2. Architecture

```
Market Data / News
       │
       ▼
Deterministic Quant pipeline ──► QuantExecutionPolicy (AI-free, deterministic)
       │                                    │
       │                          AI IS NOT REQUIRED
       │                                    ▼
       │                          ChiefTrader (policy router)
       │                                    ▼
       │                          RiskEngine (26 gates, mandatory)
       │                                    ▼
       │                          PositionSizing → OMS → BrokerManager
       │
Material events only:                    ┌──────────────┐
  new catalyst ─┐                        │ AICallGovernor│
  regime change ─┼──► "is AI useful?" ──► │  (the gate)   │
  quant candidate┼                        └──────┬───────┘
  conflict ─────┘                               │
                        ┌───────────────────────┼───────────────────────┐
                        ▼                       ▼                       ▼
                 JevDecisionProvider   generative executor        SKIPPED + reason
                 (STRUCTURED_DECISION) (via AIRouter)             (the common case)
                        │                       │
                        └───────────┬───────────┘
                                    ▼
                          optional advisory context
                          (observability + aiAdvisoryNote;
                           NEVER gates a decision)
```

**Capability-based routing** (`AICallGovernor → JevDecisionProvider | AIRouter`):
Jev advertises `STRUCTURED_DECISION`. It is deliberately NOT forced into a
chat-completions abstraction — structured state → typed decisions is a fundamentally
different capability from generative analysis. Do not route narrative research to Jev;
do not route simple classification to an expensive generative LLM unless necessary.

**Jev's role** (bounded, typed, batched): news relevance/materiality/catalyst
classification, duplicate-vs-new judgment, structured contradiction checks, triage for
whether expensive generative analysis is warranted (two-stage cascade: most events die at
Level 0 = no AI; many of the rest die at Level 1 = Jev; very few reach Level 3 =
strong/expensive model). Never "analyze this stock and tell me whether to buy."

**Never ask AI for deterministic math**: RSI, MACD, ATR, VWAP, volatility, EV, R:R,
position size, P&L, drawdown, exposure, VaR, moving averages, RiskEngine gates — code
does those (Java 26 Engine Authority for new quant math; control-plane reuse for policy).

## 3. AICallGovernor — the gate

`src/server/ai/AICallGovernor.ts`. Every optional AI request goes through
`governor.request({capability, kind, material, jev?, run?})`. Check order (first hit
wins); each outcome emits a structured observability event:

1. `DISABLED` — governor or capability switch off
2. `STALE_EVENT` — decision deadline already passed
3. `DEADLINE_TOO_CLOSE` — not enough lead time for the result to matter
4. `NOT_MATERIAL` — below the kind's materiality floor
5. `CACHE_HIT` — fingerprint seen, result fresh (per-kind TTL)
6. `DUPLICATE` — same fingerprint already in flight → **singleflight join** (callers
   share the one pending result; counted, not re-called)
7. `SYMBOL_COOLDOWN` — per-symbol cooldown active
8. `GLOBAL_BUDGET` / `PROVIDER_BUDGET` — per-minute token buckets exhausted
9. `PROVIDER_UNHEALTHY` / `NO_API_KEY` — no usable provider
10. `CIRCUIT_OPEN` — breaker open after consecutive failures
11. `QUEUE_FULL` — bounded in-flight + queue saturated
12. `SHOULD_CALL` — proceed

**Fingerprint** = stable stringify of `{capability, kind, model, schemaVersion, symbol,
...sorted material parts}`. Volatile fields (wall-clock, traceId) are never included —
including them would make every fingerprint unique and defeat the cache.

**Cache TTLs** (`config/aiCallGovernor.json`, per data type): news triage 1h (article
identity), regime 15m, quant advisory 2m, premarket enrichment 30m, post-trade research
24h. Max entries 500, LRU eviction.

**Circuit breaker** (per provider): N consecutive tripping failures
(TIMEOUT/RATE_LIMIT/OVERLOAD/SERVER/NETWORK) → OPEN for cooldown → HALF_OPEN with
bounded probes → CLOSED on success, OPEN on failure. AUTH/VALIDATION/NO_API_KEY do not
trip the breaker (bad key ≠ sick provider).

**No fallback, ever.** A failed Jev call is never automatically retried on an expensive
LLM — otherwise a Jev outage becomes an OpenAI/Gemini/Mistral cost explosion. Optional
AI that fails becomes UNAVAILABLE; the quant path continues unchanged.

## 4. JevDecisionProvider

`src/server/ai/JevDecisionProvider.ts` wraps the existing `JevProvider`
(System One wire format: `POST {base}/v1/systemone`, `Authorization: Bearer <key>`,
`{model, state, questions}` → typed `answers`). Structured error taxonomy:

`NO_API_KEY | AUTH(401) | RATE_LIMIT(429) | OVERLOAD(529) | SERVER(5xx) |
NETWORK | TIMEOUT | VALIDATION(422/malformed) | ABORTED | UNKNOWN`

with `retryable` flags (never retry AUTH/VALIDATION/NO_API_KEY). Multi-question
batching is native — one request carries all related questions for a state (e.g. news
triage: `relevant` noul + `catalyst_type` choice + `materiality` score +
`needs_deeper_research` noul). Defense-in-depth key redaction on every error path;
the key is never logged, never in observability payloads, never in the DB.

`JEV_API_KEY` (Argus convention; `TYPESAFE_API_KEY` also accepted) is read from the
server environment only. Model configurable (`jevModel`, default `jev-latest`);
capability discovery (`GET /v1/models`) exists but is only invoked by the opt-in
smoke test — never per request, never at startup.

## 5. Event-driven triggers (advisory-only, fire-and-forget)

`src/server/ai/AiAdvisoryService.ts`. All entry points are synchronous, never throw,
and can never gate/delay/alter a trading decision:

- **News catalyst triage** — hooked in `NewsEngine` after cluster acceptance
  (genuinely-new articles only; never duplicates, never empty polls). One batched Jev
  call per article; result → observability + short-TTL advisory note.
- **Quant candidate advisory** — fired AFTER a quant policy decision is recorded
  (approve or reject path). Result → observability only.
- **Premarket enrichment** — kind registered in config; wiring deferred (see §9).

The advisory note is read synchronously from an in-memory cache by
`ChiefTraderAgent.evaluateQuantPolicy` and passed as `aiAdvisoryNote` into
`QuantExecutionPolicy`, which **records it and never consults it** (provably
non-gating; certified by parity tests). Absent note → `null` → existing behavior.

## 6. Failure semantics (certified)

| Jev state | Validated quant | AI-originated idea |
|---|---|---|
| timeout / 429 / 500 / network / circuit open / no key | proceeds; `AI_CONTEXT_STATUS=UNAVAILABLE`; policy decision byte-identical to Jev-healthy | fails closed (no approval, no invented confidence) |

Protective exits (stop/take-profit/risk-exit/CLOSE_LONG), RiskEngine, reconciliation,
and OMS never wait for or require Jev — enforced by architecture tests, not just
convention.

## 7. Prohibitions (statically tested)

- No Jev/AIRouter network call from hot tick/quote/websocket/bar-update paths
  (`hotPathProhibition.test.ts`).
- `QuantExecutionPolicy`, `QuantStrategyAuthorization`, `tradeIdeaProvenance` never
  import from `src/server/ai/` (`quantAiIndependence.test.ts`).
- Jev/governor/advisory never import BrokerManager/OrderManagement/RiskEngine/
  ChiefTraderAgent; never emit `CHIEF_APPROVED_IDEA`.
- The pre-existing shadow scorer (`JevNewsTriage.kickOffJevShadowScoring`, flag-gated
  off by default) is untouched and independent of the governor path.

## 8. Observability & cost control

Events: `AI_CALL_CONSIDERED/SKIPPED/CACHE_HIT/SINGLEFLIGHT_JOINED/STARTED/COMPLETED/
FAILED`, `AI_PROVIDER_CIRCUIT_OPENED/HALF_OPEN/RECOVERED`, `JEV_DECISION_COMPLETED` —
all with kind/symbol/fingerprint-hash/latency, never request bodies. Diagnostics
expose calls/hour, success/cache-hit/skip/timeout rates, P50/P95/P99 latency,
in-flight count, circuit states, and the headline metric: **AI call-avoidance rate**
(considered vs actually called).

## 9. Known limitations / follow-ups

- `JEV_REAL_SMOKE_TEST = NOT_RUN` — no key exists in CI/dev; the opt-in
  `argus ai test jev` command is implemented and manually verified (no-key → NO-GO).
- Premarket enrichment wiring deferred: `TradePlanBuilder.buildTradePlanDrafts` is a
  pure synchronous contract with no production caller yet; wire at the premarket job's
  final-candidate-set point when one exists.
- Generative-capability routing through the governor exists as an interface
  (`setGenerativeExecutor`) with no live callers yet — existing agents keep their
  current `AIRouter` usage; retrofitting them is a separate, larger change.
- Vendor pricing/latency figures in code comments are vendor claims, not measurements.

## 10. Test evidence

- `JevDecisionProvider.test.ts` (20), `JevProvider.test.ts` (16): typed parsing,
  multi-question single-call, error taxonomy, key-leak redaction.
- `AICallGovernor.test.ts` (35): every skip reason, cache, singleflight
  (20→1), budgets, circuit lifecycle, deadline skips, 1000-event cost-storm
  (5 bounded calls, circuit OPEN, zero fallback).
- `jevFailureSemantics` (3), `jevCallReduction` (4), `jevAiValue` (4):
  byte-identical quant decisions across all Jev failure modes; measured reduction
  (100 identical → 1 call; 100 non-material → 0; 20 dup articles → 1).
- Prohibition suites: `quantAiIndependence` (7), `hotPathProhibition` (6),
  `protectiveExitAiIndependence` (5), `riskAndReconciliationAiIndependence` (5).
- Anchor: `AiOfflineQuantCertification.test.ts` 5/5 throughout.
