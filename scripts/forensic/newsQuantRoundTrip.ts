/**
 * News+Quant Independent-Consensus Round-Trip Certification - PARENT launcher (2026-10-06 follow-up
 * to ARGUS_NEWS_QUANT_INDEPENDENT_ROUNDTRIP_CERTIFICATION.md). Same isolation architecture as
 * scripts/sim/marketOpen.ts (pure launcher, no src/server/ imports, spawns a child with every
 * isolation env var set at spawn time) - see that file's own header for the full rationale this
 * duplicates rather than imports, to keep this one-off forensic script self-contained.
 *
 * Usage: node --use-system-ca ./node_modules/tsx/dist/cli.mjs scripts/forensic/newsQuantRoundTrip.ts
 *        [--seed=20261006] [--duration=400] [--speed=400] [--symbols=5] [--scenario=CERTIFIED_BULLISH_ENTRY_EXIT]
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
  return env;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seed = Number(args.seed ?? 20261006);
  const duration = Number(args.duration ?? 400);
  const speed = Number(args.speed ?? 400);
  const symbols = Number(args.symbols ?? 5);
  const scenarioId = args.scenario ?? 'CERTIFIED_BULLISH_ENTRY_EXIT';
  const simulationId = `sim_NEWSQUANT_${scenarioId}_${seed}_${Date.now()}`;

  const { dbPath } = computeSyntheticSimulationPaths(simulationId);
  const env = buildChildEnv(dbPath);
  const childScriptPath = path.join(__dirname, 'newsQuantRoundTripChild.ts');
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
      else reject(new Error(`News+Quant round-trip child exited with code ${code}`));
    });
  });
}

main().catch((e) => { console.error('NEWS+QUANT ROUND TRIP FAILED (parent)', e); process.exit(1); });
