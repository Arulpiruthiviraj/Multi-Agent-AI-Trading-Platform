/**
 * Budget Sweep - PARENT launcher (2026-10-05).
 *
 * WHAT: Runs the synthetic market session at multiple allocated-budget levels
 *   and reports how Argus behaves at each. Answers the operator's question:
 *   "if I allocate $X, what does the system actually do with it?"
 *
 * WHY THIS EXISTS:
 *   The allocated budget (settings.budget) interacts with two gates:
 *   - Gate 23 (argus_capital_allocation): total deployed capital ≤ budget
 *   - Gate 16 (order_notional_cap): single order ≤ max_trade_size ($3k)
 *   The sweep reveals which constraint binds at each allocation level, and
 *   verifies the $0 edge case (no capital → no trades, cleanly, not crashing).
 *
 * BUDGET LEVELS (geometric progression, operator-specified):
 *   $0, $5k, $10k, $20k, $40k, $80k, $160k, $200k
 *   Geometric (doubling) because gate behavior changes logarithmically:
 *   the interesting transitions happen across orders of magnitude, not
 *   linear steps. $0 is the degenerate edge case. $200k is 2x the IBKR
 *   buying power, testing behavior when budget exceeds available capital.
 *
 * METHODOLOGY (for comparability):
 *   - Same scenario, same seed, same universe, same duration for every level.
 *     The ONLY variable is the budget. Any behavioral difference is therefore
 *     attributable to the budget, not to market randomness.
 *   - Each level runs in its own isolated child process with its own isolated
 *     DB (same architecture as marketOpen.ts — see its header for why).
 *   - Sequential (not parallel): synthetic sessions are CPU-heavy (full Argus
 *     core boot per run); parallel runs would contend and distort timing.
 *
 * Usage:
 *   npm run sim:budget-sweep
 *   npm run sim:budget-sweep -- --scenario=TRENDING_BULL_GAP_AND_GO --seed=999
 *
 * Flags:
 *   --scenario=<id>   scenario to run at each level (default QUIET_OPEN)
 *   --seed=<n>        PRNG seed, same for all levels (default 12345)
 *   --duration=<min> session length per level (default 30, shorter than the
 *                    standard 90 — 8 levels × 90min would take very long)
 *   --symbols=<n>     universe size per level (default 5)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSyntheticSimulationPaths } from '../../src/server/replay/syntheticSimulationPaths';
import { parseArgs } from './simCliArgs';
import type { BudgetSweepMetrics } from './budgetSweepChild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Geometric progression: the operator asked for 0 → 5k → 10k → 20k → ... → 200k.
const BUDGET_LEVELS = [0, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 200_000];

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

function runBudgetLevelInChild(
  simulationId: string,
  scenarioId: string,
  seed: number,
  speed: number,
  durationMinutes: number,
  symbols: number,
  budget: number,
): Promise<BudgetSweepMetrics | null> {
  return new Promise((resolve, reject) => {
    const { dbPath } = computeSyntheticSimulationPaths(simulationId);
    const env = buildChildEnv(dbPath);
    const childScriptPath = path.join(__dirname, 'budgetSweepChild.ts');
    const tsxCliPath = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const spec = { simulationId, scenarioId, seed, speed, durationMinutes, symbols, budget };
    const specArg = `--spec=${encodeURIComponent(JSON.stringify(spec))}`;

    const child = spawn(process.execPath, [tsxCliPath, childScriptPath, specArg], {
      env,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });

    let resultMessage: BudgetSweepMetrics | null = null;
    child.on('message', (msg: BudgetSweepMetrics) => { resultMessage = msg; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(resultMessage);
      else reject(new Error(`Budget sweep child exited with code ${code} (budget=$${budget})`));
    });
  });
}

function renderReport(results: BudgetSweepMetrics[]): void {
  console.log('\n' + '='.repeat(100));
  console.log('BUDGET SWEEP REPORT — how Argus behaves at each allocated budget');
  console.log('='.repeat(100));
  console.log(
    'Budget'.padEnd(12) +
    'Trades'.padEnd(8) +
    'Filled'.padEnd(8) +
    'Rejected'.padEnd(10) +
    'Deployed'.padEnd(14) +
    'Max Trade'.padEnd(12) +
    'Util %'.padEnd(8) +
    'Time'
  );
  console.log('-'.repeat(100));
  for (const r of results) {
    const util = r.capitalUtilizationPct === null ? 'n/a' : r.capitalUtilizationPct.toFixed(1) + '%';
    console.log(
      ('$' + r.budget.toLocaleString()).padEnd(12) +
      String(r.tradesTotal).padEnd(8) +
      String(r.tradesFilled).padEnd(8) +
      String(r.tradesRejected).padEnd(10) +
      ('$' + r.totalNotionalDeployed.toLocaleString(undefined, { maximumFractionDigits: 0 })).padEnd(14) +
      ('$' + r.maxSingleTradeNotional.toLocaleString(undefined, { maximumFractionDigits: 0 })).padEnd(12) +
      util.padEnd(8) +
      (r.wallClockDurationMs / 1000).toFixed(1) + 's'
    );
  }
  console.log('='.repeat(100));

  // Gate analysis: show which gates blocked at each level.
  console.log('\nGATE DECISIONS BY BUDGET LEVEL (top 5 per level):');
  for (const r of results) {
    console.log(`\n  $${r.budget.toLocaleString()}:`);
    const top = r.gateDecisions.slice(0, 5);
    if (top.length === 0) {
      console.log('    (no gate decisions recorded)');
    } else {
      for (const g of top) {
        console.log(`    ${g.gate}: ${g.decision} × ${g.count}`);
      }
    }
  }
  console.log('\n' + '='.repeat(100));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioId = args['scenario'] ?? 'QUIET_OPEN';
  const seed = Number(args['seed'] ?? 12345);
  const durationMinutes = Number(args['duration'] ?? 30);
  const symbols = Number(args['symbols'] ?? 5);
  const speed = 1;

  console.log(`\nBudget sweep: ${BUDGET_LEVELS.length} levels, scenario=${scenarioId}, seed=${seed}, ${durationMinutes}min each`);
  console.log(`Levels: ${BUDGET_LEVELS.map((b) => '$' + b.toLocaleString()).join(', ')}`);
  console.log('Same seed/scenario for all levels — only the budget varies.\n');

  const results: BudgetSweepMetrics[] = [];
  for (const budget of BUDGET_LEVELS) {
    const simulationId = `budget_sweep_${budget}_${Date.now()}`;
    try {
      const metrics = await runBudgetLevelInChild(
        simulationId, scenarioId, seed, speed, durationMinutes, symbols, budget,
      );
      if (metrics) {
        results.push(metrics);
        console.log(`\n✓ Budget $${budget.toLocaleString()}: ${metrics.tradesFilled} filled, ${metrics.tradesRejected} rejected, $${metrics.totalNotionalDeployed.toFixed(0)} deployed`);
      }
    } catch (e) {
      console.error(`\n✗ Budget $${budget.toLocaleString()} FAILED:`, e instanceof Error ? e.message : e);
    }
  }

  renderReport(results);
}

main().catch((e) => {
  console.error('BUDGET SWEEP FAILED', e);
  process.exit(1);
});
