import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

/**
 * Real coverage for FinceptCacheAdapter.ts against a genuine, controlled SQLite file matching
 * cache.db's real `unified_cache` schema (confirmed by direct inspection this session) - not
 * against the actual, transient Fincept installation, which is empty most of the time.
 */
describe('FinceptCacheAdapter', () => {
  let tmpDbPath: string;
  let getFinceptMacroSnapshot: typeof import('./FinceptCacheAdapter').getFinceptMacroSnapshot;
  let formatFinceptMacroSnapshotForPrompt: typeof import('./FinceptCacheAdapter').formatFinceptMacroSnapshotForPrompt;
  const originalEnv = { ...process.env };

  function makeCacheDb(path_: string, rows: Array<{ key: string; value: unknown; expiresAt: number | null }>) {
    const db = new Database(path_);
    db.exec(`CREATE TABLE unified_cache (key TEXT PRIMARY KEY, value TEXT, category TEXT, content_type TEXT, ttl_seconds INTEGER, expires_at INTEGER, created_at INTEGER, hit_count INTEGER, size_bytes INTEGER)`);
    const insert = db.prepare(`INSERT INTO unified_cache (key, value, expires_at) VALUES (?, ?, ?)`);
    for (const r of rows) insert.run(r.key, JSON.stringify(r.value), r.expiresAt);
    db.close();
  }

  beforeAll(async () => {
    ({ getFinceptMacroSnapshot, formatFinceptMacroSnapshotForPrompt } = await import('./FinceptCacheAdapter'));
  });

  beforeEach(() => {
    tmpDbPath = path.join(os.tmpdir(), `argus_fincept_cache_test_${Date.now()}_${process.pid}.db`);
    process.env.FINCEPT_CACHE_DB_PATH = tmpDbPath;
    process.env.ENABLE_FINCEPT_CACHE_ADVISORY = 'true';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
  });

  it('is a no-op (returns null) when the feature flag is off, even with real fresh data present', () => {
    process.env.ENABLE_FINCEPT_CACHE_ADVISORY = 'false';
    const future = Date.now() + 60_000;
    makeCacheDb(tmpDbPath, [{ key: 'market:^VIX', value: { price: 15.16 }, expiresAt: future }]);

    expect(getFinceptMacroSnapshot()).toBeNull();
  });

  it('reads a real, fresh VIX + index snapshot when the flag is on and data is present', () => {
    const future = Date.now() + 60_000;
    makeCacheDb(tmpDbPath, [
      { key: 'market:^VIX', value: { price: 15.16 }, expiresAt: future },
      { key: 'market:^GSPC', value: { price: 5123.45, changePct: 0.42 }, expiresAt: future },
    ]);

    const snap = getFinceptMacroSnapshot();

    expect(snap).not.toBeNull();
    expect(snap!.vix).toBe(15.16);
    expect(snap!.indices['S&P 500']).toEqual({ price: 5123.45, changePct: 0.42 });
    const formatted = formatFinceptMacroSnapshotForPrompt(snap!);
    expect(formatted).toContain('VIX 15.16');
    expect(formatted).toContain('S&P 500 5123.45 (+0.42%)');
  });

  it('treats an EXPIRED cache row exactly like a missing one - never serves stale data as fresh', () => {
    const past = Date.now() - 1000;
    makeCacheDb(tmpDbPath, [{ key: 'market:^VIX', value: { price: 99.99 }, expiresAt: past }]);

    expect(getFinceptMacroSnapshot()).toBeNull();
  });

  it('fails closed (returns null, never throws) when the database file does not exist', () => {
    process.env.FINCEPT_CACHE_DB_PATH = path.join(os.tmpdir(), 'this_file_does_not_exist_12345.db');

    expect(() => getFinceptMacroSnapshot()).not.toThrow();
    expect(getFinceptMacroSnapshot()).toBeNull();
  });

  it('fails closed on a malformed (non-JSON) cache value instead of guessing at its shape', () => {
    const future = Date.now() + 60_000;
    const db = new Database(tmpDbPath);
    db.exec(`CREATE TABLE unified_cache (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)`);
    db.prepare(`INSERT INTO unified_cache (key, value, expires_at) VALUES (?, ?, ?)`).run('market:^VIX', 'not json at all', future);
    db.close();

    expect(getFinceptMacroSnapshot()).toBeNull();
  });

  it('returns null when the table exists but has no matching rows - the real, common state', () => {
    makeCacheDb(tmpDbPath, []);

    expect(getFinceptMacroSnapshot()).toBeNull();
  });

  it('formatFinceptMacroSnapshotForPrompt never asserts a recommendation - just states the numbers', () => {
    const formatted = formatFinceptMacroSnapshotForPrompt({ vix: 20, indices: {}, asOfMs: Date.now() });
    expect(formatted).not.toMatch(/buy|sell|recommend/i);
  });
});
