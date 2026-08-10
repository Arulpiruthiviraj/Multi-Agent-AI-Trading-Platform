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

// ARGUS_DB_PATH lets integration tests (or anything else) point at an isolated SQLite file
// instead of the real data/argus.db - see CLAUDE.md's warning about a second connection to the
// live file. Production/dev behavior is unchanged when it's unset.
const dbDir = fs.existsSync('/data') ? '/data' : path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const dbPath = process.env.ARGUS_DB_PATH || path.join(dbDir, 'argus.db');
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');

export const db = drizzle(sqlite, { schema });
export const sqliteDb = sqlite;
export { dbPath };

// Run migrations on startup
try {
  console.log("Running migrations...");
  migrate(db, { migrationsFolder: path.join(process.cwd(), 'drizzle') });
  console.log("Migrations complete.");
} catch (error) {
  console.error("Migration failed:", error);
}

console.log("Database initialized at:", dbPath);

import { seedDefaultModels } from './seedModels';
seedDefaultModels().catch(console.error);
