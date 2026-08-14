import dotenv from 'dotenv';
dotenv.config();
import fs from 'fs';
import path from 'path';
import { backtestEngine } from '../src/server/engines/backtest/BacktestEngine';
import { walkForwardValidator } from '../src/server/engines/backtest/WalkForwardValidator';
import { db } from '../src/server/db';
import * as schema from '../src/server/db/schema';
import { and, eq, gte, lte, asc } from 'drizzle-orm';

const OUT_FILE = 'C:/Users/ithay/AppData/Local/Temp/claude/C--WorkProjects-Multi-Agent-AI-Trading-Platform/ba850359-ce36-470f-a7f0-5cdd987276b2/scratchpad/audit_results_phase2.json';
const CLEAN_SYMBOLS = ['MSFT', 'AMD', 'SPY', 'QQQ'];
const START = '2018-01-01';
const END = '2025-12-31';
const startMs = new Date(START).getTime();
const endMs = new Date(END).getTime();

async function buyAndHold(symbol: string): Promise<{ startClose: number; endClose: number; returnPct: number } | null> {
  const rows = await db.select().from(schema.ohlcvBars)
    .where(and(eq(schema.ohlcvBars.symbol, symbol), eq(schema.ohlcvBars.timeframe, '1Day'), gte(schema.ohlcvBars.timestamp, startMs), lte(schema.ohlcvBars.timestamp, endMs)))
    .orderBy(asc(schema.ohlcvBars.timestamp));
  if (rows.length === 0) return null;
  const startClose = rows[0].close;
  const endClose = rows[rows.length - 1].close;
  return { startClose, endClose, returnPct: Number((((endClose - startClose) / startClose) * 100).toFixed(2)) };
}

function bootstrapMonteCarlo(tradeReturnsPct: number[], startCapital: number, tradesPerPath: number, numPaths: number) {
  const finals: number[] = [];
  for (let p = 0; p < numPaths; p++) {
    let equity = startCapital;
    for (let t = 0; t < tradesPerPath; t++) {
      const r = tradeReturnsPct[Math.floor(Math.random() * tradeReturnsPct.length)] / 100;
      equity = equity * (1 + r);
      if (equity < 0.01) { equity = 0; break; }
    }
    finals.push(equity);
  }
  finals.sort((a, b) => a - b);
  const pct = (p: number) => finals[Math.floor(p * (finals.length - 1))];
  return {
    numPaths, tradesPerPath, startCapital,
    median: pct(0.5), p10: pct(0.10), p25: pct(0.25), p75: pct(0.75), p90: pct(0.90),
    probLoseMoney: Number((finals.filter(f => f < startCapital).length / finals.length * 100).toFixed(1)),
    probDouble: Number((finals.filter(f => f >= startCapital * 2).length / finals.length * 100).toFixed(1)),
    probReach500: Number((finals.filter(f => f >= 500).length / finals.length * 100).toFixed(1)),
    probReach1000: Number((finals.filter(f => f >= 1000).length / finals.length * 100).toFixed(1)),
    probRuin: Number((finals.filter(f => f <= startCapital * 0.5).length / finals.length * 100).toFixed(1)),
  };
}

