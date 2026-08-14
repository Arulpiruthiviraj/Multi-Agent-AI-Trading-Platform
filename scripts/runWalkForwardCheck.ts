/**
 * E1/E5 follow-up (BACKTEST_QUANT_HARDENING_ANALYSIS.md): a real walk-forward OOS check on the
 * two highest-Sharpe combinations from the E1 baseline (MOMENTUM_BREAKOUT/MSFT, Sharpe 1.99;
 * MOMENTUM_BREAKOUT/AMD, Sharpe 2.59), per the audit's own explicit instruction not to claim a
 * strategy is profitable without out-of-sample evidence. Uses E5's new
 * WalkForwardValidator.run({strategyId, symbol, ...}) mode.
 */
import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { walkForwardValidator } from '../src/server/engines/backtest/WalkForwardValidator';

const COMBOS = [
  { strategyId: 'MOMENTUM_BREAKOUT', symbol: 'MSFT' },
  { strategyId: 'MOMENTUM_BREAKOUT', symbol: 'AMD' },
];

async function main() {
  const outPath = path.join(process.cwd(), 'WALKFORWARD_CHECK_RESULTS.json');
  const results: any = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  for (const { strategyId, symbol } of COMBOS) {
    console.log(`Walk-forward: ${strategyId} / ${symbol} ...`);
    try {
      const result = await walkForwardValidator.run({
        strategyId, symbol,
        startDate: '2018-01-01', endDate: '2025-12-31',
        trainDays: 365, testDays: 120, initialCash: 100000,
      });
      results[`${strategyId}_${symbol}`] = {
        periodCount: result.periodCount,
        avgInSampleReturnPct: result.avgInSampleReturnPct,
        avgOutOfSampleReturnPct: result.avgOutOfSampleReturnPct,
        outOfSamplePositivePeriodPct: result.outOfSamplePositivePeriodPct,
        inSampleVsOutOfSampleGapPct: result.inSampleVsOutOfSampleGapPct,
        insufficientPeriods: result.insufficientPeriods,
        note: result.note,
      };
      console.log(`  periods=${result.periodCount} avgIS=${result.avgInSampleReturnPct}% avgOOS=${result.avgOutOfSampleReturnPct}% gap=${result.inSampleVsOutOfSampleGapPct}% oosPositive=${result.outOfSamplePositivePeriodPct}%`);
    } catch (e: any) {
      results[`${strategyId}_${symbol}`] = { error: e.message };
      console.log(`  FAILED: ${e.message}`);
    }
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('Wrote WALKFORWARD_CHECK_RESULTS.json');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
