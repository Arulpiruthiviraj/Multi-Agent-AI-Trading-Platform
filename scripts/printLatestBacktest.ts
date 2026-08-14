/**
 * ==========================================================
 * Script: printLatestBacktest.ts
 *
 * Purpose:
 * Task 3B of the 3-phase remediation plan. Queries the real `backtest_runs` table (written by
 * BacktestEngine.run() - the same engine POST /api/v1/backtest and /api/v2/system/backtest both
 * delegate to) and prints PnL, win rate, and Sharpe ratio for the most recent run directly to the
 * console, so the new commission/slippage/sizing-parity cost model's real effect on
 * FINAL_ANALYSIS.md Section 15.18's negative-Sharpe finding can actually be read, not assumed.
 *
 * Usage: `npx tsx scripts/printLatestBacktest.ts` (optionally `-- --id <backtest_runs.id>` to
 * print a specific run instead of the latest one). Reads whatever `ARGUS_DB_PATH` (or the default
 * `data/argus.db`) the rest of the app is already configured to use - never a second DB.
 * ==========================================================
 */
import { db } from '../src/server/db';
import { backtestRuns } from '../src/server/db/schema';
import { desc, eq } from 'drizzle-orm';

async function main() {
  const idArg = process.argv.find((a, i) => process.argv[i - 1] === '--id');

  const run = idArg
    ? (await db.select().from(backtestRuns).where(eq(backtestRuns.id, idArg)).limit(1))[0]
    : (await db.select().from(backtestRuns).orderBy(desc(backtestRuns.createdAt)).limit(1))[0];

  if (!run) {
    console.error(idArg ? `No backtest_runs row found with id=${idArg}.` : 'No backtest_runs rows exist yet - run one first (POST /api/v1/backtest).');
    process.exitCode = 1;
    return;
  }

  const totalTrades = run.totalTrades ?? 0;
  const sampleWarning = totalTrades < 20
    ? `  ⚠ INSUFFICIENT SAMPLE SIZE (${totalTrades} closed trades, <20) - Sharpe/win-rate/profit-factor are not statistically meaningful.`
    : null;

  console.log('='.repeat(72));
  console.log(`Backtest Run: ${run.id}`);
  console.log('='.repeat(72));
  console.log(`Status:          ${run.status}`);
  console.log(`Symbols:         ${run.symbols}`);
  console.log(`Window:          ${run.startDate} -> ${run.endDate} (${run.timeframe})`);
  console.log(`Initial Cash:    $${run.initialCash?.toLocaleString()}`);
  console.log(`Final Equity:    $${run.finalEquity?.toLocaleString() ?? 'N/A'}`);
  console.log('-'.repeat(72));
  console.log(`PnL:             ${run.finalEquity != null ? `$${(run.finalEquity - run.initialCash).toFixed(2)}` : 'N/A'}`);
  console.log(`Win Rate:        ${run.winRate != null ? `${run.winRate.toFixed(1)}%` : 'N/A'}`);
  console.log(`Sharpe Ratio:    ${run.sharpeRatio != null ? run.sharpeRatio.toFixed(3) : 'N/A'}`);
  console.log(`Sortino Ratio:   ${run.sortinoRatio != null ? run.sortinoRatio.toFixed(3) : 'N/A'}`);
  console.log(`Profit Factor:   ${run.profitFactor != null ? run.profitFactor.toFixed(2) : 'N/A'}`);
  console.log(`Max Drawdown:    ${run.maxDrawdownPct != null ? `${run.maxDrawdownPct.toFixed(2)}%` : 'N/A'}`);
  console.log(`CAGR:            ${run.cagr != null ? `${run.cagr.toFixed(2)}%` : 'N/A'}`);
  console.log(`Expectancy:      ${run.expectancy != null ? `$${run.expectancy.toFixed(2)}` : 'N/A'}`);
  console.log(`Closed Trades:   ${totalTrades}`);
  console.log('-'.repeat(72));
  if (sampleWarning) console.log(sampleWarning);
  if (run.errorMessage) console.log(`Error: ${run.errorMessage}`);
  console.log('='.repeat(72));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
