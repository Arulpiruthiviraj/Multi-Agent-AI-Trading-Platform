/** CLI component test: real isolated child, no seeded authority or injected approvals. */
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import Database from 'better-sqlite3';

it('reports missing authority and unexecuted release evidence without claiming READY', { timeout: 120_000 }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'argus-release-probe-test-'));
  try {
    const dbPath = join(folder, 'isolated.db');
    new Database(dbPath).close();
    const result = spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('scripts/certifyNextSession.ts'), `--isolated-db=${dbPath}`, '--json'], {
      cwd: process.cwd(), timeout: 90_000, encoding: 'utf8', maxBuffer: 2_000_000,
      env: { ...process.env, ARGUS_DB_PATH: dbPath, PAPER_TRADING_ONLY: 'true', ARGUS_DISABLE_MARKET_DATA_WS: 'true',
        ENCRYPTION_SECRET: 'CERTIFICATION_FIXTURE_ONLY', OPENALICE_ENABLED: 'false' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.overallStatus).toBe('NO_GO');
    expect(report.certificationScope).toBe('PRODUCTION_STATE_POLICY_AND_DB_DATA_PROBES_ONLY');
    expect(report.lifecycleSummary.authorizedPaperQuantStrategies).toBe(0);
    expect(report.unverifiedReleaseChecks).toEqual(expect.arrayContaining([
      { area: 'executedArtifact', status: 'NOT_RUN' }, { area: 'resourceSoak', status: 'NOT_RUN' },
    ]));
    expect(report.conditions.join(' ')).toContain('RELEASE_CERTIFICATION_INCOMPLETE');
  } finally {
    if (dirname(folder) !== resolve(tmpdir()) || !basename(folder).startsWith('argus-release-probe-test-')) throw new Error('Unsafe cleanup');
    rmSync(folder, { recursive: true, force: true });
  }
});
