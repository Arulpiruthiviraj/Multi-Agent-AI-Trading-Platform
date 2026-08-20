import { NormalizedArticle } from './NewsNormalizer';
import { db } from '../db';
import * as schema from '../db/schema';
import { v4 as uuidv4 } from 'uuid';
import { eq, gte } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { tradingSafety } from '../config/tradingSafety';
import { ImpactAssessment } from './NewsImpactEngine';
import { findMatchingCluster, type ClusterCandidate } from './newsEventClustering';

export interface ClusterOutcome {
  clusterId: string;
  /** False when this article was merged into an existing cluster (real corroboration). */
  isNewCluster: boolean;
  /** Article count in the cluster BEFORE this article was added - 0 for a brand-new cluster. */
  priorArticleCount: number;
  /** Distinct source count in the cluster AFTER this article was added. */
  sourceCount: number;
}

export class NewsClusterEngine {
  public async createOrUpdateCluster(
    article: NormalizedArticle,
    category: string,
    impact: ImpactAssessment,
    credibility: number,
    finalSymbols: string[]
  ): Promise<ClusterOutcome | null> {
    try {
      // 1. Insert Article first, clusterId TBD below - onConflictDoNothing is defense-in-depth
      // for a server restart, where NewsDeduplicator's in-memory id cache resets but these rows
      // are already durably stored.
      const articlePublishedMs = Date.parse(article.publishedAt);

      // Phase F2 (real event clustering): find an existing cluster this article actually belongs
      // to before minting a new one - see newsEventClustering.ts for the matching layers
      // (symbol overlap + category + time proximity + title similarity). Candidates are narrowed
      // to unarchived clusters updated within the configured window before the pure matcher runs.
      const windowStartIso = new Date(Date.now() - tradingSafety.newsClusterTimeWindowMs).toISOString();
      const recentClusters = await db.select().from(schema.newsClusters)
        .where(gte(schema.newsClusters.updatedAt, windowStartIso));
      const candidates: ClusterCandidate[] = recentClusters
        .filter((c) => !c.isArchived)
        .map((c) => ({
          id: c.id,
          title: c.title,
          eventType: c.eventType,
          symbols: c.symbols ? JSON.parse(c.symbols) : [],
          // updatedAt is processing time (real wall-clock), not each article's publishedAt - a
          // known simplification. Live news processing happens close to real-time, so this is a
          // reasonable proxy; a strict published-time proximity would need a dedicated column.
          lastArticlePublishedMs: Date.parse(c.updatedAt),
        }));
      const matched = Number.isFinite(articlePublishedMs)
        ? findMatchingCluster(
            { title: article.title, eventType: category, symbols: finalSymbols, publishedMs: articlePublishedMs },
            candidates,
            {
              timeWindowMs: tradingSafety.newsClusterTimeWindowMs,
              titleSimilarityThreshold: tradingSafety.newsClusterTitleSimilarityThreshold,
            },
          )
        : null;

      const clusterId = matched ? matched.id : `cluster_${uuidv4()}`;

      const inserted = await db.insert(schema.newsArticles).values({
        id: article.id,
        title: article.title,
        content: article.content,
        url: article.url,
        source: article.source,
        author: article.author,
        publishedAt: article.publishedAt,
        clusterId: clusterId,
        sentimentScore: impact.sentiment,
        credibilityScore: credibility,
        relevanceScore: 1.0,
        summary: article.title,
        symbols: JSON.stringify(finalSymbols)
      }).onConflictDoNothing();
      if (inserted.changes === 0) {
        // Already persisted from a prior process lifetime - don't create an orphan cluster row
        // (and don't let the caller re-run AI analysis / re-emit a trade idea for it) either.
        return null;
      }

      if (matched) {
        // 2a. Merge into the matched cluster - real corroboration, not a new independent event.
        const existingSymbols: string[] = matched.symbols;
        const mergedSymbols = Array.from(new Set([...existingSymbols, ...finalSymbols]));
        const existingRow = recentClusters.find((c) => c.id === matched.id)!;
        const priorArticleCount = existingRow.articleCount;
        const distinctSourcesRow = await db.select({ source: schema.newsArticles.source })
          .from(schema.newsArticles)
          .where(eq(schema.newsArticles.clusterId, clusterId));
        const sourceCount = new Set(distinctSourcesRow.map((r) => r.source)).size;
        // Running average - each additional corroborating article nudges sentiment/impact rather
        // than letting the single newest article overwrite the cluster's accumulated read.
        const blendedSentiment = existingRow.sentimentScore == null
          ? impact.sentiment
          : (existingRow.sentimentScore * priorArticleCount + impact.sentiment) / (priorArticleCount + 1);
        const blendedImpact = existingRow.impactScore == null
          ? impact.impactScore
          : (existingRow.impactScore * priorArticleCount + impact.impactScore) / (priorArticleCount + 1);

        await db.update(schema.newsClusters).set({
          updatedAt: new Date().toISOString(),
          sentimentScore: blendedSentiment,
          impactScore: blendedImpact,
          symbols: JSON.stringify(mergedSymbols),
          articleCount: priorArticleCount + 1,
          sourceCount,
        }).where(eq(schema.newsClusters.id, clusterId));

        eventBus.emit(EVENTS.NEWS_CLUSTER_UPDATED, {
          clusterId,
          title: existingRow.title,
          symbols: mergedSymbols,
          sentiment: blendedSentiment,
          impactScore: blendedImpact,
          articleCount: priorArticleCount + 1,
          sourceCount,
        });

        return { clusterId, isNewCluster: false, priorArticleCount, sourceCount };
      }

      // 2b. Insert a brand-new cluster - no existing cluster passed every matching layer.
      await db.insert(schema.newsClusters).values({
        id: clusterId,
        title: article.title,
        summary: article.content,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        eventType: category,
        sentimentScore: impact.sentiment,
        impactScore: impact.impactScore,
        timeHorizon: impact.timeHorizon,
        isArchived: false,
        symbols: JSON.stringify(finalSymbols),
        articleCount: 1,
        sourceCount: 1,
      });

      eventBus.emit(EVENTS.NEWS_CLUSTER_CREATED, {
        clusterId,
        title: article.title,
        symbols: finalSymbols,
        sentiment: impact.sentiment,
        impactScore: impact.impactScore
      });

      return { clusterId, isNewCluster: true, priorArticleCount: 0, sourceCount: 1 };
    } catch (e) {
      console.error('[NewsClusterEngine] Failed to save to DB:', e);
      return null;
    }
  }
}
