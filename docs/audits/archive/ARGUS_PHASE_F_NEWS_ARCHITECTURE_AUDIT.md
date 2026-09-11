# ARGUS PHASE F — NEWS ARCHITECTURE AUDIT (current state, before any Phase F code)

Read-only audit per Phase F Step 1. Every claim below is sourced from actual code (file:line), not from prior markdown docs. A background research pass gathered the initial findings; the most load-bearing claims (dead clustering, config defaults, gate divergence) were independently re-verified by direct file reads before being written here.

No code was changed to produce this document.

---

## 1. Current architecture (as it exists today)

The real pipeline, per 10-second tick (`runtimeIntervals.json` `newsEngineMs: 10000`):

```
NewsProviderManager.fetchAllLatest()          (7 providers, sequential)
        ↓
NewsNormalizer.normalize()                     (+ fingerprint)
        ↓
NewsDeduplicator.isDuplicate()                 (in-memory id/fingerprint sets, cap 10k)
        ↓
NewsCredibilityEngine.assess(article, 0.8)     (hardcoded weight — see gap #7)
        ↓  (skip if < 0.3)
NewsClassifier.classify()                      (keyword/substring only)
        ↓
NewsSymbolExtractor.extract()                  (7-ticker hardcoded allowlist + provider symbols)
        ↓
NewsImpactEngine.assess()                       (FinBERT sentiment + impact score)
        ↓
NewsClusterEngine.createOrUpdateCluster()      ← ALWAYS 1 article = 1 new cluster (no real clustering)
        ↓                                          persists news_articles + news_clusters
NEWS_ANALYSIS_STARTED
        ↓
decideEscalation() (EscalationPolicy)          local FinBERT-only vs. LLM escalation
        ↓ (if escalating, under newsLlmMaxCallsPerCycle=2)
NewsScoringEngine.analyzeWithAI()              real AIRouter.routeTask('NewsAgent', ...) call
        ↓ (else) buildLocalFirstNewsAnalysis()  FinBERT-only fallback, never fabricates an LLM result
ESCALATION_DECISION
        ↓
[if tradingBias !== NEUTRAL] NewsCatalystStore.recordNewsCatalyst() + NEWS_CATALYST
        ↓
[if deskIntelligence.newsEmitsTradeIdeas && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('NewsAgent')]
    eventBus.emitTradeIdea({ agent: 'NewsAgent', ... })   ← DEFAULT OFF (newsEmitsTradeIdeas=false)
        ↓
NEWS_ANALYZED
        ↓ (after all articles)
NEWS_PIPELINE_TICK  (heartbeat, telemetryPulse:true, fires even on an all-duplicate tick)
```

Separately, on every RiskEngine BUY/SELL evaluation, gate 14 (`news_veto`) independently reads `news_clusters` directly — this path runs regardless of whether NewsAgent ever votes (`config/pipelineAgents.json`: `"description": "...Cluster ingest for RiskEngine news_veto runs from process boot (independent of Autobot); ideas stay gated."`).

Class/module map:
- `src/server/news/NewsEngine.ts` — orchestrator singleton (`newsEngine`), owns all sub-engines, drives the tick loop.
- `src/server/news/NewsProviderManager.ts` — registers and calls the 7 providers.
- `src/server/news/providers/*.ts` — `RssNewsProvider` (×3: Yahoo/CNBC/WSJ), `FinnhubNewsProvider`, `AlphaVantageNewsProvider`, `PolygonNewsProvider`, `FMPNewsProvider`, `MockNewsProvider` (dead).
- `src/server/news/NewsNormalizer.ts`, `NewsDeduplicator.ts`, `NewsCredibilityEngine.ts`, `NewsClassifier.ts`, `NewsSymbolExtractor.ts`, `NewsImpactEngine.ts`, `NewsClusterEngine.ts`, `NewsScoringEngine.ts` — one small, single-purpose class each.
- `src/server/services/NewsCatalystStore.ts` — in-memory catalyst list (display/scoring only).
- `src/server/news/newsClusterMatch.ts` — pure helpers used only by RiskEngine's gate 14.
- `src/server/ai/EscalationPolicy.ts` — local-vs-LLM escalation decision (shared with other agents, not News-specific).

There is **no separate "NewsAgent" class** — "NewsAgent" is a string label (`agent: 'NewsAgent'`) used in emitted ideas/events and in config (`agentWeights.json`, `pipelineAgents.json`), not a distinct module.

---

## 2. Existing News components (detail)

See the class/module map above. Two components deserve special note because their names overstate what they do:

