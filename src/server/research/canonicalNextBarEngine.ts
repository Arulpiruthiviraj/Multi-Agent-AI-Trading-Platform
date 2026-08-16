/**
 * Canonical CORE research fills: signal on closed bar T, execute at bar T+1 open.
 * Research-only. Never calls OMS, BrokerManager, or placeOrder.
 */
import { researchSafety, isTheoreticalZeroCost } from '../config/researchSafety';
import { tradingSafety } from '../config/tradingSafety';
import { executionModelVersion, getExecutionModel } from './executionModel';
import { replayArgusStrategy, type ArgusReplaySignal } from './argusStrategyReplay';
import { freezeStrategyVersion } from './strategySpecs';
import { hashCanonicalDataset } from './datasetHash';
import type { CanonicalDataset, DataProvenance, ResearchBar } from './ohlcvTypes';
import { isPromotableProvenance } from './importDataset';
import { assessDataQuality } from './dataQuality';

export interface CanonicalFillCosts {
  commissionPerShare: number;
  spreadBps: number;
  slippageBps: number;
  qty: number;
}

export interface CanonicalTrade {
  side: 'BUY' | 'SELL';
  signalBarIndex: number;
  fillBarIndex: number;
  fillPrice: number;
  qty: number;
  commission: number;
  stop: number | null;
  target: number | null;
  exitReason: 'STOP' | 'TARGET' | 'SIGNAL' | 'UNCLOSED';
  pnl: number | null;
  regime: string | null;
}

export interface CanonicalMetrics {
  tradeCount: number;
  sampleSize: number;
  grossPnl: number | null;
  netPnl: number | null;
  winRate: number | null;
  expectancy: number | null;
  profitFactor: number | null;
  maxDrawdown: number | null;
  sharpe: { status: 'OK' | 'INSUFFICIENT_SAMPLE'; sampleSize: number; value: number | null };
  invented: false;
}

export interface CanonicalBacktestResult {
  engine: 'argus_canonical_next_bar';
  canPlaceOrders: false;
  strategyId: string;
  strategyVersion: string | null;
  datasetId: string;
  datasetHash: string;
  symbol: string;
  timeframe: string;
  dataProvider: string;
  executionModel: string;
  executionModelVersion: string;
  costModel: 'CONFIG' | 'THEORETICAL_ZERO_COST';
  slippageModel: string;
  parametersHash: string | null;
  provenance: DataProvenance;
  quality: string;
  createdAt: string;
  signalCount: number;
  trades: CanonicalTrade[];
  metrics: CanonicalMetrics;
  unclosedCount: number;
  promotable: false;
  backtestPass: boolean;
  rejection: string | null;
  comparableToSameBarClose: false;
}

export function loadCanonicalCosts(): CanonicalFillCosts {
  return {
    commissionPerShare: researchSafety.commissionPerShare,
    spreadBps: researchSafety.spreadBps,
    slippageBps: researchSafety.slippageBps,
    qty: researchSafety.researchQtyShares,
  };
}

function buyFillPrice(open: number, costs: CanonicalFillCosts): number {
  return open * (1 + (costs.spreadBps + costs.slippageBps) / 10000);
}

function sellFillPrice(open: number, costs: CanonicalFillCosts): number {
  return open * (1 - (costs.spreadBps + costs.slippageBps) / 10000);
}

/** Long-only. BUY signal at T fills T+1 open. Stop/target on later bars; gap-through uses that bar's open. */
export function applyNextBarLongFills(
  bars: ResearchBar[],
  signals: Array<Pick<ArgusReplaySignal, 'barIndex' | 'side' | 'stop' | 'target'>>,
  costs: CanonicalFillCosts = loadCanonicalCosts(),
): { trades: CanonicalTrade[]; unclosedCount: number } {
  const byBar = new Map<number, Pick<ArgusReplaySignal, 'barIndex' | 'side' | 'stop' | 'target'>>();
  for (const s of signals) byBar.set(s.barIndex, s);
  const trades: CanonicalTrade[] = [];
  let long: CanonicalTrade | null = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (long) {
      const stop = long.stop;
      const target = long.target;
      if (stop != null && bar.low <= stop) {
        const px = bar.open < stop ? bar.open : stop;
        const commission = costs.commissionPerShare * long.qty;
        const pnl = (px - long.fillPrice) * long.qty - commission - long.commission;
        trades.push({ ...long, side: 'SELL', fillBarIndex: i, fillPrice: px, commission: long.commission + commission, exitReason: 'STOP', pnl });
        long = null;
        continue;
      }
      if (target != null && bar.high >= target) {
        const px = bar.open > target ? bar.open : target;
        const commission = costs.commissionPerShare * long.qty;
        const pnl = (px - long.fillPrice) * long.qty - commission - long.commission;
        trades.push({ ...long, side: 'SELL', fillBarIndex: i, fillPrice: px, commission: long.commission + commission, exitReason: 'TARGET', pnl });
        long = null;
        continue;
      }
    }

    const sig = byBar.get(i);
    if (!sig) continue;
    const exec = i + 1;
    if (exec >= bars.length) continue;
    if (sig.side === 'BUY' && !long) {
      const px = buyFillPrice(bars[exec].open, costs);
      const commission = costs.commissionPerShare * costs.qty;
      long = {
        side: 'BUY',
        signalBarIndex: i,
        fillBarIndex: exec,
        fillPrice: px,
        qty: costs.qty,
        commission,
        stop: sig.stop,
        target: sig.target,
        exitReason: 'UNCLOSED',
        pnl: null,
        regime: null,
      };
    } else if (sig.side === 'SELL' && long) {
      const px = sellFillPrice(bars[exec].open, costs);
      const commission = costs.commissionPerShare * long.qty;
      const pnl = (px - long.fillPrice) * long.qty - commission - long.commission;
      trades.push({
        ...long,
        side: 'SELL',
        signalBarIndex: i,
        fillBarIndex: exec,
        fillPrice: px,
        commission: long.commission + commission,
        exitReason: 'SIGNAL',
        pnl,
      });
      long = null;
    }
  }

  return { trades, unclosedCount: long ? 1 : 0 };
}

