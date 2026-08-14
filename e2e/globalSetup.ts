import Database from 'better-sqlite3';
import fs from 'fs';
import { E2E_DB_PATH } from './e2eDbPath';

/**
 * Phase 2A (3-phase remediation, this pass's fix for FINAL_ANALYSIS.md Section 25.5's finding):
 * the E2E DB is fresh and isolated every run, so `settings.onboardingComplete` defaults to false,
 * which force-opens the full-screen Setup Wizard on load and blocks every other UI interaction
 * behind it - the exact reason `moduleToggleParity.spec.ts` timed out.
 *
 * Structurally bypasses the modal by seeding `onboardingComplete = true` directly in the DB
 * before any test runs, rather than relying on every test to remember to dismiss a wizard that
 * has nothing to do with what it's actually testing. Playwright's `webServer` and `globalSetup`
 * both run before any test, but this doesn't assume a specific ordering between them: it polls
 * for the `settings` table (created by the server's own migration runner on boot) to exist before
 * writing, so this works whether the dev server has already booted by the time this runs or not.
 *
 * Deliberately uses `better-sqlite3` directly rather than importing the app's own `db`/schema
 * modules - this is a short-lived setup script, not a second instance of the app, and importing
 * the app's module graph here would risk triggering unrelated side-effecting module-load code
 * (broker singletons, worker intervals) in a process that has no business running them.
 */
async function waitForSettingsTable(dbPath: string, timeoutMs = 45_000): Promise<Database.Database> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath);
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get();
        if (row) return db;
        db.close();
      } catch (e) {
        lastError = e;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`e2e globalSetup: 'settings' table never appeared in ${dbPath} within ${timeoutMs}ms - the dev server's own migrations may not have run. Last error: ${lastError}`);
}

export default async function globalSetup() {
  const db = await waitForSettingsTable(E2E_DB_PATH);
  try {
    // Real, idempotent seed - either updates the row the server's boot migration already
    // inserted, or inserts a fresh one if migrations create the table without a default row.
    const existing = db.prepare('SELECT id FROM settings LIMIT 1').get() as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE settings SET onboarding_complete = 1 WHERE id = ?').run(existing.id);
    } else {
      db.prepare('INSERT INTO settings (onboarding_complete) VALUES (1)').run();
    }
  } finally {
    db.close();
  }
}
