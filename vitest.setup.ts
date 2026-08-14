import { afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Real bug this closes: BrokerAdapter.test.ts (and, as of this same investigation,
 * MarketDataCrossChecker.test.ts) statically import modules that transitively import
 * src/server/db/index.ts, which opens and migrates a real SQLite file at module-load time -
 * with no ARGUS_DB_PATH override set anywhere in either file, that file was the actual live
 * data/argus.db, not an isolated one. Multiple test workers hitting the same live file
 * concurrently is exactly the competing-connection risk CLAUDE.md already documents (a false
 * SQLITE_CORRUPT report from one connection while the app's own stays healthy) - here it more
 * likely manifested as the intermittent whole-suite failures observed when re-running the suite
 * after adding a second real-DB-touching test file.
 *
 * This gives every test file a fresh, unique, isolated temp DB by default, before that file's own
 * imports resolve - so a file that forgets to isolate can no longer reach the real database at
 * all. Test files that need finer control (seeding specific data, inspecting the file directly)
 * still set their own ARGUS_DB_PATH in their own beforeAll before dynamically importing '../db' -
 * that assignment runs after this file's, and simply overrides it before their own import reads it.
 */
const defaultDbPath = path.join(
  os.tmpdir(),
  `argus_test_default_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.ARGUS_DB_PATH = defaultDbPath;

afterAll(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(defaultDbPath + suffix); } catch { /* best-effort cleanup - may never have been created */ }
  }
});
