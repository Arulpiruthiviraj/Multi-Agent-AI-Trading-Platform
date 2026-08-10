import { NormalizedArticle } from './NewsNormalizer';
import { db } from '../db';
import * as schema from '../db/schema';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { eventBus } from '../core/EventBus';
import { ImpactAssessment } from './NewsImpactEngine';

export class NewsClusterEngine {
  public async createOrUpdateCluster(
    article: NormalizedArticle, 
    category: string, 
    impact: ImpactAssessment, 
    credibility: number,
    finalSymbols: string[]
  ) {
    const clusterId = `cluster_${uuidv4()}`;

    try {
      // 1. Insert Article - onConflictDoNothing is defense-in-depth for a server restart, where
      // NewsDeduplicator's in-memory id cache resets but these rows are already durably stored.
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

      // 2. Insert Cluster (Simplification: 1 article = 1 cluster for now, real clustering requires embedding matching)
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
        symbols: JSON.stringify(finalSymbols)
      });

      eventBus.publish('NEWS_CLUSTER_CREATED', {
        clusterId,
        title: article.title,
        symbols: finalSymbols,
        sentiment: impact.sentiment,
        impactScore: impact.impactScore
      });

      return clusterId;
    } catch (e) {
      console.error('[NewsClusterEngine] Failed to save to DB:', e);
    }
  }
}
