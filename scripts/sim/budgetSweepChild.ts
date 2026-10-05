/**
 * Budget Sweep - CHILD process (2026-10-05).
 *
 * Runs ONE synthetic session at ONE allocated budget level and reports
 * behavior metrics back to the parent via IPC. Never invoked directly —
 * budgetSweep.ts (the parent launcher) spawns one of these per budget level,
 * with isolation env vars set at spawn time (same structural guarantee as
 * marketOpen.ts/marketOpenChild.ts).
 *
 * WHAT THIS MEASURES (and why):
 *   The allocated budget (settings.budget) flows into two key gates:
 *   - Gate 23 (argus_capital_allocation): caps total deployed capital
 *   - Gate 16 (order_notional_cap): caps single-order notional via max_trade_size
 *   By sweeping the budget from $0 to $200k with the same seed/scenario, we
 *   observe where each gate binds:
 *   - $0: everything blocked (no capital → no trades, by design)
 *   - Small ($5k): budget binds before max_trade_size
 *   - Large ($200k): max_trade_size ($3k) binds before budget
 *   The crossover point tells us which constraint actually governs behavior
 *   at the operator's chosen allocation.
 */

import path from 'node:path';
import fs from 'node:fs';
import { assertSyntheticSimulationNotOpeningProductionDb } from '../../src/server/db/syntheticSimulationDbGuard';
import { resolveDbDir } from '../../src/server/db/resolveDbDir';

function assertChildEnvironmentIsIsolated(): void {
  if (process.env.SYNTHETIC_SIMULATION !== 'true') {
    throw new Error(
      'FATAL: budgetSweepChild.ts must be launched by budgetSweep.ts with ' +
      'SYNTHETIC_SIMULATION=true already set at process-spawn time.',
    );
  }
  const requestedDbPath = process.env.ARGUS_DB_PATH;
  if (!requestedDbPath) {
    throw new Error('FATAL: budgetSweepChild.ts requires ARGUS_DB_PATH set by parent.');
  }
  const dbDir = resolveDbDir(process.platform, fs.existsSync, process.cwd(), path.resolve);
  assertSyntheticSimulationNotOpeningProductionDb(true, requestedDbPath, path.join(dbDir, 'argus.db'));
}

export interface BudgetSweepMetrics {
  type: 'BUDGET_SWEEP_RESULT';
  budget: number;
  simulationId: string;
  // Trade outcomes
  tradesTotal: number;
  tradesFilled: number;
  tradesRejected: number;
  tradesOther: number;
  totalNotionalDeployed: number;
  maxSingleTradeNotional: number;
  // Gate behavior (from risk_gate_results)
  gateDecisions: Array<{ gate: string; decision: string; count: number }>;
  // Capital efficiency
  capitalUtilizationPct: number | null; // deployed / budget, null when budget=0
  wallClockDurationMs: number;
}

interface Spec {
  simulationId: string;
  scenarioId: string;
  seed: number;
  speed: number;
  durationMinutes: number;
  symbols: number;
  budget: number;
}

async function runOneBudgetLevel(spec: Spec): Promise<BudgetSweepMetrics> {
  const { SyntheticSessionEngine } = await import('../../src/server/replay/synthetic/SyntheticSessionEngine');
  const engine = new SyntheticSessionEngine();
  engine.prepareIsolatedEnvironment({
    simulationId: spec.simulationId,
    scenarioId: spec.scenarioId,
    seed: spec.seed,
  });

  console.log(`\n=== Budget sweep: $${spec.budget.toLocaleString()} (scenario=${spec.scenarioId}, seed=${spec.seed}) [child pid=${process.pid}] ===`);

  const result = await engine.run({
    simulationId: spec.simulationId,
    scenarioId: spec.scenarioId,
    seed: spec.seed,
    speedMultiplier: spec.speed,
    sessionDurationMinutes: spec.durationMinutes,
    universeSize: spec.symbols,
    initialCash: spec.budget,
  });

  // Collect metrics from the isolated DB (this child's own DB, not production).
  const { db } = await import('../../src/server/db');
  const { sql } = await import('drizzle-orm');

  // Trade counts by status.
  const tradeRows = db.all(sql`
    SELECT status, COUNT(*) as n, COALESCE(SUM(quantity * price), 0) as notional,
           COALESCE(MAX(quantity * price), 0) as max_notional
    FROM trades GROUP BY status
  `) as Array<{ status: string; n: number; notional: number; max_notional: number }>;

  let tradesTotal = 0, tradesFilled = 0, tradesRejected = 0, tradesOther = 0;
  let totalNotionalDeployed = 0, maxSingleTradeNotional = 0;
  for (const r of tradeRows) {
    tradesTotal += r.n;
    if (r.status === 'FILLED') {
      tradesFilled += r.n;
      totalNotionalDeployed += r.notional;
      maxSingleTradeNotional = Math.max(maxSingleTradeNotional, r.max_notional);
    } else if (r.status === 'REJECTED') {
      tradesRejected += r.n;
    } else {
      tradesOther += r.n;
    }
  }

  // Gate decisions: which gates allowed/blocked, and how often.
  // Focus on the budget-relevant gates but capture all for context.
  const gateRows = db.all(sql`
    SELECT gate_name as gate, CASE WHEN passed THEN 'PASS' ELSE 'BLOCK' END as decision, COUNT(*) as count
    FROM risk_gate_results GROUP BY gate_name, passed ORDER BY count DESC
  `) as Array<{ gate: string; decision: string; count: number }>;

  const capitalUtilizationPct = spec.budget > 0
    ? (totalNotionalDeployed / spec.budget) * 100
    : null;

  return {
    type: 'BUDGET_SWEEP_RESULT',
    budget: spec.budget,
    simulationId: spec.simulationId,
    tradesTotal,
    tradesFilled,
    tradesRejected,
    tradesOther,
    totalNotionalDeployed,
    maxSingleTradeNotional,
    gateDecisions: gateRows,
    capitalUtilizationPct,
    wallClockDurationMs: result.wallClockDurationMs,
  };
}

async function main() {
  assertChildEnvironmentIsIsolated();

  const specArg = process.argv.find((a) => a.startsWith('--spec='));
  if (!specArg) throw new Error('FATAL: budgetSweepChild.ts requires --spec=<json> from parent.');
  const spec: Spec = JSON.parse(decodeURIComponent(specArg.slice('--spec='.length)));

  const metrics = await runOneBudgetLevel(spec);
  if (process.send) process.send(metrics);
  process.exit(0);
}

main().catch((e) => {
  console.error('BUDGET SWEEP CHILD FAILED', e);
  process.exit(1);
});
