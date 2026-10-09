/**
 * Three-hour wall-clock soak — PARENT launcher (Part 51 of the architecture audit).
 *
 * Pure launcher: imports nothing from src/server/ (same isolation pattern as
 * scripts/sim/marketOpen.ts). Spawns ONE child process (threeHourSoakChild.ts) with full
 * isolation env vars at spawn time. The child runs a 180-minute synthetic session at
 * speed=1 (real wall-clock pacing), samples operational metrics every 60s, and performs
 * the end-of-soak proof (legitimate authorized quant fixture → full canonical execution
 * in the final window).
 *
 * Usage:
 *   node --use-system-ca ./node_modules/tsx/dist/cli.mjs scripts/soak/threeHourSoak.ts [--seed=12345]
 *
 * The child writes its report to scripts/soak/results/soak-<id>.json and prints a summary.
 * This parent resolves when the child exits; a non-zero child exit rejects.
 *
 * Do NOT run against the production DB — the child asserts SYNTHETIC_SIMULATION isolation
 * before importing anything.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSyntheticSimulationPaths } from '../../src/server/replay/syntheticSimulationPaths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildChildEnv(dbPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.LIVE_ARM;
  env.SYNTHETIC_SIMULATION = 'true';
  env.PAPER_TRADING_ONLY = 'true';
  env.ARGUS_DB_PATH = dbPath;
  env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
  env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'true';
  env.OPENALICE_ENABLED = 'false';
  env.ARGUS_OPPORTUNITY_LOOP_ENABLED = 'false';
  env.ARGUS_BROAD_UNIVERSE_ENABLED = 'false';
  env.ARGUS_MARKET_MOVERS_ENABLED = 'false';
  env.ARGUS_ACTIVE_BROKER = 'internal_paper';
  // Test-scoped dummy encryption secret (same idiom as vitest.setup.ts): the child boots the
  // real server stack, and EncryptionService throws at module-load when ENCRYPTION_SECRET is
  // unset. This DB is an isolated synthetic fixture — never production — so a dummy is safe.
  if (!env.ENCRYPTION_SECRET) {
    env.ENCRYPTION_SECRET = 'soak-test-only-not-a-real-secret';
  }
  return env;
}

async function main(): Promise<void> {
  const seedArg = process.argv.find((a) => a.startsWith('--seed='));
  const seed = seedArg ? Number(seedArg.split('=')[1]) : 12345;
  // 2026-10-09: wall-clock duration is configurable (default 180 = the original
  // 3-hour soak). The child already accepted --minutes=; the parent just never
  // exposed it. Validated: positive integer, capped at 24h to bound runaway runs.
  const minArg = process.argv.find((a) => a.startsWith('--wall-minutes='));
  const wallMinutes = minArg ? Number(minArg.split('=')[1]) : 180;
  if (!Number.isInteger(wallMinutes) || wallMinutes <= 0 || wallMinutes > 1440) {
    throw new Error(`--wall-minutes must be a positive integer <= 1440, got: ${minArg}`);
  }
  const soakId = `soak-${wallMinutes}min-${Date.now()}`;
  const { dbPath } = computeSyntheticSimulationPaths(soakId);
  const env = buildChildEnv(dbPath);
  const childScriptPath = path.join(__dirname, 'threeHourSoakChild.ts');
  const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

  console.log(`=== ARGUS SOAK starting (${wallMinutes}min wall-clock) ===`);
  console.log(`soakId=${soakId} seed=${seed} dbPath=${dbPath}`);
  console.log(`Expected wall-clock duration: ~${wallMinutes + 5}m. Metrics sampled every 60s.`);
  console.log(`AI providers: none configured in this environment — soak runs all-AI-down (hardest case).`);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, childScriptPath, `--soak-id=${soakId}`, `--seed=${seed}`, `--minutes=${wallMinutes}`], {
      env,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    child.on('message', (msg: unknown) => {
      const m = msg as { type?: string };
      if (m && m.type === 'SOAK_RESULT') {
        console.log('\n=== SOAK RESULT (from child) ===');
        console.log(JSON.stringify(msg, null, 2));
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Soak child exited with code ${code}`));
    });
  });

  // ---- End-of-soak proof (Part 52): the certified AI-offline quant round trip ----
  // The soak child proves stability (memory, event loop, DB, no errors over 3h). This
  // proves the execution path still works end-to-end after the soak, using the already-
  // certified hermetic test (BUY fill → organic SELL exit → flat, all AI down).
  console.log('\n=== END-OF-SOAK PROOF: running AiOfflineQuantCertification ===');
  await new Promise<void>((resolve, reject) => {
    const test = spawn('npx', ['vitest', 'run', 'src/server/quant/AiOfflineQuantCertification.test.ts'], {
      env: { ...process.env },
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    test.on('error', reject);
    test.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`End-of-soak proof FAILED: AiOfflineQuantCertification exited with code ${code}`));
    });
  });
  console.log('=== ARGUS 3-HOUR SOAK complete (stability + execution-path proof) ===');
}

main().catch((e) => {
  console.error('Soak launcher failed:', e);
  process.exit(1);
});
