# AI_MODEL_INVENTORY.md

**Phase 7 (ARGUS_PRE_IMPLEMENTATION_BASELINE.md).** Every agent that calls an AI provider, and
exactly what it calls, verified against current source this phase (`src/server/ai/AIRouter.ts`,
`src/server/ai/providers/*.ts`, each agent file). Marked `UNVERIFIED` where a live runtime trace
(not just source reading) would be needed to confirm — per this phase's own rule, "do not claim a
model is being used unless actual runtime traces prove it."

## Router

All AI calls go through `AIRouter.getInstance()` — no agent calls a provider directly (verified: no
`import.*providers/` outside `AIRouter.ts` and each provider's own test file). `routeTask()`
(sequential failover, one call site awaited by the caller) and `routeConsensus()` (parallel
`Promise.all` across every available provider, used only by `ChiefTraderAgent`'s optional adversarial
debate) are the only two entry points.

## Per-agent inventory

| Agent | Provider(s) | Model | Local/Remote | Input | Output | Confidence | Fallback | Timeout | Cost | Real usage |
|---|---|---|---|---|---|---|---|---|---|---|
| `FundamentalAgent.ts` | Whichever `AIRouter.routeTask()` selects (priority-sorted, health-aware) — real default rotation: Gemini → Grok/OpenRouter/LiteLLM/Ollama (`AIRouter.ts:initialize()`'s seeded default provider list) | Provider default unless a per-agent override exists (`AIRouter.setAgentRoute()`) | Mixed — Ollama/LiteLLM are local (`$0` cost); Gemini/Grok/OpenRouter are remote | Real AlphaVantage fundamentals data for 3 hardcoded symbols, formatted into a prompt | Structured JSON: `recommendation`/`confidence`/`reasoning` | Real, coerced via `AIOutputValidator.clampScore` (0-100) | On malformed/failed response: `AIOutputValidator` degrades to `HOLD`/0-confidence — never a fabricated BUY/SELL (tested, `FundamentalAgent.test.ts`) | **20s (Phase 1, new)** | Real per-call, tracked in `ai_usage` | 60s timer, always on |
| `MacroAgent.ts` | Same routing as `FundamentalAgent.ts` | Same | Same | Real AlphaVantage macro data, 3 hardcoded symbols | Same shape | Same | Same degrade-to-HOLD behavior (tested, `MacroAgent.test.ts`) | **20s (Phase 1, new)** | Real, tracked | 75s timer, always on |
| `NewsEngine.ts` / `NewsScoringEngine.ts` | Same routing; per `CLAUDE.md`, NewsAgent's calls preferentially route through the local Ollama stack (`$0`/call) via a per-agent routing override, with FinBERT sentiment as the primary signal and the AI call as a secondary/interpretive layer | Ollama-hosted model (local) when the override is active; falls back to the router's normal priority order otherwise | Primarily local | Real RSS/paid-API news content | Structured sentiment/impact JSON | Real, coerced | Same `AIOutputValidator` pattern (tested, `NewsScoringEngine.test.ts`) | **20s (Phase 1, new)** | Real ($0 for the local path) | Event-driven (real news ingestion), always on |
| `ChiefTraderAgent.ts` (adversarial debate) | `AIRouter.routeConsensus()` — **all** available providers in parallel, not one | Provider default per participant | Mixed | Aggregated evidence + prompt asking for a structured BUY/SELL/HOLD + confidence + supporting/risk factors | Structured JSON, `coerceEnum`/`clampScore`/`coerceStringArray`-validated | Real, 0-100 scale (a real, previously-flagged in-code scale-consistency note exists around the hardcoded 50/80 injected values noted in `ARGUS_SAFETY_HARDENING_REPORT.md`'s research — not re-litigated here) | A provider that errors out contributes `status:"error"` to the aggregate; the consensus still resolves from whichever providers succeeded (tested, `ChiefTraderAgent.test.ts`, `AIRouter.test.ts`) | **20s per provider (Phase 1, new)** | Real, tracked per provider | Conditional — only when `settings.adversarialDebateMode` (default true) AND the triggering idea's confidence > 0.6 |
| `QuantContradictionAnalyzer.ts` (quant layer) | `AIRouter.routeTask()` | Provider default | Mixed | The deterministic quant assessment (regime/strategy/scores) | `disagreementNote` (string) + `aiAgreesWithSide` (boolean\|null) — **never** a side/confidence value | N/A (qualitative only) | On failure, `aiContradictionAnalysis` is simply `null` — the deterministic assessment proceeds unaffected (tested, `QuantContradictionAnalyzer.test.ts`) | **20s (Phase 1, new)** | Real, tracked | Only when `QUANT_ENGINE_ENABLED=true` (this repo's actual `.env`: `true`) and a real quant idea was generated |
| `KronosForecastAgent.ts` / `KronosInference.ts` | **Not an AIRouter call** — a persistent local HTTP service (`npm run ai:serve`, `scripts/local_ai_service.py`), loading `amazon/chronos-t5-mini` via the real `chronos-forecasting` package | Local only, `$0` | Real historical OHLCV | Numerical price forecast | N/A (a forecast, not a decision) | `KronosModelManager` polls the service's own `/health` every 30s and reports honestly if unavailable | No AIRouter timeout applies (different call path) — **UNVERIFIED this phase** whether the local service call itself has its own timeout; not traced this pass | N/A ($0, local) | **UNVERIFIED this phase** whether the service is actually running in this environment right now — `agentWeights['KronosEngine']=0.20` exists in `ChiefTraderAgent.ts`, but whether it is actively contributing live evidence depends on that separate local process being up |

## Real providers wired (`AIRouter.ts`)

Gemini, DeepSeek, OpenAI, Nvidia, and a generic OpenAI-compatible adapter (covers Grok, OpenRouter,
LiteLLM, and Ollama at `http://localhost:11434/v1`). Real sequential failover in `routeTask()`
(tries the next provider in priority order on any error, including the new Phase 1 timeout); real
parallel aggregation in `routeConsensus()`. Provider `health`/`successRate` are real, persisted,
and update after every real call (`aiProviders` table) — a provider whose `successRate` decays below
50 is marked `Offline` and moved to the back of the priority order, not excluded entirely (still
tried last-resort if every other provider also fails).

## Reliability additions this phase (Phase 1 + Phase 7)

- **Timeout**: 20s per provider call, both `routeTask()` and `routeConsensus()` (Phase 1,
  `AIRouter.test.ts` proves a hung provider never blocks the caller and fails over correctly).
- **Retry policy**: cross-provider (the existing failover loop), not same-provider retry — a timed-
  out provider is not retried against itself; the router moves to the next one immediately, which
  is faster and doesn't waste another full timeout window on a provider that just proved unresponsive.
  `OpenAICompatibleProvider.ts` additionally has its own pre-existing internal retry (2 attempts,
  backoff) for local-endpoint transient failures — unchanged this phase.
- **Circuit breaker**: real, pre-existing (`health`/`successRate` decay → `Offline` → deprioritized).
  Not a hard-fail-fast circuit breaker like `AlpacaBroker.ts`'s new one (Phase 1) — a "known-dead"
  provider is still attempted as a last resort if nothing else is available, by design (an AI
  provider recovering is a normal, frequent event; a broker being genuinely down usually isn't
  transient in the same way).
- **Malformed response handling / schema validation / confidence bounds**: real, pre-existing,
  applied at every real parse site (`AIOutputValidator.ts` — `coerceEnum`, `clampScore`,
  `normalizeConfidence01`, `coerceString(Array)`). Re-verified this phase, unchanged.
- **Reproducibility**: real, new this phase — `AI_DECISION_TEMPERATURE = 0.2` now passed to every
  real trading-decision call across all 5 providers (additive `temperature` param, opt-in per call
  site, backward compatible with any caller that doesn't supply one). This measurably reduces
  run-to-run variance without forcing fully deterministic sampling (temperature 0 handles some
  providers' longer structured-JSON outputs poorly).
- **AI can never directly trigger an order / override deterministic risk controls**: re-verified
  this phase (independently confirmed by two separate research passes during the audit that
  produced this baseline) — every path from an AI-influenced decision to a real order passes through
  `RiskAgent.ts` → `RiskEngine.evaluateRisk()` unconditionally. No exception exists.
- **AI failure → HOLD, never a fabricated BUY/SELL**: real, pre-existing, tested
  (`FundamentalAgent.test.ts`, `MacroAgent.test.ts` both assert this explicitly for
  RATE_LIMITED/UNKNOWN/malformed responses).

## Explicitly NOT done this phase (real gaps, honestly deferred, not silently skipped)

- **Hallucination-resistant fact-checking**: `AIOutputValidator.ts` enforces *structural* validity
  (the response parses, fields are the right type/range) — it does **not** verify that an AI's
  stated reasoning or claimed facts are actually consistent with the real input data it was given.
  `MarketDataCrossChecker.ts` exists but only cross-checks raw price feeds against each other, never
  AI output. Building real fact-checking (e.g., verifying a `FundamentalAgent` response's claimed
  numbers against the real AlphaVantage data it was given) is a real, valuable, and non-trivial
  addition — scoped as a P1 item for a future phase, not attempted here.
- **Full historical AI backtesting**: still zero — see `ARGUS_AI_VALIDATION_REPORT.md` (Phase 9) for
  the staged plan and why this phase does not attempt it.
- **True request cancellation for AI provider calls**: the Phase 1 timeout is a router-level "soft"
  timeout (`Promise.race`) — the underlying HTTP request to the provider is not aborted the way
  `AlpacaBroker.ts`'s `AbortController`-based timeout cancels a broker request. Documented as a
  known limitation in `ARGUS_SAFETY_HARDENING_REPORT.md`, not silently left unstated here either.
