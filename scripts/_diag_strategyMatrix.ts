import 'dotenv/config';
import { BacktestEngine } from '../src/server/engines/backtest/BacktestEngine';
import fs from 'fs';

const STRATEGIES = ['MOMENTUM_BREAKOUT', 'PULLBACK_CONTINUATION', 'MEAN_REVERSION', 'TREND_FOLLOWING', 'RANGE_REVERSION'];
const SYMBOLS = ['AAPL', 'AMD', 'F', 'IWM', 'MSFT', 'NVDA', 'QQQ', 'SPY', 'TSLA', 'XLK'];
// Real cached daily-bar coverage confirmed 2018-01-02 through at least 2025-12-30 for all 10
// symbols (verified via a direct ohlcv_bars query before this run) - using 2025-12-30 as the
// common end date avoids a live Alpaca backfill call for the 9 symbols whose cache stops there.
const START = '2018-01-01';
const END = '2025-12-30';

async function main() {
  const engine = new BacktestEngine();
  const results: any[] = [];
  let i = 0;
  const total = STRATEGIES.length * SYMBOLS.length;
  for (const symbol of SYMBOLS) {
    for (const strategyId of STRATEGIES) {
      i++;
      const t0 = Date.now();
      try {
        const r = await engine.runStrategyBacktest({ strategyId, symbol, startDate: START, endDate: END, timeframe: '1Day' });
        const elapsed = Date.now() - t0;
        console.error(`[${i}/${total}] ${strategyId} ${symbol} - ${elapsed}ms - trades=${r.closedTrades} winRate=${r.winRatePct} PF=${r.profitFactor} status=${r.status}`);
        results.push({
          strategyId, symbol, status: r.status, errorMessage: r.errorMessage,
          closedTrades: r.closedTrades, insufficientSampleSize: r.insufficientSampleSize,
          winRatePct: r.winRatePct, profitFactor: r.profitFactor, expectancy: r.expectancy,
          avgWinR: r.avgWinR, avgLossR: r.avgLossR, avgR: r.avgR,
          sharpe: r.sharpe, sortino: r.sortino, cagrPct: r.cagrPct, maxDrawdownPct: r.maxDrawdownPct,
          maxConsecutiveLosses: r.maxConsecutiveLosses,
          totalReturnPct: r.totalReturnPct, finalEquity: r.finalEquity,
          drawdownCircuitBreakerTriggeredAt: r.drawdownCircuitBreakerTriggeredAt,
          regimeBreakdown: r.regimeBreakdown,
          expectedValue: r.expectedValue, kelly: r.kelly,
          benchmarkComparison: r.benchmarkComparison,
          failureBreakdown: r.failureBreakdown,
        });
      } catch (e: any) {
        console.error(`[${i}/${total}] ${strategyId} ${symbol} - ERROR: ${e.message}`);
        results.push({ strategyId, symbol, status: 'ERROR', errorMessage: e.message });
      }
    }
  }
  fs.writeFileSync('scripts/_diag_strategyMatrix_results.json', JSON.stringify(results, null, 2));
  console.error('Done. Wrote scripts/_diag_strategyMatrix_results.json');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
