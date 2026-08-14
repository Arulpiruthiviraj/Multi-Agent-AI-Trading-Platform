import path from 'path';
import os from 'os';

/**
 * Single source of truth for the E2E run's isolated temp DB path - shared between
 * `playwright.config.ts` (which passes it to the spawned `npm run dev` server via
 * `ARGUS_DB_PATH`) and `globalSetup.ts` (which seeds `settings.onboardingComplete = true` into
 * that same file before the server boots). Computed once per module load so both sides agree on
 * the identical path; if each computed `Date.now()+pid` independently they would disagree and
 * globalSetup would seed a file the server never actually opens.
 */
export const E2E_DB_PATH = path.join(os.tmpdir(), `argus_e2e_${Date.now()}_${process.pid}.db`);
