/**
 * ==========================================================
 * Module: research/evolution/CandidateEvaluator
 *
 * THE critical bridge (Section 5/10/13). Forensic audit found a real, load-bearing gap: the
 * canonical, evidence-real NEXT_BAR_OPEN pipeline (canonicalNextBarEngine.ts) can only evaluate
 * the FIXED, hand-written quant/strategies/* catalog by string id (via replayArgusStrategy ->
 * findStrategy(id)) — it cannot execute an arbitrary runtime-generated parameter set. Meanwhile
 * strategiesEngine/'s DSL StrategyDefinition IS runtime-parameterizable, but its own backtest
 * runner (runBacktest.ts) is SAME_BAR_CLOSE and its promoteEvidence() ladder is evidence-free
 * (confirmed: a pure ladder-order + reason-string check, zero quantitative gate). Building
 * "evolution" on either alone would be theater — genome+mutation feeding a runner that can't
 * execute it, or a real-looking promotion ladder with nothing behind it.
 *
 * This function closes that gap WITHOUT modifying either existing engine: it evaluates a
 * StrategyDefinition's condition tree bar-by-bar using strategiesEngine's own real, tested
 * evaluateCondition()/buildMarketSnapshotFromBars() (never reimplemented), converts the result
 * into the exact same ArgusReplaySignal-shaped {barIndex, side, stop, target} tuples, and feeds
 * them into canonicalNextBarEngine's own real applyNextBarLongFills()/metricsFromClosedTrades() —
 * the SAME fill/cost model every canonical, promotion-eligible strategy already uses. The
 * resulting CanonicalBacktestResult-shaped object is then evaluable by the real,
 * unmodified assertPromotionQuarantine() exactly like any other canonical result.
 * ==========================================================
 */
import type { Bar } from '../../engines/backtest/HistoricalDataGateway';
import type { StrategyDefinition } from '../../strategiesEngine/core/types';
import { buildMarketSnapshotFromBars } from '../../strategiesEngine/core/MarketSnapshot';
import { evaluateCondition } from '../../strategiesEngine/conditions/evaluateCondition';
import { resolveStopPrice } from '../../strategiesEngine/backtest/runBacktest';
import {
  applyNextBarLongFills,
  loadCanonicalCosts,
  metricsFromClosedTrades,
  type CanonicalMetrics,
  type CanonicalTrade,
} from '../canonicalNextBarEngine';
import { assessDataQuality } from '../dataQuality';
import { isPromotableProvenance } from '../importDataset';
import { isTheoreticalZeroCost, researchSafety } from '../../config/researchSafety';
import { hashCanonicalDataset } from '../datasetHash';
import { getExecutionModel, executionModelVersion } from '../executionModel';
import type { CanonicalDataset } from '../ohlcvTypes';

function resolveTargetPrice(strategy: StrategyDefinition, entryPrice: number, atr: number | null, stopPrice: number | null): number | null {
  const tp = strategy.takeProfit;
  if (!tp || tp.value === null) return null;
  if (tp.kind === 'ATR_MULTIPLE') return atr === null ? null : entryPrice + atr * tp.value;
  if (tp.kind === 'FIXED_PCT') return entryPrice * (1 + tp.value / 100);
  if (tp.kind === 'RISK_MULTIPLE') {
    if (stopPrice === null) return null;
    const riskPerShare = entryPrice - stopPrice;
    return riskPerShare > 0 ? entryPrice + riskPerShare * tp.value : null;
  }
  return null; // STRUCTURE/OPPOSING_LIQUIDITY need richer state this evaluator does not model
}

export interface CandidateBacktestResult {
  engine: 'argus_candidate_evolution_next_bar';
  canPlaceOrders: false;
  candidateId: string;
  datasetId: string;
  datasetHash: string;
  symbol: string;
  timeframe: string;
  executionModel: string;
  executionModelVersion: string;
  costModel: 'CONFIG' | 'THEORETICAL_ZERO_COST';
  provenance: string;
  quality: string;
  createdAt: string;
  signalCount: number;
  trades: CanonicalTrade[];
  metrics: CanonicalMetrics;
  unclosedCount: number;
  backtestPass: boolean;
  rejection: string | null;
}