async function main() {
  const results: any = { portfolio: null, walkForward: null, buyAndHold: {}, monteCarlo: null, errors: [] };

  console.log('=== Multi-symbol portfolio backtest (clean symbols only: MSFT, AMD, SPY, QQQ) ===');
  try {
    const r = await backtestEngine.run({ symbols: CLEAN_SYMBOLS, startDate: START, endDate: END, timeframe: '1Day', initialCash: 100000 });
    results.portfolio = r;
    console.log(`  trades=${r.closedTrades} winRate=${r.winRatePct}% PF=${r.profitFactor} totalReturn=${r.totalReturnPct}% cagr=${r.cagrPct}% maxDD=${r.maxDrawdownPct}% sharpe=${r.sharpe} sortino=${r.sortino}`);
  } catch (e: any) {
    console.error('  Portfolio FAILED:', e.message);
    results.errors.push({ what: 'portfolio', error: e.message });
  }

  console.log('\n=== Walk-forward (SPY + MSFT, 365-day train / 90-day test) ===');
  try {
    const wf = await walkForwardValidator.run({ symbols: ['SPY', 'MSFT'], startDate: START, endDate: END, timeframe: '1Day', initialCash: 100000, trainDays: 365, testDays: 90 });
    results.walkForward = wf;
    console.log(`  periods=${wf.periodCount} avgIS=${wf.avgInSampleReturnPct}% avgOOS=${wf.avgOutOfSampleReturnPct}% oosPositivePct=${wf.outOfSamplePositivePeriodPct}% gap=${wf.inSampleVsOutOfSampleGapPct}`);
    for (const p of wf.periods) console.log(`    period ${p.period}: test ${p.testStart.slice(0,10)}->${p.testEnd.slice(0,10)} train_ret=${p.train.totalReturnPct}% test_ret=${p.test.totalReturnPct}% train_trades=${p.train.closedTrades} test_trades=${p.test.closedTrades}`);
  } catch (e: any) {
    console.error('  Walk-forward FAILED:', e.message);
    results.errors.push({ what: 'walkForward', error: e.message });
  }

  console.log('\n=== Buy-and-hold benchmarks (from the same real cached bars) ===');
  for (const sym of ['SPY', 'QQQ', 'MSFT', 'AMD', 'F']) {
    const bh = await buyAndHold(sym);
    results.buyAndHold[sym] = bh;
    console.log(`  ${sym}: ${JSON.stringify(bh)}`);
  }

  console.log('\n=== Monte Carlo (bootstrap resample of real per-trade %returns from MSFT/AMD/SPY/QQQ) ===');
  // Load phase-1 results (already on disk) to pull real trade logs
  const phase1 = JSON.parse(fs.readFileSync('C:/Users/ithay/AppData/Local/Temp/claude/C--WorkProjects-Multi-Agent-AI-Trading-Platform/ba850359-ce36-470f-a7f0-5cdd987276b2/scratchpad/audit_results.json', 'utf8'));
  const pooledReturnsPct: number[] = [];
  for (const sym of CLEAN_SYMBOLS) {
    const run = phase1.runs[sym];
    if (!run || !run.tradeLog) continue;
    for (const t of run.tradeLog) {
      if (t.side === 'SELL' && typeof t.realizedPnl === 'number') {
        // Reconstruct the % return this specific trade earned on ITS OWN invested capital
        // (not % of total account) - the honest building block for an "if this were $100 with
        // continuous/fractional sizing" simulation. Real Argus has no fractional shares; this is
        // a clearly-labeled simplifying assumption, not a claim about literal achievable results.
        const costBasis = t.price * t.quantity - (t.realizedPnl ?? 0); // approx entry notional
        if (costBasis > 0) pooledReturnsPct.push((t.realizedPnl / costBasis) * 100);
      }
    }
  }
  console.log(`  Pooled trade sample size: ${pooledReturnsPct.length}`);
  console.log(`  Mean per-trade return: ${(pooledReturnsPct.reduce((a,b)=>a+b,0)/pooledReturnsPct.length).toFixed(2)}%`);
  const mc = bootstrapMonteCarlo(pooledReturnsPct, 100, 40, 2000);
  results.monteCarlo = { ...mc, pooledSampleSize: pooledReturnsPct.length, pooledMeanReturnPct: Number((pooledReturnsPct.reduce((a,b)=>a+b,0)/pooledReturnsPct.length).toFixed(3)), assumption: 'Assumes continuous/fractional position sizing at $100 (Argus itself has no fractional shares) - see literal $100 F-symbol test for what integer-share sizing actually achieves.' };
  console.log('  ', JSON.stringify(mc, null, 2));

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  console.log(`\nWritten to ${OUT_FILE}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
