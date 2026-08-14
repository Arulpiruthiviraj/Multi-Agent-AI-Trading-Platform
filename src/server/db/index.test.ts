import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

/**
 * Real regression test for a P1 fix (FINAL_ANALYSIS.md 15.13/15.22 High #7): a failed migration
 * used to be caught, logged, and swallowed - the app kept running against a possibly-
 * inconsistent schema. `db/index.ts` now re-throws, which crashes the process during startup
 * (before any route/agent code can run) instead of silently degrading.
 *
 * Forces a REAL migration failure (not a mock) by pre-creating a table that migration 0000 also
 * tries to create, with an incompatible definition - the same class of conflict a hand-modified
 * or partially-restored production DB could hit for real.
 */
describe('db/index.ts - migration failure must not be silently swallowed', () => {
  let tmpDbPath: string | undefined;

  afterEach(() => {
    if (tmpDbPath) {
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
      }
    }
    tmpDbPath = undefined;
    delete process.env.ARGUS_DB_PATH;
    vi.resetModules(); // force the next test's `import('../db')` to re-evaluate the module fresh
  });

  it('throws (does not silently continue) when a migration genuinely fails against the real DB', async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_migfail_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    // Pre-create a real conflict: migration 0000 also does `CREATE TABLE agent_memory (...)` -
    // this incompatible pre-existing definition makes that statement fail for real, not a mock.
    const seed = new Database(tmpDbPath);
    seed.exec('CREATE TABLE agent_memory (totally_incompatible_column TEXT)');
    seed.close();

    await expect(import('../db/index')).rejects.toThrow();
  });

  it('starts cleanly (no throw) against a genuinely fresh DB - proves the test above is a real migration failure, not an environment issue', async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_migok_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    const mod = await import('../db/index');
    try {
      const cols = mod.sqliteDb.prepare("PRAGMA table_info(agent_memory)").all() as any[];
      expect(cols.length).toBeGreaterThan(0); // the real migration actually ran and created it
    } finally {
      try { mod.sqliteDb.close(); } catch { /* already closed */ }
    }
  });
});
