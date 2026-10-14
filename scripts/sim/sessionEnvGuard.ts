/**
 * Like-for-like certification guard (2026-10-14). A session launched from a worktree with no `.env` silently runs with production flags OFF
 * (e.g. ARGUS_PORTFOLIO_INTEL_ENABLED), so PortfolioMonitor still ran but wrote ZERO decision telemetry and the independent oracle reported an
 * open position as "unprotected" - an environment difference, not a protection defect (candidate 5e36e191 mt33 incident). Fail fast instead.
 */
import fs from 'node:fs';
import path from 'node:path';

export function assertProductionEnvPresentForSession(cwd: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean = fs.existsSync): void {
  if (env.ARGUS_SYNTH_ALLOW_MISSING_PROD_ENV === '1') return;
  if (exists(path.join(cwd, '.env'))) return;
  throw new Error(
    `FATAL: no .env in ${cwd}. Synthetic certification sessions must run with the same production flags as the release being certified; without ` +
    'them monitoring telemetry and other flagged paths are silently disabled and oracle verdicts are not comparable. Copy the release .env into ' +
    'this worktree (never commit it) or set ARGUS_SYNTH_ALLOW_MISSING_PROD_ENV=1 for a deliberate flag-off run.',
  );
}
