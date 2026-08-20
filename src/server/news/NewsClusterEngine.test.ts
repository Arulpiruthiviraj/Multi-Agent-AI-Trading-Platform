import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import type { NormalizedArticle } from './NewsNormalizer';
import type { ImpactAssessment } from './NewsImpactEngine';

/**
 * Real, DB-backed proof that Phase F2's clustering actually clusters - closing the audit's
 * explicitly-flagged gap ("no test asserts the 1-article-1-cluster behavior"). Prior to this
 * fix, NewsClusterEngine always minted a new cluster per article; these tests exercise the real
 * merge-vs-new-cluster decision against a real (isolated, temp) SQLite DB, not a mock.
 */
describe('NewsClusterEngine (Phase F2 real clustering, real DB)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let db: any;
  let schema: typeof import('../db/schema');
  let NewsClusterEngine: typeof import('./NewsClusterEngine').NewsClusterEngine;
  let engine: InstanceType<typeof import('./NewsClusterEngine').NewsClusterEngine>;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_newscluster_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb, db } = await import('../db'));
    schema = await import('../db/schema');
    ({ NewsClusterEngine } = await import('./NewsClusterEngine'));
  });

  beforeEach(async () => {
    engine = new NewsClusterEngine();
    // Each `it` shares the same real DB (set up once in beforeAll) - clear both tables so one
    // test's clusters can never accidentally match another test's articles.
    await db.delete(schema.newsArticles);
    await db.delete(schema.newsClusters);
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  function article(overrides: Partial<NormalizedArticle>): NormalizedArticle {
    return {
      id: `art_${Math.random().toString(36).slice(2)}`,
      title: 'Apple announces new AI partnership',
      content: 'Apple today announced a new AI partnership.',
      url: 'https://example.com/a',
      source: 'Yahoo Finance',
      author: 'Staff',
      publishedAt: '2026-08-20T12:00:00.000Z',
      symbols: ['AAPL'],
      fingerprint: 'fp',
      ...overrides,
    };
  }

  const impact: ImpactAssessment = { sentiment: 0.5, impactScore: 0.6, timeHorizon: '1-3D', sentimentSource: 'finbert' };

  it('creates a new cluster for the first article about an event (articleCount=1, sourceCount=1)', async () => {
    const outcome = await engine.createOrUpdateCluster(article({}), 'Product', impact, 0.9, ['AAPL']);
    expect(outcome).toBeTruthy();
    expect(outcome!.isNewCluster).toBe(true);
    expect(outcome!.priorArticleCount).toBe(0);
    const rows = await db.select().from(schema.newsClusters).where(eq(schema.newsClusters.id, outcome!.clusterId));
    expect(rows[0].articleCount).toBe(1);
    expect(rows[0].sourceCount).toBe(1);
  });

  it('merges a corroborating article from a different outlet into the SAME cluster', async () => {
    const first = article({ title: 'Apple announces new AI partnership', source: 'Yahoo Finance', publishedAt: '2026-08-20T13:00:00.000Z' });
    const firstOutcome = await engine.createOrUpdateCluster(first, 'Product', impact, 0.9, ['AAPL']);
    expect(firstOutcome).toBeTruthy();

    const second = article({ title: 'Apple enters major AI partnership', source: 'CNBC', publishedAt: '2026-08-20T13:05:00.000Z' });
    const secondOutcome = await engine.createOrUpdateCluster(second, 'Product', impact, 0.85, ['AAPL']);

    expect(secondOutcome!.clusterId).toBe(firstOutcome!.clusterId);
    expect(secondOutcome!.isNewCluster).toBe(false);
    expect(secondOutcome!.priorArticleCount).toBe(1);

    const clusterRows = await db.select().from(schema.newsClusters);
    const merged = clusterRows.find((c: any) => c.id === firstOutcome!.clusterId);
    expect(merged.articleCount).toBe(2);
    expect(merged.sourceCount).toBe(2);

    const articleRows = await db.select().from(schema.newsArticles);
    const clusteredIds = articleRows.filter((a: any) => a.clusterId === firstOutcome!.clusterId).map((a: any) => a.id);
    expect(clusteredIds).toContain(first.id);
    expect(clusteredIds).toContain(second.id);
  });

  it('does NOT merge a genuinely different event about a different symbol', async () => {
    const first = article({ title: 'Apple announces new AI partnership', symbols: ['AAPL'], publishedAt: '2026-08-20T14:00:00.000Z' });
    const firstOutcome = await engine.createOrUpdateCluster(first, 'Product', impact, 0.9, ['AAPL']);

    const second = article({ title: 'Microsoft announces new AI partnership', symbols: ['MSFT'], publishedAt: '2026-08-20T14:05:00.000Z' });
    const secondOutcome = await engine.createOrUpdateCluster(second, 'Product', impact, 0.9, ['MSFT']);

    expect(secondOutcome!.clusterId).not.toBe(firstOutcome!.clusterId);
    const clusterRows = await db.select().from(schema.newsClusters);
    const firstCluster = clusterRows.find((c: any) => c.id === firstOutcome!.clusterId);
    expect(firstCluster.articleCount).toBe(1);
  });

  it('preserves the existing onConflictDoNothing behavior for a re-processed article id', async () => {
    const a = article({ id: 'stable-id-1', publishedAt: '2026-08-20T15:00:00.000Z' });
    const firstResult = await engine.createOrUpdateCluster(a, 'Product', impact, 0.9, ['AAPL']);
    expect(firstResult).toBeTruthy();

    const secondResult = await engine.createOrUpdateCluster(a, 'Product', impact, 0.9, ['AAPL']);
    expect(secondResult).toBeNull();
  });
});