export function metricsFromClosedTrades(trades: CanonicalTrade[], minSample: number): CanonicalMetrics {
  const closed = trades.filter((t) => t.side === 'SELL' && typeof t.pnl === 'number');
  const n = closed.length;
  const pnls = closed.map((t) => t.pnl as number);
  const empty: CanonicalMetrics = {
    tradeCount: n,
    sampleSize: n,
    grossPnl: n ? pnls.reduce((s, v) => s + v, 0) : null,
    netPnl: n ? pnls.reduce((s, v) => s + v, 0) : null,
    winRate: null,
    expectancy: null,
    profitFactor: null,
    maxDrawdown: null,
    sharpe: { status: 'INSUFFICIENT_SAMPLE', sampleSize: n, value: null },
    invented: false,
  };
  if (n === 0) return empty;
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p < 0);
  const winRate = wins.length / n;
  const expectancy = pnls.reduce((s, v) => s + v, 0) / n;
  const grossWin = wins.reduce((s, v) => s + v, 0);
  const grossLossAbs = Math.abs(losses.reduce((s, v) => s + v, 0));
  const profitFactor = grossLossAbs > 0 ? grossWin / grossLossAbs : null;
  let peak = 0;
  let eq = 0;
  let maxDd = 0;
  for (const p of pnls) {
    eq += p;
    if (eq > peak) peak = eq;
    maxDd = Math.max(maxDd, peak - eq);
  }
  const filled = { ...empty, winRate, expectancy, profitFactor, maxDrawdown: maxDd, netPnl: empty.netPnl, grossPnl: empty.grossPnl };
  if (n < minSample) return filled;
  const mean = expectancy;
  const variance = pnls.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const stdev = Math.sqrt(variance);
  const value = stdev > 0 ? mean / stdev : null;
  return {
    ...filled,
    sharpe: value === null
      ? { status: 'INSUFFICIENT_SAMPLE', sampleSize: n, value: null }
      : { status: 'OK', sampleSize: n, value: Number(value.toFixed(4)) },
  };
}

export function runCanonicalCoreBacktest(opts: {
  strategyId: string;
  dataset: CanonicalDataset;
  minConfidence?: number;
}): CanonicalBacktestResult {
  const costs = loadCanonicalCosts();
  const frozen = freezeStrategyVersion(opts.strategyId);
  const replay = replayArgusStrategy({
    strategyId: opts.strategyId,
    bars: opts.dataset.bars,
    provenance: opts.dataset.provenance ?? 'UNKNOWN',
    minConfidence: opts.minConfidence ?? tradingSafety.minStrategyConfidenceToTrade,
  });
  const quality = assessDataQuality(opts.dataset);
  const { trades, unclosedCount } = applyNextBarLongFills(opts.dataset.bars, replay.signals, costs);
  const metrics = metricsFromClosedTrades(trades, researchSafety.minOosTrades);
  const zero = isTheoreticalZeroCost();
  const costModel = zero ? 'THEORETICAL_ZERO_COST' : 'CONFIG';
  let rejection = replay.rejection;
  if (!rejection && zero && researchSafety.zeroCostBlocksPromotion) rejection = 'THEORETICAL_ZERO_COST';
  if (!rejection && !isPromotableProvenance(opts.dataset.provenance ?? 'UNKNOWN')) rejection = 'SYNTHETIC_NOT_PROMOTABLE';
  if (!rejection && quality.quality !== 'GREEN') rejection = 'DATA_QUALITY_NOT_GREEN';
  if (!rejection && metrics.tradeCount < researchSafety.minOosTrades) rejection = 'INSUFFICIENT_TRADES';
  const backtestPass =
    isPromotableProvenance(opts.dataset.provenance ?? 'UNKNOWN') &&
    quality.quality === 'GREEN' &&
    !(zero && researchSafety.zeroCostBlocksPromotion) &&
    metrics.tradeCount >= researchSafety.minOosTrades &&
    replay.executionModel === 'NEXT_BAR_OPEN';

  return {
    engine: 'argus_canonical_next_bar',
    canPlaceOrders: false,
    strategyId: opts.strategyId,
    strategyVersion: frozen?.strategyVersion ?? null,
    datasetId: opts.dataset.datasetId,
    datasetHash: hashCanonicalDataset(opts.dataset),
    symbol: opts.dataset.symbol,
    timeframe: opts.dataset.frequency,
    dataProvider: opts.dataset.source,
    executionModel: getExecutionModel('NEXT_BAR_OPEN').executionModel,
    executionModelVersion: executionModelVersion(),
    costModel,
    slippageModel: getExecutionModel('NEXT_BAR_OPEN').slippageModel,
    parametersHash: frozen?.configHash ?? null,
    provenance: opts.dataset.provenance ?? 'UNKNOWN',
    quality: quality.quality,
    createdAt: new Date().toISOString(),
    signalCount: replay.signalCount,
    trades,
    metrics,
    unclosedCount,
    promotable: false,
    backtestPass,
    rejection,
    comparableToSameBarClose: false,
  };
}

