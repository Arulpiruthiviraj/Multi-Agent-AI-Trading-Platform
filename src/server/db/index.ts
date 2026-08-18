/**
 * ==========================================================
 * Module:
 * index.ts
 *
 * Purpose:
 * Core implementation and logic for the index.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for index
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';
import path from 'path';
import fs from 'fs';
import { resolveDbDir } from './resolveDbDir';

// ARGUS_DB_PATH lets integration tests (or anything else) point at an isolated SQLite file
// instead of the real data/argus.db - see CLAUDE.md's warning about a second connection to the
// live file. Production/dev behavior is unchanged when it's unset.
const dbDir = resolveDbDir(process.platform, fs.existsSync, process.cwd(), path.resolve);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = process.env.ARGUS_DB_PATH || path.join(dbDir, 'argus.db');
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('busy_timeout = 5000');
// Standard WAL-mode pairing (SQLite's own recommendation): NORMAL only fsyncs at WAL checkpoints
// instead of every transaction. Durability is still covered by the WAL file itself - a full OS
// crash could lose the most recent commit, not corrupt the DB. busy_timeout above already covers
// SQLITE_BUSY under concurrent readers/writers; this is a throughput improvement, not a new safety
// mechanism.
sqlite.pragma('synchronous = NORMAL');

export const db = drizzle(sqlite, { schema });
export const sqliteDb = sqlite;
export { dbPath };

// Run migrations on startup. Real bug found and fixed this pass (FINAL_ANALYSIS.md 15.13/15.22
// High #7): a failed migration used to be caught, logged, and swallowed - the process continued
// running against a possibly-inconsistent schema instead of refusing to start. This module is
// imported before any route/agent code runs (server.ts's very first real import), so re-throwing
// here crashes the process during startup, before it can ever serve a request or place a trade -
// "must not start as healthy" rather than "started, but silently broken."
console.log("Running migrations...");
try {
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  console.log("Migrations complete.");
} catch (error) {
  console.error("[FATAL] Database migration failed - refusing to start with a possibly-inconsistent schema.", error);
  throw error;
}

console.log("Database initialized at:", dbPath);

import { seedDefaultModels } from './seedModels';
seedDefaultModels().catch(console.error);
