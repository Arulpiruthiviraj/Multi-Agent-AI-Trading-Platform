/**
 * Temporary diagnostic script for the Argus deep-analysis audit (not a permanent addition -
 * calls only the existing, unmodified BacktestEngine/WalkForwardValidator; writes results to a
 * JSON file for report-writing, touches no live-trading state).
 *
 * Usage: npx tsx scripts/_deep_audit_run.ts
 */
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { backtestEngine } from '../src/server/engines/backtest/BacktestEngine';
import { walkForwardValidator } from '../src/server/engines/backtest/WalkForwardValidator';

const OUT_FILE = 'C:/Users/ithay/AppData/Local/Temp/claude/C--WorkProjects-Multi-Agent-AI-Trading-Platform/ba850359-ce36-470f-a7f0-5cdd987276b2/scratchpad/audit_results.json';

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'SPY', 'QQQ'];
const START = '2018-01-01';
const END = '2025-12-31';

async function main() {
  const results: any = { runs: {}, portfolio: null, walkForward: null, hundredDollarTests: {}, errors: [] };

  console.log('=== Per-symbol standard-scale backtests ($100,000) ===');
  for (const sym of SYMBOLS) {
    try {
      console.log(`Running ${sym}...`);
      const r = await backtestEngine.run({ symbols: [sym], startDate: START, endDate: END, timeframe: '1Day', initialCash: 100000 });
      results.runs[sym] = r;
      console.log(`  ${sym}: trades=${r.closedTrades} winRate=${r.winRatePct}% PF=${r.profitFactor} totalReturn=${r.totalReturnPct}% maxDD=${r.maxDrawdownPct}% insufficientSample=${r.insufficientSampleSize}`);
    } catch (e: any) {
      console.error(`  ${sym} FAILED: ${e.message}`);
      results.errors.push({ symbol: sym, error: e.message });
    }
  }

  console.log('\n=== Multi-symbol portfolio backtest ($100,000, all 7 symbols together) ===');
  try {
    const r = await backtestEngine.run({ symbols: SYMBOLS, startDate: START, endDate: END, timeframe: '1Day', initialCash: 100000 });
    results.portfolio = r;
    console.log(`  Portfolio: trades=${r.closedTrades} winRate=${r.winRatePct}% PF=${r.profitFactor} totalReturn=${r.totalReturnPct}% maxDD=${r.maxDrawdownPct}% sharpe=${r.sharpe} sortino=${r.sortino} insufficientSample=${r.insufficientSampleSize}`);
  } catch (e: any) {
    console.error(`  Portfolio FAILED: ${e.message}`);
    results.errors.push({ symbol: 'PORTFOLIO', error: e.message });
  }

  console.log('\n=== Walk-forward validation (SPY + AAPL, 365-day train / 90-day test) ===');
  try {
    const wf = await walkForwardValidator.run({ symbols: ['SPY', 'AAPL'], startDate: START, endDate: END, timeframe: '1Day', initialCash: 100000, trainDays: 365, testDays: 90 });
    results.walkForward = wf;
    console.log(`  Periods=${wf.periodCount} avgIS=${wf.avgInSampleReturnPct}% avgOOS=${wf.avgOutOfSampleReturnPct}% oosPositivePct=${wf.outOfSamplePositivePeriodPct}% gap=${wf.inSampleVsOutOfSampleGapPct}`);
  } catch (e: any) {
    console.error(`  Walk-forward FAILED: ${e.message}`);
    results.errors.push({ symbol: 'WALK_FORWARD', error: e.message });
  }

  console.log('\n=== Literal $100 starting-capital tests (real share-quantization) ===');
  for (const sym of ['AAPL', 'F', 'SPY']) {
    try {
      const r = await backtestEngine.run({ symbols: [sym], startDate: START, endDate: END, timeframe: '1Day', initialCash: 100 });
      results.hundredDollarTests[sym] = r;
      console.log(`  ${sym} @ $100 start: trades=${r.closedTrades} finalEquity=${r.finalEquity} totalReturn=${r.totalReturnPct}%`);
    } catch (e: any) {
      console.error(`  ${sym} @ $100 FAILED: ${e.message}`);
      results.errors.push({ symbol: `${sym}_100`, error: e.message });
    }
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\nWritten to ${OUT_FILE}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
