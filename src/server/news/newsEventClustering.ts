/**
 * Phase F2 — real event clustering match logic (pure, deterministic, no DB/network access).
 *
 * Replaces NewsClusterEngine's prior "1 article = 1 cluster" behavior (its own comment used to
 * admit: "Simplification: 1 article = 1 cluster for now, real clustering requires embedding
 * matching"). This is a layered heuristic match, not embeddings - per the Phase F spec,
 * embeddings are optional and should not be made mandatory if they add latency/operational
 * complexity. A candidate cluster matches a new article only if ALL of the following hold:
 *   1. At least one symbol overlaps.
 *   2. The event category (NewsClassifier output) is the same.
 *   3. The candidate's most recent article was published within newsClusterTimeWindowMs.
 *   4. Normalized-title Jaccard similarity is >= newsClusterTitleSimilarityThreshold.
 * This intentionally will not catch every cross-outlet rephrasing (e.g. "signs a deal" vs.
 * "partnership") - documented as a known limitation, not silently overclaimed as perfect entity
 * resolution. Symbol+category are strong prior filters, so the title-similarity bar can stay
 * moderate without excessive false-positive merging.
 */

// Deliberately small - removing these before tokenizing improves Jaccard signal on financial
// headlines without pulling in a full NLP stopword list.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'in', 'on', 'of', 'for', 'with', 'and', 'or', 'is', 'are', 'as', 'at', 'by',
]);

export function normalizeTitleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

export function titleJaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  const unionSize = a.size + b.size - intersection;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

export function symbolsOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const bSet = new Set(b);
  return a.some((s) => bSet.has(s));
}

export interface ClusterCandidate {
  id: string;
  title: string;
  eventType: string | null;
  symbols: string[];
  /** Epoch ms of the most recently clustered article - used for the time-proximity check. */
  lastArticlePublishedMs: number;
}

export interface ClusterMatchInput {
  title: string;
  eventType: string;
  symbols: string[];
  publishedMs: number;
}

export interface ClusterMatchConfig {
  timeWindowMs: number;
  titleSimilarityThreshold: number;
}

/**
 * Returns the best-matching candidate (highest title similarity among those that pass every
 * layer), or null if none qualify. Pure function - safe to unit-test and safe to reuse from
 * replay without any live-only dependency.
 */
export function findMatchingCluster(
  article: ClusterMatchInput,
  candidates: ClusterCandidate[],
  config: ClusterMatchConfig,
): ClusterCandidate | null {
  const articleTokens = normalizeTitleTokens(article.title);
  let best: { candidate: ClusterCandidate; similarity: number } | null = null;

  for (const candidate of candidates) {
    if (candidate.eventType !== article.eventType) continue;
    if (!symbolsOverlap(candidate.symbols, article.symbols)) continue;
    if (Math.abs(article.publishedMs - candidate.lastArticlePublishedMs) > config.timeWindowMs) continue;

    const similarity = titleJaccardSimilarity(articleTokens, normalizeTitleTokens(candidate.title));
    if (similarity < config.titleSimilarityThreshold) continue;

    if (!best || similarity > best.similarity) {
      best = { candidate, similarity };
    }
  }

  return best?.candidate ?? null;
}
