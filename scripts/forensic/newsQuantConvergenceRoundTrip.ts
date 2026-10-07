/**
 * News+Quant Independent-Consensus Round-Trip Certification - Phase 1 compatible-scenario attempt
 * (2026-10-07 follow-up to ARGUS_NEWS_QUANT_INDEPENDENT_ROUNDTRIP_CERTIFICATION.md's two prior
 * sections). PARENT launcher. Same isolation architecture as scripts/sim/marketOpen.ts and this
 * mission's own prior newsQuantRoundTrip.ts (pure launcher, no src/server/ imports, spawns a child
 * with every isolation env var set at spawn time).
 *
 * Targets the new COMPANY_BULLISH_CATALYST_CONVERGENCE scenario (src/server/replay/synthetic/
 * SyntheticScenario.ts) on AAPL - chosen because ARGUS_SYNTHETIC_CERTIFICATION_RESULT.md run #2
 * already documents a real, organic CHIEF_APPROVED_IDEA BUY on AAPL from VALIDATED_CONVERGENCE_
 * CONTROL via TechnicalAgent+KronosEngine alone, BEFORE this mission's news injection work and
 * BEFORE QuantEngine was even evaluable in that run. This script tests whether a now-fixed
 * QuantEngine and an injected bullish company-specific catalyst ALSO organically agree - the
 * economic story (see SyntheticScenario.ts's own header on this scenario) was written before this
 * script was run, not after observing any confidence number.
 *
 * Usage: node --use-system-ca ./node_modules/tsx/dist/cli.mjs scripts/forensic/newsQuantConvergenceRoundTrip.ts
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSyntheticSimulationPaths } from '../../src/server/replay/syntheticSimulationPaths';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number(args.seed ?? 20261006);
  const duration = Number(args.duration ?? 400);
  const speed = Number(args.speed ?? 400);
  const symbols = Number(args.symbols ?? 5);
  const scenarioId = args.scenario ?? 'COMPANY_BULLISH_CATALYST_CONVERGENCE';
  const simulationId = `sim_NEWSQUANTCONV_${scenarioId}_${seed}_${Date.now()}`;

  const { dbPath } = computeSyntheticSimulationPaths(simulationId);
  const env = buildChildEnv(dbPath);
  const childScriptPath = path.join(__dirname, 'newsQuantConvergenceRoundTripChild.ts');
  const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const spec = { simulationId, scenarioId, seed, duration, speed, symbols, dbPath };
  const specArg = `--spec=${encodeURIComponent(JSON.stringify(spec))}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCliPath, childScriptPath, specArg], {
      env,
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`News+Quant convergence round-trip child exited with code ${code}`));
    });
  });
}

main().catch((e) => { console.error('NEWS+QUANT CONVERGENCE ROUND TRIP FAILED (parent)', e); process.exit(1); });
