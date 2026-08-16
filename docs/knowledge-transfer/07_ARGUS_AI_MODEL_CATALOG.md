# 07 — AI model / provider catalog

**Router-native classes:** Gemini, OpenAI, DeepSeek, Nvidia (`OpenAICompatibleProvider`), OpenAI-compatible (Ollama `http://localhost:11434/v1`).

**Env keys without a provider class:** `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `KIMI_API_KEY`, `GROK_API_KEY`, `GROQ_API_KEY` — **DISABLED unless** pointed at an OpenAI-compatible endpoint row in DB.

| Model/stack | Provider | Purpose | Agent | Structured? | Timeout | Local | Enabled |
|---|---|---|---|---|---|---|---|
| gemini-* | Gemini SDK | Debate, fund/macro/news | Routed | JSON mode optional | 20s abort | No | If key + DB |
| gpt-* | OpenAI fetch | Same | Routed | jsonMode | 20s | No | If key |
| deepseek | DeepSeek fetch | Same | Routed | | 20s | No | If key |
| NVIDIA integrate | Nvidia | Same | Routed | | 20s | No | If key |
| llama/plutus/etc | Ollama compat | Cheap routing | Routed | | 20s | Yes | If running |
| Chronos-T5-mini | Python `:8008` | Forecast | KronosForecastAgent | Numeric forecast | HTTP | Yes | Companion |
| FinBERT | Same Python | News sentiment fallback path | News scoring | Score | HTTP | Yes | Companion |
| OpenAlice Guardian | MCP | Non-blocking verify | After chief | Tools | MCP | Local | Both env flags |
| XGBoost | Mentioned in old UI | — | Not wired to live path | — | — | — | DEAD / NOT live-eligible |
| Claude direct | — | — | — | — | — | — | MISSING class |
| Grok/Groq/Kimi | env only | — | — | — | — | — | MISSING class |

Cost: `estimateCost()` published prices; local $0. Ledger: `ai_calls` fire-and-forget.

Failure: failover next provider; `AITimeoutError`; AIFailureCircuitBreaker can `TRADING_PAUSED` after threshold (`aiFailureThresholdForLivePause`).

Health: ModelRuntimeManager; `MODEL_HEALTH` events. Kronos honest unavailable.

**FINAL_ANALYSIS §15.21 once listed Grok as “Real”** — **code: no GrokProvider**. Ground truth = classes in `src/server/ai/providers/`.
