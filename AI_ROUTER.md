# Argus - AI ROUTER

Real implementation reference for `AIRouter`, verified against `src/server/ai/AIRouter.ts` and `src/server/ai/providers/*` on 2026-08-08. This file was previously generic boilerplate identical to several other stub docs in this repository — replaced with real content.

---

## What it does (real)

`AIRouter` (`src/server/ai/AIRouter.ts`) is the single required entry point for every LLM call in this codebase. No agent should instantiate a provider SDK directly.

```ts
class AIRouter {
  private providers: Map<string, AIProvider> = new Map();
  private agentRouting: Map<string, {providerId, model}> = new Map();

  async initialize() {
    // reads ai_providers from the DB; seeds 4 defaults (Gemini, OpenRouter, LiteLLM, Ollama) if empty
    // for each enabled row: decrypts the key, picks a concrete provider class by name/endpoint heuristics,
    // wrapped in a per-provider try/catch so one bad decrypt doesn't abort the whole boot
  }

  async routeTask(agentType, prompt, traceId) {
    // sorts registered providers by: settings.priority -> health -> successRate -> latency
    // moves any agent-pinned provider (via setAgentRoute) to the front
    // tries each in sequence; on success, logs to ai_usage and updates an EMA-based
    // health/successRate; on failure, fails over to the next provider
  }

  async routeConsensus(agentType, prompt, traceId) {
    // fans out to EVERY registered, enabled provider in PARALLEL via Promise.all
    // used by ChiefTraderAgent's multi-model debate feature
    // each provider is asked to return {decision, confidence (0-100 scale here), reasoning, ...}
    // aggregates into a consensus_verdict by summing confidence-weighted BUY/SELL votes
  }
}
```

## Real provider implementations

| Provider | File | Real network call | Model override respected | `estimateCost()` |
|---|---|---|---|---|
| Gemini | `GeminiProvider.ts` | ✅ `@google/genai` SDK | ❌ hardcoded `gemini-2.5-flash` | always `0` |
| OpenAI | `OpenAIProvider.ts` | ✅ raw `fetch` to `api.openai.com` | ❌ hardcoded `gpt-4o` | always `0` |
| DeepSeek | `DeepSeekProvider.ts` | ✅ raw `fetch` to `api.deepseek.com` | ❌ hardcoded `deepseek-coder` | always `0` |
| NVIDIA (NIM) | `NvidiaProvider.ts` (extends `OpenAICompatibleProvider`) | ✅ | ✅ | always `0` |
| OpenAI-compatible (OpenRouter/LiteLLM/Ollama/Groq/local) | `OpenAICompatibleProvider.ts` | ✅, with real 429/5xx retry+backoff | ✅ | always `0` |

## Known bugs in this layer (verify before assuming they're fixed)

1. **Cost tracking is fake across every provider.** `estimateCost()` is only ever the inherited `BaseAIProvider` default, which returns `0`. Every `ai_usage.cost` and `ai_providers.cost` value is `$0` regardless of real spend. `GeminiProvider.chat()` also hardcodes `tokens: 0` instead of reading `response.usageMetadata`.
2. **Model overrides are silently ignored by 3 of 5 providers.** If you call `AIRouter.setAgentRoute(agent, providerId, model)` and that provider is Gemini/OpenAI/DeepSeek, the requested `model` is discarded and the provider's hardcoded default is used instead. Only NVIDIA/OpenAI-compatible respect it.
3. **Cross-wired env fallback.** `OpenAIProvider.initialize()` and `DeepSeekProvider.initialize()` both resolve their key as `apiKey || (process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY)` — identical fallback order in both classes. If only one of those two env vars is set, the *other* provider will still report `authenticate() === true` and send a request to the wrong vendor's endpoint with the wrong key.
4. **Newly-saved providers aren't routable until a restart.** `configRoutes.ts`'s `POST /providers` handler ends with `AIRouter.getInstance().registerProvider(provider, provider)` — this registers a string (`provider`, the provider name) where an `AIProvider` instance is expected. `AIRouter.initialize()` only runs once, at server boot, so a provider added through the UI has no effect on routing until the process restarts.
5. **`ai_models` is decorative.** Seeded by `seedModels.ts` with 6 rows (including a nonexistent `"Claude"` provider — there is no `ClaudeProvider` class anywhere in this codebase). `AIRouter`'s actual routing reads only `ai_providers`, never `ai_models`.
6. **`health()` and capability flags can lie.** Every concrete provider inherits `BaseAIProvider.health()`'s default (`return 'Healthy'`) — none overrides it with a real check. Some providers set `supportsStreaming()`/`supportsVision()` to `true` without actually overriding the corresponding `stream()`/`vision()` methods (which remain the `BaseAIProvider` no-ops).

## Confidence scale convention (important, previously a source of real bugs)

Every real `TRADE_IDEA_GENERATED` emitter uses a **0-1 confidence scale**. `routeConsensus()`'s debate prompt asks providers for a **0-100 scale** internally (`"confidence": 0-100` in the prompt), and `ChiefTraderAgent` normalizes the debate's resulting side to `0.5` (HOLD) or `0.8` (BUY/SELL) on the 0-1 scale before mixing it into the same weighted-average pool as everything else — a prior version of this normalization used `50`/`80` directly, which silently broke the consensus math's `[0,1]` clamp and could auto-approve almost any debated trade. If you add a new agent or a new AI-driven scoring step, make sure whatever confidence value you emit into `TRADE_IDEA_GENERATED` is normalized to `[0, 1]` before emitting.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference, § Key Components → AIRouter
- [AI_AGENTS.md](./AI_AGENTS.md) — which agents call into this router and how
- [AGENTS.md](./AGENTS.md) — guidance for adding a new provider
