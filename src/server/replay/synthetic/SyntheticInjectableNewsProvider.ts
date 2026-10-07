/**
 * ==========================================================
 * Module: SyntheticInjectableNewsProvider
 *
 * Closes the gap documented in docs/audits/ARGUS_NEWS_QUANT_INDEPENDENT_ROUNDTRIP_CERTIFICATION.md
 * §3/§5: the only pre-existing test-facing NewsProviderPlugin (MockNewsProvider.ts) is hardcoded to
 * one AAPL article stamped with real wall-clock Date.now() - it cannot target a different symbol,
 * cannot be timed to a synthetic session's own simulated clock, and cannot vary content run to run.
 * Using it as-is for a News+Quant independent-consensus certification would violate point-in-time
 * discipline (an article whose timestamp is real "now" has no defined relationship to a synthetic
 * session's own, usually-much-earlier, simulated clock).
 *
 * This is a real NewsProviderPlugin implementation (same interface RssNewsProvider/FinnhubNewsProvider/
 * etc. already implement), so a caller-supplied article still flows through the REAL production
 * pipeline unmodified: NewsEngine.runPipeline() -> NewsNormalizer -> NewsDeduplicator ->
 * NewsCredibilityEngine -> NewsClassifier -> NewsSymbolExtractor (real entity/ticker extraction) ->
 * NewsImpactEngine (real FinBERT/keyword-heuristic sentiment) -> NewsClusterEngine -> NewsScoringEngine
 * (FinBERT/LLM catalyst classification) -> eventBus.emitTradeIdea() under agent 'NewsAgent'. Nothing
 * in this file hand-builds a trading decision, a sentiment score, or a vote - it only supplies the
 * raw article text/timing a real provider would have supplied.
 *
 * Point-in-time discipline is enforced at the SOURCE (fetchLatest() below), not by the caller
 * remembering to wait: an injected article is withheld from every fetchLatest() call until the
 * caller-supplied nowFn() (the session's own SyntheticMarketClock.now(), never Date.now()) has
 * actually reached that article's own publishedAtMs. This mirrors SyntheticDailyBarProvider.ts's
 * own point-in-time contract (only ever fed bars the simulated clock has already reached) and
 * InformationCutoff's broader role in this harness.
 *
 * Production-safety / architecture boundary: this module lives in src/server/replay/synthetic/,
 * the same directory SyntheticDailyBarProvider.ts and SyntheticNewsGenerator.ts already use, and
 * carries the same SYNTHETIC_SIMULATION=true runtime guard
 * (assertSyntheticInjectableNewsProviderOnlyInSyntheticSession()) at every entry point. It is never
 * registered by any production boot path - ArgusCoreBoot.ts's unconditional
 * `new NewsProviderManager()` (inside NewsEngine's constructor) never references this file, and
 * NewsProviderManager.replaceProviders() (the seam this provider is installed through - see
 * NewsProviderManager.ts) is only ever called from SyntheticSessionEngine.ts. See
 * SyntheticInjectableNewsProvider.architectureBoundary.test.ts for the static import-boundary proof
 * and the runtime guard proof, matching SyntheticDailyBarProvider's own test pattern.
 * ==========================================================
 */
import type { NewsProviderPlugin, NewsArticleRaw } from '../../news/providers/NewsProviderPlugin';

export interface SyntheticNewsArticleSpec {
  /** Stable id for dedup across repeated fetchLatest() calls within one session. Auto-derived from
   *  symbol+publishedAtMs if omitted. */
  id?: string;
  title: string;
  content: string;
  /** Provider-supplied symbol - the highest-trust source NewsSymbolExtractor.extract() consults
   *  (see that file's own header), exactly as a real news API's ticker tag would be. Supplying this
   *  does not bypass extraction; it exercises the identical "provider-supplied symbol" branch a
   *  real AlphaVantage/Polygon article with ticker metadata would also take. */
  symbol: string;
  /** Simulated-clock timestamp (NOT Date.now()) - the moment this article becomes visible. */
  publishedAtMs: number;
  source?: string;
  author?: string;
}

function assertSyntheticInjectableNewsProviderOnlyInSyntheticSession(): void {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error(
      'SyntheticInjectableNewsProvider refuses to run outside a synthetic simulation session ' +
      '(SYNTHETIC_SIMULATION !== "true"). This module exists only to feed NewsProviderManager inside ' +
      'an isolated synthetic harness session - it must never be reachable from a live/paper boot.',
    );
  }
}

/**
 * A real, minimal NewsProviderPlugin that delivers caller-queued articles once the session's own
 * simulated clock reaches each article's publishedAtMs - never before. See this file's header for
 * the full rationale and the production-safety boundary.
 */
export class SyntheticInjectableNewsProvider implements NewsProviderPlugin {
  id = 'synthetic_injectable_news';
  name = 'Synthetic Injectable News (test harness only - never a real wire)';
  type = 'synthetic';
  // Comparable to a real mid-tier wire credibilityWeight (RssNewsProvider instances in this
  // codebase range 0.85-0.95; MockNewsProvider uses 0.5) - not tuned to push any particular
  // certification outcome, just a plausible real-provider-shaped value.
  credibilityWeight = 0.8;

  private readonly queue: SyntheticNewsArticleSpec[] = [];
  private readonly delivered = new Set<string>();
  private readonly nowFn: () => number;

  /** @param nowFn Must be the session's own SyntheticMarketClock.now() (or an equivalent simulated
   *  clock reader) - never Date.now(). This is what makes publishedAtMs gating point-in-time safe
   *  rather than wall-clock coincidental. */
  constructor(nowFn: () => number) {
    assertSyntheticInjectableNewsProviderOnlyInSyntheticSession();
    this.nowFn = nowFn;
  }

  /** Queues an article for future delivery. Safe to call at any point before or during a session -
   *  delivery timing is governed entirely by publishedAtMs vs. the live nowFn() read inside
   *  fetchLatest(), never by when inject() itself was called. */
  inject(spec: SyntheticNewsArticleSpec): void {
    assertSyntheticInjectableNewsProviderOnlyInSyntheticSession();
    this.queue.push(spec);
  }

  async initialize(): Promise<void> {}

  async fetchLatest(): Promise<NewsArticleRaw[]> {
    assertSyntheticInjectableNewsProviderOnlyInSyntheticSession();
    const now = this.nowFn();
    const out: NewsArticleRaw[] = [];
    for (const spec of this.queue) {
      const id = spec.id ?? `synthetic_${spec.symbol}_${spec.publishedAtMs}`;
      if (this.delivered.has(id)) continue;
      // Point-in-time discipline, enforced here (the source), not trusted to the caller: an
      // article dated AFTER the current simulated time is never returned, no matter how many
      // times fetchLatest() is polled.
      if (spec.publishedAtMs > now) continue;
      this.delivered.add(id);
      out.push({
        id,
        title: spec.title,
        content: spec.content,
        url: `synthetic://news/${id}`,
        source: spec.source ?? 'Synthetic Wire (test harness)',
        author: spec.author ?? 'Synthetic Harness',
        publishedAt: new Date(spec.publishedAtMs).toISOString(),
        symbols: [spec.symbol],
      });
    }
    return out;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /** Diagnostic only - how many queued articles have not yet cleared the point-in-time gate. */
  pendingCount(): number {
    return this.queue.filter((s) => {
      const id = s.id ?? `synthetic_${s.symbol}_${s.publishedAtMs}`;
      return !this.delivered.has(id);
    }).length;
  }
}
