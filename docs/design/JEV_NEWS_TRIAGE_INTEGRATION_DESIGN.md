# Jev Decision-Model Integration — Design

**Status:** design only. The adapter (`JevProvider`) is on main; nothing consumes it.
No wiring to any trading path, paper or otherwise, until the phases below are approved.

## 1. Problem

Most of Argus's AI providers are down, and the LLM calls that remain are expensive and
slow. The goal: use AI only where it earns its cost, feed it complete validated data, and
make exactly one request per decision — never several.

## 2. AI call-site inventory (verified in code, 2026-10-05)

| Call site | What it asks the AI for | Needs generated reasoning? |
|---|---|---|
| `NewsScoringEngine.analyzeWithAI` — per-article `routeTask('NewsAgent', …)` | sentiment, market impact, trading bias, surprise, contradiction — pure classification as JSON | **No** |
| `FundamentalAgent` — per-symbol fundamentals | summary, recommendation, supporting evidence, risks, reasoning | Yes |
| `MacroAgent` — macro indicators | summary, recommendation, supporting evidence, risks, reasoning | Yes |
| `ChiefTraderAgent` — `routeConsensus` debate, bull/bear research agents | debate positions, reasoning chains | Yes |
| `MarketRegimeAgent`, `ExplainabilityAgent`, `EvolutionHypothesis` | regime reasoning, explanations, hypotheses | Yes |

**Conclusion:** news scoring triage is the single correct insertion point. Jev is a
decision model — typed probabilistic answers, zero text generation. It structurally cannot
serve any call site that needs reasoning, and must never be asked to.

## 3. Why news scoring fits

- It is the highest-volume AI consumer in Argus (one LLM call per article).
- Its output is already a fixed schema of scores and enums — exactly Jev's native shape.
- Jev's answers are schema-bound by construction, which neutralizes the prompt-injection
  class `NewsScoringEngine` currently defends against with delimiter escaping: untrusted
  article text can only ever come back as probabilities, never as instructions.
- Independent tests show good calibration on classification (error ~0.03–0.10) — the task
  at hand — and poor answer-quality rating, which we are not asking it to do.

## 4. Design

### 4.1 Perfect-data input contract

One validated `JevNewsState` object is built per article, before any network call:

- **Required fields:** title, content, source, `publishedAt` (parseable), symbol (must pass
  `looksLikeListedTicker`).
- **Freshness gate:** articles older than the configured horizon are marked unscored with
  zero requests — stale news never spends a call.
- **Deterministic context bundled in:** category, credibility score, cluster novelty/isNewCluster —
  everything Jev needs is in the single state; it never has to guess what the LLM path knew.
- **Fail closed:** any missing or invalid field → unscored, no request. Never send a partial
  state and hope.

### 4.2 Single request, batched questions

One `evaluate()` per article, all questions in the same call — Jev answers them in parallel
off one shared state read:

| Key | Type | Asks |
|---|---|---|
| `is_relevant` | noul | Is this article relevant to trading decisions for this symbol? |
| `sentiment` | choice (bullish/bearish/neutral + criteria) | Directional implication with confidence |
| `market_impact` | score (0–10 levels) | Significance of the news |
| `is_surprise` | noul | Genuine surprise vs already priced in |
| `has_contradiction` | noul | Contains conflicting claims or disputes an earlier report |
| `urgency` | score (0–10 levels) | Time sensitivity |

Never one request per question — that would erase the cost and latency advantage entirely.
(Multi-article batching inside one state is explicitly deferred: only after single-article
calibration is proven on real data.)

### 4.3 Confidence-gated escalation

Jev is the cheap first pass; the LLM is reserved for where reasoning earns its cost:

1. Jev scores the article (fast, ~$0.00002).
2. If sentiment + relevance confidence ≥ threshold → accept; the LLM is never called.
3. If confidence is low, or the article is high-stakes (credible source × high impact) →
   escalate to the existing LLM path for full reasoning.

This reuses the `EscalationPolicy.decideEscalation` pattern (local signal + decisive
threshold → escalate-or-not with a recorded reason) rather than inventing a new mechanism.
Every skip and every escalation is logged with its reason.

### 4.4 Usage discipline

- **Deduplication:** never rescore the same article or cluster (the existing cluster
  tracking is the dedup key).
- **Scope:** only articles tied to tracked symbols are scored at all.
- **Cost:** `AICostGovernor` already prices Jev correctly via the adapter's `estimateCost`.
- **Rate limits:** the provider retries 429/529 with backoff and never retries 401/422.
- **Observability (from day one):** log the scoring path per article (`jev` / `llm` /
  `local` / `unscored` + reason); on every escalated article, record Jev-vs-LLM agreement.
  That agreement ledger is the calibration evidence required before Phase 3.

### 4.5 Output mapping

Jev's answers map back into the existing `AIAnalysisResult` through the same
`AIOutputValidator` clamps the LLM path uses (sentiment −1..1, impact/confidence 0..100,
`tradingBias` enum). Downstream consumers cannot tell which path produced the score —
deliberately, so the comparison in shadow mode is apples-to-apples.

## 5. Hard boundaries (non-negotiable)

- **AI is enhancement, never a dependency** (core architectural principle, 2026-10-05):
  Argus must trade with zero AI. The deterministic spine — technical/quant agents, Java
  quant engines, the 25 RiskEngine gates, OMS, broker — is the real trading system and
  stands alone; AI failures already degrade gracefully (agents return null / log-and-continue,
  local FinBERT fallback exists) and consensus needs only 2 independent agents, reachable by
  non-AI voters alone. Jev (like the LLMs) is triage/classification only. If this integration
  ever became load-bearing for trading, that would be a design failure, not a success.
- Jev never emits a trading recommendation, never casts a vote, never touches consensus,
  RiskEngine, OMS, or any gate. It is a triage instrument, not a decision-maker.
- Jev's confidence is not evidence of edge and is never presented as such.
- No multi-article batching, no new question types, no threshold changes without measured
  calibration data from the agreement ledger.
- Feature-flagged, default off. Not in any paper session until Phase 2 is approved.

## 6. Phased rollout

- **Phase 1 — Shadow mode.** Jev scores alongside the LLM; results logged, never used.
  Exit criteria: agreement ledger populated across real articles; measured latency/cost
  match the plan's assumptions.
- **Phase 2 — Live escalation.** Jev first, LLM on low confidence or high stakes.
  Exit criteria: no degradation in downstream news-catalyst quality vs the LLM-only baseline.
- **Phase 3 — Widen.** Only with calibration evidence from Phase 2: adjust thresholds,
  consider additional low-risk classification tasks. Never reasoning tasks.

## 7. Open questions

1. Live smoke with a real key (`JEV_API_KEY=… npx tsx scripts/jev-smoke.ts`) — verifies
   the wire format against the real API, not just docs and mocks.
2. Measured Jev-vs-LLM agreement on Argus's own news flow (Phase 1's entire purpose).
3. The exact confidence threshold for escalation — must come from Phase 1 data, not a guess.
4. Whether the free BeatAPI tier (`jev-1.13-free`, 1 req/min) suffices for shadow mode, or
   official usage-based billing is needed from the start.

## 8. References

- Adapter: `src/server/ai/providers/JevProvider.ts` (+ 15 tests)
- Spike notes: `docs/research/JEV_ADAPTER_SPIKE_2026-10-05.md`
- Smoke test: `scripts/jev-smoke.ts`
- Current LLM news path: `src/server/news/NewsScoringEngine.ts`
- Escalation pattern: `src/server/ai/EscalationPolicy.ts`
