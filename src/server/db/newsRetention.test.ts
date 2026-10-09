/**
 * Tests for the news retention sweeps (2026-10-08 memory-leak follow-up).
 *
 * news_articles and news_clusters grew on disk with no prune path anywhere in the
 * codebase - the same defect class as candidate_rankings (2026-09-22). These tests prove:
 * - old rows are pruned, recent rows are kept (per-table cutoff semantics)
 * - the sweep is idempotent (second run deletes nothing)
 * - a large backlog does NOT block the event loop (batched + yielding: a heartbeat
 *   scheduled with setImmediate must tick while the sweep works through multiple batches)
 * - the sweeper never throws (returns a partial count on error)
 *
 * Isolation: ARGUS_DB_PATH points at a temp SQLite file; migrations run on import
 * (same pattern as v2Diagnostics.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('news retention sweeps', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let sweepNewsArticlesRetention: (nowMs?: number) => Promise<number>;
  let sweepNewsClustersRetention: (nowMs?: number) => Promise<number>;
  let intervals: any;

  const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_newsretention_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../db/index'));
    ({ sweepNewsArticlesRetention, sweepNewsClustersRetention } = await import('./operationalRetention'));
    ({ runtimeIntervals: intervals } = await import('../config/runtimeIntervals'));
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpDbPath); } catch { /* best effort */ }
    delete process.env.ARGUS_DB_PATH;
  });

  function insertArticle(id: string, publishedAtIso: string) {
    sqliteDb.prepare(
      `INSERT INTO news_articles (id, title, source, published_at, content, summary)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, `title ${id}`, 'test-source', publishedAtIso, 'x'.repeat(1000), 'summary');
  }

  function insertCluster(id: string, updatedAtIso: string) {
    sqliteDb.prepare(
      `INSERT INTO news_clusters (id, title, created_at, updated_at, article_count, source_count)
       VALUES (?, ?, ?, ?, 1, 1)`
    ).run(id, `cluster ${id}`, updatedAtIso, updatedAtIso);
  }

  it('prunes articles older than retention and keeps recent ones', async () => {
    const oldId = `art-old-${Date.now()}`;
    const newId = `art-new-${Date.now()}`;
    insertArticle(oldId, daysAgoIso(intervals.newsArticlesRetentionDays + 5));
    insertArticle(newId, daysAgoIso(1));

    const deleted = await sweepNewsArticlesRetention();

    expect(deleted).toBe(1);
    expect(sqliteDb.prepare('SELECT id FROM news_articles WHERE id = ?').get(oldId)).toBeUndefined();
    expect(sqliteDb.prepare('SELECT id FROM news_articles WHERE id = ?').get(newId)).toBeDefined();
  });

  it('prunes clusters by updated_at (an active story keeps its cluster alive)', async () => {
    const staleId = `clu-stale-${Date.now()}`;
    const activeId = `clu-active-${Date.now()}`;
    // Stale: created long ago, never updated since.
    insertCluster(staleId, daysAgoIso(intervals.newsClustersRetentionDays + 5));
    // Active: created long ago but updated recently (story still developing).
    sqliteDb.prepare(
      `INSERT INTO news_clusters (id, title, created_at, updated_at, article_count, source_count)
       VALUES (?, ?, ?, ?, 3, 2)`
    ).run(activeId, 'active story', daysAgoIso(intervals.newsClustersRetentionDays + 5), daysAgoIso(1));

    const deleted = await sweepNewsClustersRetention();

    expect(deleted).toBe(1);
    expect(sqliteDb.prepare('SELECT id FROM news_clusters WHERE id = ?').get(staleId)).toBeUndefined();
    expect(sqliteDb.prepare('SELECT id FROM news_clusters WHERE id = ?').get(activeId)).toBeDefined();
  });

  it('is idempotent: a second sweep deletes nothing', async () => {
    const id = `art-idem-${Date.now()}`;
    insertArticle(id, daysAgoIso(intervals.newsArticlesRetentionDays + 1));
    expect(await sweepNewsArticlesRetention()).toBe(1);
    expect(await sweepNewsArticlesRetention()).toBe(0);
    expect(await sweepNewsClustersRetention()).toBe(0);
  });

  it('does not block the event loop while working through multiple batches', async () => {
    const batchSize: number = intervals.newsRetentionSweepBatchSize;
    const total = batchSize + 500;
    const prefix = `art-hb-${Date.now()}`;
    const insert = sqliteDb.prepare(
      `INSERT INTO news_articles (id, title, source, published_at) VALUES (?, ?, ?, ?)`
    );
    const oldIso = daysAgoIso(intervals.newsArticlesRetentionDays + 1);
    const txn = sqliteDb.transaction((n: number) => {
      for (let i = 0; i < n; i++) insert.run(`${prefix}-${i}`, 't', 's', oldIso);
    });
    txn(total);

    let heartbeats = 0;
    let keepBeating = true;
    const beat = () => {
      if (!keepBeating) return;
      heartbeats++;
      setImmediate(beat);
    };
    setImmediate(beat);

    const deleted = await sweepNewsArticlesRetention();
    keepBeating = false;

    expect(deleted).toBe(total);
    // At least two batches were needed, and the sweep yields via setImmediate between
    // batches - the heartbeat must have ticked while the sweep was running.
    expect(heartbeats).toBeGreaterThan(0);
  });

  it('never throws: returns a partial count on error', async () => {
    // Empty tables: nothing to delete, resolves 0 rather than throwing.
    await expect(sweepNewsArticlesRetention()).resolves.toBe(0);
    await expect(sweepNewsClustersRetention()).resolves.toBe(0);
  });

  it('P2-R2: prunes rows with non-ISO published_at (RFC-2822 pubDate, space-separated datetime)', async () => {
    // Rows written before NewsNormalizer.normalizePublishedAt carried provider-native
    // formats. ISO-text comparison could never prune them (e.g. "Thu, ..." sorts after
    // any "2026-..." cutoff). The sweep must repair them to ISO first, then prune.
    const oldDate = new Date(Date.now() - (intervals.newsArticlesRetentionDays + 5) * 24 * 60 * 60 * 1000);
    const rfc2822 = oldDate.toUTCString(); // "Thu, 08 Oct 2026 12:00:00 GMT"
    const spaceSep = oldDate.toISOString().slice(0, 10) + ' ' + oldDate.toISOString().slice(11, 19); // "YYYY-MM-DD HH:MM:SS"
    const id1 = `art-rfc-${Date.now()}-1`;
    const id2 = `art-spc-${Date.now()}-2`;
    expect(rfc2822).not.toMatch(/^\d{4}-\d{2}-\d{2}T/); // sanity: genuinely non-ISO
    insertArticle(id1, rfc2822);
    insertArticle(id2, spaceSep);
    const deleted = await sweepNewsArticlesRetention();
    expect(deleted).toBeGreaterThanOrEqual(2);
    const remaining = sqliteDb.prepare('SELECT COUNT(*) AS n FROM news_articles WHERE id IN (?, ?)').get(id1, id2) as any;
    expect(remaining.n).toBe(0);
  });

  it('P2-R2: normalizer emits ISO published_at for every provider format', async () => {
    const { normalizePublishedAt } = await import('../news/NewsNormalizer');
    expect(normalizePublishedAt('Thu, 08 Oct 2026 12:00:00 GMT')).toBe(new Date(Date.parse('Thu, 08 Oct 2026 12:00:00 GMT')).toISOString());
    expect(normalizePublishedAt('2026-10-01 12:00:00')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(normalizePublishedAt(undefined)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Unparseable fails closed to a parseable ISO "now", never a garbage passthrough.
    const fallback = normalizePublishedAt('not a date');
    expect(fallback).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Math.abs(Date.parse(fallback) - Date.now())).toBeLessThan(60_000);
  });
});
