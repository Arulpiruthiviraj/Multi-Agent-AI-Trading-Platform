/**
 * ==========================================================
 * Script: runBaseline.ts
 *
 * Purpose:
 * E1 of BACKTEST_QUANT_HARDENING_ANALYSIS.md. Runs the existing, UNMODIFIED BacktestEngine.run()
 * (the original deterministic technical strategy) as a portfolio backtest across SPY/QQQ/MSFT/AMD,
 * 2018-01-01 -> 2025-12-31, $100,000, and separately runs BacktestEngine.runStrategyBacktest() for
 * each of the 5 real quant strategies against each of the same 4 symbols individually (that entry
 * point is single-symbol by design). No code under src/ is touched by this script - it is pure
 * read/execute/report, matching the "do not modify production logic before obtaining the baseline"
 * instruction.
 *
 * Symbols were chosen (by the requester) specifically to avoid HistoricalDataGateway's real
 * unadjusted-corporate-action safety refusal that AAPL/NVDA/TSLA trigger in this window - none of
 * SPY/QQQ/MSFT/AMD had a stock split in 2018-2025.
 *
 * Usage: `npx tsx scripts/runBaseline.ts`. Writes a machine-readable JSON artifact to
 * BASELINE_RESULTS.json in the repo root. Uses real Alpaca historical data via the same
 * HistoricalDataGateway/ohlcv_bars cache every other backtest path uses - this WILL write real
 * cached bars and real backtest_runs/quant_strategy_backtests rows to data/argus.db, exactly like
 * any other real backtest run in this app.
 * ==========================================================
 */
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { backtestEngine } from '../src/server/engines/backtest/BacktestEngine';

const SYMBOLS = ['SPY', 'QQQ', 'MSFT', 'AMD'];
const START_DATE = '2018-01-01';
const END_DATE = '2025-12-31';
const INITIAL_CASH = 100000;
const STRATEGY_IDS = ['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION'];

async function main() {
  const startedAt = new Date().toISOString();
  console.log('='.repeat(72));
  console.log(`E1 Baseline: ${SYMBOLS.join(', ')} | ${START_DATE} -> ${END_DATE} | $${INITIAL_CASH.toLocaleString()}`);
  console.log('='.repeat(72));

  const result: any = {
    startedAt,
    config: { symbols: SYMBOLS, startDate: START_DATE, endDate: END_DATE, initialCash: INITIAL_CASH },
    portfolioBaseline: null,
    portfolioBaselineError: null,
    quantStrategyBacktests: {},
  };

  // --- Portfolio baseline: run() across all 4 symbols in one combined simulation ---
  console.log('\n[1/2] Portfolio baseline via BacktestEngine.run() (original deterministic strategy)...');
  try {
    const run = await backtestEngine.run({
      symbols: SYMBOLS,
      startDate: START_DATE,
      endDate: END_DATE,
      initialCash: INITIAL_CASH,
    });
    result.portfolioBaseline = run;
    console.log(`  status=${run.status} trades=${run.tradeLog?.length ?? run.totalTrades ?? 'N/A'} finalEquity=${run.finalEquity} sharpe=${run.sharpeRatio ?? run.sharpe}`);
  } catch (e: any) {
    result.portfolioBaselineError = e.message;
    console.error(`  FAILED: ${e.message}`);
  }

  // --- Per-strategy, per-symbol quant backtests via runStrategyBacktest() ---
  console.log('\n[2/2] Quant-layer strategy backtests via BacktestEngine.runStrategyBacktest() (per strategy x symbol)...');
  for (const strategyId of STRATEGY_IDS) {
    result.quantStrategyBacktests[strategyId] = {};
    for (const symbol of SYMBOLS) {
      process.stdout.write(`  ${strategyId} / ${symbol} ... `);
      try {
        const run = await backtestEngine.runStrategyBacktest({
          strategyId,
          symbol,
          startDate: START_DATE,
          endDate: END_DATE,
          initialCash: INITIAL_CASH,
        });
        result.quantStrategyBacktests[strategyId][symbol] = run;
        console.log(`status=${run.status} trades=${run.totalTrades} winRate=${run.winRatePct}% expectancy=${run.expectancy}`);
      } catch (e: any) {
        result.quantStrategyBacktests[strategyId][symbol] = { status: 'FAILED', error: e.message };
        console.log(`FAILED: ${e.message}`);
      }
    }
  }

  result.finishedAt = new Date().toISOString();

  const outPath = path.join(process.cwd(), 'BASELINE_RESULTS.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n' + '='.repeat(72));
  console.log(`Wrote ${outPath}`);
  console.log('='.repeat(72));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
