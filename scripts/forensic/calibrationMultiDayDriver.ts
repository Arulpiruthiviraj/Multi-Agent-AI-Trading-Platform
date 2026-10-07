/**
 * Calibration-Trust Multi-Day Certification - PARENT launcher.
 *
 * Follow-up to docs/audits/ARGUS_CALIBRATION_TRUST_FORENSIC.md's Phases 1-4 (commit b920eb8),
 * which traced - with file:line citations, no code changed - that TechnicalAgent's calibration
 * sample size is 0 in every synthetic session because PredictionOutcomeEvaluator,
 * ConsensusDebateOutcomeEvaluator, ReflectionEngine, and CalibrationValidationWorker are all
 * triggered by a real-wall-clock `setInterval` (5min/5min/60s/15min) that cannot fire inside a
 * ~2-10 real-second synthetic session, no matter how much simulated time that session represents.
 *
 * This script runs TWO isolated children, each its own fresh DB (same isolation discipline as
 * every other scripts/forensic/*RoundTrip.ts harness - never data/argus.db, never the live
 * process, never a real broker):
 *   - COLD: a single run of the AAPL COMPANY_BULLISH_CATALYST_CONVERGENCE fixture on an empty DB
 *     (re-confirms the existing committed 0.6511 / sampleCount=0 / UNTRUSTED result).
 *   - WARM: 10 warmup days (SPY/QQQ only - AAPL deliberately excluded from warmup, see
 *     calibrationMultiDayDriverChild.ts's WARMUP_DAYS header comment, frozen before any run) that
 *     earn real calibration history via the REAL evaluator cycle functions
 *     (src/server/replay/synthetic/SyntheticWallClockOverride.ts controls WHEN they run, never
 *     WHAT they compute - see that file's header), followed by the SAME AAPL target fixture on
 *     the now-warmed DB.
 *
 * Usage: node --use-system-ca ./node_modules/tsx/dist/cli.mjs scripts/forensic/calibrationMultiDayDriver.ts
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
  env.QUANT_ENGINE_ENABLED = 'true';
  return env;
}

async function runChild(mode: 'cold' | 'warm', dbPath: string): Promise<void> {
  const env = buildChildEnv(dbPath);
  const childScriptPath = path.join(__dirname, 'calibrationMultiDayDriverChild.ts');
  const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const specArg = `--mode=${mode}`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, childScriptPath, specArg], {
      env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Calibration multi-day driver (${mode}) child exited with code ${code}`));
    });
  });
}

async function main() {
  const seed = Number(process.argv.find((a) => a.startsWith('--seed='))?.split('=')[1] ?? 20261007);
  const coldSim = `sim_CALTRUST_COLD_${seed}_${Date.now()}`;
  const warmSim = `sim_CALTRUST_WARM_${seed}_${Date.now()}`;
  const { dbPath: coldDbPath } = computeSyntheticSimulationPaths(coldSim);
  const { dbPath: warmDbPath } = computeSyntheticSimulationPaths(warmSim);

  console.log('\n=== PHASE: COLD run (fresh DB, AAPL target fixture only) ===');
  console.log(`DB: ${coldDbPath}`);
  await runChild('cold', coldDbPath);

  console.log('\n=== PHASE: WARM run (10 warmup days + AAPL target fixture, same DB) ===');
  console.log(`DB: ${warmDbPath}`);
  await runChild('warm', warmDbPath);

  console.log('\n=== Both children completed. See their stdout above for the structured reports. ===');
}

main().catch((e) => { console.error('CALIBRATION MULTI-DAY DRIVER FAILED (parent)', e); process.exit(1); });
