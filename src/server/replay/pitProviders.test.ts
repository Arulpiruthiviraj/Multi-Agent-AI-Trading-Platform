import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * PIT Agent Ledger System - real integration tests (isolated temp SQLite DB, never data/argus.db).
 * Proves two things per provider: (1) the loader reads real rows scoped to the requested
 * symbols/window, and (2) the *VisibleAt point-in-time filter never leaks a record whose real
 * timestamp is strictly after the replay clock's current time - the actual zero-lookahead
 * guarantee FullArgusReplayEngine.ts depends on when it calls these mid-replay.
 */
describe('PIT Agent Ledger System providers - zero lookahead', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let ReplayClock: any;
  let InformationCutoff: any;
  let macroModule: any;
  let fundamentalModule: any;
  let newsModule: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pit_providers_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ ReplayClock } = await import('../engines/backtest/ReplayClock'));
    ({ InformationCutoff } = await import('./InformationCutoff'));
    macroModule = await import('./HistoricalMacroProvider');
    fundamentalModule = await import('./HistoricalFundamentalProvider');
    newsModule = await import('./HistoricalNewsProvider');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  const T = Date.parse('2024-06-03T14:30:00Z');

  it('loadHistoricalMacroProvider reads only real rows inside the requested window, and macroReleasesVisibleAt never leaks a future release', async () => {
    await db.insert(schema.historicalMacroReleases).values([
      { id: 'macro-past', eventId: 'CPI-2024-05', releaseDateMs: T - 60_000, metric: 'CPI', actual: 3.1, forecast: 3.2, previous: 3.3, impact: 'HIGH', source: 'test', createdAt: new Date().toISOString() },
      { id: 'macro-future', eventId: 'CPI-2024-07', releaseDateMs: T + 60_000, metric: 'CPI', actual: 3.0, forecast: 3.1, previous: 3.1, impact: 'HIGH', source: 'test', createdAt: new Date().toISOString() },
      { id: 'macro-outside-window', eventId: 'CPI-2020-01', releaseDateMs: T - 1_000_000_000, metric: 'CPI', actual: 2.0, forecast: 2.0, previous: 2.0, impact: 'HIGH', source: 'test', createdAt: new Date().toISOString() },
    ]);

    const provider = await macroModule.loadHistoricalMacroProvider(T - 120_000, T + 120_000);
    expect(provider.available).toBe(true);
    expect(provider.all().map((r: any) => r.eventId).sort()).toEqual(['CPI-2024-05', 'CPI-2024-07']);

    const clock = new ReplayClock(T);
    const cutoff = new InformationCutoff(clock);
    const visible = macroModule.macroReleasesVisibleAt(provider, cutoff);
    expect(visible.map((r: any) => r.eventId)).toEqual(['CPI-2024-05']);
    expect(visible.some((r: any) => r.eventId === 'CPI-2024-07')).toBe(false);
  });

  it('loadHistoricalMacroProvider returns the unavailable provider when no rows exist for the window (never fabricates a release)', async () => {
    const provider = await macroModule.loadHistoricalMacroProvider(T + 10_000_000, T + 20_000_000);
    expect(provider.available).toBe(false);
    expect(provider.status).toBe('HISTORICAL_MACRO_UNAVAILABLE');
    expect(provider.all()).toEqual([]);
  });

  it('loadHistoricalFundamentalProvider + latestFundamentalSnapshotAsOf returns the most recent filing at-or-before cutoff, never a future one', async () => {
    await db.insert(schema.historicalFundamentalSnapshots).values([
      { id: 'fund-q1', symbol: 'PITCO', filingDateMs: T - 90 * 86_400_000, peRatio: 20, pbRatio: 3, roe: 0.15, debtToEquity: 0.5, source: 'test', createdAt: new Date().toISOString() },
      { id: 'fund-q2', symbol: 'PITCO', filingDateMs: T - 1_000, peRatio: 22, pbRatio: 3.2, roe: 0.16, debtToEquity: 0.48, source: 'test', createdAt: new Date().toISOString() },
      { id: 'fund-q3-future', symbol: 'PITCO', filingDateMs: T + 90 * 86_400_000, peRatio: 25, pbRatio: 3.5, roe: 0.18, debtToEquity: 0.45, source: 'test', createdAt: new Date().toISOString() },
    ]);

    const provider = await fundamentalModule.loadHistoricalFundamentalProvider(['PITCO']);
    expect(provider.available).toBe(true);
    expect(provider.all().length).toBe(3);

    const clock = new ReplayClock(T);
    const cutoff = new InformationCutoff(clock);
    const snap = fundamentalModule.latestFundamentalSnapshotAsOf(provider, cutoff, 'PITCO');
    expect(snap?.filingAtMs).toBe(T - 1_000);
    expect(snap?.peRatio).toBe(22);
  });

  it('latestFundamentalSnapshotAsOf returns null (never fabricates a ratio) when no qualifying filing exists yet at that point in the replay', async () => {
    await db.insert(schema.historicalFundamentalSnapshots).values([
      { id: 'fund-later-co', symbol: 'NOFILING', filingDateMs: T + 5_000, peRatio: 10, pbRatio: 1, roe: 0.1, debtToEquity: 0.3, source: 'test', createdAt: new Date().toISOString() },
    ]);
    const provider = await fundamentalModule.loadHistoricalFundamentalProvider(['NOFILING']);
    const clock = new ReplayClock(T);
    const cutoff = new InformationCutoff(clock);
    const snap = fundamentalModule.latestFundamentalSnapshotAsOf(provider, cutoff, 'NOFILING');
    expect(snap).toBeNull();
  });

  it('loadHistoricalNewsArchiveProvider scopes to requested symbols/window, and newsVisibleAt never leaks a future headline', async () => {
    await db.insert(schema.historicalNewsArchive).values([
      { id: 'news-past', symbol: 'PITCO', publishedAtMs: T - 30_000, headline: 'PITCO beats estimates', summary: 's', sentimentScore: 0.6, source: 'test', createdAt: new Date().toISOString() },
      { id: 'news-future', symbol: 'PITCO', publishedAtMs: T + 30_000, headline: 'PITCO misses next quarter (should never be visible yet)', summary: 's', sentimentScore: -0.5, source: 'test', createdAt: new Date().toISOString() },
      { id: 'news-other-symbol', symbol: 'OTHERCO', publishedAtMs: T - 30_000, headline: 'Unrelated', summary: 's', sentimentScore: 0.2, source: 'test', createdAt: new Date().toISOString() },
    ]);

    const provider = await newsModule.loadHistoricalNewsArchiveProvider(['PITCO'], T - 120_000, T + 120_000);
    expect(provider.available).toBe(true);
    expect(provider.id).toBe('historical_news_archive');
    expect(provider.all().map((n: any) => n.newsId).sort()).toEqual(['news-future', 'news-past']);

    const clock = new ReplayClock(T);
    const cutoff = new InformationCutoff(clock);
    const visible = newsModule.newsVisibleAt(provider, cutoff, 'PITCO');
    expect(visible.map((n: any) => n.newsId)).toEqual(['news-past']);
    expect(visible.some((n: any) => n.newsId === 'news-future')).toBe(false);
  });

  it('loadHistoricalNewsArchiveProvider returns the unavailable provider for a window/symbol set with no real rows', async () => {
    const provider = await newsModule.loadHistoricalNewsArchiveProvider(['NEVERSEEN'], T, T + 1000);
    expect(provider.available).toBe(false);
    expect(provider.status).toBe('HISTORICAL_NEWS_UNAVAILABLE');
  });
});