/**
 * Real, bar-by-bar evaluation of a DSL candidate against real bars — mirrors
 * argusStrategyReplay.ts's loop shape exactly (same MIN_BARS-style warmup convention: this
 * evaluator requires researchSafety-derived warmup via the caller's dataset, never a fabricated
 * minimum). Long-only (matches every other engine in this codebase — no shorting anywhere).
 */
export function evaluateCandidate(candidate: StrategyDefinition, dataset: CanonicalDataset): CandidateBacktestResult {
  const bars: Bar[] = dataset.bars.map((b) => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const minBars = researchSafety.wfoTrainBars > 0 ? Math.min(30, researchSafety.wfoTrainBars) : 30;
  const execution = getExecutionModel('NEXT_BAR_OPEN');

  const signals: Array<{ barIndex: number; side: 'BUY' | 'SELL'; stop: number | null; target: number | null }> = [];
  let openEntryPrice: number | null = null;
  let openStop: number | null = null;

  for (let i = minBars - 1; i < bars.length; i++) {
    const visible = bars.slice(0, i + 1);
    const snapshot = buildMarketSnapshotFromBars(visible, candidate.metadata?.tags?.[0] ?? dataset.symbol, '1d');
    const bar = bars[i];

    if (openEntryPrice !== null) {
      const stopHit = openStop !== null && bar.low <= openStop;
      const exitSignal = candidate.exitConditions ? evaluateCondition(candidate.exitConditions, snapshot) : false;
      const invalidated = candidate.invalidationConditions ? evaluateCondition(candidate.invalidationConditions, snapshot) : false;
      if (stopHit || exitSignal || invalidated) {
        signals.push({ barIndex: i, side: 'SELL', stop: null, target: null });
        openEntryPrice = null;
        openStop = null;
      }
    } else {
      const entrySignal = evaluateCondition(candidate.entryConditions, snapshot);
      const confirmed = candidate.confirmationConditions ? evaluateCondition(candidate.confirmationConditions, snapshot) : true;
      if (entrySignal && confirmed && bar.close > 0) {
        const atr = snapshot.indicators.atr;
        const stop = resolveStopPrice(candidate, bar.close, atr);
        const target = resolveTargetPrice(candidate, bar.close, atr, stop);
        signals.push({ barIndex: i, side: 'BUY', stop, target });
        openEntryPrice = bar.close;
        openStop = stop;
      }
    }
  }

  const costs = loadCanonicalCosts();
  const { trades, unclosedCount } = applyNextBarLongFills(dataset.bars, signals, costs);
  const metrics = metricsFromClosedTrades(trades, researchSafety.minOosTrades);
  const quality = assessDataQuality(dataset);
  const zero = isTheoreticalZeroCost();
  const costModel = zero ? 'THEORETICAL_ZERO_COST' : 'CONFIG';

  let rejection: string | null = null;
  if (!isPromotableProvenance(dataset.provenance ?? 'UNKNOWN')) rejection = 'SYNTHETIC_NOT_PROMOTABLE';
  else if (zero && researchSafety.zeroCostBlocksPromotion) rejection = 'THEORETICAL_ZERO_COST';
  else if (quality.quality !== 'GREEN') rejection = 'DATA_QUALITY_NOT_GREEN';
  else if (metrics.tradeCount < researchSafety.minOosTrades) rejection = 'INSUFFICIENT_TRADES';

  const backtestPass =
    isPromotableProvenance(dataset.provenance ?? 'UNKNOWN') &&
    quality.quality === 'GREEN' &&
    !(zero && researchSafety.zeroCostBlocksPromotion) &&
    metrics.tradeCount >= researchSafety.minOosTrades;

  return {
    engine: 'argus_candidate_evolution_next_bar',
    canPlaceOrders: false,
    candidateId: candidate.id,
    datasetId: dataset.datasetId,
    datasetHash: hashCanonicalDataset(dataset),
    symbol: dataset.symbol,
    timeframe: dataset.frequency,
    executionModel: execution.executionModel,
    executionModelVersion: executionModelVersion(),
    costModel,
    provenance: dataset.provenance ?? 'UNKNOWN',
    quality: quality.quality,
    createdAt: new Date().toISOString(),
    signalCount: signals.length,
    trades,
    metrics,
    unclosedCount,
    backtestPass,
    rejection,
  };
}
