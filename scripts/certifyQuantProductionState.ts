/** Read-only source snapshot + isolated canonical authorization check. No lifecycle seeding. */
import Database from 'better-sqlite3';
import { parse } from 'dotenv';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function main() {
  const childInput = process.argv.find(a => a.startsWith('--snapshot='));
  if (childInput) {
    const inputPath = path.resolve(childInput.slice('--snapshot='.length));
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const { sqliteDb } = await import('../src/server/db');
    try {
      // Populate only the isolated DB with verbatim source records, never earned-state fixtures.
      const columns = ['id', 'version_type', 'parent_version_id', 'status', 'state_json',
        'hypothesis', 'evidence_json', 'sample_size', 'created_at', 'promoted_at', 'retired_at'];
      const insert = sqliteDb.prepare(`INSERT INTO learning_versions (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      sqliteDb.transaction(() => {
        for (const row of input.rows) insert.run(...columns.map(c => row[c] ?? null));
        const overrideInsert = sqliteDb.prepare('INSERT INTO config_overrides (key,value,updated_at,updated_by) VALUES (?,?,?,?)');
        for (const row of input.overrides) overrideInsert.run(row.key, row.value, row.updated_at, row.updated_by);
      })();
      const { hydrateRuntimeConfigFromDb } = await import('../src/server/config/effectiveRuntimeConfig');
      await hydrateRuntimeConfigFromDb();
      const { buildQuantReadinessReport } = await import('../src/server/routes/v2Diagnostics');
      const report = await buildQuantReadinessReport();
      console.log(JSON.stringify({
        certification: 'PRODUCTION_POLICY_CERTIFICATION',
        scope: 'actual lifecycle snapshot, current registry/config and canonical authorization; no signal or execution certification',
        sourceCapturedAt: input.capturedAt,
        sourceLifecycleRows: input.rows.length,
        sourceConfigOverrideRows: input.overrides.length,
        result: report.summary.authorizedQuantPolicy > 0 ? 'AUTHORITY_PRESENT' : 'QUANT_FIRST_OPERATIONALLY_INACTIVE',
        report,
      }, null, 2));
      // A failed release check is a result, not permission to manufacture authorization.
      process.exitCode = report.summary.authorizedQuantPolicy > 0 ? 0 : 2;
    } finally {
      sqliteDb.close();
    }
    // Imports may install diagnostic timers; this command has no running engine to drain.
    process.exit(process.exitCode ?? 0);
  }

  const envFile = fs.existsSync('.env') ? parse(fs.readFileSync('.env')) : {};
  const env = { ...envFile, ...process.env };
  const sourcePath = path.resolve(env.ARGUS_DB_PATH || 'data/argus.db');
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  let snapshot;
  try {
    source.pragma('query_only=ON');
    snapshot = source.transaction(() => ({
      capturedAt: new Date().toISOString(),
      rows: source.prepare("SELECT * FROM learning_versions WHERE version_type LIKE 'strategyEligibility:%' ORDER BY created_at,rowid").all(),
      overrides: source.prepare('SELECT * FROM config_overrides ORDER BY key').all(),
    }))();
  } finally { source.close(); }

  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-quant-policy-cert-'));
  const snapshotPath = path.join(snapshotRoot, 'lifecycle.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
  try {
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--use-system-ca', path.resolve('node_modules/tsx/dist/cli.mjs'),
        path.resolve('scripts/certifyQuantProductionState.ts'), `--snapshot=${snapshotPath}`,
      ], {
        env: { ...env, ARGUS_DB_PATH: path.join(snapshotRoot, 'snapshot.db'),
          SYNTHETIC_SIMULATION: 'false', ARGUS_DISABLE_MARKET_DATA_WS: 'true',
          ENCRYPTION_SECRET: env.ENCRYPTION_SECRET || 'isolated-policy-snapshot-only' },
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', code => resolve(code ?? 1));
    });
    process.exitCode = code;
  } finally {
    // Remove only this freshly-created snapshot directory; never sourcePath.
    if (path.dirname(snapshotRoot) !== path.resolve(os.tmpdir()) ||
        !path.basename(snapshotRoot).startsWith('argus-quant-policy-cert-')) {
      throw new Error('Refusing snapshot cleanup outside the owned temporary directory');
    }
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
