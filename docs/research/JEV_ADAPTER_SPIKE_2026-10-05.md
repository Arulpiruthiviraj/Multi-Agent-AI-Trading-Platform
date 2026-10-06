# Jev (TypeSafe AI) Adapter — Research Spike

**Status:** spike on branch `research/jev-adapter`. Not wired into any live decision path. Not merged to main.

## What it is

TypeSafe AI's Jev (launched 2026-09-15) is a "System One" decision model: `state` + typed
questions in, typed probabilistic answers out. No text generation. Three question types:

| Type | Ask | Get back |
|---|---|---|
| `noul` | yes/no question | P(yes) in [0,1] |
| `choice` | question + option criteria (≤255) | chosen option, per-option probabilities, confidence |
| `score` | question + ordered levels (2–10) | score, legend, per-level probabilities, confidence |

Wire: `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, body
`{model, state, questions}` → `{model, answers, usage}`. Pricing: $0.042/1M input tokens,
output free. Vendor-claimed latency 70–500ms.

## What was built

- `src/server/ai/providers/JevProvider.ts` — full `AIProvider` implementation.
  `evaluate()` / `askYesNo()` speak the SystemOne API; `chat()`/`stream()`/`embeddings()`/
  `vision()`/`image()` fail closed with a clear "does not generate text" error.
  Answer validation is strict: missing key, type mismatch, non-finite probability,
  or undeclared choice option → `JevAnswerValidationError`, never a synthesized value.
  Retries 429/529/5xx (×2, backoff); never retries 401/422.
- `src/server/ai/providers/JevProvider.test.ts` — 15 tests, mocked HTTP.
- `src/server/ai/AIRouter.ts` — provider-creation branch (name contains `jev`/`typesafe`);
  `envKeyForProviderName` accepts `JEV_API_KEY` / `TYPESAFE_API_KEY`.
- `.env.example` — `JEV_API_KEY` with explanatory comment.
- `scripts/jev-smoke.ts` — live smoke (skips without key; costs ~$0.00002 when run).

Verified: `tsc` clean; 162/162 `src/server/ai/` tests pass (15 new).

## Where it could fit Argus (evaluated, not decided)

Cheap first-pass triage inside the confidence-gated AI routing layer: news sentiment
classification, trigger gating — escalate to real LLMs when Jev's confidence is low.
Independent tests: good calibration on classification (error ~0.03–0.10), poor on
answer-quality rating. "Can't hallucinate" = can't return out-of-schema values; it can
still be confidently wrong within the schema.

## Open before any production use

1. Live smoke with a real key (`JEV_API_KEY=... npx tsx scripts/jev-smoke.ts`).
2. Measure real latency/cost/calibration on Argus's own news-sentiment task.
3. Decide the consumer: a dedicated triage service calling `evaluate()` — never chat routing.
4. Vendor is 3 weeks old; treat pricing/limits as subject to change.
