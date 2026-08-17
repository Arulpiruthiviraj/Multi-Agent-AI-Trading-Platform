import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseStoredSymbols, mapInternalNewsRows } from './internalNewsForTicker';

describe('parseStoredSymbols', () => {
  it('parses JSON arrays and does not throw on plain ticker strings', () => {
    expect(parseStoredSymbols(JSON.stringify(['AAPL', 'MSFT']), 'SPY')).toEqual(['AAPL', 'MSFT']);
    expect(parseStoredSymbols('AAPL', 'SPY')).toEqual(['AAPL']);
    expect(parseStoredSymbols(undefined, 'NVDA')).toEqual(['NVDA']);
  });
});

describe('mapInternalNewsRows', () => {
  it('maps NewsEngine cluster rows without JSON.parse throwing', () => {
    const mapped = mapInternalNewsRows(
      [{ id: 'c1', title: 'Headline', summary: 'Body', source: 'RSS', createdAt: '2026-01-01', symbols: '["AAPL"]' }],
      'AAPL',
    );
    expect(mapped[0].headline).toBe('Headline');
    expect(mapped[0].symbols).toEqual(['AAPL']);
    expect(mapped[0].source).toBe('RSS');
  });
});

describe('loadInternalNewsForTicker', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let loadInternalNewsForTicker: typeof import('./internalNewsForTicker').loadInternalNewsForTicker;
  let db: any;
  let schema: typeof import('../db/schema');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_internalnews_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ sqliteDb, db } = await import('../db'));
    schema = await import('../db/schema');
    ({ loadInternalNewsForTicker } = await import('./internalNewsForTicker'));
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  it('returns available:false with empty news when nothing is stored (never 500)', async () => {
    const payload = await loadInternalNewsForTicker('TICKER_WITH_NO_STORED_NEWS');
    expect(payload.available).toBe(false);
    expect(payload.news).toEqual([]);
    expect(payload.source).toBe('NewsEngine');
    expect(payload.reason).toMatch(/no stored items/i);
  });

  it('returns NewsEngine clusters when present', async () => {
    await db.insert(schema.newsClusters).values({
      id: 'cluster_test_aapl',
      title: 'Internal AAPL item',
      summary: 'From NewsEngine',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      symbols: JSON.stringify(['AAPL']),
    });

    const payload = await loadInternalNewsForTicker('AAPL');
    expect(payload.available).toBe(true);
    expect(payload.news.length).toBeGreaterThan(0);
    expect(payload.news[0].headline).toBe('Internal AAPL item');
    expect(payload.source).toBe('NewsEngine');
  });
});
