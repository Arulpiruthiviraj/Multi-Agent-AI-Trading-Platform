/**
 * PBO (Probability of Backtest Overfitting) via CSCV — read-only research diagnostic.
 * Bailey, Borwein, Lopez de Prado, Zhu, "The Probability of Backtest Overfitting" (SSRN 2568435).
 * Real algorithm in src/server/research/pbo.ts (Algorithm 2.3) — this script only loads real
 * quant_strategy_backtests rows and calls it. See docs/audits/ARGUS_QUANT_LIBRARY_PBO_2026-09-11.md
 * for the full source reading notes with page citations.
 *
 * OFFLINE, READ-ONLY, DEFAULT-OFF: not imported by any live-path file, never writes back to any
 * table a gate or evaluateLiveReadiness() reads, never wired into ChiefTraderAgent/RiskEngine/OMS.
 * Per the paper's own explicit warning (p.25): PBO must never be used as a search/optimization
 * objective — this script only ever prints a report for a human to read.
 *
 * Usage:
 *   npx tsx scripts/compute_pbo.ts --strategyId=MOMENTUM_BREAKOUT [--symbol=AAPL] [--slices=16]
 *
 * Selects COMPLETED quant_strategy_backtests rows for --strategyId (optionally further filtered by
 * --symbol) as the N configurations (columns), reconstructs each one's period-return series from
 * its stored equityCurve via the same periodReturnsFromEquityCurve() BacktestEngine's own Monte
 * Carlo module already uses, and runs real CSCV. Does not attempt calendar-date alignment across
 * configurations beyond truncating to the shortest series — see computePbo()'s own doc comment.
 *
 * Must exit the process after printing — same reason as scripts/organic_paper_soak_status.ts.
 */
import dotenv from 'dotenv';
dotenv.config();
process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
}

async function main() {
  const strategyId = argValue('strategyId');
  const symbol = argValue('symbol');
  const slicesArg = argValue('slices');
  const slices = slicesArg ? Number(slicesArg) : 16;

  if (!strategyId) {
    console.log(JSON.stringify({
      ok: false,
      error: 'USAGE: npx tsx scripts/compute_pbo.ts --strategyId=<id> [--symbol=<SYM>] [--slices=16]',
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  const { db, sqliteDb } = await import('../src/server/db');
  const { quantStrategyBacktests } = await import('../src/server/db/schema');
  const { eq, and } = await import('drizzle-orm');
  const { periodReturnsFromEquityCurve } = await import('../src/server/quant/analysis/MonteCarlo');
  const { computePbo } = await import('../src/server/research/pbo');

  let rows: Array<{ id: string; symbol: string; equityCurve: string | null; status: string }> = [];
  try {
    const conditions = symbol
      ? and(eq(quantStrategyBacktests.strategyId, strategyId), eq(quantStrategyBacktests.symbol, symbol))
      : eq(quantStrategyBacktests.strategyId, strategyId);
    rows = await db.select({
      id: quantStrategyBacktests.id,
      symbol: quantStrategyBacktests.symbol,
      equityCurve: quantStrategyBacktests.equityCurve,
      status: quantStrategyBacktests.status,
    }).from(quantStrategyBacktests).where(conditions);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: `DB_QUERY_FAILED: ${e instanceof Error ? e.message : String(e)}` }, null, 2));
    process.exitCode = 1;
    try { sqliteDb.close(); } catch { /* already closed */ }
    return;
  }

  const completed = rows.filter((r) => r.status === 'COMPLETED' && r.equityCurve);
  const configurations = completed.map((r) => ({
    id: `${r.id}:${r.symbol}`,
    returns: periodReturnsFromEquityCurve(JSON.parse(r.equityCurve!)),
  })).filter((c) => c.returns.length > 0);

  const result = computePbo({ configurations, slices });

  console.log(JSON.stringify({
    ok: true,
    strategyId,
    symbol: symbol ?? 'ALL',
    totalBacktestRunsFound: rows.length,
    completedRunsUsedAsConfigurations: configurations.length,
    result,
    invented: false,
    note: 'Read-only diagnostic. Never wired into ChiefTraderAgent/RiskEngine/OMS or any live gate. '
      + 'Per the source paper: do not use PBO as a search/optimization objective.',
  }, null, 2));

  try {
    sqliteDb.close();
  } catch {
    /* already closed */
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
  });
