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
 * BUDGET LEVELS (random, operator-specified 2026-10-05):
 *   Randomly sampled between $0 and $200k (uniform distribution, seeded PRNG
 *   for reproducibility). Default 8 levels. Unlike fixed geometric steps,
 *   random sampling avoids accidentally placing all levels on one side of a
 *   gate threshold. $0 remains possible (degenerate edge case: no capital →
 *   no trades, cleanly).
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
 *   --seed=<n>        PRNG seed, same for all levels AND for budget sampling
 *                     (default 12345). Same seed → same budget levels.
 *   --duration=<min> session length per level (default 30, shorter than the
 *                    standard 90 — 8 levels × 90min would take very long)
 *   --symbols=<n>     universe size per level (default 5)
 *   --levels=<n>      how many random budget levels to sample (default 8)
 *   --min-budget=<n>  lower bound for random sampling (default 0)
 *   --max-budget=<n>  upper bound for random sampling (default 200000)
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSyntheticSimulationPaths } from '../../src/server/replay/syntheticSimulationPaths';
import { parseArgs } from './simCliArgs';
import type { BudgetSweepMetrics } from './budgetSweepChild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 2026-10-05: Budget levels are RANDOMLY sampled, not fixed.
 * Operator request: "all levels mean between 0 to 200k random number allocation."
 *
 * Why random (not geometric): the operator wants to observe behavior at
 * arbitrary allocations, not just clean round numbers. Random sampling
 * avoids the bias of hand-picked levels (which might accidentally sit on
 * either side of a gate threshold without revealing it).
 *
 * Reproducibility: levels are drawn from a seeded PRNG (mulberry32) keyed
 * off the main --seed, so the same seed always produces the same levels.
 * Different --seed → different levels. This keeps the sweep deterministic
 * (same input → same output) while still exploring the space randomly.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateRandomBudgetLevels(count: number, minBudget: number, maxBudget: number, seed: number): number[] {
  const rand = mulberry32(seed);
  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    // Round to the nearest dollar — fractional-cent budgets are meaningless.
    const level = Math.round(minBudget + rand() * (maxBudget - minBudget));
    levels.push(level);
  }
  // Sort ascending so the report reads naturally (small → large).
  levels.sort((a, b) => a - b);
  return levels;
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
  // Random budget levels between $0 and $200k (operator request).
  // --levels=N controls how many (default 8). --min-budget/--max-budget
  // override the range. Levels are seeded from the main seed for reproducibility.
  const levelCount = Number(args['levels'] ?? 8);
  const minBudget = Number(args['min-budget'] ?? 0);
  const maxBudget = Number(args['max-budget'] ?? 200_000);
  const budgetLevels = generateRandomBudgetLevels(levelCount, minBudget, maxBudget, seed);

  console.log(`\nBudget sweep: ${budgetLevels.length} RANDOM levels, scenario=${scenarioId}, seed=${seed}, ${durationMinutes}min each`);
  console.log(`Levels: ${budgetLevels.map((b) => '$' + b.toLocaleString()).join(', ')}`);
  console.log('Same seed/scenario for all levels — only the budget varies.\n');

  const results: BudgetSweepMetrics[] = [];
  for (const budget of budgetLevels) {
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