- **`NewsClusterEngine`**: despite the name, `createOrUpdateCluster()` (`NewsClusterEngine.ts:9-71`) always mints a new `clusterId = cluster_${uuidv4()}` and always inserts exactly one new `news_clusters` row. There is no lookup against existing clusters. The code's own comment admits it: *"Insert Cluster (Simplification: 1 article = 1 cluster for now, real clustering requires embedding matching)"* (line 43). Verified directly — confirmed real, not a research artifact.
- **`NewsDeduplicator`**: real, but shallow — exact `id` or exact normalized-string `fingerprint` match only (`title.toLowerCase().replace(/[^a-z0-9]/g,'') + content.slice(0,100)...`). No near-duplicate/semantic matching, no hashing. This catches re-fetches of the *same* article, not the *same event* reported by a different outlet.

---

## 3. Dead / idle paths

1. `MockNewsProvider` — implements the plugin interface, never registered in `NewsProviderManager`'s constructor, unreferenced elsewhere. Dead code.
2. Real clustering is entirely unimplemented (see #2 above) — this is the single largest gap Phase F needs to fill, and the schema/event names already imply it exists when it doesn't.
3. `news_providers` DB table (`schema.ts:537-547`) — written only by a generic encrypted-secrets admin path, never read by any real provider (which all use `process.env.*_API_KEY` directly). Vestigial/disconnected from the live pipeline.
4. `deskIntelligence.newsEmitsTradeIdeas: false` (default) — the entire NewsAgent-as-ChiefTrader-voter path (weight 0.25, hard-veto-on-HOLD) is live code but dormant; only exercised in unit tests via direct `reviewIdea()` calls, never through the real `NewsEngine` → `ChiefTraderAgent` path today.
5. Two emit call sites use raw string literals instead of the `EVENTS` catalog constant: `NewsClusterEngine.ts:58` (`'NEWS_CLUSTER_CREATED'`), `NewsProviderManager.ts:67` (`'NEWS_PROVIDER_FAILED'`). Functionally fine today, but a drift risk.
6. `e2e_news_pipeline.ts` (repo root) — a standalone manual script reaching into `NewsEngine`'s private fields via `(newsEngine as any).x`; not part of any test runner. Leftover dev harness.
7. `NewsCredibilityEngine.assess()` is always called with a hardcoded `0.8` weight (`NewsEngine.ts:99`), never each provider's actual configured `credibilityWeight` (0.85–0.95, set in `NewsProviderManager.ts:27-33`). Likely an oversight — the per-provider weights exist but are never consulted.
8. `NewsSymbolExtractor`'s "common tickers" list is a hardcoded 7-ticker allowlist (`AAPL, TSLA, MSFT, NVDA, GOOGL, AMZN, META`) — a placeholder, not real ticker extraction.
9. `NewsClassifier` is keyword/substring matching only (`earnings|revenue|eps`, `dividend`, `merger|acquisition`, etc.) with a `General` catch-all.

---

## 4. Provider status

| Provider | Auth | Resilience |
|---|---|---|
| RSS (Yahoo/CNBC/WSJ) | none | **Real backoff**: transient-HTTP set `{429,502,503,504}` + regex-matched timeout/DNS/reset errors → 15-min cooldown (`rssFeedErrorBackoffMs`), logged once, `fetchLatest()`/`healthCheck()` short-circuit while cooling down. |
| Finnhub | `?token=` query param | **None** — `if (!res.ok) return []`, no retry/backoff. No test file exists for this provider. |
| AlphaVantage | `apikey=` query param | **None** — same pattern. Not subject to the existing `AlphaVantageBudget.ts` daily-request-budget guard used elsewhere (e.g. FundamentalAgent) — re-hits AlphaVantage every ~10s cycle uncapped. Uses `logErrorSafely` specifically so a caught error's message can't leak the key. |
| Polygon | `Authorization: Bearer` header (deliberately not query-string, to avoid leaking via error messages) | **None** — same `if (!res.ok) return []` pattern. |
| FMP | `apikey=` query param | **None** — same pattern; also `logErrorSafely`. |
| Mock | n/a | Dead code, not registered. |

Shared interface exists (`NewsProviderPlugin`: `initialize/fetchLatest/healthCheck/isConfigured?`) and a real manager (`NewsProviderManager`) tracks per-provider stats (`lastFetchAt/lastSuccessAt/lastArticleCount/errorCount/lastError`) and emits `'NEWS_PROVIDER_FAILED'` on a thrown error. But actual failure handling beyond that is ad hoc per provider — only RSS has real backoff.

---

## 5. Current configuration

| Key | File | Value | Role |
|---|---|---|---|
| `newsEmitsTradeIdeas` | `deskIntelligence.json` | `false` | Master gate — News never votes unless true |
| `newsLlmMaxCallsPerCycle` | `tradingSafety.json` | `2` | Per-tick LLM escalation cap |
| `newsVetoMinImpactScore` | `tradingSafety.json` | `80` | RiskEngine gate 14 threshold (0–100 scale) |
| `newsVetoWindowMs` | `tradingSafety.json` | `14400000` (4h) | Gate 14 lookback window |
| `newsDecisiveSentimentThreshold` | `tradingSafety.json` | `0.6` | FinBERT-confident-enough-to-skip-LLM threshold |
| `newsEngineMs` | `runtimeIntervals.json` | `10000` | Pipeline tick interval |
| `rssFeedErrorBackoffMs` | `runtimeIntervals.json` | `900000` (15m) | RSS backoff cooldown |
| `rssFeedFetchTimeoutMs` | `runtimeIntervals.json` | `10000` | Per-fetch RSS timeout |
| `defaults.NewsAgent` | `agentWeights.json` | `0.25` | Consensus vote weight (tied-highest with Technical) |
| `consensusHardVetoAgents` | `agentWeights.json` | `["NewsAgent","ConsensusDebate"]` | HOLD-as-penalty status |
| News entry | `pipelineAgents.json` | present | Mission Control toggle, `keepsBackgroundPipeline: true` |
| `NEWS` role | `modelRoles.json` | `["NewsAgent","NewsEngine"]` | AIRouter role mapping |
| `NewsAgent` entry | `aiModels.json` | present | Model/provider routing for the News AIRouter task |
| `newsRss` / `marketData` blocks | `networkEndpoints.json` | present | Feed URLs / API base URLs |

No dedicated `config/news.json` exists — News config is scattered across 6+ files. Env vars read directly (no config mirror): `FINNHUB_API_KEY`, `ALPHAVANTAGE_API_KEY`, `POLYGON_API_KEY`, `FMP_API_KEY`.

---

## 6. Current EventBus behavior

Canonical names in `config/eventNames.json`: `NEWS_ANALYSIS_STARTED`, `NEWS_ANALYZED`, `NEWS_PIPELINE_TICK`, `ESCALATION_DECISION`, `NEWS_CLUSTER_CREATED`, `NEWS_PROVIDER_FAILED`, `NEWS_CATALYST` (the last is also in the `persist` array — durably stored; the others are not).

| Event | Emitted from | Payload |
|---|---|---|
| `NEWS_ANALYSIS_STARTED` | `NewsEngine.ts:126` | `{ traceId, headline, source }` |
| `ESCALATION_DECISION` | `NewsEngine.ts:190-197` | `{ traceId, agent:'NewsAgent', localSource:'finbert', localConfidence, escalated, reason }` |
| `NEWS_CATALYST` | `NewsEngine.ts:241` | `{ traceId, symbol, headline, source, publishedAtMs, sentiment, credibility, catalystStrength, tradingBias, contribution, reasoning, recordedAt }` |
| `NEWS_ANALYZED` | `NewsEngine.ts:288-296` | `{ id, clusterId, symbols, impact, credibility, category, aiAnalysis }` |
| `NEWS_PIPELINE_TICK` | `NewsEngine.ts:304-309` | `{ telemetryPulse:true, fetched, analyzed, at }` |
| `NEWS_CLUSTER_CREATED` | `NewsClusterEngine.ts:58-64` | `{ clusterId, title, symbols, sentiment, impactScore }` (raw string literal, not `EVENTS.*`) |
| `NEWS_PROVIDER_FAILED` | `NewsProviderManager.ts:67` | `{ providerId, error }` (raw string literal) |

---

## 7. Current ChiefTrader integration

News is wired as a **fully generic weighted voting agent** — no special-cased code path distinguishes it from Technical/Fundamental/Macro in `ChiefTraderAgent.reviewIdea()`/`EvidenceAggregator.aggregate()`. What makes it distinctive is entirely config-driven:
- Weight `0.25` (tied-highest with TechnicalAgent) — `agentWeights.json:6`.
- Member of `consensusHardVetoAgents` — a NewsAgent HOLD with confidence > 0 counts as a disagreement penalty against the winning side, unlike a plain Fundamental/Macro HOLD (`EvidenceAggregator.ts:73-77,17,91`).

This entire path is **live code but dormant in production**, gated behind `deskIntelligence.newsEmitsTradeIdeas` (default `false`). `ChiefTraderAgent.test.ts` exercises NewsAgent-as-voter directly via `reviewIdea({agent:'NewsAgent',...})`, bypassing `NewsEngine` — i.e. the consensus math is unit-tested in isolation, not through the real end-to-end gate.

Absent that flag, News's only live effect on trading today is (a) `NEWS_CATALYST`/`NewsCatalystStore` (display/scoring only — read by `EliteTraderDecision.ts` for a `CatalystScore`, never order-blocking) and (b) RiskEngine gate 14.

---

## 8. News veto / risk gate (RiskEngine gate 14) — verified directly

`src/server/engines/RiskEngine.ts:491-510`. Live path:
```ts
const fourHoursAgo = new Date(nowMs - tradingSafety.newsVetoWindowMs).toISOString();
const recentClusters = await db.select().from(schema.newsClusters).where(gte(schema.newsClusters.updatedAt, fourHoursAgo));
symbolNews = recentClusters.filter((n) =>
  clusterCoversSymbol(n.symbols, proposal.symbol) &&
  typeof n.impactScore === 'number' &&
  newsImpactOnVetoScale(n.impactScore) > tradingSafety.newsVetoMinImpactScore
);
recordGate('news_veto', symbolNews.length === 0, ...);
```
Replay path uses a **different** criterion — point-in-time `newsVisibleAt(...)` filtered by `sentiment < -0.99` (hardcoded), not the impact-score threshold used live. **This is a real, verified live/replay divergence**: the same named gate applies different logic depending on whether it's running live or in replay. Worth reconciling or explicitly documenting as intentional before Phase F builds on top of it.

Since `NewsClusterEngine` never actually clusters (§2), this gate fires per-article in practice, not per real-world event — a single sensational headline can veto for up to 4 hours.

A code comment (`RiskEngine.ts` above line 493) documents a previously-real bug this file already fixed: `impactScore` doesn't exist on `news_articles` at all, only on `news_clusters` — an earlier version of this query always evaluated "no high-impact news" regardless of reality.

---

## 9. Existing persistence

- `news_articles` (`schema.ts:507-521`): `id(PK), title, content, url, source, author, publishedAt, clusterId, sentimentScore, credibilityScore, relevanceScore, summary, symbols(JSON text)`. **No `impactScore` column** (confirmed — this is the exact gap the RiskEngine comment references).
- `news_clusters` (`schema.ts:523-535`): `id(PK), title, summary, createdAt, updatedAt, eventType, sentimentScore, impactScore, timeHorizon, isArchived, symbols(JSON text)`.
- `news_providers` (`schema.ts:537-547`): credential-management table, disconnected from the live pipeline (§3).
- `escalation_decisions` (shared table): written by NewsEngine with `agent:'NewsAgent', task:'news_sentiment_analysis', localSource:'finbert'`.
- No `news_events`, no embeddings table, no article↔cluster many-to-many junction — clustering support does not exist at the schema level either.

---

## 10. Existing tests

Real, targeted unit coverage exists for: AI-output validation/coercion (`NewsScoringEngine.test.ts`), the two RiskEngine-adjacent pure helpers (`newsClusterMatch.test.ts`), the LLM-call-budget counter (`newsLlmBudget.test.ts`), secret-non-leakage for AlphaVantage/FMP/Polygon providers, RSS backoff behavior, the `newsEmitsTradeIdeas=false` default (`NewsCatalystStore.test.ts`), internal-news-lookup mapping, the `news_veto` gate itself (`RiskEngine.test.ts`, `RiskEngine.gates.test.ts`), the config shape (`agentWeights.test.ts`), and NewsAgent-as-generic-voter scenarios in `ChiefTraderAgent.test.ts` (called directly, not through NewsEngine). Point-in-time news visibility is covered in `phase24.historicalReplay.test.ts`.

**Not covered by any test**: `NewsEngine.runPipeline()` end-to-end, `NewsProviderManager.fetchAllLatest()`, `NewsClusterEngine` (no test asserts the 1-article-1-cluster behavior), `NewsClassifier`, `NewsCredibilityEngine`, `NewsSymbolExtractor`, `NewsImpactEngine`, `NewsDeduplicator`, `FinnhubNewsProvider` (no test file at all), `newsRoutes.ts` handlers.

---

## 11. Exact gaps (ranked by relevance to Phase F's stated goals)

1. **No real clustering** — the single biggest gap. `NewsClusterEngine` is 1:1 article→cluster today; Phase F's entire "5 articles = 1 event" requirement (Step 5) does not exist yet.
2. **NewsAgent produces no structured multi-dimensional assessment** — no materiality/novelty/market-surprise/expected-horizon/catalyst-type fields exist anywhere in the current data model (§4 chain: `NewsArticleRaw → NormalizedArticle → ImpactAssessment → AIAnalysisResult → NewsCatalyst`). `AIAnalysisResult` has `sentimentScore/marketImpactScore/confidence/tradingBias/riskFlags` — a reasonable partial foundation, but no novelty/surprise/horizon dimensions.
3. **No separate directional-vote vs. risk/veto output** — today it's one `tradingBias` field; Phase F's Step 8 (two conceptually separate outputs) has no existing scaffold.
4. **No `NEWS_AGENT_MODE` enum** — today it's a single boolean (`newsEmitsTradeIdeas`). Phase F's 5-mode design (`DISABLED/CATALYST_ONLY/ACTIVE_OBSERVE/ACTIVE_VOTE/ACTIVE_VOTE_AND_VETO`) needs to be introduced net-new; today's `false` most closely maps to `CATALYST_ONLY` (clustering + catalyst events run; no votes).
5. **API providers (Finnhub/AlphaVantage/Polygon/FMP) have zero resilience** — only RSS backs off. A quota-exhaustion or outage on any of the 4 API providers will silently return `[]` forever, every ~10s, with no visible degraded-health signal beyond `NewsProviderManager`'s per-provider stats (which nothing currently surfaces to an operator API).
6. **No prediction ledger** — nothing today tracks a News prediction against actual subsequent price movement. Step 14's entire ask is net-new.
7. **Live/replay `news_veto` divergence** — different thresholds for the same gate depending on execution mode (§8). Should be reconciled or explicitly justified before Phase F's replay-fidelity requirement (Step 22) can be met.
8. **`news_providers` DB table is vestigial** — if Phase F wants DB-managed provider config/health, this table exists but is currently disconnected from the real providers.
9. **Minor drift risks**: raw string literals instead of `EVENTS.*` constants (§3.5); hardcoded `0.8` credibility weight ignoring real per-provider weights (§3.7); no per-provider `AlphaVantageBudget`-style cap applied to news fetches.

---

## 12. Proposed Phase F changes (direction only — not started)

Given the scale (27 steps in the source spec) and that the user has explicitly chosen to proceed alongside a live paper session, the recommended approach is to build **additively, in this rough order, each step tested and typechecked before the next**:

1. Introduce `NEWS_AGENT_MODE` config (new key, e.g. `config/deskIntelligence.json` or a new `config/newsIntelligence.json`), defaulting to today's *effective* behavior mapped onto the new enum (almost certainly `CATALYST_ONLY`, since that's what `newsEmitsTradeIdeas:false` already does) — a config addition only, zero behavior change, fully backward compatible.
2. Build the real event-clustering engine (embedding or heuristic similarity + symbol + time-window matching) as a **replacement implementation inside `NewsClusterEngine`**, not a parallel second engine — preserving its existing method signature/DB writes so `RiskEngine`'s gate 14 keeps working unmodified. This is the highest-leverage, most self-contained first real change.
3. Extend `AIAnalysisResult`/`NewsCatalyst` (or introduce a new `NewsEvent` type that supersedes both) with the missing dimensions (materiality, novelty, market surprise, expected horizon, catalyst type, contradictory evidence) — additive fields, existing consumers unaffected.
4. Split the single `tradingBias` output into the two conceptually separate vote/risk outputs Step 8 asks for, without changing `emitTradeIdea`'s existing contract until `NEWS_AGENT_MODE` is actually `ACTIVE_VOTE` or above.
5. Build the prediction ledger (Step 14) as new, additive tables (following the existing `news_articles`/`news_clusters` Drizzle conventions), populated going forward only — no retroactive fabrication of historical News predictions.
6. Only once the above are real and tested: wire `ACTIVE_VOTE`/`ACTIVE_VOTE_AND_VETO` modes into `NewsEngine.ts`'s existing `emitTradeIdea` call site (already gated correctly today) — this is a config/mode check, not new ChiefTrader wiring, since the consensus-math side (weight, hard-veto-on-HOLD) already exists and is already tested.
7. Address the live/replay gate-14 divergence explicitly (either unify the threshold logic or document why they differ) before claiming replay fidelity for News.
8. Add provider resilience (timeout/backoff/429 handling) to the 4 currently-unprotected API providers, following the existing `RssNewsProvider` pattern already proven in this codebase.

This document intentionally stops here — per the source spec, no code is changed until this architecture is understood and the user has had a chance to review this plan.
