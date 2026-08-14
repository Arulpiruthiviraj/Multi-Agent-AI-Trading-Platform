import { defineConfig } from '@playwright/test';
import { E2E_DB_PATH } from './e2e/e2eDbPath';

/**
 * Phase 4B (FINAL_ANALYSIS.md's 4-phase remediation plan) - real browser-driven E2E, the one
 * testing gap this entire engagement has repeatedly flagged and never closed (Section 15.15/
 * 15.23 P9: "zero browser-driven E2E tests"). Runs the actual dev server against a fresh,
 * isolated, disposable temp DB and throwaway auth credentials - never the real data/argus.db or
 * the real .env secrets, so this can run safely without touching real account state.
 *
 * Phase 2A (3-phase remediation pass) - `globalSetup` seeds `settings.onboardingComplete = true`
 * into this same isolated DB before any test runs, so the Setup Wizard modal never force-opens
 * and blocks the rest of the UI (Section 25.5's finding: a fresh isolated DB defaults
 * onboardingComplete to false, which trapped the one existing E2E test behind that modal).
 */

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  reporter: 'list',
  // A plain relative path, not require.resolve() - this project is ESM ("type": "module" in
  // package.json), where `require` doesn't exist. Playwright resolves this relative to this
  // config file's own directory.
  globalSetup: './e2e/globalSetup.ts',
  webServer: {
    // Calls tsx directly, not `npm run dev` - `dev` now conditionally starts a second, separate
    // OpenAlice process (scripts/devWithOpenAlice.ts) when OPENALICE_ENABLED=true, which this E2E
    // run must never trigger as a side effect. OPENALICE_ENABLED is also force-overridden to
    // 'false' below as a second, explicit guard, independent of which command is used here.
    command: 'npx tsx server.ts',
    url: 'http://localhost:3000/health',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ARGUS_DB_PATH: E2E_DB_PATH,
      AUTH_USERNAME: 'e2e-admin',
      AUTH_PASSWORD: 'e2e-test-password-not-real',
      AUTH_SESSION_SECRET: 'e2e-test-session-secret-not-real-do-not-use-in-production',
      NODE_ENV: 'development',
      OPENALICE_ENABLED: 'false',
    },
  },
  use: {
    baseURL: 'http://localhost:3000',
    screenshot: 'only-on-failure',
  },
});
