/**
 * Synthetic Market Session Simulator CLI - PARENT launcher (2026-09-14 mandate, Step 1 isolation
 * hardening rewrite). Classification: OFFLINE-FORENSIC / RESEARCH-ONLY, same as scripts/forensic/ -
 * isolated tmp DB, never the live engine, never a real broker.
 *
 * Architecture (why this file changed shape): a same-process version of this simulator caused a
 * real production-database pollution incident (see marketOpenChild.ts's header comment and
 * src/server/db/syntheticSimulationDbGuard.ts for the full account) because isolation env vars were
 * set by a class METHOD - code that only runs after its enclosing module (and everything it
 * transitively imports) has already been imported and evaluated. Any future static top-level import
 * of a db-touching module anywhere in that chain could silently race ahead of the env-var setup.
 *
 * This file is deliberately a PURE LAUNCHER: it imports nothing from src/server/ (grep this file -
 * there is no such import), computes the isolated DB path itself via the same pure formula
 * SyntheticSessionEngine uses (src/server/replay/syntheticSimulationPaths.ts - imported here only
 * because it is provably side-effect-free, never opens a DB/broker/EventBus connection), and spawns
 * a CHILD Node process (marketOpenChild.ts) with every isolation env var set via child_process's
 * `env` option AT SPAWN TIME. Node guarantees process.env is fully populated before a single line of
 * the child's own JS - including its very first import statement - executes. This closes the bug
 * class structurally rather than by import-ordering convention.
 *
 * Usage:
 *   npm run sim:market-open -- --scenario=QUIET_OPEN --seed=12345
 *   npm run sim:market-open -- --scenario=TRENDING_BULL_GAP_AND_GO --seed=12345 --speed=60
 *   npm run sim:market-open -- --certify   (runs BOTH mandatory certification tests, each in its
 *                                            own fresh child process)
 *
 * Flags:
 *   --scenario=<id>      QUIET_OPEN | EXTREME_NOISE | TRENDING_BULL_GAP_AND_GO | NEWS_SHOCK |
 *                         VALIDATED_CONVERGENCE_CONTROL
 *   --seed=<n>            deterministic PRNG seed (default 12345)
 *   --speed=<n>           clock speedMultiplier (default 1)
 *   --duration=<minutes>  session length (default 90)
 *   --symbols=<n>         universe size (default 5)
 *   --certify             ignores --scenario; runs Test A (QUIET_OPEN) + Test B
 *                          (VALIDATED_CONVERGENCE_CONTROL) and prints both certification reports.
 *                          Test B seeds a synthetic prior calibration history by default (see
 *                          CalibrationHistorySeeder.ts) - pass --no-seed-calibration to see the
 *                          plain organic (pre-seed) diagnostic instead.
 *   --seed-calibration    (plain single-scenario runs only) apply the same synthetic calibration
 *                          seed set --certify's Test B uses. Off by default outside --certify.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSyntheticSimulationPaths } from '../../src/server/replay/syntheticSimulationPaths';
import { parseArgs, type ScenarioRunSpec, DEFAULT_CALIBRATION_SEEDS } from './simCliArgs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ChildResultMessage {
  type: 'SIMULATION_RESULT';
  certification: 'PASS' | 'FAIL' | null;
  tradeObserved: boolean | null;
  zeroTradeReason: string | null;
  firstBlockingStage: string | null;
  calibrationSeeded: boolean;
}

function buildChildEnv(dbPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Deliberately not inherited from the parent's own env, whatever it happened to be - this is the
  // parent-side half of the isolation contract, set explicitly for every child regardless of how
  // this launcher itself was invoked.
  delete env.LIVE_ARM;
  env.SYNTHETIC_SIMULATION = 'true';
  env.PAPER_TRADING_ONLY = 'true';
  env.ARGUS_DB_PATH = dbPath;
  env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
  env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'true';
  env.OPENALICE_ENABLED = 'false';
  // Step 2 root-cause fix (2026-09-14) - see SyntheticSessionEngine.prepareIsolatedEnvironment()'s
  // own comment for the full incident: real, network-dependent discovery workers must stay idle for
  // an isolated deterministic simulation, both because they'd otherwise make real Alpaca calls a
  // "no real network reliance" simulation should never depend on, and because their real
  // subscribe() calls were the actual cause of a previously-observed getActiveSymbols() churn.
  // Setting these here (spawn time, before the child's module graph loads) is the same structural
  // guarantee Step 1 established for ARGUS_DB_PATH - EncryptionService.ts's dotenv.config() side
  // effect cannot override a key already present in process.env.
  env.ARGUS_OPPORTUNITY_LOOP_ENABLED = 'false';
  env.ARGUS_BROAD_UNIVERSE_ENABLED = 'false';
  env.ARGUS_MARKET_MOVERS_ENABLED = 'false';
  // A second, larger real root cause of getActiveSymbols() churn (2026-09-14) - see
  // SyntheticSessionEngine.prepareIsolatedEnvironment()'s own comment: this deployment's real .env
  // sets ARGUS_ACTIVE_BROKER=ibkr_gateway, which leaks into an otherwise-isolated session the same
  // way the three flags above did, making MarketDataWorker.subscribe() silently roll back every
  // subscription (no real IB Gateway is reachable here). Forcing internal_paper at spawn time closes
  // this the same structural way Step 1 closed the DB path - never affects order placement, which
  // stays redirected to this session's own HistoricalReplayBroker regardless.
  env.ARGUS_ACTIVE_BROKER = 'internal_paper';
  return env;
}

/** Spawns one isolated child process for one scenario run and resolves with its reported result. */
function runScenarioInChildProcess(spec: ScenarioRunSpec): Promise<ChildResultMessage | null> {
  return new Promise((resolve, reject) => {
    const { dbPath } = computeSyntheticSimulationPaths(spec.simulationId);
    const env = buildChildEnv(dbPath);
    const childScriptPath = path.join(__dirname, 'marketOpenChild.ts');
    // Same tsx-CLI invocation as this launcher's own npm script (see package.json's
    // sim:market-open), so the child has identical TypeScript-loading behavior regardless of how
    // this parent process itself was started.
    const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const specArg = `--spec=${encodeURIComponent(JSON.stringify(spec))}`;

    const child = spawn(process.execPath, [tsxCliPath, childScriptPath, specArg], {
      env,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    let resultMessage: ChildResultMessage | null = null;
    child.on('message', (msg: ChildResultMessage) => { resultMessage = msg; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(resultMessage);
      else reject(new Error(`Simulation child process exited with code ${code} (scenario=${spec.scenarioId})`));
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.certify) {
    console.log('=== ARGUS MANDATORY POST-CHANGE MARKET-OPEN CERTIFICATION ===');
    const seed = Number(args.seed ?? 12345);
    const speed = Number(args.speed ?? 1);
    // Test B's default duration (240min, not Test A's 90min) is deliberate, not an oversight: the
    // VALIDATED_CONVERGENCE_CONTROL scenario needs 200+ real bars for TREND_FOLLOWING's own
    // SMA200-ordering condition to be evaluable at all (see that scenario's own header comment) -
    // an operator-supplied --duration overrides both tests identically if given explicitly.
    const testADuration = Number(args.duration ?? 90);
    const testBDuration = Number(args.duration ?? 240);
    // Test B defaults to a small universe (3, not 5) deliberately: fewer concurrently-random-
    // walking symbols means TechnicalAgent/QuantSignalAgent/KronosForecastAgent's independent
    // evaluations are less likely to land on DIFFERENT "best" symbols and dilute the very
    // convergence this scenario exists to produce - narrowing confounds, not lowering a bar.
    const symbols = Number(args.symbols ?? 3);

    const testASpec: ScenarioRunSpec = {
      simulationId: `sim_QUIET_OPEN_${seed}_${Date.now()}`,
      scenarioId: 'QUIET_OPEN', seed, speed, durationMinutes: testADuration, symbols,
      requireTradeForCertification: false,
    };
    const testA = await runScenarioInChildProcess(testASpec);

    // Explicit, disclosed methodology change (2026-09-14, operator-authorized) - see
    // CalibrationHistorySeeder.ts's own header for the full disclosure. Applied to Test B ONLY -
    // Test A is a pure no-trade safety proof and must never have its evidence altered. Opt out with
    // --no-seed-calibration to see the plain organic (pre-seed) diagnostic instead.
    const seedCalibration = args['no-seed-calibration'] !== 'true';
    const testBSpec: ScenarioRunSpec = {
      simulationId: `sim_VALIDATED_CONVERGENCE_CONTROL_${seed}_${Date.now()}`,
      scenarioId: 'VALIDATED_CONVERGENCE_CONTROL', seed, speed, durationMinutes: testBDuration, symbols,
      requireTradeForCertification: true,
      calibrationSeeds: seedCalibration ? DEFAULT_CALIBRATION_SEEDS : undefined,
    };
    const testB = await runScenarioInChildProcess(testBSpec);

    console.log('\n=== CERTIFICATION SUMMARY ===');
    console.log(`TEST A (no-trade safety):     ${testA?.certification} (tradeObserved=${testA?.tradeObserved}, zeroTradeReason=${testA?.zeroTradeReason ?? 'n/a'})`);
    console.log(`TEST B (tradeable scenario):  ${testB?.certification} (tradeObserved=${testB?.tradeObserved}, firstBlockingStage=${testB?.firstBlockingStage ?? 'none'}, calibrationSeeded=${testB?.calibrationSeeded ?? false})`);
    if (testB?.calibrationSeeded) {
      console.log('  NOTE: Test B used a seeded synthetic calibration history - see the report above.');
      console.log('  A PASS here proves pipeline CAPABILITY, not organic empirically-validated alpha.');
    }
    const overall = testA?.certification === 'PASS' && testB?.certification === 'PASS' ? 'PASS' : 'FAIL';
    console.log(`OVERALL: ${overall}`);
    process.exit(overall === 'PASS' ? 0 : 1);
  }

  const scenarioId = args.scenario ?? 'QUIET_OPEN';
  const seed = Number(args.seed ?? 12345);
  const speed = Number(args.speed ?? 1);
  const duration = Number(args.duration ?? 90);
  const symbols = Number(args.symbols ?? 5);
  const spec: ScenarioRunSpec = {
    simulationId: `sim_${scenarioId}_${seed}_${Date.now()}`,
    scenarioId, seed, speed, durationMinutes: duration, symbols,
    requireTradeForCertification: null,
    calibrationSeeds: args['seed-calibration'] === 'true' ? DEFAULT_CALIBRATION_SEEDS : undefined,
  };
  await runScenarioInChildProcess(spec);
  process.exit(0);
}

main().catch((e) => { console.error('SIMULATION FAILED (parent)', e); process.exit(1); });
