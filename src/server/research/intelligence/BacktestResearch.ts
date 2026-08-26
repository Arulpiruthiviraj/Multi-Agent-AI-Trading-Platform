/**
 * Backtesting (Phase 4). Deliberately does NOT create a second competing backtest framework —
 * both real engines already exist and stay exactly as CLAUDE.md documents them:
 *   - backtestEngine.runStrategyBacktest() — SAME_BAR_CLOSE, long-only, named-quant-strategy,
 *     already persists to quant_strategy_backtests (explicitly non-promotable).
 *   - runCanonicalCoreBacktest() — NEXT_BAR_OPEN, the one promotion-adjacent path.
 * This module only wraps both behind one ResearchResult shape with attached provenance metadata
 * (dataset/period/params/costs/timestamp, Phase 4's own requirement) and never reports success
 * from in-sample return alone — it surfaces whatever profitFactor/Sharpe/expectancy/sample-size
 * the underlying engine already computed, unedited.
 */
import { backtestEngine, StrategyBacktestConfig } from '../../engines/backtest/BacktestEngine';
import { runCanonicalCoreBacktest } from '../canonicalNextBarEngine';
import type { CanonicalDataset } from '../ohlcvTypes';
import { researchSafety } from '../../config/researchSafety';
import { wrapResearchResult, ResearchResult, DataQualityMeta, newResearchRunId } from './types';
import { emitResearchEvent } from './researchEventLog';

export async function runSameBarCloseBacktestResearch(
  config: StrategyBacktestConfig,
  traceId?: string,
): Promise<ResearchResult<any>> {
  const researchRunId = newResearchRunId();
  emitResearchEvent('BACKTEST_STARTED', { researchRunId, traceId, symbol: config.symbol, strategyId: config.strategyId, engine: 'SAME_BAR_CLOSE' });
  const raw = await backtestEngine.runStrategyBacktest(config);
  const sampleSize = raw?.metrics?.closedTrades ?? raw?.closedTrades ?? 0;
  const dataQuality: DataQualityMeta = {
    source: 'BacktestEngine.runStrategyBacktest (reused, SAME_BAR_CLOSE — explicitly non-promotable per CLAUDE.md)',
    symbol: config.symbol,
    timeframe: config.timeframe || '1Day',
    timestamp: new Date().toISOString(),
    sampleSize,
    missingFields: raw?.insufficientSampleSize ? [`fewer than ${researchSafety.minOosTrades} closed trades`] : [],
    staleness: 'FRESH',
    assumptions: [`Period ${config.startDate}..${config.endDate}`, `strategyId=${config.strategyId}`, 'SAME_BAR_CLOSE fill model — not comparable to NEXT_BAR_OPEN, never promotion-eligible'],
    quality: sampleSize >= researchSafety.minOosTrades ? 'GREEN' : sampleSize > 0 ? 'YELLOW' : 'UNAVAILABLE',
  };
  const result = wrapResearchResult({ capability: 'BACKTESTING', label: 'RESEARCH', dataQuality, data: raw, researchRunId });
  emitResearchEvent('BACKTEST_COMPLETED', {
    researchRunId,
    traceId,
    symbol: config.symbol,
    strategyId: config.strategyId,
    engine: 'SAME_BAR_CLOSE',
    sampleSize,
    profitFactor: raw?.metrics?.profitFactor ?? null,
  });
  return result;
}

export function runNextBarOpenBacktestResearch(
  opts: { strategyId: string; dataset: CanonicalDataset; minConfidence?: number; traceId?: string },
): ResearchResult<ReturnType<typeof runCanonicalCoreBacktest>> {
  const researchRunId = newResearchRunId();
  emitResearchEvent('BACKTEST_STARTED', { researchRunId, traceId: opts.traceId, symbol: opts.dataset.symbol, strategyId: opts.strategyId, engine: 'NEXT_BAR_OPEN' });
  const raw = runCanonicalCoreBacktest({ strategyId: opts.strategyId, dataset: opts.dataset, minConfidence: opts.minConfidence });
  const dataQuality: DataQualityMeta = {
    source: 'canonicalNextBarEngine.runCanonicalCoreBacktest (reused — the one promotion-adjacent path)',
    symbol: opts.dataset.symbol,
    timeframe: opts.dataset.frequency,
    timestamp: new Date().toISOString(),
    sampleSize: raw.metrics.tradeCount,
    missingFields: [],
    staleness: 'FRESH',
    assumptions: [`datasetId=${opts.dataset.datasetId}`, `costModel=${raw.costModel}`, `strategyVersion=${raw.strategyVersion}`],
    quality: raw.quality === 'GREEN' ? 'GREEN' : raw.quality === 'YELLOW' ? 'YELLOW' : raw.quality === 'RED' ? 'RED' : 'UNAVAILABLE',
  };
  const result = wrapResearchResult({ capability: 'BACKTESTING', label: 'RESEARCH', dataQuality, data: raw, researchRunId });
  emitResearchEvent('BACKTEST_COMPLETED', {
    researchRunId,
    traceId: opts.traceId,
    symbol: opts.dataset.symbol,
    strategyId: opts.strategyId,
    engine: 'NEXT_BAR_OPEN',
    sampleSize: raw.metrics.tradeCount,
    backtestPass: raw.backtestPass,
  });
  return result;
}
